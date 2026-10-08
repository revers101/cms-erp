// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OperationsService } from '../service-operations/engine.mjs';
import {
  ContentError,
  ContentService,
  renderPublicContent,
  validateContent,
} from './engine.mjs';

const admin = { id: 1, role: 'admin' };
const editor = { id: 2, role: 'editor' };
const otherEditor = { id: 3, role: 'editor' };
const publisher = { id: 4, role: 'publisher' };
const reader = { id: 5, role: 'reader' };

function article(overrides = {}) {
  return {
    type: 'article',
    title: 'Installatie & onderhoud',
    slug: 'installatie-onderhoud',
    summary: 'Praktische uitleg voor klanten.',
    blocks: [
      { type: 'heading', level: 2, text: 'Voorbereiding' },
      { type: 'paragraph', text: 'Controleer eerst de meterkast.' },
      { type: 'list', ordered: true, items: ['Schakel uit', 'Controleer spanning'] },
    ],
    seoTitle: 'Installatie en onderhoud',
    seoDescription: 'Lees de uitleg.',
    ...overrides,
  };
}

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'cms-content-'));
  let seconds = 0;
  const service = new ContentService(join(directory, 'content.sqlite'), {
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds++)).toISOString(),
  });
  t.after(() => {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return service;
}

test('content models accept only supported types, fields, slugs and safe blocks', () => {
  assert.equal(validateContent(article()).blocks.length, 3);
  assert.throws(() => validateContent(article({ type: 'product' })), /content type/);
  assert.throws(() => validateContent(article({ slug: '../admin' })), /slug/);
  assert.throws(() => validateContent(article({ extra: 'private' })), /content field/);
  assert.throws(() => validateContent(article({ blocks: [{ type: 'html', html: '<script>x</script>' }] })), /block field/);
  assert.throws(() => validateContent(article({ blocks: [{ type: 'paragraph', text: 'bad\u202econtrol' }] })), /block text/);
  assert.throws(() => validateContent(article({ blocks: [] })), /blocks/);
});

test('strict record validation rejects accessors without executing them', () => {
  let invoked = false;
  const hostile = article();
  Object.defineProperty(hostile, 'slug', { enumerable: true, get() { invoked = true; return 'unsafe'; } });
  assert.throws(() => validateContent(hostile), /field/);
  assert.equal(invoked, false);
  const block = { type: 'paragraph' };
  Object.defineProperty(block, 'text', { enumerable: true, get() { invoked = true; return 'unsafe'; } });
  assert.throws(() => validateContent(article({ blocks: [block] })), /field/);
  assert.equal(invoked, false);
});

test('editor drafts become public only after publisher approval; public model excludes internal fields', (t) => {
  const cms = setup(t);
  const draft = cms.createContent(editor, article(), 'create-article-01');
  assert.equal(draft.status, 'draft');
  assert.equal(draft.reviewStatus, 'none');
  assert.equal(cms.getPublished(draft.slug), null);
  assert.throws(() => cms.publishContent(publisher, draft.id, draft.version, 'publish-without-review'), /submitted for review/);
  const submitted = cms.submitForReview(editor, draft.id, draft.version, 'submit-article-01');
  assert.equal(submitted.reviewStatus, 'pending');
  assert.equal(submitted.submittedBy, String(editor.id));
  assert.equal(cms.getPublished(draft.slug), null);
  const live = cms.publishContent(publisher, draft.id, submitted.version, 'publish-article-01');
  assert.equal(live.status, 'published');
  assert.equal(live.reviewStatus, 'none');
  const published = cms.getPublished(draft.slug);
  assert.equal(published.title, 'Installatie & onderhoud');
  assert.deepEqual(Object.keys(published).sort(), [
    'blocks', 'id', 'publishedAt', 'seoDescription', 'seoTitle', 'slug', 'summary', 'title', 'type',
  ].sort());
  assert.equal(Object.hasOwn(published, 'createdBy'), false);
  assert.equal(Object.hasOwn(published, 'version'), false);
  assert.equal(cms.listRevisions(admin, draft.id).length, 3);
});

test('review can be returned, corrected and resubmitted without exposing draft content', (t) => {
  const cms = setup(t);
  const draft = cms.createContent(editor, article(), 'create-review-001');
  const submitted = cms.submitForReview(editor, draft.id, draft.version, 'submit-review-001');
  const replay = cms.submitForReview(editor, draft.id, draft.version, 'submit-review-001');
  assert.equal(replay.version, submitted.version);
  assert.equal(cms.getPublished(draft.slug), null);
  assert.throws(() => cms.returnForChanges(editor, draft.id, submitted.version, 'return-review-denied'), /not authorized/);
  const returned = cms.returnForChanges(publisher, draft.id, submitted.version, 'return-review-001');
  assert.equal(returned.reviewStatus, 'changes_requested');
  assert.equal(cms.getPublished(draft.slug), null);
  const corrected = cms.updateContent(editor, draft.id, article({ title: 'Aangepaste uitleg' }), returned.version, 'edit-review-001');
  assert.equal(corrected.reviewStatus, 'none');
  const resubmitted = cms.submitForReview(editor, draft.id, corrected.version, 'submit-review-002');
  assert.equal(resubmitted.reviewStatus, 'pending');
  const live = cms.publishContent(publisher, draft.id, resubmitted.version, 'publish-review-001');
  assert.equal(live.reviewStatus, 'none');
  assert.equal(cms.getPublished(draft.slug).title, 'Aangepaste uitleg');
  assert.deepEqual(cms.listRevisions(admin, draft.id).map((revision) => revision.action), [
    'published', 'submitted_for_review', 'edited', 'returned_for_changes', 'submitted_for_review', 'created',
  ]);
});

test('public rendering validates a closed model and escapes all text', () => {
  const publicModel = {
    id: 1,
    ...article({
      title: '<script>alert(1)</script>',
      summary: 'A & B',
      blocks: [{ type: 'paragraph', text: '<img src=x onerror=alert(1)>' }],
    }),
    publishedAt: '2026-01-01T00:00:00.000Z',
  };
  const html = renderPublicContent(publicModel);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /A &amp; B/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<script|<img/);
  assert.throws(() => renderPublicContent({ ...publicModel, audit: [] }), /public content field/);
});

