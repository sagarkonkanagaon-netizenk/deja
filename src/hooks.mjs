// Claude Code hook handlers. Each runs in a short-lived process, touches SQLite,
// prints at most one JSON object and exits. No daemon, no network, no LLM calls.
import { existsSync } from 'node:fs';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { openDb, tx } from './db.mjs';
import { commandFamily, errorSignature, keyLines } from './errors.mjs';
import { recordFile } from './graph.mjs';
import { redact } from './redact.mjs';
import { addMemory, fixesFor, rank, refreshStaleness, search } from './store.mjs';
import { ago, clip, intEnv, now, oneLine, projectName, projectRoot, relPath, tokens } from './util.mjs';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const LINEAGE_EXT = new Set(['.sql', '.hql', '.ddl', '.py', '.ipynb']);
// Exit code 1 from these is an answer ("no match", "differs"), not a bug.
const NOT_BUGS = new Set(['grep', 'rg', 'ag', 'ls', 'cat', 'find', 'test', '[', 'which', 'command', 'type', 'head', 'tail', 'echo', 'diff', 'cmp', 'stat', 'file', 'pgrep', 'kill', 'curl', 'sleep', 'true', 'false', 'git diff', 'git status', 'git log', 'git show']);
const FIX_WINDOW_MS = 45 * 60_000;

const out = (event, context) => (context ? { hookSpecificOutput: { hookEventName: event, additionalContext: context } } : null);

export function disabled(project) {
  return process.env.DEJA_DISABLE === '1' || existsSync(join(project, '.deja-off'));
}

function session(db, input, project) {
  const id = input.session_id || 'unknown';
  db.prepare('INSERT OR IGNORE INTO sessions (id, project, started_at) VALUES (?, ?, ?)').run(id, project, now());
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
}

function injectedSet(s) {
  return new Set((s.injected || '').split(',').filter(Boolean).map(Number));
}

function markInjected(db, s, ids) {
  if (!ids.length) return;
  const set = injectedSet(s);
  ids.forEach((i) => set.add(i));
  db.prepare('UPDATE sessions SET injected = ? WHERE id = ?').run([...set].slice(-300).join(','), s.id);
}

const gist = (m) => (m.kind === 'fix' ? m.body.split('\nFix: ').pop() : m.body);
const line = (m) => `- #${m.id} [${m.kind}${m.stale ? ', stale' : ''}] ${oneLine(m.title, 110)}${m.body ? ' → ' + oneLine(gist(m), 160) : ''} (${ago(m.updated_at)})`;

export function sessionStart(input) {
  const project = projectRoot(input.cwd);
  if (disabled(project)) return null;
  const db = openDb();
  const s = session(db, input, project);
  refreshStaleness(project);
  const budget = intEnv('DEJA_CONTEXT_TOKENS', 1500);
  const total = db.prepare('SELECT COUNT(*) n FROM memories WHERE project = ?').get(project).n;
  const lin = db.prepare("SELECT (SELECT COUNT(*) FROM datasets WHERE project = ? AND kind != 'dag') d, (SELECT COUNT(*) FROM datasets WHERE project = ? AND kind = 'dag') g").get(project, project);
  if (!total && !lin.d) {
    return out('SessionStart', `deja is recording this project (${projectName(project)}). No memories yet. The deja MCP tools \`remember\` and \`recall\` store and search project memory across sessions.`);
  }

  const parts = [`deja memory for ${projectName(project)}: ${total} memories. Fetch any in full with the deja \`get\` tool by id; search with \`recall\`.`];
  const used = new Set();
  let spent = tokens(parts[0]);
  const section = (title, rows, fmt = line) => {
    const lines = [];
    for (const r of rows) {
      if (used.has(r.id)) continue;
      const l = fmt(r);
      if (spent + tokens(l) > budget) break;
      spent += tokens(l);
      lines.push(l);
      used.add(r.id);
    }
    if (lines.length) parts.push(`\n${title}\n${lines.join('\n')}`);
  };

  const last = db.prepare("SELECT * FROM memories WHERE project = ? AND kind = 'summary' ORDER BY created_at DESC LIMIT 1").get(project);
  if (last) section('Last session:', [last], (m) => `- ${oneLine(m.title, 120)} (${ago(m.created_at)})\n  ${oneLine(m.body, 400)}`);

  const pick = (kinds, n) => rank(db.prepare(`SELECT *, -1.0 AS rank FROM memories WHERE project = ? AND stale = 0 AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY updated_at DESC LIMIT 80`).all(project, ...kinds)).slice(0, n);
  section('Decisions and gotchas:', pick(['decision', 'gotcha'], 12));
  section('Open todos:', pick(['todo'], 5));
  section('Fixes learned (error → what fixed it):', pick(['fix'], 6));
  section('Notes:', pick(['note'], 6));
  const stale = db.prepare('SELECT * FROM memories WHERE project = ? AND stale = 1 AND kind != ? ORDER BY updated_at DESC LIMIT 5').all(project, 'summary');
  section('Possibly outdated (anchored files changed since these were written):', stale);
  if (lin.d || lin.g) parts.push(`\nData lineage: ${lin.d} datasets and ${lin.g} Airflow DAGs mapped. The deja \`lineage\` tool answers upstream/downstream and schema questions.`);

  markInjected(db, s, [...used]);
  return out('SessionStart', parts.join('\n'));
}

