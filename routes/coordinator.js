import { dispatchSnapshot } from '../snapshot-lifecycle.js';
import { fileRoutingMetadata } from '../file-routing.js';
import { normalizePolicyMetadata, buildFallbackPolicy, compileEnvelope } from '../policy-envelope.js';
import { activeGrant, safeMetadata, validateAdvice, exact, fail } from '../access-control.js';
import { sendJson, readBody } from '../http-helpers.js';
import { normalizeString } from '../value-helpers.js';
import { currentRequest } from '../request-context.js';

// The two advice paths: the coordinator's tool call and the legacy policy recommendation. Both are
// governed by LEGACY_HOSTED_ADVICE and the Token Factory budget, so they share one set of outlet
// settings. Moved out of server.js verbatim. `approvedPackage` and `performLocalDelivery` are the
// legacy package operations the `status`, `recommend` and `deliver` tools act on. `handleCoordinator`
// returns true when it answered the request and false when the path is not one of its own.
export function createCoordinatorRoutes({ tasksPath, packagesPath, readJson, fileAdviser, nebiusBudget, nebiusBaseUrl,
  nebiusModel, localOnly, legacyHostedAdviceOff, demoFallbackEnabled, validatePolicy, approvedPackage, performLocalDelivery }) {
  async function callNebiusPolicy(input) {
    if (localOnly || legacyHostedAdviceOff) return validatePolicy(buildFallbackPolicy(input));
    const apiKey = process.env.NEBIUS_API_KEY;
    if (!apiKey) {
      if (!demoFallbackEnabled) {
        throw new Error('NEBIUS_API_KEY is required and demo fallback is disabled');
      }
      return validatePolicy(buildFallbackPolicy(input));
    }
    if (await nebiusBudget.exhausted()) {
      return validatePolicy(buildFallbackPolicy(input, 'Demo fallback was used because the Token Factory budget is spent.'));
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const messages = [
      {
        role: 'system',
        content: [
          'You are an enterprise security policy assistant.',
          'Return only JSON with keys: riskLevel, classification, summary, allowedRoles, ttlMinutes, maxOpens, deviceBindingRequired, redactionRules, watermarkRequired, warnings.',
          'You must not ask for document content, summaries, snippets, extracted fields, or decryption keys.',
          'Use only non-content policy metadata. Do not approve access. Recommend policy only.'
        ].join(' ')
      },
      {
        role: 'user',
        content: JSON.stringify({
          policyMetadata: normalizePolicyMetadata(input.policyMetadata)
        })
      }
    ];

    try {
      const response = await nebiusBudget.fetch(`${nebiusBaseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: nebiusModel,
          temperature: 0.1,
          messages
        }),
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`Nebius request failed with HTTP ${response.status}`);
      }
      const payload = await response.json();
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new Error('Nebius response did not include message content');
      }
      const jsonStart = content.indexOf('{');
      const jsonEnd = content.lastIndexOf('}');
      if (jsonStart < 0 || jsonEnd < jsonStart) {
        throw new Error('Nebius response was not JSON');
      }
      const parsed = JSON.parse(content.slice(jsonStart, jsonEnd + 1));
      return validatePolicy({
        ...parsed,
        provider: 'nebius_token_factory',
        model: nebiusModel
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async function coordinatorCall(input) {
    exact(input, ['tool', 'arguments']);
    const args = input.arguments;
    if (['file_status', 'file_recommend'].includes(input.tool)) {
      exact(args, ['taskAlias', 'snapshotVersion']);
      const { config, principal } = currentRequest();
      const tasks = await readJson(tasksPath, []);
      const task = tasks.find(item => item.file && item.snapshots.some(snapshot =>
        snapshot.version === args.snapshotVersion && snapshot.privateMapping?.taskAlias === args.taskAlias));
      if (!task) fail('File task unavailable', 404);
      const grant = activeGrant(config, task.grantId);
      if ((principal.kind === 'coordinator' && principal.id !== grant.coordinatorId) ||
          (principal.kind === 'operator' && principal.id !== task.ownerId)) fail('Task access denied');
      const snapshot = dispatchSnapshot(task, grant, args.snapshotVersion);
      const job = task.jobs.find(item => item.version === snapshot.version);
      if (!job) fail('File task unavailable', 404);
      const metadata = fileRoutingMetadata(snapshot, job);
      if (input.tool === 'file_status') return { ok: true, metadata };
      // Under the opt-in cascade this tool is answered by the local outlet alone: it leaves no entry in
      // the sender's evidence trail and can be called repeatedly, so it must not be able to reach the
      // hosted model. The delivery worker's own calls (recorded in the trail) are the only cascade.
      const recommendation = await fileAdviser(metadata, 'route', { hosted: false });
      return { ok: true, provider: recommendation.provider, metadata, recommendation: recommendation.advice };
    }
    exact(args, input.tool === 'deliver' ? ['taskAlias', 'snapshotVersion', 'requestId', 'channel'] : ['taskAlias', 'snapshotVersion']);
    const { config, principal } = currentRequest();
    if (typeof args.taskAlias !== 'string' || !Number.isSafeInteger(args.snapshotVersion)) fail('Invalid routing reference', 422);
    const tasks = await readJson(tasksPath, []);
    const task = tasks.find(item => !item.file && item.snapshots.some(snapshot =>
      snapshot.version === args.snapshotVersion && snapshot.privateMapping?.taskAlias === args.taskAlias));
    if (!task) fail('Package not found', 404);
    const packages = await readJson(packagesPath, []);
    const record = packages.find(item => item.snapshot?.taskId === task.id && item.snapshot?.version === args.snapshotVersion);
    if (!record) fail('Package not found', 404);
    const grant = await approvedPackage(record);
    if (input.tool === 'deliver') return performLocalDelivery({ packageId: record.id, requestId: args.requestId, channel: args.channel });
    const metadata = safeMetadata(record, grant);
    if (input.tool === 'status') return { ok: true, metadata };
    if (input.tool !== 'recommend') fail('Coordinator tool not allowed', 422);
    let provider = 'synthetic_fixture';
    let advice = { action: 'DELIVER', channel: metadata.channels[0], reasonCode: 'CAPABILITY_MATCH' };
    if (process.env.COORDINATOR_PROVIDER === 'nebius' && !legacyHostedAdviceOff && !(await nebiusBudget.exhausted())) {
      if (localOnly) fail('External inference disabled in local-only mode', 503);
      if (!process.env.NEBIUS_API_KEY) fail('Coordinator provider unavailable', 503);
      const response = await nebiusBudget.fetch(`${nebiusBaseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST', signal: AbortSignal.timeout(15000),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.NEBIUS_API_KEY}` },
        body: JSON.stringify({ model: nebiusModel, temperature: 0,
          messages: [
            { role: 'system', content: 'Return JSON only with action DELIVER or PAUSE, channel from channels, and reasonCode CAPABILITY_MATCH, INSUFFICIENT_INFORMATION, or CHANNEL_UNAVAILABLE. Compare requiredCapability against recipientCapabilities. Never grant access.' },
            { role: 'user', content: JSON.stringify(metadata) }
          ] })
      });
      if (!response.ok) fail('Coordinator provider failed', 502);
      try { advice = JSON.parse((await response.json()).choices[0].message.content); }
      catch { fail('Invalid provider response', 502); }
      provider = 'nebius_token_factory';
    }
    return { ok: true, provider, metadata, recommendation: validateAdvice(advice, metadata) };
  }

  async function handleCoordinator(req, res, pathname, { principal }) {
    if (pathname === '/api/coordinator/call' && req.method === 'POST') {
      if (!['operator', 'coordinator'].includes(principal.kind)) fail('Coordinator required');
      sendJson(res, 200, await coordinatorCall(await readBody(req)));
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/policy/recommend') {
      const input = await readBody(req);
      exact(input, ['fileName', 'senderRole', 'intendedRecipientRole', 'policyMetadata', 'packageHash']);
      const policy = await callNebiusPolicy({
        fileName: normalizeString(input.fileName, 'internal-document.txt'),
        senderRole: normalizeString(input.senderRole, 'employee'),
        intendedRecipientRole: normalizeString(input.intendedRecipientRole, 'cfo'),
        policyMetadata: normalizePolicyMetadata(input.policyMetadata)
      });
      sendJson(res, 200, {
        policy,
        envelopePreview: compileEnvelope(policy, {
          packageHash: normalizeString(input.packageHash, 'pending-client-hash'),
          fileName: input.fileName,
          senderRole: input.senderRole
        })
      });
      return true;
    }
    return false;
  }

  return { handleCoordinator };
}
