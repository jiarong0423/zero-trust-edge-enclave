import { exact, fail } from './access-control.js';
import { hashJson, normalizeString, normalizeArray } from './value-helpers.js';

export function normalizePolicyMetadata(value) {
  const metadata = value && typeof value === 'object' ? value : {};
  const allowed = {
    dataCategory: ['finance', 'legal', 'hr', 'engineering'],
    confidentiality: ['confidential', 'restricted', 'internal'],
    businessPurpose: ['approval', 'review', 'archive'],
    requestedExpiry: ['1h', '4h', '24h'],
    devicePolicy: ['managed_device_only', 'registered_device', 'any_authenticated_device'],
    openLimit: ['single_use', 'limited_use']
  };
  exact(metadata, Object.keys(allowed));
  for (const [key, options] of Object.entries(allowed)) {
    if (metadata[key] !== undefined && !options.includes(metadata[key])) fail('Unsupported policy metadata', 422);
  }
  return {
    dataCategory: normalizeString(metadata.dataCategory, 'finance').toLowerCase(),
    confidentiality: normalizeString(metadata.confidentiality, 'confidential').toLowerCase(),
    businessPurpose: normalizeString(metadata.businessPurpose, 'approval').toLowerCase(),
    requestedExpiry: normalizeString(metadata.requestedExpiry, '1h').toLowerCase(),
    devicePolicy: normalizeString(metadata.devicePolicy, 'managed_device_only').toLowerCase(),
    openLimit: normalizeString(metadata.openLimit, 'single_use').toLowerCase()
  };
}

export function buildFallbackPolicy(input, reason = 'Demo fallback was used because NEBIUS_API_KEY is not configured.') {
  const metadata = normalizePolicyMetadata(input.policyMetadata);
  const highRisk = metadata.confidentiality === 'confidential' || metadata.dataCategory === 'finance' || metadata.dataCategory === 'legal';
  const requestedTtl = metadata.requestedExpiry === '24h' ? 1440 : metadata.requestedExpiry === '4h' ? 240 : 60;
  return {
    provider: 'demo_fallback',
    model: 'local-rule-policy-demo',
    riskLevel: highRisk ? 'high' : 'medium',
    classification: highRisk ? 'internal_confidential' : 'internal_restricted',
    summary: highRisk
      ? 'Non-content metadata requests a high-control route for a confidential internal package.'
      : 'Non-content metadata requests a policy-bound route for an internal package.',
    allowedRoles: highRisk ? ['cfo'] : ['cfo', 'manager'],
    ttlMinutes: Math.min(requestedTtl, highRisk ? 60 : 240),
    maxOpens: metadata.openLimit === 'limited_use' ? 3 : 1,
    deviceBindingRequired: metadata.devicePolicy !== 'any_authenticated_device',
    redactionRules: highRisk
      ? ['mask customer identifiers for non-cfo roles', 'mask unreleased revenue figures for non-cfo roles']
      : ['mask direct identifiers for non-manager roles'],
    watermarkRequired: true,
    warnings: [`${reason} This is not hackathon submission evidence.`]
  };
}

export function validatePolicy(policy, nebiusModel) {
  const allowedRisk = new Set(['low', 'medium', 'high', 'critical']);
  const allowedClassifications = new Set(['public', 'internal', 'internal_restricted', 'internal_confidential', 'regulated']);
  const normalized = {
    provider: normalizeString(policy.provider, 'unknown'),
    model: normalizeString(policy.model, nebiusModel),
    riskLevel: allowedRisk.has(policy.riskLevel) ? policy.riskLevel : 'high',
    classification: allowedClassifications.has(policy.classification) ? policy.classification : 'internal_confidential',
    summary: normalizeString(policy.summary, 'Policy recommendation requires human review.'),
    allowedRoles: normalizeArray(policy.allowedRoles, ['cfo']),
    ttlMinutes: Math.min(Math.max(Number(policy.ttlMinutes || 60), 5), 1440),
    maxOpens: Math.min(Math.max(Number(policy.maxOpens || 1), 1), 10),
    deviceBindingRequired: Boolean(policy.deviceBindingRequired),
    redactionRules: normalizeArray(policy.redactionRules, []),
    watermarkRequired: policy.watermarkRequired !== false,
    warnings: normalizeArray(policy.warnings, [])
  };

  if (normalized.allowedRoles.length === 0) {
    normalized.allowedRoles = ['cfo'];
  }

  return normalized;
}

export function compileEnvelope(policy, input) {
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + policy.ttlMinutes * 60_000).toISOString();
  const envelope = {
    version: '0.1',
    createdAt,
    expiresAt,
    packageHash: normalizeString(input.packageHash),
    fileName: normalizeString(input.fileName, 'sealed-package.txt'),
    senderRole: normalizeString(input.senderRole, 'employee'),
    allowedRoles: policy.allowedRoles,
    classification: policy.classification,
    riskLevel: policy.riskLevel,
    ttlMinutes: policy.ttlMinutes,
    maxOpens: policy.maxOpens,
    deviceBindingRequired: policy.deviceBindingRequired,
    redactionRules: policy.redactionRules,
    watermarkRequired: policy.watermarkRequired,
    aiRecommendation: {
      provider: policy.provider,
      model: policy.model,
      summary: policy.summary,
      warnings: policy.warnings
    }
  };
  return {
    ...envelope,
    signature: hashJson(envelope)
  };
}
