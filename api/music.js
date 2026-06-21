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

const REPLICATE_MODEL = 'meta/musicgen:671ac645ce5e552cc63a54a2bbff63fcf798043055d2dac5fc9e36a837eedcfb';

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
  const prompt = (GENRE_PROMPTS[genre] || GENRE_PROMPTS.trap) + (symbol ? `, theme: ${symbol} token` : '');

  try {
    // Start prediction
    const startRes = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: {
        'Authorization': `Token ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        version: REPLICATE_MODEL,
        input: {
          prompt,
          model_version: 'stereo-large',
          output_format: 'mp3',
          duration: 30,
          temperature: 1,
          top_k: 250,
          top_p: 0,
          classifier_free_guidance: 3,
          continuation: false,
          multi_band_diffusion: false,
          normalization_strategy: 'peak',
        },
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!startRes.ok) {
      const err = await startRes.text();
      throw new Error(`Replicate start failed: ${startRes.status} — ${err.slice(0, 200)}`);
    }

    const prediction = await startRes.json();
    const predictionId = prediction.id;

    // Poll for completion (max ~38s)
    const deadline = Date.now() + 38000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2500));

      const pollRes = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
        headers: { 'Authorization': `Token ${apiKey}` },
        signal: AbortSignal.timeout(8000),
      });

      if (!pollRes.ok) continue;

      const poll = await pollRes.json();

      if (poll.status === 'succeeded') {
        const audioUrl = Array.isArray(poll.output) ? poll.output[0] : poll.output;
        res.writeHead(200, CORS);
        return res.end(JSON.stringify({ audioUrl, genre, predictionId }));
      }

      if (poll.status === 'failed' || poll.status === 'canceled') {
        throw new Error(`Prediction ${poll.status}: ${poll.error || 'unknown'}`);
      }
      // still 'starting' or 'processing' — keep polling
    }

    throw new Error('Music generation timed out — try again');
  } catch (e) {
    res.writeHead(502, CORS);
    res.end(JSON.stringify({ error: e.message }));
  }
};