test('editing a published item preserves the previous live snapshot until republished', (t) => {
  const cms = setup(t);
  const created = cms.createContent(editor, article(), 'create-live-001');
  const firstReview = cms.submitForReview(editor, created.id, created.version, 'submit-live-001');
  const live = cms.publishContent(admin, created.id, firstReview.version, 'publish-live-001');
  const edited = cms.updateContent(
    editor,
    live.id,
    article({ slug: 'onderhoud-update', title: 'Bijgewerkte titel' }),
    live.version,
    'edit-live-001',
  );
  assert.equal(edited.status, 'published');
  assert.equal(edited.hasUnpublishedChanges, true);
  assert.equal(cms.getPublished('installatie-onderhoud').title, 'Installatie & onderhoud');
  assert.equal(cms.getPublished('onderhoud-update'), null);
  const updateReview = cms.submitForReview(editor, edited.id, edited.version, 'submit-live-002');
  assert.equal(updateReview.reviewStatus, 'pending');
  assert.equal(cms.getPublished('installatie-onderhoud').title, 'Installatie & onderhoud');
  const updatedLive = cms.publishContent(publisher, edited.id, updateReview.version, 'publish-live-002');
  assert.equal(updatedLive.hasUnpublishedChanges, false);
  assert.equal(cms.getPublished('installatie-onderhoud'), null);
  assert.equal(cms.getPublished('onderhoud-update').title, 'Bijgewerkte titel');
});

