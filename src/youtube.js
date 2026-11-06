// Live videos from YouTube for the curated feed.
//
// - Channel uploads come from YouTube's public RSS feed for a channel
//   (https://www.youtube.com/feeds/videos.xml?channel_id=UC…): no key, no quota, ~15 latest.
// - Searches (the search box and followed topics) go to YouTube's own web client API without a key
//   (src/innertube.js), so all of YouTube is searchable with no quota. With a YouTube Data API key
//   (YOUTUBE_API_KEY), followed topics use the official API instead: its free quota is 10,000
//   units a day, a search costs 100, and a daily budget stops before the quota runs out.
// - Channel lookups use the Data API with a key, else the public channel page.
//
// Nothing is written to disk. Video ids, titles, channels, dates, durations and view counts are
// kept in memory for at most a few hours, so repeated asks don't go to YouTube again.

import { LRUCache } from "lru-cache";
import { HttpError, VID_RE } from "./http.js";
import { parseIsoDuration } from "./data.js";
import { createRateLimiter } from "./ratelimit.js";
import { createInnertube } from "./innertube.js";

const API = "https://www.googleapis.com/youtube/v3";
const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
const HANDLE_RE = /^@[A-Za-z0-9._-]{3,30}$/;
const COST = { search: 100, videos: 1, channels: 1 };

const decodeXml = (s) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
const tag = (xml, name) => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(
    xml,
  );
  return m ? decodeXml(m[1].trim()) : null;
};

/** The channel id a YouTube channel page is about (its canonical link, else its metadata). */
export function channelIdFromPage(html) {
  const m =
    /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})"/.exec(
      html,
    ) ||
    /<meta itemprop="identifier" content="(UC[A-Za-z0-9_-]{22})"/.exec(html) ||
    /"externalId":"(UC[A-Za-z0-9_-]{22})"/.exec(html);
  return m ? m[1] : null;
}

/**
 * What a viewer typed to name a channel: a channel id, a @handle, or a link to a channel, a
 * handle, a video or a Short. Returns null for anything else.
 */
export function parseChannelInput(raw) {
  const s = String(raw ?? "").trim();
  if (CHANNEL_ID_RE.test(s)) return { channelId: s };
  if (HANDLE_RE.test(s)) return { handle: s };
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, "");
  if (host === "youtu.be") {
    const vid = url.pathname.slice(1);
    return VID_RE.test(vid) ? { vid } : null;
  }
  if (host !== "youtube.com") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "channel" && CHANNEL_ID_RE.test(parts[1] ?? ""))
    return { channelId: parts[1] };
  if (parts[0]?.startsWith("@")) {
    const handle = decodeURIComponent(parts[0]);
    return HANDLE_RE.test(handle) ? { handle } : null;
  }
  if (parts[0] === "watch" && VID_RE.test(url.searchParams.get("v") ?? ""))
    return { vid: url.searchParams.get("v") };
  if (
    ["shorts", "live", "embed"].includes(parts[0]) &&
    VID_RE.test(parts[1] ?? "")
  )
    return { vid: parts[1] };
  return null;
}

/** Parse a channel's Atom feed into video entries (newest first, as YouTube sends them). */
export function parseChannelFeed(xml) {
  const channel = tag(xml.split("<entry>")[0], "title") ?? "";
  const entries = [];
  for (const chunk of xml.split("<entry>").slice(1)) {
    const vid = tag(chunk, "yt:videoId");
    if (!vid || !VID_RE.test(vid)) continue;
    const views = /<media:statistics views="(\d+)"/.exec(chunk)?.[1];
    entries.push({
      vid,
      title: (tag(chunk, "title") ?? "").slice(0, 300),
      channel: (tag(chunk, "name") ?? channel).slice(0, 200),
      published: tag(chunk, "published"),
      views: views ? Number(views) : null,
      // YouTube's feed links Shorts as /shorts/<id>
      short: /href="https:\/\/www\.youtube\.com\/shorts\//.test(chunk),
    });
  }
  return { channel, entries };
}

/**
 * @param {{ apiKey?: string|null, fetchImpl?: typeof fetch, innertube?: ReturnType<typeof createInnertube>|null, dailyBudget?: number, log?: Console, now?: () => number }} opts
 */
