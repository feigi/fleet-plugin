## Agent skills

### Triage labels

Label string equals role name for all five roles: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout — one `CONTEXT.md` + `docs/adr/` at the repo root. Both exist here. See `docs/agents/domain.md`.

## Shipped surface

Shipped files (`plugin/`) cite no issue, PR, ADR, repo-internal `docs/`
record path (`adr`/`specs`/`research`/`agents`/`requirements`) or test
file — state the claim instead; provenance lives in git history. See ADR
0019 and `CONTEXT.md`'s **Shipped surface**.
