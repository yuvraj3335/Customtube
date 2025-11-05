# Custom Tube

A YouTube front end where you decide what your feed shows. It starts from the videos Hacker News has
recommended for nearly 20 years (6,454 videos, 39,834 labeled HN comments, 150 topics), and you add,
filter and mix from there.

- **Watch in the app.** Videos remember where you stopped (Continue watching, progress bars, "Resume
  at 12:34"), the next one autoplays after a 5-second countdown you can cancel, and lists play in
  order. Share any video with one click.
- **Quick search** (⌘K / Ctrl+K): videos and topics as you type, plus every page and action.
- **First visit:** pick a few topics and the first feed is already yours. A **Following** tab shows
  only the topics you follow.
- **Installable** as an app (desktop and phone), and its screens open offline.
- **Home** is a feed made from several sources: HN classics, recent favourites, topics you haven't
  explored, videos similar to your likes, what the same HN people also recommended, topics you follow,
  hidden gems, and videos you added yourself. Hover a card to see why it's there.
- **Customize** chooses exactly what Home may show and how it's mixed:
  - formats: Shorts (up to 3 minutes), regular videos, long videos (over an hour)
  - kinds of video: talk, lecture, documentary, tutorial, comedy, music and the rest
  - topics to follow (they get their own spot in the feed) or mute (never shown)
  - channels to hide
  - a weight from 0 to 5 for every feed source (0 turns it off)
  - news-only videos and videos HN only cited (off by default)
  - export everything to a file and import it in another browser
- **My videos** adds any YouTube video or Short by pasting its link. They join your feed, as often as
  you set.
- **Every card's ⋯ menu**: Watch later, Save to list, Not interested (with undo), Hide this channel.
- **Library** keeps Watch later, Liked, History, My videos and your **Lists**: your own playlists,
  which you can reorder and play on YouTube in one click ("Play all" works on every page, up to 50
  videos, no account needed).
- **Topics** has quick views of the whole collection: recently recommended, most recommended,
  lectures, documentaries, and (with YouTube metadata) hidden gems, over an hour, under 4 minutes.
- **Search** matches by meaning (the `bge-small-en-v1.5` model the data's vectors were made with), plus
  whole-word keywords (singular or plural, and names like C++, C# and .NET) and topics, with filters
  and sorting. Sorting by anything but relevance re-orders only the clearly relevant hits, and
  re-uploads of the same video are shown once.
- **Every video page** shows what HN actually said about it, linking back to the comments, with "Up
  next" built from shared HN recommenders and similar topics.
- No accounts and no tracking. Your likes, history, settings and added videos stay in your browser;
  the server keeps none of it. Videos play through YouTube's privacy-enhanced embed, and only after
  you press play.

## Run it

Needs Node 22.23.4+ (or 24.22.1+); `nvm use` picks the version from `.nvmrc`. `data:fetch` needs `curl` and
`unzip`, and the browser tests need Google Chrome.

```bash
npm ci
npm run data:fetch      # downloads the HackerTube data export (18 MB zip, 48 MB unpacked) into data/raw/
npm start               # builds the client, then serves http://127.0.0.1:8080
```

`npm run dev` builds once, then rebuilds the client (JS and CSS) as you edit and restarts the server when
server code or a rebuilt file changes. Ctrl+C or SIGTERM stops all of it.

On first start the search model (~34 MB) downloads from Hugging Face into `.cache/models/`. Until it
is ready, search uses keywords only.

### Settings

| Variable | Default | What it does |
|---|---|---|
| `PORT`, `HOST` | `8080`, `127.0.0.1` | Where the server listens |
| `CUSTOMTUBE_DATA_DIR` | `data/raw/hackertube-data` | The unzipped data export |
| `CUSTOMTUBE_YOUTUBE_META` | `data/youtube_meta.jsonl` | Optional YouTube metadata (below) |
| `CUSTOMTUBE_EMBEDDER` | on | `off` skips the model; search is keyword-only |
| `CUSTOMTUBE_MODEL_CACHE` | `.cache/models` | Where the model is cached |
| `PUBLIC_URL` | none | Public origin, for canonical link tags, e.g. `https://tube.example.com` (checked at startup) |
| `MAX_CONNECTIONS` | `2000` | Open connections the server accepts at once |
| `TRUST_PROXY` | `0` | How many proxies of yours sit in front of the server (e.g. `1` for one reverse proxy, `2` for a CDN plus a load balancer). Rate limits then key on the client address those proxies report; anything a client adds further left is ignored. Only set it when the server can't be reached except through those proxies: a client that reaches it directly could forge the header and dodge every limit |

### Deploying

See [DEPLOY.md](DEPLOY.md): free hosting on Render (one click with `render.yaml`), Google Cloud Run,
or any VM with Docker. `docker build -t customtube .` makes a self-contained image (app, data and
search model) that runs in about 300 MB of RAM.

### Running it for real

- `npm start` caps the V8 heap at 384 MB; the process settles around 400–500 MB RSS under load, so
  a 1 GB box is enough. Put it behind nginx or Caddy (TLS, HTTP/2) and set `TRUST_PROXY=1`.
- `SIGTERM`/`SIGINT` stop accepting connections, let in-flight requests finish, and force-close
  after 10 seconds.
- `/healthz` reports `degraded: true` while search is keyword-only because the model couldn't load;
  the server retries loading it with backoff (30 s, doubling, up to every 10 minutes).
- Rate limits: per client for every API route, plus server-wide budgets for the two expensive
  things, building a new profile's feed (about 30% of one core at most) and searching (30 per
  second). Over budget the server answers 503 with `Retry-After`.
- Static files are compressed once at startup and served with ETags (304 when unchanged).

### YouTube metadata (for Shorts, lengths, dates and view counts)

The data export has no durations, view counts or upload dates, because YouTube's terms don't allow
redistributing them. Without them, everything works except: the Shorts / regular / long format
choice for HN videos (it still applies to videos you add yourself), the length and upload-date
filters, hidden gems, and the sorts by date, views and like ratio.

To get them, you need a free YouTube Data API key (about 5 minutes, no credit card):

1. Open https://console.cloud.google.com/ and create a project.
2. Under **APIs & Services → Library**, enable **YouTube Data API v3**.
3. Under **APIs & Services → Credentials**, create an **API key**, and restrict it to the YouTube
   Data API v3.
4. Run the fetch (about 130 requests, well inside the free daily quota). Keep the key out of files:

```bash
YOUTUBE_API_KEY=your-key npm run data:youtube
```

Then restart the server. The script resumes where it stopped. YouTube's developer policies expect
stored data to be refreshed now and then: delete `data/youtube_meta.jsonl` and run it again.

## How the feed works

All the ranking happens on the server, per request, from what the browser sends: likes, dislikes,
the last 200 videos opened, a random seed that changes on each page load, and the curation settings.
The same inputs always give the same feed, so scrolling never repeats or skips a video.

- **Score.** A video's score is the number of different months HN recommended it in, with months
  that had a strong recommendation counting half extra. Lasting recommendations beat one viral spike.
- **Sources.** Each source puts its candidates in a weighted random order (Efraimidis–Spirakis), e.g.
  classics weighted by score², similar videos by embedding similarity to your likes. The sources then
  take turns in proportion to their mix weights (smooth weighted round-robin), skipping videos already
  used and avoiding three in a row from one channel.
- **Likes.** Up to 500 are kept and all of them are left out of the feed. "Similar" and "same
  recommenders" are computed from your 30 most recent likes.
- **Dislikes** (up to 500, all left out): videos almost identical to one of your last 100 dislikes
  (cosine ≥ 0.88) are dropped, videos similar to your last 30 are pushed down, and a disliked video's
  channel shows up half as often.
- **Explore** only offers topics none of your likes, dislikes, history or followed topics touch, on
  any of a video's topics.
- **Left out by default:** news-only videos, videos HN only cited, duplicate uploads of the same talk,
  videos YouTube won't play in an embed (when metadata says so), and anything you've opened, liked or
  disliked.
- **Cost.** The expensive part (dislike penalties and similarity to your likes, about 140 ms for a
  200-like profile) is cached per profile and settings, so a new seed costs about 2 ms.

## API

All endpoints answer `GET` with JSON and reject unknown, invalid or empty parameters with a 400
(an empty filter is never read as "no filter"). Every `/api/*` route has a per-client rate limit
(a burst of 240, then 40 per second; over it: 429 with `Retry-After`). Feed building, search and
suggestions also have server-wide budgets; over those: 503 with `Retry-After`. `offset` is at most
100,000 everywhere.

| Endpoint | Parameters |
|---|---|
| `/api/feed` | `like`, `dislike` (ids, ≤500 each), `seen` (≤200), `seed`, `offset`, `n` (≤60); curation: `formats`, `types`, `follow_topics`, `mute_topics`, `mute_channels`, `mix`, `news`, `cited`. Also takes `POST` with a JSON body (what the client uses, since a big profile doesn't fit in a URL), e.g. `{"like": ["…"], "types": ["talk"], "mix": {"explore": 0}, "mute_channels": ["Some Channel"], "news": true}`. The body is at most 64 KB (413 when larger) and must be `application/json` (415 otherwise); a POST takes nothing in its URL. In the `GET` form lists are comma-separated, `mute_channels` names are URI-encoded first, and `mix` is `classics:3,explore:0` |
| `/api/list` | `cat` or `area`, `offset`, `n` (≤60, default 24), and filters: `type`, `level`, `evergreen`, `sort`; with metadata also `dur`, `date`, `gems` |
| `/api/search` | `q` (≤200 chars) and the same filters; `sort` defaults to `relevance`; at most 60 results |
| `/api/video` | `vid`: the card, HN stats and comments |
| `/api/related` | `vid`, `n` (≤40, default 20) |
| `/api/docs` | `vids` (≤200): cards for saved lists, in order; unknown or deleted ids are skipped |
| `/api/suggest` | `q` (≤200 chars; a single character returns nothing): up to 6 videos and 4 topics for as-you-type search (the last word may be a prefix); cached |
| `/api/oembed` | `vid`: title and channel of any YouTube video, for My videos (via YouTube's public oEmbed; rate limited) |
| `/api/browse`, `/api/stats`, `/api/config` | none |

## Develop and test

```bash
npm run lint
npm test            # unit + API tests on a synthetic fixture (no download needed)
npm run test:e2e    # the real client in headless Chrome
npm run test:all
```

The browser tests use the real data and the real model when `data/raw/hackertube-data` exists, and
the fixture otherwise. They need Google Chrome installed, or `CHROME_PATH` set to a Chromium-family
browser. Every request that would leave localhost (thumbnails, YouTube) is answered locally.

The client is built from `client/` with **esbuild** (bundling) and **Tailwind CSS v4** (styles) into
`public/app.js` and `public/styles.css`; `npm start` and the test scripts build it first. It uses
**Lucide** for icons, **Floating UI** to place menus, and **Fuse.js** for fuzzy matching in quick
search. The YouTube player is driven through YouTube's documented iframe `postMessage` protocol, so
no third-party script runs on the page.

```
client/          app.js (pages, router, state), player.js, palette.js, icons.js, styles.css (Tailwind)
public/          index.html, sw.js, manifest.webmanifest, icons; built app.js and styles.css
src/
  server.js      HTTP server: API routes, app shell with per-page <meta>, static files
  data.js        loads the export, re-orders embeddings, finds duplicate uploads, topic centroids
  feed.js        the Home feed sources and how they're interleaved
  curation.js    the viewer's feed settings: parsing, filtering, mix pattern
  search.js      semantic + keyword search, weak-match detection
  related.js     "Up next"
  filters.js     list/search filters and sorts
  embedder.js    query embeddings with transformers.js (bge-small-en-v1.5, CLS pooling)
  npy.js, rng.js, vec.js, ratelimit.js, http.js
scripts/         build.js (esbuild + Tailwind), dev.js, fetch-data.sh, fetch-youtube-meta.js
test/            unit, api and e2e tests, plus the fixture generator
```

## Licence

Copyright © 2026 the Custom Tube authors. All rights reserved (see `LICENSE`). Third-party software
and its licences are listed in `THIRD_PARTY_NOTICES.md`; the web client serves the notices for the
code it bundles at `/static/licenses.txt` (linked from About).

## Credits and data licence

The video data comes from the [HackerTube](https://hackertube.org) data export (exported 2026-10-31),
released under the [Open Data Commons Attribution License (ODC-By) v1.0](https://opendatacommons.org/licenses/by/1-0/),
and derived from the [open-index/hacker-news](https://huggingface.co/datasets/open-index/hacker-news)
archive. Hacker News data is provided by Y Combinator, and comments remain the work of their authors.
The labels, summaries and topics were written by an LLM, so expect a few to be off. Video titles and
channel names belong to their creators.

The data is not committed to this repository; `npm run data:fetch` downloads it. Custom Tube is an
independent project, not affiliated with HackerTube, YouTube, Google, Hacker News or Y Combinator.
