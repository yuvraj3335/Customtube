# InstaTube: where the Instagram data comes from

Written 2 November 2026. Every Meta term below was checked against Meta's live pages today, not recalled from memory. Yield numbers marked **measured** come from scans we ran today. Numbers marked **estimate** are reasoned and say so.

> Not legal advice. Before any public launch, a lawyer should review the Meta terms, the trademark question (the name contains "Insta") and the content of the recommendation sources.

## 0. The short version

HackerTube works because Hacker News is a large, free, openly licensed corpus of people recommending YouTube videos, and YouTube lets anyone embed them. Instagram has the embed half (official embeds work for public posts with no login). It does **not** have the corpus half: we measured, and there are very few public recommendations of specific Instagram posts in open sources.

**Recommendation: Plan R, "recommended-by-people, shown-by-embed".** Build the catalogue from public, openly licensed recommendation sources (Hacker News now, a Bluesky collector going forward, and editorial or user submissions). Show every post **only through Instagram's official embed**. Claude writes the summaries and the "why it's recommended" text **from what the recommenders said**, never from Instagram's content. We store no Instagram metadata, call no Meta API by default, and log in to no Instagram account. Expect a catalogue of about **1–2 thousand items** at launch, not HackerTube's 7,000, and a weaker quality signal. Section 6 gives the details.

## 1. The rules that constrain every option

