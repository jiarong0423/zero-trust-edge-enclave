#!/usr/bin/env node
// Measures how well similarity ranking orders a synthetic directory, against the fixed order, using the
// embedding model that is actually running on this machine (default http://127.0.0.1:1234/v1, loopback
// only). It is a measurement, not part of the test suite: it needs the model up and its numbers depend on
// the model. The directory and the queries are invented; nothing real is read or sent anywhere.
//
//   node scripts/rank-eval.mjs
//
// Two baselines: the fixed order (alphabetical by department and name), which is a weak yardstick because
// it ignores the query, and the search box the page already has (the whole text must appear in the id,
// display name, Chinese name or email), which is the fair one.
//
// For each query a set of people counts as correct. "Hit at 1" is whether the first person listed is
// correct; "precision at k" (k = how many are correct) is the share of the first k that are correct.
import { createRecipientRanker, fixedOrder } from '../recipient-rank.js';

const surnames = ['劉', '陳', '林', '黃', '張', '李', '王', '吳', '蔡', '楊'];
const given = ['文祥', '慶龍', '小明', '大文', '志豪', '雅婷', '怡君', '建宏', '淑芬', '俊傑'];
const english = { 劉: 'Liu', 陳: 'Chen', 林: 'Lin', 黃: 'Huang', 張: 'Chang', 李: 'Lee', 王: 'Wang', 吳: 'Wu', 蔡: 'Tsai', 楊: 'Yang' };
const departments = ['sales', 'accounting', 'hr', 'ops'];
const labels = { sales: '業務部', accounting: '會計部', hr: '人事部', ops: '營運部' };
const regions = ['北區', '中區', '南區'];
const teams = ['一組', '二組', '三組'];

// Deterministic: person i takes surname, given name, department, region and team by fixed strides.
const people = Array.from({ length: 60 }, (_, i) => {
  const surname = surnames[i % 10]; const name = given[(i * 3 + Math.floor(i / 10)) % 10];
  return { id: `e${1000 + i}`, nameZh: surname + name, displayName: `${name.length ? 'Person' : ''} ${english[surname]}`.trim(),
    department: departments[(i * 7 + Math.floor(i / 4)) % 4], tags: { region: regions[(i * 5) % 3], team: teams[(i * 2 + Math.floor(i / 3)) % 3] } };
});
const where = predicate => people.filter(predicate).map(person => person.id);
const queries = [
  ['full name', '劉文祥', where(p => p.nameZh === '劉文祥')],
  ['department and surname', '業務部 劉', where(p => p.department === 'sales' && p.nameZh.startsWith('劉'))],
  ['department and surname (honorific)', '業務的劉先生', where(p => p.department === 'sales' && p.nameZh.startsWith('劉'))],
  ['surname only', '陳先生', where(p => p.nameZh.startsWith('陳'))],
  ['department and region', '會計部 北區', where(p => p.department === 'accounting' && p.tags.region === '北區')],
  ['department, region and team', '人事部 南區 二組', where(p => p.department === 'hr' && p.tags.region === '南區' && p.tags.team === '二組')],
  ['English surname', 'Liu sales', where(p => p.department === 'sales' && p.displayName.includes('Liu'))],
  ['English surname only', 'Wang', where(p => p.displayName.includes('Wang'))],
  ['given name', '志豪', where(p => p.nameZh.endsWith('志豪'))],
  ['department only', '營運部', where(p => p.department === 'ops')],
  ['region and team only', '中區 三組', where(p => p.tags.region === '中區' && p.tags.team === '三組')],
  ['full name and department', '李雅婷 營運', where(p => p.nameZh === '李雅婷' && p.department === 'ops')],
  ['misspelled name', '劉文翔', where(p => p.nameZh === '劉文祥')],
  ['name with space', '黃 建宏', where(p => p.nameZh === '黃建宏')]
].filter(([, , relevant]) => relevant.length > 0);

const ranker = createRecipientRanker({ env: { ...process.env, RECIPIENT_RANKING: 'vector' } });
const fixed = fixedOrder(people);
const rows = [];
let failure = null;
for (const [label, text, relevant] of queries) {
  const k = relevant.length; const set = new Set(relevant);
  const result = await ranker.rank(text, people, labels);
  if (result.method !== 'vector') { failure = result.fallback; break; }
  const precision = order => order.slice(0, k).filter(id => set.has(id)).length / k;
  const needle = text.trim().toLowerCase();
  const box = people.filter(p => [p.id, p.displayName, p.nameZh].some(v => v.toLowerCase().includes(needle))).map(p => p.id);
  rows.push({ label, text, k, hit1: set.has(result.order[0]), vector: precision(result.order), fixed: precision(fixed), fixedHit1: set.has(fixed[0]),
    box: precision(box), boxHit1: box.length > 0 && set.has(box[0]), boxFound: box.length });
}
if (failure) { console.error(`ERROR the embedding model did not answer (${failure}); start LM Studio's server and load an embedding model`); process.exit(1); }
console.log(`directory: ${people.length} invented people; queries: ${rows.length}\n`);
console.log('| query | text | correct | hit@1 | precision@k vector | precision@k search box | precision@k fixed order |');
console.log('| --- | --- | --- | --- | --- | --- | --- |');
for (const r of rows) console.log(`| ${r.label} | ${r.text} | ${r.k} | ${r.hit1 ? 'yes' : 'no'} | ${r.vector.toFixed(2)} | ${r.box.toFixed(2)} (${r.boxFound} found) | ${r.fixed.toFixed(2)} |`);
const mean = f => (rows.reduce((s, r) => s + f(r), 0) / rows.length).toFixed(2);
console.log(`\nmean hit@1: vector ${(rows.filter(r => r.hit1).length / rows.length).toFixed(2)}, search box ${(rows.filter(r => r.boxHit1).length / rows.length).toFixed(2)}, fixed order ${(rows.filter(r => r.fixedHit1).length / rows.length).toFixed(2)}`);
console.log(`mean precision@k: vector ${mean(r => r.vector)}, search box ${mean(r => r.box)}, fixed order ${mean(r => r.fixed)}`);
console.log(`queries where the search box found nobody: ${rows.filter(r => r.boxFound === 0).length} of ${rows.length}`);
console.log('These queries and people are invented; the numbers describe this model on this directory only.');
