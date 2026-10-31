// A minimal MCP server over stdio (JSON-RPC 2.0, newline-delimited). No SDK dependency.
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { findDatasets, scan, trace } from './graph.mjs';
import { addMemory, forget, getMemories, KINDS, refreshStaleness, search } from './store.mjs';
import { ago, oneLine, projectName, projectRoot } from './util.mjs';
import { VERSION } from './version.mjs';
import { openDb } from './db.mjs';
import { redact } from './redact.mjs';

function recentAutoFix(project) {
  return openDb().prepare("SELECT * FROM memories WHERE project = ? AND kind = 'fix' AND signature IS NOT NULL AND updated_at > ? ORDER BY updated_at DESC LIMIT 1")
    .get(project, Date.now() - 2 * 3_600_000);
}

const PLUGIN_DIR = resolve(import.meta.dirname, '..');

/**
 * The project the agent is working in. Claude Code passes it in CLAUDE_PROJECT_DIR.
 * Codex starts plugin MCP servers inside the plugin's own folder, so fall back to the
 * shell's PWD, then to the most recent session.
 */
export function project() {
  if (process.env.CLAUDE_PROJECT_DIR) return projectRoot(process.env.CLAUDE_PROJECT_DIR);
  const here = projectRoot(process.cwd());
  if (here !== projectRoot(PLUGIN_DIR)) return here;
  const pwd = process.env.PWD && resolve(process.env.PWD);
  if (pwd && projectRoot(pwd) !== here) return projectRoot(pwd);
  return openDb().prepare('SELECT project FROM sessions ORDER BY started_at DESC LIMIT 1').get()?.project || here;
}

const TOOLS = [
  {
    name: 'recall',
    description: 'Search this project\'s memory (decisions, gotchas, fixes for past errors, notes, todos, session summaries). Returns a compact index; call `get` for full text. Use before working in an unfamiliar area or when an error looks familiar.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords. Empty returns the most recent memories.' },
        kind: { type: 'string', enum: KINDS },
        limit: { type: 'number', default: 10 },
        all_projects: { type: 'boolean', default: false, description: 'Search every project on this machine.' },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get',
    description: 'Fetch full memories by id, including the files they are anchored to and whether those files changed since.',
    inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'number' } } }, required: ['ids'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'remember',
    description: 'Save something a future session should know: a decision and its reason, a gotcha, the real cause of a bug, a convention, or a todo. Pass the files it concerns; the memory is flagged stale automatically when they change. Saving with an existing title updates that memory.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'One line that will make sense out of context.' },
        body: { type: 'string', description: 'The why and the how. Short.' },
        kind: { type: 'string', enum: KINDS, default: 'note' },
        files: { type: 'array', items: { type: 'string' }, description: 'Paths this memory is about.' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['title'],
    },
  },
  {
    name: 'forget',
    description: 'Delete memories by id when they are wrong or no longer apply.',
    inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'number' } } }, required: ['ids'] },
    annotations: { destructiveHint: true },
  },
  {
    name: 'lineage',
    description: 'Data lineage for a table, view, path or Airflow DAG, built from the SQL, dbt, PySpark and Airflow files in this project: what feeds it, what it feeds, which file does it, and its known columns. Pass a partial name to search.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        direction: { type: 'string', enum: ['up', 'down', 'both'], default: 'both' },
        depth: { type: 'number', default: 3 },
      },
      required: ['name'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'scan_lineage',
    description: 'Index lineage for every SQL, dbt, PySpark, notebook and Airflow file under the project (or a subdirectory). Run once on a data repo; edits keep it current afterwards.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  },
];

const text = (s) => ({ content: [{ type: 'text', text: s }] });

