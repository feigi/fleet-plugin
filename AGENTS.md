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

## Incident policy

A member-reliability incident closes with a mechanism, not a paragraph in the runbook.
What counts as one, and the order of preference, is in `docs/agents/incident-policy.md`.

## Live runs

A run is live once `ledger.mjs rotate` has written its `controller` record to
`.fleet/heartbeat.json`, and stays live, however old the beat, until a beat no
older than that record's `at` carries a non-empty `stopped`; a stopped beat
older than the record is the previous run's. While it is, the main checkout is
the run's: a session that is not its controller or one of its members neither
moves `HEAD` or the index there nor edits a tracked file or adds an untracked
one — no `merge`, `pull`, `rebase`, `reset`, `switch`, `checkout`, `restore`,
`commit` or `stash`. Read current `origin/main` with `git fetch` then
`git show origin/main:<path>`, or `git worktree add --detach <dir> origin/main`;
do branch work in a worktree.
The rule stands without a refused gate to point at: a fast-forward does not
change the installed package the instruments pin certifies, but a branch switch
or an edit there trips the tick's main-checkout guard, and any move of `HEAD`
rewrites tracked files the run edits.
A beat that looks dead stays live until the maintainer says otherwise.

## Runs on this repo

After a `/fleet-ctl:run-team` run on this repository, run the `run-team-local`
skill (`read skill://run-team-local`): the plugin never calls it, so this rule
is what triggers it. It is repeatable, so a missed run strands nothing.

Run artifacts follow this repo's own convention, which the plugin does not
mandate: the Close-out PR goes on `chore/run-artifacts-<date>` (a letter suffix
when that date already has one, `chore/run-artifacts-2026-08-23b`), and data
rows and rule-doc prose never share a PR — one branch each. The halves have
opposite cost profiles: a stranded data row is lost (the member-outcomes
scrape is regenerated from harness transcripts we do not own), while a
stranded rule change only costs the status quo, but is expensive to review.
Bundled, the cheap half gates the expensive one. So the metrics branch carries
the `docs/metrics/` files and nothing else, and prose that wants review goes
on its own branch with its own PR.

A ticket the fleet works delivers on its claim branch, metrics tickets
included: its brief states the content rule (`docs/metrics/` files and nothing
else) and names no branch. `chore/run-artifacts-<date>` is the Close-out PR's
name.

## ADR amendments

An accepted ADR's body stays as ruled. A later change that falsifies or closes
something it states is recorded on its `**Status:**` line as `Amended by #N: …`
(the issue) or `Amended by ADR NNNN: …`.

## Spec amendments

A merged spec under `docs/specs/` records a later change to what it states
next to the changed text, never in its header. The note starts on its own line
directly under the last line of the paragraph or list item it amends, with no
blank line between, so it renders inside it (in a list, indented to the item's
text); it is never appended to an existing line. It reads `*Amended (#N): …*`,
`#N` being the issue that ruled the change; when another ticket carried it
out, `*Amended (#N, implemented by #M): …*`. A change that adds a whole
section opens it with `**Amended (#N): <claim>.**`, a paragraph of its own
after a blank line.

The header — the metadata lines under the title, `Status:` and `Relates to:`
among them — holds no amendment, no pointer to one and no summary of them. A
new lifecycle state (`implemented`, `ticketed as #…`, `superseded by …`) and
the fix of a reference that no longer resolves are still edited in place.
Amendments already in a header stay as written.