| Rule | Source (checked 2 Nov 2026) | Effect on InstaTube |
|---|---|---|
| Instagram Terms of Use forbid "collecting information in an automated way without our express permission". Meta's separate Automated Data Collection Terms (effective 7 Oct 2024, per secondary sources) require express written permission for scrapers, bots and crawlers. | [Instagram Terms](https://help.instagram.com/581066165581870), [Open Terms Archive memo](https://opentermsarchive.org/en/memos/instagram-blocks-data-retrieval-and-clarifies-what-information-it-retrieves/) | No scraping of instagram.com pages, profiles, hashtags or private endpoints. No logged-in automation. This was already a project rule. |
| The **oEmbed** endpoint is "meant only for embedding". Using its metadata or content for other purposes, including **persisting it or deriving analytics from it**, is prohibited. Private, inactive, age-restricted, embed-disabled accounts and Stories are not supported. 1,000 requests per hour. | [Meta oEmbed docs](https://developers.facebook.com/docs/instagram-platform/oembed) | We can render embeds. We **cannot** take captions or thumbnails from oEmbed to build our own cards, search index or summaries. |
| Since **3 Nov 2025**, oEmbed no longer returns `author_name`, `author_url` or `thumbnail_*`. Since **15 May 2026**, Instagram oEmbed can be called **without an access token**. | [Instagram Platform changelog](https://developers.facebook.com/docs/instagram-platform/changelog) | oEmbed now returns little more than embed HTML. Tokenless access means no Meta app is needed just to embed. |
| The **Basic Display API** was shut down on 4 Dec 2024. | changelog | There is no "read a personal account" API any more. |
| **Hashtag Search** allows 30 unique hashtags per IG professional account per rolling 7 days. It needs the *Instagram Public Content Access* feature, App Review and `instagram_basic`. Stories are not supported. | [Hashtag Search docs](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login/hashtag-search) | Possible, but it needs our own Business/Creator account, a Meta app and App Review. Thirty hashtags a week is a hard ceiling. |
| **Business Discovery** reads public metadata and metrics of *other professional accounts* by username, including per-post like, comment and view counts. Age-gated accounts are excluded. Since 30 Jul 2026, `media_url` is omitted for copyrighted-audio video and for reels whose owners disabled downloads. | [Business Discovery docs](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/business-discovery), changelog | Works only for creator and business accounts we list by hand. Needs our own professional IG account, a Meta app and App Review. |
| Graph API rate limits: Business Use Case limits for the Instagram Platform are "4800 × impressions" per 24 h. Business Discovery and Hashtag Search fall under the platform rate limits. | [Rate limiting](https://developers.facebook.com/docs/graph-api/overview/rate-limiting) | Fine for a small curated index. |
| **Meta Platform Terms** (last updated 3 Feb 2026): no selling or licensing of Platform Data (§3.a.iv). No building or augmenting user profiles without consent (§3.a.v). Delete data when no longer needed, when Meta or the user asks, or when the product shuts down (§3.d.i). | [Platform Terms](https://developers.facebook.com/terms/) | If we use the Graph API, we keep only what the feature needs, honour deletions and never redistribute it, unlike HackerTube's open dataset. |
| Trademark: "Insta" and the Instagram marks are Meta's. | Meta brand guidelines | The name must be reviewed before any public launch (project rule). |

## 2. Options evaluated

### A. Official Instagram embeds and oEmbed (display layer)

- **What:** `<blockquote class="instagram-media" data-instgrm-permalink="https://www.instagram.com/p/{code}/">` plus Instagram's `embed.js`, or tokenless oEmbed for the same HTML.
- **Legal:** ✅ This is Meta's sanctioned way to show public posts on third-party sites. Meta's terms apply to the embed.
- **Technical:** ✅ No keys, no account. ⚠️ Embeds are heavy iframes, so they should load only on the item page or on click. ⚠️ We get no thumbnail or title we may reuse, so our cards must be text cards.
- **Yield:** none on its own. It **displays** posts and does not **find** them, so it must be paired with a discovery source.
- **Cost:** free.

### B. Official Meta APIs (Graph API: Business Discovery + Hashtag Search)

- **What:** we create a Meta developer app, link our **own** Instagram professional account, pass App Review for Business Discovery and Public Content Access, then pull recent media for a hand-picked list of creator handles and up to 30 hashtags a week.
- **Legal:** ✅ Allowed within the Platform Terms and Developer Policies. ⚠️ App Review may reject a "curate other people's posts" use case. Meta decides, and review often takes weeks.
- **Technical:** caption, permalink, media type, timestamp, likes, comments and views (and `media_url` or `thumbnail_url` when allowed) for **professional accounts only**. Personal accounts are invisible. Hashtag Search returns only top and recent media.
- **Yield (estimate):** 200 hand-picked creators × their last ~50 posts ≈ **10,000 posts**, plus 30 hashtags × (~50 top + recent) ≈ **1,500 a week**. But there is **no "people recommend this" signal**: it is popularity, which is exactly what HackerTube was built to avoid.
- **Cost:** API calls are free. It needs a Facebook account, an IG professional account, business verification, possibly a privacy-policy URL, and **weeks of App Review** that cannot finish before the credit deadline (5 Nov 2026).
- **Risk:** a medium chance of App Review rejection. Tokens expire. Any account used must be a real business account we own. We would never use a personal account.

### C. Hacker News (open-index/hacker-news, ODC-By 1.0), measured

We scanned **the whole archive** (239 monthly Parquet files, Oct 2006–Aug 2026) for `instagram.com/{p|reel|reels|tv}/{code}` links in story URLs and comment text, handling HN's `&#x2F;` escaping:

| Measure | Result |
|---|---|
| HN items linking an IG post | **1,769** (1,312 comments, 457 stories) from 1,358 people |
| Distinct IG posts | **1,815** (about 2,822 `/p/`, 651 `/reel(s)/` and 71 `/tv/` link occurrences) |
| Linked by ≥ 2 different people | **53** |
| ≥ 2 people in ≥ 2 different months | **9** |
| HackerTube's bar (≥ 3 people, ≥ 3 months) | **1** |
| Distinct posts linked since 2023 | 743 |

For comparison, HackerTube starts from "well over a hundred thousand" YouTube videos and keeps about 7,000.

- **Legal:** ✅ ODC-By 1.0, crediting `open-index/hacker-news` (and HackerTube, if we use its method or data). Comment text stays its authors' work, so we show short quotes with links back to the thread.
- **Usable yield (estimate):** **about 900–1,300** posts still embeddable. We assume 30–50% of 2012–2026 posts were deleted, made private or had embeds disabled; old links rot. A dead embed is hidden in the browser, and nothing is fetched server-side to check.
- **Quality:** the "why" is real human context from HN (for example, "this reel shows the welding technique I meant"). Most posts have a single mention, so the ranking leans on Claude's stance label more than on counting recommenders.
- **Cost:** the archive download is free. Claude labelling costs are in section 5.

### D. Reddit: not available to us

- Reddit's Responsible Builder Policy (announced Nov 2025) ended self-service API access: new OAuth tokens need explicit approval, commercial or AI use needs a contract, and secondary sources report that **new public-API requests stopped being accepted on 31 Oct 2026** and that logged-out `.json` access ended in May 2026. We could not confirm these against Reddit's own wiki. ([r/redditdev announcement](https://r.datuan.dev/r/redditdev/comments/1oug31u/introducing_the_responsible_builder_policy_new/nohcaph/?context=3), [secondary summary](https://medium.com/@alex_79882/reddits-api-is-officially-dead-in-2026-here-s-what-i-use-instead-f88ee5b809c8))
- Reddit would otherwise be the richest source, with whole subreddits of "this reel is amazing" posts. **Yield for us: 0**, unless the user already holds approved API access or a data agreement. Scraping Reddit instead is ruled out.

### E. Bluesky (AT Protocol Jetstream, public firehose), measured

We listened to the public Jetstream feed (`app.bsky.feed.post`) for 3 + 10 minutes:

| Sample | Posts seen | Posts linking IG posts | Distinct IG posts | YouTube-linking posts |
|---|---|---|---|---|
| 10 min | 15,058 | 11 (from 10 accounts) | 16 | 265 |
| 3 min | 4,669 | 3 | 5 | 62 |

- **Raw yield (estimate):** about 16 per 10 min, so **about 2,300 distinct IG posts a day** and roughly **0.8 million a year**. Instagram links are about 24× rarer than YouTube links.
- **Usable yield (estimate):** most such posts are people sharing their **own** work, not recommending someone else's. Using HN's ratio (about 3% of posts get a second recommender) plus a Claude stance filter, we expect **roughly 20–70 genuinely recommended posts a day**. That builds **a few thousand a quarter**, and it builds slowly. The first week would add only a few hundred.
- **Legal:** ✅ public, open-protocol data with no login. ⚠️ We must honour deletions (Jetstream emits them) and Bluesky's developer guidelines. We could not load that page today, so it must be re-checked before launch. We would store post URI, author DID, a short quote and our labels, not full threads.
- **Cost:** free to consume. Needs an always-on collector process, which is cheap but can't run continuously on these cloud credits after 5 Nov.

### F. Editorial seed and user submissions

- **What:** an admin or users paste an IG post URL with a sentence on why it is worth watching. Claude turns that into a card.
- **Legal:** ✅ This is ordinary linking plus our own text.
- **Yield:** whatever the curators supply. It is the most reliable way to fill topics that are thin. It also makes InstaTube useful as a personal "watch later for Instagram" even with a small catalogue.

## 3. Yield summary

| Source | Measured raw | Usable at launch (estimate) | Ongoing | Has a "people recommend this" signal? | Blockers |
|---|---|---|---|---|---|
| A. Embeds / oEmbed | n/a (display) | n/a | n/a | n/a | none |
| B. Meta Graph API | n/a | 0 before App Review; ~10k after | ~1.5k/week | ❌ popularity only | App Review (weeks), our own business account |
| C. Hacker News | **1,815 posts** | **~900–1,300** | ~250/year | ✅ (weak: mostly single mentions) | none |
| D. Reddit | n/a | 0 | 0 | ✅ | API closed to new users |
| E. Bluesky | **~2,300/day** links | a few hundred in week 1 | ~20–70/day | ✅ (needs filtering) | always-on collector |
| F. Editorial / submissions | n/a | tens to hundreds | as curated | ✅ | human time |

## 4. Recommended plan: R = C + E + F for discovery, A for display, B deferred

1. **Discovery.** Ship with the **HN corpus** (built offline, ODC-By, credited). Include a **Bluesky collector** script that can run whenever the user has a machine on. Add a **submit-a-post** form for editorial seeding.
2. **Display.** Use **official embed only**: `embed.js` with the blockquote, loaded lazily on the item page and on click in the grid. Grid cards are **our own text cards** (Claude-written title, topic chips, the recommender's quote, source badge, and a Reel or Post badge taken from the URL). If an embed fails (deleted, private or embed-disabled), the browser hides the item locally. **No server-side calls to Meta.**
3. **Claude's role** (mirrors HackerTube). For each mention, Claude labels the **stance** (recommends / cites / jokes / criticises / self-promotes) and extracts a quote and topics. For each post, Claude writes a **title, summary and "why it's recommended" from the mentions only**, plus a content type and topics. Because Claude never sees Instagram's own caption or media, the summary must say what *recommenders* said it shows, and the UI labels it "Summary written by Claude from what recommenders said".
4. **Search.** Use local `bge-small-en-v1.5` embeddings over our own card text for meaning search, plus keyword search. No API cost.
5. **Short-form section.** Reels (`/reel/`, `/reels/` and `/tv/` URLs) get their own section, the counterpart of HackerTube's "Longs".
6. **Ranking.** Distinct recommenders × distinct months (HackerTube's durability idea), Claude's stance confidence, and recency. Personalisation stays stateless and account-free, as in HackerTube.
7. **Deferred: B.** Add an optional Graph API adapter only if the user later creates a Meta app and passes App Review. It would supply captions and thumbnails for allow-listed creators, kept under the Platform Terms and never redistributed.

**What we store** per post: the shortcode, the canonical URL, kind (post or reel, from the URL), our Claude labels and card, mention records (source, link, author handle, month, short quote), topics and embedding. We store **no** Instagram captions, images, counts or author data.

**Dataset licence.** The HN-derived part stays ODC-By (credit `open-index/hacker-news`). Bluesky-derived records should not be redistributed until their terms are reviewed. Instagram content is never in our data.

## 5. Costs

| Item | Estimate |
|---|---|
| HN archive scan (DuckDB over HTTPS) | Free; about 25 min on a laptop |
| Claude labelling, HN corpus: ~1,800 mentions + ~1,800 cards at ~1,500 input + ~250 output tokens each | Claude Opus 5.5 ($4 / $20 per M tokens): **≈ $40**; **≈ $20 with the Batch API (50% off)**. Claude Haiku 5.5 ($0.10 / $0.50): ≈ $1. Recommended: Haiku 5.5 for stance labels and Opus 5.5 for the cards, ≈ $20 total. |
| Bluesky ongoing: ~2,300 links/day | Haiku 5.5 stance filter ≈ $1/day; cards only for posts that pass ≈ $1–2/day on Opus 5.5 |
| Embeddings (bge-small, local) | Free |
| Meta API / oEmbed | Free (not used by default) |
| Hosting (local, as asked) | Free; a small VM or edge function later, about $5–10 a month |

The app will ship with a **pre-built sample dataset** so it runs locally with **no API keys**. `ANTHROPIC_API_KEY` is needed only to rebuild or extend the labels.

## 6. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **Small catalogue.** The ~1,000-item launch is thin next to HackerTube. | High (product) | Add Bluesky and submissions. Present it honestly as "early". |
| **Link rot.** Old HN links point at deleted or private posts. | Medium | Hide failed embeds on the client. Rank recent mentions higher. |
| **Weak quality signal.** Most posts have one recommender. | Medium | Claude stance filter, a quote shown on every card, and durability ranking when available. |
| **Meta changes embed rules** (it changed oEmbed twice in 2025–26). | Medium | The display layer is isolated. A card still links to instagram.com if embeds stop. |
| **Trademark** on the "Insta" name. | Medium | The user reviews the name before launch (project rule). Use no Instagram logo or colours. |
| **Claude summaries can be wrong.** | Low–Med | Label them as Claude-written, as HackerTube does. Write only from mention text, and show the source quotes. |
| **Bluesky or HN authors' text** reused out of context. | Low | Short quotes with links, and honour Bluesky deletions. |
| **Account bans.** | None by design | No Instagram account is used at all in Plan R. |

## 7. Alternatives you could pick instead

- **Plan R (recommended):** HN + Bluesky + submissions, shown through official embeds, with no Meta API. Starts today with no account risk. Small but honest catalogue.
- **Plan R+B:** Plan R now, plus the Meta Graph API adapter once you create a Meta app, link a business account and pass App Review. Gives a bigger catalogue with thumbnails, but it ranks by popularity and takes weeks of review.
- **Plan F-only, "personal curator":** only user-submitted links, shown through embeds. Simplest, but there is no discovery.

**Decision needed:** approve one plan (R, R+B or F-only) before any application code is written.
