// /api/music.js — generate music via Hugging Face MusicGen (free tier)
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const GENRE_PROMPTS = {
  trap:   'aggressive trap beat, heavy 808 bass, trap hi-hats, dark atmospheric synths, 140 BPM',
  phonk:  'dark phonk music, Memphis rap beat, deep cowbell, distorted 808, drifting vibes',
  pop:    'upbeat pop instrumental, catchy melody, bright synths, clapping, 120 BPM',
  drill:  'UK drill beat, dark piano, rolling hi-hats, heavy bass, 140 BPM',
  hype:   'high energy hype beat, stadium anthem, heavy bass drops, fast tempo, adrenaline',
  ballad: 'emotional piano ballad, orchestral strings, melancholic melody, slow tempo, cinematic',
};

// HuggingFace hosted MusicGen — completely free with a free HF account
const HF_MODEL = 'https://api-inference.huggingface.co/models/facebook/musicgen-small';

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (req.method !== 'POST') { res.writeHead(405, CORS); return res.end(JSON.stringify({ error: 'POST only' })); }

  const apiKey = process.env.HUGGINGFACE_API_KEY;
  if (!apiKey) {
    res.writeHead(503, CORS);
    return res.end(JSON.stringify({ error: 'no_key', message: 'HUGGINGFACE_API_KEY not set' }));
  }

  let body = '';
  await new Promise((resolve, reject) => { req.on('data', d => { body += d }); req.on('end', resolve); req.on('error', reject); });

  let genre, symbol;
  try { ({ genre, symbol } = JSON.parse(body)); } catch {
    res.writeHead(400, CORS); return res.end(JSON.stringify({ error: 'Invalid JSON' }));
  }

  genre = (genre || 'trap').toLowerCase();
  const prompt = (GENRE_PROMPTS[genre] || GENRE_PROMPTS.trap) + (symbol ? `, ${symbol} token anthem` : '');

  try {
    const hfRes = await fetch(HF_MODEL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Wait-For-Model': 'true',
      },
      body: JSON.stringify({
        inputs: prompt,
        parameters: { max_new_tokens: 512 },
      }),
      signal: AbortSignal.timeout(55000),
    });

    if (!hfRes.ok) {
      const errText = await hfRes.text().catch(() => hfRes.status);
      throw new Error(`HuggingFace ${hfRes.status}: ${String(errText).slice(0, 200)}`);
    }

    // HF returns raw audio bytes
    const audioBuffer = await hfRes.arrayBuffer();
    const base64 = Buffer.from(audioBuffer).toString('base64');
    const contentType = hfRes.headers.get('content-type') || 'audio/flac';

    res.writeHead(200, CORS);
    res.end(JSON.stringify({
      audioData: base64,
      contentType,
      genre,
    }));
  } catch (e) {
    res.writeHead(502, CORS);
    res.end(JSON.stringify({ error: e.message }));
  }
};
