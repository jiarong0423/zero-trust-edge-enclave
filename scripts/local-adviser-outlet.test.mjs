import test from 'node:test';
import assert from 'node:assert/strict';
import { requestFileAdvice } from '../file-adviser.js';

const metadata = {
  taskAlias: '0b0c3c96-1a2b-4c3d-8e4f-5a6b7c8d9e0f',
  snapshotVersion: 1,
  channels: ['email', 'internal_queue'],
  state: 'PENDING_CHECK',
  attempts: 0,
};

const localOutlet = {
  provider: 'local_openai_compatible',
  baseUrl: 'http://127.0.0.1:1234/v1',
  model: 'nvidia-nemotron-3-nano-4b',
  localOnly: true,
};

// A stub outlet: these cases assert the contract and the endpoint rule, not a live model.
function stubRequest(body, { seen } = {}) {
  return async (url, init) => {
    if (seen) {
      seen.url = String(url);
      seen.headers = init.headers;
      seen.body = JSON.parse(init.body);
    }
    return new Response(
      JSON.stringify({ model: localOutlet.model, choices: [{ message: { content: JSON.stringify(body) } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
}

const validAdvice = {
  taskAlias: metadata.taskAlias,
  snapshotVersion: metadata.snapshotVersion,
  action: 'ROUTE',
  channel: 'email',
  reasonCode: 'APPROVED_CHANNEL',
};

test('loopback outlet is labelled separately and is not blocked by LOCAL_ONLY', async () => {
  const seen = {};
  const result = await requestFileAdvice(metadata, localOutlet, stubRequest(validAdvice, { seen }));

  assert.equal(result.provider, 'local_openai_compatible');
  assert.deepEqual(result.advice, validAdvice);
  assert.equal(seen.url, 'http://127.0.0.1:1234/v1/chat/completions');
  assert.equal(seen.headers.authorization, undefined, 'no bearer token is sent to a local outlet');
});

test('the local outlet receives the same five-field projection and nothing else', async () => {
  const seen = {};
  await requestFileAdvice(metadata, localOutlet, stubRequest(validAdvice, { seen }));

  const user = seen.body.messages.find(message => message.role === 'user');
  assert.deepEqual(
    Object.keys(JSON.parse(user.content)).sort(),
    ['attempts', 'channels', 'snapshotVersion', 'state', 'taskAlias'],
  );
});

test('a non-loopback host is refused even when it claims the local provider', async () => {
  for (const baseUrl of [
    'https://api.tokenfactory.nebius.com/v1',
    'http://169.254.169.254/v1',
    'https://localhost.evil.example/v1',
  ]) {
    await assert.rejects(
      () => requestFileAdvice(metadata, { ...localOutlet, baseUrl }, stubRequest(validAdvice)),
      error => error.status === 503,
      baseUrl,
    );
  }
});

test('an external outlet stays blocked while LOCAL_ONLY is set', async () => {
  await assert.rejects(
    () => requestFileAdvice(metadata, {
      provider: 'nebius',
      baseUrl: 'https://api.tokenfactory.nebius.com/v1',
      model: 'nvidia/nemotron-3-super-120b-a12b',
      apiKey: 'unused-in-this-test',
      localOnly: true,
    }, stubRequest(validAdvice)),
    error => error.status === 503,
  );
});

test('a local outlet cannot widen the contract: malformed advice is still rejected', async () => {
  for (const bad of [
    { ...validAdvice, action: 'SEND' },
    { ...validAdvice, channel: 'sms' },
    { ...validAdvice, reasonCode: 'LOOKS_FINE' },
    { ...validAdvice, snapshotVersion: 2 },
    { ...validAdvice, extra: true },
  ]) {
    await assert.rejects(
      () => requestFileAdvice(metadata, localOutlet, stubRequest(bad)),
      error => error.status === 422,
      JSON.stringify(bad),
    );
  }
});

test('the server wires each outlet to its own endpoint and never lends the cloud key to loopback', async () => {
  // Mirrors fileAdviser() in server.js: the outlet decides the endpoint, the model and whether a
  // credential travels at all. Passing the cloud endpoint to the loopback outlet — which is what
  // the server did before this was wired — fails the loopback rule and disables local inference.
  const pick = provider => provider === 'local_openai_compatible'
    ? { baseUrl: 'http://127.0.0.1:1234/v1', model: 'nvidia-nemotron-3-nano-4b' }
    : { baseUrl: 'https://api.tokenfactory.nebius.com/v1', model: 'nvidia/nemotron-3-super-120b-a12b', apiKey: 'synthetic-test-only' };

  const seen = {};
  const advice = { taskAlias: metadata.taskAlias, snapshotVersion: 1, action: 'ROUTE', channel: 'email', reasonCode: 'APPROVED_CHANNEL' };
  const spy = async (url, init) => {
    seen.url = String(url);
    seen.authorization = init.headers.authorization;
    return Response.json({ choices: [{ message: { content: JSON.stringify(advice) } }] });
  };

  const local = await requestFileAdvice(metadata, { provider: 'local_openai_compatible', localOnly: true, ...pick('local_openai_compatible') }, spy);
  assert.equal(local.provider, 'local_openai_compatible');
  assert.equal(seen.url, 'http://127.0.0.1:1234/v1/chat/completions');
  assert.equal(seen.authorization, undefined, 'a loopback endpoint must never receive the cloud credential');

  const cloud = await requestFileAdvice(metadata, { provider: 'nebius', localOnly: false, ...pick('nebius') }, spy);
  assert.equal(cloud.provider, 'nebius_token_factory');
  assert.equal(seen.url, 'https://api.tokenfactory.nebius.com/v1/chat/completions');
  assert.ok(seen.authorization.startsWith('Bearer '));

  // The regression itself: the cloud endpoint handed to the loopback outlet must stay refused.
  await assert.rejects(
    requestFileAdvice(metadata, { provider: 'local_openai_compatible', localOnly: true, ...pick('nebius') }, spy),
    /FILE_PROVIDER_UNAVAILABLE/);
});

test('the local outlet asks for no reasoning and greedy decoding under the schema', async () => {
  // On LM Studio's llama.cpp 2.41.0 the schema alone no longer suppresses reasoning (8 to 27 s);
  // these two fields restore the 2 to 3 s answer the recorded runs relied on.
  const seen = {};
  await requestFileAdvice(metadata, localOutlet, stubRequest(validAdvice, { seen }));
  assert.equal(seen.body.reasoning_effort, 'none');
  assert.equal(seen.body.temperature, 0);
  assert.equal(seen.body.response_format.type, 'json_schema');
  assert.equal(seen.body.chat_template_kwargs, undefined);
});
