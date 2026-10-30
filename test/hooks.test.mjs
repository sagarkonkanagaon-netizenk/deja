import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ctx, repo, write } from './helpers.mjs';
import { failure, postToolUse, sessionEnd, sessionStart, stop, userPromptSubmit } from '../src/hooks.mjs';
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
