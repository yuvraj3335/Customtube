// Download the search model into the model cache ahead of time (used by the Docker build), so a
// fresh server has semantic search from its first request instead of after a download.
import { createEmbedder } from '../src/embedder.js';
import { readConfig } from '../src/server.js';

const cfg = readConfig({ ...process.env, CUSTOMTUBE_EMBEDDER: 'on' });
const embedder = createEmbedder({ cacheDir: cfg.cacheDir, retryMs: 2 ** 31 - 1 });
await embedder.start();
if (embedder.status() !== 'ready') {
  console.error('Could not download the search model.');
  process.exit(1);
}
const vec = await embedder.embed('distributed systems');
console.log(`model ready in ${cfg.cacheDir} (${vec.length} dimensions)`);
process.exit(0);