export function userPromptSubmit(input) {
  const project = projectRoot(input.cwd);
  if (disabled(project)) return null;
  const db = openDb();
  const s = session(db, input, project);
  const prompt = redact(input.prompt || '');
  db.prepare('UPDATE sessions SET prompts = prompts + 1, first_prompt = COALESCE(first_prompt, ?) WHERE id = ?').run(clip(prompt, 300), s.id);
  if (prompt.length < 15 || prompt.trim().startsWith('/')) return null;

  const words = new Set((prompt.toLowerCase().match(/[a-z0-9_]{4,}/g) || []));
  if (words.size < 2) return null;
  const seen = injectedSet(s);
  const hits = search({ project, query: prompt, limit: 8 })
    .filter((m) => m.kind !== 'summary' && !seen.has(m.id))
    .filter((m) => {
      const hay = `${m.title} ${m.body} ${m.tags}`.toLowerCase();
      const overlap = [...words].filter((w) => hay.includes(w.slice(0, Math.max(4, w.length - 2)))).length;
      return overlap >= 2 && overlap / words.size >= 0.2;
    })
    .slice(0, 3);
  if (!hits.length) return null;
  markInjected(db, s, hits.map((h) => h.id));
  return out('UserPromptSubmit', `deja found memories related to this request:\n${hits.map(line).join('\n')}`);
}

function absPath(input, p) {
  if (!p) return null;
  return isAbsolute(p) ? p : resolve(input.cwd || process.cwd(), p);
}

// Memories anchored to a file come back the first time Claude opens or edits it.
function fileMemories(db, s, project, file) {
  const seen = injectedSet(s);
  const rows = db.prepare(`SELECT m.* FROM anchors a JOIN memories m ON m.id = a.memory_id
    WHERE m.project = ? AND a.path = ? AND m.kind IN ('decision','gotcha','fix','note','todo') ORDER BY m.updated_at DESC LIMIT 4`).all(project, relPath(project, file));
  const fresh = rows.filter((r) => !seen.has(r.id));
  if (!fresh.length) return null;
  markInjected(db, s, fresh.map((r) => r.id));
  return `deja memories about ${relPath(project, file)}:\n${fresh.map(line).join('\n')}`;
}

