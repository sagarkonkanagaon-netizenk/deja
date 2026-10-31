// Enforces the machine-checkable rules in docs/STANDARDS.md. Run with `npm run check`;
// CI runs it on every pull request. Each failure names the standard it breaks.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.DEJA_DB = ':memory:';
const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(root + p, 'utf8');
const json = (p) => JSON.parse(read(p));
const failures = [];
const check = (id, ok, message) => ok || failures.push(`${id}  ${message}`);

// A1: no runtime dependencies.
const pkg = json('package.json');
check('A1', !pkg.dependencies || !Object.keys(pkg.dependencies).length, 'package.json must not declare runtime "dependencies"');

// A2, A3, R3: source code makes no network calls, spawns nothing and never writes to stdout by hand.
const src = readdirSync(root + 'src').filter((f) => f.endsWith('.mjs'));
for (const f of src) {
  const text = read(`src/${f}`);
  check('A2', !/node:(https?|net|dgram|tls)\b|\bfetch\(/.test(text), `src/${f} must not use the network`);
  check('A3', !/node:child_process|\bworker_threads\b/.test(text), `src/${f} must not start processes or threads`);
  if (f !== 'mcp.mjs') check('R3', !/console\.(log|info)|process\.stdout\.write/.test(text), `src/${f} must not write to stdout (hooks print only their JSON)`);
}

// T1: the MCP tool list and instructions stay small, because every session pays for them.
const { handle } = await import('../src/mcp.mjs');
const toolChars = JSON.stringify(handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }).result.tools).length
  + handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }).result.instructions.length;
check('T1', toolChars / 4 <= 900, `MCP tool list + instructions is ~${Math.ceil(toolChars / 4)} tokens; the budget is 900`);

// D1: one version everywhere, with a changelog entry.
const { VERSION } = await import('../src/version.mjs');
for (const p of ['package.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json']) {
  check('D1', json(p).version === VERSION, `${p} version ${json(p).version} differs from src/version.mjs ${VERSION}`);
}
check('D1', read('CHANGELOG.md').includes(`## ${VERSION}`), `CHANGELOG.md has no "## ${VERSION}" entry`);

// C2: every hook wired in either agent points at a handler that exists.
const { HANDLERS } = await import('../src/hooks.mjs');
for (const p of ['hooks/hooks.json', 'hooks/codex-hooks.json']) {
  for (const [event, groups] of Object.entries(json(p).hooks)) {
    for (const h of groups.flatMap((g) => g.hooks)) {
      const target = h.command.match(/deja\.mjs" hook (\w+)/)?.[1];
      check('C2', target && HANDLERS[target], `${p} ${event} runs "${h.command}", which has no handler`);
      check('R4', (h.timeout ?? 0) <= 10, `${p} ${event} timeout must be 10 s or less`);
    }
  }
}

if (failures.length) {
  console.error(`deja standards: ${failures.length} problem(s)\n${failures.map((f) => '  ✘ ' + f).join('\n')}\nSee docs/STANDARDS.md.`);
  process.exit(1);
}
console.log('deja standards: all checks pass');
