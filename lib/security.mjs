import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const nowIso = () => new Date().toISOString();
export const randomId = (bytes = 16) => randomBytes(bytes).toString('hex');
export const randomToken = () => `kv_${randomBytes(24).toString('base64url')}`;
export const tokenHash = (token) => createHash('sha256').update(token).digest('hex');
export const sha256 = (input) => createHash('sha256').update(input).digest('hex');

export function safeEqualHex(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

export function cleanText(value, max = 500) {
  if (value == null) return null;
  const s = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.slice(0, max) || null;
}

export function asInt(value, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback = 0 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  return Math.max(min, Math.min(max, i));
}

function validIsbn10(value) {
  if (!/^\d{9}[\dX]$/.test(value)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const d = value[i] === 'X' ? 10 : Number(value[i]);
    sum += d * (10 - i);
  }
  return sum % 11 === 0;
}

function validIsbn13(value) {
  if (!/^97[89]\d{10}$/.test(value)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(value[i]) * (i % 2 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === Number(value[12]);
}

/** Extract a validated ISBN from EPUB/KOReader identifier metadata.
 * KOReader's doc_props.identifiers is commonly a newline-separated string such as
 * `isbn:978...`, `urn:isbn:...`, `calibre:...`, `uuid:...`.
 */
export function extractIsbn(value) {
  if (!value) return null;
  const raw = String(value).toUpperCase();
  const candidates = raw.match(/(?:97[89][\d\s-]{9,20}\d|\d[\d\s-]{7,16}[\dX])/g) || [];
  const cleaned = [...new Set(candidates.map(x => x.replace(/[^0-9X]/g, '')))];
  const isbn13 = cleaned.find(x => x.length === 13 && validIsbn13(x));
  if (isbn13) return isbn13;
  return cleaned.find(x => x.length === 10 && validIsbn10(x)) || null;
}

export function json(res, status, body, extraHeaders = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(payload);
}
