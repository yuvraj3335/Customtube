// YouTube search without an API key, through YouTube's own web client API (InnerTube), by way of
// the youtubei.js package. Nothing is stored: each search is asked of YouTube, and the next page
// is YouTube's own continuation token, handed to the browser and sent back as is.

import { Innertube, YT, YTNodes } from 'youtubei.js';
import { HttpError, VID_RE } from './http.js';

const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
// YouTube's continuation tokens are URL-safe base64 (a few hundred characters).
export const PAGE_TOKEN_RE = /^[A-Za-z0-9_%=-]{16,4096}$/;
const SESSION_TTL = 6 * 60 * 60_000;
const UNIT_MS = { second: 1e3, minute: 60e3, hour: 3600e3, day: 86400e3, week: 7 * 86400e3, month: 30 * 86400e3, year: 365 * 86400e3 };

/** "3 weeks ago", "Streamed 2 years ago" → an ISO time that far before now (YouTube gives no exact date here). */
export function relativeToIso(text, now = Date.now()) {
  const m = /(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i.exec(String(text ?? ''));
  if (!m) return null;
  const d = new Date(now - Number(m[1]) * UNIT_MS[m[2].toLowerCase()]);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const digits = (s) => {
  const d = String(s ?? '').replace(/[^\d]/g, '');
  return d ? Number(d) : null;
};

/** One search result video as Custom Tube's live item, or null for live streams, premieres and oddities. */
export function videoFromNode(v, now = Date.now()) {
  const vid = v?.video_id ?? v?.id;
  if (!VID_RE.test(vid ?? '')) return null;
  if (v.is_live || v.is_upcoming) return null;
  const duration_s = Number.isFinite(v.duration?.seconds) && v.duration.seconds > 0 ? v.duration.seconds : null;
  if (!duration_s) return null;
  const channelId = v.author?.id;
  return {
    vid,
    title: String(v.title?.toString?.() ?? '').slice(0, 300) || 'Untitled video',
    channel: String(v.author?.name ?? '').slice(0, 200),
    channelId: CHANNEL_ID_RE.test(channelId ?? '') ? channelId : null,
    published: relativeToIso(v.published?.toString?.(), now),
    duration_s,
    views: digits(v.view_count?.toString?.()),
    short: duration_s <= 180,
  };
}

/**
 * @param {{ fetchImpl?: typeof fetch, create?: () => Promise<any>, now?: () => number, log?: Console }} opts
 */
export function createInnertube({
  fetchImpl = globalThis.fetch,
  create = () => Innertube.create({ retrieve_player: false, generate_session_locally: true, lang: 'en', location: 'US', fetch: (input, init) => fetchImpl(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(8000) }) }),
  now = () => Date.now(),
  log = console,
} = {}) {
  let session = null; // { client: Promise, at }
  const client = () => {
    if (!session || now() - session.at > SESSION_TTL) {
      const p = create();
      session = { client: p, at: now() };
      // a failed start is not kept, so the next search tries again
      p.catch(() => {
        if (session?.client === p) session = null;
      });
    }
    return session.client;
  };

  const tokenOf = (page) => page.memo?.getType(YTNodes.ContinuationItem)?.at(-1)?.endpoint?.payload?.token ?? null;

  return {
    /**
     * Videos on YouTube for a phrase, most relevant first. `within` ('week', 'month' or 'year')
     * keeps only videos uploaded that recently (YouTube's own "sort by upload date" mostly returns
     * old videos, so recency is a filter). `page` is the token a previous answer returned as `next`.
     */
    async search(q, { within = null, page = null } = {}) {
      if (page && !PAGE_TOKEN_RE.test(page)) throw new HttpError(400, '"page" is not a page token from this search');
      let result;
      try {
        const yt = await client();
        if (page) result = new YT.Search(yt.actions, await yt.actions.execute('/search', { continuation: page, parse: true }), true);
        else result = await yt.search(q, { type: 'video', ...(within ? { upload_date: within } : {}) });
      } catch (err) {
        log.error?.(`YouTube search failed: ${err.message}`);
        throw new HttpError(502, 'YouTube search failed, try again');
      }
      const t = now();
      const seen = new Set();
      const items = [];
      for (const v of result.videos ?? []) {
        const it = videoFromNode(v, t);
        if (it && !seen.has(it.vid)) {
          seen.add(it.vid);
          items.push(it);
        }
      }
      const next = tokenOf(result);
      return { items, next: next && next !== page && PAGE_TOKEN_RE.test(next) ? next : null };
    },
  };
}
