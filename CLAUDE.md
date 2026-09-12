## Agent skills

### Triage labels

Label string equals role name for all five roles: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Verifying a claim

When a skill tells you to verify a claim and verifying means editing source — flipping a condition to check that a test reds — that edit goes in a scratch copy, never in this shared working tree, because a concurrent session may be reading it. Copy the file elsewhere, or work in a throwaway `git worktree`. Restoring it quickly is not enough: the exposure is an instant, and a single tool call is a wide enough window. Read-only verification — running the suite unmodified, grepping, reading a diff — touches nothing and needs no copy.

### Domain docs

Single-context layout — one `CONTEXT.md` + `docs/adr/` at the repo root. Both exist here. See `docs/agents/domain.md`.
