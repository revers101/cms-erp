// SPDX-License-Identifier: GPL-3.0-or-later
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const periodSeconds = 30;
const digits = 6;

export function encodeBase32(value) {
  const bytes = Buffer.from(value);
  let bits = 0;
  let buffer = 0;
  let output = '';
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += alphabet[(buffer >>> bits) & 31];
      buffer &= (1 << bits) - 1;
    }
  }
  if (bits) output += alphabet[(buffer << (5 - bits)) & 31];
  return output;
}

export function decodeBase32(value) {
  if (typeof value !== 'string' || !/^[A-Z2-7]+$/u.test(value)) throw new TypeError('Invalid base32 secret');
  let bits = 0;
  let buffer = 0;
  const output = [];
  for (const character of value) {
    buffer = (buffer << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((buffer >>> bits) & 255);
      buffer &= (1 << bits) - 1;
    }
  }
  if (bits && buffer !== 0) throw new TypeError('Invalid base32 secret padding');
  return Buffer.from(output);
}

export function createTotpSecret() {
  return encodeBase32(randomBytes(20));
}

export function totpCode(secret, timestampMs = Date.now()) {
  const key = typeof secret === 'string' ? decodeBase32(secret) : Buffer.from(secret);
  if (key.length < 16 || !Number.isFinite(timestampMs) || timestampMs < 0) throw new TypeError('Invalid TOTP input');
  const step = Math.floor(timestampMs / (periodSeconds * 1000));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % (10 ** digits)).padStart(digits, '0');
}

export function matchingTotpStep(secret, code, timestampMs = Date.now(), lastAcceptedStep = -1) {
  if (typeof code !== 'string' || !/^\d{6}$/u.test(code) || !Number.isSafeInteger(lastAcceptedStep)) return null;
  const supplied = Buffer.from(code, 'ascii');
  const currentStep = Math.floor(timestampMs / (periodSeconds * 1000));
  let matched = null;
  for (const step of [currentStep - 1, currentStep, currentStep + 1]) {
    if (step <= lastAcceptedStep || step < 0) continue;
    const expected = Buffer.from(totpCode(secret, step * periodSeconds * 1000), 'ascii');
    if (timingSafeEqual(expected, supplied)) matched = step;
  }
  return matched;
}
