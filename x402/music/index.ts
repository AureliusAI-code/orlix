// Orlix X402 — Music Generator
// Generates crypto-themed music via Mubert. Holders get longer tracks + higher quality.

import { getOrlixTier, withTier } from '../_shared/holder';

const GENRES = ['trap','phonk','pop','drill','hype','ballad'] as const;
type Genre = typeof GENRES[number];

const GENRE_PROMPTS: Record<Genre, string> = {
  trap:   'aggressive trap beat, heavy 808 bass, trap hi-hats, dark atmospheric synths, 140 BPM',
  phonk:  'dark phonk music, Memphis rap beat, deep cowbell, distorted 808, drifting vibes',
  pop:    'upbeat pop instrumental, catchy melody, bright synths, clapping, 120 BPM',
  drill:  'UK drill beat, dark piano, rolling hi-hats, heavy bass, 140 BPM',
  hype:   'high energy hype beat, stadium anthem, heavy bass drops, fast tempo, adrenaline',
  ballad: 'emotional piano ballad, orchestral strings, melancholic melody, slow tempo, cinematic',
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function mubertPost(path: string, params: object, apiKey: string) {
  const r = await fetch(`https://api.mubert.com/v2/${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ method: path, params: { pat: apiKey, ...params } }),
    signal:  AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`Mubert HTTP ${r.status}`);
  const data: any = await r.json();
  if (data.status !== 1) throw new Error(`Mubert: ${data.error?.text || 'unknown error'}`);
  return data;
}

export default async function handler(req: Request) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({
      error:  'POST required',
      usage:  { genre: GENRES, token: 'optional — token symbol for themed music', wallet: 'optional — $ORLIX holder wallet' },
    }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }

  let body: any;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const apiKey = process.env.MUBERT_API_KEY || '';
  if (!apiKey) return new Response(JSON.stringify({ error: 'MUBERT_API_KEY not configured' }), { status: 503, headers: { 'Content-Type': 'application/json' } });

  const genre  = (GENRES.includes(body.genre as Genre) ? body.genre : 'trap') as Genre;
  const symbol = (body.token || body.symbol || '').toUpperCase();
  const wallet = body.wallet || null;
  const tier   = await getOrlixTier(wallet);

  // Holders get longer tracks
  const duration = tier.tier === 'DIAMOND' ? 60
    : tier.tier === 'GOLD'    ? 45
    : tier.tier === 'SILVER'  ? 40
    : tier.tier === 'BRONZE'  ? 35
    : 30;

  const prompt = GENRE_PROMPTS[genre] + (symbol ? `, ${symbol} token anthem` : ', crypto trading anthem');

  try {
    const startData: any = await mubertPost('RecordTrackTTM', { text: prompt, duration, format: 'mp3', intensity: 'medium' }, apiKey);
    const taskId = startData.data?.tasks?.[0]?.task_id;
    if (!taskId) throw new Error('No task ID from Mubert');

    // Poll up to 50s
    for (let i = 0; i < 14; i++) {
      await sleep(3500);
      const pollData: any = await mubertPost('GetTrackTTM', { task_id: taskId }, apiKey);
      const task = pollData.data?.tasks?.[0];
      if (!task) continue;
      if (task.task_activation_status === 'Done' && task.download_link) {
        return withTier({
          audioUrl:  task.download_link,
          genre,
          token:     symbol || null,
          duration:  `${duration}s`,
          timestamp: new Date().toISOString(),
          poweredBy: 'Orlix AI + Mubert — orlixai.xyz',
        }, tier);
      }
      if (task.task_activation_status === 'Error') throw new Error('Mubert generation failed');
    }
    throw new Error('Music generation timed out');
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: { 'Content-Type': 'application/json' } });
  }
}
