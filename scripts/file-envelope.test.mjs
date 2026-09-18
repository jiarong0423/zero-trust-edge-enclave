import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sealFileBytes, openFileBytes, packetCommitment, MAX_FILE_BYTES } from '../public/file-envelope.js';

test('binary envelope preserves every byte and protects private metadata independently of text decoding', async () => {
  // Arbitrary bytes verify transport, not conformance to any document format.
  const bytes = new Uint8Array(Array.from({ length: 4096 }, (_, index) => index % 256));
  const hash = value => createHash('sha256').update(value).digest('hex');
  for (const extension of ['docx', 'pdf', 'csv']) {
    const name = `PRIVATE_TEST.${extension}`;
    const first = await sealFileBytes(bytes, name);
    const second = await sealFileBytes(bytes, name);
    assert.notDeepEqual(first.key, second.key);
    assert.notDeepEqual(first.packet, second.packet);
    assert.equal(first.commitment, await packetCommitment(first.packet));
    assert.ok(!JSON.stringify(first.packet).includes('PRIVATE_TEST'));
    const opened = await openFileBytes(first.packet, first.key);
    assert.equal(opened.name, name);
    assert.equal(opened.size, bytes.length);
    assert.equal(hash(opened.bytes), hash(bytes));
    assert.deepEqual(opened.bytes, bytes);
    await assert.rejects(openFileBytes(first.packet, second.key));
    for (const mutate of [
      packet => packet.context = crypto.randomUUID(),
      packet => packet.iv = 'AAAAAAAAAAAAAAAA',
      packet => packet.ciphertext = (packet.ciphertext[0] === 'A' ? 'B' : 'A') + packet.ciphertext.slice(1),
      packet => packet.version = 2,
      packet => packet.fileName = 'unexpected'
    ]) {
      const bad = structuredClone(first.packet);
      mutate(bad);
      await assert.rejects(openFileBytes(bad, first.key));
    }
    first.key.fill(0);
    second.key.fill(0);
  }
  await assert.rejects(sealFileBytes(new Uint8Array(MAX_FILE_BYTES + 1), 'large.pdf'));
  await assert.rejects(sealFileBytes(new Uint8Array(), 'empty.csv'));
  await assert.rejects(sealFileBytes(bytes, '../bad.pdf'));
  await assert.rejects(sealFileBytes(bytes, 'bad.exe'));
});

test('maximum-size binary file remains within envelope bounds', async () => {
  const bytes = new Uint8Array(MAX_FILE_BYTES);
  bytes[0] = 255;
  bytes[bytes.length - 1] = 128;
  const sealed = await sealFileBytes(bytes, 'boundary.pdf');
  const opened = await openFileBytes(sealed.packet, sealed.key);
  assert.deepEqual(opened.bytes, bytes);
  sealed.key.fill(0);
});
