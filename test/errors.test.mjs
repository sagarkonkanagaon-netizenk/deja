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

test('generic test-runner summaries never become the signature', () => {
  const jestA = `FAIL src/a.test.js\n  ● sum › adds\n    expect(received).toBe(expected)\nTests:       1 failed, 4 passed, 5 total\nnpm ERR! Test failed.  See above for more details.`;
  const jestB = `FAIL src/b.test.js\n  ● parse › handles empty\n    TypeError: Cannot read properties of undefined (reading 'trim')\nTest Suites: 1 failed, 2 passed, 3 total\nTests:       1 failed, 9 passed, 10 total`;
  assert.notEqual(errorSignature(jestA).signature, errorSignature(jestB).signature);
  assert.deepEqual(keyLines('FAILURE: Build failed with an exception.\nBUILD FAILED in 2s'), []);
  assert.deepEqual(keyLines('src/index.ts(3,7): error TS2322: Type x.\nFound 1 error in src/index.ts:3'), ['src/index.ts(N,N): error TS2322: Type x.']);
  assert.deepEqual(keyLines("error[E0425]: cannot find value `x` in this scope\nerror: could not compile `demo` due to 1 previous error"), ['error[E0425]: cannot find value `x` in this scope']);
  assert.deepEqual(keyLines('gcc: error: foo.c: No such file or directory\nmake: *** [Makefile:3: all] Error 1'), ['gcc: error: foo.c: No such file or directory']);
  assert.equal(errorSignature('Exit code 1\n=== 2 failed, 3 passed in 0.12s ==='), null);
});

test('signatures pick the meaningful line across stacks', () => {
  const cases = [
    ['--- FAIL: TestParse (0.00s)\n    parse_test.go:12: expected 3, got 4\nFAIL\nFAIL\texample.com/pkg\t0.004s', /expected 3, got 4/],
    ['/home/u/app/src/a.ts\n  3:7  error  \'x\' is assigned a value but never used  no-unused-vars\n\n✖ 1 problem (1 error, 0 warnings)', /never used/],
    ['│ Error: Unsupported argument\n│\n│   on main.tf line 12, in resource "aws_s3_bucket" "b":', /Unsupported argument/],
    [' FAIL  src/sum.test.ts > sum > adds\nAssertionError: expected 4 to be 3\n Test Files  1 failed (1)\n      Tests  1 failed (1)', /expected 4 to be 3/],
    ['Failures:\n  1) User#name\n     Failure/Error: expect(user.name).to eq("A B")\n1 example, 1 failure', /Failure\/Error/],
    ['[ERROR] /src/main/java/App.java:[5,9] cannot find symbol\n[ERROR] BUILD FAILURE', /cannot find symbol/],
    ['src/app.py:10: error: Incompatible return value type  [return-value]\nFound 1 error in 1 file', /Incompatible return value/],
  ];
  for (const [text, want] of cases) {
    const lines = keyLines(text);
    assert.ok(lines.some((l) => want.test(l)), `${want} in ${JSON.stringify(lines)}`);
    assert.ok(!lines.some((l) => /\d+ (failed|problem|failure)|BUILD FAILURE|Found \d/.test(l)), JSON.stringify(lines));
  }
  // Durations differ run to run and must not change the signature.
  assert.equal(errorSignature('FAIL\texample.com/pkg\t0.004s\nerror: x').signature, errorSignature('FAIL\texample.com/pkg\t1.27s\nerror: x').signature);
});
