## What and why

<!-- What this changes and the problem it solves. Link the issue if there is one. -->

## How it was verified

- [ ] `npm test` passes
- [ ] `npm run typecheck` passes
- [ ] Tried in a real session with `claude --plugin-dir .` (for behaviour changes)
- [ ] `npm run bench` shows no hook slower than before (for hook changes)

## Principles

- [ ] No new runtime dependency, background process or LLM call
- [ ] Hooks still exit 0 on every error and print only their JSON
- [ ] README, `docs/ARCHITECTURE.md` and `CHANGELOG.md` updated if behaviour changed
