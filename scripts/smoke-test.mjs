const baseUrl = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3344';

async function postJson(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const json = await response.json();
  if (!response.ok) {
    throw new Error(`${path} failed: ${json.error || response.status}`);
  }
  return json;
}

async function mcpCall(tool, args) {
  const response = await postJson('/api/mcp/call', {
    tool,
    arguments: args
  });
  if (!response.ok || !response.result?.ok) {
    throw new Error(`MCP tool ${tool} failed`);
  }
  return response.result;
}

async function main() {
  const healthResponse = await fetch(`${baseUrl}/api/health`);
  if (!healthResponse.ok) {
    throw new Error('health check failed');
  }
  const toolsResponse = await fetch(`${baseUrl}/api/mcp/tools`);
  const tools = await toolsResponse.json();
  const toolNames = new Set((tools.tools || []).map(tool => tool.name));
  for (const name of ['create_sealed_package', 'route_package', 'prepare_email_delivery', 'check_endpoint_receipt', 'issue_timed_credential', 'read_fallback_status', 'read_audit_log']) {
    if (!toolNames.has(name)) {
      throw new Error(`missing MCP transport tool: ${name}`);
    }
  }

  const policy = await postJson('/api/policy/recommend', {
    fileName: 'Synthetic_Internal_Demo.txt',
    senderRole: 'engineering',
    intendedRecipientRole: 'manager',
    policyMetadata: {
      dataCategory: 'engineering',
      confidentiality: 'internal',
      businessPurpose: 'review',
      requestedExpiry: '4h',
      devicePolicy: 'managed_device_only',
      openLimit: 'single_use'
    }
  });
  if (!policy.policy || !Array.isArray(policy.policy.allowedRoles)) {
    throw new Error('policy recommendation did not return allowed roles');
  }

  const created = await mcpCall('create_sealed_package', {
    fileName: 'Synthetic_Internal_Demo.txt',
    senderRole: 'engineering',
    policy: policy.policy,
    ciphertext: 'smoke-ciphertext-only',
    iv: 'smoke-iv',
    salt: 'smoke-salt',
    packageHash: `smoke-${Date.now()}`
  });
  if (!created.packageId || !created.sealedLink) {
    throw new Error('MCP package creation did not return id and sealed link');
  }

  const route = await mcpCall('route_package', {
    packageId: created.packageId,
    channel: 'cross_region_relay',
    endpoint: 'demo-managed-edge-endpoint',
    regionHint: 'global'
  });
  if (route.receipt?.status !== 'SENT' || route.receipt?.channel !== 'cross_region_relay') {
    throw new Error('MCP route_package did not return cross-region SENT receipt');
  }

  const receipt = await mcpCall('check_endpoint_receipt', {
    packageId: created.packageId
  });
  if (receipt.latestReceipt?.id !== route.receipt.id) {
    throw new Error('MCP check_endpoint_receipt did not return latest route receipt');
  }

  const emailDraft = await mcpCall('prepare_email_delivery', {
    packageId: created.packageId,
    recipientLabel: 'demo-global-recipient',
    baseUrl
  });
  const outboundEmailText = `${emailDraft.draft.subject}\n${emailDraft.draft.body}\n${emailDraft.draft.sealedLink}`.toLowerCase();
  for (const forbidden of ['smoke-ciphertext', 'content key', 'encryption key', 'decryption key', '"iv"', '"salt"', 'raw payload']) {
    if (outboundEmailText.includes(forbidden)) {
      throw new Error(`dry-run email contains forbidden material: ${forbidden}`);
    }
  }
  if (emailDraft.draft.mode !== 'dry_run_only' || emailDraft.draft.safetyChecks.sendsEmail !== false) {
    throw new Error('dry-run email adapter attempted to send or did not mark dry-run mode');
  }

  const denied = await postJson(`/api/packages/${created.packageId}/verify`, {
    credential: 'not-a-valid-credential'
  });
  if (denied.result !== 'DENY') {
    throw new Error('invalid credential decode should be denied');
  }

  const marketingCredential = await mcpCall('issue_timed_credential', {
    packageId: created.packageId,
    role: 'marketing',
    deviceClaim: 'personal-phone'
  });
  const deniedByPolicy = await postJson(`/api/packages/${created.packageId}/verify`, {
    credential: marketingCredential.credential.token
  });
  if (deniedByPolicy.result !== 'DENY') {
    throw new Error('unauthorized marketing credential should be denied by policy');
  }

  const fallback = await mcpCall('read_fallback_status', {
    packageId: created.packageId
  });
  if (fallback.fallback?.status !== 'DENIED') {
    throw new Error('MCP read_fallback_status did not return latest denied state');
  }

  const accessCredential = await mcpCall('issue_timed_credential', {
    packageId: created.packageId,
    role: policy.policy.allowedRoles[0],
    deviceClaim: 'managed-laptop'
  });
  if (!accessCredential.credential?.claims?.policyHash || !accessCredential.credential?.token) {
    throw new Error('timed credential did not include policy hash and signed token');
  }

  const allowed = await postJson(`/api/packages/${created.packageId}/verify`, {
    credential: accessCredential.credential.token
  });
  if (allowed.result !== 'ALLOW' || !allowed.package.ciphertext) {
    throw new Error('authorized signed credential should return ciphertext for local decrypt');
  }

  const auditResponse = await fetch(`${baseUrl}/api/audit`);
  const audit = await auditResponse.json();
  const matchingEvents = audit.events.filter(event => event.packageId === created.packageId);
  if (matchingEvents.length < 5) {
    throw new Error('audit log did not record package create, credential, deny, and allow events');
  }

  const mcpAudit = await mcpCall('read_audit_log', {
    packageId: created.packageId,
    limit: 10
  });
  if (!mcpAudit.events.some(event => event.type === 'PACKAGE_ROUTED')) {
    throw new Error('MCP read_audit_log did not include package route evidence');
  }
  if (!mcpAudit.events.some(event => event.type === 'EMAIL_DRY_RUN_PREPARED')) {
    throw new Error('MCP read_audit_log did not include email dry-run evidence');
  }

  console.log('smoke e2e check passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
