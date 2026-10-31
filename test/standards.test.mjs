import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commitProblems } from '../scripts/check-commit.mjs';

test('commit headers follow Conventional Commits with a 72-character limit', () => {
  for (const ok of ['feat(codex): recall fixes from apply_patch edits', 'fix: ignore Vitest durations', 'feat(mcp)!: rename recall to search', 'chore(deps): bump typescript from 5.9.3 to 7.0.2', 'ci: bump actions/checkout from 4 to 7']) {
    assert.deepEqual(commitProblems(ok), [], ok);
  }
  assert.match(commitProblems('Add a thing')[0], /must look like/);
  assert.match(commitProblems('feature: add a thing')[0], /must look like/);
  assert.match(commitProblems('feat: Add a thing').join(), /lower case/);
  assert.match(commitProblems('feat: add a thing.').join(), /period/);
  assert.match(commitProblems('fix: fixed the parser').join(), /imperative/);
  assert.match(commitProblems(`docs: ${'x'.repeat(70)}`).join(), /limit is 72/);
});
