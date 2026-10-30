import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Every test file gets its own database and a throwaway git repo.
process.env.DEJA_HOME = mkdtempSync(join(tmpdir(), 'deja-home-'));
process.env.DEJA_DB = ':memory:';

export function repo(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'deja-repo-'));
  mkdirSync(join(root, '.git'));
  for (const [p, body] of Object.entries(files)) write(root, p, body);
  return root;
}

export function write(root, p, body) {
  const abs = join(root, p);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
  return abs;
}

export const ctx = (r) => r?.hookSpecificOutput?.additionalContext ?? '';
