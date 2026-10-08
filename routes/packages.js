import { authorizeRecord, fail } from '../access-control.js';
import { sendJson, readBody } from '../http-helpers.js';
import { normalizeString } from '../value-helpers.js';

// The legacy sealed-package endpoints: create, read, issue a timed credential, verify and revoke.
// Moved out of routeApi verbatim, in the order they had there (the GET prefix match comes first, as
// before). The rejection-catching create route calls auditRejection itself (risk 3 in the split plan).
// `handlePackages` returns true when it answered the request and false when the path is not one of
// its own.
export function createPackageRoutes({ packagesPath, readJson, writeJson, appendAudit, auditRejection, readSignedCredential,
  createSealedPackageRecord, approvedPackage, createTimedCredential, evaluateDecodeAttempt }) {
  async function handlePackages(req, res, pathname, { config, principal }) {
    if (req.method === 'POST' && pathname === '/api/packages') {
      const input = await readBody(req);
      if (!input.ciphertext || !input.iv || !input.packageHash || !input.policy) {
        sendJson(res, 422, { ok: false, error: 'ciphertext, iv, packageHash, and policy are required' });
        return true;
      }
      try {
        const created = await createSealedPackageRecord(input, 'api');
        sendJson(res, 201, created);
      } catch (error) {
        await auditRejection(error);
        sendJson(res, error.status || 500, {
          ok: false,
          error: error instanceof Error ? error.message : 'package creation failed'
        });
      }
      return true;
    }

    if (req.method === 'GET' && pathname.startsWith('/api/packages/')) {
      const packageId = pathname.split('/').at(-1);
      const packages = await readJson(packagesPath, []);
      const record = packages.find(item => item.id === packageId);
      if (!record) {
        sendJson(res, 404, { ok: false, error: 'package not found' });
        return true;
      }
      authorizeRecord(config, principal, record);
      sendJson(res, 200, {
        id: record.id,
        fileName: record.fileName,
        packageHash: record.packageHash,
        envelope: record.envelope,
        openCount: record.openCount,
        revoked: record.revoked,
        revocationVersion: record.revocationVersion || 0
      });
      return true;
    }

    if (req.method === 'POST' && pathname.endsWith('/credential') && pathname.startsWith('/api/packages/')) {
      const packageId = pathname.split('/')[3];
      const input = await readBody(req);
      const packages = await readJson(packagesPath, []);
      const record = packages.find(item => item.id === packageId);
      if (!record) {
        sendJson(res, 404, { ok: false, error: 'package not found' });
        return true;
      }
      await approvedPackage(record);
      const credential = createTimedCredential(record, input);
      const audit = await appendAudit({
        type: 'TIMED_CREDENTIAL_ISSUED',
        result: 'INFO',
        packageId,
        packageHash: record.packageHash,
        role: credential.claims.role,
        deviceClaim: credential.claims.deviceClaim,
        credentialId: credential.claims.credentialId,
        credentialExpiresAt: credential.claims.expiresAt
      });
      sendJson(res, 201, {
        ok: true,
        credential,
        audit
      });
      return true;
    }

    if (req.method === 'POST' && pathname.endsWith('/verify') && pathname.startsWith('/api/packages/')) {
      const packageId = pathname.split('/')[3];
      const input = await readBody(req);
      const packages = await readJson(packagesPath, []);
      const index = packages.findIndex(item => item.id === packageId);
      if (index < 0) {
        sendJson(res, 404, { ok: false, error: 'package not found' });
        return true;
      }
      const record = packages[index];
      await approvedPackage(record);
      let credential;
      try {
        credential = readSignedCredential(input.credential);
      } catch (error) {
        const audit = await appendAudit({
          type: 'DECODE_ATTEMPT',
          result: 'DENY',
          packageId,
          packageHash: record.packageHash,
          role: normalizeString(input.role, 'unknown'),
          deviceClaim: normalizeString(input.deviceClaim, 'unknown-device'),
          reasons: [error instanceof Error ? error.message : 'invalid credential']
        });
        sendJson(res, 200, {
          ok: false,
          result: 'DENY',
          reasons: audit.reasons,
          package: {
            id: record.id,
            fileName: record.fileName,
            packageHash: record.packageHash,
            ciphertext: null,
            iv: null,
            salt: null,
            envelope: record.envelope
          },
          audit
        });
        return true;
      }
      const decision = evaluateDecodeAttempt(record, credential);
      if (decision.ok) {
        packages[index] = {
          ...record,
          openCount: record.openCount + 1,
          usedCredentials: [...(record.usedCredentials || []), credential.credentialId]
        };
        await writeJson(packagesPath, packages);
      }

      const audit = await appendAudit({
        type: 'DECODE_ATTEMPT',
        result: decision.result,
        packageId,
        packageHash: record.packageHash,
        role: decision.role,
        deviceClaim: decision.deviceClaim,
        credentialId: credential.credentialId,
        credentialExpiresAt: credential.expiresAt,
        reasons: decision.reasons
      });
      sendJson(res, 200, {
        ok: decision.ok,
        result: decision.result,
        reasons: decision.reasons,
        package: {
          id: record.id,
          fileName: record.fileName,
          packageHash: record.packageHash,
          ciphertext: decision.ok ? record.ciphertext : null,
          iv: decision.ok ? record.iv : null,
          salt: decision.ok ? record.salt : null,
          envelope: record.envelope
        },
        audit
      });
      return true;
    }

    if (req.method === 'POST' && pathname.endsWith('/revoke') && pathname.startsWith('/api/packages/')) {
      const packageId = pathname.split('/')[3];
      const packages = await readJson(packagesPath, []);
      const index = packages.findIndex(item => item.id === packageId);
      if (index < 0) {
        sendJson(res, 404, { ok: false, error: 'package not found' });
        return true;
      }
      if (principal.kind !== 'operator') fail('Operator required');
      authorizeRecord(config, principal, packages[index]);
      packages[index].revoked = true;
      packages[index].revocationVersion = (packages[index].revocationVersion || 0) + 1;
      await writeJson(packagesPath, packages);
      const audit = await appendAudit({
        type: 'PACKAGE_REVOKED',
        result: 'INFO',
        packageId,
        packageHash: packages[index].packageHash,
        role: 'security-admin',
        deviceClaim: 'soc-dashboard'
      });
      sendJson(res, 200, { ok: true, audit });
      return true;
    }
    return false;
  }

  return { handlePackages };
}