test('a live slug stays reserved until the new version is published', (t) => {
  const cms = setup(t);
  const created = cms.createContent(editor, article(), 'create-reserve-01');
  const firstReview = cms.submitForReview(editor, created.id, created.version, 'submit-reserve-01');
  const live = cms.publishContent(admin, created.id, firstReview.version, 'publish-reserve-01');
  const edited = cms.updateContent(editor, live.id, article({ slug: 'new-slug' }), live.version, 'edit-reserve-01');
  const replacement = cms.createContent(editor, article({ type: 'page', slug: 'installatie-onderhoud' }), 'create-replace-01');
  const replacementReview = cms.submitForReview(editor, replacement.id, replacement.version, 'submit-replace-01');
  assert.throws(() => cms.publishContent(admin, replacement.id, replacementReview.version, 'publish-replace-01'), /slug already exists/);
  assert.equal(cms.getPublished('installatie-onderhoud').title, 'Installatie & onderhoud');
  assert.equal(cms.getManaged(editor, edited.id).hasUnpublishedChanges, true);
});

test('an editor cannot read or edit another author’s drafts', (t) => {
  const cms = setup(t);
  const draft = cms.createContent(editor, article(), 'create-owner-001');
  assert.throws(() => cms.getManaged(otherEditor, draft.id), /content not found/);
  assert.throws(() => cms.updateContent(otherEditor, draft.id, article(), draft.version, 'edit-owner-001'), /content not found/);
  assert.deepEqual(cms.listManaged(otherEditor), []);
  assert.throws(() => cms.listManaged(reader), /not authorized/);
});

test('readers see published content but cannot see drafts or revisions', (t) => {
  const cms = setup(t);
  const draft = cms.createContent(editor, article(), 'create-reader-001');
  assert.deepEqual(cms.listPublished(), []);
  assert.throws(() => cms.getManaged(reader, draft.id), /not authorized/);
  const submitted = cms.submitForReview(editor, draft.id, draft.version, 'submit-reader-01');
  const live = cms.publishContent(publisher, draft.id, submitted.version, 'publish-reader-01');
  assert.equal(cms.listPublished({ type: 'article' })[0].id, live.id);
  assert.equal(cms.getPublished(draft.slug).id, live.id);
});

test('version checks reject stale writes and idempotency prevents duplicate revisions', (t) => {
  const cms = setup(t);
  const first = cms.createContent(editor, article(), 'create-idem-001');
  const repeated = cms.createContent(editor, article(), 'create-idem-001');
  assert.equal(repeated.id, first.id);
  assert.equal(cms.listRevisions(admin, first.id).length, 1);
  assert.throws(() => cms.createContent(editor, article({ slug: 'different' }), 'create-idem-001'), /idempotency key reused/);
  const updated = cms.updateContent(editor, first.id, article({ title: 'Nieuwe titel' }), first.version, 'update-idem-001');
  assert.equal(updated.version, 2);
  assert.throws(() => cms.updateContent(editor, first.id, article(), first.version, 'update-stale-001'), /version conflict/);
  assert.equal(cms.listRevisions(admin, first.id).length, 2);
});

test('archiving removes public visibility and an authorized edit restores a draft', (t) => {
  const cms = setup(t);
  const draft = cms.createContent(editor, article(), 'create-archive-1');
  const submitted = cms.submitForReview(editor, draft.id, draft.version, 'submit-archive-1');
  const live = cms.publishContent(admin, draft.id, submitted.version, 'publish-archive-1');
  const archived = cms.archiveContent(publisher, live.id, live.version, 'archive-live-001');
  assert.equal(archived.status, 'archived');
  assert.equal(cms.getPublished(draft.slug), null);
  const restored = cms.updateContent(editor, archived.id, article({ title: 'Herzien' }), archived.version, 'restore-draft-001');
  assert.equal(restored.status, 'draft');
  assert.equal(cms.getPublished(draft.slug), null);
  assert.equal(cms.listRevisions(admin, draft.id)[0].action, 'edited');
});

test('list filters and bounds are validated', (t) => {
  const cms = setup(t);
  cms.createContent(editor, article(), 'create-list-0001');
  cms.createContent(admin, article({ type: 'faq', slug: 'veelgestelde-vraag' }), 'create-list-0002');
  assert.equal(cms.listManaged(admin, { type: 'faq', status: 'draft' }).length, 1);
  assert.equal(cms.listPublished({ type: 'page' }).length, 0);
  assert.throws(() => cms.listManaged(admin, { limit: 101 }), /pagination/);
  assert.throws(() => cms.listPublished({ status: 'draft' }), /list options field/);
});

