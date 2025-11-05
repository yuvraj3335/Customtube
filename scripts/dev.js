// npm run dev: build once, then rebuild the client on change and restart the server when the
// server code or a built file changes. One process owns both children, so stopping it (Ctrl+C
// or SIGTERM) stops everything.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;
const run = (args) => spawn(node, args, { cwd: root, stdio: 'inherit' });

const first = run(['scripts/build.js']);
first.on('exit', (code) => {
  if (code !== 0) process.exit(code ?? 1);
  const children = [
    run(['scripts/build.js', '--watch']),
    // the server reads public/ at startup, so a rebuilt bundle restarts it too
    run(['--watch-path=src', '--watch-path=public', 'src/server.js']),
  ];
  const stop = () => {
    for (const c of children) c.kill('SIGTERM');
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  for (const c of children) c.on('exit', (code) => code && code !== 0 && stop());
});
