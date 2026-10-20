# The tick's rows: what each asks of the controller

The full text of each row `fleet-tick.mjs` prints and what it asks of the controller. SKILL.md's **The tick's rows** carries one line for each.

- `PULL #<N> …` — one Pull per named ticket, in the order printed: phase 1's
  read, then the dispatch. A ticket that fails the read is relabelled or
  excluded (phase 1), and the next tick names the next head.
- `REFRESHED shortlist: <n> entries; <k> lifted` — the tick refreshed the
  shortlist itself, and its `PULL` row already reads the result. `REFRESH
  FAILED` is yours: `shortlist.mjs` could not run, and the implementer row is
  blind until it can. When the refresh ran because fewer than B heads were
  unclaimed (`unclaimed <u> < in-flight bound <B>`), a head whose Pull ended
  this run not counted (unless it ended on an exclusion whose premise has
  lifted), the implementer row's `unclaimed=` prints that same
  `<u>`, not the refreshed file's count.
- `SUGGEST /triage, hold idle` — nothing is admissible after the refresh.
  Suggest, never run. A head whose Pull already ended in
  this run is not counted toward the refresh, so a shortlist of only such
  heads triggers the refresh before this row prints. It is not printed while the
  refreshed shortlist holds a head whose Pull ended only on an exclusion whose
  premise has lifted and a slot is free: that head gets its `PULL` row.
- `specs-dropped=#<N> … (to-spec: User Stories heading)` at the end of the
  implementer row's counts, whatever its ACTION — the tickets the to-spec
  filter kept out of `supply`, read off the shortlist's `dropped`. Never
  actionable. Log them as specs awaiting to-tickets (phase 0), not as no work.
- `DISPATCH fix-pr PR#<M> …` — a fix-applier per PR, for a review's survived or unverified findings,
  a dispositions mismatch no retry has answered, or a `conflict-hold:#<M>` — the merge bot's, or one you recorded off a `CONFLICT` line (**The fix-applier**). Printed
  ahead of reviews on purpose: finishing what is started beats starting more.
- `DISPATCH review PR#<M> …` — a review per PR, oldest first, off your turn
  (**The reviewer**).
- `DISPATCH merge-bot` — the next `merge-bot-<n>` (**The merge bot**). The `<scratch>` its brief takes is the absolute `scratch-root.mjs` output, and the bot writes only under `<scratch>/pr<N>/merge-bot-<n>/`.
- `DISPATCH finisher PR#<M> …` — a finisher settled `labelled`, yet the open
  list shows PR M without `ready-to-merge`, and no `label-off=` (references/ledger.md)
  accounts for the removal. Apply the finisher gate (**The finisher gate**: the
  `check` job green on the current head), then dispatch the next-suffix
  finisher at that head, one letter past the highest the PR has used: render
  its brief with `dispatch-prompt.mjs render finisher --kind repair --member
  finisher-pr-<M>-<x> …`, then `ledger.mjs dispatch <M> finisher-pr-<M>-<x>`.
  Never add the label yourself. A head
  that moved is caught by the new finisher's duty 1 `past-pin` halt and the
  re-review path that follows it. Finishers are not review units, so this
  prints whatever the unit count reads.
- `ESCALATE unlabelled PR#<M> …` — a second finisher since the last `label-off=`
  settled `labelled` and the label is still not on: the tick dispatches no
  third. Not actionable; the maintainer's, through the cockpit's `unlabelled`
  flag and the comment the repair finisher's report left (`fleet-event.mjs`'s
  `finisher-report` entry).
- `CONFLICT PR#<M> …` — GitHub reads PR M `mergeable=CONFLICTING`, the ledger
  tracks it, no conflict hold stands on it, no fix-applier, finisher or
  implementer on it is live, and, if it carries `ready-to-merge`, no merge bot
  is live: a queued PR is the bot's while one runs, and its own fallback records
  the hold. Record it with `fleet-event.mjs conflict <M>`, not with the `ledger.mjs
  row` form the row's detail prints: `row` replaces the whole line. The call
  refuses a PR whose row already carries a hold no fix-applier has answered.
  The tick then reads the hold as `DISPATCH fix-pr
  PR#<M>`, a conflict fix-applier (**The conflict hold**), and that row obeys
  every hold. A review in flight does not stop the
  line: `fix-due` waits for the review to return. It prints under a
  main-checkout hold and a drain too, since it writes a record and dispatches
  nothing.
