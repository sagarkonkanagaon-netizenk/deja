// Measures what a user feels: wall time of each hook as Claude Code runs it
// (a fresh `node` process per call), against a database with real-sized history.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/deja.mjs', import.meta.url));
const N = Number(process.argv[2] || 5000);
const RUNS = Number(process.argv[3] || 30);

const home = mkdtempSync(join(tmpdir(), 'deja-bench-'));
const repo = join(home, 'repo');
mkdirSync(join(repo, '.git'), { recursive: true });
mkdirSync(join(repo, 'jobs'));
writeFileSync(join(repo, 'jobs', 'load.sql'), 'INSERT INTO silver.orders SELECT * FROM bronze.orders JOIN ref.fx USING (ccy)');
const env = { ...process.env, DEJA_HOME: home };

// Seed through the public API, in one process.
process.env.DEJA_HOME = home;
const { addMemory } = await import('../src/store.mjs');
const { openDb } = await import('../src/db.mjs');
const words = 'spark delta airflow backfill partition schema merge null skew retry vendor api cache index timeout auth token deploy docker test build lint migration'.split(' ');
const pick = () => words[Math.floor(Math.random() * words.length)];
openDb().exec('BEGIN');
for (let i = 0; i < N; i++) {
  addMemory({ project: repo, kind: ['decision', 'gotcha', 'fix', 'note', 'summary'][i % 5], title: `${pick()} ${pick()} ${pick()} memory ${i}`, body: Array.from({ length: 30 }, pick).join(' ') });
}
openDb().exec('COMMIT');

const input = (extra) => JSON.stringify({ session_id: 'bench', cwd: repo, ...extra });
const cases = {
  SessionStart: input({}),
  UserPromptSubmit: input({ prompt: 'the spark backfill job keeps failing on a skewed partition merge' }),
  'PostToolUse (Edit .sql)': input({ tool_name: 'Edit', tool_input: { file_path: join(repo, 'jobs', 'load.sql') } }),
  'PostToolUse (Bash)': input({ tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: {} }),
  PostToolUseFailure: input({ tool_name: 'Bash', tool_input: { command: 'pytest' }, error: "E   ModuleNotFoundError: No module named 'pyarrow'" }),
};

const baseline = [];
for (let i = 0; i < RUNS; i++) {
  const t = performance.now();
  execFileSync(process.execPath, ['-e', '0']);
  baseline.push(performance.now() - t);
}

const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];
const ms = (x) => `${x.toFixed(0)} ms`.padStart(7);
console.log(`deja hook latency, ${N} memories, ${RUNS} runs each, Node ${process.versions.node}\n`);
console.log(`${'hook'.padEnd(26)}   p50      p95`);
console.log(`${'(bare `node -e 0`)'.padEnd(26)} ${ms(pct(baseline, 0.5))}  ${ms(pct(baseline, 0.95))}`);
for (const [name, stdin] of Object.entries(cases)) {
  const event = name.split(' ')[0];
  const times = [];
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now();
    const r = spawnSync(process.execPath, [BIN, 'hook', event], { input: stdin, env });
    times.push(performance.now() - t);
    if (r.status !== 0) throw new Error(`${name} exited ${r.status}: ${r.stderr}`);
  }
  console.log(`${name.padEnd(26)} ${ms(pct(times, 0.5))}  ${ms(pct(times, 0.95))}`);
}
