import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ctx, repo, write } from './helpers.mjs';
import { fileURLToPath } from 'node:url';
import { exitOf, failure, patchFiles, postToolUse, sessionEnd, sessionStart, stop, userPromptSubmit } from '../src/hooks.mjs';
import { addMemory, search } from '../src/store.mjs';
import { handle } from '../src/mcp.mjs';

const bash = (cwd, session_id, command, extra = {}) => ({ cwd, session_id, tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: '' }, ...extra });
const fail = (cwd, session_id, command, error) => ({ cwd, session_id, tool_name: 'Bash', tool_input: { command }, error });

test('learns error → fix in one session and recalls it in the next', () => {
  const cwd = repo({ 'src/app.js': 'require("express")' });
  sessionStart({ cwd, session_id: 'a1' });
  userPromptSubmit({ cwd, session_id: 'a1', prompt: 'the tests are failing, please fix them' });
  assert.equal(ctx(failure(fail(cwd, 'a1', 'npm test', "Exit code 1\nError: Cannot find module 'express'\n    at x (/home/a/app/src/app.js:1:1)"))), '');
  postToolUse(bash(cwd, 'a1', 'npm install express'));
  const learned = ctx(postToolUse(bash(cwd, 'a1', 'npm test')));
  assert.match(learned, /saved fix memory #\d+/);
  stop({ cwd, session_id: 'a1', last_assistant_message: 'Installed express; tests pass.' });
  sessionEnd({ cwd, session_id: 'a1' });

  const start = ctx(sessionStart({ cwd, session_id: 'a2' }));
  assert.match(start, /Fixes learned/);
  assert.match(start, /Cannot find module 'express'/);
  assert.match(start, /Last session/);

  // Same error, different stack paths, new session: the fix comes back.
  const again = ctx(failure(fail(cwd, 'a2', 'npm test -- --ci', "Exit code 1\nError: Cannot find module 'express'\n    at y (/Users/b/work/src/app.js:9:9)")));
  assert.match(again, /seen this error before/);
  assert.match(again, /npm install express/);
});

test('a root cause saved with remember rides along with the auto-captured fix', () => {
  const cwd = repo({ 'jobs/silver.py': 'x' });
  process.env.CLAUDE_PROJECT_DIR = cwd;
  const err = "AnalysisException: [DELTA_FAILED_TO_MERGE_FIELDS] Failed to merge fields 'amount' and 'amount'";
  failure(fail(cwd, 'c1', 'spark-submit jobs/silver.py', err));
  postToolUse({ cwd, session_id: 'c1', tool_name: 'Edit', tool_input: { file_path: `${cwd}/jobs/silver.py` } });
  postToolUse(bash(cwd, 'c1', 'spark-submit jobs/silver.py'));
  const r = handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'remember', arguments: { kind: 'fix', title: 'Source sends amount as double', body: 'cast to decimal(12,2) before MERGE' } } });
  assert.match(r.result.content[0].text, /Added the cause to fix #/);
  const again = ctx(failure(fail(cwd, 'c2', 'spark-submit jobs/silver.py', err)));
  assert.match(again, /edited jobs\/silver\.py/);
  assert.match(again, /cast to decimal\(12,2\) before MERGE/);
});

test('fixes travel across projects, labelled with where they came from', () => {
  const a = repo();
  const b = repo();
  failure(fail(a, 'x1', 'pytest', 'E   ModuleNotFoundError: No module named \'pyarrow\''));
  postToolUse(bash(a, 'x1', 'pip install pyarrow'));
  postToolUse(bash(a, 'x1', 'pytest'));
  const out = ctx(failure(fail(b, 'y1', 'pytest -x', 'E   ModuleNotFoundError: No module named \'pyarrow\'')));
  assert.match(out, /pip install pyarrow/);
  assert.match(out, / in deja-repo-/);
});

