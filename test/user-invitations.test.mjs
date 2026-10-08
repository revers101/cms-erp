// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { AuthStore } from '../src/auth.mjs';

const directories = new Set();
const stores = new Set();
afterEach(async () => {
  for (const store of stores) store.close();
  stores.clear();
  await Promise.all([...directories].map((directory) => rm(directory, { recursive: true, force: true })));
  directories.clear();
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cms-erp-invitations-'));
  directories.add(directory);
  const database = path.join(directory, 'auth.sqlite');
  const store = new AuthStore(database);
  stores.add(store);
  store.bootstrapAdmin('admin@example.test', 'test-only-admin-password-123');
  const admin = store.authenticate('admin@example.test', 'test-only-admin-password-123').actor;
  return { store, admin, database };
}

function token() { return randomBytes(32).toString('base64url'); }

test('invitation is delivered only after activation, stored as a digest, and accepted once', async () => {
  const f = await fixture();
  const firstToken = token();
  const first = f.store.createInvitation(f.admin, 'invite-idempotency-001', {
    email: ' New.User@Example.Test ', role: 'editor', token: firstToken,
  });
  assert.equal(first.data.email, 'new.user@example.test');
  assert.equal(first.data.role, 'editor');
  assert.equal(first.data.expiresAt > Date.now(), true);
  assert.equal(f.store.listInvitations().length, 0);
  const database = new DatabaseSync(f.database);
  const stored = database.prepare('SELECT token_hash FROM app_user_invitations WHERE id=?').get(first.data.id);
  assert.notEqual(stored.token_hash, firstToken);
  assert.equal(stored.token_hash.length, 64);
  database.close();

  assert.equal(f.store.activateInvitation(firstToken), true);
  assert.equal(f.store.listInvitations().length, 1);
  const duplicate = f.store.createInvitation(f.admin, 'invite-idempotency-001', {
    email: 'new.user@example.test', role: 'editor', token: token(),
  });
  assert.equal(duplicate.data.alreadyCreated, true);
  assert.equal(Object.hasOwn(duplicate.data, 'token'), false);

  const replacementToken = token();
  const replacement = f.store.createInvitation(f.admin, 'invite-idempotency-002', {
    email: 'new.user@example.test', role: 'finance', token: replacementToken,
  });
  assert.equal(f.store.activateInvitation(replacementToken), true);
  assert.equal(f.store.acceptInvitation(firstToken, 'test-only-user-password-1234').error, 'INVALID_OR_EXPIRED_INVITATION');
  assert.equal(f.store.listInvitations().length, 1);

  const accepted = f.store.acceptInvitation(replacementToken, 'test-only-user-password-1234');
  assert.deepEqual({ email: accepted.data.email, role: accepted.data.role, active: accepted.data.active }, {
    email: 'new.user@example.test', role: 'finance', active: 1,
  });
  assert.equal(f.store.authenticate('new.user@example.test', 'test-only-user-password-1234').actor.role, 'finance');
  assert.equal(f.store.acceptInvitation(replacementToken, 'test-only-user-password-1234').error, 'INVALID_OR_EXPIRED_INVITATION');
  assert.equal(f.store.listInvitations().length, 0);
});

test('invitation rejects non-admin actors, mismatched idempotency, bad tokens, and undelivered invitations', async () => {
  const f = await fixture();
  const user = f.store.createUser(f.admin, 'invite-user-seed-001', {
    email: 'reader@example.test', password: 'test-only-reader-password-1234', role: 'reader',
  }).data;
  assert.equal(f.store.createInvitation(user, 'invite-idempotency-003', {
    email: 'other@example.test', role: 'reader', token: token(),
  }).error, 'FORBIDDEN');

  const originalToken = token();
  f.store.createInvitation(f.admin, 'invite-idempotency-004', {
    email: 'other@example.test', role: 'reader', token: originalToken,
  });
  assert.equal(f.store.createInvitation(f.admin, 'invite-idempotency-004', {
    email: 'different@example.test', role: 'reader', token: token(),
  }).error, 'IDEMPOTENCY_CONFLICT');
  assert.equal(f.store.acceptInvitation(originalToken, 'test-only-other-password-1234').error, 'INVALID_OR_EXPIRED_INVITATION');
  assert.equal(f.store.activateInvitation(originalToken), true);
  assert.equal(f.store.discardPendingInvitation(originalToken), false);

  const failedDeliveryToken = token();
  f.store.createInvitation(f.admin, 'invite-idempotency-005', {
    email: 'failed@example.test', role: 'reader', token: failedDeliveryToken,
  });
  assert.equal(f.store.discardPendingInvitation(failedDeliveryToken), true);
  assert.equal(f.store.activateInvitation(failedDeliveryToken), false);
  assert.equal(f.store.acceptInvitation(failedDeliveryToken, 'test-only-other-password-1234').error, 'INVALID_OR_EXPIRED_INVITATION');
});

test('expired invitations cannot be accepted and do not appear in the pending list', async () => {
  const f = await fixture();
  const invitationToken = token();
  const invitation = f.store.createInvitation(f.admin, 'invite-idempotency-006', {
    email: 'expired@example.test', role: 'reader', token: invitationToken,
  });
  assert.equal(f.store.activateInvitation(invitationToken), true);
  const database = new DatabaseSync(f.database);
  database.prepare('UPDATE app_user_invitations SET expires_at=? WHERE id=?').run(Date.now() - 1, invitation.data.id);
  database.close();
  assert.equal(f.store.listInvitations().length, 0);
  assert.equal(f.store.acceptInvitation(invitationToken, 'test-only-expired-password-1234').error, 'INVALID_OR_EXPIRED_INVITATION');
});

test('admin can revoke a pending invitation with durable idempotent audit', async () => {
  const f = await fixture();
  const invitationToken = token();
  const invitation = f.store.createInvitation(f.admin, 'invite-idempotency-007', {
    email: 'revoke@example.test', role: 'reader', token: invitationToken,
  });
  assert.equal(f.store.activateInvitation(invitationToken), true);
  const revoked = f.store.revokeInvitation(f.admin, 'invite-revoke-idempotency-001', invitation.data.id);
  assert.deepEqual(revoked.data, { id: invitation.data.id, email: 'revoke@example.test', revoked: true });
  assert.deepEqual(f.store.revokeInvitation(f.admin, 'invite-revoke-idempotency-001', invitation.data.id), revoked);
  assert.equal(f.store.listInvitations().length, 0);
  assert.equal(f.store.acceptInvitation(invitationToken, 'test-only-revoked-password-1234').error, 'INVALID_OR_EXPIRED_INVITATION');
  assert.equal(f.store.revokeInvitation(f.admin, 'invite-revoke-idempotency-002', invitation.data.id).error, 'INVITATION_NOT_ACTIVE');
  const database = new DatabaseSync(f.database);
  const audit = database.prepare('SELECT event FROM app_user_invitation_audit ORDER BY id').all().map((row) => row.event);
  assert.deepEqual(audit, ['created', 'revoked']);
  database.close();
});
