# The Pull: what each step does and why

`pull.mjs` runs the Pull; SKILL.md's phase 1 says how to drive it, how to read the tick's `PULL` row and how to answer the questions it asks. This file is what each step means, and the measured reasons behind them, for the controller to read when a step refuses or an answer needs more than SKILL.md says.

## The steps

The steps below are what the driver runs, and the guidance for answering
`staleness`, `decided` and `collision`.

One free implementer slot is one Pull. The tick names the heads — one `PULL` row
per free slot — and each Pull runs this sequence on its head,
terminating in exactly one dispatch or an empty shortlist:

1. **Take the shortlist head** — the next `.fleet/shortlist.json` entry with no
   `impl-` row and no `excluded` row whose premise still holds, which is the
   ticket the tick's `PULL` row names.
2. **In-flight check, again** — `~/.fleet/bin/fleet-run inflight.sh <N>`; any
   hit = taken, drop it and take the next entry. The shortlist is as old as its
   last refresh. It runs all three probes (PRs, remote heads, local
   worktrees + branches) so a partial one cannot read as free. The PR probe is
   two signals rather than a bare full-text match — GitHub's own closing-PR links
   plus branch-segment matching — and both drop `MERGED` and `CLOSED`, so a
   merged or abandoned PR the `gh pr list` window covers cannot hold a ticket
   forever. A linked PR that window does *not* cover has no state to read: it
   prints `?` and still counts as taken, merged or not.

   **Exit 2 is not free** — the question went unanswered, so treat it as taken
   and say which ticket it was in the log. A probe that could not look is
   recorded rather than aborting the run, so exit 2 from one prints the same
   JSON as 0 and 1 plus an `unknown[]` naming the probes that could not look:
   read `unknown`, never `taken` alone, because exit 2 says `"taken": false`,
   which summarizes `hits` and is not a claim the ticket is free. A hit outranks
   an unknown — a payload can carry a non-empty `hits[]` and a non-empty
   `unknown[]` at exit 1, which is taken. Four causes print nothing at all — a
   bad argument, not inside a git repository, no such issue, a verdict that could
   not be written — so never assume exit 2 parses.

   **A free verdict is not evidence that nobody is editing the ticket's
   target files.** All three probes ask whether a branch-shaped claim
   exists — a PR, a remote head, a local branch, or a worktree — and
   nothing else; work done directly against the shared checkout, by a
   human or another agent session, stakes no branch-shaped claim and trips
   none of them.
