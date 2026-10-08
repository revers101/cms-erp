// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTotpSecret, decodeBase32, encodeBase32, matchingTotpStep, totpCode } from '../src/totp.mjs';

test('base32 round-trips random TOTP secrets without padding', () => {
  const secret = createTotpSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/u);
  assert.equal(encodeBase32(decodeBase32(secret)), secret);
});

test('TOTP follows the RFC 6238 SHA-1 test vector and rejects malformed input', () => {
  const secret = encodeBase32(Buffer.from('12345678901234567890', 'ascii'));
  assert.equal(totpCode(secret, 59_000), '287082');
  assert.throws(() => decodeBase32('ABC0'), /base32/u);
  assert.equal(matchingTotpStep(secret, 'bad-code', 59_000), null);
});

test('TOTP accepts a one-step clock skew and rejects reuse of an accepted step', () => {
  const secret = createTotpSecret();
  const now = 1_800_000_000_000;
  const priorStepCode = totpCode(secret, now - 30_000);
  const acceptedStep = matchingTotpStep(secret, priorStepCode, now, -1);
  assert.equal(acceptedStep, Math.floor(now / 30_000) - 1);
  assert.equal(matchingTotpStep(secret, priorStepCode, now, acceptedStep), null);
});
