import crypto from 'node:crypto';

// Similarity ranking of recipient candidates, for display order only. It never decides who is matched and
// never selects anyone: the matching rule, the authorization, the failure limit and the sender's own
// confirmation are all elsewhere and unchanged. When it cannot run it returns a fixed order instead of
// failing, so matching never depends on it.
//
// Embeddings come from a model on this machine, through the same loopback-only rule the local adviser
// uses. Nothing here sends a name, a tag or the sender's text to any other host. The index is a plain
// in-memory map of vectors with cosine similarity: the project has no dependencies, and a directory of a
// few hundred people does not need a database.

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);
export const RANK_TEXT_MAX = 100;
export const RANK_POOL_MAX = 500;
const CACHE_MAX = 5000;
const RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Deterministic: department, then Chinese name (or display name), then id.
export function fixedOrder(people) {
  const key = person => [person.department || '', person.nameZh || person.displayName || '', person.id];
  return [...people].sort((a, b) => {
    const x = key(a); const y = key(b);
    return compare(x[0], y[0]) || compare(x[1], y[1]) || compare(x[2], y[2]);
  }).map(person => person.id);
}

export function personText(person, departmentLabel) {
  return [person.nameZh, person.displayName, departmentLabel || person.department, ...Object.values(person.tags || {})]
    .filter(value => typeof value === 'string' && value).join(' ').slice(0, 300);
}

export function cosine(a, b) {
  let dot = 0; let x = 0; let y = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; }
  return x && y ? dot / Math.sqrt(x * y) : 0;
}

export async function embedTexts(texts, { baseUrl, model, request = fetch, timeoutMs = 5000 }) {
  const endpoint = new URL(baseUrl);
  if (!LOOPBACK_HOSTS.has(endpoint.hostname) || !['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash || endpoint.pathname.replace(/\/$/, '') !== '/v1' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(model)) {
    throw new Error('EMBEDDING_ENDPOINT_REFUSED');
  }
  if (!Array.isArray(texts) || !texts.length || texts.length > RANK_POOL_MAX + 1 || texts.some(text => typeof text !== 'string' || !text || text.length > 400)) {
    throw new Error('EMBEDDING_INPUT_REFUSED');
  }
  const response = await request(new URL('/v1/embeddings', endpoint), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, input: texts }) });
  if (!response.ok) throw new Error('EMBEDDING_HTTP_ERROR');
  const reader = response.body.getReader();
  const chunks = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > RESPONSE_MAX_BYTES) throw new Error('EMBEDDING_RESPONSE_TOO_LARGE');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const body = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
  const rows = Array.isArray(body?.data) ? [...body.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)) : null;
  if (!rows || rows.length !== texts.length) throw new Error('EMBEDDING_SHAPE_REJECTED');
  const width = rows[0]?.embedding?.length;
  if (!Number.isInteger(width) || width < 8 || width > 4096) throw new Error('EMBEDDING_SHAPE_REJECTED');
  for (const row of rows) {
    if (!Array.isArray(row.embedding) || row.embedding.length !== width || row.embedding.some(value => !Number.isFinite(value))) throw new Error('EMBEDDING_SHAPE_REJECTED');
  }
  return rows.map(row => row.embedding);
}

// Off unless RECIPIENT_RANKING is exactly `vector`. People are embedded once and kept by the hash of
// their text, so only a changed entry is embedded again.
export function createRecipientRanker({ env = process.env, request = fetch, baseUrl, model, timeoutMs } = {}) {
  const enabled = env.RECIPIENT_RANKING === 'vector';
  const modelName = model || env.EMBEDDING_MODEL_NAME || 'text-embedding-nomic-embed-text-v1.5';
  const url = baseUrl || env.LOCAL_MODEL_BASE_URL || 'http://127.0.0.1:1234/v1';
  // nomic-embed is trained with these task prefixes; other models get the plain text.
  const queryPrefix = /nomic/i.test(modelName) ? 'search_query: ' : '';
  const documentPrefix = /nomic/i.test(modelName) ? 'search_document: ' : '';
  const cache = new Map();
  const remember = (key, vector) => {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, vector);
  };
  const keyOf = text => `${modelName}|${crypto.createHash('sha256').update(text).digest('hex')}`;

  async function rank(text, people, departmentLabels = {}) {
    const fixed = (fallback) => ({ order: fixedOrder(people), method: 'fixed', fallback });
    if (!enabled) return fixed('RANKING_OFF');
    if (typeof text !== 'string' || !text.trim() || text.length > RANK_TEXT_MAX || people.length > RANK_POOL_MAX) return fixed('INPUT_REFUSED');
    if (!people.length) return { order: [], method: 'vector', fallback: null };
    try {
      const docs = people.map(person => documentPrefix + personText(person, departmentLabels[person.department]));
      const missing = [...new Set(docs.filter(doc => !cache.has(keyOf(doc))))];
      const vectors = await embedTexts([queryPrefix + text.trim(), ...missing], { baseUrl: url, model: modelName, request, timeoutMs });
      missing.forEach((doc, index) => remember(keyOf(doc), vectors[index + 1]));
      const query = vectors[0];
      const base = new Map(fixedOrder(people).map((id, index) => [id, index]));
      const scored = people.map((person, index) => ({ id: person.id, score: cosine(query, cache.get(keyOf(docs[index]))) }));
      scored.sort((a, b) => b.score - a.score || base.get(a.id) - base.get(b.id));
      return { order: scored.map(item => item.id), method: 'vector', fallback: null };
    } catch { return fixed('EMBEDDING_UNAVAILABLE'); }
  }
  return { enabled, rank, cacheSize: () => cache.size };
}