- `ESCALATE conflict PR#<M> …` — PR M reads CONFLICTING again after two
  conflict fix-appliers landed on it: a rebase treadmill. Comment on the PR
  and flag it for a human; write no hold and dispatch no fix-applier. Not
  actionable; it repeats while the PR reads CONFLICTING and clears once it
  stops, closes or merges.
- `ESCALATE pr-closed #<N> PR#<M>` — PR M, ticket N's latest PR (the latest
  `impl-<N>…=PR#<M>` on the row), is CLOSED unmerged while issue #N is not
  read CLOSED (an issue gh cannot read counts as open), and no
  `impl-<N>-<x>` after it is live or settled `released`. An unmerged
  close is unknown intent, so the line is the maintainer's and not
  actionable: tell the maintainer once per ticket per run, dispatch nothing
  for #N, and post no GitHub comment. It prints beside the implementer row,
  never in it, takes no implementer slot and counts toward no bound. While a
  member on PR M is live — `fix-pr-<M>…`, `finisher-pr-<M>…`, or a live
  `merge-bot-<n>` while M's latest finisher settled `labelled` with no
  `label-off=` after it — the line ends ` — <member> live`. Reopening PR M,
  or closing #N, clears it by itself on the next tick. Act only on the
  maintainer's `replace #N` or `release #N`, and only once the line names no
  live member:
  - `replace #N` — the `NEED resume` procedure (phase 0): `impl-<N>-b`, or
    one letter past the highest `impl-<N>-<x>` the ticket has used, in the
    existing worktree and branch, never `claim-ticket.sh`. Its new PR settles
    onto the same row, and that two-PR row is a legitimate shape: the tick
    keys the row on the newer PR from then on.
  - `release #N` — `release-ticket.sh <N> impl-<N> implementer --apply`,
    which runs its closed-PR mode on a branch whose PRs all read CLOSED, then
    settle `released`: `ledger.mjs row <N> "<text> · impl-<N>-<x>"`, the next
    letter, and `ledger.mjs settle impl-<N>-<x> released`, which ends the
    line.

  A replacement that settles `bailed`, `blocked` or `killed` brings the line
  back on M, and one whose own PR M′ closes unmerged prints it on M′. One the
  implementer row holds on a tier mismatch (`HOLD (tier mismatch …)`) keeps
  the line off while that row asks for the next replacement — the `replace`
  carried on at the right tier — and once that one settles, the line reads it
  the same way. A tier mismatch on the member that settled `PR#<M>` itself
  replaces nothing, so the line stands beside that hold.
- `ESCALATE pr-unchecked #<N> PR#<M>` — the same ticket, but `gh pr view
  <M>` could not answer, so whether M closed is unknown. The maintainer's on
  the same terms as `pr-closed`; the next tick probes again.
