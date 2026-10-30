# deja architecture

This document explains how deja works and why it is built this way. It covers the process model, storage, error signatures, fix learning, staleness, ranking, context injection, lineage and failure handling.

## Design constraints

Everything below follows from four rules:

1. **Never hurt the session.** A memory system runs inside every prompt and every tool call. If it is slow, noisy or crashes, people uninstall it. Every hook exits 0, catches every error, logs to `~/.deja/deja.log`, and prints nothing except the hook's JSON.
2. **No daemon.** Background workers mean ports, crashes, stale PIDs and upgrade races. deja is a CLI that Claude Code runs per event: start, do one thing in SQLite, exit.
3. **No extra LLM calls.** The model that is already running knows *why* something happened. deja captures the *what* deterministically and gives the model a `remember` tool for the *why*. Capturing therefore costs zero tokens and works offline.
4. **Zero runtime dependencies.** Node ≥ 22.13 ships `node:sqlite` (SQLite with FTS5) and `node:test`. Nothing to install, compile or audit.

## Process model

```
Claude Code ──stdin JSON──▶ node bin/deja.mjs hook <Event> ──▶ SQLite (WAL) ──▶ stdout JSON ──▶ Claude Code
Claude Code ◀──JSON-RPC 2.0 over stdio──▶ node bin/deja.mjs mcp      (one long-lived process per session)
```

- **Hooks** are registered in `hooks/hooks.json` for `SessionStart`, `UserPromptSubmit`, `PostToolUse` (matcher `Bash|Edit|Write|MultiEdit|NotebookEdit|Read`), `PostToolUseFailure` (matcher `Bash`), `Stop` and `SessionEnd`. Each one gets the event JSON on stdin and may answer with `hookSpecificOutput.additionalContext`.
- **The MCP server** is a hand-written JSON-RPC 2.0 loop over newline-delimited stdio. It implements `initialize`, `ping`, `tools/list` and `tools/call`, and ignores notifications. There is no SDK, so there is nothing to keep in sync.
- **Startup cost.** Node takes about 35 ms to start. deja adds roughly 30–50 ms on top: it imports `node:sqlite` lazily, opens a cached connection, and runs prepared statements. See `bench/bench.mjs`.

## Storage

One file, `~/.deja/deja.db` (`DEJA_HOME` to move it), opened with `journal_mode=WAL`, `busy_timeout=3000`, `synchronous=NORMAL` and `foreign_keys=ON`. WAL lets parallel hooks (Claude Code runs tools in parallel) read while one writes. Writes use `BEGIN IMMEDIATE` so lock contention appears at the start of a transaction, where the busy timeout handles it, and not as a deadlock in the middle of one.

| Table | Purpose |
| --- | --- |
| `memories` | `id, project, session_id, kind, title, body, tags, signature, created_at, updated_at, hits, stale` |
| `memories_fts` | FTS5 external-content index over `title, body, tags` with the `porter unicode61` tokenizer, kept in sync by triggers |
| `anchors` | `(memory_id, path) → hash, mtime, size`: the files a memory describes |
| `failures` | Pending failed commands: `signature, family, command, error, mark` (the step-log position at failure time) |
| `touches` | Ordered step log per session: files edited and commands run |
| `commands` | The repo's playbook: per command family, the latest working form and its success and failure counts |
| `sessions` | `first_prompt, last_message, prompts, injected` (ids already shown this session) |
| `datasets`, `edges` | The lineage graph |

**Project identity** is the enclosing git root. Linked worktrees resolve through their `.git` file (`gitdir: …/.git/worktrees/<name>`) to the main checkout, so every worktree shares one memory. Stored paths are repo-relative with forward slashes, so memories and exports are identical on macOS, Linux and Windows.

**Migrations** use `PRAGMA user_version`. A fresh database gets the full schema; an older one runs only the migrations it lacks, inside one transaction.

## Error signatures

The core problem: the same bug produces different text every time. Paths differ between machines, line numbers move, ports, PIDs, UUIDs, durations and timestamps change. Meanwhile, completely different bugs print identical summary lines (`Tests: 1 failed, 9 passed`). A useful signature has to ignore the first kind of difference and not be fooled by the second.

`src/errors.mjs` does this in three passes:

