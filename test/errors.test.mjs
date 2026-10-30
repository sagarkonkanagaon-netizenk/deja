import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandFamily, errorSignature, keyLines } from '../src/errors.mjs';
import { redact } from '../src/redact.mjs';

test('same error on different machines has the same signature', () => {
  const a = errorSignature("Exit code 1\nError: Cannot find module 'express'\n    at Module._resolve (/home/a/app/node_modules/x.js:12:5)");
  const b = errorSignature("Exit code 1\nError: Cannot find module 'express'\n    at Object.<anonymous> (/Users/b/code/index.js:3:1)");
  assert.equal(a.signature, b.signature);
  assert.match(a.text, /Cannot find module 'express'/);
});

test('different missing modules are different errors', () => {
  assert.notEqual(errorSignature("Error: Cannot find module 'express'").signature, errorSignature("Error: Cannot find module 'react'").signature);
});

test('python tracebacks key on the final exception line', () => {
  const tb = `Traceback (most recent call last):
  File "/srv/job/run.py", line 88, in <module>
    main()
  File "/srv/job/run.py", line 12, in main
    df = spark.table("silver.orders")
pyspark.sql.utils.AnalysisException: [TABLE_OR_VIEW_NOT_FOUND] The table or view \`silver\`.\`orders\` cannot be found.`;
  const lines = keyLines(tb);
  assert.match(lines.at(-1), /AnalysisException/);
  assert.doesNotMatch(lines.join(), /line 88/);
});

test('numbers, hashes and timestamps are normalized', () => {
  const a = errorSignature('ERROR 2026-10-30T10:00:01Z task 4412 failed: port 5432 refused (pid 991)');
  const b = errorSignature('ERROR 2026-11-02T08:13:44Z task 17 failed: port 5432 refused (pid 12)');
  assert.equal(a.signature, b.signature);
});

test('command families group variants of the same command', () => {
  assert.equal(commandFamily('npm test -- --watch'), 'npm test');
  assert.equal(commandFamily('npm run build:prod'), 'npm run build:prod');
  assert.equal(commandFamily('cd app && CI=1 pytest tests/test_a.py -k slow'), 'pytest');
  assert.equal(commandFamily('python -m pytest -x'), 'python -m pytest');
  assert.equal(commandFamily('uv run pytest'), 'pytest');
  assert.equal(commandFamily('npx tsc --noEmit'), 'tsc');
  assert.equal(commandFamily('dbt run --select orders'), 'dbt run');
  assert.equal(commandFamily('./gradlew test'), 'gradlew');
});

test('secrets never reach the database', () => {
  // Fake credentials are assembled at runtime so secret scanners do not flag this file.
  const fake = (prefix, n) => prefix + 'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(2).slice(0, n);
  const s = redact(`export OPENAI_API_KEY=${fake('sk-proj-', 24)} and ${fake('gh' + 'p_', 36)} postgres://bob:hunter2@db:5432/x password=supersecret <private>my notes</private>`);
  assert.doesNotMatch(s, /abcdefghijklmnop|hunter2|supersecret|my notes/);
  assert.match(s, /\[private\]/);
  assert.equal(redact('dap' + 'i' + '0123456789abcdef'.repeat(2)), '[databricks token]');
});