test('a plain retry that passes teaches nothing (flaky), and grep misses are not bugs', () => {
  const cwd = repo();
  failure(fail(cwd, 'f1', 'npm test', 'Error: socket hang up'));
  assert.equal(ctx(postToolUse(bash(cwd, 'f1', 'npm test'))), '');
  assert.equal(failure(fail(cwd, 'f1', 'grep -r foo .', 'Exit code 1')), null);
  assert.equal(search({ project: cwd, query: 'socket', kind: 'fix' }).length, 0);
});

test('memories about a file come back when Claude opens it, once per session', () => {
  const cwd = repo({ 'etl/load.py': 'x = 1' });
  addMemory({ project: cwd, kind: 'gotcha', title: 'load.py must run after the FX snapshot', body: 'Otherwise revenue is double-converted.', files: ['etl/load.py'] });
  const first = ctx(postToolUse({ cwd, session_id: 'r1', tool_name: 'Read', tool_input: { file_path: `${cwd}/etl/load.py` } }));
  assert.match(first, /FX snapshot/);
  assert.equal(ctx(postToolUse({ cwd, session_id: 'r1', tool_name: 'Read', tool_input: { file_path: `${cwd}/etl/load.py` } })), '');
});

test('memories go stale when their files change', () => {
  const cwd = repo({ 'conf/retry.yml': 'retries: 3' });
  addMemory({ project: cwd, kind: 'decision', title: 'Retries are 3 because the vendor API rate-limits at 4', files: ['conf/retry.yml'] });
  assert.doesNotMatch(ctx(sessionStart({ cwd, session_id: 's1' })), /Possibly outdated/);
  write(cwd, 'conf/retry.yml', 'retries: 10');
  const out = ctx(sessionStart({ cwd, session_id: 's2' }));
  assert.match(out, /Possibly outdated[\s\S]*vendor API/);
});

test('prompts pull in related memories without repeating ones already shown', () => {
  const cwd = repo();
  addMemory({ project: cwd, kind: 'decision', title: 'Backfills use replaceWhere on the dt partition', body: 'Never overwrite the whole Delta table during backfill.' });
  sessionStart({ cwd, session_id: 'p0' });
  assert.equal(ctx(userPromptSubmit({ cwd, session_id: 'p0', prompt: 'write a backfill for the orders delta table' })), '', 'already shown at session start');
  const out = ctx(userPromptSubmit({ cwd, session_id: 'p1', prompt: 'write a backfill for the orders delta table' }));
  assert.match(out, /replaceWhere/);
  assert.equal(ctx(userPromptSubmit({ cwd, session_id: 'p2', prompt: 'what time is it in tokyo right now' })), '');
});

test('a .deja-off file disables capture for that repo', () => {
  const cwd = repo({ '.deja-off': '' });
  assert.equal(sessionStart({ cwd, session_id: 'off' }), null);
});

test('MCP server speaks JSON-RPC and its tools work', () => {
  const cwd = repo({ 'm.sql': 'INSERT INTO gold.kpis SELECT * FROM silver.events' });
  process.env.CLAUDE_PROJECT_DIR = cwd;
  assert.equal(handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }).result.serverInfo.name, 'deja');
  const names = handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }).result.tools.map((t) => t.name);
  assert.deepEqual(names, ['recall', 'get', 'remember', 'forget', 'lineage', 'scan_lineage']);
  const call = (name, args) => handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } }).result.content[0].text;
  assert.match(call('remember', { title: 'KPIs are computed in UTC', kind: 'decision', files: ['m.sql'] }), /Saved memory #(\d+)/);
  assert.match(call('recall', { query: 'utc kpis' }), /KPIs are computed in UTC/);
  assert.match(call('scan_lineage', {}), /1 had lineage/);
  assert.match(call('lineage', { name: 'gold.kpis' }), /← silver\.events/);
  assert.equal(handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(handle({ jsonrpc: '2.0', id: 9, method: 'nope' }).error.code, -32601);
});

