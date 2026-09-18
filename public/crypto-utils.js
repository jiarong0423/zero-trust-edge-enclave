// Every encrypt and decrypt path here needs Web Crypto, which browsers expose only in a secure
// context: https, or a loopback host. A phone or second machine reaching this over plain http on
// a LAN address will connect and render, then fail inside subtle with an undefined-property error
// that says nothing about the real cause. Fail early and say what is wrong instead.
export function requireSecureContext() {
  if (globalThis.crypto?.subtle) return;
  const origin = globalThis.location?.origin || 'this page';
  throw new Error('INSECURE_CONTEXT: Web Crypto is unavailable at ' + origin +
    '. Browsers expose it only over https or on a loopback address such as http://127.0.0.1. ' +
    'Open this page over https, or from the machine running the server.');
}

export function bytesToBase64(bytes) {
  let binary = '';
  bytes.forEach(byte => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

export function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export async function sha256Hex(text) {
  requireSecureContext();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function deriveKey(passphrase, saltBytes) {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: saltBytes,
      iterations: 150000,
      hash: 'SHA-256'
    },
    material,
    {
      name: 'AES-GCM',
      length: 256
    },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptText(plaintext, passphrase) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(passphrase, salt);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv
    },
    key,
    new TextEncoder().encode(plaintext)
  );
  return {
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    iv: bytesToBase64(iv),
    salt: bytesToBase64(salt),
    packageHash: await sha256Hex(`${bytesToBase64(new Uint8Array(ciphertext))}.${bytesToBase64(iv)}.${bytesToBase64(salt)}`)
  };
}

export async function decryptText(ciphertextBase64, ivBase64, saltBase64, passphrase) {
  const key = await deriveKey(passphrase, base64ToBytes(saltBase64));
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: base64ToBytes(ivBase64)
    },
    key,
    base64ToBytes(ciphertextBase64)
  );
  return new TextDecoder().decode(plaintext);
}
