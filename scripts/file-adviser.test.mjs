import test from 'node:test';
import assert from 'node:assert/strict';
import { requestFileAdvice } from '../file-adviser.js';

test('provider diagnostics classify phases without raw private errors or responses', async () => {
  const input = { taskAlias: '12345678-1234-4234-8234-123456789012', snapshotVersion: 1,
    channels: ['email'], state: 'PENDING_CHECK', attempts: 0 };
  const options = { provider: 'nebius', localOnly: false, baseUrl: 'https://api.tokenfactory.nebius.com/v1',
    apiKey: 'PRIVATE_CANARY', model: 'nvidia/test' };
  for (const [code, stage, mock] of [
    ['TRANSPORT_ERROR', 'HEADERS', async () => { throw Error('PRIVATE_CANARY'); }],
    ['TIMEOUT', 'HEADERS', async () => { throw new DOMException('PRIVATE_CANARY', 'TimeoutError'); }],
    ['HTTP_ERROR', 'BODY', async () => new Response('PRIVATE_CANARY', { status: 503 })],
    ['PARSE_ERROR', 'ENVELOPE_PARSE', async () => new Response('PRIVATE_CANARY')],
    ['PARSE_ERROR', 'ADVICE_PARSE', async () => Response.json({ choices: [{ message: { content: 'PRIVATE_CANARY' } }] })],
    ['ADVICE_REJECTED', 'VALIDATION', async () => Response.json({ choices: [{ message: { content: '{"private":"PRIVATE_CANARY"}' } }] })],
    ['RESPONSE_TOO_LARGE', 'BODY', async () => new Response('x'.repeat(16385))]
  ]) {
    let diagnostic;
    await assert.rejects(requestFileAdvice(input, { ...options, onDiagnostics: value => { diagnostic = value; } }, mock));
    assert.equal(diagnostic.code, code);
    assert.equal(diagnostic.stage, stage);
    assert.ok(diagnostic.totalMs >= 0);
    assert.ok(!JSON.stringify(diagnostic).includes('PRIVATE_CANARY'));
    assert.ok(!JSON.stringify(diagnostic).includes(input.taskAlias));
  }
});

test('file adviser forbids private fields and local-mode cloud calls, validates provider response', async () => {
  const metadata = { taskAlias: '12345678-1234-4234-8234-123456789012', snapshotVersion: 1,
    channels: ['internal_queue', 'email'], state: 'RETRY_WAIT', attempts: 1 };
  const options = { provider: 'nebius', localOnly: false, baseUrl: 'https://api.tokenfactory.nebius.com/v1',
    apiKey: 'SYNTHETIC_TEST_ONLY', model: 'nvidia/test-fixture' };
  let calls = 0;
  const mock = async (url, request) => {
    calls++;
    assert.equal(url.href, 'https://api.tokenfactory.nebius.com/v1/chat/completions');
    assert.equal(request.redirect, 'error');
    const payload = JSON.parse(request.body);
    assert.deepEqual(payload.response_format, { type: 'json_object' });
    assert.equal(payload.chat_template_kwargs.enable_thinking, false);
    assert.deepEqual(JSON.parse(payload.messages[1].content), metadata);
    assert.ok(!request.body.includes(options.apiKey));
    return Response.json({ choices: [{ message: { content: JSON.stringify({ taskAlias: metadata.taskAlias,
      snapshotVersion: 1, action: 'ROUTE', channel: 'email', reasonCode: 'RETRY_ALTERNATIVE' }) } }] });
  };
  await assert.rejects(requestFileAdvice(metadata, { ...options, localOnly: true }, mock));
  await assert.rejects(requestFileAdvice({ ...metadata, plaintext: 'PRIVATE_CANARY' }, options, mock));
  await assert.rejects(requestFileAdvice(metadata, { ...options, baseUrl: 'https://unapproved.invalid/v1' }, mock));
  assert.equal(calls, 0);
  const answer = await requestFileAdvice(metadata, options, mock);
  assert.equal(answer.provider, 'nebius_token_factory');
  assert.equal(answer.advice.channel, 'email');
  assert.equal(calls, 1);
  for (const content of ['not json', JSON.stringify({ channel: 'external' })]) {
    await assert.rejects(requestFileAdvice(metadata, options,
      async () => Response.json({ choices: [{ message: { content } }] })));
  }
  await assert.rejects(requestFileAdvice(metadata, options, async () => new Response('x'.repeat(16385))));
  await assert.rejects(requestFileAdvice(metadata, options, async () => { throw new Error('PRIVATE_PROVIDER_ERROR'); }),
    error => error.message === 'FILE_PROVIDER_RESPONSE_REJECTED');
});
