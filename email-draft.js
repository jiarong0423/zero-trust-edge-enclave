import { normalizeString } from './value-helpers.js';

function hasForbiddenEmailMaterial(value) {
  const text = String(value).toLowerCase();
  const forbidden = [
    'ciphertext',
    'smoke-ciphertext',
    'content key',
    'encryption key',
    'decryption key',
    '"iv"',
    '"salt"',
    'plaintext',
    'raw payload'
  ];
  return forbidden.some(term => text.includes(term));
}

export function createEmailDraftBuilder(host, port) {
  function buildDryRunEmailDraft(record, input) {
    const baseUrl = normalizeString(input.baseUrl, `http://${host}:${port}`).replace(/\/$/, '');
    const recipientLabel = normalizeString(input.recipientLabel, 'authorized-recipient');
    const decodeUrl = `${baseUrl}/decode.html?id=${encodeURIComponent(record.id)}`;
    const bodyLines = [
      `You have received a sealed enterprise data package.`,
      ``,
      `Package ID: ${record.id}`,
      `Classification: ${record.envelope.classification}`,
      `Risk level: ${record.envelope.riskLevel}`,
      `Expires at: ${record.envelope.expiresAt}`,
      `Allowed roles: ${record.envelope.allowedRoles.join(', ')}`,
      ``,
      `Open through the Decode Gate:`,
      decodeUrl,
      ``,
      `This is a one-way sealed-package notification. The message contains only sealed-link metadata and no protected content or cryptographic material.`,
      `If access fails, request a fresh timed credential from the sender or security operator.`
    ];
    const draft = {
      mode: 'dry_run_only',
      to: recipientLabel,
      subject: `Sealed package access notice: ${record.envelope.classification}`,
      body: bodyLines.join('\n'),
      sealedLink: decodeUrl,
      packageId: record.id,
      packageHash: record.packageHash,
      expiresAt: record.envelope.expiresAt,
      safetyChecks: {
        includesPlaintext: false,
        includesCiphertext: false,
        includesKeyMaterial: false,
        sendsEmail: false
      }
    };
    const outboundText = [draft.subject, draft.body, draft.sealedLink].join('\n');
    if (hasForbiddenEmailMaterial(outboundText)) {
      const error = new Error('dry-run email draft contains forbidden material');
      error.status = 500;
      throw error;
    }
    return draft;
  }

  return buildDryRunEmailDraft;
}
