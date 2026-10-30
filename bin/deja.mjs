#!/usr/bin/env node
// deja: one entry point for hooks, the MCP server and the CLI.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

process.removeAllListeners('warning');
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  // Hooks must never break a session: stay silent and let `deja doctor` explain.
  if (process.argv[2] === 'hook') process.exit(0);
  console.error(`deja needs Node.js 22.13 or newer (found ${process.versions.node}).`);
  process.exit(1);
}

const { dejaHome, openDb } = await import('../src/db.mjs');
const { projectRoot, projectName, readStdin, ago } = await import('../src/util.mjs');
const [cmd, ...rest] = process.argv.slice(2);

function flags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      out[k] = v ?? (args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true);
    } else out._.push(a);
  }
  return out;
}

async function hook(event) {
  const started = performance.now();
  const raw = await readStdin();
  try {
    const { HANDLERS } = await import('../src/hooks.mjs');
    const handler = HANDLERS[event];
    if (!handler) return;
    const input = raw ? JSON.parse(raw) : {};
    const result = handler(input);
    if (result) process.stdout.write(JSON.stringify(result));
  } catch (err) {
    try {
      appendFileSync(join(dejaHome(), 'deja.log'), `${new Date().toISOString()} ${event} ${err.stack || err}\n`);
    } catch {}
  } finally {
    if (process.env.DEJA_TIMING) {
      try {
        appendFileSync(join(dejaHome(), 'timing.log'), `${event} ${(performance.now() - started).toFixed(1)}ms\n`);
      } catch {}
    }
  }
}

const HELP = `deja — memory for Claude Code. Zero dependencies, no daemon, no extra tokens.

Usage: deja <command> [options]

  recall [query]        Search memories   --kind fix|decision|gotcha|note|todo|summary  --all  --limit N
  get <id...>           Show memories in full
  remember <title>      Save a memory     --body "..."  --kind decision  --files a.py,b.sql  --tags x,y
  forget <id...>        Delete memories
  lineage <table>       Upstream/downstream for a table, path or dag:<id>   --up | --down  --depth N
  scan [dir]            Index SQL / dbt / PySpark / Airflow lineage under a directory
  stats                 Counts for this project  --all for every project
  export                Write memories as Markdown (default) or --json, for sharing in git
  import <file.json>    Load memories exported with --json into this project
  ui                    Visual browser of memories, fixes, playbook, lineage  --all  --out F  --no-open
  prune [--days 90]     Drop old session summaries and logs; keeps everything you saved
  doctor                Check the install
  hook <Event>          (used by Claude Code)
  mcp                   (used by Claude Code) run the MCP server

Env: DEJA_HOME (default ~/.deja)  DEJA_CONTEXT_TOKENS (default 1500)  DEJA_DISABLE=1
A file named .deja-off in a repo turns deja off for that repo.`;

