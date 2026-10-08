import { ADVICE_SOURCE, ADVICE_NO_RETRY, adviceOrigin } from './file-worker.js';
import { requestFileAdvice } from './file-adviser.js';

const ADVISER_PRE_REQUEST_FAILURES = new Set(['FILE_ADVICE_KIND_UNKNOWN', 'FILE_METADATA_REJECTED',
  'FOLLOWUP_METADATA_REJECTED', 'FILE_PROVIDER_UNAVAILABLE', 'FILE_EXTERNAL_INFERENCE_DISABLED']);

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

// The hosted outlet is never reachable from an edge-only deployment. The same test the request path
// applies (`localOnly !== false`) decides here, so LOCAL_ONLY unset or true keeps the cascade local.
export function cascadeStartupProblem(provider, localOnly) {
  return provider === CASCADE_PROVIDER && localOnly !== false ? 'CASCADE_REQUIRES_LOCAL_ONLY_FALSE' : null;
}

// Each outlet is given its own endpoint and model. The loopback outlet is never handed the cloud
// credential: it does not need one, and sending a provider key to a local endpoint would put that
// key somewhere the boundary never intended it to go.
// A spent Token Factory budget hands the decision to the synthetic adviser, the same path a
// deployment without a key takes, rather than pausing every delivery.
// localRequest and hostedRequest are the transport for each outlet; they default to the global
// fetch and exist so a test can answer both outlets without a network.
export function createFileAdviser({ nebiusBudget, localOnly, localModelBaseUrl, localModelName, nebiusBaseUrl, nebiusModel,
  localRequest, hostedRequest }) {
  const startupProblem = cascadeStartupProblem(process.env.COORDINATOR_PROVIDER, localOnly);
  if (startupProblem) {
    console.error(`ERROR adviser ${CASCADE_PROVIDER} refused at start-up: ${startupProblem}`);
    throw new Error(startupProblem);
  }
  const hostedBlocked = localOnly !== false;
  const sendLocal = localRequest || ((url, init) => fetch(url, init));
  const sendHosted = hostedRequest || ((url, init) => fetch(url, init));

  const outletFor = provider => provider === LOCAL_OUTLET
    ? { baseUrl: localModelBaseUrl, model: localModelName }
    : { baseUrl: nebiusBaseUrl, model: nebiusModel, apiKey: process.env.NEBIUS_API_KEY };
  const requestFor = provider => provider === 'nebius' ? (url, init) => nebiusBudget.fetch(url, init, sendHosted)
    : provider === LOCAL_OUTLET ? sendLocal : sendHosted;

  // One outlet, one call, one log line. cascade is the marker when this call is the second outlet of
  // a cascade; failureNote adds the cascade state to a failure line once the failure is classified.
  async function ask(provider, metadata, kind, { cascade = null, failureNote = null } = {}) {
    const outlet = outletFor(provider);
    // One line per adviser call, so the operator can see which outlet and model answered and what it
    // proposed. It carries the action and reason code only: never the task alias or any identity.
    const model = provider === 'synthetic_fixture' ? '-' : outlet.model;
    const started = performance.now();
    try {
      const result = await requestFileAdvice(metadata, { provider, localOnly, kind, ...outlet }, requestFor(provider));
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
  // after a local failure that cascadeReason() names. Whatever it returns or throws is final.
  async function cascaded(metadata, kind) {
    let localError;
    try {
      return await ask(LOCAL_OUTLET, metadata, kind, { failureNote: error => {
        const reason = cascadeReason(error);
        return reason ? (hostedBlocked ? ' cascade=BLOCKED_LOCAL_ONLY' : ` cascade=${reason}`) : '';
      } });
    } catch (error) { localError = error; }
    const reason = cascadeReason(localError);
    if (!reason || hostedBlocked) throw localError;
    let hostedProvider;
    try {
      hostedProvider = (await nebiusBudget.exhausted()) ? 'synthetic_fixture' : 'nebius';
    } catch {
      console.error(`ERROR adviser ${kind} nebius ${nebiusModel} 0ms NEBIUS_BUDGET_UNREADABLE cascade=${reason}`);
      throw localError;
    }
    try {
      return await ask(hostedProvider, metadata, kind, { cascade: { from: LOCAL_OUTLET, reason } });
    } catch (hostedError) {
      // Refused before any request left (no key, outlet misconfigured): the second outlet was never
      // reached, so the failure worth reporting, and retrying, is the local one.
      if (hostedError?.[ADVICE_NO_RETRY]) throw localError;
      throw hostedError;
    }
  }

  return async function fileAdviser(metadata, kind = 'route') {
    let provider = process.env.COORDINATOR_PROVIDER || 'synthetic_fixture';
    if (provider === CASCADE_PROVIDER) return cascaded(metadata, kind);
    if (provider === 'nebius' && await nebiusBudget.exhausted()) provider = 'synthetic_fixture';
    return ask(provider, metadata, kind);
  };
}
