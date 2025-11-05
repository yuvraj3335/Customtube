// HTTP helpers: typed errors, strict query-parameter parsing and JSON responses.

import { gzipSync } from 'node:zlib';

export class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

export const badRequest = (message) => new HttpError(400, message);

export const VID_RE = /^[A-Za-z0-9_-]{11}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;

/** Reject any query parameter the endpoint does not know, so typos fail loudly. */
export function assertKnownParams(params, allowed) {
  for (const key of params.keys()) {
    if (!allowed.includes(key)) throw badRequest(`unknown parameter "${key}"`);
  }
  for (const key of allowed) {
    if (params.getAll(key).length > 1) throw badRequest(`parameter "${key}" given more than once`);
  }
}

/** A parameter that is present must have a value: `?type=` would otherwise widen the results. */
export function assertNonEmpty(params, keys) {
  for (const key of keys) {
    if (params.has(key) && params.get(key) === '') throw badRequest(`"${key}" is empty`);
  }
}

export function parseVid(value, name = 'vid') {
  if (!value || !VID_RE.test(value)) throw badRequest(`"${name}" must be an 11-character YouTube video id`);
  return value;
}

/** A comma-separated list of video ids, deduplicated in order. Empty or missing means []. */
export function parseVidList(value, name, max) {
  if (value === null || value === undefined || value === '') return [];
  const parts = value.split(',');
  if (parts.length > max) throw badRequest(`"${name}" accepts at most ${max} ids`);
  const seen = new Set();
  for (const p of parts) {
    if (!VID_RE.test(p)) throw badRequest(`"${name}" contains an invalid video id`);
    seen.add(p);
  }
  return [...seen];
}

export function parseIntParam(value, name, { min, max, def }) {
  if (value === null || value === undefined || value === '') return def;
  if (!/^\d{1,9}$/.test(value)) throw badRequest(`"${name}" must be a whole number`);
  const n = Number(value);
  if (n < min || n > max) throw badRequest(`"${name}" must be between ${min} and ${max}`);
  return n;
}

export function parseSlug(value, name) {
  if (!value || !SLUG_RE.test(value)) throw badRequest(`"${name}" must be a topic id`);
  return value;
}

/** Feed seed: an opaque token the client picks once per page load. */
export function parseSeed(value) {
  if (value === null || value === undefined || value === '') return '0';
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(value)) throw badRequest('"seed" must be 1-32 letters, digits, - or _');
  return value;
}

export const SECURITY_HEADERS = {
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: https://i.ytimg.com",
    'frame-src https://www.youtube-nocookie.com',
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'cross-origin-opener-policy': 'same-origin',
};

function acceptsGzip(req) {
  return /\bgzip\b/.test(req.headers['accept-encoding'] || '');
}

export function send(req, res, status, body, headers = {}) {
  let payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : Buffer.from(body);
  const out = { ...SECURITY_HEADERS, ...headers };
  const type = String(out['content-type'] || '');
  const compressible = /^(application\/json|text\/|application\/javascript|image\/svg)/.test(type);
  if (compressible && acceptsGzip(req) && Buffer.byteLength(payload) > 1024) {
    payload = gzipSync(payload);
    out['content-encoding'] = 'gzip';
    out.vary = 'Accept-Encoding';
  }
  out['content-length'] = Buffer.byteLength(payload);
  res.writeHead(status, out);
  res.end(req.method === 'HEAD' ? undefined : payload);
}

export function sendJson(req, res, status, value, headers = {}) {
  send(req, res, status, JSON.stringify(value), {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