- `HOLD (…)` — the row is held and says why: draining, a tier mismatch, an
  unchecked tier, the In-flight bound reached (`HOLD (in-flight <n>/<B>)` —
  nothing to do unless its detail names a replacement to dispatch, else a
  merge brings n below B), or every
  queued merge candidate held behind a lower PR or on a conflict hold no
  fix-applier has cleared. An unchecked tier is `tick --apply`'s to check, and
  the hold stays while the check writes no verdict (its `tier-ok=`, or
  `tier-unverifiable=` for a member settled `killed` or `released` with no
  transcript, clears it); a mismatch is yours to clear, by dispatching the
  replacement at the right tier. Each prints its clearing step in
  the row's detail. For a mismatch that is the replacement's name —
  `impl-<N>-b` on a first retry, else one letter past the highest the ticket
  has used, or that no retry letter is left. For an unchecked tier, which
  `tick --apply` has already tried, it is the `tier-check.mjs` command to run
  by hand when the tick ran without `--apply` or the check wrote no verdict,
  with a batch entry per member it names (fill in `<file>`; `<session>` too
  when no receipt of this run records one).
  **The batch file is a JSON array, one entry per dispatched member** — under
  Pull, a batch of one, the member just dispatched: `{member}`.
  `member` is the AgentId the dispatch returns (`impl-<N>`). An entry that
  names neither `session` nor `transcript` takes the session directory phase
  0's receipt `.fleet/phase0.json` of `--ledger`'s workspace (else the cwd's,
  resolved as the default ledger is) records, and is exit 2 naming the receipt
  when it records none; the check reads `<session>/<member>.jsonl`, so a
  member with no assistant turn yet still resolves off its dispatch-time
  record. A `session` the entry gives
  wins over the receipt's; a caller already holding the exact transcript path
  may give `transcript` instead. The agent type an implementer was dispatched
  as lives only in its transcript. `resolvedModel`
  **and** `resolvedThinkingLevel` together — the dispatch's own job record —
  may ride beside it and are preferred for the model and level. An `impl-`
  entry carries no `agentFile`: its definition is the row's, never the
  caller's. `transcript`/`session` resolve relative to `--repo` (defaults to
  the plugin's own root), and the check reads and writes the run's own ledger
  unless `--ledger` names another.
- `AT CAP`, `IDLE OK` — nothing to do on that row.
- `MAIN-CHECKOUT-DIRTY <paths> …`, printed above the rows, with every
  dispatching row (implementers, reviewers, merge-bot) reading
  `HOLD (main checkout dirty)` — the main checkout changed since the Phase 0
  baseline. The line names the changed paths, or a `HEAD <was> → <now>` entry
  when HEAD moved, and every live member; it
  attributes nothing, because concurrent members make that a guess. Dispatch
  nothing new and tell the maintainer: they resolve the stray paths FIRST,
  then re-baseline with `~/.fleet/bin/fleet-run main-checkout.mjs --record`.
  A path entry holds until that re-baseline, tick after tick; a `HEAD …` entry
  clears itself once HEAD reads clean again, and is never re-baselined while
  HEAD is off the run's branch. Never revert the
  paths yourself, and never re-baseline over paths nobody has resolved. The
  changes of yours that trip it are a mid-run tooling fix edited in this
  checkout and the close-out commit's round trip through a branch; SKILL.md's
  **A mid-run tooling fix** and the commit section of references/close-out.md say how
  each is cleared.
  The maintainer may instead ignore a stray path that is untracked and new since the baseline: an entry in `.git/info/exclude` or in the global excludes file hides it from the check, and the hold clears on the next tick with no re-baseline. Ignoring never clears a tracked or staged file's change, which `git status` reports whatever the excludes say, nor a pattern that also matches a path the baseline holds, which then reads as changed. Ignoring is the maintainer's decision; the controller never writes an exclude or a `.gitignore` entry. Keep the pattern narrow, because an ignored path is invisible to this check, so a member write that matches it is never seen.
- `MAIN-CHECKOUT-UNKNOWN …` with `HOLD (main checkout unknown)` — the tick
  could not look: a git or hash read failed (`could not look:`), or the
  baseline exists but cannot be read (`baseline unreadable:`). Never clean,
  and **never re-baseline over it** — `--record` overwrites, so that certifies
  a tree nobody read. Fix what the line names and tick again. `baseline v<n>
  written by a newer plugin` is a baseline a newer plugin version wrote:
  `--record` refuses over it too — run the plugin that wrote it. The
  exceptions are the two whose remedy is `--record`: `baseline v<n> —
  re-record`, an older-format baseline this plugin cannot compare; and
  `baseline commit <oid> is missing from this repository`, which an amend or
  reset followed by gc leaves — examine HEAD against `origin/main` FIRST,
  since HEAD moved off that commit and nobody has looked at the move, and
  resolve any stray paths, which the line does not name; only then re-record.
