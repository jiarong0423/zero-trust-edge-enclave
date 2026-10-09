import { ADVICE_SOURCE, ADVICE_NO_RETRY, adviceOrigin } from './file-worker.js';
import { requestFileAdvice } from './file-adviser.js';

const ADVISER_PRE_REQUEST_FAILURES = new Set(['FILE_ADVICE_KIND_UNKNOWN', 'FILE_METADATA_REJECTED',
  'FOLLOWUP_METADATA_REJECTED', 'MATCH_METADATA_REJECTED', 'FILE_PROVIDER_UNAVAILABLE', 'FILE_EXTERNAL_INFERENCE_DISABLED']);

const LOCAL_OUTLET = 'local_openai_compatible';

// Opt-in cascade: ask the local edge model first and ask the hosted model only when the local call
// produced nothing usable. It is a COORDINATOR_PROVIDER value of its own, so no existing value changes
// meaning and the default stays the synthetic fixture.
export const CASCADE_PROVIDER = 'local_then_nebius';

// Why the local outlet could not answer. Only these two failures start a cascade, and they are the
// whole vocabulary of the marker stored in the evidence trail:
//   LOCAL_UNREACHABLE  no answer was received: refused connection, timeout, transport error
//   LOCAL_REJECTED     the runtime answered but the result is unusable: an HTTP error, an oversized,
//                      empty or unparseable body, or an answer the validator refuses
// A valid answer is final even when it is WAIT or ESCALATE: the model reports no confidence, so there
// is nothing to trigger on except failure. A call refused before any request left (misconfigured
// endpoint, rejected metadata) is not a cascade trigger either; asking a second outlet would not be
// a retry of the same question but a quiet change of where data goes.
const CASCADE_TRIGGERS = { FILE_PROVIDER_UNREACHABLE: 'LOCAL_UNREACHABLE', FILE_PROVIDER_RESPONSE_REJECTED: 'LOCAL_REJECTED' };
export function cascadeReason(error) {
  if (!error || typeof error !== 'object' || error[ADVICE_NO_RETRY]) return null;
  if (error.adviceRejected) return 'LOCAL_REJECTED';
  return CASCADE_TRIGGERS[error.message] || null;
}

// Names a deployment may set. Anything else is refused by the request path with
// FILE_PROVIDER_UNAVAILABLE (never retried); start-up says so once instead of staying silent.
export const KNOWN_PROVIDERS = Object.freeze(['synthetic_fixture', 'nebius', 'local_openai_compatible', CASCADE_PROVIDER]);

// A Token Factory ceiling that can actually be computed: a positive NEBIUS_BUDGET_USD and both prices.
// It mirrors what createBudget treats as usable; a configured budget without prices counts as spent
// there, so it would not bound anything here either.
export function tokenFactoryBudgetUsable(env = process.env) {
  const positive = value => Number.isFinite(value) && value > 0;
  return env.NEBIUS_BUDGET_USD !== undefined && positive(Number(env.NEBIUS_BUDGET_USD)) &&
    positive(Number(env.NEBIUS_PRICE_INPUT_PER_M)) && positive(Number(env.NEBIUS_PRICE_OUTPUT_PER_M));
}

// The cascade is refused at start-up, not warned about, when any of its preconditions is missing:
//   CASCADE_REQUIRES_LOCAL_ONLY_FALSE            the hosted outlet is never reachable from an edge-only
//                                                deployment (the test the request path applies,
//                                                `localOnly !== false`)
//   CASCADE_REQUIRES_LEGACY_HOSTED_ADVICE_OFF    LOCAL_ONLY=false also opens /api/policy/recommend to the
//                                                hosted model; the cascade promises the five-field
//                                                projection, so those paths must be off (exactly "off")
//   CASCADE_REQUIRES_TOKEN_FACTORY_BUDGET        a cascade can reach the hosted model on every local
//                                                failure and the worker retries, so spend needs a ceiling
export function cascadeStartupProblem(provider, localOnly, { legacyHostedAdviceOff = false, env = process.env, budgetConfigured = true } = {}) {
  if (provider !== CASCADE_PROVIDER) return null;
  if (localOnly !== false) return 'CASCADE_REQUIRES_LOCAL_ONLY_FALSE';
  if (legacyHostedAdviceOff !== true) return 'CASCADE_REQUIRES_LEGACY_HOSTED_ADVICE_OFF';
  if (!budgetConfigured || !tokenFactoryBudgetUsable(env)) return 'CASCADE_REQUIRES_TOKEN_FACTORY_BUDGET';
  return null;
}