export function postToolUse(input) {
  const project = projectRoot(input.cwd);
  if (disabled(project)) return null;
  const db = openDb();
  const s = session(db, input, project);
  const tool = input.tool_name;
  const ti = input.tool_input || {};
  const notes = [];

  if (EDIT_TOOLS.has(tool) || tool === 'Read') {
    const file = absPath(input, ti.file_path || ti.notebook_path);
    if (file) {
      if (EDIT_TOOLS.has(tool)) db.prepare('INSERT INTO touches (session_id, path, tool, at) VALUES (?, ?, ?, ?)').run(s.id, relPath(project, file), tool, now());
      if (LINEAGE_EXT.has(extname(file).toLowerCase())) recordFile(project, file);
      const mem = fileMemories(db, s, project, file);
      if (mem) notes.push(mem);
    }
  }

  if (tool === 'Bash' && ti.command) {
    const command = redact(ti.command);
    const resp = input.tool_response || {};
    // Some versions report a non-zero exit as a successful tool call with an error code.
    const code = resp.exitCode ?? resp.exit_code ?? resp.returnCode;
    if (code && code !== 0) return failure({ ...input, error: `Exit code ${code}\n${resp.stderr || ''}\n${resp.stdout || ''}` });
    db.prepare('INSERT INTO touches (session_id, path, tool, at) VALUES (?, ?, ?, ?)').run(s.id, clip(command, 300), 'Bash', now());
    const learned = resolveFailures(db, s, project, command);
    if (learned) notes.push(learned);
  }
  return out('PostToolUse', notes.join('\n\n') || null);
}

function resolveFailures(db, s, project, command) {
  const family = commandFamily(command);
  if (!family) return null;
  const open = db.prepare('SELECT * FROM failures WHERE session_id = ? AND family = ? AND resolved = 0 AND created_at > ? ORDER BY created_at').all(s.id, family, now() - FIX_WINDOW_MS);
  if (!open.length) return null;
  const learned = [];
  tx(db, () => db.prepare(`UPDATE failures SET resolved = 1 WHERE id IN (${open.map(() => '?').join(',')})`).run(...open.map((f) => f.id)));
  // Several failures of one signature collapse into one fix.
  const bySig = new Map();
  for (const f of open) if (!bySig.has(f.signature)) bySig.set(f.signature, f);
  for (const f of bySig.values()) {
    const steps = db.prepare('SELECT path, tool FROM touches WHERE session_id = ? AND rowid > ? ORDER BY rowid').all(s.id, f.mark);
    const files = [...new Set(steps.filter((t) => t.tool !== 'Bash').map((t) => t.path))];
    const cmds = [...new Set(steps.filter((t) => t.tool === 'Bash' && t.path !== command).map((t) => t.path))].slice(-5);
    const changed = command.trim() !== f.command.trim();
    if (!files.length && !cmds.length && !changed) continue; // passed on a plain retry: flaky, nothing to learn
    const how = [
      files.length ? `edited ${files.slice(0, 8).join(', ')}` : null,
      cmds.length ? `ran ${cmds.map((c) => '`' + oneLine(c, 100) + '`').join(', ')}` : null,
      changed ? `then \`${oneLine(command, 160)}\` passed (was \`${oneLine(f.command, 120)}\`)` : `then \`${oneLine(command, 160)}\` passed`,
    ].filter(Boolean).join('; ');
    const id = addMemory({
      project,
      sessionId: s.id,
      kind: 'fix',
      title: oneLine(f.error.split('\n').pop().replace(/^(error|exception):\s*/i, ''), 160),
      body: `Error: ${f.error}\nFix: ${how}.`,
      tags: [f.family],
      files,
      signature: f.signature,
    });
    learned.push(id);
  }
  return learned.length ? `deja saved fix memory #${learned.join(', #')} (error → fix). Refine it with the deja \`remember\` tool if the real cause differs.` : null;
}

