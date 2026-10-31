# Engineering standards

These are the rules every change to deja follows, whoever writes it. **Must** means a pull request is not merged without it; **should** means it needs a stated reason to skip. Rules with an ID are checked automatically by `npm run check` and CI.

## 1. Architecture

| ID | Rule |
| --- | --- |
| A1 | **Must** add no runtime dependency. deja ships as plain ES modules on Node's standard library. Dev tooling is fine. |
| A2 | **Must** make no network calls. Nothing a user stores leaves their machine. |
| A3 | **Must** start no background process, thread, port or daemon. Hooks are short-lived processes; the MCP server lives only as long as the agent session. |
| A4 | **Must** make no model calls. deja captures facts deterministically; the agent already running writes the "why" through `remember`. |
| A5 | **Should** keep one code path for every agent. Differences between Claude Code and Codex are handled by normalizing input (see `exitOf`, `patchFiles`), not by forking logic. |

## 2. Reliability

| ID | Rule |
| --- | --- |
| R1 | Hooks **must** exit 0 on every error. A failure is logged to `~/.deja/deja.log`; it never blocks or breaks a session. |
| R2 | Hooks **must** degrade silently: an old Node version, a locked database or a malformed payload produces no output, not an error. |
| R3 | Code under `src/` **must not** write to stdout. Hooks print only their JSON result, and only `src/mcp.mjs` speaks the protocol. |
| R4 | Hook timeouts in `hooks/*.json` **must** be 10 seconds or less. |
| R5 | Schema changes **must** ship as a numbered migration in `src/db.mjs` and a test that upgrades an older database (`test/migrate.test.mjs`). |

## 3. Performance and token budgets

| ID | Rule |
| --- | --- |
| P1 | Each hook **should** finish in under 150 ms at the 50th percentile against 5,000 memories (`npm run bench`). A change that makes a hook slower says so in its pull request, with numbers. |
| P2 | Files over 1 MB **must not** be parsed inside a hook. |
| T1 | The MCP tool list plus server instructions **must** stay within 900 tokens. Every session pays for them. |
| T2 | Injected context **must** respect `DEJA_CONTEXT_TOKENS`, show each memory at most once per session, and stay one line per note. `npm run tokens` reports the numbers; update the README table when they move. |

## 4. Privacy and security

| ID | Rule |
| --- | --- |
| S1 | Everything written to disk **must** pass through `redact()` first. A new secret format gets a pattern in `src/redact.mjs` and a test. |
| S2 | `<private>` blocks, `.deja-off` and `DEJA_DISABLE=1` **must** always be honoured. |
| S3 | Tests **must not** contain real-looking secrets. Build fakes at runtime (GitHub push protection rejects them otherwise). |
| S4 | Anything rendered as HTML **must** be escaped (see `inline()` and `esc()` in `src/ui.mjs`). |

## 5. Compatibility

| ID | Rule |
| --- | --- |
| C1 | **Must** pass on Linux, macOS and Windows with Node 22.13+ and the current Node release (the CI matrix). Paths are stored with forward slashes. |
| C2 | Every hook wired in `hooks/hooks.json` (Claude Code) or `hooks/codex-hooks.json` (Codex) **must** point at a handler in `src/hooks.mjs`. |
| C3 | User data **must** keep working across upgrades: no breaking change to the database, the export format or the MCP tool names without a migration and a major version. |

## 6. Code style

- Plain JavaScript ES modules (`.mjs`), type-checked with `checkJs` (`npm run typecheck`). Two-space indentation, single quotes, semicolons, LF line endings (see `.editorconfig`).
- Small functions with names that say what they return or do. No abbreviations a newcomer would have to guess.
- Prefer the standard library and plain data over classes and abstractions. Add an abstraction only when a second caller needs it.
- Handle errors where they can be acted on. Never swallow an error outside the hook boundary without logging it.
- No dead code, commented-out code or TODOs without an issue link.

## 7. Comments

Comments explain **why**, not what. The code already says what it does.