test('idempotency key, actor and version inputs reject malformed values', (t) => {
  const cms = setup(t);
  assert.throws(() => cms.createContent({ id: 0, role: 'admin' }, article(), 'create-invalid-01'), /actor/);
  assert.throws(() => cms.createContent(editor, article(), 'short'), /idempotency key/);
  assert.throws(() => cms.publishContent(publisher, 1, 0, 'publish-invalid-01'), /version/);
  assert.throws(() => cms.getPublished('../draft'), /slug/);
  assert.throws(() => cms.createContent({ id: 2, role: 'reader' }, article(), 'create-invalid-02'), /not authorized/);
});

test('CMS and ERP schemas coexist in one private SQLite database', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cms-erp-shared-db-'));
  const path = join(directory, 'application.sqlite');
  const erp = new OperationsService(path);
  const cms = new ContentService(path);
  t.after(() => {
    cms.close();
    erp.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const customer = erp.createCustomer(admin, { name: 'Voorbeeld', type: 'b2c' }, 'erp-create-customer-1');
  const page = cms.createContent(editor, article({ type: 'page', slug: 'home' }), 'cms-create-home-01');
  assert.equal(erp.get(admin, 'customers', customer.id).name, 'Voorbeeld');
  assert.equal(cms.getManaged(editor, page.id).slug, 'home');
});

test('review migration preserves legacy content and immutable revisions', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cms-review-migration-'));
  const path = join(directory, 'legacy.sqlite');
  const legacy = new DatabaseSync(path);
  const snapshot = JSON.stringify(article());
  legacy.exec(`
    CREATE TABLE cms_content (
      id INTEGER PRIMARY KEY,
      content_type TEXT NOT NULL CHECK(content_type IN ('page','article','service','project','faq')),
      slug TEXT NOT NULL UNIQUE,
      published_slug TEXT UNIQUE,
      status TEXT NOT NULL CHECK(status IN ('draft','published','archived')),
      version INTEGER NOT NULL CHECK(version > 0),
      created_by TEXT NOT NULL,
      working_json TEXT NOT NULL CHECK(json_valid(working_json)),
      published_json TEXT CHECK(published_json IS NULL OR json_valid(published_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      published_at TEXT,
      CHECK((status='published' AND published_slug IS NOT NULL AND published_json IS NOT NULL AND published_at IS NOT NULL)
        OR (status IN ('draft','archived') AND published_slug IS NULL AND published_json IS NULL AND published_at IS NULL))
    );
    CREATE TABLE cms_revisions (
      id INTEGER PRIMARY KEY,
      content_id INTEGER NOT NULL REFERENCES cms_content(id),
      version INTEGER NOT NULL CHECK(version > 0),
      action TEXT NOT NULL CHECK(action IN ('created','edited','published','archived')),
      actor_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
      UNIQUE(content_id,version)
    );
  `);
  legacy.prepare(`INSERT INTO cms_content(id,content_type,slug,status,version,created_by,working_json,created_at,updated_at)
    VALUES(1,'article','installatie-onderhoud','draft',1,?,?,?,?)`).run(String(editor.id), snapshot, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  legacy.prepare(`INSERT INTO cms_revisions(content_id,version,action,actor_id,created_at,snapshot_json)
    VALUES(1,1,'created',?,'2026-01-01T00:00:00.000Z',?)`).run(String(editor.id), snapshot);
  legacy.close();

  const cms = new ContentService(path);
  t.after(() => { cms.close(); rmSync(directory, { recursive: true, force: true }); });
  const migrated = cms.getManaged(editor, 1);
  assert.equal(migrated.reviewStatus, 'none');
  assert.equal(migrated.content.title, 'Installatie & onderhoud');
  assert.equal(cms.listRevisions(admin, 1)[0].action, 'created');
  const submitted = cms.submitForReview(editor, 1, migrated.version, 'migrate-review-001');
  assert.equal(submitted.reviewStatus, 'pending');
  assert.equal(cms.listRevisions(admin, 1)[0].action, 'submitted_for_review');
});
