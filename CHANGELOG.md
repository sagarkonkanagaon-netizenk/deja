# Changelog

## 0.2.0

**New: command playbook**
- deja learns which test, build, lint and run commands actually work in each repo and lists them in the session briefing, with links to fixes for the ones that need a step first.

**Accuracy**
- Error signatures ignore the summary lines every failure prints (Jest, Vitest, pytest, RSpec, Go, Gradle, Maven, make, tsc, cargo, npm), so different failing tests no longer look like the same bug.
- Signatures now recognise CamelCase exception names, assertion diffs, Go and Vitest failures, ESLint rule lines, Terraform's boxed errors, and C#/Maven positions, and they normalize durations.
- A passing run of a *different* test target no longer counts as the fix (`pytest tests/b.py` does not resolve `pytest tests/a.py`).

**Behaviour**
- After `/compact` or `/clear`, the briefing and file memories are shown again.
- Linked git worktrees share the main repository's memory.
- Slash commands and pasted blobs no longer name session summaries.
- Injected context is labelled as notes to verify, not instructions.
- The newest 200 session summaries are kept per repo (`DEJA_KEEP_SUMMARIES`), and `deja prune` clears older history.

**Performance**
- Stale checks skip hashing files whose mtime and size are unchanged.
- Files over 1 MB are not parsed for lineage inside hooks.

**Internals**
- Schema migrations via `PRAGMA user_version`; 0.1 databases upgrade in place.
- New `docs/ARCHITECTURE.md`.

## 0.1.0

- First release: error → fix memory, stale detection, contextual recall, data lineage, MCP server, CLI, slash commands and skill.