- `MAIN-CHECKOUT-NO-BASELINE …` with `HOLD (main checkout no baseline)` — no
  baseline was recorded. Yours to fix: run
  `~/.fleet/bin/fleet-run main-checkout.mjs --record`, which references/phase-0.md
  describes under "Record the main-checkout baseline". A baseline
  that vanished mid-run is not a fresh run — report it to the maintainer
  before recording over whatever the tree now holds.
- `PHASE0-INCOMPLETE <step>[, <step>…] …`, printed first above the rows,
  with every dispatching row (implementers, reviewers, merge-bot) reading
  `HOLD (phase 0 incomplete)` — this run's phase-0 receipt
  `.fleet/phase0.json` names a step `failed` or `pending`, or lacks one. In
  place of the steps the line says the receipt is missing, unreadable,
  another run's (its `run` is not the `at` in the controller record), or a
  run whose controller has exited — the previous run's finished receipt, in
  a session that has not yet run its own phase 0. It outranks every
  other reason on those rows, `MAIN-CHECKOUT-*` included, whose lines still
  print; a `baseline` step not `ok` is one of the steps it names.
  `CONFLICT` rows and the stall report still print. Run the
  `phase0.mjs` command the line names and act on what it prints: a re-run
  resumes at the step that stopped. A `drift` or `unanswered` step and a
  `fold-in` `NEED` are advice, named after `; advice:` on the line, or alone
  on a `PHASE0-ADVICE …` line when nothing is incomplete; advice holds
  nothing.
- `CHECK-LIVENESS <member> (<family> > p99 <t>m)`, printed above the rows — a
  live ledger token has stayed live past its family's p99 run time, counted
  from the first tick that saw it (`> 2×p99 …` from the second multiple of the
  threshold on; `review:PR#<n>` names an in-flight `review=` launch). Advice,
  not an action: it is not actionable, resets no `quiet`, changes no row and
  frees no slot, and the tick settles and kills nothing. Take the census the
  **Member unaccounted** row of **Failure handling** gives before you touch the
  token. It repeats every tick while the token stays live past the threshold.
  `--liveness-impl`, `--liveness-fix-pr`, `--liveness-finisher`,
  `--liveness-merge-bot` and `--liveness-review` set the thresholds, in minutes.
- `UNRECORDED <stem> (transcript exists, no ledger token)`, printed above the
  rows — the session directory holds a `<stem>.jsonl` whose stem is a member
  name no row token, `## Dispatched` entry or `## Retired` line names: a
  dispatch whose ledger write was forgotten. Record it with `ledger.mjs
  dispatch`, or confirm it is a stranger's member.
  Advice, like `CHECK-LIVENESS`: it resets no `quiet`, changes no row and
  frees no slot, it repeats every tick while it holds, and the folded line
  names it (`…; UNRECORDED <stem> persists — …`).
- `NO-TRANSCRIPT <member> (live <age>m, no <session>/<member>.jsonl)`, printed
  above the rows — a live ledger token first seen more than
  `--no-transcript-after` minutes ago (default 5) has no transcript in the
  session directory: a dispatch whose `task` call was never made. Make the
  `task` call, or run the **Member confirmed dead or never dispatched** wake
  (`fleet-event.mjs member-died <member>`), which settles the token `killed`
  once the first-seen stamp is past five minutes. Advice the same way, folded as
  `…; NO-TRANSCRIPT <member> persists — …`. Both lines read the session
  directory this run's phase-0 receipt names, else `--session <dir>`; with
  neither the tick skips them with one stderr line. A heartbeat state file
  that exists but cannot be used — unreadable, not JSON, not a JSON object,
  or holding a `controller` that cannot be judged — holds no first-seen
  ages, and the tick never rewrites it, so every live token reads as first
  seen that tick and neither `CHECK-LIVENESS` nor `NO-TRANSCRIPT` can fire.
  The tick says so with one stderr line, `fleet-tick: CHECK-LIVENESS and
  NO-TRANSCRIPT not checked — <file> <cause>, so first-seen ages are
  unavailable`, naming only the checks that would have run that tick.
