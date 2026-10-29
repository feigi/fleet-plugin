# 0035 — Label strings come from the consumer repository into fleet state; the shipped surface names roles only

**Status:** Accepted. Ruled by the maintainer in the grilling recorded on #3296 (spec `docs/specs/2026-10-15-label-map.md`, D1 and D12), with the record rule below added 2026-10-27 in a grilling of #3863. Closes the "Label-remap coupling" item of `docs/specs/2026-07-30-fleet-trust-the-label-design.md` § Out of scope, and supersedes `.out-of-scope/consumer-label-spelling-alias.md`, which is deleted with this ADR.

## Context

The fleet read a fixed set of label strings, and `docs/requirements.md` § 2.4 told a consumer repository to create exactly those. `/setup-matt-pocock-skills` Section B lets a repository rename its triage labels and records the result in `docs/agents/triage-labels.md`, so a repository that did so could not run the fleet: the Shortlist query matched nothing and read as "no work".

`.out-of-scope/consumer-label-spelling-alias.md` ruled an alias for one spelling out, as a setup fault of one non-conformant repository. The spec records its reopen condition — a second consumer that cannot rename its label — as met. The note's "Prior requests" line:

- #2883 — "fleet-ctl: shortlist ignores on-hold — tick PULLs maintainer-frozen tickets (ready-for-agent + on-hold coexist)"

The fleet also writes one record to the tracker and parses it back: the head record `ready-to-merge-head: <sha>` (ADR 0024), a PR comment the finisher posts immediately before it adds `ready-to-merge`. The merge bot reads it to prove that a rebase carried the audited change. Its text contains a role name. A prefix that followed the Label map would orphan every standing record at a re-map: the merge bot would fall back to the PR timeline, which cannot prove a rebase-carry and lets a hand relabel after a push merge a head nobody audited.

## Decision

1. **The eight labels are roles.** `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`, `in-progress`, `onhold` and `ready-to-merge` are Label roles: names the fleet's scripts and runbooks use for a label's meaning. A role's name is also its default string. `wayfinder:*` and `patch`/`minor`/`major` stay literal strings and are not roles.
2. **The strings come from the consumer repository into fleet state.** The Label map is derived from the repository's triage-label table and its live label list, confirmed by the maintainer where derivation is uncertain, and kept as fleet state beside the Recipe cache. Absent means "derive", never "infer".
3. **The shipped surface names roles only.** A script or runbook resolves a role through the map and never types a label string.
4. **The plugin writes no consumer file.** It reads `docs/agents/triage-labels.md` and never writes it; the maintainer's answer lives in fleet state.
5. **A record the fleet writes to the tracker and parses back is not a label.** It keeps its fixed grammar even where it contains a role name, so re-mapping a label never orphans a record already posted. Today the only such record is the head record `ready-to-merge-head: <sha>`. ADR 0024, which names the record, is unchanged.
6. **The alias note is superseded and the "Label-remap coupling" item is closed.** The note is deleted, its "Prior requests" line moved to Context above; the 2026-07-30 spec's item is annotated `Closed by ADR 0035`, and that spec is otherwise as written.
