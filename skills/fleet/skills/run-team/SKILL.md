---
name: run-team
description: Run an agent fleet — up to 5 implementers, up to 5 reviewers, one merge bot — over the ready-for-agent queue. Invoke-only; the fleet writes to a live repo and must never start unasked.
argument-hint: "[implementers] [reviewers]"
disable-model-invocation: true
---

Run `next-ticket`, `review-and-fix`, `run-merge-bot` as one fleet. You are the
**controller**, in the main thread, never a member.

`$ARGUMENTS` = `[implementers] [reviewers]`, both optional, default 5, cap 5.
Merge bot is at most one, not configurable.

Rationale: `~/.claude/docs/specs/2026-07-22-run-team-agent-fleet-design.md`. The
war story behind a rule ending `See references/<file>` lives in that file; load
it only when a member needs the *why*. A rule without that line carries its
reasoning inline — nothing is missing.

## Rules that fail silently

**A report is a `SendMessage`, not the end of a turn.** Every member owes the
controller one `SendMessage` naming its outcome before it exits — including a
member whose prompt carries no explicit report line. The "report the SHA",
"report PR number" and "stop and report" instructions below *are* that message,
not a second obligation on top of it. A member that does the work correctly and
ends its turn has reported nothing: the controller learns the outcome only by
re-reading artifacts and pinging, and a finding held only in that member's
context is lost. Members did exactly this in one run — finishers, a reviewer and
merge bots alike, the work done and only the delivery missing. Say it in every
dispatch prompt. See references/member-lifecycle.md.

**Say in every dispatch prompt that you do not acknowledge reports.** A member
cannot see whether its `SendMessage` arrived, so silence from you is
indistinguishable from loss and it re-sends — three members did in one run, each
burning a turn, and in all three the original had in fact arrived. Give them the
line verbatim: *"The controller does not acknowledge reports. Send once and exit;
never re-send unless the controller asks by name."*

**Your OWN messages can vanish the same way, and that half is not recoverable by
a re-send.** Two controller rulings were lost in one run, both with a
`success: true` receipt: a member proceeded on its stated default and filed a
tracker issue the lost ruling had said not to file. So **never read a member's
silence as assent**, and require members to report their *confirmation state*
alongside results — "I escalated X, received no ruling, proceeded on default Y".
That sentence is the only thing that made either loss visible. After any ruling
you cannot confirm was received, re-check the artifacts it governed.

**Name every member.** The name makes it a team member, and membership is what
carries the `Agent` tool. Omit it → the member loses delegation with no error.
Names follow the unit of work: `impl-<issue#>`, `fix-pr-<pr#>`,
`review-pr-<pr#>`, `merge-bot-<wave#>`. See references/member-lifecycle.md.

**Inverts one level down: members must name their children `undefined`.** A named
member passing a `name` fails with `teammates cannot spawn teammates`, so
specialists are dispatched **unnamed**. Say so in a fallback reviewer's prompt, or
it silently downgrades to a solo review. See references/member-lifecycle.md.

**Fresh context per member.** One agent, one unit of work, gone. Never
`subagent_type: "fork"` (inherits your whole conversation). Never re-task a
finished agent — `SendMessage` resumes its transcript and drags the old ticket in.
Refill = **new** agent, **new** name. `SendMessage` is still right for pinging a
member for a report it owes, or resuming a truncated reply.
See references/member-lifecycle.md.

## Phase 0 — shortlist

At start, and whenever the pool empties.

0. **Once per run, before anything else.**

   **Fast-forward the checkout before you trust these rules — you are reading
   them from it.** `git fetch origin && git rev-list --count main..origin/main`;
   non-zero means the SKILL.md you are executing is superseded, so
   `git merge --ff-only origin/main` and re-read what changed under
   `skills/fleet`. The usual cause is the PREVIOUS run's own close-out PR: it
   lands the rules THIS run needs and nothing pulls them. Measured twice — 57
   commits stale in one run, 20 in another, the second shipping every dispatch
   prompt without two rules that had merged the day before. Silent by
   construction: stale text reads as authoritative, and the tier guard's own
   floor is re-derived from a stale `tier-outcomes.tsv` at the same time.

   **Launch the cockpit.** On the first phase-0 pass only:
   `node ~/.claude/skills/fleet/scripts/board.mjs serve --open &` in the
   background. It is a read-only mirror of `.fleet/ledger.md` + `gh` — you never
   feed or update it, and it survives your own compaction. Skip on later
   re-shortlists (a server is already running; a second one collides on the
   port).

1. **Candidate scan** — `~/.claude/skills/fleet/scripts/candidates.mjs
   --require-label ready-for-agent`. **`--require-label ready-for-agent` mandatory, no
   fallback** — do NOT pass `--allow-fallback`. Empty means no work;
   `ready-for-human` needs a human to brainstorm first and you have no channel to
   one mid-flight.
2. Dependency scan, `next-ticket` step 2, on the `d` array. Open blocker → drop.
3. **In-flight check** — `~/.claude/skills/fleet/scripts/inflight.sh <N>` per
   candidate; any hit = taken. It runs all three probes (PRs, remote heads, local
   worktrees + branches) so a partial one cannot read as free. The PR probe is
   two signals rather than a bare full-text match — GitHub's own closing-PR links
   plus branch-segment matching — and both drop `MERGED` and `CLOSED`, so a
   merged or abandoned PR the `gh pr list` window covers cannot hold a ticket
   forever. A linked PR that window does *not* cover has no state to read: it
   prints `?` and still counts as taken, merged or not.

   **Exit 2 is not free** — the question went unanswered, so treat it as taken
   and say which candidate it was in the log. A probe that could not look is
   recorded rather than aborting the run, so exit 2 from one prints the same
   JSON as 0 and 1 plus an `unknown[]` naming the probes that could not look:
   read `unknown`, never `taken` alone, because exit 2 says `"taken": false`,
   which summarizes `hits` and is not a claim the ticket is free. A hit outranks
   an unknown — a payload can carry a non-empty `hits[]` and a non-empty
   `unknown[]` at exit 1, which is taken. Four causes print nothing at all — a
   bad argument, not inside a git repository, no such issue, a verdict that could
   not be written — so never assume exit 2 parses.