async function main() {
  const f = flags(rest);
  const project = projectRoot(process.cwd());
  switch (cmd) {
    case 'hook':
      return hook(rest[0]);
    case 'mcp': {
      const { serve } = await import('../src/mcp.mjs');
      return serve();
    }
    case 'recall':
    case 'search': {
      const { callTool } = await import('../src/mcp.mjs');
      process.env.CLAUDE_PROJECT_DIR = project;
      return console.log(callTool('recall', { query: f._.join(' '), kind: f.kind, limit: Number(f.limit) || 20, all_projects: !!f.all }).content[0].text);
    }
    case 'get': {
      const { callTool } = await import('../src/mcp.mjs');
      process.env.CLAUDE_PROJECT_DIR = project;
      return console.log(callTool('get', { ids: f._.map(Number) }).content[0].text);
    }
    case 'remember': {
      const { addMemory } = await import('../src/store.mjs');
      const id = addMemory({ project, kind: f.kind || 'note', title: f._.join(' '), body: f.body || '', tags: f.tags ? String(f.tags).split(',') : [], files: f.files ? String(f.files).split(',') : [] });
      return console.log(`Saved memory #${id}.`);
    }
    case 'forget': {
      const { forget } = await import('../src/store.mjs');
      return console.log(`Deleted ${forget(f._)} memories.`);
    }
    case 'lineage': {
      const { callTool } = await import('../src/mcp.mjs');
      process.env.CLAUDE_PROJECT_DIR = project;
      return console.log(callTool('lineage', { name: f._.join(' '), direction: f.up ? 'up' : f.down ? 'down' : 'both', depth: Number(f.depth) || 3 }).content[0].text);
    }
    case 'scan': {
      const { scan } = await import('../src/graph.mjs');
      const t = performance.now();
      const r = scan(project, resolve(f._[0] || project));
      return console.log(`Scanned ${r.files} files in ${((performance.now() - t) / 1000).toFixed(1)}s; ${r.withLineage} had lineage.`);
    }
    case 'stats': {
      const { stats } = await import('../src/store.mjs');
      const s = stats(f.all ? null : project);
      console.log(f.all ? 'All projects' : projectName(project));
      console.log(`  memories: ${s.memories.reduce((n, r) => n + r.n, 0)} (${s.memories.map((r) => `${r.n} ${r.kind}`).join(', ') || 'none'})`);
      console.log(`  stale: ${s.stale}   sessions: ${s.sessions}   datasets: ${s.datasets}   lineage edges: ${s.edges}`);
      if (s.projects) s.projects.forEach((p) => console.log(`  ${String(p.n).padStart(5)}  ${p.project}`));
      return;
    }
    case 'export': {
      const db = openDb();
      const rows = db.prepare("SELECT * FROM memories WHERE project = ? AND kind != 'summary' ORDER BY kind, updated_at DESC").all(project);
      const anchors = db.prepare('SELECT path FROM anchors WHERE memory_id = ?');
      let output;
      if (f.json) {
        output = JSON.stringify(rows.map(({ id, project: _p, session_id, hits, rank, ...m }) => ({ ...m, files: anchors.all(id).map((a) => a.path) })), null, 2);
      } else {
        const groups = {};
        for (const m of rows) (groups[m.kind] ||= []).push(m);
        output = `# Project memory: ${projectName(project)}\n\nExported by [deja](https://github.com/sagarkonkanagaon-netizenk/deja) on ${new Date().toISOString().slice(0, 10)}.\n`;
        for (const [kind, ms] of Object.entries(groups)) {
          output += `\n## ${kind[0].toUpperCase() + kind.slice(1)}s\n`;
          for (const m of ms) {
            const files = anchors.all(m.id).map((a) => '`' + a.path + '`');
            output += `\n### ${m.title}${m.stale ? ' (stale)' : ''}\n\n${m.body}\n${files.length ? `\nFiles: ${files.join(', ')}\n` : ''}`;
          }
        }
      }
      if (f.out) {
        writeFileSync(f.out, output);
        return console.log(`Wrote ${rows.length} memories to ${f.out}.`);
      }
      return process.stdout.write(output + '\n');
    }
    case 'import': {
      const { addMemory } = await import('../src/store.mjs');
      const items = JSON.parse(readFileSync(f._[0], 'utf8'));
      let n = 0;
      for (const m of items) {
        addMemory({ project, kind: m.kind, title: m.title, body: m.body, tags: m.tags, files: m.files || [], signature: m.signature });
        n++;
      }
      return console.log(`Imported ${n} memories into ${projectName(project)}.`);
    }
    case 'ui': {
      const { collect, render } = await import('../src/ui.mjs');
      const { mkdirSync, writeFileSync: write } = await import('node:fs');
      const { spawn } = await import('node:child_process');
      const all = !!f.all;
      const slug = all ? 'all-projects' : projectName(project).replace(/[^\w.-]+/g, '-');
      const out = resolve(f.out || join(dejaHome(), 'ui', `${slug}.html`));
      mkdirSync(join(out, '..'), { recursive: true });
      const data = collect(all ? null : project);
      write(out, render(data));
      console.log(`deja ui: ${data.memories.length} memories, ${data.commands.length} commands, ${data.datasets.length} datasets → ${out}`);
      if (!f['no-open'] && !process.env.CI) {
        const [bin, args] = process.platform === 'darwin' ? ['open', [out]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', out]] : ['xdg-open', [out]];
        try {
          spawn(bin, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
        } catch {}
      }
      return;
    }
    case 'prune': {
      const db = openDb();
      const days = Number(f.days) || 90;
      const cutoff = Date.now() - days * 86_400_000;
      const summaries = db.prepare("DELETE FROM memories WHERE kind = 'summary' AND created_at < ?").run(cutoff).changes;
      const failures = db.prepare('DELETE FROM failures WHERE created_at < ?').run(cutoff).changes;
      const sessions = db.prepare('DELETE FROM sessions WHERE started_at < ?').run(cutoff).changes;
      db.exec("INSERT INTO memories_fts(memories_fts) VALUES ('optimize'); VACUUM;");
      return console.log(`Removed ${summaries} session summaries, ${failures} old failures and ${sessions} sessions older than ${days} days. Decisions, gotchas, fixes, notes and todos are kept.`);
    }
    case 'doctor': {
      const ok = (b, msg) => console.log(`${b ? '✔' : '✘'} ${msg}`);
      ok(true, `Node.js ${process.versions.node}`);
      let db;
      try {
        db = openDb();
        ok(true, `database ${process.env.DEJA_DB || join(dejaHome(), 'deja.db')}`);
      } catch (e) {
        ok(false, `database: ${e.message}`);
        return;
      }
      try {
        db.prepare("SELECT * FROM memories_fts WHERE memories_fts MATCH 'x' LIMIT 1").all();
        ok(true, 'SQLite FTS5 full-text search');
      } catch (e) {
        ok(false, `FTS5: ${e.message}`);
      }
      const last = db.prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT 1').get();
      ok(!!last, last ? `hooks are firing (last session ${ago(last.started_at)} in ${projectName(last.project)})` : 'no sessions recorded yet: start Claude Code with the plugin enabled');
      return;
    }
    case 'version':
    case '--version':
    case '-v': {
      const { VERSION } = await import('../src/version.mjs');
      return console.log(VERSION);
    }
    default:
      console.log(HELP);
  }
}

await main();
