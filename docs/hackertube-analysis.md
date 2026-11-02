# HackerTube: how it works

Studied on 2 November 2026. Sources:

- The public homepage `https://hackertube.org/`: its HTML, its inline script (read only, nothing copied) and one normal page load in headless Chromium.
- `robots.txt`, which disallows `/api/` and `/download/`. We did not crawl or bulk-fetch either path. The single page load let the page make its usual calls (`/api/config` and one `/api/feed`). We made no direct API calls.
- Two MIT-licensed community clients, which document the same JSON API:
  - [ephraimduncan/hackertube.tv](https://github.com/ephraimduncan/hackertube.tv) (Android TV, Kotlin), © 2026 Ephraim Duncan
  - [iTzFaisal/hackertube](https://github.com/iTzFaisal/hackertube) (Samsung Tizen, ES5 JS), MIT
- [morluto/rea](https://github.com/morluto/rea) (MIT): see "Method" at the end.

## 1. What the product is

HackerTube is **not a YouTube clone**. It is a curated index of YouTube videos that Hacker News commenters recommend to each other, with a YouTube-style browsing UI on top. Its tagline is *"The YouTube videos that Hacker News keeps telling each other to watch."* Its About page argues that YouTube's recommendations optimise for watch time, while HN's recommendations, collected over about two decades, surface talks and lectures with lasting value.

It hosts no video. Playback uses YouTube's privacy-enhanced embed (`youtube-nocookie.com/embed/{id}`), and thumbnails come from `i.ytimg.com/vi/{id}/hq2.jpg`.

## 2. Features (user-visible)

| Area | What it does |
|---|---|
| **Home** | Infinite grid of personalised picks, plus a **Filters** bar: era chips (Past year, 2020s, 2010s, 2000s), type chips (Talk, Lecture, Explainer, Tutorial, Documentary, Interview, Demo, Commentary, Comedy, Music), length chips (<4 min, 4–20, 20–60, >1 h), "Hidden gems", "Evergreen only", and sort (Best first, Recently recommended, Upload date, Oldest, View count, Like ratio). The feed mixes HN classics, hidden gems (loved on HN, few views), recent favourites, unexplored topics and, once you have likes, "similar" and "same HN people also recommend". Hovering a card shows why it is there. |
| **Search** | Search by words and by meaning: "distributed systems" finds talks that never use those words. A result can carry `via`, the topic it matched on. |
| **Longs** | The same browse page filtered to `dur=xlong` (over 1 hour). The community TV clients describe this section as **Longs**. |
| **Liked / History / Watch later** | Stored only in `localStorage`, with no accounts. Likes and dislikes steer the Home feed. |
| **Categories** | About 20 "areas", each holding topic categories, with counts. Each category page is filterable and sortable. |
| **Playlists** | Hand-made lists written by Claude, in tiers such as "broad, essential lists for your first visit" and "one obsession each, for when you want to go down a rabbit hole". Each has an intro, a running time, a cover mosaic, a per-video note, and "Play all on YouTube" (`watch_videos?video_ids=…`). |
| **Video page** | Embedded player, a meta line (views · age · content type · shelf life), **summary**, **why HN likes it**, category tags, "Cited N× on HN, first–last", the **actual HN comments** (author, month, story, text, link to the thread) and **Up next** (related videos). |
| **About / Data** | Stats, how it was built, credits, and a downloadable dataset (zip). |
| **Settings, keyboard** | Theme toggle; `?` help, `/` search, `j`/`k` move, `w` watch later, `h` home. |

## 3. Architecture

```
Browser (one HTML file, inline CSS + vanilla JS, client-side router)
   │  fetch JSON                      │ <iframe> youtube-nocookie embed
   ▼                                  ▼
hackertube.org /api/*  (read-only JSON over a prebuilt index)      YouTube
   │
   ▼
Offline build artefacts: videos.jsonl, mentions.jsonl, taxonomy.json,
related.jsonl, embeddings.npy (bge-small-en-v1.5, 384-d, float16)
```

- **Front end:** a single `index.html` of about 68 KB with inline CSS and an inline script. It uses no framework. The router uses `history` paths (`/`, `/search`, `/watch`, `/c/{id}`, `/liked`, `/history`, `/later`, `/categories`, `/playlists`, `/about`, `/settings`). The store is a tiny `localStorage` wrapper with keys such as `likes`, `dislikes`, `seen` and `later`. CSS variables handle the light and dark themes.
- **API** (shape from the MIT clients and the page's script). It is read-only, with no auth and no CORS headers:

| Endpoint | Params | Returns |
|---|---|---|
| `GET /api/feed` | `like, dislike, seen` (comma-separated ids; `seen` capped at the last 200), `seed`, `offset`, `n` | `Video[]`, personalised |
| `GET /api/list` | filters `cat, area, dur, sort, …`, `offset`, `n` | `Video[]` |
| `GET /api/search` | `q` | `{results: Video[]}` (hybrid keyword + vector) |
| `GET /api/video` | `vid` | `{video, comments[]}` |
| `GET /api/related` | `vid, n` | `Video[]` |
| `GET /api/docs` | `vids` | `Video[]` in the given order (for Liked/History/Later) |
| `GET /api/browse` | none | `Area[]` with nested categories and counts |
| `GET /api/playlists`, `/api/playlist` | `slug` | playlist cards / one playlist |
| `GET /api/config`, `/api/stats`, `/api/export` | none | frame source, counts, dataset manifest |

- **Video record** (fields): `vid, title, channel, published, duration_s, views, summary, why_hn, content_type, shelf_life, categories[{id,name,area_name}], hn{mentions, recommenders, rec_months, first, last}, via?, note?`.
- **Personalisation is stateless on the server.** The client sends its likes, dislikes and seen ids, plus a random `seed`, with every feed request. The server re-ranks and stores nothing. That keeps it account-free and private.

## 4. Data pipeline: how it gets its data

From the About page's "How it was built" section, together with the dataset manifest:

1. **Source corpus.** The full Hacker News archive from the public Hugging Face dataset [`open-index/hacker-news`](https://huggingface.co/datasets/open-index/hacker-news) (ODC-By 1.0, monthly Parquet files, live-updated). Every comment from 2006 onwards is scanned for YouTube links, which turns up well over 100,000 distinct videos.
2. **Threshold.** A video is kept only if **at least 3 different people** linked it with real commentary **in at least 3 different months**. That leaves about 7,000 videos. This rule is the key quality filter: it captures lasting recommendations and drops drive-by links.
3. **Comment labelling (LLM).** Claude reads each linking comment together with its HN story title. It labels the comment's **stance** (recommending, citing as a source, joke, criticism), extracts a short **quote** and tags **topics**. The result is `mentions.jsonl`.
4. **Video cards (LLM).** Claude writes each card from the YouTube metadata (YouTube Data API) and everything HN said about the video. A card has a **summary**, **why HN likes it**, **content type**, **level** and **shelf life** (has it aged well). The result is `videos.jsonl`.
5. **Taxonomy (LLM).** Claude writes a shared topic list (areas, then categories) with synonym-rich descriptions. Videos are sorted into it (`taxonomy.json`).
6. **Ranking.** A video's standing comes mainly from the **number of distinct months** in which people recommended it, so it rewards durability over viral spikes. "Hidden gems" combine high HN standing with low YouTube views.
7. **Related.** "HN people also recommend" uses co-recommendation counts between videos, with no usernames (`related.jsonl`). "Similar" uses embedding neighbours.
8. **Search.** Embeddings from `bge-small-en-v1.5` (384 dimensions) over the card text give semantic search and similar-video lookups. They are combined with keyword matching.

**How Claude-written content is used.** Claude produced the comment stance labels, the per-video summary and "why HN likes it", the type, level and shelf-life tags, the taxonomy, and the playlist intros and notes. The credits say Claude Opus 5.5 built the pipeline and site in Claude Code, and that teams of Claude Sonnet 5.5 agents, coordinated by Opus, wrote the labels, cards and topics. The site says plainly that these were written by Claude, "so expect a few to be off". In the UI the summary is the main description, "why HN likes it" is the recommendation reason, the stance labels decide which comments count as recommendations, and the topics drive chips, categories and semantic search.

**Licensing.** The dataset is ODC-By 1.0: use it for anything, crediting HackerTube and `open-index/hacker-news`. YouTube metadata is **not** redistributed, because YouTube's terms forbid it. Only ids are shipped, and users re-fetch the metadata themselves. We found no code licence for the website, so InstaTube reimplements the behaviour and copies none of its code.

## 5. What carries over to Instagram, and what doesn't

| HackerTube ingredient | Instagram equivalent | Problem |
|---|---|---|
| Free, open recommendation corpus (HN) with many YouTube links | We need a corpus of people recommending specific IG posts | HN has very few IG post links (measured in `instagram-data-plan.md`) |
| YouTube embed playable without API keys | Instagram's official embed (`embed.js` / `/p/{code}/embed`) | Works for public posts. No thumbnails or titles are allowed outside the embed (see the oEmbed terms) |
| YouTube Data API for titles, durations and views (kept out of the redistributed data) | Instagram Graph API: Business Discovery, Hashtag Search | Needs a Meta app, a professional IG account and App Review. Only professional accounts are covered |
| Claude-written summary and "why HN likes it" | Claude-written summary and "why people recommend it", written **from the recommenders' text**, not from Instagram content | We may not persist or derive from oEmbed content |
| Stateless, account-free personalisation | Same | none |
| bge-small semantic search | Same | none |
| "Longs" (over 1 hour) | **Reels / short-form** section | Instagram is short-form by nature, so the short-form section is the natural one |

## 6. Method

REA (`morluto/rea`) is an MCP and CLI toolkit for reverse-engineering binaries, apps and websites. For websites it offers passive Chrome DevTools Protocol observation, static bundle analysis that extracts route and endpoint candidates, and evidence reports that state their limits. We applied the **method** rather than installing the toolchain, because the target is one unminified inline script, and a native-analysis and CDP setup would cost more than it reveals:

- **Static bundle analysis:** extracted endpoint candidates (`/api/*`, `/download/*`), route names, UI strings and data-field names from the inline script.
- **Passive observation:** loaded the homepage once in headless Chromium and recorded its requests (`/api/config`, `/api/feed?like=&dislike=&seen=&seed=…&offset=0&n=36`, and thumbnails from `i.ytimg.com`), plus the visible chips.
- **Evidence with stated limits:** the facts above come from the About text, the script and the MIT clients. These are **inferred and unconfirmed**: the server-side ranking formula, the exact weights in the feed mix, and how hybrid search combines its scores. The server code is not public.
