// Memory operations shared by the hooks, the MCP server and the CLI.
import { resolve, isAbsolute } from 'node:path';
import { openDb, tx } from './db.mjs';
import { redact } from './redact.mjs';
import { fileStat, hashFile, now, relPath } from './util.mjs';

export const KINDS = ['decision', 'gotcha', 'fix', 'note', 'todo', 'summary'];

// Kinds that are worth surfacing on their own; prompts and summaries are context.
const KIND_WEIGHT = { fix: 1.4, gotcha: 1.4, decision: 1.3, todo: 1.1, note: 1.0, summary: 0.7 };

export function addMemory({ project, sessionId = null, kind = 'note', title, body = '', tags = [], files = [], signature = null }) {
  const db = openDb();
  const t = now();
  title = redact(title).trim();
  body = redact(body).trim();
  if (!title) throw new Error('title is required');
  const tagStr = (Array.isArray(tags) ? tags : String(tags).split(/[,\s]+/)).filter(Boolean).join(' ');
  return tx(db, () => {
    // Same title in the same project is an update, not a duplicate.
    const existing = db.prepare('SELECT id FROM memories WHERE project = ? AND kind = ? AND title = ?').get(project, kind, title);
    let id;
    if (existing) {
      id = existing.id;
      db.prepare('UPDATE memories SET body = ?, tags = ?, updated_at = ?, stale = 0, signature = COALESCE(?, signature) WHERE id = ?').run(body, tagStr, t, signature, id);
      db.prepare('DELETE FROM anchors WHERE memory_id = ?').run(id);
    } else {
      id = Number(
        db.prepare('INSERT INTO memories (project, session_id, kind, title, body, tags, signature, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(project, sessionId, kind, title, body, tagStr, signature, t, t).lastInsertRowid,
      );
    }
    anchor(db, id, project, files);
    return id;
  });
}

function anchor(db, id, project, files) {
  const ins = db.prepare('INSERT OR REPLACE INTO anchors (memory_id, path, hash, mtime, size) VALUES (?, ?, ?, ?, ?)');
  for (const f of [...new Set(files)].slice(0, 20)) {
    const abs = isAbsolute(f) ? f : resolve(project, f);
    const st = fileStat(abs);
    ins.run(id, relPath(project, abs), hashFile(abs), st?.mtime ?? null, st?.size ?? null);
  }
}

/**
 * Flags memories whose anchored files changed since they were written. Runs lazily
 * (at session start and on recall), never in the background.
 */
export function refreshStaleness(project, limit = 400) {
  const db = openDb();
  const rows = db.prepare(`
    SELECT a.memory_id, a.path, a.hash, a.mtime, a.size, m.stale FROM anchors a JOIN memories m ON m.id = a.memory_id
    WHERE m.project = ? AND a.hash IS NOT NULL ORDER BY m.updated_at DESC LIMIT ?`).all(project, limit);
  const touch = db.prepare('UPDATE anchors SET mtime = ?, size = ? WHERE memory_id = ? AND path = ?');
  const byMemory = new Map();
  for (const r of rows) {
    const abs = resolve(project, r.path);
    const st = fileStat(abs);
    let changed;
    if (!st) changed = true;
    else if (st.mtime === r.mtime && st.size === r.size) changed = false; // untouched: skip hashing
    else {
      changed = hashFile(abs) !== r.hash;
      if (!changed) touch.run(st.mtime, st.size, r.memory_id, r.path); // touched but identical
    }
    const prev = byMemory.get(r.memory_id);
    byMemory.set(r.memory_id, { changed: (prev?.changed ?? false) || changed, stale: r.stale });
  }
  const set = db.prepare('UPDATE memories SET stale = ? WHERE id = ?');
  let flipped = 0;
  for (const [id, { changed, stale }] of byMemory) {
    if (Number(changed) !== stale) {
      set.run(Number(changed), id);
      flipped++;
    }
  }
  return flipped;
}

export function staleFiles(id) {
  return openDb().prepare('SELECT path FROM anchors WHERE memory_id = ?').all(id).map((r) => r.path);
}

const STOP = new Set('a an and are as at be but by can do does for from has have how i if in into is it its me my no not of on or our so that the their then there these this to was we were what when where which who why will with you your please should could would make use using get let lets just need want also add fix'.split(' '));

export function ftsQuery(text) {
  const words = (String(text).toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) || []).filter((w) => !STOP.has(w));
  const uniq = [...new Set(words)].slice(0, 16);
  return uniq.map((w) => `"${w}"${w.length > 3 ? '*' : ''}`).join(' OR ');
}

