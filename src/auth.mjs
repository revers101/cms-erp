// SPDX-License-Identifier: GPL-3.0-or-later
import { DatabaseSync } from 'node:sqlite';
import {
  createCipheriv,
  createHash,
  createHmac,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { createTotpSecret, matchingTotpStep } from './totp.mjs';

const cookieName = 'cms_erp_session';
const sessionLifetimeMs = 8 * 60 * 60 * 1000;
const roles = new Set(['admin', 'editor', 'publisher', 'planner', 'technician', 'finance', 'reader']);
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

function normalizedEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && emailPattern.test(email) ? email : null;
}

function cookieValue(req) {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== cookieName) continue;
    const value = part.slice(separator + 1).trim();
    return /^[A-Za-z0-9_-]{43}$/u.test(value) ? value : null;
  }
  return null;
}

function tokenDigest(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function sessionCookie(token, { secure = false, clear = false } = {}) {
  const attributes = [
    `${cookieName}=${clear ? '' : token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
    `Max-Age=${clear ? 0 : Math.floor(sessionLifetimeMs / 1000)}`,
  ];
  return attributes.join('; ');
}

export class AuthStore {
  #db;
  #csrfSecret = randomBytes(32);
  #dummySalt = randomBytes(16);
  #dummyHash = scryptSync('invalid-password', this.#dummySalt, 64);
  #mfaEncryptionKey;

  constructor(databasePath, { mfaEncryptionKey = process.env.CMS_ERP_MFA_ENCRYPTION_KEY ?? '' } = {}) {
    if (mfaEncryptionKey && !/^[a-f0-9]{64}$/iu.test(mfaEncryptionKey)) {
      throw new Error('CMS_ERP_MFA_ENCRYPTION_KEY must be 32 bytes encoded as 64 hexadecimal characters.');
    }
    this.#mfaEncryptionKey = mfaEncryptionKey ? Buffer.from(mfaEncryptionKey, 'hex') : null;
    this.#db = new DatabaseSync(databasePath);
    this.#db.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS app_users (
        id INTEGER PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','editor','publisher','planner','technician','finance','reader')),
        active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
        created_at TEXT NOT NULL,
        auth0_issuer TEXT,
        auth0_subject TEXT,
        mfa_enabled INTEGER NOT NULL DEFAULT 0 CHECK(mfa_enabled IN (0,1)),
        mfa_secret_encrypted TEXT,
        mfa_last_step INTEGER NOT NULL DEFAULT -1
      );
      CREATE TABLE IF NOT EXISTS app_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS app_sessions_expiry ON app_sessions(expires_at);
      CREATE TABLE IF NOT EXISTS app_password_reset_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER,
        delivery_state TEXT NOT NULL DEFAULT 'pending' CHECK(delivery_state IN ('pending','active'))
      );
      CREATE INDEX IF NOT EXISTS app_password_reset_expiry ON app_password_reset_tokens(expires_at);
      CREATE TABLE IF NOT EXISTS app_auth_audit (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        event TEXT NOT NULL CHECK(event IN ('password_reset','password_changed')),
        occurred_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_auth_rate_limits (
        bucket_hash TEXT PRIMARY KEY,
        window_started_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL CHECK(attempts > 0)
      );
      CREATE TABLE IF NOT EXISTS app_user_idempotency (
        actor_id INTEGER NOT NULL REFERENCES app_users(id),
        idem_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        user_id INTEGER NOT NULL REFERENCES app_users(id),
        PRIMARY KEY(actor_id,idem_key)
      );
      CREATE TABLE IF NOT EXISTS app_user_admin_idempotency (
        actor_id INTEGER NOT NULL REFERENCES app_users(id),
        idem_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        response_json TEXT NOT NULL CHECK(json_valid(response_json)),
        created_at TEXT NOT NULL,
        PRIMARY KEY(actor_id,idem_key)
      );
      CREATE TABLE IF NOT EXISTS app_user_admin_audit (
        id INTEGER PRIMARY KEY,
        actor_id INTEGER NOT NULL REFERENCES app_users(id),
        target_user_id INTEGER NOT NULL REFERENCES app_users(id),
        before_json TEXT NOT NULL CHECK(json_valid(before_json)),
        after_json TEXT NOT NULL CHECK(json_valid(after_json)),
        created_at TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS app_user_admin_audit_no_update
        BEFORE UPDATE ON app_user_admin_audit BEGIN SELECT RAISE(ABORT,'immutable user administration audit'); END;
      CREATE TRIGGER IF NOT EXISTS app_user_admin_audit_no_delete
        BEFORE DELETE ON app_user_admin_audit BEGIN SELECT RAISE(ABORT,'immutable user administration audit'); END;
      CREATE TABLE IF NOT EXISTS app_user_invitations (
        id INTEGER PRIMARY KEY,
        email TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','editor','publisher','planner','technician','finance','reader')),
        token_hash TEXT NOT NULL UNIQUE,
        invited_by INTEGER NOT NULL REFERENCES app_users(id),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        delivery_state TEXT NOT NULL CHECK(delivery_state IN ('pending','active')),
        accepted_at INTEGER,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS app_user_invitations_email ON app_user_invitations(email,expires_at);
      CREATE TABLE IF NOT EXISTS app_user_invitation_idempotency (
        actor_id INTEGER NOT NULL REFERENCES app_users(id),
        idem_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        invitation_id INTEGER NOT NULL REFERENCES app_user_invitations(id) ON DELETE CASCADE,
        PRIMARY KEY(actor_id,idem_key)
      );
      CREATE TABLE IF NOT EXISTS app_user_invitation_revoke_idempotency (
        actor_id INTEGER NOT NULL REFERENCES app_users(id),
        idem_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        response_json TEXT NOT NULL CHECK(json_valid(response_json)),
        created_at INTEGER NOT NULL,
        PRIMARY KEY(actor_id,idem_key)
      );
      CREATE TABLE IF NOT EXISTS app_user_invitation_audit (
        id INTEGER PRIMARY KEY,
        invitation_id INTEGER NOT NULL REFERENCES app_user_invitations(id),
        actor_id INTEGER NOT NULL REFERENCES app_users(id),
        event TEXT NOT NULL CHECK(event IN ('created','accepted','revoked')),
        occurred_at INTEGER NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS app_user_invitation_audit_no_update
        BEFORE UPDATE ON app_user_invitation_audit BEGIN SELECT RAISE(ABORT,'immutable invitation audit'); END;
      CREATE TRIGGER IF NOT EXISTS app_user_invitation_audit_no_delete
        BEFORE DELETE ON app_user_invitation_audit BEGIN SELECT RAISE(ABORT,'immutable invitation audit'); END;
      CREATE TABLE IF NOT EXISTS app_mfa_enrollments (
        user_id INTEGER PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
        secret_encrypted TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_mfa_recovery_codes (
        user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        code_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        used_at INTEGER,
        PRIMARY KEY(user_id,code_hash)
      );
      CREATE TABLE IF NOT EXISTS app_mfa_audit (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        event TEXT NOT NULL CHECK(event IN ('enabled','disabled','recovery_code_used')),
        occurred_at INTEGER NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS app_mfa_audit_no_update
        BEFORE UPDATE ON app_mfa_audit BEGIN SELECT RAISE(ABORT,'immutable MFA audit'); END;
      CREATE TRIGGER IF NOT EXISTS app_mfa_audit_no_delete
        BEFORE DELETE ON app_mfa_audit BEGIN SELECT RAISE(ABORT,'immutable MFA audit'); END;
    `);
    const resetColumns = new Set(this.#db.prepare('PRAGMA table_info(app_password_reset_tokens)').all().map((column) => column.name));
    if (!resetColumns.has('delivery_state')) {
      this.#db.exec("ALTER TABLE app_password_reset_tokens ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'active' CHECK(delivery_state IN ('pending','active'))");
    }
    const rateLimitColumns = new Set(this.#db.prepare('PRAGMA table_info(app_auth_rate_limits)').all().map((column) => column.name));
    if (!rateLimitColumns.has('expires_at')) {
      this.#db.exec('ALTER TABLE app_auth_rate_limits ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0');
    }
    this.#db.exec('CREATE INDEX IF NOT EXISTS app_auth_rate_limits_expiry ON app_auth_rate_limits(expires_at)');
    const userColumns = new Set(this.#db.prepare('PRAGMA table_info(app_users)').all().map((column) => column.name));
    if (!userColumns.has('auth0_issuer')) this.#db.exec('ALTER TABLE app_users ADD COLUMN auth0_issuer TEXT');
    if (!userColumns.has('auth0_subject')) this.#db.exec('ALTER TABLE app_users ADD COLUMN auth0_subject TEXT');
    if (!userColumns.has('mfa_enabled')) this.#db.exec('ALTER TABLE app_users ADD COLUMN mfa_enabled INTEGER NOT NULL DEFAULT 0 CHECK(mfa_enabled IN (0,1))');
    if (!userColumns.has('mfa_secret_encrypted')) this.#db.exec('ALTER TABLE app_users ADD COLUMN mfa_secret_encrypted TEXT');
    if (!userColumns.has('mfa_last_step')) this.#db.exec('ALTER TABLE app_users ADD COLUMN mfa_last_step INTEGER NOT NULL DEFAULT -1');
    if (!this.#mfaEncryptionKey && this.#db.prepare('SELECT 1 FROM app_users WHERE mfa_enabled=1 LIMIT 1').get()) {
      this.#db.close();
      throw new Error('CMS_ERP_MFA_ENCRYPTION_KEY is required while MFA-enabled accounts exist.');
    }
    this.#db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS app_users_auth0_identity
        ON app_users(auth0_issuer,auth0_subject)
        WHERE auth0_issuer IS NOT NULL AND auth0_subject IS NOT NULL;
      CREATE TABLE IF NOT EXISTS app_identity_link_idempotency (
        actor_id INTEGER NOT NULL REFERENCES app_users(id),
        idem_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        user_id INTEGER NOT NULL REFERENCES app_users(id),
        PRIMARY KEY(actor_id,idem_key)
      );
      CREATE TABLE IF NOT EXISTS app_identity_link_challenges (
        code_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES app_users(id),
        created_by INTEGER NOT NULL REFERENCES app_users(id),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS app_identity_link_audit (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES app_users(id),
        actor_id INTEGER NOT NULL REFERENCES app_users(id),
        auth0_issuer TEXT NOT NULL,
        auth0_subject TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  hasUsers() {
    return this.#db.prepare('SELECT 1 AS present FROM app_users LIMIT 1').get() !== undefined;
  }

  bootstrapAdmin(emailValue, password) {
    if (this.hasUsers()) return false;
    const email = normalizedEmail(emailValue);
    if (!email || typeof password !== 'string' || password.length < 14 || password.length > 1024) {
      throw new Error('First-run setup requires a valid CMS_ERP_BOOTSTRAP_EMAIL and a password of at least 14 characters.');
    }
    const salt = randomBytes(16);
    const hash = scryptSync(password, salt, 64);
    this.#db.prepare(
      'INSERT INTO app_users(email,password_hash,password_salt,role,created_at) VALUES(?,?,?,\'admin\',?)',
    ).run(email, hash.toString('hex'), salt.toString('hex'), new Date().toISOString());
    return true;
  }

  #encryptMfaSecret(secret) {
    if (!this.#mfaEncryptionKey) throw new Error('MFA encryption is not configured.');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#mfaEncryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
  }

  #decryptMfaSecret(value) {
    if (!this.#mfaEncryptionKey) throw new Error('MFA encryption is not configured.');
    if (typeof value !== 'string') throw new Error('Stored MFA secret is invalid.');
    const [ivText, tagText, ciphertextText, extra] = value.split('.');
    if (!ivText || !tagText || !ciphertextText || extra !== undefined) throw new Error('Stored MFA secret is invalid.');
    const decipher = createDecipheriv('aes-256-gcm', this.#mfaEncryptionKey, Buffer.from(ivText, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertextText, 'base64url')), decipher.final()]).toString('utf8');
  }

  #consumeMfaFactor(user, code, now) {
    if (typeof code !== 'string' || !this.#mfaEncryptionKey) return false;
    const codeHash = createHash('sha256').update(code, 'utf8').digest('hex');
    const consumed = this.#db.prepare(`
      UPDATE app_mfa_recovery_codes SET used_at=?
      WHERE user_id=? AND code_hash=? AND used_at IS NULL
    `).run(now, user.id, codeHash);
    if (Number(consumed.changes) === 1) {
      this.#db.prepare("INSERT INTO app_mfa_audit(user_id,event,occurred_at) VALUES(?,'recovery_code_used',?)").run(user.id, now);
      return true;
    }
    const secret = this.#decryptMfaSecret(user.mfa_secret_encrypted);
    const step = matchingTotpStep(secret, code, now, user.mfa_last_step);
    if (step === null) return false;
    const accepted = this.#db.prepare(`
      UPDATE app_users SET mfa_last_step=? WHERE id=? AND mfa_enabled=1 AND mfa_last_step<?
    `).run(step, user.id, step);
    return Number(accepted.changes) === 1;
  }

  authenticate(emailValue, password, mfaCode = '') {
    const email = normalizedEmail(emailValue);
    if (typeof password !== 'string' || password.length > 1024) return null;
    const user = email
      ? this.#db.prepare('SELECT id,email,password_hash,password_salt,role,active,mfa_enabled,mfa_secret_encrypted,mfa_last_step FROM app_users WHERE email=?').get(email)
      : undefined;
    const salt = user ? Buffer.from(user.password_salt, 'hex') : this.#dummySalt;
    const expected = user ? Buffer.from(user.password_hash, 'hex') : this.#dummyHash;
    const actual = scryptSync(password, salt, 64);
    const matches = actual.length === expected.length && timingSafeEqual(actual, expected);
    if (!user || !user.active || !matches) return null;

    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    if (user.mfa_enabled) {
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        const current = this.#db.prepare(`
          SELECT id,email,password_hash,password_salt,role,active,mfa_enabled,mfa_secret_encrypted,mfa_last_step
          FROM app_users WHERE id=?
        `).get(user.id);
        if (!current || !current.active || !current.mfa_enabled || current.password_hash !== user.password_hash ||
            current.password_salt !== user.password_salt || !this.#consumeMfaFactor(current, mfaCode, now)) {
          this.#db.exec('ROLLBACK');
          return null;
        }
        this.#db.prepare('DELETE FROM app_sessions WHERE expires_at<=?').run(now);
        this.#db.prepare('INSERT INTO app_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)')
          .run(tokenDigest(token), current.id, now + sessionLifetimeMs, now);
        this.#db.exec('COMMIT');
        return { token, actor: { id: current.id, email: current.email, role: current.role } };
      } catch (error) {
        try { this.#db.exec('ROLLBACK'); } catch { /* preserve the original error */ }
        throw error;
      }
    }
    this.#db.prepare('DELETE FROM app_sessions WHERE expires_at<=?').run(now);
    this.#db.prepare('INSERT INTO app_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)')
      .run(tokenDigest(token), user.id, now + sessionLifetimeMs, now);
    return { token, actor: { id: user.id, email: user.email, role: user.role } };
  }

  changePassword(req, actor, currentPassword, newPassword) {
    const session = this.#session(req);
    if (!session || session.actor.id !== actor?.id) return { error: 'AUTH_REQUIRED' };
    if (typeof currentPassword !== 'string' || currentPassword.length > 1024) {
      return { error: 'INVALID_CURRENT_PASSWORD' };
    }
    if (typeof newPassword !== 'string' || newPassword.length < 14 || newPassword.length > 1024) {
      return { error: 'INVALID_NEW_PASSWORD' };
    }
    if (currentPassword === newPassword) return { error: 'PASSWORD_UNCHANGED' };

    const user = this.#db.prepare(
      'SELECT id,email,role,password_hash,password_salt,active FROM app_users WHERE id=?',
    ).get(actor.id);
    if (!user || !user.active) return { error: 'AUTH_REQUIRED' };
    const oldSalt = Buffer.from(user.password_salt, 'hex');
    const oldHash = Buffer.from(user.password_hash, 'hex');
    const suppliedHash = scryptSync(currentPassword, oldSalt, 64);
    if (suppliedHash.length !== oldHash.length || !timingSafeEqual(suppliedHash, oldHash)) {
      return { error: 'CURRENT_PASSWORD_INVALID' };
    }

    const nextSalt = randomBytes(16);
    const nextHash = scryptSync(newPassword, nextSalt, 64);
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const update = this.#db.prepare(`
        UPDATE app_users SET password_hash=?,password_salt=?
        WHERE id=? AND password_hash=? AND password_salt=? AND active=1
      `).run(nextHash.toString('hex'), nextSalt.toString('hex'), actor.id, user.password_hash, user.password_salt);
      if (Number(update.changes) !== 1) {
        this.#db.exec('ROLLBACK');
        return { error: 'PASSWORD_CHANGED_CONCURRENTLY' };
      }
      this.#db.prepare('DELETE FROM app_sessions WHERE user_id=?').run(actor.id);
      this.#db.prepare('DELETE FROM app_password_reset_tokens WHERE user_id=?').run(actor.id);
      this.#db.prepare('INSERT INTO app_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)')
        .run(tokenDigest(token), actor.id, now + sessionLifetimeMs, now);
      this.#db.prepare("INSERT INTO app_auth_audit(user_id,event,occurred_at) VALUES(?,'password_changed',?)").run(actor.id, now);
      this.#db.exec('COMMIT');
      return {
        token,
        actor: { id: user.id, email: user.email, role: user.role },
        csrfToken: createHmac('sha256', this.#csrfSecret).update(token, 'utf8').digest('base64url'),
      };
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* the transaction may already be closed */ }
      throw error;
    }
  }

  createPasswordReset(emailValue) {
    const email = normalizedEmail(emailValue);
    if (!email) return null;
    const user = this.#db.prepare('SELECT id,email FROM app_users WHERE email=? AND active=1').get(email);
    if (!user) return null;
    const token = randomBytes(32).toString('base64url');
    const tokenHash = tokenDigest(token);
    const now = Date.now();
    const expiresAt = now + 30 * 60 * 1000;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.#db.prepare('SELECT id,email FROM app_users WHERE id=? AND active=1').get(user.id);
      if (!current) {
        this.#db.exec('ROLLBACK');
        return null;
      }
      this.#db.prepare('DELETE FROM app_password_reset_tokens WHERE expires_at<=?').run(now);
      this.#db.prepare('INSERT INTO app_password_reset_tokens(token_hash,user_id,created_at,expires_at,delivery_state) VALUES(?,?,?,?,\'pending\')')
        .run(tokenHash, user.id, now, expiresAt);
      this.#db.exec('COMMIT');
      return { email: current.email, token, expiresAt };
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* preserve the original error */ }
      throw error;
    }
  }

  activatePasswordReset(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(token)) return false;
    const tokenHash = tokenDigest(token);
    const now = Date.now();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const pending = this.#db.prepare(`
        SELECT t.user_id FROM app_password_reset_tokens t
        JOIN app_users u ON u.id=t.user_id
        WHERE t.token_hash=? AND t.delivery_state='pending' AND t.consumed_at IS NULL AND t.expires_at>? AND u.active=1
      `).get(tokenHash, now);
      if (!pending) {
        this.#db.exec('ROLLBACK');
        return false;
      }
      const activated = this.#db.prepare(`
        UPDATE app_password_reset_tokens SET delivery_state='active'
        WHERE token_hash=? AND delivery_state='pending' AND consumed_at IS NULL AND expires_at>?
      `).run(tokenHash, now);
      if (Number(activated.changes) !== 1) {
        this.#db.exec('ROLLBACK');
        return false;
      }
      this.#db.exec('COMMIT');
      return true;
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* preserve the original error */ }
      throw error;
    }
  }

  discardPendingPasswordReset(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(token)) return false;
    const result = this.#db.prepare(`
      DELETE FROM app_password_reset_tokens WHERE token_hash=? AND delivery_state='pending'
    `).run(tokenDigest(token));
    return Number(result.changes) === 1;
  }

  consumeRateLimits(buckets) {
    if (!Array.isArray(buckets) || buckets.length < 1 || buckets.length > 4 || buckets.some((bucket) =>
      !bucket || typeof bucket.key !== 'string' || bucket.key.length < 1 || bucket.key.length > 1024 ||
      !Number.isSafeInteger(bucket.limit) || bucket.limit < 1 || bucket.limit > 10_000 ||
      !Number.isSafeInteger(bucket.windowMs) || bucket.windowMs < 1000 || bucket.windowMs > 7 * 24 * 60 * 60 * 1000)) {
      throw new Error('INVALID_RATE_LIMIT_REQUEST');
    }
    const now = Date.now();
    const normalized = buckets.map((bucket) => ({
      bucketHash: tokenDigest(bucket.key),
      limit: bucket.limit,
      windowMs: bucket.windowMs,
    }));
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const stamp = Date.now();
      this.#db.prepare('DELETE FROM app_auth_rate_limits WHERE expires_at<=?').run(stamp);
      const current = normalized.map((bucket) => ({
        ...bucket,
        row: this.#db.prepare('SELECT window_started_at,expires_at,attempts FROM app_auth_rate_limits WHERE bucket_hash=?').get(bucket.bucketHash),
      }));
      if (current.some(({ row, limit, windowMs }) => row && Date.now() - row.window_started_at < windowMs && row.attempts >= limit)) {
        this.#db.exec('ROLLBACK');
        return false;
      }
      if (current.some(({ row }) => !row)) {
        const rowCount = this.#db.prepare('SELECT count(*) AS count FROM app_auth_rate_limits').get().count;
        if (rowCount + current.filter(({ row }) => !row).length > 10_000) {
          this.#db.exec('ROLLBACK');
          return false;
        }
      }
      for (const { bucketHash, limit, windowMs, row } of current) {
        if (!row || stamp - row.window_started_at >= windowMs) {
          this.#db.prepare(`
            INSERT INTO app_auth_rate_limits(bucket_hash,window_started_at,expires_at,attempts) VALUES(?,?,?,1)
            ON CONFLICT(bucket_hash) DO UPDATE SET window_started_at=excluded.window_started_at,expires_at=excluded.expires_at,attempts=1
          `).run(bucketHash, stamp, stamp + windowMs);
        } else {
          this.#db.prepare('UPDATE app_auth_rate_limits SET attempts=attempts+1 WHERE bucket_hash=?').run(bucketHash);
        }
      }
      this.#db.exec('COMMIT');
      return true;
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* preserve the original error */ }
      throw error;
    }
  }

  completePasswordReset(token, newPassword) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(token)) return { error: 'INVALID_OR_EXPIRED_RESET' };
    if (typeof newPassword !== 'string' || newPassword.length < 14 || newPassword.length > 1024) {
      return { error: 'INVALID_NEW_PASSWORD' };
    }
    const tokenHash = tokenDigest(token);
    const now = Date.now();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const reset = this.#db.prepare(`
        SELECT t.user_id,t.expires_at FROM app_password_reset_tokens t
        JOIN app_users u ON u.id=t.user_id
        WHERE t.token_hash=? AND t.delivery_state='active' AND t.consumed_at IS NULL AND t.expires_at>? AND u.active=1
      `).get(tokenHash, now);
      if (!reset) {
        this.#db.exec('ROLLBACK');
        return { error: 'INVALID_OR_EXPIRED_RESET' };
      }
      const salt = randomBytes(16);
      const hash = scryptSync(newPassword, salt, 64);
      const completedAt = Date.now();
      if (reset.expires_at <= completedAt) {
        this.#db.exec('ROLLBACK');
        return { error: 'INVALID_OR_EXPIRED_RESET' };
      }
      const updated = this.#db.prepare(`
        UPDATE app_users SET password_hash=?,password_salt=? WHERE id=? AND active=1
      `).run(hash.toString('hex'), salt.toString('hex'), reset.user_id);
      if (Number(updated.changes) !== 1) {
        this.#db.exec('ROLLBACK');
        return { error: 'INVALID_OR_EXPIRED_RESET' };
      }
      const consumed = this.#db.prepare(`
        UPDATE app_password_reset_tokens SET consumed_at=?
        WHERE token_hash=? AND consumed_at IS NULL AND expires_at>?
      `).run(completedAt, tokenHash, completedAt);
      if (Number(consumed.changes) !== 1) {
        this.#db.exec('ROLLBACK');
        return { error: 'INVALID_OR_EXPIRED_RESET' };
      }
      this.#db.prepare('DELETE FROM app_sessions WHERE user_id=?').run(reset.user_id);
      this.#db.prepare('DELETE FROM app_password_reset_tokens WHERE user_id=?').run(reset.user_id);
      this.#db.prepare("INSERT INTO app_auth_audit(user_id,event,occurred_at) VALUES(?,'password_reset',?)").run(reset.user_id, completedAt);
      this.#db.exec('COMMIT');
      return { data: { passwordChanged: true } };
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* preserve the original error */ }
      throw error;
    }
  }

  listUsers() {
    return this.#db.prepare('SELECT id,email,role,active,created_at AS createdAt,(auth0_subject IS NOT NULL) AS auth0Linked FROM app_users ORDER BY id').all();
  }

  listInvitations() {
    const now = Date.now();
    return this.#db.prepare(`
      SELECT id,email,role,created_at AS createdAt,expires_at AS expiresAt
      FROM app_user_invitations
      WHERE delivery_state='active' AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>?
      ORDER BY created_at DESC,id DESC
    `).all(now);
  }

  revokeInvitation(actor, key, invitationId) {
    if (actor?.role !== 'admin' || !Number.isSafeInteger(actor.id) || actor.id < 1) return { error: 'FORBIDDEN' };
    if (!Number.isSafeInteger(invitationId) || invitationId < 1) return { error: 'INVALID_INVITATION' };
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,100}$/u.test(key)) return { error: 'IDEMPOTENCY_KEY_REQUIRED' };
    const fingerprint = createHmac('sha256', this.#csrfSecret).update(JSON.stringify({ invitationId }), 'utf8').digest('hex');
    const now = Date.now();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const currentActor = this.#db.prepare('SELECT role,active FROM app_users WHERE id=?').get(actor.id);
      if (!currentActor || currentActor.role !== 'admin' || currentActor.active !== 1) {
        this.#db.exec('ROLLBACK');
        return { error: 'FORBIDDEN' };
      }
      const prior = this.#db.prepare(`
        SELECT fingerprint,response_json FROM app_user_invitation_revoke_idempotency WHERE actor_id=? AND idem_key=?
      `).get(actor.id, key);
      if (prior) {
        this.#db.exec('COMMIT');
        return prior.fingerprint === fingerprint ? JSON.parse(prior.response_json) : { error: 'IDEMPOTENCY_CONFLICT' };
      }
      const invitation = this.#db.prepare(`
        SELECT id,email,role,delivery_state,expires_at,accepted_at,revoked_at
        FROM app_user_invitations WHERE id=?
      `).get(invitationId);
      if (!invitation) { this.#db.exec('ROLLBACK'); return { error: 'INVITATION_NOT_FOUND' }; }
      if (invitation.delivery_state !== 'active' || invitation.accepted_at !== null || invitation.revoked_at !== null || invitation.expires_at <= now) {
        this.#db.exec('ROLLBACK');
        return { error: 'INVITATION_NOT_ACTIVE' };
      }
      this.#db.prepare('UPDATE app_user_invitations SET revoked_at=? WHERE id=? AND revoked_at IS NULL AND accepted_at IS NULL').run(now, invitationId);
      this.#db.prepare("INSERT INTO app_user_invitation_audit(invitation_id,actor_id,event,occurred_at) VALUES(?,?,'revoked',?)").run(invitationId, actor.id, now);
      const response = { data: { id: invitationId, email: invitation.email, revoked: true } };
      this.#db.prepare(`
        INSERT INTO app_user_invitation_revoke_idempotency(actor_id,idem_key,fingerprint,response_json,created_at)
        VALUES(?,?,?,?,?)
      `).run(actor.id, key, fingerprint, JSON.stringify(response), now);
      this.#db.exec('COMMIT');
      return response;
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* preserve the original error */ }
      throw error;
    }
  }

  createInvitation(actor, key, { email: emailValue, role, token } = {}) {
    const email = normalizedEmail(emailValue);
    if (!email || !roles.has(role) || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(token)) return { error: 'INVALID_INVITATION' };
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,100}$/u.test(key)) return { error: 'IDEMPOTENCY_KEY_REQUIRED' };
    if (actor?.role !== 'admin' || !Number.isSafeInteger(actor.id) || actor.id < 1) return { error: 'FORBIDDEN' };
    const fingerprint = createHmac('sha256', this.#csrfSecret)
      .update(JSON.stringify({ email, role }), 'utf8').digest('hex');
    const tokenHash = tokenDigest(token);
    const now = Date.now();
    const expiresAt = now + 7 * 24 * 60 * 60 * 1000;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const currentActor = this.#db.prepare('SELECT role,active FROM app_users WHERE id=?').get(actor.id);
      if (!currentActor || currentActor.role !== 'admin' || currentActor.active !== 1) {
        this.#db.exec('ROLLBACK');
        return { error: 'FORBIDDEN' };
      }
      const prior = this.#db.prepare(`
        SELECT fingerprint,invitation_id FROM app_user_invitation_idempotency WHERE actor_id=? AND idem_key=?
      `).get(actor.id, key);
      if (prior) {
        const invitation = prior.fingerprint === fingerprint
        ? this.#db.prepare(`SELECT email,role,expires_at,delivery_state,accepted_at,revoked_at FROM app_user_invitations WHERE id=?`).get(prior.invitation_id)
          : null;
        this.#db.exec('COMMIT');
        if (prior.fingerprint !== fingerprint) return { error: 'IDEMPOTENCY_CONFLICT' };
        if (!invitation || invitation.delivery_state !== 'active' || invitation.accepted_at !== null || invitation.revoked_at !== null || invitation.expires_at <= now) return { error: 'INVITATION_EXPIRED' };
        return { data: { email: invitation.email, role: invitation.role, expiresAt: invitation.expires_at, alreadyCreated: true } };
      }
      if (this.#db.prepare('SELECT 1 FROM app_users WHERE email=?').get(email)) {
        this.#db.exec('ROLLBACK');
        return { error: 'EMAIL_IN_USE' };
      }
      this.#db.prepare("DELETE FROM app_user_invitations WHERE delivery_state='pending' AND created_at<?").run(now - 10 * 60 * 1000);
      if (this.#db.prepare("SELECT 1 FROM app_user_invitations WHERE email=? AND delivery_state='pending' AND created_at>=?").get(email, now - 10 * 60 * 1000)) {
        this.#db.exec('ROLLBACK');
        return { error: 'INVITATION_DELIVERY_PENDING' };
      }
      const inserted = this.#db.prepare(`
        INSERT INTO app_user_invitations(email,role,token_hash,invited_by,created_at,expires_at,delivery_state)
        VALUES(?,?,?,?,?,?,'pending')
      `).run(email, role, tokenHash, actor.id, now, expiresAt);
      const invitationId = Number(inserted.lastInsertRowid);
      this.#db.prepare(`
        INSERT INTO app_user_invitation_idempotency(actor_id,idem_key,fingerprint,invitation_id) VALUES(?,?,?,?)
      `).run(actor.id, key, fingerprint, invitationId);
      this.#db.exec('COMMIT');
      return { data: { id: invitationId, email, role, expiresAt, token } };
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* preserve the original error */ }
      throw error;
    }
  }

  activateInvitation(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(token)) return false;
    const now = Date.now();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const invitation = this.#db.prepare(`
        SELECT id,email,invited_by,delivery_state,expires_at FROM app_user_invitations WHERE token_hash=?
      `).get(tokenDigest(token));
      if (!invitation || invitation.expires_at <= now || invitation.delivery_state !== 'pending') {
        this.#db.exec('ROLLBACK');
        return false;
      }
      const priorActive = this.#db.prepare(`
        SELECT id,invited_by FROM app_user_invitations
        WHERE email=? AND delivery_state='active' AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>?
      `).all(invitation.email, now);
      for (const prior of priorActive) {
        this.#db.prepare('UPDATE app_user_invitations SET revoked_at=? WHERE id=?').run(now, prior.id);
        this.#db.prepare("INSERT INTO app_user_invitation_audit(invitation_id,actor_id,event,occurred_at) VALUES(?,?,'revoked',?)").run(prior.id, invitation.invited_by, now);
      }
      this.#db.prepare("UPDATE app_user_invitations SET delivery_state='active' WHERE id=? AND delivery_state='pending'").run(invitation.id);
      this.#db.prepare("INSERT INTO app_user_invitation_audit(invitation_id,actor_id,event,occurred_at) VALUES(?,?,'created',?)").run(invitation.id, invitation.invited_by, now);
      this.#db.exec('COMMIT');
      return true;
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* preserve the original error */ }
      throw error;
    }
  }

  discardPendingInvitation(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(token)) return false;
    const result = this.#db.prepare("DELETE FROM app_user_invitations WHERE token_hash=? AND delivery_state='pending'").run(tokenDigest(token));
    return Number(result.changes) === 1;
  }

  acceptInvitation(token, password) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(token) ||
        typeof password !== 'string' || password.length < 14 || password.length > 1024) return { error: 'INVALID_OR_EXPIRED_INVITATION' };
    const now = Date.now();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const invitation = this.#db.prepare(`
        SELECT id,email,role,invited_by,expires_at,delivery_state,accepted_at,revoked_at
        FROM app_user_invitations WHERE token_hash=?
      `).get(tokenDigest(token));
      if (!invitation || invitation.delivery_state !== 'active' || invitation.accepted_at !== null || invitation.revoked_at !== null || invitation.expires_at <= now) {
        this.#db.exec('ROLLBACK');
        return { error: 'INVALID_OR_EXPIRED_INVITATION' };
      }
      if (this.#db.prepare('SELECT 1 FROM app_users WHERE email=?').get(invitation.email)) {
        this.#db.exec('ROLLBACK');
        return { error: 'INVITATION_ALREADY_USED' };
      }
      const salt = randomBytes(16);
      const passwordHash = scryptSync(password, salt, 64);
      const createdAt = new Date(now).toISOString();
      const inserted = this.#db.prepare(`
        INSERT INTO app_users(email,password_hash,password_salt,role,created_at) VALUES(?,?,?,?,?)
      `).run(invitation.email, passwordHash.toString('hex'), salt.toString('hex'), invitation.role, createdAt);
      const userId = Number(inserted.lastInsertRowid);
      this.#db.prepare('UPDATE app_user_invitations SET accepted_at=? WHERE id=? AND accepted_at IS NULL').run(now, invitation.id);
      this.#db.prepare("INSERT INTO app_user_invitation_audit(invitation_id,actor_id,event,occurred_at) VALUES(?,?,'accepted',?)").run(invitation.id, invitation.invited_by, now);
      this.#db.exec('COMMIT');
      return { data: { id: userId, email: invitation.email, role: invitation.role, active: 1, createdAt } };
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* preserve the original error */ }
      if (/UNIQUE constraint failed: app_users\.email/u.test(error?.message ?? '')) return { error: 'INVITATION_ALREADY_USED' };
      throw error;
    }
  }

  updateUser(actor, key, userId, input = {}) {
    if (actor?.role !== 'admin' || !Number.isSafeInteger(actor.id) || actor.id < 1) return { error: 'FORBIDDEN' };
    if (!Number.isSafeInteger(userId) || userId < 1 || !input || typeof input !== 'object' || Array.isArray(input)) {
      return { error: 'INVALID_USER_UPDATE' };
    }
    const keys = Object.keys(input);
    if (!keys.length || keys.some((name) => !['role', 'active'].includes(name)) ||
        (Object.hasOwn(input, 'role') && !roles.has(input.role)) ||
        (Object.hasOwn(input, 'active') && typeof input.active !== 'boolean')) {
      return { error: 'INVALID_USER_UPDATE' };
    }
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,100}$/u.test(key)) return { error: 'IDEMPOTENCY_KEY_REQUIRED' };

    const fingerprint = createHmac('sha256', this.#csrfSecret)
      .update(JSON.stringify({ userId, role: input.role ?? null, active: input.active ?? null }), 'utf8').digest('hex');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const currentActor = this.#db.prepare('SELECT role,active FROM app_users WHERE id=?').get(actor.id);
      if (!currentActor || currentActor.role !== 'admin' || currentActor.active !== 1) {
        this.#db.exec('ROLLBACK');
        return { error: 'FORBIDDEN' };
      }
      const prior = this.#db.prepare(`
        SELECT fingerprint,response_json FROM app_user_admin_idempotency WHERE actor_id=? AND idem_key=?
      `).get(actor.id, key);
      if (prior) {
        this.#db.exec('COMMIT');
        return prior.fingerprint === fingerprint
          ? JSON.parse(prior.response_json)
          : { error: 'IDEMPOTENCY_CONFLICT' };
      }

      const current = this.#db.prepare(`
        SELECT id,email,role,active,created_at AS createdAt FROM app_users WHERE id=?
      `).get(userId);
      if (!current) { this.#db.exec('ROLLBACK'); return { error: 'USER_NOT_FOUND' }; }
      const nextRole = input.role ?? current.role;
      const nextActive = Object.hasOwn(input, 'active') ? Number(input.active) : current.active;
      const changed = nextRole !== current.role || nextActive !== current.active;
      if (changed && userId === actor.id) {
        this.#db.exec('ROLLBACK');
        return { error: 'SELF_MANAGEMENT_FORBIDDEN' };
      }
      if (current.role === 'admin' && current.active === 1 && (nextRole !== 'admin' || nextActive !== 1)) {
        const activeAdmins = this.#db.prepare("SELECT count(*) AS count FROM app_users WHERE role='admin' AND active=1").get().count;
        if (activeAdmins <= 1) { this.#db.exec('ROLLBACK'); return { error: 'LAST_ADMIN_REQUIRED' }; }
      }

      if (changed) {
        this.#db.prepare('UPDATE app_users SET role=?,active=? WHERE id=?').run(nextRole, nextActive, userId);
        this.#db.prepare('DELETE FROM app_sessions WHERE user_id=?').run(userId);
        const after = { id: current.id, email: current.email, role: nextRole, active: nextActive, createdAt: current.createdAt };
        this.#db.prepare(`
          INSERT INTO app_user_admin_audit(actor_id,target_user_id,before_json,after_json,created_at)
          VALUES(?,?,?,?,?)
        `).run(actor.id, userId, JSON.stringify(current), JSON.stringify(after), new Date().toISOString());
      }
      const data = this.#db.prepare(`
        SELECT id,email,role,active,created_at AS createdAt FROM app_users WHERE id=?
      `).get(userId);
      const response = { data };
      this.#db.prepare(`
        INSERT INTO app_user_admin_idempotency(actor_id,idem_key,fingerprint,response_json,created_at)
        VALUES(?,?,?,?,?)
      `).run(actor.id, key, fingerprint, JSON.stringify(response), new Date().toISOString());
      this.#db.exec('COMMIT');
      return response;
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* preserve the original error */ }
      throw error;
    }
  }

  actorForExternalIdentity(issuer, subject) {
    if (typeof issuer !== 'string' || typeof subject !== 'string' || !issuer || !subject ||
        issuer.length > 512 || subject.length > 255 || /[\u0000-\u001f\u007f]/u.test(issuer + subject)) return null;
    const user = this.#db.prepare(`
      SELECT id,email,role FROM app_users
      WHERE auth0_issuer=? AND auth0_subject=? AND active=1
    `).get(issuer, subject);
    return user ? { id: user.id, email: user.email, role: user.role } : null;
  }

  createAuth0LinkChallenge(actor, key, userId, code) {
    if (actor?.role !== 'admin' || !Number.isSafeInteger(actor.id) || actor.id < 1) return { error: 'FORBIDDEN' };
    if (!Number.isSafeInteger(userId) || userId < 1 || typeof code !== 'string' || !/^[A-Za-z0-9._~-]{32,100}$/u.test(code)) return { error: 'INVALID_LINK_REQUEST' };
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,100}$/u.test(key)) return { error: 'IDEMPOTENCY_KEY_REQUIRED' };
    const codeHash = createHash('sha256').update(code, 'utf8').digest('hex');
    const fingerprint = createHash('sha256').update(JSON.stringify({ userId, codeHash }), 'utf8').digest('hex');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.#db.prepare('SELECT fingerprint,user_id FROM app_identity_link_idempotency WHERE actor_id=? AND idem_key=?').get(actor.id, key);
      if (prior) {
        const challenge = prior.fingerprint === fingerprint
          ? this.#db.prepare('SELECT expires_at,consumed_at FROM app_identity_link_challenges WHERE code_hash=?').get(codeHash)
          : null;
        this.#db.exec('COMMIT');
        if (prior.fingerprint !== fingerprint) return { error: 'IDEMPOTENCY_CONFLICT' };
        if (!challenge || challenge.consumed_at !== null || challenge.expires_at <= Date.now()) return { error: 'LINK_CHALLENGE_EXPIRED' };
        return { data: { userId: prior.user_id, challengeCreated: true, expiresAt: challenge.expires_at } };
      }
      const user = this.#db.prepare('SELECT id,active,auth0_issuer,auth0_subject FROM app_users WHERE id=?').get(userId);
      if (!user) { this.#db.exec('ROLLBACK'); return { error: 'USER_NOT_FOUND' }; }
      if (!user.active) { this.#db.exec('ROLLBACK'); return { error: 'USER_INACTIVE' }; }
      if (user.auth0_issuer || user.auth0_subject) {
        this.#db.exec('ROLLBACK');
        return { error: 'IDENTITY_ALREADY_LINKED' };
      }
      const now = Date.now();
      this.#db.prepare('UPDATE app_identity_link_challenges SET consumed_at=? WHERE user_id=? AND consumed_at IS NULL').run(now, userId);
      this.#db.prepare('INSERT INTO app_identity_link_challenges(code_hash,user_id,created_by,created_at,expires_at) VALUES(?,?,?,?,?)').run(codeHash, userId, actor.id, now, now + 10 * 60 * 1000);
      this.#db.prepare('INSERT INTO app_identity_link_idempotency(actor_id,idem_key,fingerprint,user_id) VALUES(?,?,?,?)').run(actor.id, key, fingerprint, userId);
      this.#db.exec('COMMIT');
      return { data: { userId, challengeCreated: true, expiresAt: now + 10 * 60 * 1000 } };
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* preserve the original error */ }
      throw error;
    }
  }

  completeAuth0IdentityLink(issuer, subject, code) {
    if (typeof issuer !== 'string' || !/^https:\/\/[^/]+\/$/u.test(issuer) || issuer.length > 512 ||
        typeof subject !== 'string' || !/^[^\u0000-\u0020\u007f]{1,255}$/u.test(subject) ||
        typeof code !== 'string' || !/^[A-Za-z0-9._~-]{32,100}$/u.test(code)) return { error: 'INVALID_LINK_REQUEST' };
    const codeHash = createHash('sha256').update(code, 'utf8').digest('hex');
    const now = Date.now();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const challenge = this.#db.prepare('SELECT user_id,created_by,expires_at,consumed_at FROM app_identity_link_challenges WHERE code_hash=?').get(codeHash);
      if (!challenge || challenge.consumed_at !== null || challenge.expires_at <= now) {
        this.#db.exec('ROLLBACK');
        return { error: 'LINK_CHALLENGE_INVALID' };
      }
      const user = this.#db.prepare('SELECT id,role,active,auth0_issuer,auth0_subject FROM app_users WHERE id=?').get(challenge.user_id);
      if (!user || !user.active || user.auth0_issuer || user.auth0_subject) {
        this.#db.exec('ROLLBACK');
        return { error: 'IDENTITY_ALREADY_LINKED' };
      }
      this.#db.prepare('UPDATE app_users SET auth0_issuer=?,auth0_subject=? WHERE id=? AND auth0_issuer IS NULL AND auth0_subject IS NULL').run(issuer, subject, user.id);
      this.#db.prepare('UPDATE app_identity_link_challenges SET consumed_at=? WHERE code_hash=? AND consumed_at IS NULL').run(now, codeHash);
      this.#db.prepare('INSERT INTO app_identity_link_audit(user_id,actor_id,auth0_issuer,auth0_subject,created_at) VALUES(?,?,?,?,?)').run(user.id, challenge.created_by, issuer, subject, new Date(now).toISOString());
      this.#db.exec('COMMIT');
      return { data: { userId: user.id, linked: true, role: user.role } };
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* preserve the original error */ }
      if (/UNIQUE constraint failed: app_users\.auth0_issuer, app_users\.auth0_subject/u.test(error?.message ?? '')) return { error: 'IDENTITY_IN_USE' };
      throw error;
    }
  }

  listActiveTechnicians() {
    return this.#db.prepare(
      "SELECT id,email FROM app_users WHERE role='technician' AND active=1 ORDER BY id",
    ).all();
  }

  isActiveTechnician(id) {
    if (!Number.isSafeInteger(id) || id < 1) return false;
    return Boolean(this.#db.prepare(
      "SELECT 1 FROM app_users WHERE id=? AND role='technician' AND active=1",
    ).get(id));
  }

  createUser(actor, key, { email: emailValue, password, role } = {}) {
    const email = normalizedEmail(emailValue);
    if (!email || typeof password !== 'string' || password.length < 14 || password.length > 1024 || !roles.has(role)) {
      return { error: 'INVALID_USER' };
    }
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,100}$/u.test(key)) return { error: 'IDEMPOTENCY_KEY_REQUIRED' };
    const fingerprint = createHmac('sha256', this.#csrfSecret)
      .update(JSON.stringify({ email, role, password }), 'utf8').digest('hex');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.#db.prepare('SELECT fingerprint,user_id FROM app_user_idempotency WHERE actor_id=? AND idem_key=?').get(actor.id, key);
      if (prior) {
        this.#db.exec('COMMIT');
        return prior.fingerprint === fingerprint
          ? { data: this.#db.prepare('SELECT id,email,role,active,created_at AS createdAt FROM app_users WHERE id=?').get(prior.user_id) }
          : { error: 'IDEMPOTENCY_CONFLICT' };
      }
      if (this.#db.prepare('SELECT 1 FROM app_users WHERE email=?').get(email)) {
        this.#db.exec('ROLLBACK');
        return { error: 'EMAIL_IN_USE' };
      }
      const salt = randomBytes(16);
      const passwordHash = scryptSync(password, salt, 64);
      const createdAt = new Date().toISOString();
      const insert = this.#db.prepare(
        'INSERT INTO app_users(email,password_hash,password_salt,role,created_at) VALUES(?,?,?,?,?)',
      ).run(email, passwordHash.toString('hex'), salt.toString('hex'), role, createdAt);
      const id = Number(insert.lastInsertRowid);
      this.#db.prepare('INSERT INTO app_user_idempotency(actor_id,idem_key,fingerprint,user_id) VALUES(?,?,?,?)')
        .run(actor.id, key, fingerprint, id);
      const data = this.#db.prepare('SELECT id,email,role,active,created_at AS createdAt FROM app_users WHERE id=?').get(id);
      this.#db.exec('COMMIT');
      return { data };
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* the transaction may already be closed */ }
      throw error;
    }
  }

  #session(req) {
    const token = cookieValue(req);
    if (!token) return null;
    const row = this.#db.prepare(`
      SELECT u.id,u.email,u.role,s.token_hash,s.expires_at
      FROM app_sessions s JOIN app_users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.expires_at>? AND u.active=1
    `).get(tokenDigest(token), Date.now());
    return row ? { token, tokenHash: row.token_hash, actor: { id: row.id, email: row.email, role: row.role } } : null;
  }

  mfaStatus(req, actor) {
    const session = this.#session(req);
    if (!session || session.actor.id !== actor?.id) return { error: 'AUTH_REQUIRED' };
    const user = this.#db.prepare('SELECT mfa_enabled FROM app_users WHERE id=? AND active=1').get(actor.id);
    return user ? { data: { enabled: user.mfa_enabled === 1, encryptionConfigured: Boolean(this.#mfaEncryptionKey) } } : { error: 'AUTH_REQUIRED' };
  }

  beginMfaEnrollment(req, actor, currentPassword) {
    const session = this.#session(req);
    if (!session || session.actor.id !== actor?.id) return { error: 'AUTH_REQUIRED' };
    if (!this.#mfaEncryptionKey) return { error: 'MFA_NOT_CONFIGURED' };
    if (typeof currentPassword !== 'string' || currentPassword.length > 1024) return { error: 'CURRENT_PASSWORD_INVALID' };
    const user = this.#db.prepare('SELECT id,email,password_hash,password_salt,mfa_enabled FROM app_users WHERE id=? AND active=1').get(actor.id);
    if (!user) return { error: 'AUTH_REQUIRED' };
    const actual = scryptSync(currentPassword, Buffer.from(user.password_salt, 'hex'), 64);
    const expected = Buffer.from(user.password_hash, 'hex');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return { error: 'CURRENT_PASSWORD_INVALID' };
    if (user.mfa_enabled) return { error: 'MFA_ALREADY_ENABLED' };

    const secret = createTotpSecret();
    const encrypted = this.#encryptMfaSecret(secret);
    const now = Date.now();
    const expiresAt = now + 10 * 60 * 1000;
    this.#db.prepare(`
      INSERT INTO app_mfa_enrollments(user_id,secret_encrypted,expires_at) VALUES(?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET secret_encrypted=excluded.secret_encrypted,expires_at=excluded.expires_at
    `).run(user.id, encrypted, expiresAt);
    const label = encodeURIComponent(`CMS ERP:${user.email}`);
    const otpauthUrl = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent('CMS ERP')}&algorithm=SHA1&digits=6&period=30`;
    return { data: { secret, otpauthUrl, expiresAt } };
  }

  confirmMfaEnrollment(req, actor, code) {
    const session = this.#session(req);
    if (!session || session.actor.id !== actor?.id) return { error: 'AUTH_REQUIRED' };
    if (!this.#mfaEncryptionKey) return { error: 'MFA_NOT_CONFIGURED' };
    if (typeof code !== 'string' || !/^\d{6}$/u.test(code)) return { error: 'INVALID_MFA_CODE' };
    const now = Date.now();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const user = this.#db.prepare('SELECT id,active,mfa_enabled FROM app_users WHERE id=?').get(actor.id);
      const enrollment = this.#db.prepare('SELECT secret_encrypted,expires_at FROM app_mfa_enrollments WHERE user_id=?').get(actor.id);
      if (!user || !user.active) { this.#db.exec('ROLLBACK'); return { error: 'AUTH_REQUIRED' }; }
      if (user.mfa_enabled) { this.#db.exec('ROLLBACK'); return { error: 'MFA_ALREADY_ENABLED' }; }
      if (!enrollment || enrollment.expires_at <= now) {
        this.#db.prepare('DELETE FROM app_mfa_enrollments WHERE user_id=?').run(actor.id);
        this.#db.exec('COMMIT');
        return { error: 'MFA_ENROLLMENT_EXPIRED' };
      }
      const secret = this.#decryptMfaSecret(enrollment.secret_encrypted);
      const step = matchingTotpStep(secret, code, now, -1);
      if (step === null) { this.#db.exec('ROLLBACK'); return { error: 'INVALID_MFA_CODE' }; }
      const codes = Array.from({ length: 10 }, () => randomBytes(12).toString('base64url'));
      this.#db.prepare(`
        UPDATE app_users SET mfa_enabled=1,mfa_secret_encrypted=?,mfa_last_step=?
        WHERE id=? AND active=1 AND mfa_enabled=0
      `).run(enrollment.secret_encrypted, step, actor.id);
      this.#db.prepare('DELETE FROM app_mfa_recovery_codes WHERE user_id=?').run(actor.id);
      const insertCode = this.#db.prepare('INSERT INTO app_mfa_recovery_codes(user_id,code_hash,created_at) VALUES(?,?,?)');
      for (const recoveryCode of codes) insertCode.run(actor.id, createHash('sha256').update(recoveryCode, 'utf8').digest('hex'), now);
      this.#db.prepare('DELETE FROM app_mfa_enrollments WHERE user_id=?').run(actor.id);
      this.#db.prepare('DELETE FROM app_sessions WHERE user_id=? AND token_hash<>?').run(actor.id, session.tokenHash);
      this.#db.prepare("INSERT INTO app_mfa_audit(user_id,event,occurred_at) VALUES(?,'enabled',?)").run(actor.id, now);
      this.#db.exec('COMMIT');
      return { data: { enabled: true, recoveryCodes: codes } };
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* preserve the original error */ }
      throw error;
    }
  }

  disableMfa(req, actor, currentPassword, code) {
    const session = this.#session(req);
    if (!session || session.actor.id !== actor?.id) return { error: 'AUTH_REQUIRED' };
    if (typeof currentPassword !== 'string' || currentPassword.length > 1024 || typeof code !== 'string' || code.length > 128) {
      return { error: 'INVALID_MFA_REQUEST' };
    }
    const current = this.#db.prepare('SELECT id,active,password_hash,password_salt,mfa_enabled FROM app_users WHERE id=?').get(actor.id);
    if (!current || !current.active) return { error: 'AUTH_REQUIRED' };
    const suppliedHash = scryptSync(currentPassword, Buffer.from(current.password_salt, 'hex'), 64);
    const expectedHash = Buffer.from(current.password_hash, 'hex');
    if (suppliedHash.length !== expectedHash.length || !timingSafeEqual(suppliedHash, expectedHash)) return { error: 'CURRENT_PASSWORD_INVALID' };
    if (!current.mfa_enabled) return { error: 'MFA_NOT_ENABLED' };

    const now = Date.now();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const user = this.#db.prepare(`
        SELECT id,active,password_hash,password_salt,mfa_enabled,mfa_secret_encrypted,mfa_last_step
        FROM app_users WHERE id=?
      `).get(actor.id);
      if (!user || !user.active || !user.mfa_enabled || user.password_hash !== current.password_hash || user.password_salt !== current.password_salt) {
        this.#db.exec('ROLLBACK');
        return { error: 'AUTH_REQUIRED' };
      }
      if (!this.#consumeMfaFactor(user, code, now)) { this.#db.exec('ROLLBACK'); return { error: 'INVALID_MFA_CODE' }; }
      this.#db.prepare('UPDATE app_users SET mfa_enabled=0,mfa_secret_encrypted=NULL,mfa_last_step=-1 WHERE id=?').run(actor.id);
      this.#db.prepare('DELETE FROM app_mfa_recovery_codes WHERE user_id=?').run(actor.id);
      this.#db.prepare('DELETE FROM app_mfa_enrollments WHERE user_id=?').run(actor.id);
      this.#db.prepare('DELETE FROM app_sessions WHERE user_id=? AND token_hash<>?').run(actor.id, session.tokenHash);
      this.#db.prepare("INSERT INTO app_mfa_audit(user_id,event,occurred_at) VALUES(?,'disabled',?)").run(actor.id, now);
      this.#db.exec('COMMIT');
      return { data: { enabled: false } };
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* preserve the original error */ }
      throw error;
    }
  }

  actor(req) {
    return this.#session(req)?.actor ?? null;
  }

  csrfToken(req) {
    const session = this.#session(req);
    return session ? createHmac('sha256', this.#csrfSecret).update(session.token, 'utf8').digest('base64url') : null;
  }

  verifyCsrf(req, actor) {
    const session = this.#session(req);
    const supplied = req.headers['x-csrf-token'];
    if (!session || session.actor.id !== actor?.id || typeof supplied !== 'string') return false;
    const expected = createHmac('sha256', this.#csrfSecret).update(session.token, 'utf8').digest();
    let actual;
    try { actual = Buffer.from(supplied, 'base64url'); } catch { return false; }
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  revoke(req) {
    const session = this.#session(req);
    if (session) this.#db.prepare('DELETE FROM app_sessions WHERE token_hash=?').run(session.tokenHash);
  }

  close() {
    this.#db.close();
  }
}
