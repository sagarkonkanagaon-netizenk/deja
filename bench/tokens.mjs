// Measures every token deja adds to an agent's context: the MCP tool list, the
// session briefing, and the one-line notes it injects. deja makes no model calls,
// so this is its whole token cost. Counts use @anthropic-ai/tokenizer when it is
// installed (npx -p @anthropic-ai/tokenizer node bench/tokens.mjs) and otherwise
// fall back to characters / 4.
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let countTokens = (s) => Math.ceil(s.length / 4);
let method = 'characters / 4';
try {
  ({ countTokens } = createRequire(import.meta.url)('@anthropic-ai/tokenizer'));
  method = '@anthropic-ai/tokenizer';
} catch {}
process.env.DEJA_HOME = mkdtempSync(join(tmpdir(), 'dh-'));
process.env.DEJA_DB = ':memory:';
const D = '../src/';
const { sessionStart, userPromptSubmit, postToolUse, failure, stop, sessionEnd } = await import(D + 'hooks.mjs');
const { addMemory } = await import(D + 'store.mjs');
const { handle } = await import(D + 'mcp.mjs');
const ctx = (r) => r?.hookSpecificOutput?.additionalContext ?? '';
const T = (s) => countTokens(s || '');
const repo = () => { const r = mkdtempSync(join(tmpdir(), 'rp-')); mkdirSync(join(r, '.git')); mkdirSync(join(r,'src')); writeFileSync(join(r,'src/db.ts'),'x'); writeFileSync(join(r,'src/api.ts'),'y'); return r; };
const bash = (cwd, id, command) => ({ cwd, session_id: id, tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: 'ok' } });
const res = {};

// MCP tool definitions (sent once per session with the tool list)
res.tools = T(JSON.stringify(handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }).result.tools));
res.instructions = T(handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }).result.instructions);

// Empty project
const empty = repo();
res.briefEmpty = T(ctx(sessionStart({ cwd: empty, session_id: 'e1', source: 'startup' })));

// Typical project: a learned fix, playbook, decisions, gotchas
const cwd = repo();
sessionStart({ cwd, session_id: 's1', source: 'startup' });
userPromptSubmit({ cwd, session_id: 's1', prompt: 'integration tests fail, please fix the database connection' });
failure({ cwd, session_id: 's1', tool_name: 'Bash', tool_input: { command: 'npm run test:integration' }, error: "Exit code 1\nPrismaClientInitializationError: Can't reach database server at `localhost:5432`" });
postToolUse(bash(cwd, 's1', 'docker compose up -d postgres'));
postToolUse({ cwd, session_id: 's1', tool_name: 'Edit', tool_input: { file_path: cwd + '/src/db.ts' } });
for (let i = 0; i < 3; i++) { postToolUse(bash(cwd, 's1', 'npm run test:integration')); postToolUse(bash(cwd, 's1', 'npm run lint')); postToolUse(bash(cwd, 's1', 'npm run build')); }
stop({ cwd, session_id: 's1', last_assistant_message: 'Started Postgres with docker compose; integration tests pass.' });
sessionEnd({ cwd, session_id: 's1' });
const mem = [
  ['decision', 'API errors use RFC 7807 problem+json', 'The mobile app parses `type`, not `message`.', ['src/api.ts']],
  ['gotcha', 'Prisma migrations must run before seeding', 'Seed script assumes the latest schema; run `npx prisma migrate deploy` first.', ['src/db.ts']],
  ['gotcha', 'Session cookies need SameSite=None behind the CDN', 'Otherwise login loops on Safari.', []],
  ['decision', 'Webhook retries capped at 3', 'Stripe retries on its side too; more causes duplicate refunds.', []],
  ['todo', 'Move idempotency keys to Redis', 'In-memory map is lost on deploy.', []],
];
for (const [kind, title, body, files] of mem) addMemory({ project: cwd, kind, title, body, files });
res.briefTypical = T(ctx(sessionStart({ cwd, session_id: 's2', source: 'startup' })));
res.promptRecall = T(ctx(userPromptSubmit({ cwd, session_id: 's2', prompt: 'add retries to the stripe webhook refunds handler' })));
res.fileNote = T(ctx(postToolUse({ cwd, session_id: 's2', tool_name: 'Read', tool_input: { file_path: cwd + '/src/api.ts' } })));
res.fixRecall = T(ctx(failure({ cwd, session_id: 's2', tool_name: 'Bash', tool_input: { command: 'npm run test:integration' }, error: "Exit code 1\nPrismaClientInitializationError: Can't reach database server at `db:5432`" })));

res.promptRecallFresh = T(ctx(userPromptSubmit({ cwd, session_id: 's3', prompt: 'add retries to the stripe webhook refunds handler' })));
res.fileNoteFresh = T(ctx(postToolUse({ cwd, session_id: 's4', tool_name: 'Read', tool_input: { file_path: cwd + '/src/api.ts' } })));
// Large project: 300 memories, briefing hits its cap
const big = repo();
for (let i = 0; i < 300; i++) addMemory({ project: big, kind: ['decision','gotcha','fix','note','todo'][i % 5], title: `Rule ${i}: keep the ${['cache','queue','api','db','auth'][i%5]} layer consistent with service ${i}`, body: 'Detail '.repeat(30) });
res.briefLarge = T(ctx(sessionStart({ cwd: big, session_id: 'b1', source: 'startup' })));
process.env.DEJA_CONTEXT_TOKENS = '500';
res.briefLarge500 = T(ctx(sessionStart({ cwd: big, session_id: 'b2', source: 'startup' })));
const rows = [
  ['MCP tool list + instructions (once per session)', res.tools + res.instructions],
  ['Session briefing, new project', res.briefEmpty],
  ['Session briefing, typical project', res.briefTypical],
  ['Session briefing, 300 memories (default cap)', res.briefLarge],
  ['Session briefing, 300 memories, DEJA_CONTEXT_TOKENS=500', res.briefLarge500],
  ['Related memories on a prompt (when relevant)', res.promptRecallFresh],
  ['File memories when a file is opened (when relevant)', res.fileNoteFresh],
  ['Fix recalled when an error repeats', res.fixRecall],
];
console.log(`Tokens deja adds to context (${method})
`);
for (const [k, v] of rows) console.log(`${String(v).padStart(6)}  ${k}`);