export function callTool(name, args = {}) {
  const p = project();
  switch (name) {
    case 'recall': {
      refreshStaleness(p);
      const rows = search({ project: p, query: args.query, kind: args.kind, limit: Math.min(args.limit || 10, 50), allProjects: !!args.all_projects });
      if (!rows.length) return text(`No memories match in ${args.all_projects ? 'any project' : projectName(p)}.`);
      return text(rows.map((m) => `#${m.id} [${m.kind}${m.stale ? ', stale' : ''}] ${oneLine(m.title, 120)} (${ago(m.updated_at)}${args.all_projects ? ', ' + projectName(m.project) : ''})`).join('\n'));
    }
    case 'get': {
      refreshStaleness(p);
      const rows = getMemories(args.ids || []);
      if (!rows.length) return text('No such memories.');
      return text(rows.map((m) => [
        `#${m.id} [${m.kind}] ${m.title}`,
        `saved ${ago(m.created_at)}, updated ${ago(m.updated_at)}${m.project !== p ? `, project ${projectName(m.project)}` : ''}`,
        m.files.length ? `files: ${m.files.join(', ')}${m.stale ? ' (changed since this was written; verify before relying on it)' : ''}` : null,
        m.tags ? `tags: ${m.tags}` : null,
        '',
        m.body,
      ].filter((l) => l !== null).join('\n')).join('\n\n---\n\n'));
    }
    case 'remember': {
      // A root-cause note right after deja auto-captured a fix belongs on that fix,
      // so the explanation comes back the next time the same error signature appears.
      if (args.kind === 'fix') {
        const auto = recentAutoFix(p);
        if (auto) {
          const cause = redact(`${args.title}${args.body ? ' — ' + args.body : ''}`);
          const body = auto.body.replace(/\nCause: [\s\S]*$/, '') + `\nCause: ${cause}`;
          openDb().prepare('UPDATE memories SET body = ?, updated_at = ? WHERE id = ?').run(body, Date.now(), auto.id);
          return text(`Added the cause to fix #${auto.id}; it will come back with that error.`);
        }
      }
      const id = addMemory({ project: p, sessionId: null, kind: KINDS.includes(args.kind) ? args.kind : 'note', title: args.title, body: args.body, tags: args.tags || [], files: args.files || [] });
      return text(`Saved memory #${id}.`);
    }
    case 'forget':
      return text(`Deleted ${forget(args.ids || [])} memories.`);
    case 'lineage': {
      const matches = findDatasets(p, args.name);
      if (!matches.length) return text(`No dataset matching "${args.name}". If this is a data repo, run the scan_lineage tool first.`);
      const exact = matches.find((d) => d.name === String(args.name).toLowerCase()) || (matches.length === 1 ? matches[0] : null);
      if (!exact) return text(`Several datasets match; pick one:\n${matches.map((d) => `- ${d.name} (${d.kind}${d.file ? ', ' + d.file : ''})`).join('\n')}`);
      const t = trace(p, exact.name, { direction: args.direction || 'both', depth: Math.min(args.depth || 3, 8) });
      // Print as a tree so each node sits under the node it connects to.
      const fmt = (edges, arrow) => {
        const kids = new Map();
        for (const e of edges) kids.set(e.from, [...(kids.get(e.from) || []), e]);
        const lines = [];
        const walk = (node, depth, path) => {
          for (const e of kids.get(node) || []) {
            if (path.has(e.to)) continue;
            lines.push(`${'  '.repeat(depth)}${arrow} ${e.to} (${e.op === 'task' ? 'task' : e.file})`);
            walk(e.to, depth + 1, new Set([...path, e.to]));
          }
        };
        walk(exact.name, 0, new Set([exact.name]));
        return lines.join('\n');
      };
      return text([
        `${exact.name}${t.dataset?.file ? ` is written by ${t.dataset.file}` : ''}`,
        t.dags.length ? `scheduled by ${t.dags.join(', ')}` : null,
        t.dataset?.columns ? `${t.dataset.kind === 'dag' ? 'tasks' : 'columns'}: ${t.dataset.columns.join(', ')}` : null,
        t.upstream.length ? `\nupstream:\n${fmt(t.upstream, '←')}` : '\nupstream: none known',
        t.downstream.length ? `\ndownstream:\n${fmt(t.downstream, '→')}` : '\ndownstream: none known',
      ].filter(Boolean).join('\n'));
    }
    case 'scan_lineage': {
      const r = scan(p, args.path ? resolve(p, args.path) : p);
      return text(`Scanned ${r.files} files; ${r.withLineage} had lineage.`);
    }
    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
  }
}

export function handle(msg) {
  const { id, method, params } = msg;
  const reply = (result) => (id === undefined ? null : { jsonrpc: '2.0', id, result });
  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'deja', version: VERSION },
        instructions: 'deja is this project\'s long-term memory. Call `remember` when you make a non-obvious decision, find a gotcha, or learn the real cause of a bug. Call `recall` before starting unfamiliar work. Call `lineage` for questions about what feeds or depends on a table.',
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call':
      try {
        return reply(callTool(params?.name, params?.arguments || {}));
      } catch (err) {
        if (err.code === -32602) return { jsonrpc: '2.0', id, error: { code: -32602, message: err.message } };
        return reply({ ...text(`deja error: ${err.message}`), isError: true });
      }
    default:
      if (id === undefined) return null; // notifications
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

export function serve() {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (l) => {
    if (!l.trim()) return;
    let msg;
    try {
      msg = JSON.parse(l);
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
      return;
    }
    const res = handle(msg);
    if (res) process.stdout.write(JSON.stringify(res) + '\n');
  });
}
