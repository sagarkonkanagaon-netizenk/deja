// Lightweight lineage extraction for SQL, dbt, PySpark and Airflow files.
// It is regex-based on purpose: it has to run inside a hook in a few milliseconds
// and never fail. It finds the datasets a file reads and writes, plus column lists
// from DDL, and records file-level edges (every input feeds every output).
import { basename, extname } from 'node:path';

const KEYWORDS = new Set([
  'select', 'where', 'lateral', 'unnest', 'values', 'table', 'the', 'a', 'as', 'on', 'using', 'dual',
  'if', 'not', 'exists', 'only', 'with', 'set', 'into', 'from', 'join', 'by', 'group', 'order',
]);

const IDENT = '((?:`[^`]+`|"[^"]+"|\\[[^\\]]+\\]|[A-Za-z_][\\w$]*)(?:\\.(?:`[^`]+`|"[^"]+"|\\[[^\\]]+\\]|[A-Za-z_][\\w$]*)){0,3})';

function clean(name) {
  const n = name.replace(/[`"[\]]/g, '').toLowerCase();
  return KEYWORDS.has(n) ? null : n;
}

function stripComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

// Replace templating with something parseable and pull out dbt refs/sources.
function untemplate(sql, reads) {
  return sql
    .replace(/\{\{\s*ref\(\s*(?:['"][^'"]+['"]\s*,\s*)?['"]([^'"]+)['"]\s*(?:,[^)]*)?\)\s*\}\}/g, (_, m) => {
      reads.add(m.toLowerCase());
      return ` __dbt_${m} `;
    })
    .replace(/\{\{\s*source\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)\s*\}\}/g, (_, s, t) => {
      reads.add(`${s}.${t}`.toLowerCase());
      return ` __dbt_src `;
    })
    .replace(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|\{#[\s\S]*?#\}/g, ' ')
    .replace(/\$\{[^}]*\}/g, 'x');
}

function parseColumns(body) {
  const cols = [];
  let depth = 0;
  let cur = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      cols.push(cur);
      cur = '';
    } else cur += ch;
  }
  cols.push(cur);
  return cols
    .map((c) => c.trim().match(/^[`"[]?([A-Za-z_][\w$]*)[`"\]]?\s+([A-Za-z][\w]*(?:\s*\([^)]*\)|<[^>]*>)?)/))
    .filter((m) => m && !/^(primary|foreign|constraint|unique|check|key|index|partitioned|clustered)$/i.test(m[1]))
    .map((m) => `${m[1]} ${m[2].replace(/\s+/g, '')}`.toLowerCase());
}

/** @param {string} text @param {{ model?: string }} [opts] */
export function parseSql(text, { model } = {}) {
  const reads = new Set();
  const writes = new Set();
  const columns = {};
  let sql = stripComments(untemplate(String(text), reads));

  const ctes = new Set();
  for (const m of sql.matchAll(/(?:\bwith\s+(?:recursive\s+)?|,\s*)([A-Za-z_]\w*)\s+as\s*\(/gi)) ctes.add(m[1].toLowerCase());

  const writeRe = [
    new RegExp(`\\binsert\\s+(?:into|overwrite)\\s+(?:table\\s+)?${IDENT}`, 'gi'),
    new RegExp(`\\bmerge\\s+into\\s+${IDENT}`, 'gi'),
    new RegExp(`\\bcreate\\s+(?:or\\s+replace\\s+)?(?:(?:global\\s+)?temp(?:orary)?\\s+|external\\s+|materialized\\s+|transient\\s+|streaming\\s+)*(?:table|view|live\\s+table)\\s+(?:if\\s+not\\s+exists\\s+)?${IDENT}`, 'gi'),
    new RegExp(`\\bupdate\\s+${IDENT}\\s+set\\b`, 'gi'),
    new RegExp(`\\bdelete\\s+from\\s+${IDENT}`, 'gi'),
    new RegExp(`\\bcopy\\s+into\\s+${IDENT}`, 'gi'),
  ];
  for (const re of writeRe) for (const m of sql.matchAll(re)) {
    const n = clean(m[1]);
    if (n) writes.add(n);
  }

  for (const m of sql.matchAll(new RegExp(`\\bcreate\\s+(?:or\\s+replace\\s+)?(?:external\\s+|transient\\s+)?table\\s+(?:if\\s+not\\s+exists\\s+)?${IDENT}\\s*\\(`, 'gi'))) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    while (i < sql.length && depth) {
      if (sql[i] === '(') depth++;
      else if (sql[i] === ')') depth--;
      i++;
    }
    const n = clean(m[1]);
    const cols = parseColumns(sql.slice(start, i - 1));
    if (n && cols.length) columns[n] = cols;
  }

  for (const m of sql.matchAll(new RegExp(`\\b(?:from|join|using)\\s+${IDENT}`, 'gi'))) {
    const n = clean(m[1]);
    if (!n || ctes.has(n) || n.startsWith('__dbt_') || writes.has(n) && /\bdelete\s+from\s*$/i.test(sql.slice(0, m.index + 12))) continue;
    if (/^(lateral|unnest|json_table|read_\w+)$/.test(n)) continue;
    reads.add(n);
  }
  // DELETE FROM x is a write, not a read.
  for (const m of sql.matchAll(new RegExp(`\\bdelete\\s+from\\s+${IDENT}`, 'gi'))) {
    const n = clean(m[1]);
    if (n) reads.delete(n);
  }
  if (model) writes.add(model.toLowerCase());
  for (const w of writes) if (!model || w !== model) reads.delete(w);
  for (const r of [...reads]) if (r.startsWith('__dbt_')) reads.delete(r);
  return { reads: [...reads], writes: [...writes], columns };
}

