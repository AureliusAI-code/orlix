// /api/voice.js — ElevenLabs TTS for song lyrics
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// One distinct voice per genre
const VOICES = {
  trap:   { id: 'pNInz6obpgDQGcFmaJgB', stability: 0.22, style: 0.88 }, // Adam  — deep & dark
  phonk:  { id: 'N2lVS1w4EtoT3dr4eOWO', stability: 0.18, style: 0.92 }, // Callum — menacing
  drill:  { id: 'onwK4e9ZLuTAKqWW03F9', stability: 0.24, style: 0.82 }, // Daniel — cold British
  hype:   { id: 'SOYHLrjzK2X1ezoPC6cr', stability: 0.28, style: 0.96 }, // Harry  — hype energy
  pop:    { id: 'EXAVITQu4vr4xnSDxMaL', stability: 0.50, style: 0.68 }, // Sarah  — bright pop
  ballad: { id: 'XrExE9yKIg1WjnnlVkGX', stability: 0.58, style: 0.72 }, // Matilda — smooth
};

function cleanLyrics(text) {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')   // strip **bold**
    .replace(/^\[.+\]$/gm, '')            // remove [Verse 1] etc
    .replace(/^---+$/gm, '')              // remove separators
    .replace(/^\$?[A-Z0-9]{2,12}$/gm, '') // remove lone token name lines
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (req.method !== 'POST') { res.writeHead(405, CORS); return res.end(JSON.stringify({ error: 'POST only' })); }

  let body = '';
  await new Promise((resolve, reject) => {
    req.on('data', d => { body += d; });
    req.on('end', resolve);
    req.on('error', reject);
  });

  let lyrics, genre;
  try { ({ lyrics, genre } = JSON.parse(body)); }
  catch { res.writeHead(400, { ...CORS, 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Invalid JSON' })); }

  if (!lyrics?.trim()) {
    res.writeHead(400, { ...CORS, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Missing lyrics' }));
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    res.writeHead(503, { ...CORS, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Voice API not configured' }));
  }

  const voice = VOICES[genre] || VOICES.trap;
  const text  = cleanLyrics(lyrics).slice(0, 2400); // free tier limit

  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice.id}`, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_turbo_v2_5',
        voice_settings: {
          stability: voice.stability,
          similarity_boost: 0.82,
          style: voice.style,
          use_speaker_boost: true,
        },
      }),
      signal: AbortSignal.timeout(50000),
    });

    if (!r.ok) {
      const err = await r.text();
      throw new Error(`ElevenLabs ${r.status}: ${err.slice(0, 120)}`);
    }

    const buf = await r.arrayBuffer();
    res.writeHead(200, {
      ...CORS,
      'Content-Type': 'audio/mpeg',
      'Content-Length': buf.byteLength,
    });
    res.end(Buffer.from(buf));
  } catch (e) {
    res.writeHead(502, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
};
