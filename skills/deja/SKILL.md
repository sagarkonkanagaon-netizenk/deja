---
name: deja
description: Use deja project memory well. Use when you make a non-obvious decision, hit a gotcha, find the real cause of a bug, finish a chunk of work, or start work in an area you have not seen this session; and for questions about what feeds or depends on a table, view, path or Airflow DAG.
---

# Working with deja memory

deja records sessions automatically: failed commands and the steps that fixed them, files changed, and a summary of each session. What it cannot see is *why*. That part is yours.

## Save with `remember` when

- You choose between options for a reason that is not in the code ("API errors use RFC 7807 problem+json: the mobile app parses `type`, not `message`"). Kind `decision`.
- Something surprised you or cost time ("Integration tests need `docker compose up -d postgres`; the .env URL points at RDS"). Kind `gotcha`.
- An automatic fix memory says what changed but not why. Save the root cause as kind `fix` with the same files.
- Work is left unfinished. Kind `todo`.

Write the title so it makes sense with no context. Keep the body to a few lines. Always pass `files` so the memory is flagged stale when those files change.

Do not save things the code or git history already says, secrets, or anything temporary.

## Look things up with `recall` and `get`

Before changing an unfamiliar module, or when an error looks familiar, call `recall` with a few keywords, then `get` the ids that look relevant. A memory marked stale was written against an older version of its files: check the code before trusting it, then update it with `remember` (same title) or remove it with `forget`.

## Lineage

For "what feeds X", "what breaks if I change X", or "which DAG writes X", call `lineage`. If it knows nothing yet, run `scan_lineage` once. It understands SQL, dbt models, PySpark, Delta Live Tables, notebooks and Airflow DAGs, at file level.
