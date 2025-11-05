// Build the browser bundle: esbuild bundles client/app.js (and the npm packages it imports)
// into public/app.js, and the Tailwind CLI compiles client/styles.css into public/styles.css.
// Both outputs are generated, git-ignored, and rebuilt by `npm start` and the test scripts.
//
//   node scripts/build.js           one build
//   node scripts/build.js --watch   rebuild on change (npm run dev)

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');

const js = {
  entryPoints: [path.join(root, 'client/app.js')],
  outfile: path.join(root, 'public/app.js'),
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  legalComments: 'linked',
  logLevel: 'warning',
};

function tailwind() {
  const bin = path.join(root, 'node_modules/@tailwindcss/cli/dist/index.mjs');
  const args = [bin, '-i', path.join(root, 'client/styles.css'), '-o', path.join(root, 'public/styles.css')];
  if (watch) args.push('--watch');
  else args.push('--minify');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'inherit', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => {
      const text = String(d);
      // the CLI prints its timing line to stderr; only surface real errors
      if (!/^≈ tailwindcss|^Done in/m.test(text)) err += text;
    });
    child.on('exit', (code) => (code === 0 || watch ? resolve() : reject(new Error(`tailwind exited with ${code}: ${err}`))));
  });
}

if (watch) {
  const ctx = await esbuild.context(js);
  await ctx.watch();
  console.log('watching client/ for changes');
  await tailwind();
} else {
  const t0 = Date.now();
  await Promise.all([esbuild.build(js), tailwind()]);
  console.log(`built public/app.js and public/styles.css in ${Date.now() - t0} ms`);
}