export function search({ project, query, kind = undefined, limit = 10, allProjects = false, includeStale = true }) {
  const db = openDb();
  const q = ftsQuery(query || '');
  const where = [];
  const args = [];
  if (!allProjects) {
    where.push('m.project = ?');
    args.push(project);
  }
  if (kind) {
    where.push('m.kind = ?');
    args.push(kind);
  }
  if (!includeStale) where.push('m.stale = 0');
  let rows;
  if (q) {
    rows = db.prepare(`
      SELECT m.*, bm25(memories_fts, 4.0, 1.0, 2.0) AS rank FROM memories_fts
      JOIN memories m ON m.id = memories_fts.rowid
      WHERE memories_fts MATCH ? ${where.length ? 'AND ' + where.join(' AND ') : ''}
      ORDER BY rank LIMIT 60`).all(q, ...args);
  } else {
    rows = db.prepare(`SELECT m.*, -1.0 AS rank FROM memories m ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY m.updated_at DESC LIMIT 60`).all(...args);
  }
  return rank(rows).slice(0, limit);
}

/** Orders rows by bm25 relevance, adjusted for kind, recency and use; stale memories sink. */
export function rank(rows, at = now()) {
  return rows
    .map((r) => {
      const days = (at - r.updated_at) / 86_400_000;
      const recency = 1 / (1 + days / 30);
      const score = -r.rank * (KIND_WEIGHT[r.kind] ?? 1) * (0.6 + 0.4 * recency) * (1 + Math.log1p(r.hits) * 0.15) * (r.stale ? 0.4 : 1);
      return { ...r, score };
    })
    .sort((a, b) => b.score - a.score);
}

export function getMemories(ids) {
  const db = openDb();
  const get = db.prepare('SELECT * FROM memories WHERE id = ?');
  const bump = db.prepare('UPDATE memories SET hits = hits + 1 WHERE id = ?');
  return ids.map(Number).map((id) => {
    const m = get.get(id);
    if (m) {
      bump.run(id);
      m.files = staleFiles(id);
    }
    return m;
  }).filter(Boolean);
}

export function forget(ids) {
  const db = openDb();
  const del = db.prepare('DELETE FROM memories WHERE id = ?');
  return ids.reduce((n, id) => n + Number(del.run(Number(id)).changes), 0);
}

/** Past fixes for an error signature: this project first, then any project. */
export function fixesFor(signature, project, limit = 2) {
  return openDb().prepare(`
    SELECT * FROM memories WHERE kind = 'fix' AND signature = ?
    ORDER BY (project = ?) DESC, updated_at DESC LIMIT ?`).all(signature, project, limit);
}

export function stats(project) {
  const db = openDb();
  const scope = project ? 'WHERE project = ?' : '';
  const args = project ? [project] : [];
  return {
    memories: db.prepare(`SELECT kind, COUNT(*) n FROM memories ${scope} GROUP BY kind ORDER BY n DESC`).all(...args),
    stale: db.prepare(`SELECT COUNT(*) n FROM memories ${scope ? scope + ' AND' : 'WHERE'} stale = 1`).get(...args).n,
    sessions: db.prepare(`SELECT COUNT(*) n FROM sessions ${scope}`).get(...args).n,
    datasets: db.prepare(`SELECT COUNT(*) n FROM datasets ${scope}`).get(...args).n,
    edges: db.prepare(`SELECT COUNT(*) n FROM edges ${scope}`).get(...args).n,
    projects: project ? undefined : db.prepare('SELECT project, COUNT(*) n FROM memories GROUP BY project ORDER BY n DESC').all(),
  };
}
