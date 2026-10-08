import { ADVICE_SOURCE, ADVICE_NO_RETRY } from './file-worker.js';
import { requestFileAdvice } from './file-adviser.js';

const ADVISER_PRE_REQUEST_FAILURES = new Set(['FILE_ADVICE_KIND_UNKNOWN', 'FILE_METADATA_REJECTED',
  'FOLLOWUP_METADATA_REJECTED', 'FILE_PROVIDER_UNAVAILABLE', 'FILE_EXTERNAL_INFERENCE_DISABLED']);

// Each outlet is given its own endpoint and model. The loopback outlet is never handed the cloud
// credential: it does not need one, and sending a provider key to a local endpoint would put that
// key somewhere the boundary never intended it to go.
// A spent Token Factory budget hands the decision to the synthetic adviser, the same path a
// deployment without a key takes, rather than pausing every delivery.
export function createFileAdviser({ nebiusBudget, localOnly, localModelBaseUrl, localModelName, nebiusBaseUrl, nebiusModel }) {
  return async function fileAdviser(metadata, kind = 'route') {
    let provider = process.env.COORDINATOR_PROVIDER || 'synthetic_fixture';
    if (provider === 'nebius' && await nebiusBudget.exhausted()) provider = 'synthetic_fixture';
    const outlet = provider === 'local_openai_compatible'
      ? { baseUrl: localModelBaseUrl, model: localModelName }
      : { baseUrl: nebiusBaseUrl, model: nebiusModel, apiKey: process.env.NEBIUS_API_KEY };
    // One line per adviser call, so the operator can see which outlet and model answered and what it
    // proposed. It carries the action and reason code only: never the task alias or any identity.
    const model = provider === 'synthetic_fixture' ? '-' : outlet.model;
    const started = performance.now();
    try {
      const result = await requestFileAdvice(metadata, { provider, localOnly, kind, ...outlet },
        provider === 'nebius' ? (url, init) => nebiusBudget.fetch(url, init) : fetch);
      console.log(`adviser ${kind} ${result.provider} ${model} ${Math.round(performance.now() - started)}ms ` +
        `${result.advice.action} ${result.advice.reasonCode}`);
      result.advice[ADVICE_SOURCE] = result.provider;
      return result;
    } catch (error) {
      console.error(`ERROR adviser ${kind} ${provider} ${model} ${Math.round(performance.now() - started)}ms ${error.message}`);
      // Only a failure after a request was sent names the outlet; a call refused before any request
      // (outlet disabled, misconfigured, metadata rejected) never reached a model.
      if (error && typeof error === 'object') {
        if (ADVISER_PRE_REQUEST_FAILURES.has(error.message)) error[ADVICE_NO_RETRY] = true;
        else error[ADVICE_SOURCE] = provider === 'nebius' ? 'nebius_token_factory' : provider;
      }
      throw error;
    }
  };
}
