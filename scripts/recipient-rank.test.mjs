import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecipientRanker, embedTexts, fixedOrder, cosine, personText, RANK_TEXT_MAX, RANK_POOL_MAX } from '../recipient-rank.js';

// A stand-in embedder: characters and character pairs are counted into 128 buckets, so texts that share
// characters are close. It is only here to test the plumbing; how good a real model is, is measured by
// scripts/rank-eval.mjs.
const vectorOf = text => {
  const v = new Array(128).fill(0);
  const chars = [...text.replace(/^search_(query|document): /, '')];
  chars.forEach((c, i) => { v[c.codePointAt(0) % 128] += 1; if (i) v[(c.codePointAt(0) * 31 + chars[i - 1].codePointAt(0)) % 128] += 0.5; });
  return v;
};
function stand({ fail } = {}) {
  const calls = [];
  const request = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), input: body.input });
    if (fail) throw new Error('down');
    const data = body.input.map((text, index) => ({ index, embedding: vectorOf(text) }));
    return new Response(JSON.stringify({ data: fail === 'short' ? data.slice(1) : data }), { status: 200 });
  };
  return { request, calls };
}
const people = [
  { id: 'e1001', nameZh: '劉文祥', displayName: 'Wen Liu', department: 'sales', tags: { region: '北區' } },
  { id: 'e2044', nameZh: '劉文祥', displayName: 'Wen Liu', department: 'sales', tags: { region: '南區' } },
  { id: 'e3190', nameZh: '劉慶龍', displayName: 'Q Liu', department: 'sales', tags: { region: '北區' } },
  { id: 'a0007', nameZh: '王小明', displayName: 'Ming Wang', department: 'accounting' },
  { id: 'h0001', nameZh: '陳大文', displayName: 'Da Chen', department: 'hr' }
];
const labels = { sales: '業務部', accounting: '會計部', hr: '人事部' };
const on = { RECIPIENT_RANKING: 'vector' };
const make = (s, extra = {}) => createRecipientRanker({ env: on, request: s.request, baseUrl: 'http://127.0.0.1:1234/v1', model: 'stand-in', ...extra });

test('the fixed order is deterministic: department, name, id', () => {
  const order = fixedOrder(people);
  assert.deepEqual(order, ['a0007', 'h0001', 'e3190', 'e1001', 'e2044']);
  assert.deepEqual(fixedOrder([...people].reverse()), order);
});

test('similar people rank first, and the same inputs always give the same order', async () => {
  const s = stand();
  const ranker = make(s);
  const first = await ranker.rank('業務部 北區 劉慶龍', people, labels);
  assert.deepEqual([first.method, first.fallback], ['vector', null]);
  assert.equal(first.order[0], 'e3190');
  assert.equal(first.order.length, 5);
  assert.equal(new Set(first.order).size, 5);
  const again = await ranker.rank('業務部 北區 劉慶龍', [...people].reverse(), labels);
  assert.deepEqual(again.order, first.order);
});

test('two people with identical text keep the fixed order between them', async () => {
  const twins = [{ id: 'b', nameZh: '甲', displayName: 'A', department: 'x' }, { id: 'a', nameZh: '甲', displayName: 'A', department: 'x' }];
  const result = await make(stand()).rank('甲', twins, {});
  assert.deepEqual(result.order, ['a', 'b']);
});

test('people are embedded once: a second search sends only the query, and a changed entry only itself', async () => {
  const s = stand();
  const ranker = make(s);
  await ranker.rank('業務部', people, labels);
  assert.equal(s.calls[0].input.length, 1 + 5);
  await ranker.rank('北區', people, labels);
  assert.equal(s.calls[1].input.length, 1);
  const changed = people.map(person => (person.id === 'e1001' ? { ...person, tags: { region: '東區' } } : person));
  await ranker.rank('北區', changed, labels);
  assert.equal(s.calls[2].input.length, 2);
  assert.equal(ranker.cacheSize(), 6);
});

test('nomic task prefixes are used for that model and not for others', async () => {
  const s = stand();
  await createRecipientRanker({ env: on, request: s.request, baseUrl: 'http://127.0.0.1:1234/v1', model: 'text-embedding-nomic-embed-text-v1.5' }).rank('劉', people, labels);
  assert.ok(s.calls[0].input[0].startsWith('search_query: '));
  assert.ok(s.calls[0].input.slice(1).every(text => text.startsWith('search_document: ')));
  const other = stand();
  await make(other).rank('劉', people, labels);
  assert.equal(other.calls[0].input[0], '劉');
});