3. **Read the ticket in full, once** — `gh issue view <N> --json title,body,comments,labels,createdAt`
   written to `<scratch>/impl-<N>/issue.json`, then read off that file with `jq -r
   '.title, .body, ([.labels[].name]|join(",")), (.comments[]|.author.login + ": " + .body)'`.
   One read answers every question the Pull asks; step 7's router reads the same file. Record the ticket's real
   brief — the `## Agent Brief` comment where one exists, otherwise the issue
   body, which is where most tickets actually carry it (a controller probe found only 43/100 open
   `ready-for-agent` issues have a separate Agent Brief comment; the rest,
   this ticket included, carry the brief in the body) — plus its `Out of
   scope` sequencing wherever that section is found. Then judge **decided?**
   — never size.

   **Torn → surface, never guess**: relabel it
   `ready-for-human` as a fork naming the open decision — the label is how a
   Pull surfaces it to the maintainer. Opposite of
   `sizing-a-ticket`'s *torn → take the heavier row*, deliberately — see that skill.

   **A ruling the brief does not carry stops the Pull first.** The brief is
   the last `## Agent Brief` comment, else the issue body, so a decision posted
   under another heading never reaches any question the Pull asks. A comment
   with a `## Ruling` or `## Triage` heading line and no `## Agent Brief`
   heading line that is newer than the last `## Agent Brief` comment, or on a
   ticket with none, is a stranded ruling. `pull.mjs` checks for one right
   after the `ready-for-agent` label check, before printing the brief or
   asking anything. On a hit it posts one comment naming the newest stranded
   comment's heading line and URL, which says to rename that heading to
   `## Agent Brief — ruling` and drop anything that is not decided scope, or
   to delete the comment, then restore `ready-for-agent`. It then swaps
   `ready-for-agent` for `ready-for-human` and leaves with `LEFT #N:
   relabelled ready-for-human: stranded-ruling`.

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
   quoted defect is the fact.

   Old string gone from `git show origin/main:<file>`
   ⇒ the fix landed, and
   `git log -S '<old string>' --oneline origin/main -- <file> | head -1` names
   the commit that removed it; close citing that commit. Seconds either way,
   and the construct half alone is the probe that could not look.
   **No ancestry check on what that walk printed.** `origin/main` is where the
   walk starts, so every commit it can print is reachable from `origin/main` by
   construction, and `git merge-base --is-ancestor <sha> origin/main` is true
   for all of them — true again when the sha *is* `origin/main`. A step that
   cannot answer no is not evidence, and reads as evidence anyway.
   **That check belongs one input over — a sha the TICKET quotes**, where it
   can answer no: a rebase leaves the commit it orphaned a whole object, so
   `git show` resolves it happily while nothing in `origin/main`'s history
   reaches it, and a "fixed in `<sha>`" premise built on one describes a tree
   that no longer exists. Separate its two non-zero answers before citing
   either — exit 1 is the answer *not reachable*, while exit 128 with `Not a
   valid object name` is a sha this clone does not have at all, a probe that
   could not look rather than an orphan (measured: one ticket's comment cited
   `35c0845` on a since-deleted branch, and 128 is what it exits here).

   **Both halves of that command are load-bearing.** Drop the `origin/main`
   argument and `git log -S` searches `HEAD`, contradicting the rule a paragraph
   up — and the two searches fail differently there. On a checkout behind the
   fix the prescribed **old**-string search names a *wrong* commit at exit 0,
   the old string still being present in that tree: measured at
   `0dc39ef^`, `| head -1` names the rename `4fd2f73`, not the fix. It is the
   **new**-string search the paragraph above forbids that prints nothing at exit
   0 there, indistinguishable from "the change never landed"; the old-string
   search goes empty on a checkout that predates the old string's own arrival
   at that path — behind that rename in that case, and with no rename in play
   at all in this file's: measured at `647ae44^`, which already tracks this
   path under this name, `git log -S 'ls-tree origin/main'` prints nothing at
   exit 0.
   Add `--reverse` and you get the *oldest* count-changing commit, which is the
   file's last rename whenever the string predates one — measured on a ticket's old
   wording, `--reverse` names `4fd2f73` ("move next-ticket and sizing-a-ticket
   into the plugin"), a refactor that clears an ancestry gate exactly as
   well as the real fix, while newest-first `| head -1` names `0dc39ef`, the
   commit that actually did it.
   (`--follow` fixes the rename half but is mutually destructive with
   `--reverse`: the two together return empty at exit 0, and `--follow` takes
   exactly one pathspec or exits 128.) So read the subject of whatever it names
   before citing it in the close, and treat empty output as an answer you did
   not get rather than a commit.

   Measured, one run: one ticket's one-line remedy had shipped in `e7b11e6` ten days
   earlier and another's AC-2 asked for an exit code a later design
   deliberately changed — neither commit carried a trailer back, so the tracker
   showed both as open work. The one-line-remedy ticket cost a full claim, worktree and implementer
   dispatch to learn this; the exit-code ticket would have shipped a test asserting the opposite
   of the shipped behaviour. The two probes that settled both took seconds.
   **A ticket deferred from a review is a claim about a tree that has since
   moved** — and the older the ticket, the more it has moved, so this bites
   hardest at exactly the head of an oldest-first queue.

   Measured again 2026-08-19: four stale in the 20 oldest, and the construct
   probe caught **none** of the four. It **missed** a ticket whose two pins and the
   `contentWords()` extraction it asks for had all landed (`d016414`, `1abd6c8`)
   while `overlap()`, the construct, sat right where the ticket said, so the
   probe passed the ticket through as live work and it cost a claim, a worktree
   and a dispatch. It **missed** a ticket whose `d:` scan the candidates test suite
   already pinned — `6d94451` and `43d6ac5` both added `.d` assertions, and the
   ticket's own closing comment cites both. It **missed** a ticket whose wording
   defect `0dc39ef` had already fixed — by an **equivalent rewording**, not by
   the literal string the ticket proposed, which appears nowhere in
   `origin/main`; the ticket's **line number** had drifted too, `:95` → `:98`.
   And one ticket it could not read at all: that ticket's file is untracked in
   `origin/main`, the fatal-not-empty case above.

   **`staleness.mjs` runs that check for you, and answers in THREE values.**
   `~/.fleet/bin/fleet-run staleness.mjs --path <path> --gone
   '<string>'`, or `--present '<string>'`, once per claim the ticket makes.
   It goes here and not in `shortlist.mjs` because choosing WHICH string
   settles a ticket needs the ticket read, which the step above already did —
   so the cost lands on the pulled ticket and never on the backlog.
   `--gone` is a defect the fix must remove, the wording the ticket quotes as
   wrong; `--present` is what the fix must add, the assertion a pin ticket asks
   for. Give exactly one — the direction is not inferable from the string, and
   the wrong one answers the opposite verdict with full confidence.

   A needle that itself starts with `--` — `--label ready-for-agent`
   is one this backlog carries — needs the end-of-options separator: `--gone
   -- '<string>'`/`--present -- '<string>'`. Given bare, with no `--`
   immediately before it, the value guard still refuses it — `staleness:
   --gone needs a value` — at exit 2, a could-not-check to admit and annotate,
   not an invocation to retry.

   The third value is the one that has to survive. A probe that could not look
   answers exactly like a probe that looked and found nothing, so folding it
   into either neighbour retires live supply on a guess in one direction and
   reports a defect as live on a spelling the tree stopped using in the other.
   Exit 2 is also where every guard and every failed git call in that script
   lands, so a probe that breaks keeps the ticket in the queue.

   What it refuses to answer is the point of it. It reads `origin/main` and
   nothing else — never the working tree, never anything on disk — so a path
   this repo does not track is exit 2 rather than a clean read: that is the untracked-file
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
   oracle over the whole backlog is ruled out, and a reproduction run
   without a positive and a negative control misattributes causes rather than
   merely missing defects — one such check needed a purpose-built fixture plus
   both. A ticket no single string settles is a `could not check`: admitted,
   annotated in the dispatch prompt (the Pull's dispatch), never quietly dropped.

   **This is a consumption gate**, priced for the seat where implementer
   divergence costs a claim, a worktree and a dispatch; at filing time every
   issue the plugin creates is filed `needs-triage`, and only triage sets
   `ready-for-agent`.

   No sizing agent here. `sizing-a-ticket` picks the *process path*, and that is
   the dispatch's call, after the ticket is claimed.
4. **Collision scan against open PRs and live branches** — `pull.mjs` runs it
   before Q3 and prints one line per open PR or live worktree branch that shares
   a path with the brief, `no overlap` when none, and `could not look: <which>`
   for one it could not read. A path the brief names only in its `Out of scope`
   section is no target and is not scanned. Under each line come the shared
   files' hunks, each by its base-side range with the Markdown headings its
   changed lines sit under, then each brief `path:line` reference in a shared
   file with its headings on `origin/main`. A shared file is evidence, not a
   verdict. Answer Q3 off those lines: `behind-pr:#M`, a branch with no PR yet
   by its name, only when a construct the brief names, or a brief `path:line`
   reference, lands in or next to a hunk of `#M`'s diff in a shared file — next
   to is the same Markdown section, under the nearest heading above, or, in a
   file with no headings, within 20 lines of the hunk; with no such evidence the
   ticket does not collide, whatever files it shares. A target file the brief
   does not spell as a path → `paths <p>…`, which scans again and asks again. A
   PR the scan could not read is still yours to judge, and `behind-pr` on it is
   taken. `pr-overlap.mjs` is **PR-vs-PR only** — it runs `gh pr diff` on both
   args and errors on an issue number, so never run it on a ticket here.
5. **Sequence check** — the `#N` refs of the brief's `Out of scope` section are
   printed beside Q3 as the candidates: one naming an open ticket this one
   sequences after → `behind-issue:#M`. No overlap and no such ticket →
   `clear`.

   **`collision` (Q3)** — asked after the scan prints one line per open PR or
   live worktree branch sharing a path with the brief (`no overlap` when none,
   `could not look: <which>` for one it could not read) and the brief's `Out of
   scope` `#N` refs as candidates: `clear`; `behind-pr:#M`, an open PR or a
   branch with no PR yet by its name; `behind-issue:#M`, an open issue that
   section sequences this one after; or `paths <p>…`, which scans again.
6. **Claim** — `~/.fleet/bin/fleet-run claim-ticket.sh <N> impl-<N> implementer
   --apply` (below). Exit 2 → treat it as taken, next entry.
7. **Route, row, then dispatch** — `~/.fleet/bin/fleet-run ticket-router.mjs route
   --session <session> --ticket <N> --arm <A|B> --impl-row <k>[ --chain-head] --issue
   <scratch>/impl-<N>/issue.json --guard .fleet/cost-guard.json` prints the Pull's
   Routing, `POLICY=… CELL=… DRAW=… BY=… STRATUM=… BRIEF=… CRITERIA=… SIZED=… OBJECTIVE=… TRIPPED=… REASON=…`
   (the router's arguments paragraph below the list says what each argument is);
   then `ledger.mjs row <N> "impl-<N>[ · tier=<CELL>]" --routing "<that line>"`,
   `tier=<CELL>` exactly when `DRAW` is not `-`, which writes the row and files
   the line verbatim under `impl-<N>` in `## Routed` in one write; then the
   dispatch at once: claim what you are about to dispatch; dispatch what you
   have just claimed. A Pull routed without a draw writes `cell=<CELL>` instead,
   unless `CELL` is the policy cell, `slow-high`, which a row with neither runs.
   `ledger.mjs` refuses a line that is not a Routing and a second Routing for
   `impl-<N>`. Router
   exit 2 → no row and no dispatch: release the claim (`release-ticket.sh`, SKILL.md's
   Failure handling row for a claim abandoned mid-run) and emit an event, a probe that could not look — a table the router
   refuses refuses every Pull.

**The router's arguments, and nothing past its line.** `--impl-row` is the
row count the Pull creates — or, while an assignment is rolling (the latest
row 5k and every row after it carry no `tier=`), that row's number;
`--chain-head` marks a ticket another open ticket sequences after, which is
what rolls it. A `cell=` is no draw: a row carrying one and no `tier=` still
rolls. `--arm` is `A` for an even ticket number and `B` for an odd
one; a B Pull routes exactly as an A one until the table opens arm B.
`--session` is this run's own session directory. The router routes by the
row set of the run's Objective, `OBJECTIVE`, which it reads off the phase-0
receipt. The printed line is the
whole routing decision — never re-derive `CELL` from the table, the guard or
this paragraph. A missing or unreadable `.fleet/cost-guard.json` routes the
default cell only (`REASON=guard-missing`), burn-in included. On the ledger the
whole line, `REASON` with it, is the Pull's `## Routed` entry; a row carries no
`route=` (an older row's `route=<REASON>` still reads).

**The Pull table** — every verdict a Pull can reach, and the one thing each
does:

| At the Pull | Action |
|---|---|
| in-flight hit, or an in-flight check that could not answer | drop, next entry |
| no longer labelled `ready-for-agent` | drop, next entry |
| a stranded ruling: a `## Ruling` or `## Triage` comment newer than the last `## Agent Brief`, or on a ticket with none | relabel `ready-for-human`, next entry |
| `staleness.mjs` exit 1 — provably fixed | close citing the commit, next entry |
| brief names no *what* | relabel `needs-triage`, next entry |
| genuine fork — options named, none ruled | relabel `ready-for-human`, next entry |
| needs human hands — external access, manual testing, judgment during the work | relabel `ready-for-human`, next entry |
| a construct the brief names, or a brief `path:line` reference, lands in or next to a hunk of an open PR or a live branch | exclude `behind-pr:#M`, next entry |
| `Out of scope` sequences it after an open ticket | exclude `behind-issue:#M`, next entry |
| `claim-ticket.sh` exit 2 | taken, next entry |
| decided, live, free, claimed | row, then dispatch |

**The shortlist runs out → run `shortlist.mjs` once and Pull again; still
empty → hold the slot idle until the next refresh trigger.** Within a turn,
Pull from the current list first and refresh second — a refresh never delays a
dispatch.

## Relabels and exclusions

**A Pull never re-admits a ticket already relabelled.** The shortlist file can
be older than a relabel — this run's own Pulls, or a bail's relabel under **Relabel causes** — so
read the ticket's labels in step 3's full read (`--json
title,body,comments,labels`) and drop it when `ready-for-agent` is gone. A Pull
that trusted a list built before the relabel landed would hand a ticket the
fleet has already judged unimplementable straight to the next member.

**Relabel by cause.** An unclaimed ticket is yours to reclassify at the Pull —
`ready-for-human` for hands or a fork; `needs-triage` for a brief that names no
*what*. A stranded ruling relabels to `ready-for-human` as well, but it is never
yours to judge: `pull.mjs` finds it at step 3 and posts its own comment naming
the stranded comment's heading line and URL, which is not one of the
`briefs/relabel.md` comments.
`gh issue edit <N> --remove-label ready-for-agent --add-label <label>` (no
`in-progress` to drop — it was never claimed), preceded by exactly one comment,
the one `~/.fleet/bin/fleet-run dispatch-prompt.mjs render relabel --kind <kind> …`
prints. `--kind needs-triage` takes `--line`, the one-line missing decision;
`--kind fork` takes `--options`, the options verbatim from the brief, and is
the `ready-for-human` comment for a fork; `--kind hands` takes `--hands`,
one of external access, manual testing or judgment during the work, and
`--line`, and is the `ready-for-human` comment for hands. The three comments
live in `briefs/relabel.md`; `pull.mjs` posts its own one-line copy of the same
words when a Pull answer relabels, so a change to either is a change to both.

Neither label invokes anything: `/triage` is maintainer-run, and both labels
only stop the ticket costing a read per scan. These comments, the
stranded-ruling comment and the comment closing a provably fixed ticket are the
only writes the fleet makes to a ticket it did not claim.

**Exclusion is a ticket row with a premise.** `ledger.mjs row <N> "excluded ·
behind-pr:#M"` or `ledger.mjs row <N> "excluded · behind-issue:#M"` — `#M` is
the open PR, or the branch name until its PR exists, or the issue this ticket
sequences after. No new ledger section. `shortlist.mjs` probes every premise at
each refresh — MERGED or CLOSED lifts a `behind-pr`, CLOSED lifts a
`behind-issue` — and a lifted ticket re-enters the shortlist in its own
oldest-first slot; its row is rewritten to `impl-<N> …` when it is pulled,
because `row` replaces the whole line. `pull.mjs next --head <N>` reads the
ticket's row too when it would start a Pull (no record, or an ended one, or one
from another session; a Pull in progress or dispatched is resumed or reprinted
without a read): a premise still standing — one `gh` cannot be asked about
stands — ends the Pull at once, exit 1 `LEFT #<N>: excluded · behind-issue:#M
OPEN`, and so does an `excluded` row naming no premise, its reason the row's
own text; either way the record is saved and nothing claimed or commented. A
premise `gh` could not read, or whose answer holds no state, is exit 2 naming
it, the exclusion standing and nothing recorded, so the same command asks again
once `gh` answers. A branch-named `behind-pr` whose PR does not exist yet is
read that way: `gh pr view` finds no PR for the branch, so it is exit 2, not a
`LEFT`.

## Claiming

**Claiming.** `~/.fleet/bin/fleet-run claim-ticket.sh <N> impl-<N> implementer --apply` does
the label, worktree, branch, the Recipe's Install step, the clean-tree assertion, and the
isolation runner in one serial pass. The two arguments are always that literal
pair — `impl-<N>` as `<slug>`, `implementer` as `<type>` — so the claim is
branch `implementer/<N>-impl-<N>`, worktree `.worktrees/<N>-impl-<N>`. Never
read them off `git branch -r` or `git worktree list`: human branches on origin
(`fix/…`, `docs/…`) have another shape, and the script takes both arguments as
free text, so a pair copied from one claims under that shape at exit 0.

**The Install step comes from the Recipe cache — never pass or infer one.** The
claim reads it through `derive-testcmd.sh . install`, and the Test entrypoint
through `derive-testcmd.sh . test --at origin/main`, runs the
Install step in the fresh worktree and refuses if it left any file changed: an
install that rewrites the tree in a throwaway worktree corrupts it for everyone.
No cache is phase 0's Recipe derivation step not having run; an invalid one is
its re-derive-once rule.

**Materialize the isolation envelope as a file, not a briefing.** The claim
writes the runner, `agent-test`, into the fresh worktree it creates: an exec of
the Recipe's Test entrypoint, through the suite-slot wrapper (see `suite-slot.mjs`'s
header), that exports one port triple derived from `<N>`
(so collisions stay impossible), kept out of `git status` through the
repository's exclude file. A repository that tracks its own `agent-test` keeps
it byte-identical, with whatever isolation that repository built, and takes the
suite slot bound for its own full runs itself: nothing else will. Brief members
with `./agent-test` and nothing else — anyone who finds the worktree finds the
runner, including grandchildren you never dispatched. Its arguments land after
the Test entrypoint, so what one may name — a test file, a test name — is that
entrypoint's to say, and nothing in the runner refuses one that selects no
test: a run of zero tests is a failed run, not a pass. See isolation.md.

## Claim, record, render: the dispatch steps

**Claim what you are about to dispatch; dispatch what you have just claimed.**
Phase 1 makes the claim, serially in the main checkout — its rule is measured —
and the dispatch follows it at once. A claim that runs ahead of its dispatch is
a worktree, a branch and an `in-progress` label with no member behind them,
released by the end-of-run sweep rather than by a member that did the work.

**Record the dispatch before you make it.** `ledger.mjs row` wrote the row at
the Pull's step 7; `~/.fleet/bin/fleet-run dispatch-prompt.mjs render
implementer --member impl-<N> …` then renders its brief, and
`~/.fleet/bin/fleet-run ledger.mjs dispatch <N> impl-<N>`
marks `impl-<N>` live on it and in `## Dispatched`, and the call follows.
Its JSON carries `agent`, the definition that call names, and `brief.path`,
the rendered brief whose content is that call's prompt — read both off that
output, never recall them. Live implementers are the `impl-` tokens with no
`=<outcome>` — the tick reads that count off the ledger, and nobody states
it. `dispatch` refuses a member with no brief rendered for its role, naming
the `render` command to run first, and refuses once the
run is draining: drain stops supply. It also refuses a row whose `tier=`
names no single definition — two different values, or one that is not a
definition suffix — or names one with no `agents/<definition>.agent.md`,
before the member is live; fix the row with `row` first. A row with no `tier=`
is held to the same through its `cell=`. Once every refusal
has passed, `dispatch` deletes the member's prior report,
`<scratch>/reports/<member>.json`, when its brief's sidecar names an absolute
`scratch`, so a prior run's report cannot settle this one. A sidecar naming
none clears nothing and says so on stderr; a report it cannot remove refuses
the dispatch.

**The prompt carries only what varies.** Everything shared — the
unattended-member block, the `edit`/`read` absolute-path rule, the
issue re-read and re-derive backstop, commit incrementally, no `git stash`, the
shared `eval` kernel, enumerate-and-declare, sizing and the PR steps —
is the body of every `agents/fleet-implementer-<cell>.agent.md`, byte-identical
across all of them, and each harness injects it as the
member's system prompt. Never re-paste it. The prompt fills that body's
placeholders — the ticket number, the worktree abs path and branch
(`<abs-path>`, `<branch>`), the scratch path `<scratch>/impl-<N>/` — absolute,
`<scratch>` as `scratch-root.mjs` printed it — and the
distilled brief (`<distilled brief>`): the title plus the `## Agent Brief`
comment or the issue body, whichever carries the brief, and its `Out of
scope`, pasted verbatim from the Pull's own read. Beyond those
`briefs/implementer.md` carries only its report paragraph, the
no-acknowledgement line, the foreground-suite line
— and a `staleness.mjs` **could not check** verdict with its
reason when the Pull got one, so the member's own re-derive step knows the
controller's probe could not look.

## Every 5th Pull goes at an exploration cell

**Every 5th Pull by ledger count goes at an exploration cell.** Count the `impl-`
rows in `.fleet/ledger.md` at Pull time; the Pull that creates row 5, 10, 15 …
is an Exploration Pull, and the router draws its cell: `k = 1 +
(sha256("<session>\t<ticket>")[0:8] mod K)` over `router-table.json`'s
`cells` minus the policy cell, in token order. Under either Objective that
policy cell is the `cost` row set's, so the draw is the same under both. While the table's `burn_in` is
true every Pull draws, over every cell, the policy cell included. An
Exploration Pull records `tier=<cell>` in the row, and a replacement inherits the row's tier —
written at the Pull's row step, ahead of `ledger.mjs dispatch`, which reads it
and prints `fleet-implementer-<cell>` as the `agent` to dispatch. A Pull the
router routes without a draw records the cell it printed as `cell=<cell>`
instead, and dispatches there the same way; `cell=` is no draw, so a row
carrying it and no `tier=` still reads as "the draw has not happened yet",
and a draw skipped on a chain head still passes to the next Pull. A `tier=` on the row decides over a
`cell=`. A row with neither runs the policy cell. The Pull's cell binds the row's implementer
(its newest, on a resumed or re-Pulled row):
`ledger.mjs row` and `ledger.mjs token` refuse a write that changes it until that implementer has
settled. Once it has, a replacement may run at another cell, set with
`ledger.mjs token <N> tier=<cell>`. The
assignment rolls to the next Pull when another open ticket sequences after
it — a ticket the rest of the run
depends on; `class` is not read. Do not tell the member it is a control: a member that
knows it is being measured is not measuring the same thing.

The cell is the one the router's printed CELL line names, the whole routing decision.
**Do not label it anywhere — the dispatch record already carries it.**

## The readout counts deliberate comparisons

**The readout counts DELIBERATE comparisons.** An earlier rule asked
only for a `session`+`role` carrying more than one distinct `model`, which any
session that happened to stage a routine ticket beside a correction one
satisfies. Measured 2026-09-12 on one corpus: 198 keys as that query was
literally written, 35 sessions across 21 `run_date`s once restricted to
implementers, against 17 real pairs across 8 — so the gate below read itself
past its floor on sessions where nothing had been controlled. Dispatch alone
is not enough either: the two rows must actually have RUN a different model or
effort, because a deliberate dispatch whose two sides resolve to the same model
(a `modelRoles` override, measured on omp 2026-09-12) controls nothing.

## Accumulate per PR, never conclude a tier result inside one run

The unit is the PR —
supply is one Pull per free slot, so there are no implementer batches. The
guard this section speaks of is SKILL.md's **Guard: accumulate per PR, never
conclude inside one run**, under **Reading a review result**.

`tier-outcomes.mjs append`
fills `run_date`, `pr`, `ticket` and `tier` itself — `tier` from what actually
ran, off the implementer's `tier-ok=` ledger verdict or else its one
member-outcomes row (a `tier-unverifiable=` member has no ledger verdict, so
its one member-outcomes row decides), and BLANK with a WARNING naming why
when neither settles
it; never type a tier in over that.
It also works `closed_own_ticket` and `minted_false_claim` out from the Charges on
the PR's first review and composes `note` from them, so you type no verdict. A PR whose
record has no Charge on a standing finding, or whose review file or record is missing,
is refused, naming what is missing: check the record again, or dispatch the fix-applier
again as a dispositions retry. Verdicts given by hand, with `--note`, are for a merged
PR whose evidence is reclaimed, and `append` refuses them on any other.

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
evolution at least as much as tier. Recount
both, and every other figure in this section, with:

```bash
grep -vc '^#' docs/metrics/tier-outcomes.tsv
awk -F'\t' '!/^#/ && $4=="routine" {n++; d[$1]=1; if($6=="no") no++} \
  END{print n, length(d), no+0}' docs/metrics/tier-outcomes.tsv
awk -F'\t' '!/^#/ && $4=="routine" {t[$5]++; if($6=="no") f[$5]++} \
  END{for(k in t) print k, t[k], f[k]+0}' docs/metrics/tier-outcomes.tsv
```

**These rows are the historical corpus, and nothing appended to them fixes the
confound.** What fixes it is the exploration draw in the dispatch rule above:
one implementer in every five — every one, during burn-in — runs at a drawn
cell beside the policy cell's, against the same prompts on the same day, so
the comparison stops depending on which tier history happened to leave in
which week. Read each cell's comparisons, not the whole-file split, once there
are enough of them.

**So read what the guard actually established: routine tickets sometimes fail to
close their own ticket. Not that `sonnet` caused it.** The revert is the
pre-committed rule being honoured, not a measurement. Restoring a cheap tier is
still the maintainer's call and still a change to the dispatch rule — but the
deliberate control it used to require is no longer something anyone has to
authorize one ticket at a time: the exploration draw above produces one in
every five Pulls by construction.

The last guard fired with n=1 on the control side. The pre-cell pair query
counted pairs that are no cell's comparisons, and the query before that one
counted every session whose implementers merely differed, so it cleared the
cell floor **Do not read a cell early** states — at least ten comparisons across five
or more distinct `run_date`s — by an order of magnitude while the controlled
comparison did not exist yet.

## Why the implementer body carries enumerate-and-declare

Why the agent body carries what it does — read this before editing any
`fleet-implementer-<cell>` file, and keep every cell's body byte-identical. Each rule in the body's
enumerate-and-declare block is load-bearing, for a different reason.
**Enumerate-and-declare** answers a signature measured four times in one run:
each implementer fixed exactly the cases its ticket named and left an adjacent
one of the same class broken — a CRLF body **broken by** the fix for depth and
split headings, a symlinked worktree after fixing locked and regular-file ones,
an unreadable `refs/heads/<type>/` after fixing `refs/heads` itself, a bracketed
file path after fixing typos and vendored ones. **All four failed to close their
own ticket** — one's acceptance criterion went unmet, and the other three left
the named defect reachable by a sibling spelling. Every one was caught by
review, at review cost, which runs 3-5x the implementation it checks.

**The identity block is what makes `sizing-a-ticket`'s fleet entry reachable.**
That skill conditions its heavy-row process on the reader being a fleet member;
a solo reader settles the open design choices with its user before planning,
while a fleet member's `## Agent Brief` already is that settlement. A member
that takes itself for a solo session waits on a user to settle design — a user
no unattended member has, so it parks rather
than fails. Nothing else you carry says what the member is — an incidental
mention of the controller is not a statement that the reader is one of its
members. That skill keeps its condition, so a solo session still runs the
interactive path; this block is what puts a member on the fleet side of it.

**Prose-first** and **wrongly-REFUSE** are not padding — they are the case
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

## Default: In-flight bound 5

`$ARGUMENTS` sets B. It becomes
the tick's `--in-flight` and `tier-roles.mjs --check --in-flight`.

**Default: In-flight bound 5, fixed for the run.** The level is set by load, not
throughput: B caps live review units (≤ open PRs ≤ B), and the review side is
about 84 % of cache-write tokens, fanning out to 1 snapshot + up to 6
specialists + 2 refuters per finding. 5 keeps worst-case review concurrency
below the former reviewer count of 6 and sits near the measured mean In flight
of 5.6. On the means that allows ≈ 1.7 merges per open-time hour against 1.89
measured, so the default does not rest on throughput headroom and the guard's
throughput test may trip on it; the merge gate saturates near 10–11, so
raising B past that buys nothing. 8 was rejected: peak review concurrency above
the former reviewer count, for a throughput gain the backlog does not show it
needs. Re-derive it from the map's guard once 20 or more PRs have merged under
it, never from one run's rows.

A deep `ready-to-merge` queue adds no rebases per PR — each PR rebases exactly
once, when it becomes the candidate — and those PRs count as In flight because
they sit between Claim and merge, not because the queue is deep.

A deep backlog is a
`DISPATCH review` on the same tick, never a reason to idle an implementer.
A starved implementer queue never stalls the review or merge side.

## Reconcile, do not wait for an event

"A slot is free and the shortlist is
non-empty" is a *level* condition — re-derive the deficit on **every** tick,
whatever woke you: a member finishing, a member bailing before implementing, a
merge landing. An edge-triggered loop that only Pulls on completion stalls
silently the moment the shortlist empties, because 0 implementers emit no
completion event.

## The rate counts Pulls, not members

**Count the rate against the ledger, because a Pull is the dispatch unit.** One Pull is one member, so a rate counted per Pull is a rate counted per member — one implementer in five, however the Pulls fall across the run — and the ledger, not your memory, is what still holds the count after a compaction.

## Why the exploration pairing is within-run

**Why one in five within the run, not a week of one tier then a week of the other:** tier would then be confounded with calendar date and therefore with prompt evolution, which is exactly the state the rows already on disk are in, and why they cannot answer the question they were collected for.

The raw split still favours the top tier — 3 failures in 11 `routine`/`sonnet` rows against 3 in 55 `routine`/`opus`. **Do not read that as a tier result.** Tier remains largely confounded with calendar date and therefore with prompt evolution: 8 of the 11 `sonnet` rows fall on 2026-08-13 to 08-17, before the window in which 54 of the 55 `opus` rows were run, and the dispatch prompts gained rules throughout. The confound is **weakened, not resolved.** Three `sonnet` rows now break it rather than one — a maintainer-authorized deliberate control (2026-08-20) and two more (2026-08-21) — all three run against prompts of the same vintage as the `opus` rows, and **all three passed**, which is the direction opposite the raw split. Three is still not a result. **What replaces this argument going forward is the within-run pairing above**: one implementer in five at the alternate tier makes tier orthogonal to date by construction, so the question stops depending on whichever rows history happened to leave. **Orthogonal to date, and to nothing else** — the alternate member is whichever ticket the 5th Pull draws, rolling past every ticket another open one sequences after, while the top tier absorbs all of those, so the pairing trades the calendar confound for a difficulty one that runs in a known direction. That is why the four covariates exist: condition a pair comparison on `sizing`/`profile`/`loc`/`files` before reading it as a tier result, never on the raw split.

## What minted_false_claim reads

`minted_false_claim` **discriminates and no longer reads "always yes"** — 20 of the 66 `routine` rows carry `no`, 18 at `opus` and 2 at `sonnet`. Read it as a property of the TICKET before the tier: a pure code simplification need not add prose, while a correction ticket adds prose by construction. The honest summary is unchanged and is the reason this paragraph exists: the guard fired on the criterion the maintainer chose in advance, not on a demonstration that the cheaper tier is worse.

## Do not read a cell early

**Do not read a cell early.** A cell's
comparison is one session holding an admissible row at that cell — its tier
check passed and its resolved effort is the cell's level — and one at
`slow-high` whose resolved model and effort differ. Count them per cell, never
pooled across cells, and stop until
there are at least ten of them across five or more distinct `run_date`s; below
that, a comparison count is a number, not evidence. SKILL.md's **Report**
reports the count `cell-readout.mjs` prints, which holds a cell below that
floor to a count on stderr.

## A Pull's entry and exits, in full

A Pull's entry is `~/.fleet/bin/fleet-run pull.mjs next --head <N>`, run from the
main checkout (without `--head`, the next shortlist entry). It runs the
mechanical steps in order and stops at each judgement with a `QUESTION
<qid>:` block and exit 10; `pull.mjs answer <N> <qid> <token> [--path <p>] [--]
[<text>…]` records the answer and resumes it. Exit 0 prints `DISPATCH {name,
agent, brief}`, the `task` call that the dispatch makes; exit 1 means the ticket left the
Pull, so take the next entry; exit 2 names what could not be looked at —
`next --head <N>` again retries a step that failed, the same `answer` again
retries one that failed while applying an answer (the question stands), and
after a router refusal `next --head <N>` starts the ticket over; exit 3 is a
usage mistake, or an answer the question does not take, and records nothing.
The record is `<scratch>/impl-<N>/pull.json`.

## No multi-select, no maintainer tick

**No multi-select, no maintainer tick.** Selection and ordering are batched —
one scan, oldest first; admission never is. The invariant this replaces — one
human decision per batch of admissions, zero unilateral grabs — is retired
is retired: zero human decisions per admission, and every non-admission is a
label or a premise the maintainer can read.
