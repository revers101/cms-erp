// SPDX-License-Identifier: GPL-3.0-or-later
// Local CMS content service. Authentication, HTTP, uploads and tenant selection belong to the host.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const contentTypes = new Set(['page', 'article', 'service', 'project', 'faq']);
const roles = new Set(['admin', 'editor', 'publisher', 'reader']);
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const idempotencyPattern = /^[A-Za-z0-9._:-]{8,100}$/;
const controlPattern = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;
const maxContentBytes = 262144;
const managementFields = ['id', 'type', 'slug', 'status', 'version', 'createdBy', 'createdAt', 'updatedAt', 'publishedAt', 'hasUnpublishedChanges', 'content'];
const publicFields = ['id', 'type', 'slug', 'title', 'summary', 'blocks', 'seoTitle', 'seoDescription', 'publishedAt'];

export class ContentError extends Error {
  constructor(code, message) {
    const status = { VALIDATION: 422, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409 }[code];
    super(message);
    this.name = 'ContentError';
    this.code = code;
    this.status = status ?? 500;
  }
}

function record(value, fields, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContentError('VALIDATION', label);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new ContentError('VALIDATION', label);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !fields.includes(key)) throw new ContentError('VALIDATION', `${label} field`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new ContentError('VALIDATION', `${label} field`);
  }
  return value;
}

function text(value, label, maxLength, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || value.length > maxLength || controlPattern.test(value)) {
    throw new ContentError('VALIDATION', label);
  }
  const normalized = value.trim();
  if (!allowEmpty && normalized.length === 0) throw new ContentError('VALIDATION', label);
  return normalized;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new ContentError('VALIDATION', label);
  return value;
}

function safeActor(actor) {
  record(actor, ['id', 'role'], 'actor');
  const id = typeof actor.id === 'string'
    ? text(actor.id, 'actor id', 128)
    : Number.isSafeInteger(actor.id) && actor.id > 0
      ? String(actor.id)
      : undefined;
  if (!id || !roles.has(actor.role)) throw new ContentError('FORBIDDEN', 'actor is not authorized');
  return { id, role: actor.role };
}

function validateBlock(value) {
  const candidate = record(value, ['type', 'text', 'level', 'ordered', 'items'], 'block');
  if (candidate.type === 'paragraph') {
    const block = record(candidate, ['type', 'text'], 'block');
    return { type: 'paragraph', text: text(block.text, 'block text', 12000) };
  }
  if (candidate.type === 'heading') {
    const block = record(candidate, ['type', 'level', 'text'], 'block');
    if (![2, 3, 4].includes(block.level)) throw new ContentError('VALIDATION', 'heading level');
    return { type: 'heading', level: block.level, text: text(block.text, 'block text', 300) };
  }
  if (candidate.type === 'list') {
    const block = record(candidate, ['type', 'ordered', 'items'], 'block');
    if (typeof block.ordered !== 'boolean' || !Array.isArray(block.items) || block.items.length < 1 || block.items.length > 50) {
      throw new ContentError('VALIDATION', 'list');
    }
    return { type: 'list', ordered: block.ordered, items: block.items.map((item) => text(item, 'list item', 1000)) };
  }
  throw new ContentError('VALIDATION', 'unsupported content block');
}

export function validateContent(value) {
  const input = record(value, ['type', 'title', 'slug', 'summary', 'blocks', 'seoTitle', 'seoDescription'], 'content');
  if (!contentTypes.has(input.type)) throw new ContentError('VALIDATION', 'content type');
  if (typeof input.slug !== 'string' || input.slug.length > 160 || !slugPattern.test(input.slug)) {
    throw new ContentError('VALIDATION', 'slug');
  }
  if (!Array.isArray(input.blocks) || input.blocks.length < 1 || input.blocks.length > 100) {
    throw new ContentError('VALIDATION', 'blocks');
  }
  const title = text(input.title, 'title', 200);
  const summary = text(input.summary ?? '', 'summary', 500, { allowEmpty: true });
  const seoTitle = text(input.seoTitle ?? title, 'seo title', 200);
  const seoDescription = text(input.seoDescription ?? summary, 'seo description', 320, { allowEmpty: true });
  const normalized = {
    type: input.type,
    title,
    slug: input.slug,
    summary,
    blocks: input.blocks.map(validateBlock),
    seoTitle,
    seoDescription,
  };
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > maxContentBytes) {
    throw new ContentError('VALIDATION', 'content size');
  }
  return normalized;
}

