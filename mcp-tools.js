export function getMcpToolSchemas() {
  return [
    {
      name: 'create_sealed_package',
      description: 'Create a sealed package from ciphertext, crypto metadata, and a policy recommendation. Plaintext is not accepted.',
      inputSchema: {
        type: 'object',
        required: ['authorizationId', 'fileName', 'senderRole', 'policy', 'ciphertext', 'iv', 'salt', 'packageHash'],
        properties: {
          fileName: { type: 'string' },
          senderRole: { type: 'string' },
          authorizationId: { type: 'string' },
          policy: { type: 'object' },
          ciphertext: { type: 'string' },
          iv: { type: 'string' },
          salt: { type: 'string' },
          packageHash: { type: 'string' }
        }
      },
      outputBoundary: 'Returns package id, sealed link, and policy envelope only. Does not return plaintext.'
    },
    {
      name: 'route_package',
      description: 'Record one-way routing intent for a sealed package through a globally portable relay channel.',
      inputSchema: {
        type: 'object',
        required: ['packageId', 'channel', 'endpoint'],
        properties: {
          packageId: { type: 'string' },
          channel: { enum: ['email', 'internal_queue'] },
          requestId: { type: 'string' }
        }
      },
      outputBoundary: 'Returns delivery status and receipt id. Does not send plaintext.'
    },
    {
      name: 'prepare_email_delivery',
      description: 'Create a dry-run one-way email notification for a sealed package without sending mail.',
      inputSchema: {
        type: 'object',
        required: ['packageId', 'recipientLabel', 'baseUrl'],
        properties: {
          packageId: { type: 'string' },
          recipientLabel: { type: 'string' },
          baseUrl: { type: 'string' }
        }
      },
      outputBoundary: 'Returns email subject/body text containing only sealed-link metadata. Does not include plaintext, ciphertext, keys, IV, or salt.'
    },
    {
      name: 'check_endpoint_receipt',
      description: 'Read the latest delivery receipt state for a sealed package.',
      inputSchema: {
        type: 'object',
        required: ['packageId'],
        properties: {
          packageId: { type: 'string' }
        }
      },
      outputBoundary: 'Returns delivery metadata only.'
    },
    {
      name: 'issue_timed_credential',
      description: 'Issue a short-lived signed decode credential bound to package hash, policy hash, role, device claim, and revocation version.',
      inputSchema: {
        type: 'object',
        required: ['packageId', 'role', 'deviceClaim'],
        properties: {
          packageId: { type: 'string' },
          role: { type: 'string' },
          deviceClaim: { type: 'string' }
        }
      },
      outputBoundary: 'Returns a signed timed credential. The credential is not plaintext and still requires Decode Gate validation.'
    },
    {
      name: 'read_fallback_status',
      description: 'Read the latest fallback status for a package from denied decode attempts or routing failures.',
      inputSchema: {
        type: 'object',
        required: ['packageId'],
        properties: {
          packageId: { type: 'string' }
        }
      },
      outputBoundary: 'Returns denial reasons and safe fallback message only.'
    },
    {
      name: 'read_audit_log',
      description: 'Read recent package-scoped audit events.',
      inputSchema: {
        type: 'object',
        properties: {
          packageId: { type: 'string' },
          limit: { type: 'number' }
        }
      },
      outputBoundary: 'Returns audit metadata without plaintext, ciphertext, keys, IV, or salt.'
    }
  ];
}

export function fallbackMessageFromReasons(reasons) {
  const joined = Array.isArray(reasons) ? reasons.join(' ').toLowerCase() : '';
  if (joined.includes('expired')) return 'This timed access credential is expired. Request a fresh sealed-package access grant.';
  if (joined.includes('device')) return 'This endpoint is not eligible for local decryption. Use a managed device or contact the sender.';
  if (joined.includes('role') || joined.includes('recipient')) return 'This recipient is not eligible for this sealed package.';
  if (joined.includes('revoked')) return 'This sealed package has been revoked.';
  if (joined.includes('signature') || joined.includes('format')) return 'This access credential is invalid.';
  return 'This sealed package cannot be opened under the current policy.';
}
