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

**But a missing report is NOT evidence the member failed to send one — the
inbound direction drops AND delays messages.** Both were measured in one run,
and they are indistinguishable at the moment you look: one finisher's report was
accepted with a msg_id and never arrived at all, while another's arrived late —
its original and its re-send landing together, after the controller had already
concluded it was missing. Measured: a finisher completed every
duty, labelled the PR, and sent its report; the send was accepted with a msg_id
and never arrived. The controller read the silence as the member ending its turn
without reporting, said so, and was wrong. The re-send it asked for by name is
the only reason the report exists. So when a report is missing, **ask by name —
that is what the "unless the controller asks by name" clause is for — and do not
attribute the gap to the member until it answers.** A member re-sending on a
named request should state the original's msg_id and that it is a re-send, which
is what distinguishes a lost message from a member that never sent one; a
controller that skips the ask cannot tell those apart and will guess wrong in
whichever direction its expectations point.

Note this cuts against the paragraph above only in appearance: the default stays
*send once*, because unprompted re-sends were measured 2-to-1 false. The ask is
the controller's move, not the member's.

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
`review-pr-<pr#>`, `finisher-pr-<pr#>`, `merge-bot-<wave#>`. See
references/member-lifecycle.md.

**Inverts one level down: members must name their children `undefined`.** A named
member passing a `name` fails with `teammates cannot spawn teammates`, so
specialists are dispatched **unnamed**. Say so in a fallback reviewer's prompt, or
it silently downgrades to a solo review. See references/member-lifecycle.md.

**Fresh context per member.** One member, one unit of work, gone. Never
`subagent_type: "fork"` (inherits your whole conversation). Never re-task a
finished member — waking it drags the old ticket back in. Refill = **new**
member, **new** name. Sending is still right for pinging a live member for a
report it owes, or resuming a truncated reply — never for handing a finished
member the next ticket.

CLAUDE: `SendMessage` to a finished agent resumes its transcript and drags the old ticket in — the wake this contract forbids for a refill.
OMP: `hub send` to an idle peer wakes it into its old transcript the same way; re-dispatching under the same name does not reset it — omp auto-suffixes a fresh peer (`name-2`) instead.

See references/member-lifecycle.md.

**You read your instruments out of a tree every member can write to — re-check
them before every gate decision.** Per-member worktrees and `./agent-test`'s port
derivation protect members from each other; neither protects the main checkout,
which you run every gate probe out of and which any member can edit. Measured: a
member edited two files there instead of in its worktree while the CI monitor was
polling one of them every 120s and a live finisher was using it to decide a
label. It caught itself; nothing in the fleet would have. That is the silent
direction — a modified instrument raises no error, shows in no PR and leaves
nothing in the ledger, and it still returns a verdict, just not necessarily the
right one, so you have no reason to re-check a script you did not know had
changed.

- **Pin once**, at phase 0 step 0 below, from the main checkout you are
  running this from — never from a member's worktree, which is gitignored
  and carries no baseline:
  `~/.fleet/bin/fleet-run instruments.sh --pin`.
- **Re-check before you act on any instrument reading** — a SHA acceptance, a CI
  verdict, the reconcile, a reap, a label gate — from that same main checkout:
  `~/.fleet/bin/fleet-run instruments.sh`. **Exit 0 is the only code that
  lets a gate proceed. Exit 1 (the set changed) and exit 2 (the check could not
  answer) both refuse: report what it printed and do NOT re-read the
  instrument** — a guard that fails open on "could not look" protects nothing.
- **Re-pin only after a change you made deliberately.** The mid-run tooling fix
  below is the one legitimate writer. Re-pinning to clear a refusal you cannot
  explain discards the check.

It covers every tracked file under this repo's own plugin component directories
— `plugin/commands/`, `plugin/scripts/`, `plugin/skills/`, `plugin/agents/`,
`plugin/workflows/` — the probes, the libraries they source, and these runbooks,
which you also read from that tree. Not the whole repo: `docs/metrics/` is
appended by THIS run, so covering it would refuse on the run's own bookkeeping
every time. It does not cover refs, deliberately: `claim-ticket.sh` creates a
branch per ticket and `reap.sh` deletes them in the ref store every worktree
shares, so ordinary work moves refs several times a wave and a per-gate
refusal on that is noise.

**A member runs its test suite in the foreground and blocks on it.**
Backgrounding a suite and polling for it makes the member's own progress
depend on a wake-up nothing in the fleet guarantees, and an idle member is
indistinguishable from a working one — you learn only by pinging. Measured
twice in one run: `fix-pr-1184` backgrounded its suite plus a Monitor and sat
idle for roughly two hours; neither ever woke it, and the only reason no work
was lost is that you pinged it by name with a concrete next action.
`finisher-pr-1184` reached for the same pattern minutes later — a proactive
warning is the only reason it did not repeat the stall. Its
`pgrep -f 'finish-finisher-pr-1184'` could never have matched any process, so
the poll it was waiting on was structurally incapable of firing. Say it in
every dispatch prompt — this file is yours, not theirs, so a member learns
it only if you write it into the prompt.

## Phase 0 — shortlist

At start, and whenever the pool empties.

0. **Once per run, before anything else.**

   **Fast-forward the checkout before you trust these rules — you are reading
   them from it.** `git fetch origin && git rev-list --count main..origin/main`;
   non-zero means the SKILL.md you are executing is superseded, so
   `git merge --ff-only origin/main` and re-read what changed under
   `commands/`, `scripts/` and `skills/`. The usual cause is the PREVIOUS run's own close-out PR: it
   lands the rules THIS run needs and nothing pulls them. Measured twice — 57
   commits stale in one run, 20 in another, the second shipping every dispatch
   prompt without two rules that had merged the day before. Silent by
   construction: stale text reads as authoritative, and the tier guard's own
   floor is re-derived from a stale `tier-outcomes.tsv` at the same time.

   **Pin the instruments, after that fast-forward and before anything reads
   them, from this main checkout.** `~/.fleet/bin/fleet-run instruments.sh --pin`
   records what the scripts and runbooks in this repo say right now, which is
   what every later gate compares against; the rule above says what its exit
   codes mean. Pinning ahead of the fast-forward pins the superseded text and
   certifies it for the rest of the run.

   **Launch the cockpit.** On the first phase-0 pass only:
   `node ~/.fleet/bin/fleet-run board.mjs serve --open &` in the
   background. It is a read-only mirror of `.fleet/ledger.md` + `gh` — you never
   feed or update it, and it survives your own compaction. Skip on later
   re-shortlists (a server is already running; a second one collides on the
   port).

   **Fold in every PR a prior run left open, before shortlisting.** A chore PR
   carrying that run's own metrics, or ticket work whose review was deferred —
   both are reviewable work no member otherwise picks up, because phase 0 scans
   ISSUES and nothing looks at inherited PRs. Queue each for review exactly as
   ticket work: same review workflow, same fix-applier, same finisher. Measured
   2026-09-03 — #1222 arrived this way and its review found a defect its own PR
   body called unreviewed, and #1237's review then caught two metrics rows the
   controller had missed in its own close-out, so a chore PR is not exempt from
   being wrong. Reviewing them next run is also what stops one pinning
   `fleet-tick`'s backlog forever (#590): unreviewable AND uncounted is the state
   that strands it.

1. **Candidate scan** — `~/.fleet/bin/fleet-run candidates.mjs
   --require-label ready-for-agent`. **`--require-label ready-for-agent` mandatory, no
   fallback** — do NOT pass `--allow-fallback`. Empty means no work;
   `ready-for-human` needs a human to brainstorm first and you have no channel to
   one mid-flight.

   **Exit 3 is not that empty queue, and never a reason to widen the net.** It
   says the labeled query returned rows and the to-spec filter took every one:
   what is queued is to-tickets' input rather than claimable tickets, and a
   member handed one implements an entire spec as a single ticket. Log it as
   specs awaiting to-tickets, not as no work — and still do not pass
   `--allow-fallback`, whose second pass is unfiltered and so reaches the
   `ready-for-human` and untriaged work you have no channel for.