function idempotencyKey(value) {
  if (typeof value !== 'string' || !idempotencyPattern.test(value)) {
    throw new ContentError('VALIDATION', 'idempotency key');
  }
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(operation, payload) {
  return createHash('sha256').update(`${operation}\n${canonicalJson(payload)}`, 'utf8').digest('hex');
}

function validatePublicModel(value) {
  const model = record(value, publicFields, 'public content');
  const id = positiveInteger(model.id, 'id');
  const content = validateContent({
    type: model.type,
    slug: model.slug,
    title: model.title,
    summary: model.summary,
    blocks: model.blocks,
    seoTitle: model.seoTitle,
    seoDescription: model.seoDescription,
  });
  if (typeof model.publishedAt !== 'string' || !Number.isFinite(Date.parse(model.publishedAt))) {
    throw new ContentError('VALIDATION', 'published date');
  }
  return { id, ...content, publishedAt: model.publishedAt };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

export function renderPublicContent(value) {
  const model = validatePublicModel(value);
  const blocks = model.blocks.map((block) => {
    if (block.type === 'paragraph') return `<p>${escapeHtml(block.text)}</p>`;
    if (block.type === 'heading') return `<h${block.level}>${escapeHtml(block.text)}</h${block.level}>`;
    const tag = block.ordered ? 'ol' : 'ul';
    return `<${tag}>${block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</${tag}>`;
  }).join('');
  return `<article data-content-type="${escapeHtml(model.type)}"><header><h1>${escapeHtml(model.title)}</h1>${model.summary ? `<p>${escapeHtml(model.summary)}</p>` : ''}</header><div>${blocks}</div></article>`;
}

function migrateReviewWorkflow(db) {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN IMMEDIATE');
  try {
    const columns = new Set(db.prepare('PRAGMA table_info(cms_content)').all().map((column) => column.name));
    if (!columns.has('review_status')) {
      db.exec("ALTER TABLE cms_content ADD COLUMN review_status TEXT NOT NULL DEFAULT 'none' CHECK(review_status IN ('none','pending','changes_requested'))");
    }
    if (!columns.has('submitted_by')) db.exec('ALTER TABLE cms_content ADD COLUMN submitted_by TEXT');
    if (!columns.has('submitted_at')) db.exec('ALTER TABLE cms_content ADD COLUMN submitted_at TEXT');

    const revisionSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='cms_revisions'").get()?.sql ?? '';
    if (!revisionSchema.includes("'submitted_for_review'")) {
      db.exec(`DROP TABLE IF EXISTS cms_revisions_rebuild;
        CREATE TABLE cms_revisions_rebuild (
          id INTEGER PRIMARY KEY,
          content_id INTEGER NOT NULL REFERENCES cms_content(id),
          version INTEGER NOT NULL CHECK(version > 0),
          action TEXT NOT NULL CHECK(action IN ('created','edited','submitted_for_review','returned_for_changes','published','archived')),
          actor_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
          UNIQUE(content_id, version)
        );
        INSERT INTO cms_revisions_rebuild(id,content_id,version,action,actor_id,created_at,snapshot_json)
          SELECT id,content_id,version,action,actor_id,created_at,snapshot_json FROM cms_revisions;
        DROP TABLE cms_revisions;
        ALTER TABLE cms_revisions_rebuild RENAME TO cms_revisions;`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS cms_content_review ON cms_content(review_status, updated_at DESC, id DESC);
      CREATE TRIGGER IF NOT EXISTS cms_revisions_no_update
        BEFORE UPDATE ON cms_revisions BEGIN SELECT RAISE(ABORT,'immutable content revisions'); END;
      CREATE TRIGGER IF NOT EXISTS cms_revisions_no_delete
        BEFORE DELETE ON cms_revisions BEGIN SELECT RAISE(ABORT,'immutable content revisions'); END;`);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve the migration error */ }
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

export class ContentService {
  #db;
  #now;

  constructor(path, { now = () => new Date().toISOString() } = {}) {
    if (typeof path !== 'string' || path.length === 0) throw new TypeError('database path required');
    if (typeof now !== 'function') throw new TypeError('clock');
    this.#db = new DatabaseSync(path);
    this.#db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
    migrateReviewWorkflow(this.#db);
    this.#now = now;
  }

  close() { this.#db.close(); }

  #transaction(callback) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* preserve the original error */ }
      if (error?.code?.startsWith?.('ERR_SQLITE_CONSTRAINT') || /UNIQUE constraint failed: cms_content\.(?:slug|published_slug)/.test(error?.message ?? '')) {
        throw new ContentError('CONFLICT', 'slug already exists');
      }
      throw error;
    }
  }

  #requireRole(actor, allowed) {
    const safe = safeActor(actor);
    if (!allowed.includes(safe.role)) throw new ContentError('FORBIDDEN', 'actor is not authorized');
    return safe;
  }

  #row(id) {
    return this.#db.prepare('SELECT * FROM cms_content WHERE id=?').get(id);
  }

  #managed(row) {
    const content = JSON.parse(row.working_json);
    return {
      id: row.id,
      type: row.content_type,
      slug: row.slug,
      status: row.status,
      version: row.version,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      publishedAt: row.published_at,
      reviewStatus: row.review_status,
      submittedAt: row.submitted_at,
      submittedBy: row.submitted_by,
      hasUnpublishedChanges: row.status === 'published' && row.working_json !== row.published_json,
      content,
    };
  }

  #canEdit(actor, row) {
    return actor.role === 'admin' || (actor.role === 'editor' && actor.id === row.created_by);
  }

  #visibleManaged(actor, row) {
    if (!row || (actor.role === 'editor' && actor.id !== row.created_by) || actor.role === 'reader') {
      throw new ContentError('NOT_FOUND', 'content not found');
    }
    return this.#managed(row);
  }

  #revision(rowId, version, action, actorId, createdAt, snapshot) {
    this.#db.prepare(
      'INSERT INTO cms_revisions(content_id,version,action,actor_id,created_at,snapshot_json) VALUES(?,?,?,?,?,?)',
    ).run(rowId, version, action, actorId, createdAt, JSON.stringify(snapshot));
  }

  #audit(rowId, version, action, actorId, createdAt) {
    this.#db.prepare(
      'INSERT INTO cms_audit(content_id,version,action,actor_id,created_at) VALUES(?,?,?,?,?)',
    ).run(rowId, version, action, actorId, createdAt);
  }

  #write(actorValue, operation, payload, keyValue, callback) {
    const actor = safeActor(actorValue);
    const key = idempotencyKey(keyValue);
    const digest = fingerprint(operation, payload);
    return this.#transaction(() => {
      const previous = this.#db.prepare(
        'SELECT fingerprint,response_json FROM cms_idempotency WHERE actor_id=? AND key=?',
      ).get(actor.id, key);
      if (previous) {
        if (previous.fingerprint !== digest) throw new ContentError('CONFLICT', 'idempotency key reused with different input');
        return JSON.parse(previous.response_json);
      }
      const response = callback(actor);
      this.#db.prepare(
        'INSERT INTO cms_idempotency(actor_id,key,fingerprint,response_json,created_at) VALUES(?,?,?,?,?)',
      ).run(actor.id, key, digest, JSON.stringify(response), this.#now());
      return response;
    });
  }

  createContent(actorValue, inputValue, key) {
    const actor = this.#requireRole(actorValue, ['admin', 'editor']);
    const content = validateContent(inputValue);
    return this.#write(actor, 'create', content, key, (writer) => {
      const now = this.#now();
      const result = this.#db.prepare(
        `INSERT INTO cms_content(content_type,slug,status,version,created_by,working_json,published_json,created_at,updated_at,published_at)
         VALUES(?,?,'draft',1,?,?,NULL,?,?,NULL)`,
      ).run(content.type, content.slug, writer.id, JSON.stringify(content), now, now);
      const id = Number(result.lastInsertRowid);
      const row = this.#row(id);
      this.#revision(id, 1, 'created', writer.id, now, content);
      this.#audit(id, 1, 'created', writer.id, now);
      return this.#managed(row);
    });
  }

  updateContent(actorValue, idValue, inputValue, versionValue, key) {
    const actor = this.#requireRole(actorValue, ['admin', 'editor']);
    const id = positiveInteger(idValue, 'id');
    const version = positiveInteger(versionValue, 'version');
    const content = validateContent(inputValue);
    return this.#write(actor, 'update', { id, version, content }, key, (writer) => {
      const row = this.#row(id);
      if (!row) throw new ContentError('NOT_FOUND', 'content not found');
      if (!this.#canEdit(writer, row)) throw new ContentError('NOT_FOUND', 'content not found');
      if (row.version !== version) throw new ContentError('CONFLICT', 'version conflict');
      const now = this.#now();
      const nextVersion = row.version + 1;
      const nextStatus = row.status === 'archived' ? 'draft' : row.status;
      const publishedJson = nextStatus === 'published' ? row.published_json : null;
      const publishedAt = nextStatus === 'published' ? row.published_at : null;
      this.#db.prepare(
        `UPDATE cms_content SET content_type=?,slug=?,status=?,version=?,working_json=?,published_json=?,updated_at=?,published_at=?,review_status='none',submitted_by=NULL,submitted_at=NULL WHERE id=? AND version=?`,
      ).run(content.type, content.slug, nextStatus, nextVersion, JSON.stringify(content), publishedJson, now, publishedAt, id, version);
      this.#revision(id, nextVersion, 'edited', writer.id, now, content);
      this.#audit(id, nextVersion, 'edited', writer.id, now);
      return this.#managed(this.#row(id));
    });
  }

  submitForReview(actorValue, idValue, versionValue, key) {
    const actor = this.#requireRole(actorValue, ['admin', 'editor']);
    const id = positiveInteger(idValue, 'id');
    const version = positiveInteger(versionValue, 'version');
    return this.#write(actor, 'submit-review', { id, version }, key, (writer) => {
      const row = this.#row(id);
      if (!row) throw new ContentError('NOT_FOUND', 'content not found');
      if (!this.#canEdit(writer, row)) throw new ContentError('NOT_FOUND', 'content not found');
      if (row.version !== version) throw new ContentError('CONFLICT', 'version conflict');
      if (row.status === 'archived') throw new ContentError('CONFLICT', 'archived content must be restored by an editor first');
      if (row.review_status === 'pending') throw new ContentError('CONFLICT', 'content is already awaiting review');
      if (row.status === 'published' && row.working_json === row.published_json) {
        throw new ContentError('CONFLICT', 'content has no unpublished changes to review');
      }
      const now = this.#now();
      const nextVersion = row.version + 1;
      const snapshot = JSON.parse(row.working_json);
      this.#db.prepare(
        `UPDATE cms_content SET review_status='pending',submitted_by=?,submitted_at=?,version=?,updated_at=? WHERE id=? AND version=?`,
      ).run(writer.id, now, nextVersion, now, id, version);
      this.#revision(id, nextVersion, 'submitted_for_review', writer.id, now, snapshot);
      this.#audit(id, nextVersion, 'submitted_for_review', writer.id, now);
      return this.#managed(this.#row(id));
    });
  }

  returnForChanges(actorValue, idValue, versionValue, key) {
    const actor = this.#requireRole(actorValue, ['admin', 'publisher']);
    const id = positiveInteger(idValue, 'id');
    const version = positiveInteger(versionValue, 'version');
    return this.#write(actor, 'return-for-changes', { id, version }, key, (reviewer) => {
      const row = this.#row(id);
      if (!row) throw new ContentError('NOT_FOUND', 'content not found');
      if (row.version !== version) throw new ContentError('CONFLICT', 'version conflict');
      if (row.review_status !== 'pending') throw new ContentError('CONFLICT', 'content is not awaiting review');
      const now = this.#now();
      const nextVersion = row.version + 1;
      const snapshot = JSON.parse(row.working_json);
      this.#db.prepare(
        `UPDATE cms_content SET review_status='changes_requested',submitted_by=NULL,submitted_at=NULL,version=?,updated_at=? WHERE id=? AND version=?`,
      ).run(nextVersion, now, id, version);
      this.#revision(id, nextVersion, 'returned_for_changes', reviewer.id, now, snapshot);
      this.#audit(id, nextVersion, 'returned_for_changes', reviewer.id, now);
      return this.#managed(this.#row(id));
    });
  }

  publishContent(actorValue, idValue, versionValue, key) {
    const actor = this.#requireRole(actorValue, ['admin', 'publisher']);
    const id = positiveInteger(idValue, 'id');
    const version = positiveInteger(versionValue, 'version');
    return this.#write(actor, 'publish', { id, version }, key, (publisher) => {
      const row = this.#row(id);
      if (!row) throw new ContentError('NOT_FOUND', 'content not found');
      if (row.status === 'archived') throw new ContentError('CONFLICT', 'archived content must be restored by an editor first');
      if (row.version !== version) throw new ContentError('CONFLICT', 'version conflict');
      if (row.review_status !== 'pending') throw new ContentError('CONFLICT', 'content must be submitted for review before publication');
      const now = this.#now();
      const nextVersion = row.version + 1;
      const working = validateContent(JSON.parse(row.working_json));
      this.#db.prepare(
        `UPDATE cms_content SET status='published',review_status='none',submitted_by=NULL,submitted_at=NULL,version=?,published_slug=slug,published_json=working_json,updated_at=?,published_at=? WHERE id=? AND version=?`,
      ).run(nextVersion, now, now, id, version);
      this.#revision(id, nextVersion, 'published', publisher.id, now, working);
      this.#audit(id, nextVersion, 'published', publisher.id, now);
      return this.#managed(this.#row(id));
    });
  }

  archiveContent(actorValue, idValue, versionValue, key) {
    const actor = this.#requireRole(actorValue, ['admin', 'publisher']);
    const id = positiveInteger(idValue, 'id');
    const version = positiveInteger(versionValue, 'version');
    return this.#write(actor, 'archive', { id, version }, key, (publisher) => {
      const row = this.#row(id);
      if (!row) throw new ContentError('NOT_FOUND', 'content not found');
      if (row.version !== version) throw new ContentError('CONFLICT', 'version conflict');
      if (row.status === 'archived') throw new ContentError('CONFLICT', 'content already archived');
      const now = this.#now();
      const nextVersion = row.version + 1;
      const snapshot = JSON.parse(row.working_json);
      this.#db.prepare(
        `UPDATE cms_content SET status='archived',review_status='none',submitted_by=NULL,submitted_at=NULL,version=?,published_slug=NULL,published_json=NULL,updated_at=?,published_at=NULL WHERE id=? AND version=?`,
      ).run(nextVersion, now, id, version);
      this.#revision(id, nextVersion, 'archived', publisher.id, now, snapshot);
      this.#audit(id, nextVersion, 'archived', publisher.id, now);
      return this.#managed(this.#row(id));
    });
  }

  getManaged(actorValue, idValue) {
    const actor = safeActor(actorValue);
    if (!['admin', 'editor', 'publisher'].includes(actor.role)) throw new ContentError('FORBIDDEN', 'actor is not authorized');
    const id = positiveInteger(idValue, 'id');
    return this.#visibleManaged(actor, this.#row(id));
  }

  listManaged(actorValue, options = {}) {
    const actor = safeActor(actorValue);
    if (!['admin', 'editor', 'publisher'].includes(actor.role)) throw new ContentError('FORBIDDEN', 'actor is not authorized');
    record(options, ['limit', 'offset', 'type', 'status'], 'list options');
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) {
      throw new ContentError('VALIDATION', 'pagination');
    }
    if (options.type !== undefined && !contentTypes.has(options.type)) throw new ContentError('VALIDATION', 'content type');
    if (options.status !== undefined && !['draft', 'published', 'archived'].includes(options.status)) throw new ContentError('VALIDATION', 'status');
    const where = [];
    const params = [];
    if (actor.role === 'editor') { where.push('created_by=?'); params.push(actor.id); }
    if (options.type !== undefined) { where.push('content_type=?'); params.push(options.type); }
    if (options.status !== undefined) { where.push('status=?'); params.push(options.status); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = this.#db.prepare(
      `SELECT * FROM cms_content ${clause} ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset);
    return rows.map((row) => this.#managed(row));
  }

  getPublished(slugValue) {
    if (typeof slugValue !== 'string' || !slugPattern.test(slugValue)) throw new ContentError('VALIDATION', 'slug');
    const row = this.#db.prepare(
      `SELECT id,content_type,published_slug,published_json,published_at FROM cms_content WHERE published_slug=? AND status='published'`,
    ).get(slugValue);
    if (!row) return null;
    const content = validateContent(JSON.parse(row.published_json));
    return validatePublicModel({ id: row.id, ...content, publishedAt: row.published_at });
  }

  listPublished(options = {}) {
    record(options, ['limit', 'offset', 'type'], 'list options');
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) {
      throw new ContentError('VALIDATION', 'pagination');
    }
    if (options.type !== undefined && !contentTypes.has(options.type)) throw new ContentError('VALIDATION', 'content type');
    const typeFilter = options.type === undefined ? '' : ' AND content_type=?';
    const params = options.type === undefined ? [limit, offset] : [options.type, limit, offset];
    const rows = this.#db.prepare(
      `SELECT id,content_type,slug,published_json,published_at FROM cms_content WHERE status='published'${typeFilter} ORDER BY published_at DESC,id DESC LIMIT ? OFFSET ?`,
    ).all(...params);
    return rows.map((row) => validatePublicModel({
      id: row.id,
      ...validateContent(JSON.parse(row.published_json)),
      publishedAt: row.published_at,
    }));
  }

  listRevisions(actorValue, idValue) {
    const actor = safeActor(actorValue);
    if (!['admin', 'editor', 'publisher'].includes(actor.role)) throw new ContentError('FORBIDDEN', 'actor is not authorized');
    const row = this.#row(positiveInteger(idValue, 'id'));
    this.#visibleManaged(actor, row);
    return this.#db.prepare(
      'SELECT id,content_id,version,action,actor_id,created_at,snapshot_json FROM cms_revisions WHERE content_id=? ORDER BY version DESC',
    ).all(row.id).map((revision) => ({
      id: revision.id,
      contentId: revision.content_id,
      version: revision.version,
      action: revision.action,
      actorId: revision.actor_id,
      createdAt: revision.created_at,
      content: JSON.parse(revision.snapshot_json),
    }));
  }
}
