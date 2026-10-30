// Storage layer. One SQLite file, opened per process, no daemon.
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// node:sqlite prints an ExperimentalWarning on load; hooks must keep stderr quiet.
process.removeAllListeners('warning');
const { DatabaseSync } = await import('node:sqlite');

export function dejaHome() {
  return process.env.DEJA_HOME || join(homedir(), '.deja');
}

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  prompts INTEGER NOT NULL DEFAULT 0,
  last_message TEXT,
  first_prompt TEXT,
  injected TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY,
  project TEXT NOT NULL,
  session_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  signature TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  stale INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS memories_project ON memories(project, kind, created_at);
CREATE INDEX IF NOT EXISTS memories_signature ON memories(signature);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  title, body, tags, content='memories', content_rowid='id',
  tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF title, body, tags ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags);
  INSERT INTO memories_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
END;

-- A memory pinned to the content hash of the files it talks about.
CREATE TABLE IF NOT EXISTS anchors (
  memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  hash TEXT,
  PRIMARY KEY (memory_id, path)
);
CREATE INDEX IF NOT EXISTS anchors_path ON anchors(path);

-- Failures waiting for the command that fixes them.
CREATE TABLE IF NOT EXISTS failures (
  id INTEGER PRIMARY KEY,
  project TEXT NOT NULL,
  session_id TEXT,
  signature TEXT NOT NULL,
  family TEXT NOT NULL,
  command TEXT NOT NULL,
  error TEXT NOT NULL,
  mark INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS failures_open ON failures(session_id, resolved);

-- Files touched in a session, in order, so a fix can say what changed.
CREATE TABLE IF NOT EXISTS touches (
  session_id TEXT NOT NULL,
  path TEXT NOT NULL,
  tool TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS touches_session ON touches(session_id, at);

-- Data lineage: datasets, their columns, and the files that read and write them.
CREATE TABLE IF NOT EXISTS datasets (
  project TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  columns TEXT,
  file TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project, name)
);
CREATE TABLE IF NOT EXISTS edges (
  project TEXT NOT NULL,
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  file TEXT NOT NULL,
  op TEXT NOT NULL,
  PRIMARY KEY (project, src, dst, file)
);
CREATE INDEX IF NOT EXISTS edges_dst ON edges(project, dst);
`;

let cached;

export function openDb(path = process.env.DEJA_DB || join(dejaHome(), 'deja.db')) {
  if (cached && cached.path === path) return cached.db;
  if (path !== ':memory:') mkdirSync(join(path, '..'), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;');
  const { user_version } = db.prepare('PRAGMA user_version').get();
  if (user_version < SCHEMA_VERSION) {
    db.exec(SCHEMA);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
  cached = { path, db };
  return db;
}

export function closeDb() {
  if (cached) {
    cached.db.close();
    cached = undefined;
  }
}

export function tx(db, fn) {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