2. Dependency scan, `next-ticket` step 2, on the `d` array. Open blocker → drop.
3. **In-flight check** — `~/.fleet/bin/fleet-run inflight.sh <N>` per
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
   answers both questions. Record the ticket's real brief — the `## Agent
   Brief` comment where one exists, otherwise the issue body, which is where
   most tickets actually carry it (a controller probe found only 43/100 open
   `ready-for-agent` issues have a separate Agent Brief comment; the rest,
   this ticket included, carry the brief in the body) — plus its `Out of
   scope` sequencing wherever that section is found. Then judge **decided?**
   — never size.

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

   **`staleness.mjs` runs that check for you, and answers in THREE values.**
   `~/.fleet/bin/fleet-run staleness.mjs --path <path> --gone
   '<string>'`, or `--present '<string>'`, once per claim the ticket makes.
   It goes here and not in the candidate scan because choosing WHICH string
   settles a ticket needs the ticket read, which the step above already did —
   so the cost lands on shortlisted candidates and never on the backlog.
   `--gone` is a defect the fix must remove, the wording the ticket quotes as
   wrong; `--present` is what the fix must add, the assertion a pin ticket asks
   for. Give exactly one — the direction is not inferable from the string, and
   the wrong one answers the opposite verdict with full confidence.

   A needle that itself starts with `--` — #240's `--label ready-for-agent`
   is one this backlog carries — needs the end-of-options separator: `--gone
   -- '<string>'`/`--present -- '<string>'`. Given bare, with no `--`
   immediately before it, the value guard still refuses it — `staleness:
   --gone needs a value` — at exit 2, a could-not-check to offer and annotate,
   not an invocation to retry.

   | Exit | Verdict | What it does to supply |
   |---|---|---|
   | 0 | still reproduces | offer it |
   | 1 | provably fixed | do not offer; close citing the payload's `commit` and `subject` |
   | 2 | could not check | offer it, **and say the probe could not check** |

   The third value is the one that has to survive. A probe that could not look
   answers exactly like a probe that looked and found nothing, so folding it
   into either neighbour retires live supply on a guess in one direction and
   reports a defect as live on a spelling the tree stopped using in the other.
   Exit 2 is also where every guard and every failed git call in that script
   lands, so a probe that breaks keeps the ticket in the queue.

   What it refuses to answer is the point of it. It reads `origin/main` and
   nothing else — never the working tree, never anything on disk — so a path
   this repo does not track is exit 2 rather than a clean read: that is #187's
   case and the generated-artifact case together, `agent-test` being written
   into a claimed worktree by `claim-ticket.sh`'s heredoc, which makes every
   copy under `.worktrees/` a snapshot of whenever that worktree was claimed.
   `fixed` is never read off the string's presence alone either: it carries the
   commit `git log -S` names for that string at that path, reachable from
   `origin/main` by construction since that is where the walk starts. A
   `--gone` string absent from the file that ALSO never changed count there is
   exit 2, not a fix — that is the positive control, and without it a typo in
   the string closes a live ticket.

   It does not run a reproduction. The general "is this still reproducible?"
   oracle over the whole backlog is what #238 ruled out, and a reproduction run
   without a positive and a negative control misattributes causes rather than
   merely missing defects — the #230 check needed a purpose-built fixture plus
   both. A ticket no single string settles is a `could not check`: offered,
   annotated, never quietly dropped.

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

   **This is a consumption gate**, priced for the seat where implementer
   divergence costs a claim, a worktree and a dispatch; the filing-time
   counterpart was repriced to *is the defect confirmed* and states its own bar
   inline — see `docs/adr/0001-filing-label-bar-is-defect-confirmed.md`.

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
   the diff to the ticket's stated size, no positional references, never a
   count in prose, and a settling command re-run and written inline for every
   claim that goes into the commit or PR body), it partitions
   `docs/metrics/tier-outcomes.tsv`, and it is what any future tier
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
   ticking them. Annotate any survivor whose liveness probe came back **could
   not check** with that verdict and the reason its payload gave: this list is
   where the third value has to land, and a survivor presented without it reads
   as one the probe checked and found live. Annotate any survivor the
   `Out of scope` read sequences after
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

`~/.fleet/bin/fleet-run claim-ticket.sh <N> <slug> <type> --apply` does
the label, worktree, branch, frozen install, lockfile-clean assertion, and the
isolation runner in one serial pass. Infer branch/worktree convention from
`git worktree list` and `git branch -r` for the `<slug>`/`<type>` arguments.

**Infer `<install>` — never default to `npm install`.** A lockfile-mutating
install in a throwaway worktree corrupts it for everyone; the script derives the
frozen form from the lockfile and refuses to guess.

**Materialize the isolation envelope as a file, not a briefing.** The runner is
tracked at the repo root since #55, so every checkout has one; it derives its
ports from the worktree's own `<N>-slug` directory name (so collisions stay
impossible) and materializes the current runner from the one emitter rather than
carrying a copy of it. Brief members with `./agent-test
<file-or-dir>` and nothing else — anyone who finds the worktree finds the
runner, including grandchildren you never dispatched. A directory works too and
expands to the test files under it; one holding none refuses rather than passing
vacuously, so a mistyped file or directory path cannot come back green. See
references/isolation.md.

**A reused worktree may lack the runner** — no longer here, and still can
elsewhere. `claim-ticket.sh` used to write `agent-test` only when it claimed a
*fresh* worktree, so a worktree carried over from a prior run, or an already-open
PR's worktree you sent a rebaser/resolver into, had no `./agent-test` and the
member stalled on a missing script (observed with a rebase-resolver in a
prior-run worktree). #55 tracked the runner, so any worktree checked out from
`origin/main` now carries it. A tree that is NOT a checkout — a `git archive`
snapshot, a `cp -R` subset — still has whatever was copied into it, and a repo
that tracks no runner never had one: there, tell the member the runner is absent
and to run docker-free suites directly (`npx vitest run --config
vitest.ci.config.ts <file>` — the CI unit config has no `globalSetup`, so there
is no stack to collide on).

**A reused worktree may also be on the wrong COMMIT.** `git worktree add <path>
<branch>` checks out the existing LOCAL branch and never consults the remote, so
a branch a previous run left behind wins over the rebased `origin/` ref that is
actually the PR. Measured in a scratch repo (git 2.50.1): with the branch rebased
on the remote and a stale local ref standing, `git worktree add <path> <branch>`
checked out the stale commit and printed `HEAD is now at <stale-sha> <subject>` —
the same subject the PR head carries, because a rebase preserves it. Neither
commit was an ancestor of the other, so *behind* is the wrong model; it is a
fork. Every other signal reads normal too: `git worktree list` shows the worktree
present on the expected branch, and the tree is clean. `claim-ticket.sh` never
touches this path — it claims only fresh tickets, and builds those from
`origin/main`.

**The two reuse failures are not symmetric.** A missing runner fails LOUDLY: the
member stalls on a script that is not there. A stale base fails SILENTLY and
produces confident wrong output — a review cut its immutable snapshot at the
stale commit and a fix-applier was dispatched into it, halted only before a push
that would have been a non-fast-forward.

So, when you re-create a worktree for an already-open PR:

- **Create it detached from the remote ref**, never from the bare branch name:
  `git worktree add --detach <path> origin/<branch>`. Same scratch repo, same
  moment: this landed on the remote's commit. It removes the mechanism rather
  than catching it, and leaves no local ref for the next run to inherit.
- **Then verify, and refuse on mismatch.** Compare
  `git -C <path> rev-parse HEAD` against
  `gh pr view <N> --json headRefOid -q .headRefOid`. Unequal → dispatch nothing
  into that worktree, and report it naming BOTH commits, since their subjects
  will not tell them apart.

`review-pr.js` refuses a snapshot whose head is not the PR head, so the workflow
review path is backstopped — except when `gh pr view` returned no head at all,
which skips the compare rather than refusing on it. Its run log names that case:
`PR head (absent): head check SKIPPED`. A worktree you hand to an agent directly
is not. Verify here anyway.

## Phase 2 — dispatch implementers

**Dispatch every implementer as `subagent_type: "fleet-ctl:fleet-implementer"`, and still
omit `model` on the Agent call, whatever the class.** The tier now lives in that
definition's frontmatter (`agents/fleet-implementer.agent.md`), which is what an
omitted `model` takes first — the session's tier applies only when the definition
names none, and a member dispatched with `model` set does not get the declared
tier back. Omitting `model` is therefore still the mechanism; what changed is
that the tier it resolves to is now declared and pinned rather than inherited by
accident. Keep `name: impl-<N>`: the name is what makes a member, and both the
spend classifier and `member-outcomes.mjs` read it.

**After dispatching the batch, run the tier check — a scripted step, never a
prose reminder.** `~/.fleet/bin/fleet-run tier-check.mjs --batch <path-to-batch.json>`
compares what each dispatched member's definition declared against what the
harness actually resolved, and exits 1 naming every mismatched member as
`member: declared <m>/<l> resolved <m>/<l>`. A non-zero exit **stops the
wave**: dispatching the next batch on top of an unresolved tier mismatch
multiplies whatever silently degraded, so fix the definition or the dispatch
and re-run the check before continuing.

**The batch file is a JSON array, one entry per dispatched member:**
`{member, agentFile, harness, ...}` plus exactly one of the three fields
below, in the order the controller should prefer them:
- `resolvedModel` **and** `resolvedThinkingLevel` together (omp only) — the
  dispatch's own job record, when the controller already holds both; no
  file is opened at all. Holding only one of the two does not count: give
  `session` or `transcript` instead so the missing half is read, never
  guessed.
- `session` — a root the controller already knows: the SAME session or
  `subagents/` directory `member-outcomes.mjs`/`board.mjs` are already
  handed for this run. The check finds the named member under it itself
  (member-record.mjs's own readers on Claude; the member's own
  `<session>/<member>.jsonl` file directly on omp, so a member with no
  assistant turn yet still resolves off its dispatch-time record).
- `transcript` — the member's own transcript file, for a caller that
  already holds the exact path.

`agentFile` and `transcript`/`session` resolve relative to `--repo`
(defaults to the plugin's own root). `member` is `impl-<N>` on Claude
(`name:` on the Agent call) and the AgentId on omp — the same value either
harness's own dispatch already returns.

**The declaration names a bare alias (`opus`), never a versioned id.** An alias
tracks the newest generation; a pinned id rots into a superseded one that is
weaker AND more expensive, because pricing falls with each generation.

**One implementer per staged wave goes at the alternate tier — one per phase-0
staging batch, never one per refill.** Dispatch it exactly as the others but
with `subagent_type: "fleet-ctl:fleet-implementer-alt"`. Pick the ticket
that is most ordinary — never the hardest, never the one whose ticket the rest
of the run depends on — and do not tell the member it is a control: a member
that knows it is being measured is not measuring the same thing.

**Count the rate against phase-0 staging, because "wave" is not a dispatch
unit.** An ordinary refill re-enters phase 1 then 2 for a single slot and starts
no new wave — the guard below says it outright, "refill is level-triggered, so
there are no implementer waves" — so a rule counted per refill would put roughly
half the fleet on the alternate tier. Phase 0 *does* re-run mid-run whenever the
pool empties, and each of those stagings is a fresh wave that carries its own
alternate-tier member.

**Do not label it anywhere.** The pairing is a query over
`docs/metrics/member-outcomes.tsv` — a `session`+`role` carrying more than one
distinct `model`. A hand-set column would not survive that file's regeneration,
and one derived against today's declared tiers would mislabel every historical
row.

**Why one per wave and not a week of one tier followed by a week of the other:**
tier would then be confounded with calendar date and therefore with prompt
evolution, which is exactly the state #864 documents and the reason the rows
already on disk cannot answer the question they were collected for.

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
append lands a row without touching this paragraph. **As of 2026-08-28, 103
rows:** the file holds 66 `class=routine` PRs across 14 distinct `run_date`s,
so the floor is long since met, and 6 of them carry `closed_own_ticket` `no`,
so the trigger is met too. **Firing changes nothing: the action is "revert
`class=routine` to top tier" and that revert already happened on 2026-08-16.**
The guard is in its fired state and has no further move; the live question is
the opposite one, restoring a cheaper tier, which this guard does not decide
and which no row on file settles.

The raw split still favours the top tier — 3 failures in 11 `routine`/`sonnet`
rows against 3 in 55 `routine`/`opus`. **Do not read that as a tier result.**
Tier remains largely confounded with calendar date and therefore with prompt
evolution: 8 of the 11 `sonnet` rows fall on 2026-08-13 to 08-17, before the
window in which 54 of the 55 `opus` rows were run, and the dispatch prompts
gained rules throughout. The confound is **weakened, not resolved.** Three
`sonnet` rows now break it rather than one — **#714** (2026-08-20, a
maintainer-authorized deliberate control) and **#750** and **#751**
(2026-08-21) — all three run against prompts of the same vintage as the `opus`
rows, and **all three passed**, which is the direction opposite the raw split.
Three is still not a result. **What replaces this argument going forward is the
within-run pairing above**: one implementer per wave at the alternate tier makes
tier orthogonal to date by construction, so the question stops depending on
whichever rows history happened to leave. **Orthogonal to date, and to nothing
else** — the alternate member is picked as the most ordinary ticket in its wave
and never the hardest, while the top tier absorbs every remaining ticket
including all of the hardest, so the pairing trades the calendar confound for a
difficulty one that runs in a known direction. That is why the four covariates
exist: condition a pair comparison on `sizing`/`profile`/`loc`/`files` before
reading it as a tier result, never on the raw split.

`minted_false_claim` **discriminates and no longer reads "always yes"** — 20 of
the 66 `routine` rows carry `no`, 18 at `opus` and 2 at `sonnet` (#714, #750).
Read it as a property of the TICKET before the tier: a pure code simplification
need not add prose, while a correction ticket adds prose by construction. The
honest summary is unchanged and is the reason this paragraph exists: the guard
fired on the criterion the maintainer chose in advance, not on a demonstration
that the cheaper tier is worse.

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
(#246). Every use above is a recovery path, so a payload that arrives short
lands exactly where a lost class or a settled `ruled:` is unrecoverable — which
is why the script's own suite pins that `read`, `row`, `filed` and `ruled` each
reach a pipe whole.

`check` reaches a pipe whole at both of its exits too. Its ALREADY FILED exit
sits mid-branch, where falling through would run the near-miss ranking and the
tracker search that exit exists to skip — so `check`'s branch is a function now,
where `process.exitCode` carries the code and a `return` is what skips them
(#808). No payload this script prints is abandoned to `process.exit()` any more,
and the suite drives both of `check`'s arms through a pipe on a payload the
ledger sizes rather than argv. So trust that payload — and read `verdict`,
because a searched-and-clean tracker and one that was never read share exit 0.

The consumer side raised its cliff rather than removing it. `board.mjs` reads
`ledger.mjs read` with an explicit `maxBuffer`, so a payload past node's
default is carried rather than killed mid-flight and reported as an
unreachable tool — which is how the blind cockpit came back at HTTP 200 even
after the pipe cut was gone (#807). That cap is deliberately bounded, so a
payload past it lands in the same blind cockpit — and so does a ledger that
cannot be read at all, at any size. The read fails open to an empty ledger, and
`board.json`'s `ledgerState` field now distinguishes a read that failed or
didn't parse from one that succeeded (`unread`/`unparsed`/`read`, #816) —
`spend` in the same payload carries its own error the same way (#874). Zeroes
on the cockpit are not yet proof the pipeline is idle.

**Guard: accumulate per PR, never conclude inside one run.** The unit is the PR —
refill is level-triggered, so there are no implementer waves. **Append one row to
`docs/metrics/tier-outcomes.tsv` when you rule each PR's review** (that file's
header carries the column meanings). That append is the whole duty; the guard
fires on the accumulated file, across runs, not on the run in front of you.

The row's last four fields are the ticket's difficulty, and they are what lets a
tier comparison condition on the thing that swamps it. `sizing` is the
**member's** own `light`/`heavy` verdict from its phase-2 `sizing-a-ticket`
run, read back off the PR body's `Sizing:` line (`gh pr view <pr> --json body`);
`profile`, `loc` and `files` all come from `diff-stats.mjs` over the merged
diff. **Phase 0 does not size anything** — it shortlists, phase 1 claims, and
the sizing run happens inside the member after both, which is why the verdict
has to travel in the PR body rather than being something you already hold. **A value
not in hand is left BLANK, never estimated** — blank reads as unknown and drops
the row from a stratified comparison, while a guess reads as measured and
poisons one. Blank still means the field is WRITTEN and empty: append all
twelve fields on every new row, because a row of some in-between width cannot be
told apart from a shifted one. The `note` field is free text and now sits before
those four, so write it with spaces: one tab inside it shifts all four for that
row alone, and the suite reds on the field count when it does.

**Then record the run's member facts — do not author them.** Scrape EVERY session
directory for this cwd, not one:

```bash
PROJECT_DIR="$(node -e 'import("./scripts/board.mjs").then(m => console.log(m.encodeProjectDir(process.cwd())))')"
for d in "$HOME/.claude/projects/$PROJECT_DIR"/*/subagents; do
  node scripts/member-outcomes.mjs "$d"
done
```

`encodeProjectDir` (`scripts/board.mjs`) encodes the cwd the way Claude Code
does — every non-alphanumeric character becomes `-`, so a leading dot segment
doubles its dash (`board.test.mjs`'s regression case: `.claude` becomes
`--claude`, not `-.claude`) — and hand-guessing that path is why the fleet's
own panel once rendered nothing here.

**Do not narrow this to "this run's session" with `findSubagentsDir`.** That helper
answers a different question — the session with the NEWEST transcript for this cwd,
which is not the same as the one you are in. Measured 2026-08-27: 86 sessions share
`~/.claude`, and 17 of the 21 days with any subagent activity had two or more of them
writing. A second Claude session dispatching anything while you reach this step wins
the tie, and the run then re-scrapes a stranger's members, prints a plausible row
count and exits 0 while its own facts are never recorded. Looping every session dir
costs a few seconds, cannot pick wrong, and is idempotent by construction.

The scraper accepts either a `subagents/` directory or its parent session directory,
and refuses a path it cannot read — a missing, unreadable or non-directory
`subagents/` all exit 2 — so a wrong path fails loudly instead of writing nothing and
exiting 0. It reports the run's own YIELD, `scraped N of M members (D dropped)`,
alongside the file's total: read the yield, because the total is the whole corpus and
looks healthy even when every member of this session dropped.

It derives every row from the subagent transcripts the harness already wrote — both
the flat ones and a Workflow's nested `subagents/workflows/wf_*/` fan-out — so a
second run over the same session changes nothing and a re-run after a member is
re-dispatched picks the new transcript up. **Never hand-edit
`docs/metrics/member-outcomes.tsv`** — it is regenerated wholesale whenever the
role classifier changes, and a hand-entered value would not survive that. The
verdict for a PR still goes to `tier-outcomes.tsv`, by hand, as before.

Both files are the run's own artifacts and neither commits itself. Carry them to
main the same way the run carries any other controller-authored change; leaving a
regenerated 5,000-row corpus uncommitted in the checkout is how it gets discarded by
the next `git checkout` with nothing to show it ever ran.

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
the revert every routine ticket runs at top tier, so the file now holds 55
`routine`/`opus` rows against 11 `routine`/`sonnet` (as of 2026-08-28, 103 rows
— recount before citing). The same-class comparison the paragraph above calls
the only informative one therefore EXISTS now. It is still not clean: the two
groups are split almost entirely by calendar date, so it measures prompt
evolution at least as much as tier. The counter-evidence paragraph earlier in
this section carries the split and the three rows that cut against it. Recount
both, and every other figure in this section, with:

```bash
grep -vc '^#' docs/metrics/tier-outcomes.tsv
awk -F'\t' '!/^#/ && $4=="routine" {n++; d[$1]=1; if($6=="no") no++} \
  END{print n, length(d), no+0}' docs/metrics/tier-outcomes.tsv
