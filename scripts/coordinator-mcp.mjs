import { promises as fs } from 'node:fs';
import readline from 'node:readline';

const base = new URL(process.env.COORDINATOR_BASE_URL || 'http://127.0.0.1:3344');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.protocol !== 'http:') throw new Error('Local coordinator endpoint required');
const tokenFile = process.env.COORDINATOR_TOKEN_FILE;
if (!tokenFile) throw new Error('COORDINATOR_TOKEN_FILE required');
const token = (await fs.readFile(tokenFile, 'utf8')).trim();
const tools = ['status', 'recommend', 'deliver'].map(name => ({ name,
  description: name === 'deliver' ? 'Request an authorized local dry-run delivery attempt. Never sends email.' : `Read allowlisted ${name} output for an approved anonymous task alias and version.`,
  inputSchema: { type: 'object', additionalProperties: false,
    properties: { taskAlias: { type: 'string' }, snapshotVersion: { type: 'integer', minimum: 1 }, ...(name === 'deliver' ? { requestId: { type: 'string' }, channel: { type: 'string', enum: ['email', 'internal_queue'] } } : {}) },
    required: name === 'deliver' ? ['taskAlias', 'snapshotVersion', 'requestId', 'channel'] : ['taskAlias', 'snapshotVersion'] }
}));
tools.push(...['file_status', 'file_recommend'].map(name => ({ name,
  description: 'Read code-only local file task status or configured-provider route advice. No execution, file, address, key or credential access.',
  inputSchema: { type: 'object', additionalProperties: false,
    properties: { taskAlias: { type: 'string' }, snapshotVersion: { type: 'integer', minimum: 1 } },
    required: ['taskAlias', 'snapshotVersion'] }
})));

const PROTOCOL_VERSION = '2026-07-28';
const SUPPORTED_VERSIONS = [PROTOCOL_VERSION];
const SERVER_INFO = { name: 'edge-enclave-local-coordinator', version: '0.2.0' };
const VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
const UNSUPPORTED_PROTOCOL_VERSION = -32022;

// 2026-07-28 removed the initialize handshake and the protocol session: every request carries its
// own version and is accepted or refused on its own. That is what this coordinator already did at
// the application layer — each call re-derives authority from the snapshot named by its arguments
// and keeps nothing between calls — so the transport now matches the workflow instead of implying
// a session that never existed.
function requestedVersion(message) {
  const declared = message?.params?._meta?.[VERSION_KEY] ?? message?._meta?.[VERSION_KEY];
  return declared === undefined ? PROTOCOL_VERSION : declared;
}

async function handle(message) {
  const version = requestedVersion(message);
  if (!SUPPORTED_VERSIONS.includes(version)) {
    throw Object.assign(new Error('Unsupported protocol version'),
      { code: UNSUPPORTED_PROTOCOL_VERSION, data: { supported: SUPPORTED_VERSIONS } });
  }
  // Mandatory in this revision, and the backward-compatibility probe for stdio clients.
  if (message.method === 'server/discover') {
    return { resultType: 'complete', protocolVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} }, serverInfo: SERVER_INFO,
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO } };
  }
  if (message.method === 'tools/list') {
    // Deterministic order, and a freshness hint: this list is fixed for the life of the process.
    return { resultType: 'complete', tools, ttlMs: 3_600_000, cacheScope: 'private',
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO } };
  }
  if (message.method !== 'tools/call' || !tools.some(t => t.name === message.params?.name)) throw new Error('Method or tool not allowed');
  const response = await fetch(new URL('/api/coordinator/call', base), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ tool: message.params.name, arguments: message.params.arguments })
  });
  const result = await response.json();
  return { resultType: 'complete', content: [{ type: 'text', text: JSON.stringify(result) }],
    isError: !response.ok, _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO } };
}

for await (const line of readline.createInterface({ input: process.stdin })) {
  let message;
  try {
    message = JSON.parse(line);
    if (message.id === undefined) continue;
    const result = await handle(message);
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
  } catch (error) {
    const code = error?.code === UNSUPPORTED_PROTOCOL_VERSION ? UNSUPPORTED_PROTOCOL_VERSION : -32600;
    const body = code === UNSUPPORTED_PROTOCOL_VERSION
      ? { code, message: 'Unsupported protocol version', data: error.data }
      : { code, message: 'Invalid request or local service unavailable' };
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message?.id ?? null, error: body })}\n`);
  }
}
