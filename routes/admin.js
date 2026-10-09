import { auditArchiveIndex } from '../audit-retention.js';
import { retentionInventory } from '../retention-policy.js';
import { adminDirectory, changeDirectory } from '../directory-admin.js';
import { saveRegistry } from '../registry-store.js';
import { exact, fail } from '../access-control.js';
import { sendJson, readBody } from '../http-helpers.js';

// whoami and the administrator's own endpoints. Moved out of routeApi verbatim, in the order they had
// there, before the administrator kind gate and before any audit recovery. The caller has authenticated
// the principal; `handleAdmin` returns true when it answered the request and false when the path is
// not one of its own.
export function createAdminRoutes({ accessPath, tasksPath, auditsPath, readJson, matchGuard, appendAudit }) {
  async function handleAdmin(req, res, pathname, { config, principal }) {
    // Answers only "is this token a registered identity, and of which kind". It says nothing about
    // any task or grant: being authenticated is not being authorized, and the pages show the two apart.
    if (pathname === '/api/whoami') {
      if (req.method !== 'GET') fail('Method not allowed', 405);
      sendJson(res, 200, { ok: true, kind: principal.kind });
      return true;
    }
    if (pathname === '/api/admin/retention') {
      if (principal.kind !== 'administrator') fail('Administrator required');
      if (req.method !== 'GET') fail('Method not allowed', 405);
      sendJson(res, 200, retentionInventory(await readJson(tasksPath, [])));
      return true;
    }
    if (pathname === '/api/admin/audit-retention') {
      if (principal.kind !== 'administrator') fail('Administrator required');
      if (req.method !== 'GET') fail('Method not allowed', 405);
      sendJson(res, 200, await auditArchiveIndex(auditsPath));
      return true;
    }
    // Recipient-match quarantine: who is locked after repeated failed matches, and the only way out.
    if (pathname === '/api/admin/match-guard') {
      if (principal.kind !== 'administrator') fail('Administrator required');
      if (req.method === 'GET') {
        sendJson(res, 200, { limit: matchGuard.limit, entries: await matchGuard.list() });
        return true;
      }
      if (req.method === 'POST') {
        const input = await readBody(req);
        exact(input, ['operatorId', 'authorizationId']);
        const grant = config.grants.find(item => item.id === input.authorizationId && item.operatorId === input.operatorId);
        if (!grant) fail('Authorization not found', 404);
        const unlocked = await matchGuard.unlock(input.operatorId, input.authorizationId);
        if (unlocked) await appendAudit({ type: 'MATCH_ATTEMPT', result: 'INFO', reasons: ['MATCH_UNLOCKED'] });
        sendJson(res, 200, { ok: true, unlocked });
        return true;
      }
      fail('Method not allowed', 405);
    }
    if (pathname === '/api/admin/directory') {
      if (req.method === 'GET') {
        sendJson(res, 200, adminDirectory(config, principal));
        return true;
      }
      if (req.method === 'POST') {
        const input = await readBody(req);
        const result = changeDirectory(config, principal, input);
        await saveRegistry(accessPath, result.config, input.expectedRevision);
        sendJson(res, 200, { ...adminDirectory(result.config, principal), credential: result.credential });
        return true;
      }
      fail('Method not allowed', 405);
    }
    return false;
  }

  return { handleAdmin };
}
