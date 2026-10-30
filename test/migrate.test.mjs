import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('a version 1 database is upgraded in place without losing memories', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'deja-mig-')), 'deja.db');
  process.env.DEJA_DB = path;
  process.removeAllListeners('warning');
  const { DatabaseSync } = await import('node:sqlite');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE memories (id INTEGER PRIMARY KEY, project TEXT NOT NULL, session_id TEXT, kind TEXT NOT NULL, title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '', signature TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    hits INTEGER NOT NULL DEFAULT 0, stale INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE anchors (memory_id INTEGER NOT NULL, path TEXT NOT NULL, hash TEXT, PRIMARY KEY (memory_id, path));
    INSERT INTO memories (project, kind, title, created_at, updated_at) VALUES ('/r', 'note', 'kept', 1, 1);
    INSERT INTO anchors VALUES (1, 'a.txt', 'abc');
    PRAGMA user_version = 1;`);
  old.close();
  const { openDb } = await import('../src/db.mjs');
  const db = openDb(path);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(db.prepare('SELECT title FROM memories').get().title, 'kept');
  assert.deepEqual(Object.keys(db.prepare('SELECT * FROM anchors').get()), ['memory_id', 'path', 'hash', 'mtime', 'size']);
});