- `SETTLE <member> (report on disk since <n>m — ledger.mjs settle <member>
  --from-report)`, printed above the rows — a live ledger token whose report
  file, `<scratch>/reports/<member>.json`, is on disk and passes its member
  family's report schema. Run that member's report wake from the wake table:
  it runs the settle the line prints and the follow-on work its report
  calls for, which a bare settle does not do. Advice, like
  `CHECK-LIVENESS`: the tick settles nothing. Three lines name a report file
  `settle --from-report` cannot settle from: `REPORT-MISMATCH <path> (member:
  …)`, a file whose `member` is not its filename's; `REPORT-UNREADABLE <path>
  (…)`, one that is there but cannot be read; and `REPORT-INVALID <path> (…)`,
  one that names its own member and fails its family's schema, with the first
  violation. A review runner has no report schema and files none, so none of
  these lines names one.
  **The settle of an implementer's `PR#M` and of a fix-applier's
  `applied:<head>` also checks the Check-step record** beside the report,
  `<scratch>/reports/<member>.check.json`, which the member writes with
  `recipe-check.mjs`: the Recipe's Check step, then the Test entrypoint it was
  handed, run against its staged tree. The settle requires that the record
  exists and parses, that both commands exited 0 in it, and that its tree is
  the reported head's tree — so a message-only amend keeps it valid, and a
  content change or a rebase does not. A head whose tree git cannot read is
  could-not-look (exit 2), never a mismatch. The settle runs neither command,
  and a repository whose Recipe cache is absent or refused has no gate; the
  record is the member's own word, at the trust level of its report.

## Read the depth off the tick, never derive it by hand

**Do not re-derive this by hand — `fleet-tick.mjs` computes it.** The deficit is then *computed, not remembered*, which is
the whole point: a table you must remember to consult is one you will not
consult under a merge-side event storm, and that is how implementers reached
0/target with ~57 `ready-for-agent` in supply while nobody
noticed.

## What the tick reads

It reads the run itself, and nobody states a count. The In-flight count —
every open PR that closes an issue off `gh`, plus every claimed ticket whose
newest implementer is live or owed a replacement and has no such PR yet, off
the ledger — sits beside the live review units (in-flight `review=` tokens
plus unsettled `fix-pr-` ones), the merge bot, merge holds, tier mismatches
and the drain marker, all off `.fleet/ledger.md`; the unclaimed heads and the
supply come off `.fleet/shortlist.json`, which it refreshes itself when the
unclaimed count is below the In-flight bound, when the file is missing or
empty, when an Exclusion's premise has lifted, or when a branch-named
`behind-pr` or a `behind-issue` Exclusion still not lifted names a ticket the
file carries — never while the bound holds; the open PRs come off `gh`. A
head whose Pull ended this run is not counted, unless on a lifted exclusion. A
ledger token it
cannot read, it refuses rather than guessing — a member counted live or gone on
a guess is the over- or under-dispatch it exists to prevent — so correct that
row with `ledger.mjs row` and tick again. The In-flight bound defaults to 5
and is fixed for the run: pass `--in-flight` on every tick when `$ARGUMENTS`
set it, and never otherwise.

## Refresh is the tick's

2. **Refresh is the tick's from here on.** `fleet-tick.mjs` runs
   `shortlist.mjs` itself when unclaimed entries fall below the In-flight
   bound, when the file is missing or empty, when an `excluded` premise has
   lifted, and when a branch-named `behind-pr` exclusion whose PR is not yet
   MERGED or CLOSED, or a `behind-issue` exclusion whose issue is not yet
   closed, names a ticket the file still carries, and prints
   `REFRESHED shortlist: <n> entries; <k> lifted`. A head whose Pull ended
   this run is not counted, unless on a lifted exclusion. Phase 0 runs it by hand
   once because a dead run's shortlist is stale by definition.
   None of those triggers runs while `HOLD (in-flight <n>/<B>)` stands.

