# Contributing to deja

Thanks for helping. Every change follows the [engineering standards](docs/STANDARDS.md): architecture rules, performance and token budgets, privacy, code and comment style, tests, commit messages and how to contribute with AI agents. The core principles:

1. **No runtime dependencies.** Everything ships as plain ES modules on Node's standard library (`node:sqlite`, `node:test`). Dev tooling is fine if CI does not need it.
2. **Hooks must never hurt a session.** They exit 0 on every error, stay well under 150 ms, print nothing but the hook's JSON, and make no network calls.
3. **No extra LLM calls.** deja captures deterministically; the model already running in the session writes the "why" through `remember`.

## Getting started

```bash
git clone https://github.com/sagarkonkanagaon-netizenk/deja && cd deja
npm test            # node:test, no install step
npm run check       # the automated standards checks
npm run bench       # hook latency against 5,000 memories
npm run tokens      # tokens deja adds to an agent's context
claude --plugin-dir .   # try your changes in a real session
```

## Where things live

| Path | What |
| --- | --- |
| `bin/deja.mjs` | Single entry point: hooks, MCP server, CLI |
| `src/hooks.mjs` | One handler per Claude Code hook event |
| `src/store.mjs` | Memories, ranking, staleness |
| `src/errors.mjs` | Error signatures and command families |
| `src/lineage.mjs`, `src/graph.mjs` | Lineage extraction and the graph |
| `src/mcp.mjs` | MCP server (JSON-RPC over stdio, no SDK) |
| `hooks/hooks.json`, `.mcp.json`, `.claude-plugin/` | Plugin wiring |

## Good first contributions

- A lineage pattern deja misses: add a failing case to `test/lineage.test.mjs`, then make it pass.
- An error that should match a past one but does not: add both texts to `test/errors.test.mjs`.
- A secret format that slips through redaction.

Please include a test with every behaviour change.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/), with a header of 50 characters or fewer (72 at most):

```text
fix(errors): ignore Vitest duration lines
```

Check one with `node scripts/check-commit.mjs "<header>"`. Pull request titles use the same format, because they become the squash-merged commit on `main`.