awk -F'\t' '!/^#/ && $4=="routine" {t[$5]++; if($6=="no") f[$5]++} \
  END{for(k in t) print k, t[k], f[k]+0}' docs/metrics/tier-outcomes.tsv
```

**These rows are the historical corpus, and nothing appended to them fixes the
confound.** What fixes it is the within-run pairing in the dispatch rule above:
from now on every wave contributes a `sonnet` and an `opus` implementer run
against the same prompts on the same day, so the comparison stops depending on
which tier history happened to leave in which week. Read the pairs, not the
whole-file split, once there are enough of them.

**So read what the guard actually established: routine tickets sometimes fail to
close their own ticket. Not that `sonnet` caused it.** The revert is the
pre-committed rule being honoured, not a measurement. Restoring a cheap tier is
still the maintainer's call and still a change to the dispatch rule — but the
deliberate control it used to require is no longer something anyone has to
authorize one ticket at a time: the alternate-tier dispatch above produces one
per wave by construction. **Do not read the pairs early.** Report the count and
stop until there are at least ten of them across five or more distinct
`run_date`s; below that, a pair count is a number, not evidence, and the last
guard fired with n=1 on the control side.

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

**The dispatch prompt pastes phase 0's own read of the ticket rather than telling
the member to re-fetch it, and this still costs one `gh issue view` per ticket,
never one per member.** The fresh-context design's isolation rationale — "every
implementer re-reads its Agent Brief... from scratch"
(`docs/specs/2026-07-22-run-team-agent-fleet-design.md:178-179`) — is about a member
never inheriting another ticket's context, not about where the bytes come from.
Pasting phase 0's own read into the prompt keeps that: the member still gets the
brief verbatim and re-derives nothing from a sibling. What it drops is the
unconditional re-fetch of an issue the controller already has open, on every
dispatch and every refill — the fetch the prompt still carries is the backstop
for a brief that turns out to be insufficient, not the default path.

One named member per ticket, up to cap, background. Each prompt carries ticket
number, worktree abs path, branch, and each of these verbatim:

> **You are an unattended fleet member.** No maintainer is reachable, no user
> will answer you, and no approval gate will ever clear for you. Report to the
> controller and to nobody else. Where a skill offers a maintainer-present step
> and an unattended one, yours is the unattended one.

> You are ALREADY in worktree `<abs-path>` on branch `<branch>`. Do NOT create
> another worktree. Verify with `git rev-parse --git-dir` and
> `git rev-parse --git-common-dir`. Skip the using-git-worktrees skill's Step 1.

> Here is the ticket's distilled brief, already read once in phase 0 step 4 —
> title, plus whichever of the `## Agent Brief` comment or the issue body
> carries the ticket's actual brief, and its `Out of scope`, pasted verbatim:
> `<distilled brief>`. Skip the fetch below if this already answers what you
> need.

> Read the issue with `gh issue view <N> --json title,body,comments --jq '.title, .body, (.comments[]|.author.login + ": " + .body)'`.
> Not bare `gh issue view <N> --comments` — non-interactively that prints only
> the comments, and nothing at all when there are none, dropping the title and
> body either way, exit 0, so the loss is silent. The `## Agent Brief` comment
> is authoritative over the issue body. Read the issue **before
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

> **Every scratch file, fixture or mutation copy you create goes under
> `<scratch>/impl-<N>/`, never into the scratch root by itself.** The scratchpad
> root your own system prompt names is injected unprompted into every dispatched
> member and is shared with every sibling running this session — `SKILL.md` does
> not choose that root and cannot keep it from being handed to you, so writing to
> it directly, not a subdir under it, is the defect. Derive your own path the
> same way `claim-ticket.sh` already derives per-ticket ports from the issue
> number (`postgres=16<N>`, `ollama=22<N>`): `<scratch>/impl-<N>/`, not a second
> scheme, and `mkdir -p` it yourself the first time — nothing creates it for you.
> The harm is a false measurement, not untidiness: a mutation harness writes a
> broken copy of a file, measures against it, then restores from `.orig`, and
> two members in one directory are one filename collision away from restoring a
> sibling's `.orig` over their own file, or measuring a "clean baseline" that is
> actually a sibling's mutant — silently, indistinguishable from a real result.
> This is not the worktree isolation rule: `claim-ticket.sh` already gives you
> your own worktree, and the scratch root sits deliberately outside every
> worktree so a harness never dirties one — nothing partitions the scratch root
> itself but this rule.

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
> `Closes #N` in the body, then `gh pr edit --add-label` as its own command
> carrying exactly one release label — `patch`/`minor`/`major`, the *label*, not
> the branch *type*. **Never fold `--label` into the create**: a create that
> outruns your tool timeout is backgrounded with the PR already open, its flags
> unapplied and no exit status for you to react to, so the label goes missing
> and every later gate still reads the PR as correctly opened. Separate, the
> label write has its own exit status and fails loudly. **Put your step-6 sizing verdict in the PR
> body on its own line, `Sizing: light` or `Sizing: heavy`** — the controller
> records it as a difficulty covariate when it rules your review, and the PR body
> is the only place it survives your exit. Report the PR number and head SHA to
> the controller, then exit. Never apply `ready-to-merge`, never merge.

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
  **But the finisher that applied the label may still be live on that worktree,
  and the wave's first act on a behind PR is a rebase** — which is destructive to
  a worktree someone is in, the same hazard the reaping rule names. The label
  lands at duty 3 and the finisher's report is duty 4, so the gap is the normal
  case, not a rarity — the duty order produces it, not luck. Wait for that
  report before dispatching the bot. Waiting is nearly free — a PR already
  labelled is not blocking anything, and its behind-count is expired on arrival
  either way.
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
  guard here, on the floor phase 2 defines over the accumulated
  `docs/metrics/tier-outcomes.tsv` and on no gate of this event's own: a second
  threshold stated here is a second definition, free to drift from the one that
  governs, and a throttle would need state nothing on disk records — a schema
  change with its own ticket. Nothing else in the loop owns it.

