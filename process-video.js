// ─────────────────────────────────────────────────────────────────
// api/process-video.js
// Vercel Serverless Function — runs in the cloud, not the browser
//
// Called by: dashboard.html after a video uploads successfully
// Does:
//   1. Submits video URL to AssemblyAI for transcription + highlights
//   2. Polls until AssemblyAI finishes
//   3. Saves detected clips to Supabase `clips` table
//   4. Updates `videos` table status → 'ready'
// ─────────────────────────────────────────────────────────────────

// These come from Vercel Environment Variables (set in Vercel dashboard)
// — never hardcode secrets in files you deploy
const ASSEMBLYAI_API_KEY  = process.env.ASSEMBLYAI_API_KEY;
const SUPABASE_URL        = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; // service key, not anon

export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { videoId, videoUrl, userId } = req.body;

  if (!videoId || !videoUrl || !userId) {
    return res.status(400).json({ error: 'Missing videoId, videoUrl, or userId' });
  }

  try {
    // ── STEP 1: Submit to AssemblyAI ──────────────────────────────
    console.log(`[ClipVault] Submitting video ${videoId} to AssemblyAI`);

    const submitRes = await fetch('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: {
        'Authorization': ASSEMBLYAI_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        audio_url:            videoUrl,
        auto_highlights:      true,   // detects key phrases / important moments
        sentiment_analysis:   true,   // detects emotional peaks
        auto_chapters:        true,   // breaks video into meaningful chapters
        iab_categories:       true,   // content classification (sports, tech, etc.)
        language_code:        'en',
        punctuate:            true,
        format_text:          true
      })
    });

    const submitData = await submitRes.json();

    if (!submitRes.ok || !submitData.id) {
      throw new Error(`AssemblyAI submit failed: ${submitData.error || 'Unknown error'}`);
    }

    const transcriptId = submitData.id;
    console.log(`[ClipVault] AssemblyAI transcript ID: ${transcriptId}`);

    // Update video status to 'analyzing'
    await supabaseUpdate(videoId, { status: 'analyzing', transcript_id: transcriptId });

    // ── STEP 2: Poll until done ───────────────────────────────────
    // AssemblyAI takes 10 seconds to several minutes depending on video length
    // We poll every 5 seconds, max 20 attempts (= ~100 seconds)

    let transcript = null;
    const maxAttempts = 20;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await sleep(5000); // wait 5 seconds between polls

      const pollRes = await fetch(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
        headers: { 'Authorization': ASSEMBLYAI_API_KEY }
      });

      const pollData = await pollRes.json();
      console.log(`[ClipVault] Poll ${attempt + 1}: status = ${pollData.status}`);

      if (pollData.status === 'completed') {
        transcript = pollData;
        break;
      }

      if (pollData.status === 'error') {
        throw new Error(`AssemblyAI processing error: ${pollData.error}`);
      }
      // status is 'queued' or 'processing' — keep polling
    }

    if (!transcript) {
      throw new Error('AssemblyAI timed out after 100 seconds');
    }

    // ── STEP 3: Extract clips from results ───────────────────────
    const clips = extractClips(transcript, videoId);
    console.log(`[ClipVault] Extracted ${clips.length} clips`);

    // ── STEP 4: Save clips to Supabase ───────────────────────────
    if (clips.length > 0) {
      const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/clips`, {
        method: 'POST',
        headers: {
          'apikey':        SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type':  'application/json',
          'Prefer':        'return=minimal'
        },
        body: JSON.stringify(clips)
      });

      if (!insertRes.ok) {
        const err = await insertRes.text();
        throw new Error(`Clips insert failed: ${err}`);
      }
    }

    // ── STEP 5: Update video to 'ready' ──────────────────────────
    const duration = transcript.audio_duration
      ? Math.round(transcript.audio_duration)
      : null;

    await supabaseUpdate(videoId, {
      status:        'ready',
      clip_count:    clips.length,
      duration_secs: duration,
      transcript_id: transcriptId
    });

    console.log(`[ClipVault] Video ${videoId} done — ${clips.length} clips saved`);

    return res.status(200).json({
      success:    true,
      clipCount:  clips.length,
      videoId
    });

  } catch (err) {
    console.error(`[ClipVault] Error processing video ${videoId}:`, err.message);

    // Mark video as failed in database
    await supabaseUpdate(videoId, { status: 'error' }).catch(() => {});

    return res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────
// EXTRACT CLIPS
// Turns AssemblyAI results into clip records
// Sources: auto_chapters (best), auto_highlights, sentiment peaks
// ─────────────────────────────────────────────────────────────────
function extractClips(transcript, videoId) {
  const clips = [];

  // ── Source 1: Auto Chapters (most reliable, gives natural segments) ──
  if (transcript.chapters && transcript.chapters.length > 0) {
    transcript.chapters.forEach((chapter, i) => {
      const durationMs = chapter.end - chapter.start;
      const durationSecs = Math.round(durationMs / 1000);

      // Only include clips between 10s and 90s (ideal for social)
      if (durationSecs >= 10 && durationSecs <= 90) {
        clips.push({
          video_id:    videoId,
          title:       chapter.headline || `Clip ${i + 1}`,
          summary:     chapter.summary || '',
          start_ms:    chapter.start,
          end_ms:      chapter.end,
          duration_secs: durationSecs,
          source:      'chapter',
          score:       scoreClip(chapter, transcript, 'chapter'),
          transcript_text: chapter.gist || ''
        });
      }
    });
  }

  // ── Source 2: Auto Highlights (key phrases with confidence scores) ──
  if (transcript.auto_highlights_result?.results) {
    const highlights = transcript.auto_highlights_result.results
      .filter(h => h.rank > 0.6) // only high-confidence highlights
      .slice(0, 5); // top 5

    highlights.forEach((highlight, i) => {
      // Find the timestamp of this highlight in the full transcript
      const timestamp = findTimestamp(highlight.text, transcript.words);
      if (!timestamp) return;

      const startMs = Math.max(0, timestamp.start - 5000); // 5s before
      const endMs   = timestamp.end + 15000;               // 15s after
      const durationSecs = Math.round((endMs - startMs) / 1000);

      // Avoid duplicate clips that overlap with chapters
      const overlaps = clips.some(c =>
        Math.abs(c.start_ms - startMs) < 8000
      );
      if (!overlaps) {
        clips.push({
          video_id:    videoId,
          title:       `"${highlight.text}"`,
          summary:     `High-impact moment: ${highlight.text}`,
          start_ms:    startMs,
          end_ms:      endMs,
          duration_secs: durationSecs,
          source:      'highlight',
          score:       Math.round(highlight.rank * 100),
          transcript_text: highlight.text
        });
      }
    });
  }

  // ── Source 3: Sentiment peaks (emotional high points) ──
  if (transcript.sentiment_analysis_results) {
    const positives = transcript.sentiment_analysis_results
      .filter(s => s.sentiment === 'POSITIVE' && s.confidence > 0.9)
      .slice(0, 3);

    positives.forEach(seg => {
      const startMs = Math.max(0, seg.start - 3000);
      const endMs   = seg.end + 10000;
      const durationSecs = Math.round((endMs - startMs) / 1000);

      if (durationSecs < 8 || durationSecs > 60) return;

      const overlaps = clips.some(c => Math.abs(c.start_ms - startMs) < 6000);
      if (!overlaps) {
        clips.push({
          video_id:    videoId,
          title:       `Emotional peak`,
          summary:     seg.text,
          start_ms:    startMs,
          end_ms:      endMs,
          duration_secs: durationSecs,
          source:      'sentiment',
          score:       Math.round(seg.confidence * 90),
          transcript_text: seg.text
        });
      }
    });
  }

  // Sort by score descending, cap at 12 clips
  return clips
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);
}

// Score a clip 0–100 based on duration, source type, and content signals
function scoreClip(chapter, transcript, source) {
  let score = 60; // base

  // Prefer 20–60 second clips
  const dur = (chapter.end - chapter.start) / 1000;
  if (dur >= 20 && dur <= 60) score += 20;
  else if (dur > 60 && dur <= 90) score += 10;

  // Chapter source bonus
  if (source === 'chapter') score += 10;

  // If headline is a question or strong statement, it's likely engaging
  const headline = (chapter.headline || '').toLowerCase();
  if (headline.includes('?') || headline.includes('!')) score += 5;
  if (headline.split(' ').length > 5) score += 5; // descriptive = more context

  return Math.min(100, score);
}

// Find timestamp of a phrase within the word list
function findTimestamp(text, words) {
  if (!words || !text) return null;
  const phrase = text.toLowerCase().split(' ');
  for (let i = 0; i < words.length; i++) {
    if (words[i].text?.toLowerCase() === phrase[0]) {
      const endIdx = Math.min(i + phrase.length - 1, words.length - 1);
      return { start: words[i].start, end: words[endIdx].end };
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function supabaseUpdate(videoId, fields) {
  return fetch(`${SUPABASE_URL}/rest/v1/videos?id=eq.${videoId}`, {
    method: 'PATCH',
    headers: {
      'apikey':        SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        'return=minimal'
    },
    body: JSON.stringify(fields)
  });
}
