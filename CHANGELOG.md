# Changelog

## 0.4.0

**New: OpenAI Codex support**
- deja installs as a Codex plugin (`codex plugin marketplace add sagarkonkanagaon-netizenk/deja`, then `codex plugin add deja@deja`) with its hooks, MCP tools and skill.
- Codex and Claude Code share one memory: a fix learned in one comes back in the other.
- Hooks understand Codex payloads: files changed through `apply_patch`, and failed shell commands reported as `Exit code: N` text or an `exit_code` field on `PostToolUse`.
- The MCP server finds the user's project when an agent starts it inside the plugin folder, as Codex does.

## 0.3.0

**New: `deja ui`**
- `/deja:ui` or `deja ui` opens a visual browser of everything deja knows about a repo: memories with kind and staleness filters, learned fixes (error, fix and cause), the command playbook with pass rates, an interactive lineage graph and a session timeline.
- It is one self-contained HTML file with the data inlined: no server, no port, no network. It works offline, follows the system light or dark theme with a manual toggle, and fits phone screens.
- `--all` covers every repo on the machine, `--out FILE` picks the path and `--no-open` skips launching the browser.
- Memory text is escaped so nothing stored can break out of the page's data block.

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
