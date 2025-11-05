// Fetch YouTube metadata (duration, views, likes, publish date, availability) for every video
// in the export, so Custom Tube can filter by length (Shorts / regular / long), upload date
// and hidden gems. Needs a free YouTube Data API v3 key (see README); about 130 requests,
// well inside the free daily quota. Resumable: videos already in the output are skipped.
//
//   YOUTUBE_API_KEY=... npm run data:youtube
//
// YouTube's developer policies expect stored API data to be refreshed from time to time;
// delete data/youtube_meta.jsonl and run this again to refresh it.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { readConfig } from '../src/server.js';

const key = process.env.YOUTUBE_API_KEY;
if (!key) {
  console.error('Set YOUTUBE_API_KEY first (see README: "YouTube metadata").');
  process.exit(1);
}

const cfg = readConfig();
const videosFile = path.join(cfg.dataDir, 'videos.jsonl');
const out = cfg.metaFile;
const vids = readFileSync(videosFile, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l).vid);
const done = new Set(
  existsSync(out)
    ? readFileSync(out, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l).vid)
    : [],
);
const todo = vids.filter((v) => !done.has(v));
console.log(`${vids.length} videos, ${done.size} already fetched, ${todo.length} to go`);

for (let i = 0; i < todo.length; i += 50) {
  const ids = todo.slice(i, i + 50);
  const url = new URL('https://www.googleapis.com/youtube/v3/videos');
  url.searchParams.set('part', 'snippet,contentDetails,statistics,status');
  url.searchParams.set('id', ids.join(','));
  url.searchParams.set('key', key);
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    // Don't print the URL: it contains the key.
    console.error(`YouTube API returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
    process.exit(1);
  }
  const body = await res.json();
  const got = new Map((body.items ?? []).map((it) => [it.id, it]));
  // Ids missing from the response were deleted or made private.
  appendFileSync(out, ids.map((vid) => JSON.stringify({ vid, item: got.get(vid) ?? null })).join('\n') + '\n');
  console.log(`fetched ${Math.min(i + 50, todo.length)}/${todo.length}`);
  await new Promise((r) => setTimeout(r, 200));
}
console.log(`Done. Wrote ${out}. Restart the server to use it.`);
