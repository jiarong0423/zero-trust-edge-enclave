import crypto from 'node:crypto';

export function hashJson(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function base64UrlEncode(value) {
  return Buffer.from(value).toString('base64url');
}

export function base64UrlDecode(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

export function normalizeString(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  return value.trim().slice(0, 4000);
}

export function normalizeArray(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  return value.map(item => normalizeString(item)).filter(Boolean).slice(0, 20);
}
