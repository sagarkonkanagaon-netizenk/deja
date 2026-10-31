## What and why

<!-- What this changes and the problem it solves. Link the issue if there is one. -->

## How it was verified

- [ ] `npm test` passes
- [ ] `npm run typecheck` and `npm run check` pass
- [ ] Title follows [Conventional Commits](../docs/STANDARDS.md#9-commits) (`type(scope): summary`, 50 characters or fewer)
- [ ] Tried in a real session with `claude --plugin-dir .` (for behaviour changes)
- [ ] `npm run bench` shows no hook slower than before (for hook changes)

## Principles

- [ ] Follows [docs/STANDARDS.md](../docs/STANDARDS.md): no new runtime dependency, background process, network or model call
- [ ] Comments explain why, not what; none are left stale
- [ ] If an AI agent wrote part of this, I have read and verified every line
- [ ] Hooks still exit 0 on every error and print only their JSON
- [ ] README, `docs/ARCHITECTURE.md` and `CHANGELOG.md` updated if behaviour changed
