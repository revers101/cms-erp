// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { AuthStore } from '../src/auth.mjs';

const stores = [];

async function createStore() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cms-erp-password-reset-'));
  const databasePath = path.join(directory, 'auth.sqlite');
  const store = new AuthStore(databasePath);
  store.bootstrapAdmin('admin@example.test', 'test-only-admin-password-123');
  stores.push({ directory, databasePath, store });
  return { store, databasePath };
}

afterEach(async () => {
  for (const { directory, store } of stores.splice(0)) {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('password reset is single-use, stores only a digest, audits, and revokes sessions', async () => {
  const { store, databasePath } = await createStore();
  const session = store.authenticate('admin@example.test', 'test-only-admin-password-123');
  const req = { headers: { cookie: `cms_erp_session=${session.token}` } };
  assert.ok(store.actor(req));

  const reset = store.createPasswordReset(' ADMIN@example.test ');
  assert.ok(reset);
  assert.equal(reset.email, 'admin@example.test');
  assert.match(reset.token, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(reset.expiresAt - Date.now() <= 30 * 60 * 1000, true);
  assert.deepEqual(store.completePasswordReset(reset.token, 'test-only-new-password-12345'), {
    error: 'INVALID_OR_EXPIRED_RESET',
  });
  assert.equal(store.activatePasswordReset(reset.token), true);

  const inspect = new DatabaseSync(databasePath);
  const stored = inspect.prepare('SELECT token_hash,expires_at FROM app_password_reset_tokens').get();
  assert.notEqual(stored.token_hash, reset.token);
  assert.equal(stored.expires_at, reset.expiresAt);
  inspect.close();

  assert.deepEqual(store.completePasswordReset(reset.token, 'test-only-new-password-12345'), {
    data: { passwordChanged: true },
  });
  assert.equal(store.actor(req), null);
  assert.deepEqual(store.completePasswordReset(reset.token, 'test-only-replay-password-12345'), {
    error: 'INVALID_OR_EXPIRED_RESET',
  });
  assert.equal(store.authenticate('admin@example.test', 'test-only-admin-password-123'), null);
  assert.ok(store.authenticate('admin@example.test', 'test-only-new-password-12345'));

  const audit = new DatabaseSync(databasePath);
  assert.equal(audit.prepare("SELECT count(*) AS n FROM app_auth_audit WHERE event='password_reset'").get().n, 1);
  audit.close();
});

test('reset requests do not disclose missing accounts and replacement activates only after delivery', async () => {
  const { store } = await createStore();
  assert.equal(store.createPasswordReset('missing@example.test'), null);
  const first = store.createPasswordReset('admin@example.test');
  assert.equal(store.activatePasswordReset(first.token), true);
  const second = store.createPasswordReset('admin@example.test');
  assert.ok(first && second);
  assert.equal(store.discardPendingPasswordReset(second.token), true);
  assert.deepEqual(store.completePasswordReset(first.token, 'test-only-new-password-12345'), {
    data: { passwordChanged: true },
  });
});

test('delivered replacement preserves prior links until expiry; successful reset invalidates all', async () => {
  const { store } = await createStore();
  const first = store.createPasswordReset('admin@example.test');
  assert.equal(store.activatePasswordReset(first.token), true);
  const second = store.createPasswordReset('admin@example.test');
  assert.ok(second);
  assert.equal(store.activatePasswordReset(second.token), true);
  assert.deepEqual(store.completePasswordReset(first.token, 'test-only-new-password-12345'), {
    data: { passwordChanged: true },
  });
  assert.deepEqual(store.completePasswordReset(second.token, 'short'), { error: 'INVALID_NEW_PASSWORD' });
  assert.deepEqual(store.completePasswordReset(second.token, 'test-only-replay-password-12345'), {
    error: 'INVALID_OR_EXPIRED_RESET',
  });
});

test('rate limits persist in the shared SQLite database and roll back all buckets on denial', async () => {
  const { store, databasePath } = await createStore();
  const secondStore = new AuthStore(databasePath);
  const bucket = [{ key: 'reset:test:email:admin@example.test', limit: 1, windowMs: 60_000 }];
  assert.equal(store.consumeRateLimits(bucket), true);
  assert.equal(secondStore.consumeRateLimits(bucket), false);
  assert.equal(store.consumeRateLimits([
    { key: 'reset:test:ip:127.0.0.1', limit: 1, windowMs: 60_000 },
    bucket[0],
  ]), false);
  assert.equal(store.consumeRateLimits([{ key: 'reset:test:ip:127.0.0.1', limit: 1, windowMs: 60_000 }]), true);
  secondStore.close();
});

test('rate-limit bucket storage has a hard cardinality cap', async () => {
  const { store, databasePath } = await createStore();
  const database = new DatabaseSync(databasePath);
  database.exec('BEGIN');
  const insert = database.prepare('INSERT INTO app_auth_rate_limits(bucket_hash,window_started_at,expires_at,attempts) VALUES(?,?,?,1)');
  for (let index = 0; index < 10_000; index += 1) insert.run(`bucket-${index}`, Date.now(), Date.now() + 60_000);
  database.exec('COMMIT');
  database.close();
  assert.equal(store.consumeRateLimits([{ key: 'another-unique-bucket', limit: 1, windowMs: 60_000 }]), false);
  const verify = new DatabaseSync(databasePath);
  assert.equal(verify.prepare('SELECT count(*) AS count FROM app_auth_rate_limits').get().count, 10_000);
  verify.prepare('UPDATE app_auth_rate_limits SET expires_at=?').run(Date.now() - 1);
  verify.close();
  assert.equal(store.consumeRateLimits([{ key: 'recovered-after-expiry', limit: 1, windowMs: 60_000 }]), true);
  const afterExpiry = new DatabaseSync(databasePath);
  assert.equal(afterExpiry.prepare('SELECT count(*) AS count FROM app_auth_rate_limits').get().count, 1);
  afterExpiry.close();
});