4. **Read each survivor in full, once** — `gh issue view <N> --json title,body,comments
   --jq '.title, .body, (.comments[]|.author.login + ": " + .body)'`. One read
   answers both questions. Record the Agent Brief's `Out of scope` sequencing.
   Then judge **decided?** — never size.

   **Still live?** A backlog ticket's claims rot. Before `decided?`, settle the
   ticket's central claim against `origin/main` — never the working tree, never
   the ticket's own line numbers, which drift. One `git show origin/main:<file>`
   piped to `grep` does it for any ticket citing a construct, which is most of
   them. **That read is fatal, not empty, when the path is untracked in
   `origin/main`** — `git show origin/main:<path>` exits 128 saying the path
   does not exist, and the file may still sit right there on disk, so it is a
   probe that could not look rather than a clean tree. Fall back to
   `git ls-tree origin/main -- <path>` (empty output at exit 0 = untracked)
   before reading the failure as "unfixed". Already fixed → close it citing the
   commit, do not claim it. Partly fixed → say which acceptance criteria the
   tree already meets, and which the tree now **contradicts**.

   **Grep for the ticket's ASKED-FOR CHANGE, not only its subject construct** —
   the construct check passes on every stale pin ticket, because the construct
   is what the pin is *about* and never went anywhere. So for a ticket asking
   for a pin, test or assertion, grep the **test file** for the assertion it
   wants; for one asking for exact wording, grep the **old** wording the ticket
   quotes as wrong, never the new wording it proposes. A proposed replacement is
   a suggestion the implementer is free to reword — an equivalent rewording
   satisfies the ticket while failing a grep for its literal text — and the
   quoted defect is the fact. Old string gone from `git show origin/main:<file>`
   ⇒ the fix landed, and
   `git log -S '<old string>' --oneline origin/main -- <file> | head -1` names
   the commit that removed it, `git merge-base --is-ancestor <sha> origin/main`
   proves it is not a pre-rebase orphan, then close citing it. Seconds either
   way, and the construct half alone is the probe that could not look.

   **Both halves of that command are load-bearing.** Drop the `origin/main`
   argument and `git log -S` searches `HEAD`, contradicting the rule a paragraph
   up — and the two searches fail differently there. On a checkout behind the
   fix the prescribed **old**-string search names a *wrong* commit at exit 0,
   the old string still being present in that tree: measured at #206's
   `0dc39ef^`, `| head -1` names the rename `4fd2f73`, not the fix. It is the
   **new**-string search the paragraph above forbids that prints nothing at exit
   0 there, indistinguishable from "the change never landed"; the old-string
   search goes empty on a checkout that predates the old string's own arrival
   at that path — behind that rename in #206's case, and with no rename in play
   at all in this file's: measured at `647ae44^`, which already tracks this
   path under this name, `git log -S 'ls-tree origin/main'` prints nothing at
   exit 0.
   Add `--reverse` and you get the *oldest* count-changing commit, which is the
   file's last rename whenever the string predates one — measured on #206's old
   wording, `--reverse` names `4fd2f73` ("move next-ticket and sizing-a-ticket
   into the plugin"), a refactor that clears the `--is-ancestor` gate exactly as
   well as the real fix, while newest-first `| head -1` names `0dc39ef`, the
   commit that actually did it.
   (`--follow` fixes the rename half but is mutually destructive with
   `--reverse`: the two together return empty at exit 0, and `--follow` takes
   exactly one pathspec or exits 128.) So read the subject of whatever it names
   before citing it in the close, and treat empty output as an answer you did
   not get rather than a commit.

   Measured, one wave: #132's one-line remedy had shipped in `e7b11e6` ten days
   earlier and #134's AC-2 asked for an exit code a later design (#64)
   deliberately changed — neither commit carried a trailer back, so the tracker
   showed both as open work. #132 cost a full claim, worktree and implementer
   dispatch to learn this; #134 would have shipped a test asserting the opposite
   of the shipped behaviour. The two probes that settled both took seconds.
   **A ticket deferred from a review is a claim about a tree that has since
   moved** — and the older the ticket, the more it has moved, so this bites
   hardest at exactly the head of an oldest-first queue.

   Measured again 2026-08-19: four stale in the 20 oldest, and the construct
   probe caught **none** of the four. It **missed** #156 — the two pins and the
   `contentWords()` extraction it asks for had all landed (`d016414`, `1abd6c8`)
   while `overlap()`, the construct, sat right where the ticket said, so the
   probe passed the ticket through as live work and it cost a claim, a worktree
   and a dispatch. It **missed** #205, whose `d:` scan `candidates.test.mjs`
   already pinned — `6d94451` and `43d6ac5` both added `.d` assertions, and the
   ticket's own closing comment cites both. It **missed** #206, whose wording
   defect `0dc39ef` had already fixed — by an **equivalent rewording**, not by
   the literal string the ticket proposed, which appears nowhere in
   `origin/main`; the ticket's **line number** had drifted too, `:95` → `:98`.
   And #187 it could not read at all: that ticket's file is untracked in
   `origin/main`, the fatal-not-empty case above.

   **Decided?** Would two competent implementers, reading only this ticket, build
   materially different things? "Material" by inventory, not feel:

   | Left open | Verdict |
   |---|---|
   | architecture, API shape, schema, UX | **undecided** |
   | new dependency, new seam | **undecided** |
   | naming, file layout, ordering, test arrangement | decided — ignore |

   Any undecided item → not decided. Name it; that name is the exclusion line.
   **Torn → surface, never guess** (step 6's `unsure` group). Opposite of
   `sizing-a-ticket`'s *torn → take the heavier row*, deliberately — see that skill.

   No sizing agent here. `sizing-a-ticket` picks the *process path*, and that is
   phase 2's call, after the ticket is claimed.

   **Class?** Second judgement off the same read, so it costs no extra tokens.
   Stale docs, wrong comments, bad citations → `class=correction`; everything
   else → `class=routine`. **Torn → correction**: a misjudged routine is a
   missed saving, a misjudged correction runs the one class that demonstrably
   ships new wrong claims.

   **The class no longer selects a model tier** — the phase-2 guard fired on
   2026-08-16 and every class now dispatches at the session's tier. It still
   earns its read: it selects the **correction-ticket discipline** phase 2
   hands the implementer (settle every restated claim against the tree, keep
   the diff to the ticket's stated size, no positional references), it
   partitions `docs/metrics/tier-outcomes.tsv`, and it is what any future tier
   control would be drawn from. A row with no class is still `class=unknown`,
   never a guess.

   The correction exception was always a **precaution, not a measurement.**
   references/correction-tickets.md records four tickets in one run each
   shipping a *new* wrong claim, and blames the ticket's framing and
   unasked-for prose — **not** implementer capability; it measures no tier at
   all. That reasoning is why the discipline survives the tiering that used to
   accompany it.

   Record the class in step 6's annotation; phase 2 reads it for the
   discipline, no longer for the tier.
5. **Collision scan against open PRs** — a survivor is an *un-implemented issue*
   with no diff, so infer its target files from the issue body (the paths it
   names) and compare them against each open PR's `gh pr diff <PR> --name-only`,
   and against the other survivors' inferred files. `pr-overlap.mjs` is **PR-vs-PR
   only** — it runs `gh pr diff` on *both* args and errors on an issue number, so
   use it the way the merge bot does (PR vs PR), never on a candidate issue here.
   Step 3 catches a ticket already taken, not one that *edits a file an open PR
   edits*. Overlap → admit one, defer the rest with the reason. The tracker cannot
   express this, and it is what actually stalls a wave.
6. Present survivors as a multi-select, **oldest first** (`candidates.mjs` already
   sorted; do not re-rank). Three groups:

   - **admitted** — decided;
   - **unsure** — torn, each flagged with the open decision;
   - **excluded** — undecided, each with the decision that is missing.

   Annotate every survivor with its class — `correction` or `routine` — so the
   maintainer sees which tickets carry the correction-ticket discipline before
   ticking them. Annotate any survivor the `Out of scope` read sequences after
   another survivor in the same list. Without that, FIFO puts a chain's members
   next to each other and two consecutive numbers read as two independent
   tickets — which is exactly how both land in one wave.

   Maintainer ticks what to **stage this wave** — how many, what order, what
   collides. Staging, never vetting: `ready-for-agent` already carries triage's
   verdict that an agent may take the ticket, reached with the maintainer present.
   Phase 0 does not re-litigate it, and an unticked ticket is deferred, not judged
   unfit. **unsure** is the only group asking a judgment.

   Excluded, not dropped: phase 0 never relabels an unclaimed ticket, and an
   unticked ticket keeps `ready-for-agent` and returns next wave.

Never put two sequenced tickets in one wave. That lives in the brief's `Out of
scope`, is invisible to step 2, and bites hardest at five wide.

## Phase 1 — claim and isolate

Serial, main checkout, per ticket. Never parallel, never inside a member —
concurrent `worktree add` and label writes race.

`~/.claude/skills/fleet/scripts/claim-ticket.sh <N> <slug> <type> --apply` does
the label, worktree, branch, frozen install, lockfile-clean assertion, and the
isolation runner in one serial pass. Infer branch/worktree convention from
`git worktree list` and `git branch -r` for the `<slug>`/`<type>` arguments.

**Infer `<install>` — never default to `npm install`.** A lockfile-mutating
install in a throwaway worktree corrupts it for everyone; the script derives the
frozen form from the lockfile and refuses to guess.

**Materialize the isolation envelope as a file, not a briefing.** The script
writes `.worktrees/<N>-slug/agent-test` (ports derived from `<N>`, so collisions
are impossible) and `.git/info/exclude`s it. Brief members with `./agent-test
<file-or-dir>` and nothing else — anyone who finds the worktree finds the
runner, including grandchildren you never dispatched. A directory works too and
expands to the test files under it; one holding none refuses rather than passing
vacuously, so a mistyped file or directory path cannot come back green. See
references/isolation.md.

**A reused worktree may lack the runner.** `claim-ticket.sh` writes `agent-test`
only when it claims a *fresh* worktree. A worktree carried over from a prior run,
or an already-open PR's worktree you send a rebaser/resolver into, predates the
marker and has no `./agent-test` — a member told to use it stalls on a missing
script (observed with a rebase-resolver in a prior-run worktree). When you
dispatch into a NOT-freshly-claimed worktree, either re-materialize the runner
first or tell the member the runner is absent and to run docker-free suites
directly (`npx vitest run --config vitest.ci.config.ts <file>` — the CI unit
config has no `globalSetup`, so there is no stack to collide on).

## Phase 2 — dispatch implementers

**Dispatch every implementer at the session's tier — omit `model` on the Agent
call, whatever the class.** That omission is the whole mechanism, and a member
dispatched with `model` set does not get it back. It holds only while the
implementer's subagent type carries no `model:` frontmatter — an omitted `model`
takes the *agent definition's* tier first and the session's only after.

**`class=routine` → `sonnet` was REVERTED on 2026-08-16, by the guard below
firing.** Both halves were met on the accumulated `docs/metrics/tier-outcomes.tsv`:
the floor (8 `class=routine` PRs spanning 3 distinct `run_date`s) and the trigger
(2 rows carrying `closed_own_ticket` `no` — PR #452, which regressed the exact
defect its ticket existed to remove, and PR #466, which emitted invalid JSON in
the very payload its three tickets existed to make truthful). Per the guard's own
wording this reverts **`class=routine`**, never the rule wholesale: phase 0 still
records the class, it still governs the correction-ticket discipline, and it is
still what a future control would be drawn from.

**Read the counter-evidence before restoring it.** Recount from the file before
citing it — these figures are a snapshot, not a live count, and a doc-only
append lands a row without touching this paragraph. **As of PR #747,
2026-08-21, 50 rows:** the file now holds 33 `class=routine` PRs across 8
distinct `run_date`s, so the floor is long since met, and 5 of them carry
`closed_own_ticket` `no` (#452, #466, #536 at `sonnet`; #693, #707 at `opus`),
so the trigger is met too. **Firing changes nothing: the action is "revert
`class=routine` to top tier" and that revert already happened on 2026-08-16.**
The guard is in its fired state and has no further move; the live question is
the opposite one, restoring a cheaper tier, which this guard does not decide.

The raw split now favours the top tier — 3 failures in 9 `routine`/`sonnet`
rows against 2 in 24 `routine`/`opus`. **Do not read that as a tier result.**
8 of the 9 `sonnet` rows fall on 2026-08-13 to 08-17 and 23 of the 24 `opus`
rows on 08-18 to 08-21, so tier is very nearly confounded with calendar date
and therefore with prompt evolution — the dispatch prompts gained rules
throughout that window. The one row that breaks the confound is **PR #714**
(2026-08-20, `routine` at `sonnet`, maintainer-authorized as a deliberate
control, run against current prompts): it **passed**. That is n=1 in the
direction opposite the raw split.

`minted_false_claim` **now discriminates and no longer reads "always yes"** —
9 of the 33 `routine` rows carry `no` (#601, #656, #663, #674, #688, #692,
#693, #726 at `opus`; #714 at `sonnet`). Read it as a property of the TICKET
before the tier: a pure code simplification need not add prose, while a
correction ticket adds prose by construction. The honest summary is that the guard fired on the criterion the
maintainer chose in advance, not that the cheaper tier has been shown worse.

**No class recorded → record `class=unknown`, never a guess.** Since the revert
every class dispatches the same way, so a lost class no longer misprices a
member — but it still costs the **correction-ticket discipline**, which phase 2
selects on the class and which is the half that caught real defects. Every path
that loses it lands here — a compaction, a phase-3 refill re-entering phase 1
then 2 without a fresh issue read, a killed member replaced from inherited
state. Writing the gap down is what makes it visible; re-read the issue to
recover the class when a correction's discipline is worth one `gh issue view`.
**Never infer the class from the tier** — that inference is what the revert
removed, and a future control would break it again.

Carry the class in the ticket's ledger row, written before dispatch like every
other field:

```
ledger.mjs row <N> "impl-<N> · class=routine"
ledger.mjs row <N> "impl-<N> · class=correction"
ledger.mjs row <N> "impl-<N> · class=unknown"
```

`row` **replaces the whole line**, it does not append. Re-dispatching over a row
that already carries `KILLED`, `ports=` or `→ PR#` must repeat those tokens or
they are gone, with only `rewrote row #N` on stderr to say so. Recover a class
after a compaction with `ledger.mjs read` — `class=` is a raw-row field, and the
cockpit does not parse or surface it.

`ledger.mjs read` is safe on a pipe as well as a redirect: its payload used to
be abandoned at the pipe buffer and still exit 0, which is what left `board.mjs`
reporting `ledger read parse failed` and serving a blind cockpit for a whole run
(#246, fixed). Every use above is a recovery path, so a payload that arrives
short lands exactly where a lost class or a settled `ruled:` is unrecoverable —
which is why the script's own suite pins that each subcommand reaches a pipe
whole.

**Guard: accumulate per PR, never conclude inside one run.** The unit is the PR —
refill is level-triggered, so there are no implementer waves. **Append one row to
`docs/metrics/tier-outcomes.tsv` when you rule each PR's review** (that file's
header carries the column meanings). That append is the whole duty; the guard
fires on the accumulated file, across runs, not on the run in front of you.

**Why not decide inside one run.** A run holds 2-3 implementer PRs, and ticket
difficulty swamps the tier effect — a gojq parity harness and a two-statement
shell reorder are not comparable units. Finding-counts are not comparable either:
`selectDimensions` trims the fan-out by diff profile, so one PR fields 29 agents
over six dimensions and its sibling fields 8 over three. And the fleet is not
stationary — this prompt gets edited mid-run when a defect earns it. Hence a
binary outcome per PR, accumulating, rather than a per-run verdict.

**Why the rows this guard fired on could not answer the tier question, and this
is the load-bearing part.** Until the 2026-08-16 revert, `class` and `tier` were
perfectly confounded: routine always ran `sonnet`, correction always ran top
tier. So the comparison the file invites — routine-at-sonnet against
correction-at-top-tier — measures **class, not tier**, because those classes fail
in different ways by construction: corrections ship false claims in prose,
routines ship incomplete or regressing code. A run that "mixes both" does not fix
it. **Only a same-class comparison across tiers is informative**, and the old
rule could not produce one, since no routine ticket ever ran at top tier.

**That last sentence is no longer true, and this is the part to re-read.** Since
the revert every routine ticket runs at top tier, so the file now holds 24
`routine`/`opus` rows against 9 `routine`/`sonnet` (as of PR #747, 2026-08-21 —
recount before citing). The same-class comparison the paragraph above calls the
only informative one therefore EXISTS now. It is still not clean: the two groups
are split almost exactly by calendar date, so it measures prompt evolution at
least as much as tier. The counter-evidence paragraph earlier in this section
carries the split and the one deliberate control that cuts against it.

**So read what the guard actually established: routine tickets sometimes fail to
close their own ticket. Not that `sonnet` caused it.** The revert is the
pre-committed rule being honoured, not a measurement. Restoring a cheap tier —
or answering the question properly — needs a deliberate control, some
`class=routine` tickets dispatched at top tier, which is a change to the
dispatch rule and therefore the maintainer's call, not yours.

The risk being priced is economic, not shipped bugs. Reviews run 3-5x *longer*
than implementation (Red flags, below), so one extra fix-round costs a wave slot
and eats the saving the cheaper implementer made. The revert needs a floor AND a
trigger, and neither alone. **Floor:** the file holds at least
three `class=routine` PRs spanning **two or more distinct `run_date`s**.
**Trigger, read only once the floor is met:** **two or more** of those rows carry
`closed_own_ticket` `no`, or the implementer
share in `board.mjs build`'s `.spend.roles` is climbing →
revert **`class=routine`** to top tier, never the rule wholesale. That floor is
over the accumulated file, never one run — and the `run_date` half is what makes
that literal instead of merely asserted: a PR count alone is satisfied by a
single run's rows, which is the state this file ships in. Without the floor a
single noisy PR reverts a class; without a `no` count, "trending" names no
threshold and whether the guard fires is undefined. Per-`impl-<N>`
spend is not available: `.spend.top` labels agents by their Agent-call
`description`, not their member name.

**Never read the guard's silence as a pass** — and never read a single run's rows
as its verdict.

One named member per ticket, up to cap, background. Each prompt carries ticket
number, worktree abs path, branch, and each of these verbatim:

> **You are an unattended fleet member.** No maintainer is reachable, no user
> will answer you, and no approval gate will ever clear for you. Report to the
> controller and to nobody else. Where a skill offers a maintainer-present step
> and an unattended one, yours is the unattended one.

> You are ALREADY in worktree `<abs-path>` on branch `<branch>`. Do NOT create
> another worktree. Verify with `git rev-parse --git-dir` and
> `git rev-parse --git-common-dir`. Skip the using-git-worktrees skill's Step 1.

> Read the issue with `gh issue view <N> --json title,body,comments --jq '.title, .body, (.comments[]|.author.login + ": " + .body)'`.
> Not bare `gh issue view <N> --comments` — non-interactively that prints only
> the comments, and nothing at all when there are none, dropping the title and
> body either way, exit 0, so the loss is silent. The `## Agent Brief` comment
> is authoritative over the issue body. Honor its `Respec` block — it may
> explicitly rule out hypotheses the body raises. Read the issue **before
> touching code**: with the repo in front of you, still undecided or needing
> human hands you do not have → bail, name the cause, do not implement.

> **Re-derive the ticket's claims against `origin/main` before implementing** —
> not the working tree, and not the ticket's line numbers, which drift. Phase 0
> runs a cheap version of this check, so what reaches you is what a `grep` could
> not settle; you have the tree, so you are the backstop. Already fixed → report
> that with the commit and do NOT invent work. An acceptance criterion the tree
> now **contradicts** is a bail, not a thing to implement: say which, and stop.

> Commit incrementally as you go. Do not accumulate a large uncommitted diff — if
> you stop for any reason, uncommitted work is invisible to the controller and
> effectively unrecoverable.

> Your ticket names the cases it was written from. **Before implementing, enumerate
> every member of that class — including any the ticket names only in passing — and
> say which you cover and which you deliberately leave** — a guard on one path
> has siblings, a predicate has other inputs, a check on a directory has
> subdirectories. Fixing exactly the named cases is how a fix ships without
> closing its own ticket.
>
> Build that list from **the ticket's own prose first**, then from the mechanism.
> A case the body names in passing is still a named case, and enumerating from
> first principles is how you miss it. Then ask the other half: **what can this
> change wrongly REFUSE?** A new guard's false-positive class is not its
> false-negative class, and a suite that only feeds it valid input pins neither —
> so leave one test behind that feeds it input it must ACCEPT.
>
> **Both halves above are about the bug class. The third is about YOUR EDIT:
> enumerate what your change newly does, not only what the code already did
> wrong.** Moving, reordering or wrapping a statement has effects the ticket
> never mentions — the last command of a script sets its exit status, a
> relocated line changes what `set -e` covers, a hoisted guard changes what runs
> first. **Ask which of the ticket's own acceptance criteria your restructuring
> could newly violate, and test that path.** Measured: #265 required "no path in
> the script exits 1", and the fix for it moved a guard to the file's end,
> regressing the default dry run from exit 0 to exit 1 — the ticket's exact
> defect, relocated onto the path nobody tested. The implementer had enumerated
> every exit-1 path and declared two it was leaving; all of them were
> pre-existing, and none was the one its own edit created.
>
> **Then check the suite can even see the mode you changed.** That regression
> shipped under 616 green tests because all eight call sites passed the same
> flag, so the default mode had no test at all. A green suite is evidence only
> about the paths it exercises.

> Run `sizing-a-ticket` for the process path and proceed on **either row** —
> heavy is never a bail reason, and that skill owns the fleet's heavy-row entry
> point, whose condition you are. A brief that will not support a plan is the
> undecided case: bail and name the cause, never a heavy row. Selection and
> claiming are already done (`next-ticket` steps 1-5), so you start at
> `next-ticket` **step 6**, which is that sizing run.
>
> Then `next-ticket` **step 7**: rebase, re-run tests, push, `gh pr create` with
> `Closes #N` in the body and exactly one release label — `patch`/`minor`/`major`,
> the *label*, not the branch *type*. Report the PR number and head SHA to the
> controller, then exit. Never apply `ready-to-merge`, never merge.

Each rule in the enumerate-and-declare block is load-bearing, for a different
reason.
**Enumerate-and-declare** answers a signature measured four times in one run:
each implementer fixed exactly the cases its ticket named and left an adjacent
one of the same class broken — a CRLF body **broken by** the fix for depth and
split headings, a symlinked worktree after fixing locked and regular-file ones,
an unreadable `refs/heads/<type>/` after fixing `refs/heads` itself, a bracketed
file path after fixing typos and vendored ones. **All four failed to close their
own ticket** — #65's acceptance criterion went unmet, and the other three left
the named defect reachable by a sibling spelling. Every one was caught by
review, at review cost, which runs 3-5x the implementation it checks.

**Prose-first** and **wrongly-REFUSE** are not padding — they are the #394 case,
which shipped with **enumerate-and-declare** already in its prompt. It missed a
shape its own ticket named in passing, because it enumerated from the mechanism
instead of the text; and it introduced a regression refusing every `node --test`
flag, because it enumerated what the guard should catch and never what it could
wrongly refuse.

The commit-incrementally block is not optional. A member that goes idle mid-task
leaves its diff only in the worktree, and the controller cannot reap, replace,
or even see it — `worktree-audit.sh`'s committed-vs-uncommitted split is exactly
what decides whether a replacement redoes or destroys work. Observed twice in
one run.

**The identity block is what makes `sizing-a-ticket`'s fleet entry reachable.**
That skill conditions its heavy-row entry on the reader being a fleet member; a
reader that takes itself for a solo session gets `superpowers:brainstorming`
instead, whose `<HARD-GATE>` withholds every implementation action until a human
partner approves — approval no unattended member can obtain, so it parks rather
than fails. Nothing else you carry says what the member is — an incidental
mention of the controller is not a statement that the reader is one of its
members. That skill keeps its condition, so a solo session still runs the
interactive path; this block is what puts a member on the fleet side of it.

A member that bails demotes nothing itself; demotion by cause is yours
(**Implementer bails before implementing**).

## Phase 3 — event loop

React to events; never block on one.

**React to artifacts, not agents.** `idle` means "not currently executing", not
"done", and a finished member's finding may never arrive. Read `gh pr view`,
`gh run view`, `git -C <worktree> status` **before** messaging; when you message,
send the specific next action, never "what is your status".
See references/member-lifecycle.md.

**Do not ask permission to run the loop.** Dispatching a reviewer, spawning a
merge bot, refilling a slot, re-verifying a SHA, filing a follow-up — all proceed
unconfirmed. Invoking the command was the opt-in. Two exceptions: **Phase 0's
multi-select**, and **a judgement the evidence cannot settle**.

- **Implementer completes** → verify the SHA is reachable on the expected branch →
  enqueue for review → refill the slot (phase 1, then 2) with a new agent.
- **Implementer bails before implementing** → demote by cause:

  | Cause | Label |
  |---|---|
  | brief does not decide *what* to build | `needs-triage` |
  | needs human hands — external access, manual testing, judgment during the work | `ready-for-human` |

  `gh issue edit <N> --remove-label ready-for-agent --remove-label in-progress
  --add-label <label>`, comment the cause, release the worktree and branch with
  `release-ticket.sh` (below — `reap.sh` declines a claim that never became a
  PR), refill with a *different* ticket. `needs-triage` routes back to
  `/triage`, which can return it as `ready-for-agent`; `ready-for-human` is the
  dead end, so use it only for hands, never for vagueness.

  **Dropping `in-progress` is the load-bearing half** — phase 1 applied it and
  `candidates.mjs` excludes it, so leaving it makes the ticket invisible to your
  scans *and* the maintainer's. It does not loop; it disappears. Phase 0 excludes
  without relabelling — an unclaimed ticket is not yours to reclassify, and it
  surfaces its exclusions to the maintainer anyway.
- **Review slot free, PR queued** → run the review workflow yourself, then
  dispatch a fix-applier for what survives (below). Nothing survived and nothing
  to file → skip the fix-applier and dispatch the **finisher** directly: no
  member will touch that PR, so no push is coming and nothing will wake you.
- **Reviewer labels a PR** → merge-bot wave.
- **Monitor: `ready-to-merge` appears** → merge-bot wave. Catches hand-added labels.
- **Merge-bot wave reports done** → reap merged branches and worktrees (below),
  then run the reconcile (below).
- **The run ends, or the maintainer says drain** → release every claim that never
  became a PR (below). Nothing else in the loop fires for those.
- **Monitor: CI run completes** → bind it (`ci-state.mjs --pr <N>`); the
  diff-validating `check` job green with no heavy job (the diff-validating suites,
  not the `rebase-check` currency gate) in `failure` → dispatch a finisher to
  label, a `check` **failure** → a fixer. A `check`-green board whose
  heavy jobs are merely `skipped` (behind-count staleness, the normal wave case)
  still labels — do NOT gate on `ci-state --quiet` exit 0, which a behind PR never
  reaches. Fix-appliers push and exit, so a member is rarely still waiting — ping
  one only if it genuinely is. **This edge fires on the fix-applier's own push, so
  it is exactly where a ruling you still owe it is outstanding — never dispatch off
  it while you do.** Empty your outbox to it first — including any ruling you have
  withdrawn or reversed — then dispatch (below); a final report is not proof it
  stopped. Then run the reconcile (below).
- **A fix-applier reports `no-op`, or a SHA you have already bound** → dispatch
  the finisher **now**, against the existing head. No push means no new run, and
  the Monitor above is edge-keyed on `<run-id>:<attempt>:<conclusion>` — that
  head's terminal state already fired once and will never fire again, so waiting
  for the CI event waits forever. This stays a common outcome on a clean PR:
  `suggestion` is the band a clean diff produces, and every out-of-scope or
  refuted one is filed as an issue rather than committed. An edge-only label path
  therefore strands exactly the PRs with nothing wrong with them. **Reconcile, do
  not wait for an event** governs here too, not only implementer refill.
- **`ci-state.mjs --pr <N>` reads `verdict: "no-ci"`** → no workflow run will ever
  complete for this repo, so the CI-run-completion edge above never fires and
  waiting for it stalls the whole PR — the same silent-stall shape #111 reported
  before this verdict existed. Dispatch the finisher off the reviewer's final
  verdict instead, the moment it lands — and, same as above, never while you still
  owe it a ruling — or hold anything else it has not received, a ruling you have
  withdrawn or reversed included. The finisher's gate is then the
  `--declare-no-ci` declaration, not a `check` job: with it, label off the
  reviewer's verified suite run; **without it, do not label** — report that this
  repo has no CI configured and no declaration, and stop. Absence never reads as
  pass. See `review-and-fix.md` step 6.
- **Pool empty** → phase 0 again, subject to queue depth. Run phase 2's tier
  guard here once three or more `class=routine` PRs have been ruled since the
  last check; nothing else in the loop owns it.

**Run the reconcile on the merge-side edges.** Both edges marked above —
**merge-bot wave reports done** and **Monitor: CI run completes** — end with one
invocation of the executable reconcile, and you act on what it prints:

```
~/.claude/skills/fleet/scripts/fleet-tick.mjs \
  --implementers <live> --reviewers <live> --merge-bots <live> --pool <n> \
  [--implementer-cap 2] [--reviewer-cap 5]
```

It prints `actual/target` and an explicit ACTION for implementers, reviewers and
the merge bot, with the whole Queue depth guard table below applied in code. The
live counts and the pool are yours to state and it **refuses rather than
defaulting them**: nothing in the repo records liveness — a ledger row is a
dispatch, and that token outlives the member's death, its bail and the merge —
so a default would turn a forgotten flag into either a dispatch past the cap or
a permanent hold, silently. Review backlog, merge queue and supply it reads
itself.

Why these two edges: a merge cascade is a firehose of merges, CI greens and
rebases that holds your attention on the merge side while the implementer side
drains to 0 and stays there — 0 implementers emit no completion event, so the
refill edge is dead. Piggybacking the level-check onto events you are already
handling is what makes that drain visible. **It is edge-triggered, so it does
not cover a fully drained queue with no incoming events at all** — no members
and no open PRs means nothing wakes you, and the periodic resync that would is
not built (#3, deferred).

**Own the CI waits.** Members are turn-based and cannot hold across a ten-minute
run — they rebase, push, stop. Arm a second persistent Monitor over open PRs'
latest runs, keyed `<run-id>:<attempt>:<conclusion>` so each terminal state fires once, and
emit the behind-count and the per-job conclusions with it: a `success` on a branch
8 behind is not actionable, and `check`-green-with-heavy-skipped is the staleness
board you must not confuse with a red. Do not reinvent that read: one
`~/.claude/skills/fleet/scripts/ci-state.mjs --pr <N>` per open PR already emits
run id, attempt, conclusion, behind-count and per-job conclusions, branch derived
from the PR — including the `gh api --hostname <host>` a GHE compare call needs,
without which the probe 404s and `behind` comes back `null`, never 0, so every
event reads as unknown-behind. Call it **without `--quiet`** — that flag drops
`jobs` and `missing`.

A monitor event is a wake-up, never a verdict; members re-query at labelling
time. See references/ci-and-staleness.md.

**A conclusion is not stable, even for a fixed run id on an unchanged head.** A
rerun rewrites the run in place, so never cache a conclusion; key watchers on
`<run-id>:<attempt>:<conclusion>`. Leaving `attempt` out of the key is the bug
that looks like it works: a rerun that lands on the *same* conclusion regenerates
an already-seen key and fires nothing, so the second failure is silent and reads
exactly like a run still in progress. **Building that key with jq's `//` is the
same bug in the opposite direction**: `ci-state` reports an in-progress run as
`conclusion: ""`, and `//` catches `null` and `false` but never the empty
string, so `.conclusion // "-"` passes `""` straight through, keys a RUNNING job
as terminal and fires a spurious not-green — measured in four separate runs,
including one where the controller then had to re-arm blind. Test any fallback
you write against `""`, `null` AND a real conclusion, and check it still lets
the real one through: `map(if . == null or . == "" then "-" else tostring end)`.
Also: the newest
run on a branch is frequently *not* CI, so `--limit 1` can hide the CI result
entirely. See references/ci-and-staleness.md.

### Reviewers

**You run the review yourself: `Workflow({name: "review-pr", args: {pr, branch,
worktree, testCmd, scratch}})`, once per PR. That is the default path.** Only you
can run it — members have no `Workflow` tool (verified 2026-07-30 for the
`general-purpose` subagent; tool availability is per-agent-type, so recheck after
a harness change rather than treating it as permanent) — and it is the only path
on which `selectDimensions` sizes the fan-out to the diff and the verify budget
follows severity. Hand-dispatched, neither executes at all: sizing falls back to a
reviewer's own judgement and nothing budgets the adversarial pass. It cuts one
immutable snapshot, verifies every critical/important finding adversarially, and
has `agent()` return **into the script**, so no report can go undelivered and you
relay nothing — the delivery failure that cost one fleet five reports on one PR
and four on another.

**Know the trim before you rely on it — it is wider than `docsOnly` suggests.**
`diff-stats.mjs` calls a PR docs-only only when it touches **no** src, tests *or*
config, but that strictness cuts both ways and the size tier trims again on top.
Measured: a docs PR that also adds one test file is profile `tests-only` and runs
**three** (correctness+tests+comments), not six; a docs+config diff too big for
the size tier runs correctness+comments without being docs-only at all; and any
`single-file` or `small` profile trims to correctness+silent-failure, keeping
comments only when a docs file is in the diff and tests only when a test file is.
That floor holds **regardless of `hasSrc`** (#236) — a one-file `.yml` or
`.github/` shell change runs correctness+silent-failure, not correctness alone,
and a *small* docs+config diff runs all three. It is the size **tier's** floor,
so `tests-only` outranks it: that profile is assigned ahead of
`single-file`/`small`, so a no-src diff that also touches a test file gets no
silent-failure-hunter (#739). `single-file` means one file at **any** size, so a
one-file rewrite trims too. An unknown profile widens to the full six, the safe
direction, so a trim is never something to count on in advance — and a full six
is never something to assume.

**One review workflow at a time.** The workflow is not a member — count the
**fix-applier** against the reviewer cap, never the workflow — but that
accounting leaves the workflow itself ungated, and the cap bounds *members*, not
the agents members and workflows spawn. Its own fan-out is 1 snapshot + up to 6
specialists + 2 refuters per critical/important finding, and the fix-applier is
not dispatched until it returns, so the reviewer cap reads five free slots for
the whole 20-40 minutes the review runs. Queued PRs wait. A queue is not a reason
to start a second.

It returns `{pr, head, snapshot, dimensionsRun, dimensionsUnrun, survived, refuted, unverified}`.
`unverified` is *not* "checked and cleared" — a `suggestion` skips the pass by
policy, and a finding whose refuters all crashed lands there too. Hand those over
with the rest; never rule on them yourself. `refuted` comes back deliberately as
well — a refutation is itself a claim, and one has been reversed on new evidence —
so record it in the ledger's `ruled` line and hand it over only when you reverse
it. **A 1-1 split is not a verdict** — read the votes, not the band. Three tied
refutations were reversed and re-examined in one run; all three findings survived.

**`dimensionsRun` is the dispatch; `dimensionsUnrun` is what names a gap.** A
specialist that dies, and one that never executed the suite, both contribute zero
findings while the key stays in `dimensionsRun` — so read the two together. A key
in `dimensionsRun` and NOT in `dimensionsUnrun` is covered; every
`dimensionsUnrun` entry is `{dimension, reason}` naming which failure it was.
Re-run those, or name them unrun in the report — an absence of findings is not
coverage. Same rule the fallback below states for a killed specialist, for the
same reason.

The rule this replaces — treat any dimension with nothing in
`survived`/`refuted`/`unverified` as unrun — was the workaround for having no
such field, and it over-refuses in the direction that costs work: a dimension
that ran clean has nothing in those three either (#137, #138).

**A throw or an empty return is a failure event, not a clean review.** It throws
on missing `args.pr`/`args.worktree` and on a snapshot agent that returned no
tree, and it surfaces to you mid-loop, where "react, never block" makes it easy to
log and carry on — leaving a PR that *reads* as reviewed and is not. Being no
member, it has no row in **Failure handling**. Retry once; still failing →
hand-dispatch the fallback reviewer below and record in the ledger which path ran.

**Then dispatch a fix-applier** — one named member per PR, `fix-pr-<pr#>`, never
the PR's implementer. Its prompt carries the PR number, the worktree abs path, the same `testCmd` you
passed the workflow, and the returned `survived` / `unverified` findings
verbatim, plus:

**Verbatim means every one, not the ones you rank.** On the workflow path you are
the *only* copy a member can reach — `agent()` returned the findings into the
script, and the specialists' own transcripts, which do exist on disk, are not
addressable by a member: nothing it is handed names one. Relaying a selection
strands the rest: two fix-appliers in one run were sent 5 of 7 and 7 of 13, each
asked for paths nothing had given it, and each reported findings as
looked-at-by-nobody that were simply never sent. Paste all of them, and add no
adjective — ranking an unverified `suggestion` by how sharp it reads is how a
controller lends its own weight to a finding no refuter has touched yet. Twice
in that run the ranked one was refuted outright.

**Scan the findings against each other for MUTUAL EXCLUSION, and rule before the
conflicting change reaches the tree.** Refuters are blind to their siblings, so
two can approve changes that cannot both land — one preserving a comment block
another's change deletes, one keeping a binding another collapses. Only you hold
every ruling, so only you can see the pair. Two runs have produced it: PR #332,
and PR #404 where a refuter proved a variable collapse behavior-equivalent over
844 cases while its own blast-radius scan named the two comment blocks a
*different* refuter had just established as guarding distinct pinned hazards.

The scan's two inputs arrive at different times, so run it twice. **Before you
dispatch anything**, group the findings by `file:line` and by whether one's fix
undoes another's — that is in the findings' own text, which you hold for every
band. **Then as each refuter report lands**, read its blast radius against what
you have already ruled on: the workflow's own refuters return their votes with
the findings, and a report from one the fix-applier spawned surfaces to you, so
that half arrives mid-flight rather than before dispatch. The deadline is the
tree, not the dispatch.

**A conflicting pair goes to a SINGLE refuter, briefed with both claims.** That
is what settled #332's — one refuter tested the two against each other and ruled
*"B wins: A's premise is false"*, where two independent refuters would each have
approved their own side, which is how the pair arises at all. **Defer only when
no single refuter can settle it**, with the equivalence evidence recorded in the
filed issue so the work is not redone; that was the right call in the #404 case,
where the refuter had also falsified the finding's own rationale. Never let both
reach the tree and hope the diff coheres.

The same scan catches a quieter shape: a finding whose **suggested fix quotes text
another applied finding deletes**. Measured on PR #405 — `survived[5]`'s pin was
written as `/not inside a git repository/`, wording `survived[3]` removes as
fabricated, so applying both **as written** would have produced a pin matching
nothing. Not mutual exclusion, and it does not conflict at the diff level; it goes
stale and passes for the wrong reason. **Re-deriving is the fix:** never copy a
pin out of a finding, derive the assertion from the post-fix tree. Ordering is
what makes that possible rather than a second remedy — apply the finding that
changes the text before the one that asserts on it, and the tree you have to
derive from exists.

**A `refuted=false` verdict is not an instruction to apply.** It says the finding
survived refutation, not that the change is worth making — those come apart
exactly when the refuter confirms behavior-equivalence and simultaneously
falsifies the finding's *reason*. In the #404 case the stated house-style premise
was measurably false (six other non-test lines used the pattern it called
un-idiomatic, and the finding's own grep hit a seventh it omitted) and the stated
cost was understated. Behavior-neutral plus a false rationale is a defer, however
clean the verdict reads.

**When YOU extend a finding to sibling sites, the extension needs its own
per-site measurement — being right about the sites does not make you right about
the remedy.** A verified finding covers the sites its refuters measured; a
controller that widens it to every sibling spelling is making a *new* claim about
each added site, and that claim is as unverified as any `suggested_fix`.
Measured: on PR #764 a `survived` 2-0 finding was extended from one site to five
— all five genuinely carried the false claim, so the extension was right — but
the prescribed replacement reason ("the asserts below must stat through the
restored path") was **false at one of the five**, whose case asserts a value
`for-each-ref` answers without searching the chmodded directory. Only a per-site
mutation separated them: deleting all five restores at once reddened **four**,
not five. Writing the prescribed reason at the fifth would have minted a new
false claim on the correction PR that existed to remove one. So hand the
extension over as *sites to fix*, and require the fix-applier to measure each
site's reason rather than copying a shared one.

**Where `testCmd` comes from:** the repo's own test command, the one you hand
specialists per **Give specialists a stack-free test command** above — in this
repo `node --test skills/fleet/scripts/*.test.mjs`. Pass the same string to the
workflow and to the fix-applier so both gates run one command. Omit it from the
workflow args and `review-pr.js` now DERIVES it from the repo under review
(#142) instead of defaulting to a fixed string — refusing outright if it
can't; the fix-applier has no such fallback, so substituting `<testCmd>` with
nothing leaves it no gate at all.

> You are ALREADY in worktree `<abs-path>`. Do NOT create another worktree. The
> review is done and these findings are its output — do not re-review, do not
> dispatch specialists.
>
> Read `~/.claude/skills/fleet/commands/review-and-fix.md` and run **steps 2, 3
> and 5 only**: split apply-now/defer, commit, push, file every deferral as its
> own issue with the label the finding's state calls for. Skip step 1 — the
> review already ran — and steps 4 and 6: the controller owns the CI wait and
> dispatches the finisher.
>
> **Apply `survived` findings. A finding in `unverified` whose refuters ran and
> crashed always defers** — at `critical` that means every one of them died.
> Severity records how much a finding would matter if true, never whether
> anything looked. **A `suggestion` is also in `unverified`, for a different
> reason — the workflow budgets it 0 refuters by policy — and the rule below,
> not this one, covers it.**
>
> **A `suggestion` is budgeted 0 refuters, so it is unchecked until you check
> it.** For each one, first decide scope: is it inside the scope of the PR's own
> ticket, or a different piece of work? **Out of scope → defer and file, never
> apply.** **In scope → dispatch ONE refuter** against the finding before
> touching the tree, biased to refuse:
>
> > Try to REFUTE this finding. Default to refuted=true if uncertain. Verify by
> > RUNNING something — compile it, run the test, apply the mutation. Do not
> > reason your way to agreement. Everything you write — mutants, fixtures,
> > scratch repos — goes under `<scratch>/pr<N>/<finding>/` and nowhere else;
> > the checkout and any worktree are never write targets, though
> > `git show`/`git archive` at a pinned ref read fine anywhere. Chain the
> > directory change into the command, `cd "$D" && git …`, never
> > `cd "$D"; git …`, so a failed `cd` cannot leave a `git` command running in
> > the checkout — and bracket a fixture's own git with
> > `git rev-parse --show-toplevel`: before `git init` it must NOT resolve to
> > the repository, and a fresh scratch dir's `fatal: not a git repository`
> > (exit 128) is the pass, not a failure; before any `git commit` it must
> > equal your scratch path.
>
> Survives → apply it, with one hold: if its refuter reports a blast radius
> touching lines another finding also changes, report that to the controller and
> wait for a ruling before applying — only the controller holds every finding, so
> only it can see that the two cannot both land. Refuted → defer and file it, and
> say the refutation in the issue body. **Apply only what survives — no report is not a survival.** A
> refuter you never hear from leaves the finding exactly as unchecked as it
> arrived, so it defers like a refuted one.
>
> **A finding's `suggested_fix` is a hypothesis, not a patch — the review never
> ran it.** Only the claim is verified adversarially; the remedy text is unchecked.
> Three were wrong as written in one run: a stated end state that dropped a
> load-bearing option and measured RED, an assertion against a property the test
> helper does not expose (`TypeError`), and an enumeration that stopped short of
> two further stale clauses — one of them false in the *dangerous* direction. Run
> the remedy before you commit it, and re-derive an assertion from the post-fix
> tree rather than from the finding, since a sibling finding may edit the very
> text it asserts on.
>
> **Retrieve that report yourself; do not wait to be handed it — this covers the
> refuters YOU dispatch, and only those.** The review's own specialists do leave
> transcripts, but nothing gives you their address: the workflow had `agent()`
> return their findings into the script, so what you are handed names no file, and
> nothing on disk indexes a transcript by PR or dimension. Asking for their paths
> gets you nothing; ask for the text. A report from a refuter you spawned is
> different — it surfaces to the controller rather than to you, and waiting for a
> relay that never comes strands the finding. Its transcript is at the output file
> named in your spawn result, and its report is the last record:
>
> ```
> tail -1 <output-file> | jq -r '.message.content[]?|select(.type=="text").text'
> ```
>
> **Never read the whole file** — it is the full JSONL transcript and will
> overflow your context. **Pinging is not retrieval and never becomes one:**
> `SendMessage` to a finished subagent returns `had no active task; resumed from
> transcript` without the report (~15 pinged in one run, 0 retrieved). If the file
> yields nothing, ask the controller by name. Only when neither works is the
> finding **unchecked** — defer and file it, and say so in the body. This is
> `review-and-fix.md`'s **Specialists** rule; it reaches you here because the
> steps that point at it are the ones you skip.
>
> The CI facts in that file apply to you — a `rebase-check` red, or heavy jobs
> `skipped` off a non-zero behind-count, is staleness and not a failure. Never
> rebase to clear it.
>
> **Run `<testCmd>` from the worktree before committing**, copied verbatim.
> `tests 0` is a FAILED run, not a pass. Red or zero-test → fix it, or move that
> finding to defer; never commit over it. **Never `--no-verify`** — a failing
> hook is a finding you report, not an obstacle you route around. Report the test
> result with your SHA. Nothing re-reviews this commit: the review ran against a
> snapshot cut before your edits existed, and a refuter checked the finding's
> claim, never your patch.
>
> **A test you ADD must kill its own mutant** — break what it pins, confirm it and
> only it goes red, restore. **Then a change it should *not* catch, staying
> green** — else you proved it fails, not that it discriminates: a pin asserting
> whole-file text clears "it and only it goes red" and still reddens on any edit
> (measured). A green suite says nothing about a new test: one pin this run
> survived the exact mutation it was named for.
>
> **Commit BEFORE you mutate, and restore with `cp`, never a git discard.**
> `git checkout -- <file>` reverts the whole file, not your mutant — so it also
> eats uncommitted edits you made earlier, and the "clean baseline" you measure
> next is silently the reverted file. Two members hit this in one run; one lost
> prose edits and caught it only because a non-catch control failed. Copy the
> file aside and copy it back. Better still, mutate a copy under
> `<scratch>/pr<N>/mutate/` and leave the worktree untouched — that is what
> refuters are already required to do, and it has no blast radius at all.
>
> **Report LAST, and only once nothing can still change.** A report you have
> sent **pins that SHA** for the controller, which dispatches a finisher against
> it. If a further instruction arrives after you have reported, reply saying the
> SHA is moving *before* you touch the tree again — do not silently do the work
> and re-report. Measured: three members in one run sent a final report and kept
> working; one had its worktree audited mid-mutation, another handed over a SHA
> that was two commits stale, and a finisher dispatched on either would have
> halted on a diverged head.
>
> Then `SendMessage` the controller the pushed SHA, your apply/defer split, and
> the deferral issue numbers, and exit. **Deferring everything is a normal
> outcome, not a stall:** nothing is then staged, `git commit` refuses an empty
> index, `git push` prints `Everything up-to-date`, and you report `no-op, HEAD
> unchanged at <sha>` in place of a new SHA. Say it explicitly — silence there is
> indistinguishable from a member that died. Never manufacture a commit to make
> CI fire.

**Put the standing CI facts in that prompt, not in per-event messages** —
otherwise you send "your red is staleness, do not rebase" once per member per
merge. `review-and-fix.md` states them; the prompt only has to say they apply.

**The fix-applier pushes and exits — it does not hold the CI wait.** You own the
persistent Monitor; a turn-based member re-reading `gh pr checks` each idle cycle
rebuilds a 100k-token context for nothing the Monitor lacks. The prompt block
above carries the report-last rule; you do not have to restate it. When the
diff-validating `check` job is green **and no
heavy job is in `failure`** (the heavy diff-validating suites — not the
`rebase-check` currency gate; a `skipped` heavy job is behind-count staleness and
fine) — or `ci-state.mjs` reads `verdict: "no-ci"`, see below — dispatch a
**finisher** — a fresh small agent, not the fix-applier resumed. **Never dispatch
one while you still owe the fix-applier a ruling**: the pinned SHA is only as good
as the guarantee nothing else is inbound. **The test is your OUTBOX, not the
member's last message** — anything you have decided that it has not received,
including a ruling you have since **withdrawn or reversed**. A withdrawal you
recorded only in the ledger is undelivered: the member still holds the original
and will act on it. Relay everything — reversals too — then dispatch.

**A final report is not proof the member stopped.** Observed twice: a ruling
relayed after dispatch produced a new commit mid-audit, and a fix-applier that
reported "nothing outstanding" resumed on a ledger-only withdrawal and was
cycling mutants through the worktree when the finisher audited it. Both finishers
correctly halted. Note what that costs to detect: two reads of the same worktree
a minute apart showed *different* mutants, so a member's report and any single
`git status` are each valid only at their instant. Its duties, in this order:

1. **Audit the worktree** — `worktree-audit.sh`, or `git status --porcelain` in
   it. Dirty or diverged halts the finisher *here*, before the label: it reports
   what it found and labels nothing. A finisher that verifies the dirt is
   harmless and labels anyway has substituted the rule's purpose for the rule,
   and you find out at merge time. **Give it the two-cause block below,
   verbatim** — a bare SHA mismatch names no cause, and the halt report needs
   one.
2. **Confirm every deferral — and every claimed APPLY — has a home that outlives
   the merge.** The test is a durable home, not a tracker number: a tracker
   issue and a committed in-tree comment both qualify, and for a finding whose
   remedy was measured worse than the defect the in-tree note is the better one.
   What fails is a promise living only in a PR body, or on the PR's *own* source
   issue, which `Closes #N` buries on merge. Caught once at seven findings. A
   comment on an existing *follow-up* issue is filed: that is
   `review-and-fix.md` step 5, not a violation. Not filed → file it or halt,
   never label over it — and file it the way step 5 does, through
   `ledger.mjs check "<subject>"`, never a bare search. The finisher files last,
   off its own read of what the reviewer left behind, so a deferral it reads as
   unfiled may already be on the tracker under someone else's wording.

   **A fix-applier's "applied" is a claim like any other**, and nothing else
   checks it — the review ran against a snapshot cut before those edits existed.
   Confirm `git diff origin/main...HEAD` actually contains what it reported
   applying. Two finishers in one run extended duty 2 this way unprompted, and
   one found five applies where the controller's hand-written list named three:
   a controller's list of what to verify is itself a claim.

   **That range is right for the positive check and wrong for a negative one.**
   It spans the implementer's commits too, so a constraint of the form *file X
   was not touched* has to be scoped to the apply commit. Measured on PR #776:
   a controller wrote "neither document was touched" against
   `origin/main...HEAD` on a two-commit branch whose documents the IMPLEMENTER
   had correctly edited — the PR's whole point — and a finisher reading that
   literally halts a correct PR. It caught the error instead, and said so; do
   not rely on that.
3. Add `ready-to-merge`.
4. `SendMessage` you the label, the deferral issue numbers, and anything it
   halted on — cause and evidence, below, never a bare "head moved".

A halt at step 1 has exactly two causes, reading identical from a bare SHA
mismatch. Give the finisher this verbatim, so it derives the cause itself
instead of asking anyone:

> Worktree differs from your pin, or from what you last read. **Check
> head-equality first: `worktree HEAD == the SHA you were dispatched against` on
> a clean tree settles it.** Against your dispatch pin, never against
> `PR headRefOid`: a member that kept working and pushed after the pin matches
> the branch tip on a clean tree, so a headRefOid comparison reports "settled"
> over commits no reviewer read — the exact divergence this halt exists to
> catch. `headRefOid` is a second, separate read (pushed vs unpushed), never the
> equality the halt turns on. A rebase entry sitting at or behind the pin is
> that head's provenance — the implementer's own pre-push replay — not
> divergence from it, and needs no adjudication at all. Three finishers in one
> run adjudicated a reflog this one check had already answered. Only when the
> head differs from your pin, decide which of two things happened — both cheap,
> both self-checkable:
>
> - **Live editor.** `git status --porcelain` is dirty. Sample `git diff --stat`
>   twice, a minute apart — diffstat growing means someone is still writing.
>   Halt, name `live editor`, report both samples.
> - **Rebase.** `git status --porcelain` is clean, head still differs from your
>   pin. `git reflog` in the worktree: a `reset`/rebase entry near the move, not
>   a plain `commit`, means the branch replayed onto a new base — its own
>   commits on a new parent, content-identical only on a conflict-free replay.
>   Halt, name `rebase`, report the reflog line.
>
> Either cause halts, always — you never verify the dirt is harmless and label
> over it, and a rebase is not a fast-forward you get to accept. Naming the
> cause makes the halt cheap to resolve, never a reason to skip it.

Gate on the `check` job, **not** on `ci-state --quiet` exit 0: a behind PR never
reaches full green, so an exit-0 gate strands it unlabelled. The finisher reads
per-job state (`ci-state.mjs` without `--quiet`, or its `jobs`), since `--quiet`
drops `jobs` and `missing`. Normal path, not only kill-recovery.

**`ci-state.mjs` reads `verdict: "no-ci"`** — no `check` job exists in this repo
to gate on, and that is not a third way to skip the wait. **The
`--declare-no-ci` declaration is caller-side, and reading it back out of the
payload verifies nothing**: the flag is echoed into `reasons` and flips the exit
code, so re-running with it and finding it there confirms only that you passed
it. Passing it yourself is not a second opinion. Check the two facts it stands
for instead:

1. `ci-state.mjs` **without** the flag still reads `verdict: "no-ci"`. A repo
   whose CI is merely misconfigured — workflow files present under other names,
   or `.github/workflows/` unreadable — exits 2 there rather than reading no-ci,
   so this is the check that separates real absence from misconfiguration, the
   case that must never ship silently.
2. The reviewer's own final verdict reports a green `testCmd` run on the SHA it
   pushed. `review-and-fix.md` step 3 requires it to, and that run is the only
   gate this repo actually has.

Both → add the label, and say it rests on the reviewer's suite run, not on CI.
Either missing → halt here, same as a dirty worktree: report `no CI configured,
no verified suite run on record` and add no label.

**Correction tickets ship new wrong claims — inherited from the ticket, and
minted in prose the ticket never asked for.** Put the check on the
**implementer**, not only the reviewer: every factual claim the diff restates
must have a settling command run against the tree first — the issue body is a
lead, never a citation — and the diff must **match the ticket's stated size**,
since added prose is where minted claims enter. No positional references (`the
closing/second/last X`); name the thing semantically. Evidence from a run on
**another repo** is cited by host: a github.com source as `owner/repo#N`;
anything else (GHE, GitLab, internal) as prose naming host and repo and saying
it cannot be settled from this repo — a bare `#N` stays bare only for this
repo's own issues and PRs. The workflow's `comments`
dimension checks every added assertion against the tree, including comments in
files the diff does not touch; a fallback reviewer has to be told that *and* told
to read each corrected sentence literally, clause by clause.
See references/correction-tickets.md.

**But the discipline follows the DIFF, not the class — hand it to any
implementer whose diff writes prose.** Phase 2 selects it on `class=correction`,
and that selection is too narrow: a `routine` ticket that adds a test fixture, a
helper, or a coverage case writes comment prose too, and prose is where minted
claims live. Measured twice in one run, both `class=routine`, both therefore
dispatched WITHOUT this block: PR #756 added an unasked-for comment asserting a
silent-failure mode that does not exist (gross PATH damage is loud — 10 of 39
tests red), and PR #768 minted a false comparative ("the cheapest of the four to
tear down, not the dearest", when its route is the only one of four needing any
in-body teardown) **and** introduced two positional references replacing a
name-based one. Neither ticket asked for either sentence.

Two of the rules above are what caught both, so give them to every implementer
regardless of class: **every factual claim the diff restates needs a settling
command first**, and **no positional references**. A third earns its place here
— **never write a COUNT or a tally into prose; state the property instead.** A
count is false the moment the next commit lands, and #768 falsified two of them
(`the only other chmodSync(..., 0o644)`, already off by one before it; `fails 75
of the 85 cases`, measured 81 of 91) in a file whose own header records having
shipped a stale count once already.

#### Fallback: hand-dispatched reviewer member (no `Workflow` tool)

Only where the workflow is unavailable **or has failed** — never a preference.
"Unavailable" is `ToolSearch` not finding it; "failed" is the throw or empty
return above, surviving one retry. A workflow that is present and throwing is not
absent, and reading this line as absence-only leaves the likeliest failure with no
sanctioned path at all. One named member per PR, `review-pr-<pr#>`, never its
implementer. Give it the PR number and tell it to read
`~/.claude/skills/fleet/commands/review-and-fix.md` — the file
path, not a slash invocation; command availability inside a member is not
guaranteed the way skill availability is. It then does the fix-applier's job too:
apply, defer, file, push, report, exit.

**Authorize the fan-out explicitly.** State that the full specialist set IS the
requested work — otherwise the reviewer inherits the standing "do not call the
AgentTool unless requested" and silently downgrades to a thinner solo review.
Nothing computes the count here, so apply the heuristic yourself: two or three
specialists for annotation-only or single-file, the full set for production code.
See references/member-lifecycle.md.

**Delivering specialist reports is your duty on this path, not the reviewer's.**
Reports surface to *you* and grandchildren are unaddressable, so a reviewer must
never be told to ping for one. But it **can** read the report itself: a specialist
it spawned writes its transcript to the output file named in its spawn result, and
`tail -1 <file> | jq -r '.message.content[]?|select(.type=="text").text'`
extracts the final report — bounded, unlike reading the whole file. State that in
the prompt: retrieve first, ask you by name only if the file yields nothing, and
rule a dimension **unrun** only when neither works — not silently, and not after
waiting forever, since a killed specialist never reports and never gets relayed.
See references/member-lifecycle.md.

So two obligations enter the event loop for as long as a hand-dispatched reviewer
is live:

- **A specialist report lands** (a task-notification from a grandchild you never
  dispatched) → **relay it to the reviewer that owns the PR — source named, text
  included.** Relay anyway even though the reviewer can retrieve it itself — a
  duplicate costs nothing, a missed report costs a verdict. Telling it to ping the
  specialist still returns `had no active task; resumed from transcript` and
  delivers nothing.
- **A reviewer's verdict claims a dimension went undelivered** → reconcile it
  against your relay receipts before accepting it. Receipts say relayed → re-send
  naming the specialist and hold that verdict until it lands; a relay can arrive
  after a verdict is already composed. Only you hold the msg id, so only you can
  catch this — the reviewer cannot tell "no report exists" from "one was sent that
  I have not received". One reviewer ruled a relayed dimension "not covered by a
  specialist" and shipped a headline claim that report refuted.

Neither belongs in a workflow-path prompt: there `agent()` returns into the
script, no relay ever occurs, and a rule to wait for one strands every finding.

**Same receipts gate the finisher dispatch** — dispatch only once every
specialist report you know landed for this PR is relayed, none unrelayed. The
reviewer applies findings and pushes as each relay lands, so an
unrelayed report is exactly as inbound as a fix-applier ruling you haven't sent
(above) — dispatch past it and you pin a SHA the reviewer is about to move past.
Necessary, not sufficient — a reviewer re-reading its own inbox late still moves
the head, which is what the two-cause halt block above is for.
Vacuous on the workflow path: `agent()` already returned every report before
you had a tree to dispatch a finisher against, so nothing is ever outstanding
there.

### Merge bot

Per wave, named `merge-bot-<wave#>`, never two at once. Tell it to read
`~/.claude/skills/fleet/commands/run-merge-bot.md`, run **one** pass, then
`SendMessage` you what it merged and what it held, then exit — and say that
you dispatched it, which is what makes it skip its own watcher step.

**Put both gate traps in the bot's brief, not in a follow-up message.** A bot
already looping cannot be corrected — the loop consumes the turns a correction
would land in. Both are measured, and they fail in opposite directions:

- **`ci-state --quiet` is unsatisfiable-FALSE.** It drops `jobs` and `missing`,
  so a gate reading per-job state from it can never be satisfied. One bot polled
  ~2000 REST calls over 15 minutes on a PR that was green throughout, and had to
  be killed. It does not look like a bug; it looks like patience.
- **`$?`/`PIPESTATUS` is unconditionally-TRUE in zsh.** zsh has no `PIPESTATUS`
  (its array is lowercase `pipestatus`, 1-indexed), so `${PIPESTATUS[0]}` is
  always empty and `[ "" -eq 0 ]` passes. A bot's merge gate opened without ever
  reading an exit code.
- **`status` is a READ-ONLY variable in zsh**, an alias for `$?`. So the obvious
  bash idiom for reading the payload — `status=$(jq -r '.status' ci.json)` —
  aborts with `read-only variable: status`. Measured this way it fails safe (a
  hard abort, no merge), but the same assignment inside an `if`, or with stderr
  suppressed, reads as a check that silently did not run. Same root cause as the
  `PIPESTATUS` trap above, opposite failure direction — so name the variable
  anything else (`ci_status`).

So **gate on the payload's own fields** — `verdict`, `behind`, `missing`, the
per-job conclusions, and `prHead == runHeadSha` — read with `jq` from an
**unpiped** `ci-state` with stdout redirected and stderr dropped. Never fold
`2>&1` into the payload: `ci-state` traces every `gh` call to stderr and it
breaks the parse. Ask the bot **which fields its gate actually read**; a bot that
cannot answer has not got one. Prefer ONE blocking `gh run watch` to a poll loop
(three waves measured 20-377 core each, against ~2000 for the poll loop) and treat its return as permission to look, never as
the verdict.

**An empty payload reads as a block, not a pass** — the safe direction, but still
a false one. A bot that ran `ci-state` from outside the repo got `fatal: not a
git repository`, an empty payload, and a gate that refused a mergeable PR.

**You own the watcher, not the bot.** A dying member takes a watcher down with it
and the queue stops silently. Arm one yourself, `persistent: true`, seeded before
the loop so handled PRs do not re-fire.

**Every merge invalidates every other open PR, silently.** The rest show *stale
green* until something re-triggers, then flip to `rebase-check: FAILURE` with the
slow jobs skipped. Behind-count is the only honest signal.
See references/ci-and-staleness.md.

**One rebase per PR, at merge time.** The bot establishes currency once, when the
PR is the merge candidate; requiring it earlier costs a full CI cycle per sibling
merge. At 6+ open PRs batch a wave rather than merging singles. Any behind-count
you hand a bot is expired on arrival; say so. See references/ci-and-staleness.md.

`run-merge-bot.md` carries the mechanics — intra-wave re-checks, run-binding, the
ancestry proof, post-rebase red triage. Do not restate them here.

### Reap after every wave

A merge deletes the remote branch and leaves the local branch `[gone]` with its
worktree — and its `node_modules` — still on disk. Reap after **each** wave, not
once at the end: a stale worktree still answers `git worktree list`, so phase 0's
in-flight probe reads an already-merged ticket as taken and the queue quietly
shrinks. See references/reaping.md.

`~/.claude/skills/fleet/scripts/reap.sh --apply` recomputes every precondition
inside the same invocation as the delete — `for-each-ref` for `[gone]`, `git
cherry origin/main` to authorize `-D`, worktree removal without `--force` — and
reports reaped and kept-with-reason counts. Update the reaped tickets' ledger rows
in the same step. See references/reaping.md.

**Do not invoke `commit-commands:clean_gone`.** It runs `git branch -D` and
`git worktree remove --force` with no merged check at all — nothing there stops it
deleting a branch, or discarding a member's uncommitted work, that exists nowhere
else. The skill is the maintainer's to fix; do the reap yourself.
See references/reaping.md.

**Never reap a branch a live member is on.** Cross-check `.fleet/ledger.md` first:
a row without a terminal state means someone may still be in that worktree, and
the dirty check does not see a member that committed but has not pushed.
See references/reaping.md.

### Release the claims that never became PRs — at end of run, and on drain

Phase 1 is serial and runs ahead of dispatch, so a ticket can be legitimately
claimed and then never sent: a collision surfaces after the claim, the maintainer
says drain, the pool is re-prioritised. The claim still holds the `in-progress`
label, a worktree and a branch, and **`reap.sh` will not take them** — the branch
is not `[gone]` and has no unique commits, so it is correctly not reapable. Reaping
fires per merge wave and nothing fires at end of run, so the claim survives it and
phase 0's in-flight probe reads a free ticket as taken next run. Same silent queue
shrink as a stale merged worktree, from the opposite end.

`~/.claude/skills/fleet/scripts/release-ticket.sh <N> <slug> <type> --apply` is the
inverse of the claim, and recomputes its preconditions inside the same
invocation as the delete: 0 commits ahead of `origin/main`, no unique commits
(`git cherry`), no branch on `origin`, and — whenever the worktree directory is
there to read — a clean worktree. Where that directory is established absent the
dirty check does not run at all, and `git worktree remove` is no backstop for it:
it gates its own clean check on the same `stat`, so the script's absence
measurement is sole arbiter there. All clear → drops the label,
removes the worktree without `--force`, deletes the branch with `-d`. Any one of
them failing → it touches nothing and names the blocker. **That refusal is the
finding, never an obstacle**: a claim carrying commits or a pushed branch is not
auto-released, ever — audit it with `worktree-audit.sh` and decide by hand.

Run it over every pool ticket with no PR when the run ends or the maintainer
drains, and on the spot for a claim abandoned mid-run (a bail before
implementing, a collision found after the claim). Update the released tickets'
ledger rows in the same step. See references/reaping.md.

## Queue depth

- **pool** — approved, not yet dispatched
- **supply** — open `ready-for-agent` surviving in-flight scan and the decided?
  check. A queue of undecided tickets is zero supply.
- **review backlog** — PRs verified and queued with no reviewer slot.
  `fleet-tick.mjs` counts every open PR without `ready-to-merge`, which is that
  plus the ones already under review or waiting on CI. The wider read, because
  narrowing it needs per-PR review state that lives in your head and not in the
  repo — so it can hold the refill earlier than the definition above, never
  later.

**Reviews are the bottleneck, not tickets.** Implementation runs 4-15 min; review
runs 20-40, because each fans out up to six specialists. On the default path
**you** run each review, one at a time, so reviews serialize on your own turn and
the reviewer cap buys no review parallelism at all — those slots hold
fix-appliers, which do the cheap half (apply, commit, push, file). Five
implementers still saturate the pipeline within the hour and every later PR
queues; the queue now forms ahead of the workflow rather than ahead of a slot.
Absent instruction, default **2 implementers / 5 reviewers** and say why.

**The refill gate is the *review* backlog — never the merge-queue depth.** Backlog
≥ 2 → stop refilling implementer slots even with pool left; more PRs into a
review-bound pipeline buys nothing. But a deep `ready-to-merge` queue is *not* that
signal. Each PR rebases exactly once, when it becomes the candidate, so producing
more PRs adds no rebases-per-PR — it changes only *when* a given PR is ready.
(Deeper waves do cost: the last PR in one pays the largest rebase and the longest CI
cycle. That is an argument for batching a wave, never for idling an implementer.)

**Reconcile, do not wait for an event.** "A slot is free and the pool is non-empty"
is a *level* condition — re-derive the deficit on **every** tick, whatever woke you:
a member finishing, a member bailing before implementing, a merge landing. An
edge-triggered loop that only refills on completion stalls silently the moment the
queue empties, because 0 implementers emit no completion event. With pool 0 the
table below governs — re-shortlist and ask, do not dispatch un-ticked supply.

**Do not re-derive this by hand — `fleet-tick.mjs` computes it.** One invocation
prints per-role `actual/target` and an explicit ACTION with the backlog gate
above and every row of the table below already applied; the merge-side edges in
Phase 3 name the flags. The deficit is then *computed, not remembered*, which is
the whole point: a table you must remember to consult is one you will not
consult under a merge-side event storm, and that is how implementers reached
0/target with pool 1 and ~57 `ready-for-agent` in supply while nobody noticed
(#3). What follows stays here as the explanation of what the script decides —
never as a second, hand-run copy of it.

| pool | supply | action |
|---|---|---|
| ≥ 1 | — | dispatch from pool, silent — *unless* review backlog ≥ 2 |
| 0 | ≥ cap | re-shortlist, ask the maintainer to tick |
| 0 | 0 < supply < cap | re-shortlist **and** suggest `/triage` |
| 0 | 0 | suggest `/triage`, hold implementer slots idle |

The backlog gate outranks all four rows: at backlog ≥ 2 the answer is hold, and
re-shortlisting to enable a dispatch you are holding buys nothing.

`/triage` is user-invoked only — suggest, never run. The suggestion is a report,
not a blocking prompt. Counts come from cheap `gh issue list --search`, no bodies.
A starved implementer queue never stalls the review or merge side.

## Invariants

- ≤ 5 implementers, ≤ 5 reviewers, ≤ 1 merge bot. Bounds *members*, not live
  agents — members fan out and their children consume slots you never dispatched.
- A grandchild surfaces as its own task-notification. An unrecognized task-id is
  not a member reporting done.
- A reviewer never reviews a PR it implemented.
- The merge bot only touches PRs whose implementer reported done. Rebasing a
  worktree someone is working in destroys uncommitted work.
- `ready-to-merge` is added by a reviewer only — never an implementer, never you.
- **Every member acts through the maintainer's `gh` credentials, so no write is
  attributable.** Any invariant about *who* did something is unenforceable after
  the fact: when a label moves unexpectedly, ask members directly, rule out
  automation with `grep -rn '<label>' .github/workflows/`, and do not re-add it.
- Phase 1 is serial. Everything else may run concurrently.

## Guards

**Verify every reported SHA.** `~/.claude/skills/fleet/scripts/verify-sha.sh
<branch> <sha>` before enqueueing — a member can commit in a nested worktree,
leaving the SHA on a stray branch while its report reads normally. Not reachable →
flag, do not enqueue, do not return the ticket to the pool until the maintainer
rules.

**Never `--delete-branch`.** It errors on a `main` held by another worktree, or
strands the feature worktree on `main`. `gh pr merge <n> --merge` alone; GitHub
deletes the remote branch anyway.

**Never force a rebase to start.** No `git clean`, `git checkout .`,
`git reset --hard`, `git stash`. Uncommitted changes may exist nowhere else.
Non-empty `git status --porcelain` → stop and report — stashing empties it, so
that check and `no-undo-audit.sh` both go quiet on work nothing else holds.

**Cross-check what members report about their environment.** Wrong often enough
to matter, and a confident wrong report from a reviewer flips a verdict.

**Distrust negative claims hardest.** "Nothing else references this", "the sweep
is clean" — most likely false, least likely checked: a grep that found nothing
looks like a grep never run. Make members state their search scope. Negative claim
vs specific finding with paths → paths win.

**Members share one filesystem and one docker stack**, and the failures arrive as
*wrong findings*, not errors:

- **Specialist tree isolation is `review-and-fix.md`'s job — do not restate it.**
  It owns the object-store rule, the two-tree split, snapshot provisioning, and
  which suites a snapshot cannot validly run. Your only duty is to *not*
  contradict it.
- **Filesystem isolation is not stack isolation.** A private copy of the tree and
  a test command solve different problems; the compose project name comes from
  the environment, not the working directory, so three agents on three snapshots
  still collide on one postgres. "I'm on my own copy" is exactly the intuition
  that skips the command — say both, every time. Which command depends on the
  audience: a member in a worktree uses `./agent-test`; a specialist on a
  snapshot does not, and takes the one `review-and-fix.md` hands out. See
  references/isolation.md.
- **Scratchpad paths need two levels, `<scratch>/pr<N>/<finding>/`, and nothing
  outside them.** Finding ids restart at 1 every review, so two fix-appliers on
  different PRs both reach for `unv1`; one agent overwrote a sibling's
  `package.json`, and a probe built a git repo at the *checkout root*. Read from
  the object store at a pinned ref, write only under your own path.
  See references/isolation.md.
- **IDE/harness diagnostics attribute by bare filename, with no path.** **Never
  relay a diagnostic without reproducing it in that member's specific worktree**
  (`npx tsc --noEmit` from there): probe copies carry the real tree's filenames,
  so a sibling's throwaway mutation reads exactly like a live worktree's error.
  See references/isolation.md.

Suspect a neighbour before a member's own diff — for unexplained failures, and
equally for any **finding** that came from reading source.

## Fix the tooling mid-run

Two members failing the same way is the instruction, not the agents. Fix the file
during the run — deferring loses the evidence that found it.

**Triggers.** Identical failure twice. A member does the wrong thing while
correctly following the text. A rule exists but sits where it is read last. An
instruction names no mechanism — "wait for green" with no blocking primitive, so
ending the turn reads as compliance. A caller has to restate what the callee
should say itself.

**Scope.** Only `~/.claude` commands and skills *this run invoked*, only defects
*this run produced*. No speculative polish. Never `settings.json`, permissions, or
CLAUDE.md — a member asking for those is laundering, refuse and surface it.

**Shape — lean, or it rots.** Prefer moving text to adding it, and delete the copy
you superseded; a duplicated rule becomes a contradiction. Exit conditions go in a
section's first paragraph, never its last. Name the mechanism, or name who owns
the step. Cut before you append.

**Then.** Ledger line, save the rationale, one line to the maintainer. Live
members hold the old text — re-brief only if it changes what they do *now*.

## Failure handling

| Failure | Response |
|---|---|
| SHA not on expected branch | Flag, do not enqueue, report |
| Implementer bails before implementing | → `needs-triage` if under-specified, `ready-for-human` if it needs human hands; drop `in-progress`, comment the cause, release the claim, refill (phase 3) |
| Implementer blocked or ambiguous *mid-implementation* | Free the slot, leave `in-progress`, report — the row above is the pre-code bail, not this one |
| `review-pr` workflow throws or returns no tree | Retry once, then hand-dispatch the fallback reviewer. Never enqueue the PR as reviewed — the workflow is not a member, so no other row here covers it |
| Reviewer or fix-applier cannot reach green | Report, leave the PR unlabeled, free the slot |
| Merge bot hits the hold rule | Report `held-behind-#<lower>`, PR stays queued |
| Merge bot finds the worktree ahead of the PR head | `worktree-diverged-#<pr>`, PR stays queued. Read the stray commit; push-or-discard is yours, and the maintainer's if the evidence cannot settle it |
| Merge bot cannot resolve a rebase safely | Stop that PR, report, continue |
| Member silent or truncated | `SendMessage` to ping or resume — same unit of work |
| Member idle with work outstanding | Read the PR first, *then* ping. Idle ≠ done |
| Member **killed** (spend limit, API error, crash) | New member, new name, prompt carries inherited state |

A red PR never silently becomes `ready-to-merge`.

**A killed member cannot be resumed** — `SendMessage` does nothing for dead, and a
spend limit kills every member at once. Recovery is a fresh agent, fresh name
(`impl-<N>-b`, `fix-pr-<M>-b`, `review-pr-<M>-b`) whose prompt states what it inherits;
reviewers that went idle on CI recover as a **finisher, not a re-review** once
commits are pushed. See references/member-lifecycle.md.

Audit every worktree before dispatching replacements with
`~/.claude/skills/fleet/scripts/worktree-audit.sh` — it reports each worktree's
ahead-count and uncommitted files, the committed-vs-uncommitted distinction that
decides whether a replacement redoes or destroys work.

## Run ledger

One git-ignored `.fleet/ledger.md`, updated at **every** state change via
`~/.claude/skills/fleet/scripts/ledger.mjs` subcommands (`row`, `filed`, `ruled`,
`check`, `read`). Your context is the least durable thing in the run: it compacts,
and a controller that loses the pool, the dispatch map or the filed list redoes
finished work. Two duplicate tickets shipped in one run from exactly that.

One line per ticket, rewritten in place (`ledger.mjs row <ticket> <text>`):

```
#332 impl-332 → PR#344 → MERGED 73b356de
#324 impl-324 → PR#346 · fix-pr-346 · ports=16324 · ruled:6-applies · held-behind:#313
```

Plus two append-only lists:

- **filed** (`ledger.mjs filed <issue> <subject>`, checked with `ledger.mjs check
  <subject>` before every `gh issue create`) — so a finding already recorded
  this run is not filed twice. That is not a guarantee against duplicates at
  large; the tracker query below is what covers those.
- **ruled** (`ledger.mjs ruled <pr> <decision>`) — PR + decision + one-line reason,
  so a replacement controller does not re-litigate a settled call.

`check` exits **0** clean, **1** already in this run's filed list, **2** usage
error (no JSON on stdout), **3** the ledger is clean but open or closed tracker issues match — read
those and decide. It also prints the closest filed rows with an overlap score;
those are advisory and do not change the exit code, because the same finding
gets worded differently by whoever finds it second. **Exit 0 is not
automatically "safe to file":** when `gh` cannot be reached the answer is
ledger-only, and it says `TRACKER NOT CHECKED` — an issue filed by an earlier
run is invisible to it. The stdout JSON names that distinction in one field:
`verdict` is `already-filed`, `tracker-hit`, `clean` or `unverified`. The last
two both exit 0, so `verdict` is the only thing that tells a searched-and-clean
tracker from one that was never read.

**Write the ledger line before dispatching, not after.** A member that dies
between spawn and write is invisible — and members die in batches.

## Report

One running table, updated as events land:

```
#N  ticket   impl-<N>       PR #M  fix-pr-<M>      label:yes  merged
#N  ticket   impl-<N>       PR #M  fix-pr-<M>      label:no   -        red CI
#N  ticket   impl-<N>       -      -               -          -        blocked: SHA off-branch
```

Plus a queue-depth line: pool, supply, whether triage was suggested.

## Red flags

- "Fork the controller so the member has context" → fork inherits everything.
- "This member finished, send it the next ticket" → resumes its transcript.
- "The name is cosmetic" → the name carries the `Agent` tool.
- "Name the specialists too" → members cannot name children.
- "ready-for-agent came back empty, widen to ready-for-human" → empty means no work.
- "The reap at the end will pick up the claim I never dispatched" → it declines:
  not `[gone]`, no unique commits. Release it, or it reads as taken next run.
- "Touches eight files, too big for the fleet" → size is not the axis. Decided is.
- "Body is three lines, so it's simple" → short bodies hide open design choices.
- "The brief is thorough, so it's decided" → thorough ≠ decided. Read it for the
  choice it leaves open.
- "I'd have to pick an approach myself" → that IS undecided.
- "The reviewer has the Agent tool, it'll fan out" → not unless authorized.
- "Tell the reviewer to ping its specialists" (fallback path) → the ping returns
  `had no active task; resumed from transcript` and delivers nothing. Tell it to
  read the specialist's output file instead; your relay is the backup, not the
  only path.
- "I relayed it, so the reviewer has it" (fallback path) → sent is not read, and a relay can land
  after the verdict is composed. Two reviewers ruled relayed dimensions
  undelivered, one of them shipping a headline claim the report it disclaimed
  refuted. Reconcile verdicts against your receipts.
- "It reported the SHA, so it's on the branch" → verify.
- "Let the merge bot arm its own monitor" → it dies, the queue stops.
- "The member died, SendMessage it the state" → dead agents do not read mail.
- "Its CI is green, ship it" → check behind-count; green decays invisibly.
- "The specialist says nothing else references it" → the claim most often wrong.
  Ask what scope it searched.
- "Five implementers = five times throughput" → reviews are 3-5x longer. It means
  a backlog.
- "`npm install` to set up the worktree" → the wrong install mutates the lockfile
  for the whole repo.
- "I'm on my own copy, so I'm isolated" → not from the docker stack.
- "`commit-commands:clean_gone` printed nothing, the tree is clean" → its
  `[gone]` detection works fine; it just runs `-D`/`--force` with no merged
  check, so "printed nothing" only means nothing was gone yet, not that it's safe.
- "`--force` the worktree removal, the PR merged anyway" → merged says nothing
  about uncommitted files, and the reviewer may still be in there.
- "Reap once at the end of the run" → stale worktrees make phase 0 read merged
  tickets as taken, so the starvation compounds every wave.