test('a passing run of a different test target does not count as the fix', () => {
  const cwd = repo();
  failure(fail(cwd, 't1', 'pytest tests/test_a.py', 'E   KeyError: \'customer_id\''));
  postToolUse({ cwd, session_id: 't1', tool_name: 'Edit', tool_input: { file_path: `${cwd}/src/x.py` } });
  assert.equal(ctx(postToolUse(bash(cwd, 't1', 'pytest tests/test_b.py'))), '');
  assert.match(ctx(postToolUse(bash(cwd, 't1', 'pytest tests/test_a.py -q'))), /saved fix memory/);
});

test('after /compact the briefing and file memories can be shown again', () => {
  const cwd = repo({ 'api/auth.ts': 'x' });
  addMemory({ project: cwd, kind: 'gotcha', title: 'Session cookies need SameSite=None behind the proxy', files: ['api/auth.ts'] });
  const read = () => ctx(postToolUse({ cwd, session_id: 'k1', tool_name: 'Read', tool_input: { file_path: `${cwd}/api/auth.ts` } }));
  sessionStart({ cwd, session_id: 'k1', source: 'startup' });
  assert.equal(read(), '', 'already in the startup briefing');
  assert.match(ctx(sessionStart({ cwd, session_id: 'k1', source: 'compact' })), /SameSite=None/);
});

test('slash commands and pasted blobs do not name the session', () => {
  const cwd = repo({ 'a.js': '' });
  userPromptSubmit({ cwd, session_id: 'n1', prompt: '/deja:stats' });
  userPromptSubmit({ cwd, session_id: 'n1', prompt: 'refactor the rate limiter <pasted_content id="x">\nhuge log\n</pasted_content id="x">' });
  postToolUse({ cwd, session_id: 'n1', tool_name: 'Edit', tool_input: { file_path: `${cwd}/a.js` } });
  sessionEnd({ cwd, session_id: 'n1' });
  const [s] = search({ project: cwd, kind: 'summary' });
  assert.equal(s.title, 'refactor the rate limiter');
});

