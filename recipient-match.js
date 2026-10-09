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
  const refuse = (status, code) => ({ status, code, via: null, id: null, candidates: [], nameVerified: false });
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
  const named = hasName ? pool.filter(person => normalizeZhName(person.nameZh) === wanted) : [];
  const byId = hasId ? pool.find(person => person.id === asked.employeeId) : undefined;

  if (hasName && named.length === 1) {
    if (hasId && byId?.id !== named[0].id) return refuse('CONFLICT', 'CONFLICT_ID_NAME');
    return { status: 'MATCHED', code: 'MATCH_BY_NAME', via: 'NAME', id: named[0].id, candidates: [], nameVerified: true };
  }
  if (hasName && named.length > 1) {
    if (!hasId) return { ...refuse('AMBIGUOUS', 'AMBIGUOUS_NEED_ID'), candidates: named.map(person => person.id).sort() };
    const hit = named.find(person => person.id === asked.employeeId);
    return hit ? { status: 'MATCHED', code: 'MATCH_BY_ID', via: 'ID', id: hit.id, candidates: [], nameVerified: true }
      : refuse('NONE', 'NONE_ID_NOT_IN_NAME_SET');
  }
  if (hasId) {
    if (!byId) return refuse('NONE', 'NONE_NOT_FOUND');
    return { status: 'MATCHED', code: hasName ? 'MATCH_BY_ID_NAME_UNLISTED' : 'MATCH_BY_ID', via: 'ID', id: byId.id,
      candidates: [], nameVerified: !hasName };
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
