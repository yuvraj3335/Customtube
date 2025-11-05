// Build the browser bundle: esbuild bundles client/app.js (and the npm packages it imports)
// into public/app.js, and the Tailwind CLI compiles client/styles.css into public/styles.css.
// Both outputs are generated, git-ignored, and rebuilt by `npm start` and the test scripts.
//
//   node scripts/build.js           one build
//   node scripts/build.js --watch   rebuild on change (npm run dev)

import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
  legalComments: 'none', // notices for bundled packages go to public/licenses.txt instead
  metafile: true,
  logLevel: 'warning',
};

function tailwind() {
  const bin = path.join(root, 'node_modules/@tailwindcss/cli/dist/index.mjs');
  const args = [bin, '-i', path.join(root, 'client/styles.css'), '-o', path.join(root, 'public/styles.css')];
  // 'always': keep watching even though stdin is closed (plain --watch exits when it closes)
  if (watch) args.push('--watch=always');
  else args.push('--minify');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'inherit', 'pipe'] });
    if (watch) {
      // stopping the watcher stops Tailwind too, so nothing is left running
      const stop = () => {
        child.kill('SIGTERM');
        process.exit(0);
      };
      process.on('SIGTERM', stop);
      process.on('SIGINT', stop);
    }
    let err = '';
    child.stderr.on('data', (d) => {
      const text = String(d);
      // the CLI prints its timing line to stderr; only surface real errors
      if (!/^≈ tailwindcss|^Done in/m.test(text)) err += text;
    });
    child.on('exit', (code) => (code === 0 || watch ? resolve() : reject(new Error(`tailwind exited with ${code}: ${err}`))));
  });
}

/**
 * public/licenses.txt: the licence text of every npm package bundled into public/app.js (and
 * Tailwind, whose CSS ships too), so the shipped client carries its third-party notices.
 */
function writeLicenses(metafile) {
  const packages = new Set(['tailwindcss']);
  for (const input of Object.keys(metafile.inputs)) {
    const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
    if (m) packages.add(m[1]);
  }
  const parts = ['Third-party software in the Custom Tube web client', '='.repeat(52), ''];
  for (const name of [...packages].sort()) {
    const dir = path.join(root, 'node_modules', name);
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
    parts.push(`${name} ${pkg.version} (${pkg.license ?? 'see below'})`, '-'.repeat(60), file ? readFileSync(path.join(dir, file), 'utf8').trim() : `License: ${pkg.license}`, '');
  }
  writeFileSync(path.join(root, 'public/licenses.txt'), parts.join('\n'));
}

if (watch) {
  const ctx = await esbuild.context(js);
  await ctx.watch();
  console.log('watching client/ for changes');
  await tailwind();
} else {
  const t0 = Date.now();
  const [result] = await Promise.all([esbuild.build(js), tailwind()]);
  writeLicenses(result.metafile);
  console.log(`built public/app.js, public/styles.css and public/licenses.txt in ${Date.now() - t0} ms`);
}