1. **Clean.** Strip ANSI colours and leading box-drawing gutters (Terraform's `│`). Drop pure noise lines: stack frames (`at …`, `File "…"`), caret and tilde underlines, code-frame gutters.
2. **Remove generic lines.** Drop lines that every failure of a given tool prints: test-runner summaries (Jest, Vitest, pytest, RSpec, Go), `npm ERR!` lifecycle chatter, `BUILD FAILED`, Maven `[ERROR] BUILD FAILURE`, `make: ***`, `could not compile`, `Found N errors`, `Exit code N`, and `Traceback (most recent call last)` itself.
3. **Select signal lines.** Keep lines that look like a cause: CamelCase exception classes (`ModuleNotFoundError`, `AnalysisException`), error vocabulary (`cannot`, `not found`, `refused`, `undefined`, `mismatch`, `timed out`…), test-failure markers (`●`, `✕`, `FAILED`, `--- FAIL:`), and assertion diffs (`expected … got …`). Take the **last two** distinct ones, because Python and the JVM print the root cause at the bottom.

Each selected line is then normalized: absolute paths become `<path>/basename`, `:12:5` and `(12,5)` and `[12,5]` become `N`, durations become `<dur>`, numbers of three or more digits become `N`, and hex, UUIDs and ISO timestamps become placeholders. The signature is the first 16 hex characters of the SHA-1 of the normalized lines. If nothing meaningful survives, there is no signature, which is better than a vague one.

## Fix learning

A fix is learned from the session's own step log, with no guessing:

1. `PostToolUseFailure` on a Bash call computes the signature and the **command family**, and records a failure with `mark`, the current maximum row id of the step log.
2. Every later edit and command appends to `touches`.
3. When a Bash command **passes**, deja looks for open failures in the same session, of the same family, within 45 minutes, **and with overlapping targets**.
4. For each match it writes a `fix` memory: the error, the files edited after `mark`, the commands run, and the command that passed (noting when it differs from the failing one). The memory is anchored to those files.

**Command family** normalizes away wrappers (`npx`, `uv run`, `poetry`, `sudo`, `env`, `VAR=1`), leading `cd …&&`, and flags. For tools with subcommands it keeps the subcommand (`npm test`, `npm run build`, `cargo test`, `dbt run`, `python -m pytest`).

**Targets** are the path-like arguments. `pytest tests/b.py` passing does not resolve `pytest tests/a.py`. A run with no explicit targets (the full suite) resolves any failure in its family, and `tests/a.py::test_x` overlaps `tests/a.py`.

Some outcomes are not learned at all. A retry that passes with nothing changed in between is flakiness. Exit code 1 from `grep`, `diff`, `test`, `ls`, `which` and similar commands is an answer, not a bug.

When the error appears again, `PostToolUseFailure` looks the signature up in this repo first, then in every repo. If there is no exact match, it falls back to an FTS search over fixes and accepts a candidate only when the token overlap (Jaccard on error words) is at least 0.6. The fix is returned as `additionalContext`, which Claude sees directly beside the failed tool result.

**Root causes.** When Claude calls `remember` with kind `fix` within two hours of an auto-captured fix in the same repo, the explanation is attached to that fix as `Cause: …` rather than saved separately. That way the *why* comes back with the signature.

## Command playbook

Every Bash result updates `commands(project, family)`. A success stores the exact command as the family's current working form and increments `ok`; a failure increments `fail`. Exploration is never recorded: `ls`, `cat`, `grep`, `git status/diff/log/…`, file operations, one-off `node -e` and `python -c`, heredocs, and anything over 160 characters. The briefing lists up to six families that have worked at least twice, most-used first, and links the latest fix memory for that family when one exists. The result is a short "how to run this repo" that is correct because it comes from what passed, not from what a README claims.

## Staleness

A memory is pinned to files through `anchors(path, hash, mtime, size)`. On `SessionStart` and before `recall` or `get`, deja re-checks up to 400 anchors of the current repo:

- `stat` the file. If `mtime` and `size` are unchanged, it is unchanged, with no read needed.
- Otherwise hash it (SHA-1, files up to 5 MB). If the hash is equal (touched but identical), refresh the stored `mtime` and `size` so the next check is cheap again.
- If the hash differs or the file is gone, the memory is marked `stale`.

Stale memories are shown in their own "possibly outdated" section, are ranked lower, and carry a "verify before relying on it" note in `get`. Saving the same title again with `remember` re-anchors the memory and clears the flag.

## Ranking

```
score = bm25(title×4, body×1, tags×2)
      × kind weight     (fix 1.4, gotcha 1.4, decision 1.3, todo 1.1, note 1.0, summary 0.7)
      × (0.6 + 0.4 / (1 + age_days / 30))
      × (1 + 0.15 · ln(1 + hits))
      × (stale ? 0.4 : 1)
```

Queries are built from the prompt's words, minus stopwords, quoted, prefix-matched for words longer than 3 characters, and joined with `OR`. That form is safe against FTS syntax injection and tolerant of inflection, together with the Porter stemmer.

## Context injection

| Moment | Budget and filtering |
| --- | --- |
| Session start | Up to `DEJA_CONTEXT_TOKENS` (default 1,500, at 4 characters per token). Sections in priority order: last session, commands that work, decisions and gotchas, todos, fixes, notes, possibly outdated, lineage summary |
| Prompt | At most 3 memories, only when at least 2 meaningful prompt words, and 20% of them, appear in the memory |
| File opened or edited | Up to 4 memories anchored to that file |
| Failure | Up to 2 fixes |

Every injected id is recorded on the session, so nothing repeats. `/compact` and `/clear` reset that record, because the earlier context is gone. The briefing says plainly that these are recorded notes to verify, not instructions. Every item is single-lined and length-capped, which limits what a hostile string captured from tool output could do in a later session.

## Session summaries

Summaries are deterministic, with no LLM involved. Each one records the first real request (slash commands and pasted blobs are skipped), the files changed, the fixes learned, and the first 600 characters of Claude's last message. deja keeps the newest `DEJA_KEEP_SUMMARIES` (default 200) per repo. `deja prune` drops older summaries, failures and sessions, and never touches saved knowledge.

## Lineage

`src/lineage.mjs` is a set of anchored regexes, not a SQL parser. That is deliberate: it must handle Jinja, Spark dialects, notebooks and half-written files in milliseconds without ever throwing.

- **SQL:** comments are stripped, dbt `ref()` and `source()` are resolved before Jinja is removed, and CTE names are collected so they are not mistaken for tables. Write targets come from `INSERT`, `MERGE`, `CREATE … TABLE/VIEW`, `COPY INTO`, `UPDATE` and `DELETE`. Inputs come from `FROM`, `JOIN` and `USING`. DDL column lists are parsed with a parenthesis-depth scanner, so `DECIMAL(12,2)` and `ARRAY<STRING>` survive.
- **Python:** Spark reader and writer calls are classified by whichever of `.read` or `.write` appears last in the chain. `spark.sql()` and `sql=` strings are fed back through the SQL parser. DLT decorators name their targets.
- **Airflow:** DAG id, task ids from `task_id=` and `@task`, and dependencies from `>>` / `<<` chains, including lists.

Edges are file-level: every input of a file feeds every output of that file. Re-reading or editing a file atomically replaces its edges. Traversal is breadth-first with cycle protection, and the output is printed as a tree.

## Failure handling

| Failure | Behaviour |
| --- | --- |
| Node missing or older than 22.13 | `hook` exits 0 silently; the CLI and MCP server say what is needed |
| Malformed stdin, an unexpected tool shape, a SQL error | Caught, logged to `deja.log`, exit 0, no output |
| Database locked | Waits up to 3 s (`busy_timeout`), otherwise logged and skipped |
| Huge files | Not hashed above 5 MB, not parsed for lineage above 1 MB |
| A repo you don't want recorded | `.deja-off` in its root, or `DEJA_DISABLE=1` |

## Testing

`npm test` runs `node:test` suites covering signatures across stacks, command families and targets, redaction, every lineage parser, multi-hop traversal, the full hook flow (learn, recall, cross-repo, flaky retries, compact reset, worktrees), staleness, migrations, and the MCP protocol. CI runs the suites on Linux, macOS and Windows with Node 22 and 24, plus `doctor` and the benchmark.