test('ranking is off unless RECIPIENT_RANKING is exactly vector, and then no request is made', async () => {
  for (const value of [undefined, '', 'on', 'true', 'Vector', 'vector ']) {
    const s = stand();
    const result = await createRecipientRanker({ env: { RECIPIENT_RANKING: value }, request: s.request }).rank('劉', people, labels);
    assert.deepEqual([result.method, result.fallback, s.calls.length], ['fixed', 'RANKING_OFF', 0], String(value));
    assert.deepEqual(result.order, fixedOrder(people));
  }
});

test('when the embedding model cannot answer, the fixed order is returned and nothing throws', async () => {
  for (const mode of [true, 'short']) {
    const result = await make(stand({ fail: mode })).rank('劉', people, labels);
    assert.deepEqual([result.method, result.fallback], ['fixed', 'EMBEDDING_UNAVAILABLE'], String(mode));
    assert.deepEqual(result.order, fixedOrder(people));
  }
});

test('only a loopback endpoint is ever contacted', async () => {
  for (const baseUrl of ['https://api.example.com/v1', 'http://10.0.0.5:1234/v1', 'http://127.0.0.1:1234/other', 'http://user:pw@127.0.0.1:1234/v1', 'http://127.0.0.1:1234/v1?x=1']) {
    const s = stand();
    const result = await make(s, { baseUrl }).rank('劉', people, labels);
    assert.deepEqual([result.fallback, s.calls.length], ['EMBEDDING_UNAVAILABLE', 0], baseUrl);
  }
  const s = stand();
  await assert.rejects(embedTexts(['x'], { baseUrl: 'http://127.0.0.1:1234/v1', model: 'bad model!', request: s.request }), e => e.message === 'EMBEDDING_ENDPOINT_REFUSED');
  assert.equal(s.calls.length, 0);
});

test('malformed embedding responses are rejected', async () => {
  const base = { baseUrl: 'http://127.0.0.1:1234/v1', model: 'm' };
  const reply = body => async () => new Response(JSON.stringify(body), { status: 200 });
  const row = (n, width = 16) => ({ index: n, embedding: new Array(width).fill(0.5) });
  await assert.rejects(embedTexts(['a', 'b'], { ...base, request: reply({ data: [row(0)] }) }), e => e.message === 'EMBEDDING_SHAPE_REJECTED');
  await assert.rejects(embedTexts(['a'], { ...base, request: reply({ data: [row(0, 4)] }) }), e => e.message === 'EMBEDDING_SHAPE_REJECTED');
  await assert.rejects(embedTexts(['a'], { ...base, request: reply({ data: [{ index: 0, embedding: [...new Array(15).fill(1), null] }] }) }), e => e.message === 'EMBEDDING_SHAPE_REJECTED');
  await assert.rejects(embedTexts(['a', 'b'], { ...base, request: reply({ data: [row(0, 16), row(1, 17)] }) }), e => e.message === 'EMBEDDING_SHAPE_REJECTED');
  await assert.rejects(embedTexts(['a'], { ...base, request: async () => new Response('no', { status: 500 }) }), e => e.message === 'EMBEDDING_HTTP_ERROR');
  await assert.rejects(embedTexts([], { ...base, request: reply({}) }), e => e.message === 'EMBEDDING_INPUT_REFUSED');
  await assert.rejects(embedTexts(['x'.repeat(401)], { ...base, request: reply({}) }), e => e.message === 'EMBEDDING_INPUT_REFUSED');
});

test('input limits fall back to the fixed order without calling the model', async () => {
  const s = stand();
  const ranker = make(s);
  for (const text of ['', '   ', 'x'.repeat(RANK_TEXT_MAX + 1), 42, null]) {
    assert.equal((await ranker.rank(text, people, labels)).fallback, 'INPUT_REFUSED');
  }
  const crowd = Array.from({ length: RANK_POOL_MAX + 1 }, (_, i) => ({ id: `p${i}`, nameZh: '甲', department: 'x' }));
  assert.equal((await ranker.rank('甲', crowd, {})).fallback, 'INPUT_REFUSED');
  assert.equal(s.calls.length, 0);
  assert.deepEqual(await ranker.rank('甲', [], {}), { order: [], method: 'vector', fallback: null });
});

test('the text describing a person has no id, no email and nothing outside the listed fields', () => {
  const text = personText({ id: 'e1001', email: 'a@example.com', nameZh: '劉文祥', displayName: 'Wen Liu', department: 'sales', tags: { region: '北區' } }, '業務部');
  assert.equal(text, '劉文祥 Wen Liu 業務部 北區');
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([0, 0], [1, 0]), 0);
});