**Run the reconcile on the merge-side edges.** Both edges marked above —
**merge-bot wave reports done** and **Monitor: CI run completes** — end with one
invocation of the executable reconcile, and you act on what it prints:

```
~/.fleet/bin/fleet-run fleet-tick.mjs \
  --implementers <live> --reviewers <live> --merge-bots <live> --pool <n> \
  --reviews-ready <n> --merge-holds <pr,pr|none> \
  [--implementer-cap 2] [--reviewer-cap 5]
```

It prints `actual/target` and an explicit ACTION for implementers, reviewers and
the merge bot, with the whole Queue depth guard table below applied in code. The
live counts and the pool are yours to state and it **refuses rather than
defaulting them**: nothing in the repo records liveness — a ledger row is a
dispatch, and that token outlives the member's death, its bail and the merge —
so a default would turn a forgotten flag into either a dispatch past the cap or
a permanent hold, silently. Merge queue, review backlog and supply it reads
itself.

**`--reviews-ready` and `--merge-holds` are yours on the same terms**, because a
label says a PR is signed off or awaiting a review — never that anything can be
handed out. Both refuse an absent value the way the counts above do.

- **`--reviews-ready <n>`** — reviews whose findings you HAVE, with no
  fix-applier on them yet. A reviewer slot holds a fix-applier and a fix-applier
  applies findings, so a review still running counts 0 here, and on the default
  path you run them one at a time. The backlog is **not** this number: it counts
  PRs whose review has not started, which is nothing a member can be dispatched
  against, and the row will no longer dispatch off it (#590). On the
  hand-dispatched fallback path below, where the reviewer member does the review
  itself, this is the PRs one can be given.
- **`--merge-holds <pr,pr|none>`** — the PRs your last merge-bot pass reported
  `held-behind-#<lower>`. That verdict moves no label and leaves nothing in the
  repo, so the queue read here is blind to it, and a bot dispatched against a
  queue whose every candidate is held spends a member re-deriving a verdict you
  already have — which is exactly the state a stalled cascade sits in. `none` is
  a statement, not a blank: an empty value is refused, since that is the shape an
  unset shell variable arrives as.

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
`~/.fleet/bin/fleet-run ci-state.mjs --pr <N>` per open PR already emits
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

**A probe that cannot read is a transition event, not silence.** The natural
watcher shape — `st=$(ci-state.mjs --pr "$pr" 2>/dev/null) || continue` — fails
closed correctly and then throws the failure away, so a rate-limited probe emits
NOTHING and "no event" becomes indistinguishable from "not green yet". Every
open PR stalls unlabelled while the run reads as merely quiet; observed live
twice. So check the REST budget *before* polling — `gh api rate_limit` is itself
unmetered (`gh api rate_limit --jq '.resources.core.remaining'`, re-confirmed
2026-09-08) — and give an unreadable `ci-state` payload the same treatment one
level down. The shape is **one outer tick loop with an inner pass over the open
PRs**, because the two causes live at different levels — the budget is one
account, the payload is one PR:

```sh
while :; do                                   # one tick
  rl=$(gh api rate_limit --jq '.resources.core.remaining' 2>/dev/null || echo ERR)
  case "$rl" in ''|*[!0-9]*) rl=ERR;; esac    # a non-numeric read is an outage, not a budget
  if [ "$rl" = ERR ] || [ "$rl" -lt 200 ]; then
    if [ -z "$budget_out" ]; then             # ONE global latch: a quota outage hits every PR
      echo "WATCHER DEGRADED: core REST budget=$rl — CI polling paused, silence is NOT green"
      budget_out=1
    fi
  else
    if [ -n "$budget_out" ]; then
      echo "WATCHER RECOVERED: core budget=$rl — CI polling resumed"
      budget_out=
    fi
    prs=$(gh pr list --state open --json number --jq '.[].number' 2>/dev/null) || prs=ERR
    if [ "$prs" = ERR ]; then
      if [ -z "$list_out" ]; then             # global latch: this cause is account-level too
        echo "WATCHER DEGRADED: cannot list open PRs — CI polling paused, silence is NOT green"
        list_out=1
      fi
    else
      if [ -n "$list_out" ]; then
        echo "WATCHER RECOVERED: open-PR list readable again — CI polling resumed"
        list_out=
      fi
      for pr in $(printf '%s\n' "$prs"); do   # inline $(...): `for pr in $prs` is ONE iteration under zsh
        st=$(~/.fleet/bin/fleet-run ci-state.mjs --pr "$pr" 2>/dev/null)
        if ! printf '%s' "$st" | jq -e '.verdict and .verdict != "rate-limited"' >/dev/null 2>&1; then
          case " $blind " in *" $pr "*) ;; *) # latch keyed BY PR: this cause is per-PR
            echo "WATCHER DEGRADED: no usable ci-state reading for #$pr — silence is NOT green"
            blind="$blind $pr" ;;
          esac
          continue                            # inner continue — still reaches the tick sleep
        fi
        case " $blind " in *" $pr "*)
          echo "WATCHER RECOVERED: ci-state reading #$pr again — CI polling resumed"
          keep=; for b in $(printf '%s\n' "$blind"); do [ "$b" = "$pr" ] || keep="$keep $b"; done; blind=$keep ;;
        esac
        : # your normal handling of $st for this PR
      done
    fi
  fi
  sleep 120                                   # the block's only pacing, once per tick
done
```

**One gate, not a gate plus a caveat.** `jq -e '.verdict and .verdict !=
"rate-limited"'` exits non-zero on unparseable input *and* on a false result, so
that single test covers empty, garbage AND a self-named quota refusal. Empty
stdin produces no result at all, which `-e` reports as exit 4 (measured), so a
`[ -z "$st" ] ||` pre-check in front of it is a *second* gate testing what this
one already tests — the caveat this heading is about. Leaving
the named verdict to prose instead is how a watcher clears its latch on an
outage payload and hands it downstream as CI state — the very blindness this
section exists to remove, one level in. **The `.verdict and` half is load-bearing
and not belt-and-braces**: inequality alone never tests that a verdict *exists*,
so `{}`, `null` and `{"verdict":null}` all evaluate `null != "rate-limited"` →
true and clear the gate (measured), handing an empty or error object downstream
as a CI reading. Require the field, then compare it.

**It has to latch** — one line entering the degraded state, one leaving it,
never one per tick. An unlatched line at a 120s poll gets the Monitor
auto-stopped for volume during even a two-minute outage, reintroducing the same
blindness by another route. **Latch each cause at the level its cause lives
at**: the budget and the open-PR list are one global flag each — both fail at the
account level — but the payload latch is keyed by PR, and a
shared scalar for those is an unlatched line wearing a latch's clothes — one
persistently blind PR alongside one healthy PR re-clears the flag on every tick,
emitting a DEGRADED and a false RECOVERED pair forever. The recovery line is
what says the watch is alive again, so emit it on the first good pass even when
nothing about the CI state changed; without it a reader cannot tell a recovered
watcher from a dead one.

**All pacing in exactly one place — the tick loop's own tail `sleep`.** A sleep
inside the per-PR pass multiplies by the number of open PRs (8 open PRs → 960s
of pause per tick, against the 24s outage reset measured below), and a degraded
branch that `continue`s the *outer* loop skips the tail sleep and busy-spins
probe pairs during exactly the outage it is reporting. All three degraded
branches above fall through to the same single sleep instead.

**Guard every probe, not just the ones with a verdict field.** The block makes
*three* API calls, and the third — `gh pr list` — is the one that looks like
plumbing rather than a probe. A non-quota failure there (secondary/abuse limit,
5xx, network blip, expired token) does not lower `.resources.core.remaining`, so
the budget gate clears, and an unguarded `for pr in $(gh pr list …)` then
iterates zero times over the empty substitution: no error, no latch, no DEGRADED
line — total silence per tick, which is exactly what this section exists to
remove. Capture its status (`prs=$(…) || prs=ERR`), latch it globally, and fall
through to the same tail sleep. **Then iterate with the inline `$(printf '%s\n'
"$prs")` form, never a bare `for pr in $prs`** — measured, that bare form runs
ONE iteration under zsh with both numbers glued into a single value, while
`sh` and `bash` split it correctly, so the bug hides in whichever shell you
happened to test in. zsh word-splits a command substitution's *result* but not a
bare parameter expansion, so this applies to **every** loop in the block, the
`blind`-latch removal included: under a bare `for b in $blind` a recovered PR
never leaves the list and the block emits a fresh RECOVERED every tick
thereafter — the per-tick volume the latch exists to prevent, wearing a latch's
clothes again.

**Judge `ci-state` on its payload, never its exit code** — the same rule as
**gate on the payload's own fields**, applied to the watcher. `not-green` is an
ordinary, frequent state that exits non-zero, so a watcher treating any non-zero
exit as an outage misfires constantly on PRs that are merely in progress. Empty
or unparseable output is the degraded case; parseable JSON reading
`verdict: "not-green"` is normal. An exhausted quota may also name itself,
`verdict: "rate-limited"` on stdout — likewise degraded, and likewise not a
reading, which is why the gate above tests the verdict rather than mere
parseability: that payload is perfectly good JSON.

**Do not back off and wait.** These outages are short — a rolling window; one
measured reset came 24 seconds after `remaining: 0` — and pausing members for a
fixed interval stalls the fleet longer than the outage itself would have. A
retry-and-wait loop is what turns a 60s outage into a stalled member. Report it,
keep the local work moving (git, tests and mutation runs are all unaffected),
re-probe.

**While the budget is exhausted, `ledger.mjs check` reads
`verdict: "unverified"`** — the ledger was read and the tracker was not. That is
correct behaviour, but `unverified` exits **0**, the same as `clean`, so a
member treating exit 0 as "safe to file" files blind during exactly this window.
Say so when you flag the outage: members read `verdict` explicitly until you
report recovery, never the exit code alone.

### Reviewers

**You run the review yourself, once per PR. That is the default path.**

CLAUDE: `Workflow({name: "fleet-ctl:review-pr", args: {pr, branch, worktree, testCmd, scratch}})`.
OMP: `eval` loading `scripts/review-eval.mjs` through the Resolver (`fleet-run --path review-eval.mjs`) and calling `runReviewOnOmp({pr, branch, worktree, testCmd, scratch})`.

Only you can run it — members have no `Workflow` tool on Claude and no reason
to run `eval` themselves on omp (verified 2026-07-30 for the
`general-purpose` subagent on Claude; tool availability is per-agent-type, so
recheck after a harness change rather than treating it as permanent) — and it
is the only path on which `selectDimensions` sizes the fan-out to the diff
and the verify budget follows severity. Hand-dispatched, neither executes at
all: sizing falls back to a reviewer's own judgement and nothing budgets the
adversarial pass. It cuts one immutable snapshot, verifies every
critical/important finding adversarially, and has `agent()` return **into
the script**, so no report can go undelivered and you relay nothing — the
delivery failure that cost one fleet five reports on one PR and four on
another.

**Know the trim before you rely on it — it is wider than `docsOnly` suggests.**
`diff-stats.mjs` calls a PR docs-only only when it touches **no** src, tests *or*
config, but that strictness cuts both ways and the size tier trims again on top.
Measured: a docs PR that also adds one test file is profile `tests-only` and runs
**three** (correctness+tests+comments), not six; a docs+config diff too big for
the size tier runs correctness+comments without being docs-only at all; and any
`single-file` or `small` profile trims to correctness+silent-failure+comments,
keeping tests only when a test file is in the diff. `comments` is on that floor
unconditionally since #218 — it used to need a docs FILE, and `classify()` scores
any code extension `src` before it checks docs, so five production PRs whose whole
substance was prose inside a `.js`/`.mjs`/`.sh` comment scored `docs: 0` and ran
without the one specialist that fit them, `dimensionsUnrun` empty every time.
That floor holds **regardless of `hasSrc`** (#236) — a one-file `.yml` or
`.github/` shell change gets silent-failure too, not correctness alone.
It is the size **tier's** floor,
so `tests-only` outranks it when the diff has no config file: that profile is
assigned ahead of `single-file`/`small`, so a no-src, no-config diff that also
touches a test file gets no silent-failure-hunter — a tests-only diff that also
carries a config file keeps it (#739). `single-file` means one file at **any** size, so a
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

It returns `{pr, head, snapshot, dimensionsRun, dimensionsUnrun, survived, refuted, unverified, resume}`.
`unverified` is *not* "checked and cleared" — a `suggestion` skips the pass by
policy, and a finding whose refuters all crashed lands there too. Hand those over
with the rest; never rule on them yourself. **`refutersDispatched`, carried on
every finding, is what tells those two apart** — zero is the policy skip, above
zero with no surviving vote is the crash — so read the population off that field
rather than off severity, which records only how much a finding would matter if
true. `resume` is non-null exactly when that crash population is non-empty, and
it names the relaunch that replays this run's unchanged prefix from cache and
re-runs only the calls that died. **Resume beats handing a crash-heavy review
on**: a deferred crash is a finding nobody ever looked at, and you are the seat
that can still make something look. `refuted` comes back deliberately as
well — a refutation is itself a claim, and one has been reversed on new evidence —
so record it in the ledger's `ruled` line and hand it over only when you reverse
it. **A 1-1 split is not a verdict** — read the votes, not the band. Three tied
refutations were reversed and re-examined in one run; all three findings survived.

**`dimensionsRun` is the dispatch; `dimensionsUnrun` is what names a gap.** A
specialist that dies, and one that never executed the suite, both contribute zero
findings while the key stays in `dimensionsRun` — so read the two together. A key
in `dimensionsRun` and NOT in `dimensionsUnrun` ran a suite; every
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
repo `node --test scripts/*.test.mjs`. Pass the same string to the
workflow, to the fix-applier, and to the finisher — whose duty-2 mutation gate
runs it too — so every gate runs one command. Omit it from the
workflow args and `review-pr.js` now DERIVES it from the repo under review
(#142) instead of defaulting to a fixed string — refusing outright if it
can't; the fix-applier has no such fallback, so substituting `<testCmd>` with
nothing leaves it no gate at all.

> You are ALREADY in worktree `<abs-path>`. Do NOT create another worktree. The
> review is done and these findings are its output — do not re-review, do not
> dispatch specialists.
>
> Read `$(~/.fleet/bin/fleet-run --root)/commands/review-and-fix.md` and run **steps 2, 3
> and 5 only**: split apply-now/defer, commit, push, file every deferral as its
> own issue with the label the finding's state calls for. Skip step 1 — the
> review already ran — and steps 4 and 6: the controller owns the CI wait and
> dispatches the finisher.
>
> **Every factual claim your diff restates needs a settling command run
> against the tree first** — the issue body is a lead, never a citation.
> **No positional references** (`the closing/second/last X`); name the thing
> semantically. **Never write a COUNT or a tally into prose; state the
> property instead** — unless it is a past-tense record of a measurement you
> performed, which stays as written; a present-tense claim about a live
> property must be restated as a property (`every other test in the file`),
> true at any count.
>
> **Apply `survived` findings. A finding in `unverified` whose refuters ran and
> crashed always defers** — and which of the two it is, you read off
> `refutersDispatched`, never off severity and never off an empty vote list:
> above zero with nothing surviving means every refuter dispatched against it
> died, and at `critical` that is every one of them. Severity records how much a
> finding would matter if true, never whether anything looked. Say *in the
> deferral* that its refuters crashed rather than that it went unchecked — the
> run is resumable and I hold the tool that resumes it, so a deferral that names
> the crash can still be re-verified. **A `suggestion` is also in `unverified`,
> for a different reason — `refutersDispatched` of zero, the 0-refuter budget
> the workflow gives that band by policy — and the rule below, not this one,
> covers it.**
>
> **A `suggestion` is budgeted 0 refuters, so it is unchecked until you check
> it.** For each one, first decide scope: is it inside the scope of the PR's own
> ticket, or a different piece of work? **Out of scope → defer and file, never
> apply.** **In scope → dispatch ONE refuter** against the finding before
> touching the tree, biased to refuse:
>
> > Try to REFUTE this finding. Default to refuted=true if uncertain. Verify by
> > RUNNING something — compile it, run the test, apply the mutation. Do not
> > reason your way to agreement. Observe that run synchronously — run the
> > command, wait for it, read its exit code. Never poll a log file for a
> > completion marker: prefer ONE blocking run to a poll loop, and treat its
> > return as permission to look, never as the answer. Reading a log the run has
> > already finished writing is fine; waiting on one is not. If you match a test
> > reporter's own output, accepting both `ℹ` and `#` is necessary but NOT
> > sufficient — strip SGR escapes first as well. node's prefix moves with the
> > node version and with whether stdout is a TTY, and color wraps the whole line
> > so it begins with ESC and no prefix anchor matches at all, which returns
> > empty at exit 0 — indistinguishable from a hung run and from a run of zero
> > tests. For an uncolored baseline use `env -u FORCE_COLOR`; `FORCE_COLOR=`
> > empty still enables color, so it is not a control. State your search scope
> > AND what your pattern would have missed. A grep over one ref does not
> > support a claim about history; a pattern built from the token a diff removed
> > does not support a claim that the category is empty. Everything you write — mutants, fixtures,
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
> CLAUDE: retrieve via `tail -1 <output-file> | jq -r '.message.content[]?|select(.type=="text").text'` — never read the whole file, it is the full JSONL transcript and will overflow your context. Pinging is not retrieval and never becomes one: `SendMessage` to a finished subagent returns `had no active task; resumed from transcript` without the report (~15 pinged in one run, 0 retrieved).
> OMP: the tail/jq recipe does not apply — a depth-2 helper cannot dispatch further (`task.maxRecursionDepth: 2`); reach it directly instead, by its full dotted id (`<member>.<helper>`), via `hub send` — delivered, woken, no transcript workaround needed.
>
> If retrieval comes back empty, ask the controller by name. Only when neither
> works is the finding **unchecked** — defer and file it, and say so in the body. This is
> `review-and-fix.md`'s **Specialists** rule; it reaches you here because the
> steps that point at it are the ones you skip.
>
> The CI facts in that file apply to you — a `rebase-check` red, or heavy jobs
> `skipped`, **solely** off a non-zero behind-count, is staleness and not a
> failure. Never rebase to clear it. **`solely` is the load-bearing word:**
> `ci.yml`'s `rebase-check` exits 1 on five conditions and only one is
> staleness, so a non-zero behind-count does not by itself settle which fired.
> The job log names the condition — and because the staleness condition exits
> before the merge-commit condition is evaluated, the log is silent on that one
> by construction, so measure it separately with
> `git fetch origin && git rev-list --merges --count "origin/<base>..HEAD"` —
> keep the fetch, or a stale local `origin/<base>` widens the range over the
> base's own merge commits and reports a merge commit this branch never added.
> A non-zero count does not send you to a local rebase either: the merge bot's
> step-1 `gh pr update-branch --rebase` drops merge commits too
> (`run-merge-bot.md` step 1), so both conditions clear on that one server-side
> rebase. What it buys you is knowing the red was never solely staleness.
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
fine — **solely** off that count, which is a condition to establish rather than
infer, see the five-condition note in the fix-applier block above) — or
`ci-state.mjs` reads `verdict: "no-ci"`, see below — dispatch a
**finisher** — a fresh small agent, not the fix-applier resumed. **Dispatch it
with `model: "haiku"`.** Its four duties are a checklist — audit the
worktree, confirm every deferral has a tracker home and re-run the acceptance
mutation, apply one release label, report — and the
merge gate downstream still catches whatever it gets wrong, the same argument
that puts the merge bot on the same tier below. **Never dispatch
one while you still owe the fix-applier a ruling**: the pinned SHA is only as good
as the guarantee nothing else is inbound. **The test is your OUTBOX, not the
member's last message** — anything you have decided that it has not received,
including a ruling you have since **withdrawn or reversed**. A withdrawal you
recorded only in the ledger is undelivered: the member still holds the original
and will act on it. Relay everything — reversals too — then dispatch.

**An unanswered question from the member is an outbox item, and it blocks
dispatch with the same weight as a ruling you have already made.** It does not
feel like one — you have decided nothing yet, so the outbox reads empty — but a
member waiting on you is a member that will push once you answer, and the SHA
you are about to pin is exactly what that push moves. Measured on #488's run:
`fix-pr-488` asked whether to add two pins, and the finisher was held until the
member acknowledged the answer. That worked because the controller chose to
hold, not because a rule required it. Answer it, or tell the member you are not
ruling and it should proceed on its own default — either empties the outbox.
What does not empty it is noticing the question and dispatching anyway.

**A final report is not proof the member stopped.** Observed twice: a ruling
relayed after dispatch produced a new commit mid-audit, and a fix-applier that
reported "nothing outstanding" resumed on a ledger-only withdrawal and was
cycling mutants through the worktree when the finisher audited it. Both finishers
correctly halted. Note what that costs to detect: two reads of the same worktree
a minute apart showed *different* mutants, so a member's report and any single
`git status` are each valid only at their instant. Its duties, in this order:

1. **Audit the worktree** — run `worktree-audit.sh` (it takes no argument; it
   audits every worktree in one pass, so find this worktree's row in its
   output) or run `git status --porcelain -unormal` inside the worktree
   itself — the explicit mode, never bare `--porcelain`, or
   `status.showUntrackedFiles = no` reads a dirty worktree as clean (#730).
   Dirty
   or diverged halts the finisher *here*, before the label: it reports
   what it found and labels nothing. A finisher that verifies the dirt is
   harmless and labels anyway has substituted the rule's purpose for the rule,
   and you find out at merge time. **Give it the two-cause block below,
   verbatim** — a bare SHA mismatch names no cause, and the halt report needs
   one. **Give it `<testCmd>` too** — the same string you passed the workflow
   and the fix-applier — because duty 2's mutation gate runs it and nothing
   else hands the finisher one; substituted with nothing it leaves that gate
   no command at all.
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

   **Whatever you verify by RUNNING, run in a tree nobody else owns.**
   Independently re-running the ticket's acceptance mutation — loosen the
   regex, delete the guard clause, flip the per-entry reset, run `<testCmd>`,
   watch it redden, discard — is the half of this duty reading a diff cannot
   do, and it stays. But it **writes**, and the PR's worktree belongs to
   another member. Measured on #380: a finisher was inside that worktree at the
   instant the fix-applier announced one more clause to land, and neither
   ordering is detectable afterwards from the diff — a restore lands on the
   uncommitted clause and destroys it silently, or the mutant is still in the
   tree when the fix-applier commits and a deliberately broken guard ships as
   the fix, in a commit nothing re-reviews. So take your own:
   `git worktree add --detach <scratch>/pr<N>/finish-<your member name> <your dispatch pin>`,
   mutate and run `<testCmd>` in there, then
   `git worktree remove --force <scratch>/pr<N>/finish-<your member name>`.
   **At your dispatch pin, never at the fetched branch tip** — duty 1 just
   proved the owned worktree sits at that pin, and `PR headRefOid` may carry
   commits no reviewer read, the substitution the halt block's head-equality
   check rejects for the same reason. The member name is in the path because
   the scratch root is shared with every sibling, so `<scratch>/pr<N>` alone
   collides whenever a PR gets a second finisher, and `worktree add` on an
   occupied path fails closed into a halt with a purely mechanical cause.

   **Remove it on every path, the failing ones included** — a mutant that comes
   back green, a suite that will not start, your own halt at any duty. `--force`
   is required and is right only here: the tree is deliberately dirty when you
   are done, so a plain `git worktree remove` refuses it (`contains modified or
   untracked files`, rc 128, directory left on disk — measured, git 2.50.1),
   while everywhere else in this runbook that refusal is a finding precisely
   because the dirt may be someone's only copy. Here nothing in it is anyone's.
   Nothing sweeps a leak for you either: `reap.sh`'s branchless sweep is bounded
   to the fleet's worktree home, so a tree under `<scratch>` is a `kept` entry
   it reports and never collects. The tree you added is a checkout, so since #55
   it carries the tracked `./agent-test` like any other — run either that or
   `<testCmd>` in it, per **A reused worktree may lack the runner** above.

   **None of this licenses a write to the owned worktree.** Duty 1 is a read;
   you never restore that tree, because you never wrote to it. A controller
   instruction to restore mutated paths there is an instruction to perform the
   silent-destruction ordering above — report it back, do not run it. One
   finisher refused exactly that instruction live, on the grounds it could not
   prove the diff was its own; that was judgement, and this is the rule.
3. Add `ready-to-merge` — after reading the PR's labels back
   (`gh pr view <pr> --json labels`) and finding **exactly one** release label,
   `patch`/`minor`/`major`. Zero or more than one halts the finisher before the
   label, naming which it found. This is the backstop for a label lost wherever
   it was lost, a hand-created PR included: a `gh pr create` that outran its
   caller's tool timeout leaves the PR open with the flag unapplied and no exit
   status anywhere to notice, and nothing downstream re-derives the release
   label. Count only those three — the PR carries other labels, `ready-to-merge`
   itself among them once you add it, so a PR wearing one release label beside
   them passes unchanged. A repo that defines none of the three does not gate on
   one — `gh label list` settles that, and it is no licence to skip the read
   where they exist.
4. `SendMessage` you the label, the deferral issue numbers, and anything it
   halted on — cause and evidence, below, never a bare "head moved".

**Once the label is on, take it off before you approve any push.** The label is a
verdict on the tree the finisher read, and a GitHub label does not follow the
branch — on #180 it survived a push and came to sit on a commit nobody had
audited. Remove `ready-to-merge` *first*, then approve: removing the artifact the
merge bot gates on is the reliable stop, where messaging the bot races it, and a
label has been observed holding until after an abort message arrived. Then
dispatch a **fresh** finisher against the new head; the first audit does not
transfer, since it verified a different tree. The merge bot refuses that head on
its own (`run-merge-bot.md`, **The labelled head**), so this is not the only
guard — but its refusal costs a wave and leaves the label lying, which is yours
to clear either way.

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
> - **Live editor.** `git status --porcelain -unormal` is dirty. Sample
>   `git diff --stat` twice, a minute apart — diffstat growing means someone
>   is still writing. Halt, name `live editor`, report both samples.
> - **Rebase.** `git status --porcelain -unormal` is clean, head still differs
>   from your pin. `git reflog` in the worktree: a `reset`/rebase entry near
>   the move, not a plain `commit`, means the branch replayed onto a new
>   base — its own commits on a new parent, content-identical only on a
>   conflict-free replay.
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
— **never write a COUNT or a tally into prose; state the property instead** —
unless it is a past-tense record of a measurement you performed, which stays
as written; a present-tense claim about a live property must be restated as a
property (`every other test in the file`), true at any count. A
count is false the moment the next commit lands, and #768 falsified two of them
(`the only other chmodSync(..., 0o644)`, already off by one before it; `fails 75
of the 85 cases`, measured 81 of 91) in a file whose own header records having
shipped a stale count once already. The immutable-body rule earns the same
place: **every claim a commit body or a PR body asserts needs its settling
command re-run at the commit that ships it, and written inline beside it.** A
relayed enumeration delivers only what it names, so this list is the whole of
what a controller hands over, never a preface to it.

**One more rule, and the one the diff cannot carry: a claim written into a
commit body or a PR body needs its settling command re-run at the commit that
ships it, not at the commit that motivated it — and the command goes inline,
beside the claim.** The rules above scope to prose the diff restates, and a
pushed commit body is not in the diff: it cannot be edited, only retracted by a
later commit, which is itself a fresh unverified historical claim. So the check
has to sit at write time, and review-time is already too late. The claim types
are wider than measurement — a line number, a SHA, an **attribution** of who
said what, a positional reference and a count all rot the same way, and an
attribution is the worst of them, because the argument it carries collapses
when it turns out false, while a wrong line number leaves the surrounding
reasoning standing. `Verified:` is the construct a later reader trusts
*instead of* re-deriving, so a wrong figure under that header is worse than no
figure at all. Measured on #399: `f961cf2` and `acce6ee` both close `Verified:`
with `86/86 across both test files` naming the suites that read this file, a
file set the tree does not bear out — `git log -1 --format=%b <sha> | grep -A2
Verified:` shows what each shipped. Inline is what makes the difference visible:
a claim carrying the command that produces it can be re-run instead of trusted.
A claim whose settling command cannot be written is still not one to assert
bare: settle it inline, mark it unsettleable from this repo per the citation
convention above, or drop it. The marker ending is not a loophole but the case
that convention already sanctions: it directs foreign evidence to be asserted as
prose saying it cannot be settled from this repo, and that marker is itself what
tells a later reader not to trust the claim instead of re-deriving it, which is
the property this rule protects.

**The settling command for "which files read X" must never be a literal-path
grep.** The path is assembled in more than one spelling here, one of them behind
a local `read` helper, so a grep for the path string answers with the files that
merely *name* it — comments included — and misses the files that build it.
Replace the file with `MUTATED` in a throwaway copy, run the suite, and read off
which suites red: that answers which ones **depend on its contents**, which is
the question a coverage claim actually needs, and it returns a different set
from any spelling of the grep.

#### Fallback: hand-dispatched reviewer member (no `Workflow` tool)

Only where the workflow is unavailable **or has failed** — never a preference.
"Unavailable" is `ToolSearch` not finding it; "failed" is the throw or empty
return above, surviving one retry. A workflow that is present and throwing is not
absent, and reading this line as absence-only leaves the likeliest failure with no
sanctioned path at all. One named member per PR, `review-pr-<pr#>`, never its
implementer. Give it the PR number and tell it to read
`$(~/.fleet/bin/fleet-run --root)/commands/review-and-fix.md` — the resolved file
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
`$(~/.fleet/bin/fleet-run --root)/commands/run-merge-bot.md`, run **one** pass, then
`SendMessage` you what it merged and what it held, then exit — and say that
you dispatched it, which is what makes it skip its own watcher step. **Dispatch
it with `model: "haiku"`** — rebase, wait for green, check the
label, merge is checklist work, and a bad merge still needs the label and the
per-job CI state to have been read correctly, which is exactly what a wrong
merge later surfaces and a human resolves; `no-undo-audit.sh` is the
deterministic, script-driven backstop run before every push specifically to
catch a wrongly-resolved conflict, so the tier buys nothing that backstop
doesn't already cover.

**Put every gate trap in the bot's brief, not in a follow-up message.** A bot
already looping cannot be corrected — the loop consumes the turns a correction
would land in. Each is measured, and they fail in different directions:

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
- **A `jq` exit outside 0 and 1 is not a verdict.** `jq -e` exits 0 when its
  last output was truthy and 1 when it was false or null — the outcomes that
  invite reading the code as a boolean. Every other exit means the gate never
  compared a field at all: measured on jq-1.7.1-apple, **3** the program did not
  compile (a full-width `｜` typed where `|` was meant, which is how the gate
  merging #1172 hit it), **2** a usage error, **4** the program yielded no output
  (an empty payload has no field to compare), **5** the input did not parse or
  the program raised. That table is for the boolean comparison this spec
  prescribes. A *filtering* gate — `jq -e 'select(.verdict=="pass")'` — is
  outside it: such a gate answers by emitting or withholding its input, so on a
  payload that says `fail` it exits **4** where the boolean form exits 1, and
  that 4 is a genuine refusal by a gate that did look. Read an exit against the
  shape of the gate that produced it. Each boolean reading of a non-0/1 exit is
  wrong, in a different direction: `[ $rc -eq 0 ]` blocks a mergeable PR on a
  typo, `[ $rc -ne 1 ]` merges on a gate that never parsed. Same rule as
  `inflight.sh`, `verify-sha.sh` and `staleness.mjs` exit 2 — could-not-look is
  a third answer carried beside pass and fail, never folded into either. Scope
  the response to what the exit can change: 5, and 4 while the payload may still
  be filling, can clear on a re-read, so re-run the gate once and report if the
  same exit repeats; 3 and 2 are properties of the program and the invocation,
  so a second run returns them by construction — report and stop without
  re-running.

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

**A `rate-limited` payload is not a reading — read `verdict` before anything
else.** An exhausted GitHub quota makes `ci-state` name its cause rather than
refuse in silence: `verdict: "rate-limited"` on stdout at the unchanged exit 2,
with every field it never got to observe ABSENT. Gate on the fields above as a
conjunction and that blocks, because `verdict` is not `green`. Gate on a SUBSET
and it passes vacuously — absence is not self-blocking in `jq`, so
`.prHead == .runHeadSha` is `null == null` and `(.missing | length) == 0` is
`0 == 0`, each exiting 0 on a payload that read no CI at all (measured). A quota
refusal clears on its own, so the response is to re-probe shortly — not to block
the PR, and not to send it back for work it does not need.

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

`~/.fleet/bin/fleet-run reap.sh --apply` recomputes every precondition
inside the same invocation as the delete — `for-each-ref` for `[gone]`, `git
cherry origin/main` to authorize `-D`, worktree removal without `--force` — and
reports reaped and kept-with-reason counts. Update the reaped tickets' ledger rows
in the same step. See references/reaping.md.

**It sweeps detached worktrees too — the shape a `[gone]` walk structurally
cannot see.** Bounded to `.worktrees/`, so a checkout of yours outside it is
reported, never removed. Read `worktreesRemoved` alongside `reaped`: a wave that
reaps branches and removes no worktrees is a finding, not a quiet success.
See references/reaping.md.

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

`~/.fleet/bin/fleet-run release-ticket.sh <N> <slug> <type> --apply` is the
inverse of the claim, and recomputes its preconditions inside the same
invocation as the delete: 0 commits ahead of `origin/main`, no unique commits
(`git cherry`), no branch on `origin`, and — whenever the worktree directory is
there to read — a clean worktree. Where that directory is established absent the
dirty check does not run at all, and `git worktree remove` is no backstop for it:
it gates its own clean check on the same `stat`, so the script's absence
measurement is sole arbiter there. Two of the four are recomputed a second time
at the delete itself: the dirty check by git, which is what `worktree remove`
without `--force` is; and the ahead count, re-run against `origin/main`
immediately before the branch delete, because a commit can land across the
`gh issue view` between the checks and the delete. The `git cherry` and
pushed-branch checks are **not** re-run there — a commit landing in that window
is ahead of `origin/main` by construction, so the recount covers it. All clear →
drops the label, removes the worktree without `--force`, deletes the branch with
`-D`, authorized by those two commit checks plus the recount and by nothing else
(`-d` measures against local HEAD, and a claim has no upstream, so it refuses a
pristine claim whenever local `main` is behind `origin/main` — #760). Any one of
them failing → it touches nothing and names the blocker. **That refusal is the
finding, never an obstacle**: a claim carrying commits or a pushed branch is not
auto-released, ever — run `worktree-audit.sh` (it audits every worktree; find
this claim's row in the output) and decide by hand.

Run it over every pool ticket with no PR when the run ends or the maintainer
drains, and on the spot for a claim abandoned mid-run (a bail before
implementing, a collision found after the claim). Update the released tickets'
ledger rows in the same step. See references/reaping.md.

## Worktree and claim model, on both harnesses

Ruled on #1315, measured 2026-09-09 in a throwaway clone (`/tmp/fleet-probe`)
that never touched the real checkout. Container per #1297: one tree, neutral
prose, the harness split stated inline as the marked pair below — no
per-harness `SKILL.md`, no shell wrapping the shared claim.

**Claim, release and reap are unchanged on omp.** `claim-ticket.sh`,
`release-ticket.sh`, `reap.sh` and `inflight.sh` are git-native and operate on
the single shared ref store every worktree and the main checkout read and
write directly (**Phase 1**, **Reap after every wave**, **Release the claims
that never became PRs** above); nothing in omp's `task` model touches that
store, so none of the four scripts carries a dialect branch.

**A fleet member is never dispatched with omp's `isolated: true`.** Measured:
an isolated spawn builds its workspace under `~/.omp/wt/<hash>/m` — an APFS
clone (on this box), never a registered `git worktree` of the repo — and,
because `apply` defaults to `true`, its changes are patch-applied into the
**calling session's own cwd** the instant the spawn completes: a file an
isolated probe created there appeared as `?? probe-isolated.txt` in the probe
session's own cwd — which for an actual fleet run is the controller's main
checkout — not in the worktree the prompt named. That is the exact
silent-spill hazard this section exists to guard against, on by default, so
`isolated` stays unused for every member and `task.isolation.enabled` stays
off.

**A member's tree is the claimed worktree, addressed by absolute path — the
shared contract, true on both harnesses without translation.** Claude carries
the identical hazard for the identical reason: an `edit` header without the
worktree prefix lands in the main checkout (**You read your instruments out of
a tree every member can write to** above), so this is one rule, not two; only
the mechanism for handing a member its cwd splits by harness:

CLAUDE: the `Agent` tool call this runbook dispatches through (`subagent_type`, no working-directory field anywhere in this file) hands a member its cwd purely through the dispatch prompt — **Phase 2**'s "You are ALREADY in worktree `<abs-path>`" — so every write that member makes is addressed there by the absolute path alone.
OMP: the `task` tool's item schema — `name`/`agent`/`task`/`outputSchema`/`schemaMode` always, `effort`/`isolated` only when their own settings enable them — carries no working-directory field either; measured directly: a member dispatched through it with none of those fields, told only to report `pwd`, returned the calling session's own cwd, not the claimed worktree, the same output an un-`cwd`-set `bash` call gives from that session, so the recipe is the same dispatch-prompt absolute path, plus `bash`'s own `cwd` parameter set to it on every call and absolute paths for `write`/`edit`.

**The one open gap this ticket measured: `task` does not accept a per-dispatch
working directory.** `omp://tools/task.md` documents non-isolated spawns as
running `runSubprocess(...)` "directly with parent cwd" — no `cwd` field
appears anywhere in the item schema — and the probe above confirms it in
practice: the recipe is the absolute-path discipline above, not a placeholder
for a `cwd` field that does not exist.

**`release-ticket.sh` is not a no-op on omp, and `inflight.sh`'s probes are
unaffected by a running member.** Measured against a hand-built claim (a
branch plus a `git worktree add`) with a member sleeping inside it: a `bash`
call with `cwd` set to the worktree, and a non-isolated `task` spawn told to
work there, both operate inside the existing worktree and leave `git worktree
list` unchanged — they coexist with the claim rather than duplicating it. An
isolated spawn is architecturally blind to the worktree — its relative writes
land in its own `~/.omp/wt/…` workspace regardless of the prompt — but it
neither removes nor hides the claim, and `~/.omp/wt/` was empty after every
isolated run: omp's own teardown touches only omp's own workspace, never the
claim. `release-ticket.sh`'s three-artifact teardown (label, worktree, branch)
is therefore exactly as necessary as on Claude. With the member live inside
the worktree, `git worktree list` and `git branch --list` from the main
checkout reported the claim unchanged before, during and after — `inflight.sh`
hides nothing from omp.

**The controller's own cwd stays the main checkout on both harnesses,
unchanged.** Nothing in this section's dispatch recipe — the marked pair
above, the isolated-workspace measurement, or the teardown scoping — moves
where the controller itself runs from.

## Queue depth

- **pool** — approved, not yet dispatched
- **supply** — open `ready-for-agent` surviving in-flight scan and the decided?
  check. A queue of undecided tickets is zero supply.
- **review backlog** — PRs verified and queued with no reviewer slot.
  `fleet-tick.mjs` counts every open PR without `ready-to-merge` **that closes an
  issue**, which is that plus the ones already under review or waiting on CI. The
  wider read on that axis, because narrowing it needs per-PR review state that
  lives in your head and not in the repo — so it holds the refill earlier than the definition above, never
  later. The closing-issue test is what keeps it from
  widening on the other axis: a chore PR you author yourself closes nothing and is
  left unlabelled for the maintainer, so no member of the fleet will ever review
  it, and counting it floors the backlog at a depth nothing in the run can drain
  — the implementer gate then holds for the rest of the run against a queue of
  nothing (#590). GitHub's own linked-issue set decides that, not a keyword regex
  over the body; see `docs/agents/issue-tracker.md`. **That exemption is for
  the chore PR THIS run authors, never one a PRIOR run left open** — step 0
  folds those into this run's review queue, so count one when you reason about
  backlog BY HAND. **The `fleet-tick.mjs` number still excludes it**: nothing
  in its filter distinguishes an inherited chore PR from this run's own, since
  a PR closing no issue fails the closing-issue test either way — folding one
  in cannot reach the count. So the by-hand judgement and the script's output
  differ here, and the script's own comment at `reviewBacklog` says why:
  narrowing it needs per-PR review state that lives in the controller's head
  and not in the repo.

**Reviews are the bottleneck, not tickets.** Implementation runs 4-15 min; review
runs 20-40, because each fans out up to six specialists. On the default path
**you** run each review, one at a time, so reviews serialize on your own turn and
the reviewer cap buys no review parallelism at all — those slots hold
fix-appliers, which do the cheap half (apply, commit, push, file). Five
implementers still saturate the pipeline within the hour and every later PR
queues; the queue now forms ahead of the workflow rather than ahead of a slot.

**Re-derived against the full post-#211 population in
`docs/metrics/member-outcomes.tsv`, not one wave.** A single `run_date` is not
representative — `run_date=2026-08-10`, the first full wave after #210
(merged 2026-08-05) and #211 (2026-08-06) landed, gave median implementer
`wall_s` 428 against median fix-applier (`role=reviewer`) `wall_s` 1190, a
~2.8x ratio, but pooling every row since is a clearly declining trend, not a
stable one: since 2026-08-07 (the complete post-#211 population, n=289
implementer / 302 reviewer) → 1.49x; since 2026-08-28 (n=107/109) → 1.22x;
since 2026-09-01 (n=62/61) → 1.13x. All three sit at or below the 1.5x ratio
that would support narrowing, the opposite of the single-wave read. Taking the
full post-#211 population as the most representative window (largest sample,
not an outlier wave, not overfit to a narrow recent slice): median implementer
`wall_s` 905 against median fix-applier `wall_s` 1348.5, a 1.49x ratio — right
at the 1.5x line, and the narrower, more recent windows above show it
continuing to fall rather than reverting. That supports narrowing to **2
implementers / 3 reviewers**. Absent instruction, default is now **2
implementers / 3 reviewers**, and say why.

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

**Verify every reported SHA.** `~/.fleet/bin/fleet-run verify-sha.sh
<branch> <sha>` before enqueueing — a member can commit in a nested worktree,
leaving the SHA on a stray branch while its report reads normally. Exit codes as
`inflight.sh`: `# 0 reachable, 1 not reachable, 2 unanswerable`. Not reachable
(exit 1) → flag, do not enqueue, do not return the ticket to the pool until the
maintainer rules. **Exit 2 is not a verdict** — the question could not be
answered, and every cause of it reaches you as one shape: no JSON on stdout at
all, the cause on stderr alone. Read that stderr, fix what it names and re-run;
escalate if it repeats. Never read exit 2 as `not reachable`, and never record it
as a stray commit — the flag and the maintainer's ruling above are what exit 1
earns, and spending them on a probe that never answered costs a member its
ticket over a failure a re-run would have cleared.

**Never `--delete-branch`.** It errors on a `main` held by another worktree, or
strands the feature worktree on `main`. `gh pr merge <n> --merge` alone; GitHub
deletes the remote branch anyway.

**Never force a rebase to start.** No `git clean`, `git checkout .`,
`git reset --hard`, `git stash`. Uncommitted changes may exist nowhere else.
Non-empty `git status --porcelain -unormal` → stop and report — the explicit
mode, never bare `--porcelain`, or `status.showUntrackedFiles = no` reads an
empty answer here and licenses the rebase over work this check exists to
protect (#730). Stashing empties it either way, so that check and
`no-undo-audit.sh` both go quiet on work nothing else holds.

**Cross-check what members report about their environment.** Wrong often enough
to matter, and a confident wrong report from a reviewer flips a verdict.

**Distrust negative claims hardest.** "Nothing else references this", "the sweep
is clean" — most likely false, least likely checked: a grep that found nothing
looks like a grep never run. Make members state their search scope. Negative claim
vs specific finding with paths → paths win.

**Members share one filesystem, one docker stack and one process table**, and the
failures arrive as *wrong findings*, not errors:

- **A pattern kill reaches siblings — say so in the dispatch prompt.** `pkill -f
  <pattern>` matches on the whole command line, machine-wide. Members hold
  separate worktrees, but the process table is not partitioned by them and a
  test file's name is identical in every one, so a pattern naming a test file
  matches whichever member happens to be running it. Measured: an implementer
  chasing its own stalled run issued `pkill -f "claim-ticket.test.mjs"` and
  killed a `node --test claim-ticket.test.mjs inflight.test.mjs` that was not
  its own.

  **What the victim's output looks like depends on the signal — and one of the
  cases is a clean green.** Each measured on node v26.8.1/darwin against a
  purpose-spawned fixture killed by its own PID. `pkill -f` **defaults to
  SIGTERM**, and a SIGTERMed runner prints `Interrupted while running:` followed
  by a *complete* summary block with `cancelled` non-zero, exiting `rc=1` — so
  `cancelled` is exactly the thing to search for in the default case. `pkill -9
  -f` leaves no summary block at all and the shell reports `rc=137`: SIGKILL
  means the harness never lived long enough to report. A kill landing on one of
  node's per-file **child** test processes leaves a complete block with `fail`
  non-zero and `cancelled 0` at `rc=1`, indistinguishable from an ordinary test
  failure. And a kill landing on a process a **test itself spawns** leaves a
  complete `pass N / fail 0 / cancelled 0` at the expected N over a corrupted
  run: `spawnSync` reports a SIGKILLed child as `status null`, and a test
  asserting only that the process it spawned exited non-zero —
  `assert.notEqual(r.status, 0)`, a form used across this suite, in files that
  spawn the shell scripts they cover — passes vacuously on `null`.

  So **a complete summary block proves the runner survived, not that the run was
  uncontaminated.** Scrutinize reds, short counts *and* greens from inside the
  incident window; a killed **baseline** compared against a clean mutant is a
  wrong measurement that reads exactly like a real result.

  **The command line is no partition either — not reliably.** Ports are derived
  per issue precisely so collisions are impossible; argv isolates a run only
  sometimes. Measured with `ps -Ao pid,ppid,args -ww` (without `-ww` macOS `ps`
  truncates, and the truncation reads as an absence): an invocation carrying an
  **absolute** path puts a member-unique string in argv, while one carrying
  repo-relative filenames is byte-identical across members. Which of the two you
  get is not yours to choose — members are briefed on `./agent-test
  <file-or-dir>` over the suite under `plugin/scripts/`, and that runner `exec`s
  node with the file list its caller's shell already expanded, never a literal
  glob. Clearing your own leftover process needs its PID, not a pattern.

  Members report a stalled run to the controller instead of pattern-killing it,
  and the controller re-checks any measurement taken in the window.

  **Do not guess the victim — the blast radius is the machine, not the wave.**
  In that incident the controller reasoned from dispatch scope to "almost
  certainly `impl-<N>`" and told the maintainer so; the named member then proved
  it was not the victim (it had never invoked those files standalone, and its
  mutation baselines post-dated the window). Idle members of *previous* runs,
  other Claude sessions on the same machine, and the maintainer's own shell are
  all `pkill -f` targets and none of them appear in your ledger. Warn every live
  member, record the incident as unattributed, and re-check measurements by
  timestamp rather than by who you think was running.

- **A warning acted on silently is indistinguishable from one that never
  arrived.** The same incident: the controller's warning DID reach the member,
  which re-ran, found nothing changed, and said nothing — correctly reading
  "send once, never re-send" as covering it. The controller then had to spend a
  round trip asking whether its own outbox was lossy. So say in the dispatch
  prompt that **confirmation state includes warnings received and acted on, even
  when the outcome is no change** — one line, in the report the member already
  owes. That is the cheap half of the *never read silence as assent* rule, paid
  by the member rather than by the controller's guesswork.

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
  snapshot does not — the tracked bootstrap (#55) needs a real git repository
  to materialize the runner, which a `git archive` snapshot lacks — and takes
  the one `review-and-fix.md` hands out. See references/isolation.md.
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

**Then.** **Re-pin first** — `~/.fleet/bin/fleet-run instruments.sh
--pin`. You just changed the instrument set under your own check, and this is the
only edit that legitimately does; skip it and the next gate refuses on your own
fix, which teaches you to ignore the refusal. Then the ledger line, save the
rationale, one line to the maintainer. Live members hold the old text — re-brief
only if it changes what they do *now*.

## Failure handling

| Failure | Response |
|---|---|
| SHA not on expected branch | Flag, do not enqueue, report |
| Implementer bails before implementing | → `needs-triage` if under-specified, `ready-for-human` if it needs human hands; drop `in-progress`, comment the cause, release the claim, refill (phase 3) |
| Implementer blocked or ambiguous *mid-implementation* | Free the slot, leave `in-progress`, report — the row above is the pre-code bail, not this one |
| `review-pr` workflow throws or returns no tree | Retry once, then hand-dispatch the fallback reviewer. Never enqueue the PR as reviewed — the workflow is not a member, so no other row here covers it |
| Reviewer or fix-applier cannot reach green | Report, leave the PR unlabeled, free the slot |
| Merge bot hits the hold rule | Report `held-behind-#<lower>`, PR stays queued |
| Merge bot finds the worktree ahead of the PR head **on the local-rebase fallback** | `worktree-diverged-#<pr>`, PR stays queued. Read the stray commit; push-or-discard is yours, and the maintainer's if the evidence cannot settle it |
| Merge bot finds the head moved after `ready-to-merge` was applied | `head-moved-after-label-#<pr>`, PR stays queued, label untouched. Dispatch a **fresh** finisher against the new head — the first audit verified a different tree |
| Merge bot cannot resolve a rebase safely | Stop that PR, report, continue |
| Member silent or truncated | Send to ping or resume — same unit of work; see the state machine below |
| Member idle with work outstanding | Read the PR first, *then* ping. Idle ≠ done |
| Member **killed** (spend limit, API error, crash) | New member, new name, prompt carries inherited state |

A red PR never silently becomes `ready-to-merge`.

Settle outcome and liveness are different facts — and a different state
machine on each harness, not the same table with two spellings. Recovery is a
fresh member, fresh name (`impl-<N>-b`, `fix-pr-<M>-b`, `review-pr-<M>-b`)
whose prompt states what it inherits.

CLAUDE: idle or truncated still answers `SendMessage`; a killed member answers nothing, and a spend limit kills every member at once.
OMP: `hub cancel` leaves a peer hard-aborted and unmessageable, but a `failed` job's peer can stay `idle` and answer normally — a bucket Claude's triad has no slot for.

Reviewers that went idle on CI recover as a **finisher, not a re-review** once
commits are pushed. See references/member-lifecycle.md.

Audit every worktree before dispatching replacements with
`~/.fleet/bin/fleet-run worktree-audit.sh` — it reports each worktree's
ahead-count and uncommitted files, the committed-vs-uncommitted distinction that
decides whether a replacement redoes or destroys work.

## Run ledger

One git-ignored `.fleet/ledger.md`, updated at **every** state change via
`~/.fleet/bin/fleet-run ledger.mjs` subcommands (`row`, `filed`, `ruled`,
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
those and decide. Exit **3** is scored: some row gh returned has to score above
zero against the subject, because the ANDed query also matches issues the
overlap rates 0.00, and every measured stop over those was survived only by a
reader who overrode it and searched the tracker by hand — obeying it would have
dropped a real deferral (#388). It also prints the closest filed rows with an overlap score.
Those never move the exit code — the same finding gets worded differently by
whoever finds it second — but once the tracker read succeeds, a filed row at or
above `NEAR_SOFT_HIT` in `ledger.mjs` does move the verdict to `soft-hit`, as
does a tracker set with no scoring row in it; a read that failed stays
`unverified`, which outranks both. **Exit 0 is not automatically "safe to file":** when `gh`
cannot be reached the answer is ledger-only, and it says `TRACKER NOT CHECKED` —
an issue filed by an earlier run is invisible to it; and `soft-hit` means rows
worth reading were found while none of them established a duplicate, so read
them before filing. The stdout JSON names all of that in one field:
`verdict` is `already-filed`, `tracker-hit`, `clean`, `soft-hit` or
`unverified`. Only `already-filed` and `tracker-hit` carry a non-zero code, so
`verdict` is the only thing that tells a searched-and-clean tracker from one
that was never read and from one whose rows you have to read yourself.

The ledger half reports its own readability as its own field, `ledger.ok`, the
peer of `tracker.ok`: false when the file did not exist, and false too when the
path led to something that did not parse as a ledger — which is what tells a
ledger that was read and held nothing filed from one there was nothing to read
(#231). The absent case is the normal one for a run's first `check` — `.fleet/`
is git-ignored and created lazily by the first write — so it stays `clean` at
exit 0, and `ledger.ok` is the field that says why rather than the verdict
moving. The stderr warning is deliberately narrower than the field: it fires on
a path with no file, so a `--file` that landed on the wrong existing file is a
silent `ok:false` with nothing on stderr. Gate on the field, not on the warning.

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
