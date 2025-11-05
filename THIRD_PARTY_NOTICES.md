# Third-party notices

Custom Tube uses the following open-source software. Each keeps its own licence.

## Bundled into the web client (`public/app.js`, `public/styles.css`)

The full licence texts are generated at build time into `public/licenses.txt` (served at
`/static/licenses.txt`).

| Package | Licence |
|---|---|
| lucide | ISC |
| @floating-ui/dom, @floating-ui/core, @floating-ui/utils | MIT |
| fuse.js | Apache-2.0 |
| tailwindcss (generated CSS) | MIT |

## Server runtime (`dependencies`)

| Package | Licence | Notes |
|---|---|---|
| @huggingface/transformers | Apache-2.0 | Query embeddings. Pulls in `onnxruntime-node` (MIT) and `sharp` (Apache-2.0), whose prebuilt `@img/sharp-libvips-*` binaries are **LGPL-3.0-or-later**: if you distribute `node_modules` or a container image, keep the libvips licence and allow relinking (shipping the unmodified npm package satisfies this in practice). |
| lru-cache | BlueOak-1.0.0 | Keep its licence text or a link with redistributions. |
| @petamoriken/float16 | MIT | |

## Build and development only (not shipped)

esbuild (MIT), @tailwindcss/cli (MIT; uses lightningcss, MPL-2.0), eslint (MIT), globals (MIT),
playwright-core (Apache-2.0).

## Models and data

- Search model: `Xenova/bge-small-en-v1.5` (MIT, from BAAI's `bge-small-en-v1.5`), downloaded at
  first start into `.cache/models`.
- Video data: the HackerTube export, ODC-By 1.0, derived from `open-index/hacker-news`; credit
  HackerTube (https://hackertube.org) and the dataset. Hacker News comments remain the work of their
  authors; video titles and channel names belong to their creators. YouTube metadata, if you fetch
  it, is subject to the YouTube API Services Terms.
