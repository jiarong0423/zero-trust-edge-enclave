#!/usr/bin/env node
// Audit hash-chain verifier. Read-only: it never writes, never touches the network and never
// prints event contents (only a record index and, when it is a plain upper-case code, the type).
//
// What the chain is (server.js appendAudit): every stored event is
//   { ...auditProjection(event), id, createdAt, previousHash }
// and eventHash = SHA-256 over JSON.stringify of that object in that key order. previousHash is the
// eventHash of the record before it, or null for the very first record ever written. When
// audit.json grows past its limit, audit-retention.js moves the oldest records into
// content-addressed pages under <DATA_DIR>/audit-archive/<sha256 of page bytes>.json; the first
// record left in audit.json then carries the previousHash of the last archived record. This script
// follows that link back through the archive pages when they exist.
//
// What it proves: no record that is still present was edited, no record between two present
// records was removed, inserted or reordered, unless the attacker also recomputed every later hash.
//
// What it does NOT prove (real limitations, not caveats):
//  1. Truncating the TAIL is NOT detectable. Removing the newest N records leaves a shorter,
//     perfectly valid chain; the verifier only reports a different head hash. Detection needs the
//     head hash (printed below) to have been recorded somewhere an attacker cannot also edit.
//  2. The hash is unkeyed SHA-256. Anyone who can write audit.json can edit a record and recompute
//     every following eventHash, and the result verifies. The chain detects accidental damage and
//     partial or careless edits; it is not tamper-proof against a writer who knows the format.
//  3. Wholly removing the archive pages is only caught when audit.json's first record points into
//     them. A deletion of the whole oldest prefix together with a rewrite of the first remaining
//     record is case 2.
//
// Usage:  node scripts/verify-audit-chain.mjs [--window-only] <DATA_DIR | path/to/audit.json>
//   stdout "OK <n> records, head <12 hex>"                        exit 0
//   stdout "ERROR chain broken at record <index>: <reason>"       exit 1
//   usage or I/O error on stderr                                  exit 2
// --window-only accepts a first record whose previousHash is not null without requiring the
// archive (use only when the archive was deliberately moved; the older history is then unverified).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const hex64 = /^[0-9a-f]{64}$/;
const pageName = /^[0-9a-f]{64}\.json$/;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

export class ChainError extends Error {
  constructor(index, reason, record) {
    super(reason);
    this.index = index;
    this.reason = reason;
    const type = record && typeof record === 'object' && typeof record.type === 'string' && /^[A-Z_]{1,40}$/.test(record.type) ? record.type : null;
    this.typeLabel = type;
  }
}

export class InputError extends Error {}

// Recompute the hash exactly as server.js does: the record minus eventHash, in stored key order.
function recompute(record) {
  const { eventHash, ...body } = record;
  return sha256(JSON.stringify(body));
}

// Verify one contiguous run. `base` is the global index of its first record, `entryPrevious` is
// what its first previousHash must equal (undefined = any value is accepted and returned to the
// caller to be resolved against the archive).
export function verifySegment(records, base = 0, label = '') {
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    const at = base + i;
    const suffix = label ? ` (${label})` : '';
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new ChainError(at, 'record is not an object' + suffix, record);
    if (typeof record.eventHash !== 'string' || !hex64.test(record.eventHash)) throw new ChainError(at, 'missing or malformed eventHash' + suffix, record);
    if (!(record.previousHash === null || (typeof record.previousHash === 'string' && hex64.test(record.previousHash)))) {
      throw new ChainError(at, 'missing or malformed previousHash' + suffix, record);
    }
    if (recompute(record) !== record.eventHash) throw new ChainError(at, 'record content does not match its eventHash' + suffix, record);
    if (i > 0 && record.previousHash !== records[i - 1].eventHash) {
      throw new ChainError(at, 'previousHash does not match the preceding record' + suffix, record);
    }
  }
}

// Walk archive pages backwards from the hash the live window starts at. Returns the verified
// pages, oldest first.
export function resolveArchive(windowFirstPrevious, pages) {
  const byHash = new Map();
  for (const page of pages) for (const record of page.records) {
    if (record && typeof record.eventHash === 'string') byHash.set(record.eventHash, page);
  }
  const chain = [];
  const seen = new Set();
  let need = windowFirstPrevious;
  while (need !== null) {
    const page = byHash.get(need);
    if (!page) throw new ChainError(0, `predecessor ${need.slice(0, 12)} not found in audit-archive`, null);
    if (seen.has(page.name)) throw new ChainError(0, 'archive pages form a loop', null);
    seen.add(page.name);
    chain.unshift(page);
    need = page.records[0] && Object.hasOwn(page.records[0], 'previousHash') ? page.records[0].previousHash : undefined;
    if (need === undefined || (need !== null && typeof need !== 'string')) throw new ChainError(0, `archive page ${page.name.slice(0, 12)} has a malformed first record`, null);
  }
  return chain;
}

