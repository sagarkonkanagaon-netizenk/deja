# Security policy

## Supported versions

Security fixes go into the latest release. Update with `/plugin update deja`.

## Reporting a vulnerability

Please report privately through [GitHub security advisories](https://github.com/sagarkonkanagaon-netizenk/deja/security/advisories/new), not in a public issue. You will get an answer within a few days. Once a fix is released you will be credited, unless you prefer not to be.

## Threat model

deja runs locally with your user's permissions and makes no network calls. The areas worth scrutiny:

- **Secrets at rest.** Prompts, commands and error output are redacted before they are written to `~/.deja/deja.db`. A secret format that slips through redaction is a security bug.
- **Context injection.** Memories come from tool output and are shown to Claude in later sessions. They are labelled as notes to verify, not instructions, and are length-capped. A way to make a stored memory act as an instruction is a security bug.
- **Path handling.** Anchored file paths are resolved inside the repository. Reading or hashing a file outside it, other than the explicit absolute paths a user saves, is a security bug.
