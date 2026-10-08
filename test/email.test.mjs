// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createResendEmailSender } from '../src/email.mjs';

test('Resend password reset sender uses the private bearer credential and a bounded same-site link', async () => {
  let captured;
  const send = createResendEmailSender({
    apiKey: 'test-only-key',
    from: 'CAI Test <noreply@example.test>',
    origin: 'https://cms.example.test',
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  const token = 'x'.repeat(43);
  await send({ to: 'user@example.test', url: `https://cms.example.test/password-reset#token=${token}` });
  assert.equal(captured.url, 'https://api.resend.com/emails');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers.Authorization, 'Bearer test-only-key');
  assert.equal(captured.init.signal instanceof AbortSignal, true);
  const payload = JSON.parse(captured.init.body);
  assert.equal(payload.to[0], 'user@example.test');
  assert.match(payload.text, /https:\/\/cms\.example\.test\/password-reset#token=x{43}/u);
  assert.equal(payload.html.includes(token), true);
});

test('Resend sender refuses insecure reset links and does not accept partial configuration', async () => {
  assert.throws(() => createResendEmailSender({ apiKey: '', from: '' }));
  const send = createResendEmailSender({ apiKey: 'test-only-key', from: 'noreply@example.test', origin: 'https://cms.example.test', fetchImpl: async () => new Response(null, { status: 503 }) });
  const token = 'x'.repeat(43);
  await assert.rejects(send({ to: 'user@example.test', url: `http://cms.example.test/password-reset#token=${token}` }), /INVALID_PASSWORD_RESET_URL/u);
  await assert.rejects(send({ to: 'user@example.test', url: `https://other.example.test/password-reset#token=${token}` }), /INVALID_PASSWORD_RESET_URL/u);
  await assert.rejects(send({ to: 'user@example.test', url: `https://cms.example.test/password-reset#token=${token}` }), /EMAIL_PROVIDER_REJECTED/u);
});

test('Resend invitation sender permits only an exact same-site one-time invitation URL', async () => {
  let captured;
  const send = createResendEmailSender({
    apiKey: 'test-only-key',
    from: 'noreply@example.test',
    origin: 'https://cms.example.test',
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return new Response('{}', { status: 200 });
    },
  });
  const token = 'i'.repeat(43);
  const link = `https://cms.example.test/invite#token=${token}`;
  await send.sendInvitation({ to: 'user@example.test', url: link });
  assert.equal(captured.url, 'https://api.resend.com/emails');
  const payload = JSON.parse(captured.init.body);
  assert.equal(payload.subject, 'Uitnodiging voor CMS/ERP');
  assert.equal(payload.to[0], 'user@example.test');
  assert.equal(payload.text.includes(link), true);
  await assert.rejects(send.sendInvitation({ to: 'user@example.test', url: `https://other.example.test/invite#token=${token}` }), /INVALID_INVITATION_URL/u);
  await assert.rejects(send.sendInvitation({ to: 'user@example.test', url: `https://cms.example.test/password-reset#token=${token}` }), /INVALID_INVITATION_URL/u);
});
