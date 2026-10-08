import { AsyncLocalStorage } from 'node:async_hooks';

// The single per-request store. server.js opens it with `requestContext.run({}, ...)` for every
// /api/ request; routeApi fills it with `config` and `principal`; handlers set `auditTarget`; and
// auditRejection sets `rejectionRecorded`. It is mutated by reference, so every accessor here
// returns or writes the live store, never a copy.
export const requestContext = new AsyncLocalStorage();

export function currentRequest() {
  return requestContext.getStore();
}

export function setAuditTarget(target) {
  requestContext.getStore().auditTarget = target;
}