export function createYoutube({
  apiKey = null,
  innertube = null,
  fetchImpl = globalThis.fetch,
  dailyBudget = 8000,
  log = console,
  now = () => Date.now(),
} = {}) {
  const feeds = new LRUCache({ max: 2000, ttl: 15 * 60_000 }); // channel RSS, 15 min
  const searches = new LRUCache({ max: 1000, ttl: 6 * 60 * 60_000 }); // topic searches, 6 h
  // Search-box pages, 30 min. Keyless topic searches are cheap, so they stay fresh for 1 h.
  const pages = new LRUCache({ max: 2000, ttl: 30 * 60_000 });
  const keylessTtl = 60 * 60_000;
  const web = innertube ?? createInnertube({ fetchImpl, log, now });
  const channels = new LRUCache({ max: 5000, ttl: 24 * 60 * 60_000 }); // handle/video -> channel, 1 day
  // Channels YouTube has no feed for, so made-up ids don't cost a request each time.
  const missing = new LRUCache({ max: 20_000, ttl: 15 * 60_000 });
  // Requests already on their way, so parallel asks for the same thing share one.
  const inflight = new Map();
  let day = null;
  let spent = 0;
  // Requests to YouTube from the whole server: protects YouTube and our IP's reputation.
  const upstream = createRateLimiter({
    capacity: 60,
    refillPerSecond: 10,
    now,
  });
  // New searches for the whole server, spread over the day so no one can spend it all at once:
  // the budget's worth of searches a day, with a burst of 8.
  const newSearches = createRateLimiter({
    capacity: 8,
    refillPerSecond: dailyBudget / (COST.search + COST.videos) / 86_400,
    now,
  });

  // YouTube's quota day starts at midnight Pacific time.
  const quotaDay = () =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
    }).format(new Date(now()));
  function charge(units, { check = false } = {}) {
    const today = quotaDay();
    if (today !== day) {
      day = today;
      spent = 0;
    }
    if (spent + units > dailyBudget)
      throw new HttpError(
        503,
        "today's YouTube quota for this server is used up; try again tomorrow",
      );
    if (!check) spent += units;
  }
  const shared = (key, run) => {
    if (inflight.has(key)) return inflight.get(key);
    const p = run().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };

  function takeUpstream() {
    const take = upstream.take("all");
    if (!take.ok)
      throw new HttpError(
        503,
        "too many YouTube requests right now, try again shortly",
        { "retry-after": String(take.retryAfter) },
      );
  }

  async function get(url, what, { maxBytes = 2_000_000 } = {}) {
    takeUpstream();
    const accept =
      what === "feed"
        ? "application/atom+xml"
        : what === "page"
          ? "text/html"
          : "application/json";
    // The consent cookie skips the cookie-consent page YouTube shows to some regions.
    const headers = {
      accept,
      "accept-language": "en",
      ...(what === "page" ? { cookie: "CONSENT=YES+1; SOCS=CAI" } : {}),
    };
    let res;
    try {
      res = await fetchImpl(url, {
        signal: AbortSignal.timeout(8000),
        headers,
      });
    } catch (err) {
      log.error?.(`YouTube ${what} request failed: ${err.message}`);
      throw new HttpError(502, "could not reach YouTube, try again");
    }
    if (res.status === 404)
      throw new HttpError(404, "YouTube has no such channel or video");
    if (!res.ok) {
      // never log the URL: for API calls it carries the key
      log.error?.(`YouTube ${what} request returned ${res.status}`);
      throw new HttpError(502, "YouTube request failed, try again");
    }
    const text = await res.text();
    if (text.length > maxBytes)
      throw new HttpError(502, "YouTube returned an unexpectedly large answer");
    return text;
  }

  async function api(path, params, cost) {
    if (!apiKey)
      throw new HttpError(
        501,
        "live topics need a YouTube Data API key on the server (YOUTUBE_API_KEY, see README)",
      );
    charge(cost);
    const url = new URL(`${API}/${path}`);
    for (const [k, v] of Object.entries(params))
      url.searchParams.set(k, String(v));
    url.searchParams.set("key", apiKey);
    try {
      return JSON.parse(await get(url, path));
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, "YouTube returned an unexpected answer");
    }
  }

  /** Durations and view counts for up to 50 videos (1 unit). */
  async function details(vids) {
    if (!vids.length) return new Map();
    const body = await api(
      "videos",
      {
        part: "contentDetails,statistics,status",
        id: vids.join(","),
        maxResults: 50,
      },
      COST.videos,
    );
    const out = new Map();
    for (const it of body.items ?? []) {
      out.set(it.id, {
        duration_s: parseIsoDuration(it.contentDetails?.duration) || null,
        views: /^\d+$/.test(it.statistics?.viewCount ?? "")
          ? Number(it.statistics.viewCount)
          : null,
        embeddable: it.status?.embeddable !== false,
      });
    }
    return out;
  }

  return {
    canSearch: true,
    keylessTopics: !apiKey,
    hasTopic: (q, order = "date") =>
      searches.has(`${order}\u0000${q.toLowerCase()}`),
    hasChannel: (id) => feeds.has(id) || missing.has(id),
    quota: () => ({ day, spent, budget: dailyBudget }),

    /** Latest uploads of a channel from its public feed (no key needed). */
    async channelUploads(channelId) {
      if (!CHANNEL_ID_RE.test(channelId))
        throw new HttpError(
          400,
          "a channel id looks like UC followed by 22 letters, digits, - or _",
        );
      const hit = feeds.get(channelId);
      if (hit) return hit;
      if (missing.has(channelId))
        throw new HttpError(404, "YouTube has no such channel or video");
      return shared(`feed:${channelId}`, async () => {
        let xml;
        try {
          xml = await get(
            `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`,
            "feed",
          );
        } catch (err) {
          if (err.status === 404) missing.set(channelId, true);
          throw err;
        }
        const parsed = parseChannelFeed(xml);
        const out = {
          channelId,
          channel: parsed.channel,
          items: parsed.entries,
        };
        feeds.set(channelId, out);
        return out;
      });
    },

    /**
     * Fresh videos for a search phrase. With a key: the Data API (101 units: search + details),
     * embeddable videos only. Without one: keyless search, which can't tell whether a video allows
     * embedding (YouTube's own player then shows "Watch on YouTube").
     */
    async searchTopic(q, { order = "date" } = {}) {
      const key = `${order}\u0000${q.toLowerCase()}`;
      const hit = searches.get(key);
      if (hit) return hit;
      if (inflight.has(key)) return inflight.get(key);
      if (!apiKey) {
        takeUpstream();
        return shared(key, async () => {
          // Fresh videos first: this month's, or this year's for a quiet topic.
          let { items } = await web.search(q, {
            within: order === "date" ? "month" : null,
          });
          if (order === "date" && items.length < 6) {
            takeUpstream();
            ({ items } = await web.search(q, { within: "year" }));
          }
          const out = { q, items };
          searches.set(key, out, { ttl: keylessTtl });
          return out;
        });
      }
      // Check the whole cost first, so a search is never paid for and then left without details.
      charge(COST.search + COST.videos, { check: true });
      const slot = newSearches.take("all");
      if (!slot.ok)
        throw new HttpError(
          503,
          "too many new YouTube searches on this server right now, try again later",
          { "retry-after": String(slot.retryAfter) },
        );
      return shared(key, async () => {
        const body = await api(
          "search",
          {
            part: "snippet",
            q,
            type: "video",
            order,
            maxResults: 25,
            safeSearch: "moderate",
            videoEmbeddable: "true",
            relevanceLanguage: "en",
          },
          COST.search,
        );
        const rows = (body.items ?? [])
          .filter((it) => VID_RE.test(it.id?.videoId ?? ""))
          .map((it) => ({
            vid: it.id.videoId,
            title: decodeXml(String(it.snippet?.title ?? "")).slice(0, 300),
            channel: decodeXml(String(it.snippet?.channelTitle ?? "")).slice(
              0,
              200,
            ),
            channelId: CHANNEL_ID_RE.test(it.snippet?.channelId ?? "")
              ? it.snippet.channelId
              : null,
            published:
              typeof it.snippet?.publishedAt === "string"
                ? it.snippet.publishedAt
                : null,
            // live streams and premieres aren't playable uploads yet
            upcoming: ["live", "upcoming"].includes(
              it.snippet?.liveBroadcastContent,
            ),
          }))
          .filter((r) => !r.upcoming)
          .map(({ upcoming, ...r }) => r); // eslint-disable-line no-unused-vars
        const info = await details(rows.map((r) => r.vid));
        const items = rows
          .map((r) => {
            const d = info.get(r.vid);
            return {
              ...r,
              duration_s: d?.duration_s ?? null,
              views: d?.views ?? null,
              short: d?.duration_s ? d.duration_s <= 180 : false,
              embeddable: d?.embeddable !== false,
            };
          })
          .filter((r) => r.embeddable && r.duration_s)
          .map(({ embeddable, ...r }) => r); // eslint-disable-line no-unused-vars
        const out = { q, items };
        searches.set(key, out);
        return out;
      });
    },

    /**
     * Any videos on YouTube for what a viewer typed in the search box, one page at a time. `page`
     * is the `next` token of the page before (YouTube's own, passed through). No key, no quota.
     */
    async searchVideos(q, { page = null } = {}) {
      // a later page is YouTube's token alone (it carries the query); the first page is the query
      const key = page ? `p\u0000${page}` : `q\u0000${q.toLowerCase()}`;
      const hit = pages.get(key);
      if (hit) return hit;
      if (!inflight.has(`page:${key}`)) takeUpstream();
      return shared(`page:${key}`, async () => {
        const out = await web.search(q, { page });
        pages.set(key, out);
        return out;
      });
    },

    hasPage: (q, page = null) =>
      pages.has(page ? `p\u0000${page}` : `q\u0000${q.toLowerCase()}`),

    /**
     * The channel behind a channel id, a @handle or a video id. With a key this uses the Data API
     * (1 unit); without one it reads the public channel page (or oEmbed, for a video). The answer
     * is confirmed by reading the channel's feed, so it is a channel that has a feed.
     */
    async resolveChannel({ channelId, handle, vid }) {
      if (channelId && !CHANNEL_ID_RE.test(channelId))
        throw new HttpError(
          400,
          "a channel id looks like UC followed by 22 letters, digits, - or _",
        );
      if (handle && !HANDLE_RE.test(handle))
        throw new HttpError(400, "a handle looks like @name");
      if (vid && !VID_RE.test(vid))
        throw new HttpError(400, "a video id has 11 characters");
      const key = channelId
        ? `c:${channelId}`
        : handle
          ? `h:${handle.toLowerCase()}`
          : `v:${vid}`;
      const hit = channels.get(key);
      if (hit) return hit;
      let id = channelId;
      if (!id && apiKey) {
        const body = handle
          ? await api(
              "channels",
              { part: "id", forHandle: handle },
              COST.channels,
            )
          : await api("videos", { part: "snippet", id: vid }, COST.videos);
        const it = body.items?.[0];
        if (!it)
          throw new HttpError(
            404,
            handle
              ? "YouTube has no channel with that handle"
              : "YouTube has no such video",
          );
        id = handle ? it.id : it.snippet?.channelId;
      } else if (!id) {
        let page = handle ? `https://www.youtube.com/${handle}` : null;
        if (vid) {
          const info = JSON.parse(
            await get(
              `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${vid}`)}`,
              "oembed",
            ),
          );
          if (
            typeof info.author_url !== "string" ||
            !/^https:\/\/www\.youtube\.com\/[@A-Za-z0-9/._-]+$/.test(
              info.author_url,
            )
          )
            throw new HttpError(502, "YouTube did not say whose video that is");
          page = info.author_url;
        }
        const html = await get(page, "page", { maxBytes: 8_000_000 });
        id = channelIdFromPage(html);
        if (!id)
          throw new HttpError(
            502,
            "could not find the channel on its YouTube page",
          );
      }
      if (!CHANNEL_ID_RE.test(id ?? ""))
        throw new HttpError(502, "YouTube returned an unexpected channel id");
      const feed = await this.channelUploads(id);
      const out = { channelId: id, channel: feed.channel || handle || id };
      channels.set(key, out);
      return out;
    },
  };
}
