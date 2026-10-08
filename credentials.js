import crypto from 'node:crypto';
import { base64UrlEncode, base64UrlDecode, normalizeString } from './value-helpers.js';

export function resolveTokenSigningSecret() {
  if (process.env.TOKEN_SIGNING_SECRET) {
    return process.env.TOKEN_SIGNING_SECRET;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('TOKEN_SIGNING_SECRET is required when NODE_ENV=production');
  }
  return crypto.randomBytes(32).toString('hex');
}

export function createCredentialSigner(tokenSigningSecret) {
  function signValue(value) {
    return crypto.createHmac('sha256', tokenSigningSecret).update(value).digest('base64url');
  }

  function createSignedCredential(claims) {
    const header = {
      alg: 'HS256',
      typ: 'ZTEE-TAC',
      version: '0.1'
    };
    const encodedHeader = base64UrlEncode(JSON.stringify(header));
    const encodedPayload = base64UrlEncode(JSON.stringify(claims));
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    return `${signingInput}.${signValue(signingInput)}`;
  }

  function readSignedCredential(token) {
    const parts = normalizeString(token).split('.');
    if (parts.length !== 3) {
      throw new Error('invalid credential format');
    }
    const [encodedHeader, encodedPayload, signature] = parts;
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const expected = signValue(signingInput);
    const actualBytes = Buffer.from(signature);
    const expectedBytes = Buffer.from(expected);
    if (actualBytes.length !== expectedBytes.length || !crypto.timingSafeEqual(actualBytes, expectedBytes)) {
      throw new Error('invalid credential signature');
    }
    const header = JSON.parse(base64UrlDecode(encodedHeader));
    const payload = JSON.parse(base64UrlDecode(encodedPayload));
    if (header.typ !== 'ZTEE-TAC') {
      throw new Error('invalid credential type');
    }
    return payload;
  }

  return { createSignedCredential, readSignedCredential };
}
