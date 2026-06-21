// /api/music.js — generate instrumental music via Replicate MusicGen
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const GENRE_PROMPTS = {
  trap:   'aggressive trap beat, heavy 808 bass, trap hi-hats, dark atmospheric synths, 140 BPM, professional mix',
  phonk:  'dark phonk music, Memphis rap instrumental, deep cowbell, distorted 808, drifting vibes, eerie atmosphere',
  pop:    'upbeat pop song instrumental, catchy melody, bright synths, clapping, feel-good energy, 120 BPM',
  drill:  'UK drill beat, dark minor piano, rolling hi-hats, heavy bass, menacing, 140 BPM, Chicago drill',
  hype:   'high energy hype beat, stadium anthem, crowd chant, heavy bass drops, fast tempo, adrenaline',
  ballad: 'emotional piano ballad, orchestral strings, melancholic melody, slow tempo, cinematic, heartfelt R&B',
};

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (req.method !== 'POST') { res.writeHead(405, CORS); return res.end(JSON.stringify({ error: 'POST only' })); }

  const apiKey = process.env.REPLICATE_API_KEY;
  if (!apiKey) {
    res.writeHead(503, CORS);
    return res.end(JSON.stringify({ error: 'REPLICATE_API_KEY not configured' }));
  }

  let body = '';
  await new Promise((resolve, reject) => { req.on('data', d => { body += d }); req.on('end', resolve); req.on('error', reject); });

  let genre, symbol;
  try { ({ genre, symbol } = JSON.parse(body)); } catch {
    res.writeHead(400, CORS); return res.end(JSON.stringify({ error: 'Invalid JSON' }));
  }

  genre = (genre || 'trap').toLowerCase();
  const prompt = (GENRE_PROMPTS[genre] || GENRE_PROMPTS.trap) + (symbol ? `, inspired by ${symbol}` : '');

  try {
    // Use the official model endpoint (no hardcoded version hash)
    const startRes = await fetch('https://api.replicate.com/v1/models/meta/musicgen/predictions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'wait=5',
      },
      body: JSON.stringify({
        input: {
          prompt,
          duration: 28,
          output_format: 'mp3',
          normalization_strategy: 'peak',
        },
      }),
      signal: AbortSignal.timeout(12000),
    });

    if (!startRes.ok) {
      const errText = await startRes.text().catch(() => startRes.status);
      throw new Error(`Replicate ${startRes.status}: ${String(errText).slice(0, 300)}`);
    }

    const prediction = await startRes.json();

    // If already done (Prefer: wait worked)
    if (prediction.status === 'succeeded') {
      const audioUrl = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
      res.writeHead(200, CORS);
      return res.end(JSON.stringify({ audioUrl, genre }));
    }

    const predictionId = prediction.id;
    if (!predictionId) throw new Error('No prediction ID returned');

    // Poll until done (max 42s)
    const deadline = Date.now() + 42000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 3000));

      const pollRes = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(8000),
      });

      if (!pollRes.ok) continue;
      const poll = await pollRes.json();

      if (poll.status === 'succeeded') {
        const audioUrl = Array.isArray(poll.output) ? poll.output[0] : poll.output;
        if (!audioUrl) throw new Error('Empty audio output');
        res.writeHead(200, CORS);
        return res.end(JSON.stringify({ audioUrl, genre }));
      }

      if (poll.status === 'failed' || poll.status === 'canceled') {
        throw new Error(`Prediction ${poll.status}: ${poll.error || 'unknown error'}`);
      }
    }

    throw new Error('Timed out after 45s — Replicate is busy, try again');
  } catch (e) {
    res.writeHead(502, CORS);
    res.end(JSON.stringify({ error: e.message }));
  }
};
