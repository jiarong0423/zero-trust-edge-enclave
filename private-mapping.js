import crypto from 'node:crypto';
import { fail } from './access-control.js';

const GROUP_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const GROUP_CODE = /^[A-Z][1-9][0-9]{0,2}$/;

// A fresh permutation per snapshot: the position does not survive a revision, so a code cannot
// accumulate into a long-lived pseudonym. The group LETTER is not shuffled — it is the department's
// rank among the departments present in this snapshot — so a department holding a single approved
// recipient does receive a stable code, and adding or removing a department shifts later letters.
// Group codes are therefore a sender-facing and receipt-facing label, never adviser input.
function shuffledPositions(size) {
  const order = Array.from({ length: size }, (_, index) => index + 1);
  for (let index = order.length - 1; index > 0; index -= 1) {
    const pick = crypto.randomInt(index + 1);
    [order[index], order[pick]] = [order[pick], order[index]];
  }
  return order;
}

// Letters are assigned over the departments present in THIS snapshot, numbered from 1 with no
// gaps. A recipient left out of the snapshot leaves no hole behind, so the projection cannot
// reveal that an excluded person exists.
function groupCodes(content, departments) {
  const members = new Map();
  for (const recipientId of content.recipients) {
    const group = (Object.hasOwn(departments, recipientId) && departments[recipientId]) || 'unassigned';
    if (!members.has(group)) members.set(group, []);
    members.get(group).push(recipientId);
  }
  // Reject here rather than letting checkPrivateMapping refuse the finished snapshot later: the
  // code format tops out at 999 positions, and a deadlock at confirmation gives no usable reason.
  if (members.size > GROUP_LETTERS.length ||
      [...members.values()].some(pool => pool.length > 999)) fail('PRIVATE_MAPPING_REJECTED', 409);
  const codes = new Map();
  for (const [index, group] of [...members.keys()].sort().entries()) {
    const pool = members.get(group);
    const order = shuffledPositions(pool.length);
    pool.forEach((recipientId, position) => codes.set(recipientId, `${GROUP_LETTERS[index]}${order[position]}`));
  }
  return codes;
}

export function createPrivateMapping(taskId, version, content, departments = {}) {
  const codes = groupCodes(content, departments);
  return { taskId, version, taskAlias: crypto.randomUUID(),
    recipients: content.recipients.map(recipientId => ({ alias: crypto.randomUUID(), groupCode: codes.get(recipientId), recipientId,
      endpoints: content.channels.map(channel => ({ alias: crypto.randomUUID(), channel,
        endpointId: `dry-run:${recipientId}:${channel}` })) })) };
}

// Structural check only: the binding between a code and a real department is established at
// creation and protected by the snapshot hash, so this never needs the access registry.
// Letters must run from A with no gap, and each letter must be numbered 1..n with no gap, so a
// recipient left out of the snapshot cannot be inferred from a hole in the codes.
export function validGroupCodeSet(codes) {
  if (!Array.isArray(codes) || !codes.length) return false;
  const seen = new Set();
  const counts = new Map();
  for (const code of codes) {
    if (typeof code !== 'string' || !GROUP_CODE.test(code) || seen.has(code)) return false;
    seen.add(code);
    counts.set(code[0], (counts.get(code[0]) || 0) + 1);
  }
  if ([...counts.keys()].sort().some((letter, index) => letter !== GROUP_LETTERS[index])) return false;
  for (const [letter, size] of counts) {
    for (let position = 1; position <= size; position += 1) if (!seen.has(`${letter}${position}`)) return false;
  }
  return true;
}

// Group letter first, then numeric position: a plain lexicographic sort would order a group of
// ten as A1, A10, A2 and make the projection read as if a position were missing.
export function compareGroupCodes(left, right) {
  if (left[0] !== right[0]) return left[0] < right[0] ? -1 : 1;
  return Number(left.slice(1)) - Number(right.slice(1));
}

export function checkPrivateMapping(mapping, taskId, version, content) {
  const reject = () => fail('PRIVATE_MAPPING_REJECTED', 409);
  if (!mapping || mapping.taskId !== taskId || mapping.version !== version || !Array.isArray(mapping.recipients)) reject();
  const aliases = [mapping.taskAlias];
  if (mapping.recipients.length !== content.recipients.length) reject();
  for (const [index, entry] of mapping.recipients.entries()) {
    if (entry.recipientId !== content.recipients[index] || !Array.isArray(entry.endpoints) ||
        entry.endpoints.length !== content.channels.length) reject();
    aliases.push(entry.alias);
    for (const [position, endpoint] of entry.endpoints.entries()) {
      if (endpoint.channel !== content.channels[position] ||
          endpoint.endpointId !== `dry-run:${entry.recipientId}:${endpoint.channel}`) reject();
      aliases.push(endpoint.alias);
    }
  }
  if (!validGroupCodeSet(mapping.recipients.map(entry => entry.groupCode))) reject();
  if (new Set(aliases).size !== aliases.length || aliases.some(alias => typeof alias !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(alias))) reject();
  return mapping;
}

export function resolvePrivateRoute(mapping, content, channel) {
  checkPrivateMapping(mapping, mapping?.taskId, mapping?.version, content);
  if (!content.channels.includes(channel)) fail('PRIVATE_ROUTE_REJECTED', 422);
  return mapping.recipients.map(entry => ({ recipientId: entry.recipientId, groupCode: entry.groupCode,
    endpointId: entry.endpoints.find(endpoint => endpoint.channel === channel).endpointId }));
}

// Feeds the legacy coordinator metadata, which is sent to a provider verbatim, so group codes are
// deliberately absent here: a letter plus position would disclose which departments are involved
// and how many approved recipients each one holds. It does NOT hide the total headcount — this
// array carries one entry per recipient, so its length is the count. Group codes stay on the
// sender and receipt surfaces, which read the mapping entries directly.
export function mappingProjection(mapping) {
  return { taskAlias: mapping.taskAlias, snapshotVersion: mapping.version,
    recipients: mapping.recipients.map(entry => ({ recipientAlias: entry.alias,
      routes: entry.endpoints.map(endpoint => ({ routeAlias: endpoint.alias, channel: endpoint.channel })) })) };
}
