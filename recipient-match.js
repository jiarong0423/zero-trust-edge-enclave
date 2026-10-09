// Recipient matching for the sender side: fixed code only. No model sees a name, a department, a tag
// or an employee number, and nothing here is advice; it either names one person, lists the people it
// cannot tell apart, or refuses.
//
// Rule (owner, 2026-10-09): the Chinese name is the first key. If exactly one person in the pool has
// it, that person is matched. If more than one does, the employee number (the directory id, which the
// registry loader already forces to be unique) decides, and it must match exactly. Nothing is ever
// picked "first": an unresolved name is an answer, not a guess.

export const TAG_KEYS = ['region', 'team', 'role'];
const TAG_VALUE = /^[\p{L}\p{N}_-]{1,32}$/u;
const ID_SHAPE = /^[a-zA-Z0-9_-]{1,64}$/;
const NAME_MAX = 64;

// Full-width and half-width forms compare equal, and no kind of white space counts. Traditional and
// Simplified spellings are deliberately NOT unified: a variant spelling simply does not match by name
// and falls to the employee number, which can fail closed but cannot select the wrong person.
export function normalizeZhName(value) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFKC').replace(/[\s​-‍﻿]/gu, '');
}

export function validNameZh(value) {
  return typeof value === 'string' && value.length <= NAME_MAX && !/[\u0000-\u001f\u007f]/.test(value) &&
    normalizeZhName(value) !== '';
}

// A short job title, shown beside the name. Free text, not a key for matching.
export function validTitle(value) {
  return typeof value === 'string' && value.length <= 64 && !/[\u0000-\u001f\u007f]/.test(value) && value.trim() !== '';
}

// Other names the person goes by: a nickname, an English name, a former name. Up to eight.
export function validAliases(value) {
  if (value === undefined) return true;
  return Array.isArray(value) && value.length <= 8 && value.every(validNameZh) &&
    new Set(value.map(normalizeZhName)).size === value.length;
}

export function validTags(value) {
  if (value === undefined) return true;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, tag]) => TAG_KEYS.includes(key) && typeof tag === 'string' && TAG_VALUE.test(tag));
}

// status MATCHED     one person; `id` is set. `via` says which key decided it.
// status AMBIGUOUS   several people share the name and no employee number was given; `candidates` lists ids.
// status NONE        nobody fits.
// status CONFLICT    the employee number and the name point at different people.
// status INVALID     the question itself is malformed.
// `nameVerified` is false only when the match rests on the employee number alone while a name was given
// that nobody carries (for example a surname with an honorific); the caller must show the name on record.
export function resolveRecipient(config, query = {}) {
  const refuse = (status, code) => ({ status, code, via: null, id: null, candidates: [], nameVerified: false, narrow: 'NARROW_NOT_USED' });
  const asked = query && typeof query === 'object' ? query : {};
  const hasName = asked.nameZh !== undefined && asked.nameZh !== null && asked.nameZh !== '';
  const hasId = asked.employeeId !== undefined && asked.employeeId !== null && asked.employeeId !== '';
  if (hasName && !validNameZh(asked.nameZh)) return refuse('INVALID', 'INVALID_INPUT');
  if (hasId && !(typeof asked.employeeId === 'string' && ID_SHAPE.test(asked.employeeId))) return refuse('INVALID', 'INVALID_INPUT');
  if (!hasName && !hasId) return refuse('INVALID', 'INVALID_INPUT');
  if (asked.department !== undefined && typeof asked.department !== 'string') return refuse('INVALID', 'INVALID_INPUT');
  if (asked.tags !== undefined && !validTags(asked.tags)) return refuse('INVALID', 'INVALID_INPUT');

  const enabled = person => !person.disabled && (config.departments === undefined ||
    config.departments.some(entry => entry.id === (person.department || 'unassigned') && !entry.disabled));
  // The whole directory, not only one grant's list: uniqueness must not depend on who happens to be
  // authorised for this task. Whether the person is authorised is the caller's separate check.
  const pool = (config.principals || []).filter(person => person.kind === 'recipient' && enabled(person) &&
    (!asked.department || (person.department || 'unassigned') === asked.department) &&
    Object.entries(asked.tags || {}).every(([key, tag]) => person.tags?.[key] === tag));

  const wanted = hasName ? normalizeZhName(asked.nameZh) : '';
  const nameOf = person => normalizeZhName(person.nameZh) === wanted;
  const aliasOf = person => (person.aliases || []).some(alias => normalizeZhName(alias) === wanted);
  const named = hasName ? pool.filter(nameOf) : [];
  // The formal name always comes first; an alias is tried only when nobody carries the name itself, and
  // a match through an alias is never marked as a verified name.
  const aliased = hasName && !named.length ? pool.filter(aliasOf) : [];
  const set = named.length ? named : aliased;
  const viaAlias = !named.length && aliased.length > 0;
  const byId = hasId ? pool.find(person => person.id === asked.employeeId) : undefined;
  // Did the department or tags decide it? Only when the name alone would have named several people.
  const narrowed = Boolean(asked.department) || Object.keys(asked.tags || {}).length > 0;
  const wholeCount = hasName && narrowed
    ? (config.principals || []).filter(person => person.kind === 'recipient' && enabled(person) && nameOf(person)).length : 0;
  const narrow = !narrowed ? 'NARROW_NOT_USED' : set.length === 1 && wholeCount > 1 ? 'NARROW_DECISIVE' : 'NARROW_NOT_DECISIVE';
  const matched = (code, via, id, nameVerified) => ({ status: 'MATCHED', code, via, id, candidates: [], nameVerified, narrow });

  if (hasName && set.length === 1) {
    if (hasId && byId?.id !== set[0].id) return refuse('CONFLICT', 'CONFLICT_ID_NAME');
    return viaAlias ? matched('MATCH_BY_ALIAS', 'ALIAS', set[0].id, false) : matched('MATCH_BY_NAME', 'NAME', set[0].id, true);
  }
  if (hasName && set.length > 1) {
    if (!hasId) return { ...refuse('AMBIGUOUS', 'AMBIGUOUS_NEED_ID'), candidates: set.map(person => person.id).sort(), narrow };
    const hit = set.find(person => person.id === asked.employeeId);
    if (!hit) return refuse('NONE', 'NONE_ID_NOT_IN_NAME_SET');
    return viaAlias ? matched('MATCH_BY_ID_NAME_UNLISTED', 'ID', hit.id, false) : matched('MATCH_BY_ID', 'ID', hit.id, true);
  }
  if (hasId) {
    if (!byId) return refuse('NONE', 'NONE_NOT_FOUND');
    return matched(hasName ? 'MATCH_BY_ID_NAME_UNLISTED' : 'MATCH_BY_ID', 'ID', byId.id, !hasName);
  }
  return refuse('NONE', 'NONE_NOT_FOUND');
}

// What the sender is shown when a match fails. Fixed text chosen by code, so it cannot reveal whether
// a person exists and cannot be steered by anything a model said.
export const MATCH_MESSAGES = {
  AMBIGUOUS_NEED_ID: 'More than one person fits. Enter the employee number to choose.',
  NONE_NOT_FOUND: 'The fields do not match. Please check them and try again.',
  NONE_ID_NOT_IN_NAME_SET: 'The fields do not match. Please check them and try again.',
  CONFLICT_ID_NAME: 'The fields do not match. Please check them and try again.',
  INVALID_INPUT: 'The fields do not match. Please check them and try again.'
};
