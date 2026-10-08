-- SPDX-License-Identifier: GPL-3.0-or-later
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS cms_content (
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
  review_status TEXT NOT NULL DEFAULT 'none' CHECK(review_status IN ('none','pending','changes_requested')),
  submitted_by TEXT,
  submitted_at TEXT,
  CHECK(
    (status = 'published' AND published_slug IS NOT NULL AND published_json IS NOT NULL AND published_at IS NOT NULL)
    OR (status IN ('draft','archived') AND published_slug IS NULL AND published_json IS NULL AND published_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS cms_content_publication
  ON cms_content(status, content_type, published_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS cms_content_public_slug
  ON cms_content(published_slug) WHERE status = 'published';
CREATE INDEX IF NOT EXISTS cms_content_owner
  ON cms_content(created_by, updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS cms_revisions (
  id INTEGER PRIMARY KEY,
  content_id INTEGER NOT NULL REFERENCES cms_content(id),
  version INTEGER NOT NULL CHECK(version > 0),
  action TEXT NOT NULL CHECK(action IN ('created','edited','submitted_for_review','returned_for_changes','published','archived')),
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  UNIQUE(content_id, version)
);

CREATE TABLE IF NOT EXISTS cms_audit (
  id INTEGER PRIMARY KEY,
  content_id INTEGER NOT NULL REFERENCES cms_content(id),
  version INTEGER NOT NULL,
  action TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cms_idempotency (
  actor_id TEXT NOT NULL,
  key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  response_json TEXT NOT NULL CHECK(json_valid(response_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(actor_id, key)
);

CREATE TRIGGER IF NOT EXISTS cms_revisions_no_update
  BEFORE UPDATE ON cms_revisions BEGIN SELECT RAISE(ABORT,'immutable content revisions'); END;
CREATE TRIGGER IF NOT EXISTS cms_revisions_no_delete
  BEFORE DELETE ON cms_revisions BEGIN SELECT RAISE(ABORT,'immutable content revisions'); END;
CREATE TRIGGER IF NOT EXISTS cms_audit_no_update
  BEFORE UPDATE ON cms_audit BEGIN SELECT RAISE(ABORT,'immutable content audit'); END;
CREATE TRIGGER IF NOT EXISTS cms_audit_no_delete
  BEFORE DELETE ON cms_audit BEGIN SELECT RAISE(ABORT,'immutable content audit'); END;