test('git worktrees share the main repository\'s memory', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { projectRoot } = await import('../src/util.mjs');
  const main = repo();
  mkdirSync(join(main, '.git', 'worktrees', 'feature'), { recursive: true });
  const wt = repo();
  const { rmSync } = await import('node:fs');
  rmSync(join(wt, '.git'), { recursive: true });
  writeFileSync(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'feature')}\n`);
  assert.equal(projectRoot(join(wt)), main);
});

test('the briefing lists the commands that work in this repo', () => {
  const cwd = repo();
  for (let i = 0; i < 3; i++) postToolUse(bash(cwd, 'w1', 'npm run test:integration'));
  postToolUse(bash(cwd, 'w1', 'docker compose up -d postgres'));
  postToolUse(bash(cwd, 'w1', 'docker compose up -d postgres'));
  for (let i = 0; i < 5; i++) postToolUse(bash(cwd, 'w1', 'git status'));
  postToolUse(bash(cwd, 'w1', 'cat README.md'));
  failure(fail(cwd, 'w1', 'npm run test:integration', "PrismaClientInitializationError: Can't reach database server at `localhost`:`5432`"));
  const out = ctx(sessionStart({ cwd, session_id: 'w2' }));
  assert.match(out, /Commands that work in this repo:\n- `npm run test:integration` \(worked 3×, failed 1×\)\n- `docker compose up -d postgres` \(worked 2×\)/);
  assert.doesNotMatch(out, /git status|cat README/);
});

test('the playbook stores the command, not how Claude watched its output', async () => {
  const { coreCommand } = await import('../src/hooks.mjs');
  assert.equal(coreCommand('npm test 2>&1 | tail -20'), 'npm test');
  assert.equal(coreCommand('pytest -x 2>&1 | grep -E "passed|failed"'), 'pytest -x');
  assert.equal(coreCommand('make build && echo done'), 'make build');
  assert.equal(coreCommand('docker compose up -d postgres'), 'docker compose up -d postgres');
});

test('a session resumed in another repo starts fresh there', () => {
  const a = repo({ 'x.js': '' });
  const b = repo({ 'y.js': '' });
  userPromptSubmit({ cwd: a, session_id: 'mv', prompt: 'fix the login redirect loop' });
  userPromptSubmit({ cwd: b, session_id: 'mv', prompt: 'add pagination to the orders endpoint' });
  postToolUse({ cwd: b, session_id: 'mv', tool_name: 'Edit', tool_input: { file_path: `${b}/y.js` } });
  sessionEnd({ cwd: b, session_id: 'mv' });
  assert.equal(search({ project: b, kind: 'summary' })[0].title, 'add pagination to the orders endpoint');
});

test('Codex: apply_patch edits, "Exit code" text failures and fix recall', () => {
  const cwd = repo({ 'src/db.ts': 'export const url = process.env.DATABASE_URL' });
  const codex = (session_id, extra) => ({ cwd, session_id, hook_event_name: 'PostToolUse', model: 'gpt-5', turn_id: 't', ...extra });
  const sh = (session_id, command, tool_response) => codex(session_id, { tool_name: 'Bash', tool_input: { command }, tool_response });
  sessionStart({ cwd, session_id: 'x1', source: 'startup' });
  const failed = postToolUse(sh('x1', 'npm run test:integration', 'Exit code: 1\nWall time: 2.1 seconds\nOutput:\nPrismaClientInitializationError: Can\'t reach database server at `localhost:5432`\n'));
  assert.equal(failed, null);
  postToolUse(codex('x1', { tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: src/db.ts\n@@\n-x\n+y\n*** End Patch' } }));
  postToolUse(sh('x1', 'docker compose up -d postgres', { exit_code: 0, output: 'started' }));
  const learned = postToolUse(sh('x1', 'npm run test:integration', 'Exit code: 0\nWall time: 3 seconds\nOutput:\nok\n'));
  assert.match(ctx(learned), /saved fix memory/);
  const fix = search({ project: cwd, query: 'database server', kind: 'fix' })[0];
  assert.match(fix.body, /docker compose up -d postgres/);
  assert.match(fix.body, /src\/db\.ts/);

  const again = postToolUse(sh('x2', 'npm run test:integration', { exit_code: 1, output: 'PrismaClientInitializationError: Can\'t reach database server at `db.internal:5432`' }));
  assert.equal(again.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(ctx(again), /seen this error before/);
});

test('patchFiles and exitOf read Codex tool payloads', () => {
  assert.deepEqual(patchFiles('*** Begin Patch\n*** Add File: a/new.py\n+x\n*** Update File: b.sql\n*** Move to: c.sql\n*** Delete File: d.txt\n*** End Patch'), ['a/new.py', 'b.sql', 'c.sql', 'd.txt']);
  assert.deepEqual(exitOf('Exit code: 2\nWall time: 1s\nOutput:\nboom'), { code: 2, output: 'boom' });
  assert.equal(exitOf({ exit_code: 0, output: 'fine' }).code, 0);
  assert.equal(exitOf({ metadata: { exit_code: 127 }, output: 'nope' }).code, 127);
  assert.equal(exitOf(undefined).code, 0);
});

test('MCP server started inside the plugin folder (Codex) finds the user\'s project', async () => {
  const { project } = await import('../src/mcp.mjs');
  const cwd = repo();
  const saved = { dir: process.env.CLAUDE_PROJECT_DIR, pwd: process.env.PWD, cwd: process.cwd() };
  try {
    delete process.env.CLAUDE_PROJECT_DIR;
    process.chdir(fileURLToPath(new URL('..', import.meta.url)));
    process.env.PWD = cwd;
    assert.equal(project(), cwd);
    process.env.CLAUDE_PROJECT_DIR = cwd;
    assert.equal(project(), cwd);
  } finally {
    if (saved.dir === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = saved.dir;
    process.env.PWD = saved.pwd;
    process.chdir(saved.cwd);
  }
});
