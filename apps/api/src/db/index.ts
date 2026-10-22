import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL UNIQUE,
  repo_url            TEXT NOT NULL,
  production_branch   TEXT NOT NULL,
  framework           TEXT,             -- NULL = auto-detect on every build
  install_command     TEXT,
  build_command       TEXT,
  output_directory    TEXT,
  root_directory      TEXT NOT NULL DEFAULT '',
  auto_promote_paused INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS env_vars (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  targets    TEXT NOT NULL DEFAULT 'production,preview',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, key)
);

CREATE TABLE IF NOT EXISTS deployments (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target         TEXT NOT NULL CHECK (target IN ('production', 'preview')),
  branch         TEXT NOT NULL,
  ref            TEXT NOT NULL,
  commit_sha     TEXT,
  commit_message TEXT,
  commit_author  TEXT,
  status         TEXT NOT NULL CHECK (status IN ('queued', 'building', 'ready', 'error', 'canceled')),
  trigger        TEXT NOT NULL,
  framework      TEXT,
  error_message  TEXT,
  builder        TEXT,
  created_at     INTEGER NOT NULL,
  started_at     INTEGER,
  finished_at    INTEGER
);
CREATE INDEX IF NOT EXISTS deployments_project_idx ON deployments(project_id, created_at DESC);

-- A hostname label (e.g. "my-app" or "my-app-git-feature-x") pointing at one deployment.
-- Promotion and rollback are a single-row UPDATE here: atomic, instant, no rebuild.
CREATE TABLE IF NOT EXISTS aliases (
  hostname      TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('production', 'branch')),
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS alias_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  deployment_id TEXT NOT NULL,
  action        TEXT NOT NULL CHECK (action IN ('auto', 'promote', 'rollback')),
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS branch_heads (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  branch     TEXT NOT NULL,
  sha        TEXT NOT NULL,
  PRIMARY KEY (project_id, branch)
);
`;

export type Db = DatabaseSync;

/** Columns added after the first release: [table, column, definition]. */
const ADDED_COLUMNS: [string, string, string][] = [
  ["deployments", "use_cache", "INTEGER NOT NULL DEFAULT 1"],
  ["deployments", "cache_status", "TEXT"],
];

function addMissingColumns(db: Db): void {
  for (const [table, column, definition] of ADDED_COLUMNS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (columns.some((c) => c.name === column)) continue;
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    } catch (err) {
      // The control plane and the edge open the DB at the same time; the other may have won.
      if (!/duplicate column/i.test((err as Error).message)) throw err;
    }
  }
}

/** Opens (and migrates) the database. Both the control plane and the edge call this. */
export function openDb(dbPath: string): Db {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  // WAL lets the edge read concurrently while the control plane writes.
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  addMissingColumns(db);
  return db;
}

/** Run `fn` inside a transaction (BEGIN IMMEDIATE so writers serialize cleanly). */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
