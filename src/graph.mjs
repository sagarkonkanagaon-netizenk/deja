// Lineage graph storage and traversal.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { openDb, tx } from './db.mjs';
import { lineageFor } from './lineage.mjs';
import { now, relPath } from './util.mjs';

// Replace everything a file said about lineage with what it says now.
export function recordFile(project, absPath, text) {
  let found;
  try {
    // Generated or vendored giants are not worth parsing inside a hook.
    if (text === undefined && statSync(absPath).size > 1_000_000) return null;
    found = lineageFor(absPath, text ?? readFileSync(absPath, 'utf8'));
  } catch {
    return null;
  }
  if (!found) return null;
  const file = relPath(project, absPath);
  const db = openDb();
  const t = now();
  tx(db, () => {
    db.prepare('DELETE FROM edges WHERE project = ? AND file = ?').run(project, file);
    const ds = db.prepare(`INSERT INTO datasets (project, name, kind, columns, file, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project, name) DO UPDATE SET
        columns = COALESCE(excluded.columns, datasets.columns),
        file = CASE WHEN excluded.kind = 'output' OR datasets.file IS NULL THEN excluded.file ELSE datasets.file END,
        kind = CASE WHEN datasets.kind = 'output' THEN 'output' ELSE excluded.kind END,
        updated_at = excluded.updated_at`);
    const edge = db.prepare('INSERT OR IGNORE INTO edges (project, src, dst, file, op) VALUES (?, ?, ?, ?, ?)');
    for (const r of found.reads) ds.run(project, r, 'input', null, null, t);
    for (const w of found.writes) {
      const cols = found.columns[w];
      ds.run(project, w, 'output', cols ? JSON.stringify(cols) : null, file, t);
      for (const r of found.reads) if (r !== w) edge.run(project, r, w, file, 'data');
    }
    for (const [name, cols] of Object.entries(found.columns)) {
      if (!found.writes.includes(name)) ds.run(project, name, 'input', JSON.stringify(cols), null, t);
    }
    if (found.dag) {
      const dag = `dag:${found.dag.id}`;
      ds.run(project, dag, 'dag', JSON.stringify(found.dag.tasks), file, t);
      for (const [a, b] of found.dag.deps) edge.run(project, `${dag}.${a}`, `${dag}.${b}`, file, 'task');
      for (const w of found.writes) edge.run(project, dag, w, file, 'produces');
    }
  });
  return { file, reads: found.reads, writes: found.writes, dag: found.dag?.id ?? null };
}

const SCAN_EXT = new Set(['.sql', '.hql', '.ddl', '.py', '.ipynb']);
const SKIP_DIR = /^(\.|node_modules$|venv$|\.venv$|__pycache__$|target$|dist$|build$|dbt_packages$|site-packages$)/;

export function scan(project, dir = project, { maxFiles = 5000 } = {}) {
  let files = 0;
  let hits = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files >= maxFiles) return;
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIR.test(e.name)) walk(p);
      } else if (SCAN_EXT.has(extname(e.name).toLowerCase())) {
        try {
          if (statSync(p).size > 2_000_000) continue;
        } catch {
          continue;
        }
        files++;
        if (recordFile(project, p)) hits++;
      }
    }
  };
  walk(dir);
  return { files, withLineage: hits };
}

export function findDatasets(project, pattern, limit = 20) {
  const like = `%${String(pattern || '').toLowerCase()}%`;
  return openDb().prepare('SELECT * FROM datasets WHERE project = ? AND name LIKE ? ORDER BY (name = ?) DESC, length(name) LIMIT ?')
    .all(project, like, String(pattern || '').toLowerCase(), limit);
}

// Walk the graph upstream, downstream or both, breadth first.
export function trace(project, name, { direction = 'both', depth = 3 } = {}) {
  const db = openDb();
  const up = db.prepare("SELECT src AS node, file, op FROM edges WHERE project = ? AND dst = ? AND op != 'produces'");
  const down = db.prepare('SELECT dst AS node, file, op FROM edges WHERE project = ? AND src = ?');
  const start = String(name).toLowerCase();
  const walk = (stmt) => {
    const out = [];
    const seen = new Set([start]);
    const pairs = new Set();
    let frontier = [start];
    for (let level = 1; level <= depth && frontier.length; level++) {
      const next = [];
      for (const n of frontier) {
        for (const e of stmt.all(project, n)) {
          const key = `${n}>${e.node}`;
          if (pairs.has(key)) continue;
          pairs.add(key);
          out.push({ from: n, to: e.node, file: e.file, op: e.op, level });
          if (!seen.has(e.node)) {
            seen.add(e.node);
            next.push(e.node);
          }
        }
      }
      frontier = next;
    }
    return out;
  };
  const node = db.prepare('SELECT * FROM datasets WHERE project = ? AND name = ?').get(project, start);
  return {
    dataset: node ? { ...node, columns: node.columns ? JSON.parse(node.columns) : null } : null,
    dags: db.prepare("SELECT DISTINCT src FROM edges WHERE project = ? AND dst = ? AND op = 'produces'").all(project, start).map((r) => r.src),
    upstream: direction === 'down' ? [] : walk(up),
    downstream: direction === 'up' ? [] : walk(down),
  };
}