const PY_STR = `(?:[rbfu]{0,2})(?:"""([\\s\\S]*?)"""|'''([\\s\\S]*?)'''|"([^"\\n]*)"|'([^'\\n]*)')`;
const pyStr = (m, i = 1) => m[i] ?? m[i + 1] ?? m[i + 2] ?? m[i + 3];

export function parsePython(text) {
  const src = String(text);
  const reads = new Set();
  const writes = new Set();
  const columns = {};
  const add = (set, v) => v && !/[{}]/.test(v) && set.add(v.trim().toLowerCase());

  const readTable = new RegExp(`\\b(?:spark\\.table|\\.read(?:Stream)?\\.table|spark\\.read\\.table|DeltaTable\\.forName\\(\\s*\\w+\\s*,|dlt\\.read(?:_stream)?|\\.read_table)\\(?\\s*${PY_STR}`, 'g');
  for (const m of src.matchAll(readTable)) add(reads, pyStr(m));
  const readPath = new RegExp(`\\.(?:load|parquet|csv|json|orc|text|delta)\\(\\s*${PY_STR}`, 'g');
  for (const m of src.matchAll(readPath)) {
    // Whichever of .read / .write appears last in the chain decides the direction.
    const before = src.slice(Math.max(0, m.index - 300), m.index);
    const isWrite = before.lastIndexOf('.write') > before.lastIndexOf('.read');
    add(isWrite ? writes : reads, pyStr(m));
  }
  const writeTable = new RegExp(`\\.(?:saveAsTable|insertInto|toTable)\\(\\s*${PY_STR}`, 'g');
  for (const m of src.matchAll(writeTable)) add(writes, pyStr(m));
  const writePath = new RegExp(`\\.save\\(\\s*${PY_STR}`, 'g');
  for (const m of src.matchAll(writePath)) add(writes, pyStr(m));

  // Delta Live Tables: the decorated function name is the table.
  for (const m of src.matchAll(/@dlt\.(?:table|view)\(([^)]*)\)\s*\n\s*def\s+(\w+)/g)) {
    const named = m[1].match(/name\s*=\s*["']([^"']+)["']/);
    add(writes, named ? named[1] : m[2]);
  }

  // SQL embedded in spark.sql(...) and in Airflow/dbt operators' sql= arguments.
  const sqlCall = new RegExp(`(?:\\.sql\\(|\\bsql\\s*=\\s*)\\s*${PY_STR}`, 'g');
  for (const m of src.matchAll(sqlCall)) {
    const s = parseSql(pyStr(m));
    s.reads.forEach((r) => reads.add(r));
    s.writes.forEach((w) => writes.add(w));
    Object.assign(columns, s.columns);
  }
  for (const w of writes) reads.delete(w);
  return { reads: [...reads], writes: [...writes], columns, dag: parseAirflow(src) };
}

// Airflow: DAG id, task ids and the >> / << dependencies between them.
export function parseAirflow(src) {
  const id =
    src.match(/\bDAG\(\s*(?:dag_id\s*=\s*)?["']([^"']+)["']/)?.[1] ||
    src.match(/@dag\([^)]*dag_id\s*=\s*["']([^"']+)["']/s)?.[1] ||
    src.match(/@dag\b[^\n]*\n\s*def\s+(\w+)/)?.[1];
  if (!id) return null;
  const vars = new Map();
  for (const m of src.matchAll(/^\s*(\w+)\s*=\s*\w+(?:\.\w+)*\(\s*(?:[^)]*?\btask_id\s*=\s*["']([^"']+)["'])/gms)) vars.set(m[1], m[2]);
  for (const m of src.matchAll(/@task(?:\.\w+)?(?:\([^)]*\))?\s*\n\s*def\s+(\w+)/g)) vars.set(m[1], m[1]);
  const deps = [];
  for (const line of src.split('\n')) {
    if (!/>>|<</.test(line) || /^\s*#/.test(line)) continue;
    const parts = line.split(/(>>|<<)/).map((p) => p.trim());
    for (let i = 1; i < parts.length; i += 2) {
      const left = names(parts[i - 1], vars);
      const right = names(parts[i + 1], vars);
      for (const l of left) for (const r of right) deps.push(parts[i] === '>>' ? [l, r] : [r, l]);
    }
  }
  return { id, tasks: [...new Set(vars.values())], deps };
}

function names(expr, vars) {
  return (expr.match(/\w+/g) || []).map((w) => vars.get(w) || (vars.has(w.replace(/\(\)$/, '')) ? w : null)).filter(Boolean);
}

export function lineageFor(path, text) {
  const ext = extname(path).toLowerCase();
  if (ext === '.sql' || ext === '.hql' || ext === '.ddl') {
    const model = /[\\/]models[\\/]/.test(path) && /\{\{\s*(?:ref|source|config)\(/.test(text) ? basename(path, ext) : undefined;
    return { ...parseSql(text, { model }), dag: null };
  }
  if (ext === '.py' || ext === '.ipynb') {
    const src = ext === '.ipynb' ? notebookSource(text) : text;
    if (!/spark|delta|dlt|airflow|DAG|sql|pandas|read_|saveAsTable/i.test(src)) return null;
    return parsePython(src);
  }
  return null;
}

function notebookSource(text) {
  try {
    return JSON.parse(text).cells.map((c) => [].concat(c.source).join('')).join('\n\n');
  } catch {
    return '';
  }
}
