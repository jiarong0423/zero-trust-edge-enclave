import crypto from 'node:crypto';
import { auditProjection } from '../audit-boundary.js';
import { getMcpToolSchemas, fallbackMessageFromReasons } from '../mcp-tools.js';
import { authorizeRecord, exact, fail } from '../access-control.js';
import { sendJson, readBody } from '../http-helpers.js';
import { normalizeString } from '../value-helpers.js';
import { currentRequest } from '../request-context.js';

const sanitizeAuditEvent = event => auditProjection(event);

// The MCP-style transport shell: the tool list, the tool call, `executeMcpTool` and the email dry-run
// endpoint, which runs one of those tools. Moved out of server.js verbatim. The two rejection-catching
// routes call auditRejection themselves, as they did in routeApi (risk 3 in the split plan).
// `handleMcp` returns true when it answered the request and false when the path is not one of its own.
export function createMcpRoutes({ packagesPath, auditsPath, readJson, writeJson, appendAudit, auditRejection, buildDryRunEmailDraft,
  findPackage, approvedPackage, createSealedPackageRecord, performLocalDelivery, createTimedCredential }) {
  async function executeMcpTool(toolName, input) {
    if (toolName === 'issue_timed_credential') fail('Credentials are available only through the recipient API');
    if (toolName !== 'create_sealed_package') {
      const { record } = await findPackage(normalizeString(input.packageId));
      if (!record) fail('Package not found', 404);
      const { config, principal } = currentRequest();
      authorizeRecord(config, principal, record);
      await approvedPackage(record);
    }
    if (toolName === 'create_sealed_package') {
      return createSealedPackageRecord(input, 'mcp');
    }

    if (toolName === 'route_package') {
      return performLocalDelivery(input);
    }

    if (toolName === 'prepare_email_delivery') {
      const { packages, index, record } = await findPackage(normalizeString(input.packageId));
      if (!record) {
        const error = new Error('package not found');
        error.status = 404;
        throw error;
      }
      const approved = await approvedPackage(record);
      if (!approved.channels.includes('email')) fail('Email outside approved snapshot');
      exact(input, ['packageId']);
      const draft = buildDryRunEmailDraft(record, { recipientLabel: 'authorized-recipients' });
      const receipt = {
        id: crypto.randomUUID(),
        channel: 'email',
        endpoint: draft.to,
        regionHint: normalizeString(input.regionHint, 'global'),
        status: 'DRY_RUN_READY',
        sentAt: null,
        preparedAt: new Date().toISOString(),
        dryRun: true
      };
      packages[index] = {
        ...record,
        deliveryReceipts: [...(record.deliveryReceipts || []), receipt].slice(-20)
      };
      await writeJson(packagesPath, packages);
      await appendAudit({
        type: 'EMAIL_DRY_RUN_PREPARED',
        result: 'INFO',
        packageId: record.id,
        packageHash: record.packageHash,
        role: 'mcp-transport-shell',
        deviceClaim: 'mcp-transport-shell',
        deliveryReceiptId: receipt.id,
        deliveryChannel: receipt.channel,
        deliveryEndpoint: receipt.endpoint,
        regionHint: receipt.regionHint
      });
      return {
        ok: true,
        packageId: record.id,
        receipt,
        draft
      };
    }

    if (toolName === 'check_endpoint_receipt') {
      const { record } = await findPackage(normalizeString(input.packageId));
      if (!record) {
        const error = new Error('package not found');
        error.status = 404;
        throw error;
      }
      return {
        ok: true,
        packageId: record.id,
        latestReceipt: (record.deliveryReceipts || []).at(-1) || null,
        receiptCount: (record.deliveryReceipts || []).length
      };
    }

    if (toolName === 'issue_timed_credential') {
      const { record } = await findPackage(normalizeString(input.packageId));
      if (!record) {
        const error = new Error('package not found');
        error.status = 404;
        throw error;
      }
      await approvedPackage(record);
      const credential = createTimedCredential(record, input);
      await appendAudit({
        type: 'TIMED_CREDENTIAL_ISSUED',
        result: 'INFO',
        packageId: record.id,
        packageHash: record.packageHash,
        role: credential.claims.role,
        deviceClaim: credential.claims.deviceClaim,
        credentialId: credential.claims.credentialId,
        credentialExpiresAt: credential.claims.expiresAt
      });
      return {
        ok: true,
        credential
      };
    }

    if (toolName === 'read_fallback_status') {
      const packageId = normalizeString(input.packageId);
      const audits = await readJson(auditsPath, []);
      const latestDenied = audits.map(sanitizeAuditEvent)
        .filter(event => event.packageId === packageId && event.type === 'DECODE_ATTEMPT' && event.result === 'DENY')
        .at(-1);
      return {
        ok: true,
        packageId,
        fallback: latestDenied
          ? {
              status: 'DENIED',
              reasons: latestDenied.reasons || [],
              message: fallbackMessageFromReasons(latestDenied.reasons),
              eventHash: latestDenied.eventHash,
              createdAt: latestDenied.createdAt
            }
          : {
              status: 'NONE',
              reasons: [],
              message: 'No fallback condition has been recorded for this package.',
              eventHash: null,
              createdAt: null
            }
      };
    }

    if (toolName === 'read_audit_log') {
      const packageId = normalizeString(input.packageId);
      const limit = Math.min(Math.max(Number(input.limit || 20), 1), 50);
      const audits = await readJson(auditsPath, []);
      const events = audits
        .filter(event => !packageId || event.packageId === packageId)
        .slice(-limit)
        .map(sanitizeAuditEvent)
        .reverse();
      return {
        ok: true,
        events
      };
    }

    const error = new Error('unknown MCP transport tool');
    error.status = 404;
    throw error;
  }

  async function handleMcp(req, res, pathname) {
    if (req.method === 'GET' && pathname === '/api/mcp/tools') {
      sendJson(res, 200, {
        ok: true,
        name: 'zero-trust-edge-enclave-transport-shell',
        description: 'MCP-style secure package transport shell for globally portable sealed data delivery.',
        contentBoundary: 'No plaintext, document summaries, snippets, encryption keys, IV, or salt are returned by read tools.',
        tools: getMcpToolSchemas().filter(tool => tool.name !== 'issue_timed_credential')
      });
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/mcp/call') {
      const input = await readBody(req);
      const toolName = normalizeString(input.tool);
      try {
        const result = await executeMcpTool(toolName, input.arguments || {});
        sendJson(res, 200, {
          ok: true,
          tool: toolName,
          result
        });
      } catch (error) {
        await auditRejection(error);
        sendJson(res, error.status || 500, {
          ok: false,
          tool: toolName,
          error: error instanceof Error ? error.message : 'MCP transport tool failed'
        });
      }
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/delivery/email/dry-run') {
      const input = await readBody(req);
      try {
        const result = await executeMcpTool('prepare_email_delivery', input);
        sendJson(res, 200, result);
      } catch (error) {
        await auditRejection(error);
        sendJson(res, error.status || 500, {
          ok: false,
          error: error instanceof Error ? error.message : 'email dry-run failed'
        });
      }
      return true;
    }
    return false;
  }

  return { handleMcp };
}