export function failure(input) {
  const project = projectRoot(input.cwd);
  if (disabled(project)) return null;
  if (input.tool_name !== 'Bash' || input.is_interrupt) return null;
  const command = redact(input.tool_input?.command || '');
  const family = commandFamily(command);
  if (!family || NOT_BUGS.has(family) || NOT_BUGS.has(family.split(' ')[0])) return null;
  const sig = errorSignature(redact(input.error || ''));
  if (!sig) return null;
  const db = openDb();
  const s = session(db, input, project);
  // Remember where the session's step log stood, so the fix is exactly the steps after this.
  const mark = db.prepare('SELECT COALESCE(MAX(rowid), 0) m FROM touches').get().m;
  db.prepare('INSERT INTO failures (project, session_id, signature, family, command, error, mark, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(project, s.id, sig.signature, family, clip(command, 500), sig.text, mark, now());

  let fixes = fixesFor(sig.signature, project);
  if (!fixes.length) fixes = similarFixes(sig.text, project);
  if (!fixes.length) return null;
  db.prepare(`UPDATE memories SET hits = hits + 1 WHERE id IN (${fixes.map(() => '?').join(',')})`).run(...fixes.map((f) => f.id));
  const where = (f) => (f.project === project ? '' : ` in ${projectName(f.project)}`);
  return out('PostToolUseFailure', `deja has seen this error before:\n${fixes.map((f) => `- #${f.id} ${ago(f.updated_at)}${where(f)}: ${oneLine(f.body.split('\nFix: ').pop(), 400)}${f.stale ? ' (code has changed since)' : ''}`).join('\n')}`);
}

const words = (s) => new Set(String(s).toLowerCase().match(/[a-z_][a-z0-9_.']{2,}/g) || []);

// Fallback when the exact signature is new: same error, different wording around it.
function similarFixes(text, project) {
  const mine = words(text);
  if (mine.size < 3) return [];
  return search({ project, query: [...mine].join(' '), kind: 'fix', limit: 5, allProjects: true })
    .filter((m) => {
      const theirs = words(keyLines(m.body.split('\nFix: ')[0].replace(/^Error: /, '')).join(' '));
      const inter = [...mine].filter((w) => theirs.has(w)).length;
      return inter / Math.max(mine.size, theirs.size) >= 0.6;
    })
    .slice(0, 2);
}

export function stop(input) {
  const project = projectRoot(input.cwd);
  if (disabled(project) || !input.last_assistant_message) return null;
  const db = openDb();
  const s = session(db, input, project);
  db.prepare('UPDATE sessions SET last_message = ? WHERE id = ?').run(clip(redact(input.last_assistant_message), 2000), s.id);
  return null;
}

// A deterministic summary: what was asked, what changed, what was learned.
export function sessionEnd(input) {
  const project = projectRoot(input.cwd);
  if (disabled(project)) return null;
  const db = openDb();
  const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(input.session_id || 'unknown');
  if (!s) return null;
  db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(now(), s.id);
  const edits = db.prepare("SELECT DISTINCT path FROM touches WHERE session_id = ? AND tool != 'Bash'").all(s.id).map((r) => r.path);
  const fixes = db.prepare("SELECT id, title FROM memories WHERE session_id = ? AND kind = 'fix'").all(s.id);
  if (!s.prompts || (!edits.length && !fixes.length && s.prompts < 2 && !s.last_message)) return null;
  const body = [
    edits.length ? `Changed: ${edits.slice(0, 12).join(', ')}${edits.length > 12 ? ` and ${edits.length - 12} more` : ''}.` : null,
    fixes.length ? `Fixed: ${fixes.map((f) => `#${f.id} ${oneLine(f.title, 80)}`).join('; ')}.` : null,
    s.last_message ? `Ended with: ${oneLine(s.last_message, 600)}` : null,
  ].filter(Boolean).join('\n');
  addMemory({ project, sessionId: s.id, kind: 'summary', title: oneLine(s.first_prompt || 'Session', 140), body, files: edits.slice(0, 20) });
  db.prepare('DELETE FROM touches WHERE at < ?').run(now() - 7 * 86_400_000);
  db.prepare('DELETE FROM failures WHERE created_at < ?').run(now() - 7 * 86_400_000);
  return null;
}

export const HANDLERS = {
  SessionStart: sessionStart,
  UserPromptSubmit: userPromptSubmit,
  PostToolUse: postToolUse,
  PostToolUseFailure: failure,
  Stop: stop,
  SessionEnd: sessionEnd,
};