// One deadline for a whole cascaded call, so the stall it can put on the shared API queue is bounded
// like a call to a single outlet (10 s for the local outlet on its own). The local attempt may use at
// most this share of it, which keeps room for the hosted attempt behind it; the hosted attempt gets
// what is left (and never more than its own 5 s limit).
export const CASCADE_DEADLINE_MS = 10000;
const CASCADE_LOCAL_SHARE = 0.75;
const BUDGET_REFUSED = 'NEBIUS_BUDGET_EXHAUSTED';

// Each outlet is given its own endpoint and model. The loopback outlet is never handed the cloud
// credential: it does not need one, and sending a provider key to a local endpoint would put that
// key somewhere the boundary never intended it to go.
// A spent Token Factory budget hands the decision to the synthetic adviser, the same path a
// deployment without a key takes, rather than pausing every delivery.
// localRequest and hostedRequest are the transport for each outlet; they default to the global
// fetch and exist so a test can answer both outlets without a network.
export function createFileAdviser({ nebiusBudget, localOnly, localModelBaseUrl, localModelName, nebiusBaseUrl, nebiusModel,
  legacyHostedAdviceOff, localRequest, hostedRequest, cascadeDeadlineMs = CASCADE_DEADLINE_MS }) {
  const configured = process.env.COORDINATOR_PROVIDER;
  const startupProblem = cascadeStartupProblem(configured, localOnly, { legacyHostedAdviceOff, env: process.env,
    budgetConfigured: nebiusBudget?.configured === true });
  if (startupProblem) {
    console.error(`ERROR adviser ${CASCADE_PROVIDER} refused at start-up: ${startupProblem}`);
    throw new Error(startupProblem);
  }
  if (configured && !KNOWN_PROVIDERS.includes(configured)) {
    console.error(`WARN adviser COORDINATOR_PROVIDER ${JSON.stringify(configured.slice(0, 40))} is not one of ${KNOWN_PROVIDERS.join(', ')}; ` +
      'every adviser call will be refused with FILE_PROVIDER_UNAVAILABLE');
  }
  const hostedBlocked = localOnly !== false;
  const sendLocal = localRequest || ((url, init) => fetch(url, init));
  const sendHosted = hostedRequest || ((url, init) => fetch(url, init));

  const outletFor = provider => provider === LOCAL_OUTLET
    ? { baseUrl: localModelBaseUrl, model: localModelName }
    : { baseUrl: nebiusBaseUrl, model: nebiusModel, apiKey: process.env.NEBIUS_API_KEY };
  // budgetRefusal, when given, learns whether the spending cap (rather than the network) refused the
  // request: requestFileAdvice folds every transport failure into one code, so the cap's own error is
  // only visible here.
  const requestFor = (provider, budgetRefusal) => provider === 'nebius'
    ? async (url, init) => {
      try { return await nebiusBudget.fetch(url, init, sendHosted); }
      catch (error) {
        if (budgetRefusal && error?.message === BUDGET_REFUSED) budgetRefusal.refused = true;
        throw error;
      }
    }
    : provider === LOCAL_OUTLET ? sendLocal : sendHosted;

  // One outlet, one call, one log line. cascade is the marker when this call is the second outlet of
  // a cascade; failureNote adds the cascade state to a failure line once the failure is classified.
  async function ask(provider, metadata, kind, { cascade = null, failureNote = null, timeoutMs, budgetRefusal } = {}) {
    const outlet = outletFor(provider);
    // One line per adviser call, so the operator can see which outlet and model answered and what it
    // proposed. It carries the action and reason code only: never the task alias or any identity.
    const model = provider === 'synthetic_fixture' ? '-' : outlet.model;
    const started = performance.now();
    try {
      const result = await requestFileAdvice(metadata, { provider, localOnly, kind, timeoutMs, ...outlet },
        requestFor(provider, budgetRefusal));
      console.log(`adviser ${kind} ${result.provider} ${model} ${Math.round(performance.now() - started)}ms ` +
        `${result.advice.action} ${result.advice.reasonCode}${cascade ? ` cascade=${cascade.reason}` : ''}`);
      result.advice[ADVICE_SOURCE] = cascade ? adviceOrigin(result.provider, cascade) : result.provider;
      return result;
    } catch (error) {
      const note = failureNote ? failureNote(error) : '';
      console.error(`ERROR adviser ${kind} ${provider} ${model} ${Math.round(performance.now() - started)}ms ${error?.message}` +
        `${cascade ? ` cascade=${cascade.reason}` : ''}${note}`);
      // Only a failure after a request was sent names the outlet; a call refused before any request
      // (outlet disabled, misconfigured, metadata rejected) never reached a model.
      if (error && typeof error === 'object') {
        if (ADVISER_PRE_REQUEST_FAILURES.has(error.message)) error[ADVICE_NO_RETRY] = true;
        else {
          const label = provider === 'nebius' ? 'nebius_token_factory' : provider;
          error[ADVICE_SOURCE] = cascade ? adviceOrigin(label, cascade) : label;
        }
      }
      throw error;
    }
  }

  // Local first. The second outlet is asked at most once, with the identical projection, and only
  // after a local failure that cascadeReason() names. Whatever it returns or throws is final, except
  // that a hosted call the spending cap refused is answered by the fixture, as a spent cap is.
  // hostedAllowed is false for a caller that must never reach the hosted outlet (the coordinator's
  // file_recommend tool, which leaves no evidence-trail entry): it then gets the local outlet only.
  async function cascaded(metadata, kind, hostedAllowed) {
    const deadlineAt = performance.now() + cascadeDeadlineMs;
    const mayCascade = hostedAllowed && !hostedBlocked;
    let localError;
    try {
      return await ask(LOCAL_OUTLET, metadata, kind, {
        timeoutMs: mayCascade ? Math.floor(cascadeDeadlineMs * CASCADE_LOCAL_SHARE) : cascadeDeadlineMs,
        failureNote: error => {
          const reason = cascadeReason(error);
          return !reason ? '' : hostedBlocked ? ' cascade=BLOCKED_LOCAL_ONLY' : !hostedAllowed ? ' cascade=NO_HOSTED_FOR_TOOL' : ` cascade=${reason}`;
        } });
    } catch (error) { localError = error; }
    const reason = cascadeReason(localError);
    if (!reason || !mayCascade) throw localError;
    let hostedProvider;
    try {
      hostedProvider = (await nebiusBudget.exhausted()) ? 'synthetic_fixture' : 'nebius';
    } catch {
      console.error(`ERROR adviser ${kind} nebius ${nebiusModel} 0ms NEBIUS_BUDGET_UNREADABLE cascade=${reason}`);
      throw localError;
    }
    const remaining = Math.floor(deadlineAt - performance.now());
    if (hostedProvider === 'nebius' && remaining <= 0) {
      console.error(`ERROR adviser ${kind} nebius ${nebiusModel} 0ms CASCADE_DEADLINE_SPENT cascade=${reason}`);
      throw localError;
    }
    const origin = { from: LOCAL_OUTLET, reason };
    const budgetRefusal = { refused: false };
    try {
      return await ask(hostedProvider, metadata, kind, { cascade: origin, timeoutMs: remaining, budgetRefusal,
        failureNote: () => budgetRefusal.refused ? ` ${BUDGET_REFUSED}` : '' });
    } catch (hostedError) {
      // The cap refused this one request (its reservation would cross the limit) although the ledger
      // is not yet at the limit. That is a spent budget for this call: the fixture decides, exactly as
      // when the ledger itself is spent, instead of the decision pausing on a hosted failure.
      if (budgetRefusal.refused) return ask('synthetic_fixture', metadata, kind, { cascade: origin });
      // Refused before any request left (no key, outlet misconfigured): the second outlet was never
      // reached, so the failure worth reporting, and retrying, is the local one.
      if (hostedError?.[ADVICE_NO_RETRY]) throw localError;
      throw hostedError;
    }
  }

  // options.hosted === false: under the cascade, answer from the local outlet only.
  return async function fileAdviser(metadata, kind = 'route', options = {}) {
    // options.outlet names one outlet to ask on its own, with no cascade and no synthetic fallback: a
    // second opinion that silently turns into the fixture would not be a second opinion. The hosted
    // outlet still refuses under LOCAL_ONLY and still passes through the spending cap.
    if (options?.outlet === 'local') return ask(LOCAL_OUTLET, metadata, kind, { timeoutMs: cascadeDeadlineMs });
    if (options?.outlet === 'hosted') return ask('nebius', metadata, kind, { timeoutMs: cascadeDeadlineMs });
    let provider = process.env.COORDINATOR_PROVIDER || 'synthetic_fixture';
    if (provider === CASCADE_PROVIDER) return cascaded(metadata, kind, options?.hosted !== false);
    if (provider === 'nebius' && await nebiusBudget.exhausted()) provider = 'synthetic_fixture';
    return ask(provider, metadata, kind);
  };
}
