// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
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
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cms-erp-auth0-link-'));
  directories.add(directory);
  const store = new AuthStore(path.join(directory, 'auth.sqlite'));
  stores.add(store);
  store.bootstrapAdmin('admin@example.test', 'test-only-admin-password-123');
  const admin = store.authenticate('admin@example.test', 'test-only-admin-password-123').actor;
  const user = store.createUser(admin, 'auth0-user-create-01', {
    email: 'user@example.test', password: 'test-only-user-password-1234', role: 'editor',
  }).data;
  return { store, admin, user };
}

test('Auth0 link challenge is one-use, identity-bound, and does not match by email', async () => {
  const f = await fixture();
  const issuer = 'https://cai-test.eu.auth0.com/';
  const subject = 'auth0|synthetic-user';
  const code = 'test-link-code-012345678901234567890123456789012345';

  assert.equal(f.store.actorForExternalIdentity(issuer, subject), null);
  const challenge = f.store.createAuth0LinkChallenge(f.admin, 'auth0-challenge-001', f.user.id, code);
  assert.equal(challenge.data.challengeCreated, true);
  assert.equal(challenge.data.userId, f.user.id);
  assert.equal(Object.hasOwn(challenge.data, 'code'), false);
  assert.equal(f.store.actorForExternalIdentity(issuer, subject), null);

  const linked = f.store.completeAuth0IdentityLink(issuer, subject, code);
  assert.deepEqual(linked.data, { userId: f.user.id, linked: true, role: 'editor' });
  assert.deepEqual(f.store.actorForExternalIdentity(issuer, subject), { id: f.user.id, email: 'user@example.test', role: 'editor' });
  assert.equal(f.store.actorForExternalIdentity(issuer, 'different-subject'), null);
  assert.equal(f.store.completeAuth0IdentityLink(issuer, subject, code).error, 'LINK_CHALLENGE_INVALID');
});

test('an Auth0 subject cannot be linked to a second local user', async () => {
  const f = await fixture();
  const second = f.store.createUser(f.admin, 'auth0-user-create-02', {
    email: 'second@example.test', password: 'test-only-second-password-1234', role: 'finance',
  }).data;
  const issuer = 'https://cai-test.eu.auth0.com/';
  const subject = 'auth0|same-user';
  const firstCode = 'first-link-code-01234567890123456789012345678901';
  const secondCode = 'second-link-code-0123456789012345678901234567890';
  assert.equal(f.store.createAuth0LinkChallenge(f.admin, 'auth0-challenge-101', f.user.id, firstCode).data.challengeCreated, true);
  assert.equal(f.store.completeAuth0IdentityLink(issuer, subject, firstCode).data.linked, true);
  assert.equal(f.store.createAuth0LinkChallenge(f.admin, 'auth0-challenge-102', second.id, secondCode).data.challengeCreated, true);
  assert.equal(f.store.completeAuth0IdentityLink(issuer, subject, secondCode).error, 'IDENTITY_IN_USE');
  assert.equal(f.store.actorForExternalIdentity(issuer, subject).id, f.user.id);
});
