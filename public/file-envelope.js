import { bytesToBase64, base64ToBytes, sha256Hex, requireSecureContext } from './crypto-utils.js';

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_METADATA_BYTES = 2048;
const formats = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  csv: 'text/csv'
};
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const reject = () => { throw new Error('INVALID_FILE_ENVELOPE'); };

function fileMetadata(name, size) {
  if (typeof name !== 'string' || encoder.encode(name).length > 255 ||
      /[\x00-\x1f\x7f/\\]/.test(name) || !Number.isSafeInteger(size) || size < 1 || size > MAX_FILE_BYTES) reject();
  const extension = name.split('.').at(-1).toLowerCase();
  if (!formats[extension]) reject();
  return { name, type: formats[extension], size };
}

function aad(context) {
  if (typeof context !== 'string' || !/^[a-f0-9-]{36}$/.test(context)) reject();
  return encoder.encode(JSON.stringify(['edge-file-v1', 'AES-256-GCM', context]));
}

function strictBase64(value, minimum, maximum) {
  if (typeof value !== 'string' || value.length > 4 * Math.ceil(maximum / 3) ||
      value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) reject();
  const bytes = base64ToBytes(value);
  if (bytes.length < minimum || bytes.length > maximum || bytesToBase64(bytes) !== value) reject();
  return bytes;
}

export async function sealFileBytes(bytes, name, context = crypto.randomUUID()) {
  if (!(bytes instanceof Uint8Array)) reject();
  const metadata = encoder.encode(JSON.stringify(fileMetadata(name, bytes.byteLength)));
  if (metadata.length > MAX_METADATA_BYTES) reject();
  const framed = new Uint8Array(4 + metadata.length + bytes.length);
  new DataView(framed.buffer).setUint32(0, metadata.length, false);
  framed.set(metadata, 4);
  framed.set(bytes, 4 + metadata.length);
  const key = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  try {
    requireSecureContext();
    const cryptoKey = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128, additionalData: aad(context) }, cryptoKey, framed);
    const packet = { version: 1, algorithm: 'AES-256-GCM', context, iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(encrypted)) };
    return { packet, key, commitment: await packetCommitment(packet) };
  } catch (error) {
    key.fill(0);
    throw error;
  } finally { framed.fill(0); }
}

export async function packetCommitment(packet) {
  validatePacket(packet);
  return sha256Hex(JSON.stringify([packet.version, packet.algorithm, packet.context, packet.iv, packet.ciphertext]));
}

export function validatePacket(packet) {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet) ||
      Object.keys(packet).sort().join(',') !== 'algorithm,ciphertext,context,iv,version' ||
      packet.version !== 1 || packet.algorithm !== 'AES-256-GCM') reject();
  aad(packet.context);
  strictBase64(packet.iv, 12, 12);
  strictBase64(packet.ciphertext, 21, MAX_FILE_BYTES + MAX_METADATA_BYTES + 4 + 16);
  return true;
}

export async function openFileBytes(packet, keyBytes) {
  validatePacket(packet);
  if (!(keyBytes instanceof Uint8Array) || keyBytes.length !== 32) reject();
  requireSecureContext();
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  const result = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(packet.iv),
    tagLength: 128, additionalData: aad(packet.context) }, key, base64ToBytes(packet.ciphertext));
  const framed = new Uint8Array(result);
  try {
    if (framed.length < 5) reject();
    const length = new DataView(result).getUint32(0, false);
    if (length < 1 || length > MAX_METADATA_BYTES || length + 4 >= framed.length) reject();
    const metadata = JSON.parse(decoder.decode(framed.subarray(4, 4 + length)));
    const expected = fileMetadata(metadata.name, framed.length - 4 - length);
    if (Object.keys(metadata).sort().join(',') !== 'name,size,type' || metadata.type !== expected.type || metadata.size !== expected.size) reject();
    return { ...expected, bytes: framed.slice(4 + length) };
  } finally { framed.fill(0); }
}