export function verifyChain(records, options = {}) {
  if (!Array.isArray(records)) throw new InputError('audit file is not a JSON array');
  const first = records[0];
  const firstPrevious = first && typeof first === 'object' ? first.previousHash : undefined;
  const linked = typeof firstPrevious === 'string' && hex64.test(firstPrevious);
  // A live file with no records but archive pages beside it is a wiped audit.json, not an empty log:
  // a log that rotated into the archive always keeps at least the newest window.
  if (!records.length && (options.pages || []).length && !options.windowOnly) {
    throw new ChainError(0, 'audit.json is empty but audit-archive pages exist', null);
  }
  const archived = linked && !options.windowOnly ? resolveArchive(firstPrevious, options.pages || []) : [];
  let offset = 0;
  for (let p = 0; p < archived.length; p += 1) {
    const page = archived[p];
    verifySegment(page.records, offset, `archive page ${page.name.slice(0, 12)}`);
    if (p === 0 && page.records[0].previousHash !== null) throw new ChainError(offset, 'oldest archive page does not start at the genesis record', page.records[0]);
    if (p > 0 && page.records[0].previousHash !== archived[p - 1].records.at(-1).eventHash) {
      throw new ChainError(offset, `archive page ${page.name.slice(0, 12)} does not follow the previous page`, page.records[0]);
    }
    offset += page.records.length;
  }
  verifySegment(records, offset);
  if (records.length && archived.length) {
    // After an interrupted rotation the window may start inside the last page, so accept any
    // record of that page as the predecessor; resolveArchive already proved it exists there.
    if (!archived.at(-1).records.some(record => record.eventHash === records[0].previousHash)) {
      throw new ChainError(offset, 'previousHash does not match the archive', records[0]);
    }
  } else if (records.length && records[0].previousHash !== null && !options.windowOnly) {
    throw new ChainError(offset, 'first record does not start at genesis', records[0]);
  }
  return { count: offset + records.length, head: records.length ? records.at(-1).eventHash : null };
}

async function readJsonFile(file) {
  let bytes;
  try { bytes = await fs.readFile(file); }
  catch { throw new InputError('cannot read ' + path.basename(file)); }
  return bytes;
}

export async function loadArchivePages(root) {
  let names;
  try { names = await fs.readdir(root); }
  catch (error) { if (error.code === 'ENOENT') return []; throw new InputError('cannot read audit-archive'); }
  const pages = [];
  for (const name of names.filter(entry => pageName.test(entry)).sort()) {
    const bytes = await readJsonFile(path.join(root, name));
    if (sha256(bytes) + '.json' !== name) throw new ChainError(0, `archive page ${name.slice(0, 12)} digest does not match its name`, null);
    let records;
    try { records = JSON.parse(bytes); } catch { throw new InputError(`archive page ${name.slice(0, 12)} is not JSON`); }
    if (!Array.isArray(records) || !records.length) throw new InputError(`archive page ${name.slice(0, 12)} is not a non-empty array`);
    pages.push({ name, records });
  }
  return pages;
}

export async function verifyPath(target, options = {}) {
  let stat;
  try { stat = await fs.stat(target); } catch { throw new InputError('path not found'); }
  const file = stat.isDirectory() ? path.join(target, 'audit.json') : target;
  const bytes = await readJsonFile(file);
  let records;
  try { records = JSON.parse(bytes); } catch { throw new InputError('audit file is not valid JSON'); }
  if (!Array.isArray(records)) throw new InputError('audit file is not a JSON array');
  const pages = await loadArchivePages(path.join(path.dirname(file), 'audit-archive'));
  return verifyChain(records, { ...options, pages });
}

export async function main(argv, out = console.log, err = console.error) {
  const flags = argv.filter(arg => arg.startsWith('--'));
  const rest = argv.filter(arg => !arg.startsWith('--'));
  if (rest.length !== 1 || flags.some(flag => flag !== '--window-only')) {
    err('Usage: verify-audit-chain.mjs [--window-only] <DATA_DIR | path/to/audit.json>');
    return 2;
  }
  try {
    const result = await verifyPath(rest[0], { windowOnly: flags.includes('--window-only') });
    out(`OK ${result.count} records, head ${result.head ? result.head.slice(0, 12) : 'none'}`);
    return 0;
  } catch (error) {
    if (error instanceof ChainError) {
      out(`ERROR chain broken at record ${error.index}: ${error.reason}${error.typeLabel ? ` (type ${error.typeLabel})` : ''}`);
      return 1;
    }
    if (error instanceof InputError) { err('ERROR ' + error.message); return 2; }
    err('ERROR unexpected failure');
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