- Every file starts with one or two lines saying what the module is responsible for.
- Exported functions get a one-line `/** … */` summary when the name alone does not say what they return or when to use them.
- Inside functions, comment only the non-obvious: a constraint, a trade-off, an edge case or a link to the behaviour of an external tool. Example: `// Exit code 1 from these is an answer ("no match"), not a bug.`
- Write plain, specific sentences. No filler ("This function is responsible for…"), no marketing words, no emoji, and no comments that restate the line below.
- Keep comments true. A change that makes a comment wrong updates or deletes it in the same commit.
- Name agents only when the behaviour is agent-specific ("Codex reports…"); otherwise say "the agent".

## 8. Tests

- Every behaviour change or bug fix comes with a test that fails without it. Tests use `node:test` and run with `npm test`; no network, no global state outside the temporary `DEJA_HOME` that `test/helpers.mjs` creates.
- Test the behaviour a user sees (a hook's output, a recall result), not private helpers, unless the helper parses an external format (errors, lineage, agent payloads).
- New error formats go in `test/errors.test.mjs`, lineage patterns in `test/lineage.test.mjs`, agent payloads in `test/hooks.test.mjs`.

## 9. Commits

deja follows [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).

```text
<type>(<optional scope>): <summary>

<body: what changed and why, wrapped at 72 characters>

<footer: BREAKING CHANGE: …, Fixes #123, Co-authored-by: …>
```

| Type | Use for | Version bump |
| --- | --- | --- |
| `feat` | A new capability for users | minor |
| `fix` | A bug fix | patch |
| `perf` | Faster or lighter, same behaviour | patch |
| `docs` | Documentation only | none |
| `test` | Tests only | none |
| `refactor` | Code change with no behaviour change | none |
| `build`, `ci`, `chore` | Tooling, CI and dependencies | none |

Scopes match the module: `hooks`, `store`, `errors`, `lineage`, `mcp`, `ui`, `codex`, `cli`, `deps`. A breaking change adds `!` after the type and a `BREAKING CHANGE:` footer.

Examples:

```text
feat(codex): recall fixes from apply_patch edits
fix(errors): ignore Vitest duration lines in signatures
docs: measure token cost per session
```

**Header (the first line)**
- **50 characters or fewer** is the target, the long-standing Git convention, so it reads fully in `git log --oneline`, GitHub and email. **72 is the hard limit**, which CI enforces.
- Imperative mood, as if completing "This commit will …": `add`, `fix`, `remove`, not `added` or `fixes`.
- Lower case after the colon, no period at the end.

**Body**
- Separated from the header by one blank line, wrapped at **72 characters**.
- Says **what** changed and **why**. The diff already shows how.

**Commits**
- One logical change per commit; each builds and passes the tests on its own.

## 10. Pull requests and releases

- Pull request titles follow the commit format above (CI checks this), because the repository squash-merges and the title becomes the commit on `main`.
- Fill in the pull request template: what and why, how it was verified, and the principles checklist.
- CI must be green: tests on every OS and Node version, `npm run typecheck` and `npm run check`.
- Releases follow [Semantic Versioning](https://semver.org). A release bumps the version in `package.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json` and `src/version.mjs` together (D1), and adds a `CHANGELOG.md` entry for that version. Without a version bump, `/plugin update` does not pick up the change.

## 11. AI-assisted contributions

deja is built with AI coding agents, and contributions written with them are welcome on the same terms as any other:

- **A human is responsible.** The person opening the pull request has read every line, understands it and can explain it in review.
- **Disclose it.** Keep the agent's `Co-authored-by` trailer in commits, or say in the pull request which parts an agent wrote.
- **Same bar.** AI-written code meets every rule here: tests, comments that explain why, no invented APIs, no unverified claims in docs.
- **Verify, don't trust.** Run the code, the tests and the benchmark yourself. Numbers in docs come from a command anyone can re-run.
- **No secrets in prompts or transcripts** pasted into issues or pull requests.
