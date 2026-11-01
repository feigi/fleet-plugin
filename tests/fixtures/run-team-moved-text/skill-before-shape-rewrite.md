---
name: run-team
description: Run an agent fleet — implementers, reviewers, one merge bot — over the ready-for-agent queue. Invoke-only; the fleet writes to a live repo and must never start unasked.
argument-hint: "[in-flight]"
disable-model-invocation: true
---

Run `next-ticket`, `review-and-fix`, `run-merge-bot` as one fleet. You are the
**controller**, in the main thread, never a member.

`$ARGUMENTS` = `[in-flight]`, optional, one positive integer, default 5: the
In-flight bound, the most tickets between Claim and merge at once. It becomes
the tick's `--in-flight` and `tier-roles.mjs --check --in-flight`.
Merge bot is at most one, not configurable.

The war story behind a rule ending `See references/<file>` lives in that file; load
it only when a member needs the *why*. A rule without that line carries its
reasoning inline — nothing is missing.

## Rules that fail silently

**A report is delivered, not implied by ending a turn.** Every member owes
the controller one report naming its outcome before it exits — including a
member whose prompt carries no explicit report line. The "report the SHA",
"report PR number" and "stop and report" instructions below *are* that
report, not a second obligation on top of it. A member that does the work
correctly and ends its turn has reported nothing: the controller learns the
outcome only by re-reading artifacts and pinging, and a finding held only in
that member's context is lost. Members did exactly this in one run —
finishers, a reviewer and merge bots alike, the work done and only the
delivery missing. Every brief's report paragraph says it. See
references/member-lifecycle.md.

**The implementer, fix-applier, finisher, merge-bot and review-runner briefs
each tell the member you do not acknowledge reports; you never write that line
yourself.** A member cannot see whether its report arrived, so silence
from you is indistinguishable from loss and it re-sends — three members did in
one run, each burning a turn, and in all three the original had in fact arrived.
Each of those templates under `briefs/` carries the line: *"The controller does
not acknowledge reports. Send once and exit; never re-send unless the controller
asks by name."*

So when a report is missing, **ask by name — that is what the "unless the controller asks by name" clause is for — and do not attribute the gap to the member until it answers.** See references/member-lifecycle.md.

The ask is the controller's move, not the member's. See references/member-lifecycle.md.

**Your OWN messages can vanish the same way, and that half is not recoverable by
a re-send.** Two controller rulings were lost in one run, both with a
`success: true` receipt: a member proceeded on its stated default and filed a
tracker issue the lost ruling had said not to file. So **never read a member's
silence as assent**, and require members to report their *confirmation state*
alongside results — "I escalated X, received no ruling, proceeded on default Y".
That sentence is the only thing that made either loss visible. After any ruling
you cannot confirm was received, re-check the artifacts it governed.

**Name every member.** The name is the ledger token and the hub address; omit
it and the ledger cannot match the member.
Names follow the unit of work: `impl-<issue#>`, `fix-pr-<pr#>`,
`review-pr-<pr#>`, `finisher-pr-<pr#>`, `merge-bot-<n>`. See
references/member-lifecycle.md.

**Fresh context per member.** One member, one unit of work, gone. Never
re-task a finished member — waking it drags the old ticket back in. Refill =
**new** member, **new** name. Sending is still right for pinging a live
member for a report it owes, or resuming a truncated reply — never for
handing a finished member the next ticket.

`hub send` to an idle peer wakes it into its old transcript the same way; re-dispatching under the same name does not reset it — omp auto-suffixes a fresh peer (`name-2`) instead.

See references/member-lifecycle.md.

**You read your instruments out of a tree every member can write to — re-check them before every gate decision.** See references/instruments.md.

- **Pin once**, at phase 0 step 0 below, from the main checkout you are
  running this from — never from a member's worktree, which is gitignored
  and carries no baseline:
  `~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run instruments.sh --pin`. On a workspace that does not
  track `plugin/…`, the pin names the plugin checkout once — `--pin --audit
  <plugin-checkout>` — and every check after it follows the recorded tree.
- **Re-check before you act on any instrument reading** — a SHA acceptance, a CI
  verdict, the reconcile, a reap, a label gate — from that same main checkout:
  `~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run instruments.sh`. **Exit 0 is the only code that
  lets a gate proceed. Exit 1 (the set changed) and exit 2 (the check could not
  answer) both refuse: report what it printed and do NOT re-read the
  instrument** — a guard that fails open on "could not look" protects nothing.
  **A label gate and a CI verdict are also taken by dispatched members, not
  only by you** — the finisher labels, and the merge bot merges on its own
  reading — and neither is dispatched to read this file, so neither can be
reached by stating the rule here. Each carries its own copy: the finisher's
in the instrument re-check block of `agents/fleet-finisher.agent.md`, the merge bot's inside
`merge-gate.mjs`, step 3 of `run-merge-bot.md`.
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
shares, so ordinary work moves refs several times a run and a per-gate
refusal on that is noise.

**A member runs its test suite in the foreground and blocks on it.** See references/member-lifecycle.md.

**The scratch root is computed, never invented and never recorded.** No harness
supplies a scratch directory to a member, so a member left to name its own
invents one — and the liveness read below, which looks at the files under the
directory a member's own prompt assigned it, then watches a directory nobody
else can find. You run `~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run scratch-root.mjs`: it prints one
absolute path, `~/.fleet/scratch/<repo-key>/`, the same from the main checkout
and from every linked worktree, and the same again when a compacted or
re-invoked controller runs it, so nothing writes it down. It exits non-zero,
with its reason, when the root would sit inside a git work tree that does not
ignore it; that is an environment to fix, not a cue to pick another root.
`<scratch>` in this file is that path, resolved before you send anything: every
brief that carries one carries the absolute path you passed it — an
implementer's `<scratch>/impl-<N>/`, the recipe deriver's
`<scratch>/derive-recipe/`, a fix-applier's, a finisher's and a merge bot's
`<scratch>/pr<N>/…`, and a review runner's `scratch` argument, which is the
root itself. A member whose prompt names no path asks you by name and never
makes one up.

## Shell traps

Monitor and Bash commands run under **zsh**, and the shell in this file is
prescriptive — copied verbatim into a watcher or into the merge bot's agent
body. So every trap here is a zsh-vs-bash difference that ships as a
green-looking gate: correct in the shell you tested in, silently wrong in the
one it runs in. Phase 3's monitor paragraph points here instead of restating
any of it. The merge bot's agent body is the one place this block is copied
whole (see **Merge bot**); the other deliberate copy is named at the end.

**zsh word-splits an unquoted command substitution's result; it does NOT split an unquoted parameter expansion.** See references/shell-traps.md.

**Word the rule against the first row.** See references/shell-traps.md.

**Capture-then-loop needs `while IFS= read -r` fed by a heredoc**, which is
line-exact under every shell:

```sh
while IFS= read -r pr; do
  [ -n "$pr" ] || continue                        # a blank line from an empty capture, not a probe that could not look
  node …/ci-state.mjs --pr "$pr" </dev/null      # every inner call, per the trap below
done <<EOF
$prs
EOF
```

The inline `$(printf '%s\n' "$prs")` form splits correctly too and is what Phase 3's block uses, but it splits on *every* whitespace character, so it is safe only for values that cannot contain one — PR numbers cannot, branch names and paths can. See references/shell-traps.md.

**`</dev/null` every command inside a `while read` loop.** See references/shell-traps.md.

**A probe that could not look emits an event; it never `continue`s.** Stated in
full at *A probe that cannot read is a transition event, not silence* in Phase 3,
and it binds every watcher in this file rather than that one block: the third
value beside pass and fail is what turns a broken loop into a loud failure
instead of a quiet one. A guard that drops an unreadable probe — `[ -n "$json" ]
|| continue` — makes *could not look* indistinguishable from *nothing to report*.

**`$?`/`PIPESTATUS` is unconditionally-TRUE in zsh.** zsh has no `PIPESTATUS`
(its array is lowercase `pipestatus`, 1-indexed), so `${PIPESTATUS[0]}` is always
empty and `[ "" -eq 0 ]` passes. A bot's merge gate opened without ever reading
an exit code.

**`status` is a READ-ONLY variable in zsh**, an alias for `$?`. Name the variable anything else (`ci_status`). See references/shell-traps.md.

**The other deliberate copy is `env $cfg sh ./probe.sh`.** The first trap's
mechanism bites argv as well as loops, and that instance stays written out in the
fix-applier body and every refuter brief rather than here,
because the seats that inject faults are the ones that need it and a bot reads
gates without ever injecting one. Do not fold it into this block, and do not
restate this block there.

## Phase 0 — shortlist

Once per run, at start. Supply is automatic after that: the tick
refreshes the Shortlist itself, and every admission is a **Pull** — one ticket
into one free implementer slot, the moment it frees (phase 1). Nothing in this
phase, or in any later one, asks the maintainer which tickets to take.

0. **Once per run, before anything else.** Run `~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run
   phase0.mjs --session <session-dir>` from this main checkout, `<session-dir>`
   being this run's own session directory. Add `--in-flight <n>` when
   `$ARGUMENTS` gave one, `--plugin-checkout
   <dir>` when this workspace tracks no `plugin/…` of its own, `--spend-dir
   <dir>` to name the directory the cockpit's spend panel reads, and
   `--workflow <name>` or `--declare-no-ci` when the repository has no workflow
   named CI. It runs the start sequence in its fixed order — branch,
   fast-forward, pin, baseline, preflight, ruleset, tier-roles, metrics,
   cockpit, rotate, reclaim, recipe, fold-in, stranded, shortlist — prints one
   `phase0: <step>: <status>` line per step with the `NEED` lines last, and
   records each step in `.fleet/phase0.json`, which the tick reads: it prints
   `PHASE0-INCOMPLETE` and holds every dispatching row until the receipt is whole.
   Dispatch nothing before it exits 0. Exit 3 is a step that failed: its line
   carries the refusal, so fix the cause and run it again. Exit 4 is a step
   that needs you: act on each `NEED` line below, then run it again. Once
   `rotate` has run, a re-run skips every `ok` step and resumes where the last
   one stopped; before it, a re-run runs every step again.

   The `tier-roles` step runs `~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run tier-roles.mjs --check
   --in-flight <B>`, `<B>` being the `--in-flight` given, else the default
   **Defaults** (**Queue depth**) states. What it checks is under **Phase 2**'s
   tier routes. A line it prints on a pass about omp's `task.maxConcurrency`
   is a notice in the step's output and never holds: read it, report it, and
   go on — the fleet never writes that setting.

   - `NEED derive-recipe` — the Recipe cache holds nothing valid. Dispatch a
     `task` member named `derive-recipe`, agent `fleet-recipe-deriver`, its
     prompt the brief `~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run dispatch-prompt.mjs render
     recipe-deriver --member derive-recipe --repo <repo> --scratch <scratch>`
     prints (`<repo>` this main checkout's absolute path, `<scratch>` what
     `scratch-root.mjs` prints), and wait for its report. `RECIPE PROVEN` →
     run `phase0.mjs` again. `RECIPE NOT PROVEN` → stall: report `STALL —
     Recipe not proven: <cause>` to the maintainer with the deriver's reason
     verbatim, and claim, Pull and review nothing.
   - `NEED resume #<n> <worktree> <branch>` — a dead run's claim with no PR.
     Dispatch a stranded `impl-<n>-b` the ordinary way (record it with
     `ledger.mjs row`, render its brief, `ledger.mjs dispatch`, the `task`
     call, the tier check), in that worktree and branch, and never with
     `claim-ticket.sh`: the claim stands. A re-run finds the need met once its
     row is written. A `report #<n> — <why>` line is the maintainer's and
     nothing else, and a `carried` line is a live token to reconcile first.
   - `NEED review PR#<pr> (closes no issue)` — an open PR a prior run left
     that no row can queue. Advice, never an exit status: hand-dispatch its
     review exactly as ticket work, or leave it.

   A `drift` or `unanswered` ruleset step is advice too: surface the diff and
   go on. See references/phase-0.md.

1. **Build the Shortlist** — `~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run shortlist.mjs`, then read
   `.fleet/shortlist.json`. The script runs the cheap filters and nothing else
   — no ticket body is read here, because a Pull reads one ticket in full at
   the moment it admits it:

   - **Candidate scan** — `candidates.mjs --require-label ready-for-agent
     --with-dropped`, oldest-first, never re-ranked. Its row count is
     `scanned`, the supply; the rows its to-spec filter removed are
     `dropped`, counted nowhere.
   - **Dependency scan**, `next-ticket` step 2, on each row's `d` array. Open
     blocker → drop.
   - **Live Exclusions** — a ticket whose ledger row reads `excluded ·
     behind-pr:#M` or `excluded · behind-issue:#M` stays out while its premise
     holds (references/pull.md, **Exclusion**).
   - **In-flight check** — `inflight.sh <N>` per survivor. Exit 1 is taken, and
     any other non-zero exit is a check that could not answer, which is never
     free. Both drop the ticket, logged by number.

   It writes the survivors, in order, to `.fleet/shortlist.json` —
   `{scanned, shortlist: [{n, t}], dropped: [{n, reason}]}` — resolved against the git common dir by
   `fleet-dir.mjs`, the one locator `ledger.mjs` resolves `.fleet/ledger.md`
   with too, so you, the tick and a member in its own worktree all name one
   file. **Exit 0 is the file written,
   an empty shortlist included** — the empty queue is an answer. **Exit 2 is a
   refusal**: the scan, the ledger read or the write did not answer, and the
   previous file stands untouched, because an empty file written then would
   read as "no work". Never read 2 as empty.

   Every probe fails CLOSED: an unreadable blocker counts as open, an
   unreadable premise leaves its exclusion standing, an unanswered in-flight
   check counts as taken. A ticket dropped wrongly waits one refresh; a ticket
   admitted wrongly costs a Pull's full read at best and two members on one
   ticket at worst.

   **`--require-label ready-for-agent` mandatory, no fallback** — the script
   fixes it, and you never run `candidates.mjs --allow-fallback` by hand to
   widen the list: `ready-for-human` needs a human to brainstorm first and you
   have no channel to one mid-flight.

   `candidates.mjs`'s exit 3 reaches you as an empty shortlist whose `dropped`
   names every ticket the to-spec filter took, by number and reason — and the
   tick prints the same list on every tick, `specs-dropped=#<N> (to-spec: User
   Stories heading)` on the implementer row. **Exit 3 is not that empty queue, and never a reason to
   widen the net.** It says the labeled query returned rows and the to-spec
   filter took every one: what is queued is to-tickets' input rather than
   claimable tickets, and a member handed one implements an entire spec as a
   single ticket. Log it as
   specs awaiting to-tickets, not as no work — read the numbers off
   `dropped` or `specs-dropped=`, not off stderr, which the tick's own
   refresh discards — and still do not pass
   `--allow-fallback`, whose second pass is unfiltered and so reaches the
   `ready-for-human` and untriaged work you have no channel for. A partial
   drop, survivors and specs together, is named the same way.
2. **Refresh is the tick's from here on.** `fleet-tick.mjs` runs
   `shortlist.mjs` itself when unclaimed entries fall below the In-flight
   bound, when the file is missing or empty, when an `excluded` premise has
   lifted, and when a branch-named `behind-pr` exclusion whose PR is not yet
   MERGED or CLOSED, or a `behind-issue` exclusion whose issue is not yet
   closed, names a ticket the file still carries, and prints
   `REFRESHED shortlist: <n> entries; <k> lifted`. Phase 0 runs it by hand
   once because a dead run's shortlist is stale by definition.
   None of those triggers runs while `HOLD (in-flight <n>/<B>)` stands
   (**Queue depth**).

**No multi-select, no maintainer tick.** Selection and ordering are batched —
one scan, oldest first; admission never is. The invariant this replaces — one
human decision per batch of admissions, zero unilateral grabs — is retired
is retired: zero human decisions per admission, and every non-admission is a
label or a premise the maintainer can read.

## Phase 1 — Pull: judge, then claim or relabel

Serial, main checkout, one Pull at a time. Never parallel, never inside a member —
concurrent `worktree add` and label writes race.

A Pull's entry is `~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run pull.mjs next --head <N>`, run from the
main checkout (without `--head`, the next shortlist entry). It runs the
mechanical steps in order and stops at each judgement with a `QUESTION
<qid>:` block and exit 10; `pull.mjs answer <N> <qid> <token> [--path <p>] [--]
[<text>…]` records the answer and resumes it. Exit 0 prints `DISPATCH {name,
agent, brief}`, the `task` call phase 2 makes; exit 1 means the ticket left the
Pull, so take the next entry; exit 2 names what could not be looked at —
`next --head <N>` again retries a step that failed, the same `answer` again
retries one that failed while applying an answer (the question stands), and
after a router refusal `next --head <N>` starts the ticket over; exit 3 is a
usage mistake, or an answer the question does not take, and records nothing.
The record is `<scratch>/impl-<N>/pull.json`. See references/pull.md for what
each step does, and why.

**The tick's `PULL` rows name the command.** One free implementer slot is one
Pull, and each head a free slot Pulls gets its own row, read off that head's
`pull.json` and never folded:

| Row | Where the Pull stands |
|---|---|
| `PULL #N — pull.mjs next --head N` | none of this run's in progress — `next` starts it, or resumes one a failed step left |
| `PULL #N (Q2 pending — pull.mjs answer N decided …)` | a question stands: answer it; `next --head N` prints it again |
| `… (stale)` appended | that question has stood longer than `--pull-stale-minutes` (120 by default) |
| `PULL #N (dispatched, row missing — ledger.mjs row N "…")` | dispatched, yet the head holds no `impl-` row: write the row it names |

A head whose Pull already ended in this run — the ticket left, or the router
refused it and its claim was released — gets no row: `next` without `--head`
skips it, `next --head <N>` would start the ticket over, and the next head
fills the slot.

**The questions**, each answered with `pull.mjs answer <N> <qid> <token> …`:

1. **`staleness` (Q1)** — `gone --path <p> [--] <string>`, the string the fix
   must remove from `<p>` on `origin/main`, or `present --path <p> [--]
   <string>`, the string it must add: each runs `staleness.mjs` and asks again.
   `none <why>` (no string settles it) and `done` end the question.

   **Grep for the ticket's ASKED-FOR CHANGE, not only its subject construct** —
   the construct check passes on every stale pin ticket, because the construct
   is what the pin is *about* and never went anywhere. So for a ticket asking
   for a pin, test or assertion, grep the **test file** for the assertion it
   wants; for one asking for exact wording, grep the **old** wording the ticket
   quotes as wrong, never the new wording it proposes. A proposed replacement is
   a suggestion the implementer is free to reword — an equivalent rewording
   satisfies the ticket while failing a grep for its literal text — and the
   quoted defect is the fact.

   `staleness.mjs` answers each `gone` and `present` in three values:

   | Exit | Verdict | What it does at the Pull |
   |---|---|---|
   | 0 | still reproduces | admit it |
   | 1 | provably fixed | do not admit; close citing the payload's `commit` and `subject` |
   | 2 | could not check | admit it, **and say the probe could not check** |

2. **`close` (Q1b)** — asked when the probe exits 1 naming a commit: `yes`
   closes the issue with a comment citing the commit and its subject; `no
   <why>` keeps the ticket and asks Q1 again.
3. **`decided` (Q2)** — `decided`, `needs-triage <the missing decision>`,
   `ready-for-human-fork <the options, verbatim from the brief>` or
   `ready-for-human-hands <external access|manual testing|judgment> <one
   line>`; any but `decided` posts that cause's comment and replaces
   `ready-for-agent` with its label.

   **Decided?** Would two competent implementers, reading only this ticket, build
   materially different things? "Material" by inventory, not feel:

   | Left open | Verdict |
   |---|---|
   | architecture, API shape, schema, UX | **undecided** |
   | new dependency, new seam | **undecided** |
   | naming, file layout, ordering, test arrangement | decided — ignore |

   Any undecided item → not decided. Name it; that name is the relabel comment's
   missing decision or open fork. **Torn → surface, never guess**: relabel it
   `ready-for-human` as a fork naming the open decision — the label is how a
   Pull surfaces it to the maintainer. Opposite of
   `sizing-a-ticket`'s *torn → take the heavier row*, deliberately — see that skill.

4. **`collision` (Q3)** — asked after the scan prints one line per open PR or
   live worktree branch sharing a path with the brief (`no overlap` when none,
   `could not look: <which>` for one it could not read) and the brief's `Out of
   scope` `#N` refs as candidates: `clear`; `behind-pr:#M`, an open PR or a
   branch with no PR yet by its name; `behind-issue:#M`, an open issue that
   section sequences this one after; or `paths <p>…`, which scans again.

**A Pull never re-admits a ticket already relabelled**: the issue step reads the
labels fresh and exits 1 `relabelled elsewhere` once `ready-for-agent` is gone.

**The exit table** — how a Pull ends, and what follows:

| `pull.mjs` | At the Pull | Then |
|---|---|---|
| 0 `DISPATCH {…}` | decided, live, free, claimed, routed; row, brief and dispatch recorded | the `task` call (phase 2) |
| 1 `LEFT #N: taken …` | in-flight hit, an in-flight check that could not answer, or `claim-ticket.sh` exit 2 | next entry |
| 1 `LEFT #N: relabelled elsewhere` | no longer labelled `ready-for-agent` | next entry |
| 1 `LEFT #N: closed: fixed by …` | `close` answered `yes` | next entry |
| 1 `LEFT #N: relabelled <label>: …` | `decided` answered with a cause | next entry |
| 1 `LEFT #N: excluded · behind-…` | `collision` answered `behind-pr:#M` or `behind-issue:#M` | next entry |
| 1 `EMPTY` | the shortlist holds no entry to pull | run `shortlist.mjs` once and Pull again; still empty, hold the slot idle until the next refresh trigger |
| 2 | could not look, named on stderr | as the entry paragraph says |
| 3 | a usage mistake, or a token the question does not take | correct it; nothing was recorded |
| 10 `QUESTION <qid>:` | a question pending | answer it |

Relabelling by cause, exclusion rows and claiming are in references/pull.md; a
worktree re-created for an already-open PR is in references/isolation.md.

## Phase 2 — dispatch the Pull's implementer

**A Pull is one claim followed by one dispatch of a new member under a name no
member has held; nothing holds a queue.** The In-flight bound is the fleet's
own accounting rather than anything the runtime enforces, and the member is
fresh and never a wake of one that already ran. Admission is per slot and
never batched, so there is nothing to hand a freed slot its next ticket but
the next Pull.

a Pull dispatches its member with one more `task` call — `agent` the definition `ledger.mjs dispatch` printed for it (below); name `impl-<N>`; in the background, so its report arrives on its own.

**No workpool, and no kernel-resident handle.** A pool's only refill virtue —
handing a queued item to a freed worker without a controller turn — is exactly
what a Pull forbids, and its completions never arrive per member. `eval`'s
`agent()` is not the omp call either: a kernel-resident handle dies with the
kernel and needs a `wait`, while a `task` job is process-level and its report
auto-delivers on its own, like every other member's.

**No per-call tier or effort anywhere on this path**: tier stays the agent
definition's own frontmatter, whichever `fleet-implementer-<cell>`
definition the Pull names, and a member's Resolved tier stays readable from its transcript.

**Claim what you are about to dispatch, and dispatch it at once**: `pull.mjs`'s
claim step runs `claim-ticket.sh`, its route, row, render and dispatch steps
follow in the same command, and your `task` call follows its `DISPATCH` line.

**The dispatch is recorded before you make it**: `pull.mjs`'s row step writes the
row, its render step renders the brief and its dispatch step runs `ledger.mjs
dispatch`, whose `agent` and `brief.path` its `DISPATCH` line prints as `agent`
and `brief`.

**The prompt carries only what varies**: `pull.mjs`'s render step fills the
implementer brief's placeholders from the Pull's own read, and the agent body
carries everything shared, so never re-paste it.

**The prompt pastes the Pull's own read of the ticket rather than telling the
member to re-fetch it, and this still costs one `gh issue view` per ticket,
never one per member.** The fresh-context design's isolation rationale — "every
implementer re-reads its Agent Brief... from scratch"
— is about a member
never inheriting another ticket's context, not about where the bytes come from.
Pasting the Pull's own read into the prompt keeps that: the member still gets the
brief verbatim and re-derives nothing from a sibling. What it drops is the
unconditional re-fetch of an issue the controller already has open, on every
dispatch — the fetch the agent body still carries is the backstop for a brief
that turns out to be insufficient, not the default path.

**A member settling with nothing is not, by itself, a bail.** Each member's
outcome arrives as its own job status. Settle (CONTEXT.md § Coordination) is
three states on omp — `completed`, `failed`, `cancelled` — and reading
`failed`/`cancelled` the same as a `completed` turn that had nothing to report
is the exact collapse this line blocks: a member that died never chose to bail,
so demoting its ticket on its silence demotes a ticket its member never got the
chance to judge. Confirm death first, exactly as the Member-killed row does
(Failure handling, below) — its mtime discriminator, never silence alone.
**Only an explicit bail report — the member itself naming the cause — reaches
Implementer bails before implementing** (phase 3, below); a died or
merely-quiet member's silence never does. A confirmed-dead member recovers
exactly as the Member-killed row says — new member, new name, the SAME ticket —
never a demotion.

**Dispatch every implementer with the `agent` that `ledger.mjs dispatch`
printed, and still omit `model` on the `task` call.** The
tier lives in that definition's frontmatter (`agents/fleet-implementer-<cell>.agent.md`;
`slow-high`, the policy cell, for a row with no `tier=`), which is what an
omitted `model` takes first — the session's tier applies only when the definition
names none, and a member dispatched with `model` set does not get the declared
tier back. Omitting `model` is therefore still the mechanism; what changed is
that the tier it resolves to is now declared and pinned rather than inherited by
accident. Keep `name: impl-<N>`: the name is what makes a member, and both the
spend classifier and `member-outcomes.mjs` read it.

**After every Pull's dispatch, the tier check runs — a scripted step, never a
prose reminder.** `tick --apply` runs it itself, a batch of one apiece, on every
implementer it would print `HOLD (tier unchecked impl-<N>)` for, `session` off
the phase-0 receipt, and prints `APPLIED tier-check impl-<N>: <verdict>`. By
hand it is `~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run tier-check.mjs --batch <path-to-batch.json>`,
which judges the implementer just dispatched on the ledger's terms. The definition it
should have run under comes off its ticket row's `tier=` token: none means the
policy cell, `fleet-implementer-slow-high`; `tier=<cell>` means
`fleet-implementer-<cell>` — the same mapping `ledger.mjs dispatch` prints its
`agent` from, so a call that names the printed `agent` passes this half. It
fails the member two ways, one line each —
`member: dispatched <agent>, expected <definition>` when its transcript says
it was dispatched as anything else (a generic `task` dispatch fails even when
its model happens to match), and `member: declared <m>/<l> resolved <m>/<l>`
when the harness resolved a different model or level than that definition
declares. The verdict lands on the ledger either way, written by the check
itself: exit 0 appends `tier-ok=impl-<N>:<definition>` to the row, once
however often it runs; exit 1 runs `ledger.mjs settle impl-<N> tier-mismatch`
— or, for a member already settled another way, which `settle` will not
re-settle, appends `tier-mismatch=impl-<N>:<definition>` instead. Exit 3 is
the third verdict, `tier-unverifiable=impl-<N>:no-transcript`, appended once
for a member settled `killed` or `released` anywhere on the ledger — a row
or `## Dispatched` — whose `session` names an existing directory holding no
`<member>.jsonl`: a dispatch that failed before a transcript was written. It
says nothing about the tier and only clears the unchecked hold. Exit 2
writes nothing — a usage error, which includes a LIVE member with no
transcript; a member settled `PR#M`, `bailed` or `tier-mismatch` with none,
which ran, so the `session` is the wrong directory — pass the one that
dispatched it; a session directory that cannot be searched; and a `session`
that is omitted, empty, or not an existing directory, live member or settled.
A batch holding both a mismatch and an unverifiable member exits 1.

**The tick holds the next Pull until that verdict exists.** Dispatching the
next member on top of an unchecked or mismatched dispatch multiplies whatever
silently degraded. The tick prints `HOLD (tier unchecked impl-<N>)` for the
newest `impl-` member of a ticket whose row carries none of the three
verdicts, whether that member is still running or already settled `bailed`,
`killed`, `released` or `blocked`, and `HOLD (tier mismatch impl-<N>)` for a mismatched
one. Only the newest member counts, so a replacement (`impl-<N>-b`) is what
clears a mismatch — and is then owed its own check. A mismatch on a ticket
whose issue is already CLOSED holds nothing: the tick probes that issue and
drops it, since there is nothing left to replace. The tick reads no transcript
itself: `tick --apply` runs the check, and an unchecked hold it leaves is
cleared by running the check on that member by hand. A
settled member's check works only when its transcript exists;
without one, the verdict is `tier-unverifiable` for a member settled `killed`
or `released`, and exit 2 naming the wrong session for any other. Clear a
mismatch by fixing the definition or the dispatch and dispatching the
replacement at the right tier.

**After `/resume`, a carried implementer can hold the whole tick.** A live
implementer rotate carried forward with no verdict on its row is unchecked,
and once this session has been reopened with `/resume` its transcript sits
under the earlier session's directory: the check given this run's `session`
finds no `<member>.jsonl` and exits 2, writing nothing. `HOLD (tier unchecked
impl-<N>)` then stops the whole tick, not only that member's ticket. It
clears once the member settles: one settled `killed` or `released` gets
`tier-unverifiable=` from the same check, and one settled any other way ran,
so pass the directory that dispatched it, as above. Until it settles,
follow the carried token's reconciliation in references/phase-0.md, the
"Resume the claims a dead run left without a PR" section, under its
`prior: ancestor` branch: `proc://` reads `running` → wait; dead → the
Member-killed row.

**Run the check right after the dispatch, and never reinstall the plugin or
change `modelRoles` while any member is unchecked.** The check reads the
installed definition and the live `modelRoles` at check time, not at
dispatch time, so a late check judges a member against a tier it was never
dispatched under.

**The batch file is a JSON array, one entry per dispatched member** — under
Pull, a batch of one, the member just dispatched: `{member}`.
`member` is the AgentId the dispatch returns (`impl-<N>`). An entry that
names neither `session` nor `transcript` takes the session directory phase
0's receipt `.fleet/phase0.json` records, and is exit 2 naming the receipt
when it records none; the check reads the member's own
`<session>/<member>.jsonl` directly, so a member with no assistant turn yet
still resolves off its dispatch-time record. A `session` the entry gives
wins over the receipt's; a caller already holding the exact transcript path
may give `transcript` instead. The agent type an implementer was dispatched
as lives only in its transcript. `resolvedModel`
**and** `resolvedThinkingLevel` together — the dispatch's own job record —
may ride beside it and are preferred for the model and level. An `impl-`
entry carries no `agentFile`: its definition is the row's, never the
caller's. `transcript`/`session` resolve relative to `--repo` (defaults to
the plugin's own root), and the check reads and writes the run's own ledger
unless `--ledger` names another.

**The declaration is `model: "@<role>:<level>"` — a fleet tier route, never
a vendor id.** `@slow`, `@task`, `@smol` resolve through the operator's
`modelRoles`, so an install with no Anthropic model still runs the fleet
at whatever each role points at; the explicit `:<level>` suffix wins over
the role's baked one, and the tier check judges a member against the
role's own target (`modelRoles.<role>`), never a model family.

Before the run's first dispatch run `~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run tier-roles.mjs
--check --in-flight <B>`, `<B>` the run's In-flight bound (phase 0's
`tier-roles` step runs it); exit 1 names every definition whose `model:` is not a route,
every unset `modelRoles.<role>` a definition needs, every definition whose
`:<level>` its role's target does not run at (omp's model catalog — omp
would clamp it silently), except an implementer definition whose cell the
router never selects (not in `router-table.json`'s `cells` or `rows` values,
and not the policy cell), which is a notice and never stops the run; every
`task.agentModelOverrides` entry that would shadow a fleet definition, and
an `--agents` directory holding no `*.agent.md` definition,
prints the exact remedy, and **stops the run** before any member is
dispatched — the fleet reads that config and never writes it. omp's
`task.maxConcurrency` is not the bound (it counts live members, not tickets,
queues at its ceiling rather than refusing, and is session-wide): below
2·B+2, or when it cannot be read, the check prints a notice line and still
exits 0, so the notice is the operator's to read and report, never a reason to
stop the run.

**Every 5th Pull by ledger count goes at an exploration cell.** See references/pull.md.

**The router's arguments, and nothing past its line.** `--impl-row` is the
row count the Pull creates — or, while an assignment is rolling (the latest
row 5k and every row after it carry no `tier=`), that row's number;
`--chain-head` marks a ticket another open ticket sequences after, which is
what rolls it. `--arm` is `A` for an even ticket number and `B` for an odd
one; a B Pull routes exactly as an A one until the table opens arm B.
`--session` is this run's own session directory. The printed line is the
whole routing decision — never re-derive `CELL` from the table, the guard or
this paragraph. A missing or unreadable `.fleet/cost-guard.json` routes the
default cell only (`REASON=guard-missing`), burn-in included, and `REASON`
other than `ok` goes on the row as `route=<REASON>`, nowhere else.

**Count the rate against the ledger, because a Pull is the dispatch unit.** One
Pull is one member, so a rate counted per Pull is a rate counted per member —
one implementer in five, however the Pulls fall across the run — and the
ledger, not your memory, is what still holds the count after a compaction.

**Do not label it anywhere — the dispatch record already carries it.** A
cell's comparisons are a query, and `cell-readout.mjs` is that query: it joins
`docs/metrics/ticket-features.tsv`, whose `chosen_cell` names the cell the
router chose, to `docs/metrics/member-outcomes.tsv` on `session`+`agent`, and
admits a row only when its `subagent_type` is that cell's
`fleet-implementer-<cell>` definition and its `effort` is the cell's level.
That column is the record of what each member was dispatched AS, scraped like
every other column, so it survives the file's regeneration and mislabels no
historical row — the pre-cutover `fleet-implementer` and
`fleet-implementer-alt` rows are no cell's, and the readout never admits them.
A hand-set column would fail both of those tests, and one derived against
today's declared tiers would mislabel every historical row.

**The readout counts DELIBERATE comparisons.** See references/pull.md.

**Why one in five within the run, not a week of one tier then a week of the other:**
tier would then be confounded with calendar date and therefore with prompt
evolution, which is exactly the state the rows already on disk are in, and why
they cannot answer the question they were collected for.

The raw split still favours the top tier — 3 failures in 11 `routine`/`sonnet`
rows against 3 in 55 `routine`/`opus`. **Do not read that as a tier result.**
Tier remains largely confounded with calendar date and therefore with prompt
evolution: 8 of the 11 `sonnet` rows fall on 2026-08-13 to 08-17, before the
window in which 54 of the 55 `opus` rows were run, and the dispatch prompts
gained rules throughout. The confound is **weakened, not resolved.** Three
`sonnet` rows now break it rather than one — a maintainer-authorized
deliberate control (2026-08-20) and two more (2026-08-21) —
all three run against prompts of the same vintage as the `opus`
rows, and **all three passed**, which is the direction opposite the raw split.
Three is still not a result. **What replaces this argument going forward is the
within-run pairing above**: one implementer in five at the alternate tier makes
tier orthogonal to date by construction, so the question stops depending on
whichever rows history happened to leave. **Orthogonal to date, and to nothing
else** — the alternate member is whichever ticket the 5th Pull draws, rolling
past every ticket another open one sequences after, while
the top tier absorbs all of those, so the pairing trades the calendar confound
for a difficulty one that runs in a known direction. That is why the four covariates
exist: condition a pair comparison on `sizing`/`profile`/`loc`/`files` before
reading it as a tier result, never on the raw split.

`minted_false_claim` **discriminates and no longer reads "always yes"** — 20 of
the 66 `routine` rows carry `no`, 18 at `opus` and 2 at `sonnet`.
Read it as a property of the TICKET before the tier: a pure code simplification
need not add prose, while a correction ticket adds prose by construction. The
honest summary is unchanged and is the reason this paragraph exists: the guard
fired on the criterion the maintainer chose in advance, not on a demonstration
that the cheaper tier is worse.

`row` **replaces the whole line**, it does not append. To add a token to a row
that exists — `ci=`, `held-behind:#M`, `conflict-hold:#M`, `label-off=`, `ports=`
— run `ledger.mjs token <key> <token>…`, which keeps every token already on the
row and takes a PR's number as the key. A `row` over a row that already carries
`KILLED`, `ports=` or `→ PR#` must repeat those tokens or they are gone, and its
stderr, `rewrote row #N; dropped: <token>…`, names each token it lost.

`ledger.mjs read` is safe on a pipe as well as a redirect: its payload used to
be abandoned at the pipe buffer and still exit 0, which is what left `board.mjs`
reporting `ledger read parse failed` and serving a blind cockpit for a whole run.
Every use above is a recovery path, so a payload that arrives short
lands exactly where a settled `ruled:` is unrecoverable — which is why the
script's own suite pins that `read`, `row`, `filed` and `ruled` each reach a
pipe whole.

`check` reaches a pipe whole at both of its exits too. Its ALREADY FILED exit
sits mid-branch, where falling through would run the near-miss ranking and the
tracker search that exit exists to skip — so `check`'s branch is a function now,
where `process.exitCode` carries the code and a `return` is what skips them.
No payload this script prints is abandoned to `process.exit()` any more,
and the suite drives both of `check`'s arms through a pipe on a payload the
ledger sizes rather than argv. So trust that payload — and read `verdict`,
because a searched-and-clean tracker and one that was never read share exit 0.

The consumer side raised its cliff rather than removing it. `board.mjs` reads
`ledger.mjs read` with an explicit `maxBuffer`, so a payload past node's
default is carried rather than killed mid-flight and reported as an
unreachable tool — which is how the blind cockpit came back at HTTP 200 even
after the pipe cut was gone. That cap is deliberately bounded, so a
payload past it lands in the same blind cockpit — and so does a ledger that
cannot be read at all, at any size. The read fails open to an empty ledger, and
`board.json`'s `ledgerState` field now distinguishes a read that failed or
didn't parse from one that succeeded (`unread`/`unparsed`/`read`) —
`spend` in the same payload carries its own error the same way. Zeroes
on the cockpit are not yet proof the pipeline is idle.

**Guard: accumulate per PR, never conclude inside one run.** The unit is the PR —
supply is one Pull per free slot, so there are no implementer batches. **Append one row to
`docs/metrics/tier-outcomes.tsv` when you rule each PR's review, with
`~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run tier-outcomes.mjs append <pr> --closed-own-ticket yes|no --minted-false-claim yes|no --note "<text>"`,
never by hand** (that file's header carries the column meanings). The script
fills `run_date`, `pr`, `ticket` and `tier` itself — `tier` from what actually
ran, off the implementer's `tier-ok=` ledger verdict or else its one
member-outcomes row (a `tier-unverifiable=` member has no ledger verdict, so
its one member-outcomes row decides), and BLANK with a WARNING naming why
when neither settles
it; never type a tier in over that. A PR that already has a row is left
untouched, so re-running it is safe. That append is the whole duty.

The row's last four fields are the ticket's difficulty, and they are what lets a
tier comparison condition on the thing that swamps it. `sizing` is the
**member's** own `light`/`heavy` verdict from its phase-2 `sizing-a-ticket`
run, which `append` reads itself off the member's report file
(`<scratch>/reports/impl-<ticket>[-x].json`, its `sizing.verdict`, the highest
retry letter's when there are several), so you pass no `--sizing`; the member
also puts it in the PR body's `Sizing:` line, with the signal it turned on;
`profile`, `loc` and `files` all come from `diff-stats.mjs` over the merged
diff. **Phase 0 does not size anything** — it shortlists, a Pull claims, and
the sizing run happens inside the member after both, which is why the verdict
has to travel in the member's report rather than being something you already hold.

**A verdict is a measurement only if it post-dates the run that produced it.** See references/reviewers.md.

The member-facts scrape, the drain of the pending ticket-features rows and the
commit of the metrics files are steps of `closeout.mjs finish`, which **End of
run** (Phase 3) drives. See references/close-out.md.

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
every five Pulls by construction. **Do not read a cell early.** A cell's
comparison is one session holding an admissible row at that cell — its tier
check passed and its resolved effort is the cell's level — and one at
`slow-high` whose resolved model and effort differ. Count them per cell, never
pooled across cells, and stop until
there are at least ten of them across five or more distinct `run_date`s; below
that, a comparison count is a number, not evidence, and the last guard fired
with n=1 on the control side. **Report the count the per-cell readout prints,
never one from any other query:** `~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run cell-readout.mjs`
prints `<cell> <comparisons> <run_dates> <resolved models>` for each cell past
that floor and a cell below it only as a count on stderr; a `mixed (…)` models
column means the cell's history spans more than one model behind its role.
The pre-cell pair query counted pairs that are no cell's comparisons, and the
query before that one counted every session whose implementers merely
differed, so it cleared this floor by an order of magnitude while the
controlled comparison did not exist yet.

Why the agent body carries what it does — read this before editing any `fleet-implementer-<cell>` file, and keep every cell's body byte-identical. See references/pull.md.

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
merge bot, Pulling a ticket, re-verifying a SHA, filing a follow-up — all proceed
unconfirmed. Invoking the command was the opt-in. One exception: **a judgement the
evidence cannot settle**.

**Rule: record, tick, act, beat.** Every wake — a member report, a review
notification, a label, a CI run reaching a terminal state, a `CONFLICT` line, a
heartbeat, the maintainer's drain — is one `fleet-event.mjs` call, which makes
the wake's writes and ends in one `fleet-tick.mjs` invocation, and you do what
it prints. There are no hand-run
refill or dispatch edges left. Record first, because the tick reads the run off
`.fleet/ledger.md` and nothing else of yours: a wake you have not written down is
one it cannot see, and it names the same dispatch again. Every record goes
through `ledger.mjs` (**Run ledger**), which `fleet-event.mjs` drives — never a
hand edit. What each kind writes is in the header comment of `fleet-event.mjs`.

Run each as `~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run fleet-event.mjs <kind> <args>`, from the main checkout:

| Wake | Command |
|---|---|
| Implementer report | `fleet-event.mjs impl-report impl-<N>` |
| Review result file written (workflow notification / `review-pr-<n>` report) | `fleet-event.mjs review-result <pr> <path>` |
| Review launch failed | `fleet-event.mjs review-failed <pr> <launch>` |
| Fix-applier report | `fleet-event.mjs fix-report fix-pr-<M>` |
| Finisher report | `fleet-event.mjs finisher-report finisher-pr-<M>` |
| Merge-bot pass report | `fleet-event.mjs merge-bot-report merge-bot-<n>` |
| CI run terminal | `fleet-event.mjs ci <pr>` |
| Label seen (persistent Monitor) | `fleet-event.mjs label <pr>` |
| `CONFLICT` line | `fleet-event.mjs conflict <pr>` |
| Heartbeat | `fleet-event.mjs heartbeat` |
| Drain | `fleet-event.mjs drain --reason "<reason>"` |

Act on every line the call prints, the tick's last, and arm the beat. What a wake
owes beyond its call:

- **Nothing to do right now** → **do not end your turn.** Arm the heartbeat
  below. A turn that ends on a drained queue is #3's stall itself: nothing
  external will wake you, and the level-check you are one command away from
  never runs. Listed first because it is the only wake with no trigger —
  every other row above arrives; this one is the absence of one.
- **Implementer report** → the PR is owed a review from here on:
  the tick names it as `DISPATCH review PR#<M>`, and it names the next
  shortlist head whenever the In-flight count is below the bound. Pull
  nothing the tick did not name.
- **Finisher reports halted** → the per-cause rule (**Resolving a finisher
  halt**, below).
- **A finisher failed or was killed** → `ledger.mjs settle finisher-pr-<M>=failed` for a
  finisher that crashed or gave up, `=killed` for one that was killed; no label,
  and the tick prints no dispatch for it. The cockpit flags the PR
  `finisher:failed` / `finisher:killed` at severity 4 and you resolve it by hand
  (**Resolving a finisher that died**, below), then run the tick.
- **Implementer bails before implementing** → `fleet-event.mjs impl-report impl-<N>`
  settles `impl-<N>=bailed` and demotes by cause:

  | Cause | Label |
  |---|---|
  | brief does not decide *what* to build | `needs-triage` |
  | genuine fork — options named, none ruled | `ready-for-human` |
  | needs human hands — external access, manual testing, judgment during the work | `ready-for-human` |

  The call relabels, comments the cause and releases the claim, then ticks:
  the head the tick names next is a *different* ticket.
  `needs-triage` routes back to `/triage`, which can return it as
  `ready-for-agent`; `ready-for-human` for hands or a fork; `needs-triage` for a
  brief that names no *what*.

  The same causes relabel an unclaimed ticket at the Pull (phase 1), where there
  is no `in-progress` to drop — the causes and labels are one table, applied at
  whichever point the ticket fails them.
- **A review result lands** → see the result file written (by you or by the
  runner — **Reviewers** says which, per harness), then
  `fleet-event.mjs review-result <pr> <path>`: a PR with survived or unverified findings prints as
  `DISPATCH fix-pr PR#<M>`. No survived or unverified finding and nothing to file → skip the
  fix-applier and dispatch the **finisher** directly — or, when that head's
  bound conclusion is red and not solely staleness, the red-check fixer
  instead (**Then dispatch a red-check fixer**, below): no member will touch that
  PR, so no push is coming and nothing will wake you. A review that failed is
  not a result — **Reviewers** says who retries it and what takes over.
- **Monitor: `ready-to-merge` appears** → `fleet-event.mjs label <pr>`, and
  on `DISPATCH merge-bot` dispatch the next `merge-bot-<n>` (**Merge bot**).
  Catches hand-added labels as well as a finisher's own. The bot does not wait
  for that finisher's report: its rebase is server-side,
  `gh pr update-branch --rebase`, so nothing on the finisher's worktree has to
  happen first.
- **Merge-bot pass reports done** → `fleet-event.mjs merge-bot-report merge-bot-<n>`. A label that
  landed at the last moment reads `DISPATCH
  merge-bot` again: dispatch the next bot straight away. A `rebase-fallback-#<pr>`
  on a conflict needs no record from you — the bot already appended
  `conflict-hold:#<pr>` to that PR's row, and the tick turns it into `DISPATCH
  fix-pr PR#<pr>` (**Reviewers**).
- **The run ends, or the maintainer says drain** → `fleet-event.mjs drain --reason "<reason>"`
  first (below). The marker is on disk, so the tick
  holds the implementer row at `HOLD (draining)` from then on — for a
  replacement controller too — and keeps the review, fix-applier and merge rows
  firing until the open PRs merge. The drain starts the end of the run; it does
  not end it. **End of run**, in this order:
  1. `~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run fleet-event.mjs drain --reason "<reason>"` — runs
     `closeout.mjs begin --reason "<reason>"` (**Release the claims that never became
     PRs**), then the tick. A claim it refuses prints `NEED hand-release #<N> <blocker>`: that
     refusal is the finding, so run `worktree-audit.sh` and decide by hand.
     `begin` selects a claim with no PR and a live or `bailed` implementer token
     on every run, so a claim you keep leaves `begin` at exit 4 on every run:
     release the rest by hand and run `begin` again.
  2. Act on the review, fix-applier and merge rows until the tick prints
     `ACTION: run over → fleet-heartbeat.mjs --stop "<reason>"`, which it does
     once the run is draining with no open PR and no live implementer.
  3. `~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run closeout.mjs finish --reason "<reason>"` — scrapes
     the run's member facts, checks the tier-outcomes rows, refreshes the
     metrics, commits the three metrics files and opens their PR, then records
     `fleet-heartbeat.mjs --stop` last, because every reader takes a recorded
     stop as the end of the run. A `NEED tier-outcomes append <pr>` is a PR
     the ledger marks reviewed with no verdict row: append it with the verdict
     you rule (**Guard: accumulate per PR**) and run `finish` again. A step it
     fails is explained in references/close-out.md. Exit 0 is the run closed.
- **Monitor: CI run completes** → `fleet-event.mjs ci <pr>`, which binds the run
  (`ci-state.mjs --pr <N>`) and **records it as
  `ci=<run-id>:<attempt>:<conclusion>`, not just "CI green"** — in the
  ticket's ledger row, which outlives your context. The key is what the sibling
  bullet below turns on: it tells an edge already spent from one that never
  fired. The whole key, never the conclusion alone: **a
  conclusion is not stable** (below), because a rerun rewrites the run in
  place. The diff-validating `check` job green with no heavy job (the
  diff-validating suites, not the `rebase-check` currency gate) in `failure`
  → a finisher CANDIDATE (gated below), a `check`
  **failure** that is not solely staleness → the **red-check fixer** (**Then
  dispatch a red-check fixer**, below), behind the same review-returned and
  fix-applier-reported gate as a finisher. A `check`-green board whose heavy jobs are merely
  `skipped` (behind-count staleness, the normal case after a merge) still labels — do NOT
  gate on `ci-state --quiet` exit 0, which a behind PR never reaches. **This
  edge fires for every CI run the PR produces, and the implementer's own
  firing comes first for every PR** — `ci.yml` triggers on `pull_request`, so
  opening the PR at the end of `next-ticket` step 7 starts a run within seconds,
  while the review returns 20-40 minutes later. That first firing is
  the ordinary case for every PR, not a rarity, and no review has run at all
  when it arrives. **Green is therefore not the gate: dispatch a finisher only
  once the PR's review has returned AND its fix-applier, if one was dispatched,
  has sent its report — pushed is not reported**, and a push before that report
  is mid-work on a SHA the member may still move, which its own prompt tells it
  not to hand over. A push is therefore not an exit, and a report that has not
  arrived is asked for by name rather than read as one. Neither shape is caught
  by an empty outbox: on the implementer's firing there is no fix-applier to owe
  anything to, so the outbox is *vacuously* empty, and on a fix-applier's
  mid-work push nothing has been sent since the dispatch, so it is *genuinely*
  empty. **The outbox is the last test, not the only one, and it stands wherever
  a fix-applier exists** — that is exactly where a ruling you still owe it is
  outstanding, so never dispatch off it while you do. Empty your outbox to it
  first — including any ruling you have withdrawn or reversed — then dispatch
  (below); a final report is not proof it stopped. A PR that needs nothing fixed
  reaches a finisher through the **fix-applier reports `no-op`** bullet below,
  never by waiting for a second CI event this head will never produce. The
  same goes for a red one: a red that fired before the review never fires
  again, so the **fix-applier reports `no-op`** and **review result lands**
  bullets are also the only routes to the red-check fixer there.
  Then run the tick.
- **A fix-applier reports `no-op`, or a SHA you have already bound** → dispatch
  the finisher **now**, against the existing head — when that head's bound
  conclusion is red, the red-check fixer instead (**Then dispatch a red-check
  fixer**, below), never a finisher and never a wait. No push means no new run, and
  the Monitor above is edge-keyed on `<run-id>:<attempt>:<conclusion>` — that
  head's terminal state already fired once and will never fire again, so waiting
  for the CI event waits forever. This stays a common outcome on a clean PR:
  `suggestion` is the band a clean diff produces, and every out-of-scope or
  refuted one is filed as an issue rather than committed. An edge-only label path
  therefore strands exactly the PRs with nothing wrong with them. **Reconcile, do
  not wait for an event** governs here too, not only the implementer row. **This
  bullet and the one above are a pair, and on a clean PR this one carries the
  whole route to a finisher**: a `no-op` report satisfies the gate above by
  itself — the review has returned, because a fix-applier exists only after it
  did, and the member has reported — so nothing further is owed and no further
  event is coming. Edit either bullet without the other and what strands is
  exactly the PR that needed no fixes.
- **`ci-state.mjs --pr <N>` reads `verdict: "no-ci"`** → no workflow run will ever
  complete for this repo, so the CI-run-completion edge above never fires and
  waiting for it stalls the whole PR — the same silent-stall shape reported
  before this verdict existed. Dispatch the finisher off the reviewer's final
  verdict instead, the moment it lands — and, same as above, never while you still
  owe it a ruling — or hold anything else it has not received, a ruling you have
  withdrawn or reversed included. The finisher's gate is then the
  `--declare-no-ci` declaration, not a `check` job: with it, label off the
  reviewer's verified suite run; **without it, do not label** — report that this
  repo has no CI configured and no declaration, and stop. Absence never reads as
  pass. See `review-and-fix.md` step 6.

**In one line, every wake is one `fleet-event.mjs` call, which ends in the tick.** One tick invocation, and you act on what it prints:

```
~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run fleet-tick.mjs --apply [--in-flight <n>]
```

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
ledger token it
cannot read, it refuses rather than guessing — a member counted live or gone on
a guess is the over- or under-dispatch it exists to prevent — so correct that
row with `ledger.mjs row` and tick again. The In-flight bound defaults to 5
and is fixed for the run: pass `--in-flight` on every tick when `$ARGUMENTS`
set it, and never otherwise.

It prints `actual/target` and a named ACTION per role, with the whole **Queue
depth** guard table applied in code. Act on each line as it reads:

- `PULL #<N> …` — one Pull per named ticket, in the order printed: phase 1's
  read, then phase 2's dispatch. A ticket that fails the read is relabelled or
  excluded (phase 1), and the next tick names the next head.
- `REFRESHED shortlist: <n> entries; <k> lifted` — the tick refreshed the
  shortlist itself, and its `PULL` row already reads the result. `REFRESH
  FAILED` is yours: `shortlist.mjs` could not run, and the implementer row is
  blind until it can.
- `SUGGEST /triage, hold idle` — nothing is admissible after the refresh.
  Suggest, never run (**Queue depth**).
- `specs-dropped=#<N> … (to-spec: User Stories heading)` at the end of the
  implementer row's counts, whatever its ACTION — the tickets the to-spec
  filter kept out of `supply`, read off the shortlist's `dropped`. Never
  actionable. Log them as specs awaiting to-tickets (phase 0), not as no work.
- `DISPATCH fix-pr PR#<M> …` — a fix-applier per PR, for a review's survived or unverified findings,
  a dispositions mismatch no retry has answered, or a `conflict-hold:#<M>` — the merge bot's, or one you recorded off a `CONFLICT` line (**Reviewers**). Printed
  ahead of reviews on purpose: finishing what is started beats starting more.
- `DISPATCH review PR#<M> …` — a review per PR, oldest first, off your turn
  (**Reviewers**).
- `DISPATCH merge-bot` — the next `merge-bot-<n>` (**Merge bot**).
- `DISPATCH finisher PR#<M> …` — a finisher settled `labelled`, yet the open
  list shows PR M without `ready-to-merge`, and no `label-off=` (**Run ledger**)
  accounts for the removal. Apply the finisher gate (**Reviewers**: the
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
  PR#<M>`, a conflict fix-applier (**A `DISPATCH fix-pr PR#<M>` on a conflict
  hold**), and that row obeys every hold. A review in flight does not stop the
  line: `fix-due` waits for the review to return. It prints under a
  main-checkout hold and a drain too, since it writes a record and dispatches
  nothing.
- `ESCALATE conflict PR#<M> …` — PR M reads CONFLICTING again after two
  conflict fix-appliers landed on it: a rebase treadmill. Comment on the PR
  and flag it for a human; write no hold and dispatch no fix-applier. Not
  actionable; it repeats while the PR reads CONFLICTING and clears once it
  stops, closes or merges.
- `HOLD (…)` — the row is held and says why: draining, a tier mismatch, an
  unchecked tier, the In-flight bound reached (`HOLD (in-flight <n>/<B>)` —
  nothing to do unless its detail names a replacement to dispatch, else a
  merge brings n below B), or every
  queued merge candidate held behind a lower PR or on a conflict hold no
  fix-applier has cleared. An unchecked tier is `tick --apply`'s to check, and
  the hold stays while the check writes no verdict (its `tier-ok=`, or
  `tier-unverifiable=` for a member settled `killed` or `released` with no
  transcript, clears it); a mismatch is yours to clear, by dispatching the
  replacement at the right tier (phase 2). Each prints its clearing step in
  the row's detail. For a mismatch that is the replacement's name —
  `impl-<N>-b` on a first retry, else one letter past the highest the ticket
  has used, or that no retry letter is left. For an unchecked tier, which
  `tick --apply` has already tried, it is the `tier-check.mjs` command to run
  by hand when the tick ran without `--apply` or the check wrote no verdict,
  with a batch entry per member it names (fill in `<file>`; `<session>` too
  when no receipt of this run records one).
- `AT CAP`, `IDLE OK` — nothing to do on that row.
- `MAIN-CHECKOUT-DIRTY <paths> …`, printed above the rows, with every
  dispatching row (implementers, reviewers, merge-bot) reading
  `HOLD (main checkout dirty)` — the main checkout changed since the Phase 0
  baseline. The line names the changed paths, or a `HEAD <was> → <now>` entry
  when HEAD moved, and every live member; it
  attributes nothing, because concurrent members make that a guess. Dispatch
  nothing new and tell the maintainer: they resolve the stray paths FIRST,
  then re-baseline with `~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run main-checkout.mjs --record`.
  A path entry holds until that re-baseline, tick after tick; a `HEAD …` entry
  clears itself once HEAD reads clean again, and is never re-baselined while
  HEAD is off the run's branch. Never revert the
  paths yourself, and never re-baseline over paths nobody has resolved. The
  changes of yours that trip it are a mid-run tooling fix edited in this
  checkout and the close-out commit's round trip through a branch; **Fix the
  tooling mid-run** and the commit section of references/close-out.md say how
  each is cleared.
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
  `~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run main-checkout.mjs --record`, which references/phase-0.md
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
  `task` call, or settle the token `killed`. Advice the same way, folded as
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

**Tier guards under Pull.** The per-dispatch `tier-check.mjs --batch` is
phase 2's own step, run by `tick --apply`: a mismatch it finds is the
`HOLD (tier mismatch impl-<N>)` above, and a member it has no verdict on is
the `HOLD (tier unchecked impl-<N>)`. Nothing else in the loop owns it.

**`--in-flight <B>`** is the run's In-flight bound: leave it at its default
unless `$ARGUMENTS` set it. omp's `task.maxConcurrency` is not the bound
(**Phase 2** gives the reasons) — below 2·B+2 it is a notice, never a hold.

**Why every wake.** A merge cascade is a firehose of merges, CI greens and
rebases that holds your attention on the merge side while the implementer side
drains to 0 and stays there — 0 implementers emit no completion event, so a
refill that waited for one would never fire. A tick on every wake you are
already handling is what makes that drain visible. **Every wake is still an
edge, so none covers a fully drained queue**: no members and no open PRs is no
event at all, and the tick goes unrun. That state is the heartbeat's.

**Beat when there is nothing to do, and never end your turn on a drained queue.** See references/ci-and-staleness.md.

```bash
~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run fleet-heartbeat.mjs \
  [--base 300] [--ceiling 1200] [--multiplier 2] [--hold 240]
```

It blocks, then prints one line. Which line it is, is the whole protocol:

- `… interval elapsed (quiet=<n>) → run fleet-event.mjs heartbeat` — the level-check
  is due. Run that command and act on what the tick it ends in prints.
  Then arm the beat again.
- `… Ns of Ms remain → re-issue this command now, do not end your turn` — no
  command blocks for a whole interval (omp backgrounds one at 60s, which is
  why the CI gate holds its wait in one `eval` cell polling `gh run view`).
  Issue it again. That is still one blocking call per turn, never an idle turn.

The interval doubles while the fleet asks for nothing and stops at `--ceiling`,
so a quiet night costs ~26 wakes instead of ~96. **The ceiling is a real bound,
not a formality**: supply grows from OUTSIDE the fleet — a ticket you triage,
one a reviewer filed `needs-triage` included — and that arrival emits no
event either, so the ceiling is your worst-case latency for noticing it.
Do not raise it past 30 minutes.

**The beat does not stop on idleness.** An empty shortlist and an empty supply are
not a reason to end the run; they are the state a newly triaged ticket arrives
into. The run ends when you drain it, when the budget goes, or when this
context does — not because there was briefly nothing to do.

**`--fold-unchanged` belongs to the heartbeat alone** — `fleet-event.mjs heartbeat` passes it, no other kind does.
It prints one line instead of the rows when a tick asks for nothing AND says
exactly what the last one said, which is what makes an unattended night
affordable; a tick on any other wake is read by a controller that just acted and
needs the rows. An unchanged `PULL` or `DISPATCH` is never folded — unclaimed work
always prints in full, because folding it would hide the stall behind this
ticket's own remedy. A dirty or unknown main checkout still folds — clearing it
is the maintainer's, so it is nothing for you to act on — but the folded line
names it (`…; HOLD (main checkout dirty) persists — …`) for as long as it holds
dispatch.
A live member past its family's threshold folds the same way — it is advice, so
nothing for the heartbeat to act on by itself — and the folded line names each
such member (`…; CHECK-LIVENESS fix-pr-5 persists — …`) for as long as it stays
live past the threshold.
To-spec drops fold the same way, and the folded line names them
(`…; specs-dropped=#<N> (to-spec: User Stories heading) persists — …`) for as
long as the shortlist carries them.

**When you stop on purpose, say why — one command, and it is the last thing
you owe the next run.** The beat leaves a dated mark on every hold, so a run
that dies abruptly (a crashed harness, a closed terminal, an OOM kill) is
detected by its mark going stale. A run that stops KNOWINGLY can do better
than being detected, and nothing else can write the reason afterwards:

```bash
~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run fleet-heartbeat.mjs --stop "budget exhausted"
```

It holds nothing and returns at once. Use it when the budget goes, or when
you can see the context ceiling coming. A drained run records it as the last
step of **End of run** (above), never at the drain itself.
Skipping it is not fatal — the next reader still reports the stop, it just
reports that the beat stopped *without a recorded reason*, which is all it can
honestly say about a death that named nothing.

**A stall line names whose stall it is.** `fleet-tick`
prints it before its own rows when this run has gone quiet: its beat overdue
against the interval it recorded with no tick or ledger write inside the
40-minute window either — or, with no beat yet, its latest tick, ledger write
or controller record past that window. A beat, tick or ledger write older than
the controller record rotate wrote is the previous run's and counts for
nothing. The cockpit shows the same line while it is up. It names when this
run was last seen, how overdue that is, how many
tickets are still claimed and in flight, and how much supply the last read found
— because the claimed ones keep the `in-progress` label, the candidate scan
EXCLUDES that label, and those tickets are therefore invisible to your own
shortlist and to the maintainer's. Its opening words come off the controller
record:

- `heartbeat STALLED, controller gone` — the run that stranded them is dead.
  Its claims without a PR come back through the next run's phase 0
  stranded-claim step (references/phase-0.md, "Resume the claims a dead run
  left without a PR"), and its open PRs through the fold-in.
- `heartbeat not beating, controller alive (pid N)`, or `(this session's
  earlier run)` — a controller that stopped beating and kept going. Nothing
  died, so nothing is resumed; when that controller is you, the fix is to
  tick on every wake and beat when there is nothing to do.
- `heartbeat STALLED` alone — no record says whether that controller lives.
  The line is detection only.

Your first tick may print `previous run stopped deliberately at <time> (<age>
ago) — recorded reason: <reason>` instead: the stop the previous run recorded.
It is that run's end, not a verdict on yours, and no later tick prints it.

Read the line and carry on; nothing in the fleet releases, relabels or
reaps the stranded tickets for you, and nothing restarts the run that stranded them.

**Own the CI waits.** Members are turn-based and cannot hold across a ten-minute
run — they rebase, push, stop. Arm a second persistent Monitor over open PRs'
latest runs, keyed `<run-id>:<attempt>:<conclusion>` so each terminal state fires once, and
emit the behind-count and the per-job conclusions with it: a `success` on a branch
8 behind is not actionable, and `check`-green-with-heavy-skipped is the staleness
board you must not confuse with a red. Do not reinvent that read: one
`~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run ci-state.mjs --pr <N>` per open PR already emits
run id, attempt, conclusion, behind-count and per-job conclusions, branch derived
from the PR — including the `gh api --hostname <host>` a GHE compare call needs,
without which the probe 404s and `behind` comes back `null`, never 0, so every
event reads as unknown-behind. Call it **without `--quiet`** — that flag drops
`jobs`, `missing` and `dropped`.

A monitor event is a wake-up, never a verdict; members re-query at labelling
time. See references/ci-and-staleness.md.

**A conclusion is not stable, even for a fixed run id on an unchanged head.** Never cache a conclusion, and test any fallback you write against `""`, `null` AND a real conclusion. See references/ci-and-staleness.md.

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
budget_out= hidden_out= list_out= cap_out= blind= # seed the latches: set -u reads each below before tick 1 ever assigns one
pr_cap=200                                   # the open-PR read's --limit; gh stops there with exit 0 and no warning
while :; do                                   # one tick
  rl=$(gh api rate_limit --jq '.resources.core.remaining' 2>/dev/null || echo ERR)
  case "$rl" in ''|*[!0-9]*) rl=ERR;; esac    # a non-numeric read is an outage, not a budget
  if [ "$rl" = ERR ] || [ "$rl" -lt 200 ]; then
    if [ -z "$budget_out" ]; then             # ONE global latch: a quota outage hits every PR
      echo "WATCHER DEGRADED: core REST budget=$rl — CI polling paused, silence is NOT green"
      budget_out=1
    fi
  else                                        # every RECOVERED waits for the pass gates below
    prs=$(gh pr list --state open --limit "$pr_cap" --json number --jq '.[].number' 2>/dev/null) || prs=ERR
    if [ "$prs" = ERR ]; then
      if [ -z "$list_out" ]; then             # global latch: this cause is account-level too
        echo "WATCHER DEGRADED: cannot list open PRs — CI polling paused, silence is NOT green"
        list_out=1
      fi
    else                                      # a list or cap RECOVERED waits for the pass gates too
      count=$(printf '%s\n' "$prs" | grep -c .) || : # grep -c exits 1 on zero matches; set -e must not take it
      if [ "$count" -ge "$pr_cap" ] && [ -z "$cap_out" ]; then # global latch: a full page may have been cut there
        echo "WATCHER DEGRADED: open-PR list hit its --limit $pr_cap — PRs past it are NOT watched, silence on them is NOT green"
        cap_out=1
      fi
      # gh pr list is GraphQL, so $rl still holds. The pass is budgeted at 4 core
      # REST units per listed PR on top of the 200 floor. See references/ci-watcher.md.
      # A shortfall here, or at the Actions-bucket gate below, pauses this tick's pass.
      if [ "$rl" -lt $((200 + 4 * count)) ]; then
        if [ -z "$budget_out" ]; then
          echo "WATCHER DEGRADED: core REST budget=$rl < $((200 + 4 * count)) needed for $count PRs — CI polling paused, silence is NOT green"
          budget_out=1
        fi
      else
        # The workflow and run lookups bill a second core bucket that
        # `rate_limit` does not report. Its count is only in the response
        # headers of a lookup that bills it: one 1-unit read per tick, 4 units
        # per listed PR on the same 200 floor. Recovery for every global latch
        # waits until this gate clears too, so no line says polling resumed
        # while this one still pauses it.
        hrl=$(gh api -i 'repos/{owner}/{repo}/actions/workflows?per_page=1' 2>/dev/null | awk 'tolower($1)=="x-ratelimit-remaining:" {sub(/\r$/, "", $2); print $2; exit}')
        case "$hrl" in ''|*[!0-9]*) hrl=ERR;; esac # a missing header is an outage, not a budget
        if [ "$hrl" = ERR ] || [ "$hrl" -lt $((200 + 4 * count)) ]; then
          if [ -z "$hidden_out" ]; then
            need=; [ "$hrl" = ERR ] || need=" < $((200 + 4 * count)) needed for $count PRs" # an unreadable header has no amount to compare
            echo "WATCHER DEGRADED: unreported Actions core REST bucket=$hrl$need — CI polling paused, silence is NOT green"
            hidden_out=1
          fi
        else
          if [ -n "$list_out" ]; then
            echo "WATCHER RECOVERED: open-PR list readable again — CI polling resumed"
            list_out=
          fi
          if [ -n "$cap_out" ] && [ "$count" -lt "$pr_cap" ]; then
            echo "WATCHER RECOVERED: open-PR list under its --limit $pr_cap — every open PR watched again"
            cap_out=
          fi
          if [ -n "$budget_out" ]; then
            echo "WATCHER RECOVERED: core budget=$rl — CI polling resumed"
            budget_out=
          fi
          if [ -n "$hidden_out" ]; then
            echo "WATCHER RECOVERED: unreported Actions core REST bucket=$hrl — CI polling resumed"
            hidden_out=
          fi
          for pr in $(printf '%s\n' "$prs"); do # inline $(...): `for pr in $prs` is ONE iteration under zsh
            st=$(~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run ci-state.mjs --pr "$pr" 2>/dev/null) || : # not-green exits non-zero; the payload is the verdict
            if ! printf '%s' "$st" | jq -e '.verdict and .verdict != "rate-limited"' >/dev/null 2>&1; then
              case " $blind " in *" $pr "*) ;; *) # latch keyed BY PR: this cause is per-PR
                echo "WATCHER DEGRADED: no usable ci-state reading for #$pr — silence is NOT green"
                blind="$blind $pr" ;;
              esac
              continue                        # inner continue — still reaches the tick sleep
            fi
            case " $blind " in *" $pr "*)
              echo "WATCHER RECOVERED: ci-state reading #$pr again — CI polling resumed"
              keep=; for b in $(printf '%s\n' "$blind"); do [ "$b" = "$pr" ] || keep="$keep $b"; done; blind=$keep ;;
            esac
            : # your normal handling of $st for this PR; a run at a terminal state is the CI wake: fleet-event.mjs ci "$pr"
          done
        fi
      fi
    fi
  fi
  sleep 120                                   # the block's only pacing, once per tick
done
```

**One gate, not a gate plus a caveat.** See references/ci-watcher.md.

**It has to latch** — one line entering the degraded state, one leaving it,
never one per tick. An unlatched line at a 120s poll gets the Monitor
auto-stopped for volume during even a two-minute outage, reintroducing the same
blindness by another route. **Latch each cause at the level its cause lives
at**: the budget, the unreported Actions bucket, the open-PR list and that
list's cap are one global flag each — all account-level — but the payload latch is keyed by PR, and a
shared scalar for those is an unlatched line wearing a latch's clothes — one
persistently blind PR alongside one healthy PR re-clears the flag on every tick,
emitting a DEGRADED and a false RECOVERED pair forever. The recovery line is
what says the watch is alive again, so emit it on the first good pass even when
nothing about the CI state changed; without it a reader cannot tell a recovered
watcher from a dead one.

**All pacing in exactly one place — the tick loop's own tail `sleep`.** See references/ci-watcher.md.

**Guard every probe, not just the ones with a verdict field.** The block makes
several API calls, and `gh pr list` is the one that looks like
plumbing rather than a probe. A non-quota failure there (secondary/abuse limit,
5xx, network blip, expired token) does not lower `.resources.core.remaining`, so
the budget gate clears, and an unguarded `for pr in $(gh pr list …)` then
iterates zero times over the empty substitution: no error, no latch, no DEGRADED
line — total silence per tick, which is exactly what this section exists to
remove. Capture its status (`prs=$(…) || prs=ERR`), latch it globally, and fall
through to the same tail sleep. **Then iterate with the inline `$(printf '%s\n'
"$prs")` form, never a bare `for pr in $prs`** — the assigned-variable trap in
**Shell traps**, which carries the mechanism, with its measurements in
references/shell-traps.md. It
applies to **every** loop in this block, the `blind`-latch removal included:
under a bare `for b in $blind` a recovered PR never leaves the list and the block
emits a fresh RECOVERED every tick thereafter — the per-tick volume the latch
exists to prevent, wearing a latch's clothes again.

**A readable list can still be a short one.** `gh pr list` stops at its
`--limit` — 30 when the flag is absent — with exit 0 and no warning, so a list
that fills its limit reads exactly like one that happens to be that long, and
every open PR past it goes unwatched without a line. Pass an explicit `--limit`
(`pr_cap`: one variable for the flag and the check, so the two cannot drift)
and treat a full page as its own degraded cause — the "no silent caps" rule
`candidates.mjs`'s `refuseIfCapped()` and `fleet-tick.mjs`'s `PR_LIMIT` already
enforce. It latches globally like the list failure but does not pause polling:
the PRs it did return are real, so the pass still watches them, and the
DEGRADED line names the rest as unwatched until a pass comes back under the cap.

**The budget is gated at the floor and again at the pass, and only the pass gates announce recovery.** See references/ci-watcher.md.

**Judge `ci-state` on its payload, never its exit code** — the same rule as
`merge-gate.mjs` applies on the merge path, applied to the watcher. `not-green` is an
ordinary, frequent state that exits non-zero, so a watcher treating any non-zero
exit as an outage misfires constantly on PRs that are merely in progress. Empty
or unparseable output is the degraded case; parseable JSON reading
`verdict: "not-green"` is normal. An exhausted quota may also name itself,
`verdict: "rate-limited"` on stdout — likewise degraded, and likewise not a
reading, which is why the gate above tests the verdict rather than mere
parseability: that payload is perfectly good JSON.

**Do not back off and wait.** See references/ci-watcher.md.

**While the budget is exhausted, `ledger.mjs check` reads
`verdict: "unverified"`** — the ledger was read and the tracker was not. That is
correct behaviour, but `unverified` exits **0**, the same as `clean`, so a
member treating exit 0 as "safe to file" files blind during exactly this window.
Say so when you flag the outage: members read `verdict` explicitly until you
report recovery, never the exit code alone.

### Reviewers

**Dispatch the review, never wait on it, and act when its result lands. That is the default path.**
The tick names every PR owed one — `DISPATCH review PR#<M>`, oldest first —
and each gets one review, once per PR:

a `task` member named `review-pr-<pr#>`, agent `fleet-review-runner`, its prompt the five args `pr`, `branch`, `worktree`, `testCmd` and `scratch` — it loads `review-eval.mjs` through the Resolver (`~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run --path review-eval.mjs`), awaits `runReviewOnOmp` in its own kernel, writes the result file into the review's own run root and reports its path and `reviewed=` token; record `review=member:review-pr-<pr#>` on the PR's row before the dispatch call. **`scratch` is the scratch root itself, the absolute path `scratch-root.mjs` prints, never the review side's `<scratch>/pr<N>` partition:** the review creates `pr<N>/` under it, so a `pr<N>` passed in nests every run root at `pr<N>/pr<N>/`, and the review refuses a `scratch` whose last component is `pr` plus digits before dispatching anything.

Write the `review=` token with `ledger.mjs review <pr> <token>`, which appends
it to the **PR's row** — the ticket row once `settle impl-<N>=PR#M` has run,
else `#M`, created when neither exists — and prints that row's key. `review`
is the only writer of `review=`/`reviewed=` tokens, so a PR's tokens sit on
one row in the order you wrote them. The tick counts in-flight reviews off the
ledger and nowhere else, so a review you launched and never recorded is one it
names again. `review` reads the PR's review record across every row that maps
to the PR, in ledger order, and refuses a write that adds a `reviewed=` with no
open launch before it, a launch identity the PR already used, a second launch
while one is open, or an unparseable `review=`/`reviewed=` (the ledger's token
grammar, below), or any token that is not a review token. `row` refuses a
write that adds a review token (one the row holds is carried), drops an open
launch, names a member twice on the line, or makes a PR map to a second row. A
bad token the ledger already holds is carried, never re-judged.

**`selectDimensions` sizes the fan-out to the diff and the verify budget
follows severity.** It cuts one immutable
snapshot, verifies every critical/important finding adversarially,
re-dispatches each crashed specialist and each crashed refuter pair once before
it assembles the result, and has `agent()` return **into the script**, so no
report can go undelivered and you relay nothing — the delivery failure that
cost one fleet five reports on one PR and four on another. None of it runs on
your turn: a review takes 20-40 minutes, and a controller that held its turn
for each one, one at a time, was what left implementer slots empty.

**Know the trim before you rely on it — it is wider than `docsOnly` suggests.** See references/reviewers.md.

**Review units are counted, never capped.** A review in flight — a
`review-pr-<pr#>` member still running — is one; each
`fix-pr-<pr#>` is one; a finisher and a CI wait are zero; and a PR holds at most
one unit at a time. In-flight reviews are derived, never remembered: a row with
`review=` and no `reviewed=` is one, which is why the token goes on before
anything else. A review whose PR has left the open list is probed: when
`gh pr view` reports that PR MERGED or CLOSED, the tick drops the review,
since none runs against a finished PR, and a probe that
cannot answer keeps the unit counted. A unit is not the agents a review fans
out to — 1 snapshot + up to 6 specialists + 2 refuters per critical/important finding.

It returns `{pr, head, resume, testEnvironment, dimensionsRun, dimensionsUnrun, cwdAudit, counts, snapshot, survived, refuted, unverified}` —
the **digest** first, then the snapshot and the findings — and it lands as
one artefact, `<scratch>/pr<pr>/<run>/review.json`, holding that bare object.
`<run>` is the review's own `run-XXXXXXXX` run root, the one its snapshot sits
in, so a second review of the PR — at the same head or another — writes a file
of its own and never replaces the first. The `review-pr-<pr#>` runner writes it
and reports the digest, the path and the `reviewed=` token naming that run.

**You read the digest; the findings are the fix-applier's.**
`jq '{pr, head, resume, testEnvironment, dimensionsRun, dimensionsUnrun, cwdAudit, counts}' <scratch>/pr<pr>/<run>/review.json`
is the whole of your read, and it is what you record: `reviewed=<head>:<survived>/<refuted>/<unverified>:<run>`,
off `head`, `counts` and the run root's name — the runner's `ledger` field — on
the PR's row, with `ledger.mjs review <pr>`. Every later path to the review is built from that token, before a
restart or after one: `<scratch>/pr<pr>/<run>/review.json`, `<run>` off the PR's
latest `reviewed=`. Findings never enter your context —
a result runs 26-61 KB, 7-15k tokens that used to land in yours and then again,
up to ~10k characters, in every fix-applier prompt you wrote. The fix-applier
reads every one off the file and makes every ruling on them
(`review-and-fix.md`'s **The review result file**). What the digest tells you:

**`testEnvironment` says what the review's shared test run is evidence about**,
and it is present on a healthy run as well as a degraded one, so there is
nothing to notice by its absence. The snapshot is `git archive`d and then
`git init`ed with one commit, and the block that cuts it compares that commit's
tree hash against the reviewed commit's: verified, a suite run in the
snapshot collects and runs what a checkout does, and a red is a fact about the
tree. UNVERIFIED, it is not — tests that ask git what ships decline or fail for
the environment, and this field carries which line of the cut failed. The
fix-applier reads it before acting on any count from the shared test run; you
read it so a degraded review never passes for a clean one.
`unverified` is *not* "checked and cleared" — a `suggestion` skips the pass by
policy, and a finding whose refuters all crashed or abstained lands there too.
All go to the fix-applier with the rest, in the file; never rule on them yourself.
**`refutersDispatched`, carried on every finding, is what tells the skip
apart** — zero is the policy skip, above zero with no deciding vote is a
refuter pass that decided nothing — and `refutersInconclusive` splits that
one: the refuters it counts abstained, every other one dispatched crashed. So
the population is read off those fields rather than off severity,
which records only how much a finding would matter if true. `resume` is
non-null exactly when a specialist or a refuter pair crashed again after the
review's own in-run retry, and **resume beats handing a crash-heavy review
on**: a deferred crash is a finding nobody ever looked at.
No replay exists for a review that ran in a runner's own kernel — `resume` is reported, not acted on, and the fix-applier defers what it names.
`refuted` comes back deliberately as well — a refutation is itself a claim, and
one has been reversed on new evidence. The fix-applier may reverse one; it
records each reversal as a `refuted` entry in its disposition record, the
evidence in `reason`, and you copy those entries to the ledger's `ruled` line by
running `fleet-event.mjs fix-report`, whose `settle --from-report` records each
refutation the report defers.

**`dimensionsRun` is the dispatch; `dimensionsUnrun` is what names a gap.** A
specialist that dies contributes zero findings while its key stays in
`dimensionsRun`; a review whose one shared test run executed nothing — the
review runs the test command once, and every specialist reads that run instead
of running its own — leaves every key there with no suite behind it. So
read the two together. A key
in `dimensionsRun` and NOT in `dimensionsUnrun` ran a suite; every
`dimensionsUnrun` entry is `{dimension, reason}` naming which failure it was.
The review already re-dispatched each crashed specialist once, so what
`dimensionsUnrun` still names is residue: the fix-applier names it unrun in its
report and re-runs nothing — an absence of findings is not coverage.

The rule this replaces — treat any dimension with nothing in
`survived`/`refuted`/`unverified` as unrun — was the workaround for having no
such field, and it over-refuses in the direction that costs work: a dimension
that ran clean has nothing in those three either.

**`cwdAudit` is the specialist's own inherited-checkout audit, one entry per
dispatched dimension: `{dimension, state, line}`, `state` one of**
`clean`/`dirty`/`unrepo`/`missing`. The prompt asks every specialist to run
`git status --porcelain -uall` against the directory it inherited before
returning and fold the result into a `CWD-AUDIT:` line — a convention, not
schema, so a specialist that never emits it or misspells it still validates
clean. This field is the runtime backstop that reads for the line regardless:
`missing` is exactly as loud as `dirty`, and both name a checkout you should
treat as a live scratch write until you have checked it.

**A throw, an empty return, or a notification whose status is not `completed`
is a failure event, not a clean review.** The review throws on missing
`args.pr`/`args.worktree` and on a snapshot agent that returned no tree, and a
failure surfaces mid-loop, where "react, never block" makes it easy to log and
carry on — leaving a PR that *reads* as reviewed and is not. **Retry once
under the next runner letter, then stop:** the `review-pr-<pr#>` runner
already retried once inside its cell and reports `failed` with both errors, so
the retry is a second runner under the next letter the PR's rows do not carry
yet — `review-pr-<pr#>-b` after a first runner — recorded as
`review=member:<that name>`. A second failure is reported, and the PR stays at
review-due. Settle the dead review by appending `=failed` to its `review=`
token, then append `review=member:<that name>` after it, both in one
`ledger.mjs review <pr> review=<dead launch>=failed review=member:<that name>`
call — `review` settles the dead launch in place, and refuses a new launch
while the dead one still reads open, and the tick takes the last `review=`
token on a row as the one in flight, so that order is what keeps the retry
counted as the live review unit. A
runner member that is killed rather than failed follows **Failure
handling** (fresh name, inherited state stated).

**Then dispatch a fix-applier** — on `DISPATCH fix-pr PR#<M>`, which the tick
prints for a PR whose `reviewed=` counts survived or unverified findings that
no review fix-applier
has landed `applied:`/`no-op` on since, with no fix-applier live on it — one
named member per PR, `fix-pr-<pr#>` (the next suffix when that name is already
on record), never the PR's
implementer, its brief rendered with `dispatch-prompt.mjs render fix-applier
--kind review --member fix-pr-<pr#> …` and then recorded with `ledger.mjs
dispatch <pr#> fix-pr-<pr#>` before the call. Its brief carries the PR number, the worktree abs path, the PR's branch,
the same `testCmd` you passed the review, and the **path** `<scratch>/pr<pr>/<run>/review.json`,
`<run>` off the PR's latest `reviewed=` — never the findings. Every `<scratch>`
in that brief is the absolute path `scratch-root.mjs` printed, the
`dispositions-<its name>.json` record's included. The fix-applier owns every per-PR ruling you once made
before dispatch: both mutual-exclusion scans, the suggested-fix re-derivation,
`refuted=false` ≠ apply, per-site measurement for a sibling-site extension, and
`testEnvironment`/`cwdAudit` before any result of the shared test run. It
holds every finding and you hold none, so there is nothing for you to rank,
relay or pre-rule — and a report from a refuter it spawns that surfaces to you
is its to retrieve, never yours to scan or pass on.

**A `DISPATCH fix-pr PR#<M>` on a conflict hold** — the row carries an
unresolved `conflict-hold:#<M>`, the merge bot's (`run-merge-bot.md` step 1's
fallback) or one you recorded off the tick's `CONFLICT` line —
is the same slot with a different job, and no review file to hand
over. Name it `fix-pr-<M>`, or the next suffix (`-b`, `-c` …) when that name is
already on record — `dispatch` refuses a reused one — render its brief with
`dispatch-prompt.mjs render fix-applier --kind conflict --member <name> …`,
and dispatch it with the
`agent` that `ledger.mjs dispatch` printed, in the PR's existing worktree.
`dispatch` prints this member's definition, `fleet-fix-applier` whatever the
row's `tier=` — read it off that output, never recall it. Its `conflict` brief carries the
same worktree and branch identity paragraph, but in place of the review paragraphs:
bring `<branch>` current with `origin/main`, resolving every conflict by
`run-merge-bot.md`'s **No-undo audit**, run `<testCmd>`, push, report the new
head. Settle it `applied:<head>` — `no-op` if no conflict was left — which is
what lifts the tick's merge hold; a dispatched-but-live one does not, and
`failed`/`killed` leave the PR fix-due for a replacement. It answers the
hold and nothing else: survived or unverified findings of a returned review the row also carries
stay unanswered through its settle, so the tick prints `DISPATCH fix-pr
PR#<M>` again once it lands, and that one is a review fix-applier, dispatched
as above. On a PR carrying
`ready-to-merge`, the push moves the head after the label, so the next merge
bot refuses it `head-moved-after-label-#<M>`: a fresh finisher, per **Failure
handling**.

**Then dispatch a red-check fixer** — on a `check`-job `failure` bound to the
PR's current head that is not **solely** staleness: a `rebase-check` red, or
heavy jobs `skipped`, that comes only off the behind-count gets no fixer (the
five-condition note in the fix-applier body states how to establish
that). The tick prints no `DISPATCH` for it, so you reconcile it yourself, and
it always goes after the review, never before. Take the common case, the
implementer's own first CI firing turning red before any review exists: the
review is still dispatched against that head as normal, because a red suite is
review evidence and not a blocker. While a review or a review fix-applier on
the PR is live or still owes its report — a dispositions mismatch awaiting its
retry and a conflict hold awaiting its fix-applier included — the red-check
fixer does not fire: their push starts a new run, and a fixer racing them
would work on a SHA that is still moving. These edges dispatch it, each the
finisher's own: **Monitor: CI run completes** binding a red on a head
whose review has returned and whose fix-applier, if any, has reported;
**A fix-applier reports `no-op`**, or a SHA you have already bound, when that
head's bound conclusion is red; and **A review result lands** with no finding
and nothing to file, when that head's bound conclusion is red. The Monitor is
edge-keyed on `<run-id>:<attempt>:<conclusion>`, so a red that fired before the
review never fires again, and with no push there is no new run — the other
edges are the only route there, so do not wait for an event. Edit one of these
bullets without the others and what strands is exactly the red-only PR.

Name it `fix-pr-<M>`, or the next free suffix (`-b`, `-c` …) — `dispatch`
refuses a reused name — render its brief with `dispatch-prompt.mjs render
fix-applier --kind red-check --member <name> …`, record it with `ledger.mjs dispatch <pr#> <name>`
before the call, and dispatch it with the `agent` that command printed
(`fleet-fix-applier`, as for a review fix-applier), in the PR's
existing worktree. Its `red-check` brief carries the same worktree and branch
identity paragraph, but in place of the review paragraphs: read the failing job's
log, fix the cause, run `<testCmd>`, push, report the new head, and **stop**.
It is told outright not to watch, poll or wait for CI: your persistent Monitor
owns the next run on the pushed head, and the finisher gate — review returned
AND fix-applier report sent — applies to this member the same way. Settle it
`applied:<head>` once a fix is pushed. Settle it `no-op` only when the red
turns out not to be this member's to fix — a flake that passes on rerun, or
staleness — with nothing pushed; `no-op` counts as landed, so it never stands
for "could not fix". Settle it `failed` when it cannot reach green, which the
**Failure handling** row "Reviewer, fix-applier or red-check fixer cannot
reach green" covers.

**A `DISPATCH fix-pr PR#<M>` on a dispositions mismatch** — the PR's row carries
`dispositions-mismatch=<member>:<run>` for its latest review's run, and no later
fix-applier has landed — is one automatic retry, a review fix-applier named the
next suffix (`fix-pr-<M>-b`) and dispatched like the first, its brief rendered with `--kind dispositions-retry`. Its prompt is the
first one's with the retry paragraph added: `--mismatched-record`, the mismatched member's record
`<scratch>/dispositions-<member>.json` it starts from, and `--violations`, the check's
violation list as printed — the lines
`dispositions-check.mjs` printed, each naming a bucket, an index and a rule;
re-run the check for the mismatched member to reprint them. It writes its own
record, and when it reports you run the check for it exactly as for the first
one. `ok` ends it. A second failure on the same review is written as
`dispositions-escalate=fix-pr-<M>-b:<run>` in place of a mismatch: the tick
prints no `DISPATCH fix-pr` for it, `dispatch` refuses the finisher naming
`dispositions escalate`, and you post the check's output with `gh pr comment <M>`
and flag the PR for a human. A new review of the PR counts again from none.

**A refutation resting on an injection nothing proved landed is not a refutation — it is a cell that never ran.** See references/reviewers.md.

**The suite slot bound.** At most `FLEET_SUITE_SLOTS` full suite runs execute on
a host at once — 2 by default, whatever the member caps count — because each run
already spreads over most of the host's cores. The bound is a wrapper,
`suite-slot.mjs`, reached through the Resolver:
`~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run suite-slot.mjs '<entrypoint>' [args…]` runs the
entrypoint under `sh -c` with the arguments after it. It decides by arity. No
appended arguments is a full run, and waits for a free slot. Appended arguments
are a narrowed run, which takes none, so a verifier's `<testCmd> <args>` never
queues behind a full run — only its fall-back to the full command does. A
wrapper that finds `FLEET_SUITE_SLOT` set, which a slot holder exports to its
child, is nested inside a held slot and runs straight through, so a wrapped
command inside a wrapped command is one run, not a deadlock. A slot is a
pid-stamped lock file in `~/.fleet/suite-slots/` — under the host's `~/.fleet/`
and not a workspace's, because the bound is host-wide and a review's snapshot is
no repository.

Each seat that runs the full suite is wrapped where its command is written. A
claim's runner execs the Test entrypoint through the wrapper. A repository that
tracks its own runner wraps it itself, as this repository's `agent-test` does
for a bare run. The review wraps its own one run, so its args carry the bare
command; a wrapped string handed to it anyway is harmless, the inner wrapper
being the nested case. The fix-applier and the finisher run what you hand them,
so hand them the wrapped string as `<testCmd>` —
`~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run suite-slot.mjs '<command>'`, each `'` inside the command
written `'\''` — and it is still one command for every gate.

The wait is capped and never counts against the run: `FLEET_SUITE_WAIT_S`
seconds, 1800 by default, then exit **75** with `suite-slot: no slot after <n>s`
on stderr, having launched nothing. On getting a slot the wrapper prints
`SUITE_SLOT_WAIT_MS=<n>` — the wait in milliseconds — to stderr, which the
review's test-run block captures into its log and the test-run agent reports as
`slotWaitMs`. **Exit 75 is not a test result.** In a review it leaves every
dimension unrun, for the reason "no suite slot within <n> s — the host is at its
suite bound; not a test failure", with no retry inside the run: re-review it
under the next runner letter (`review-pr-<pr#>-b` after a first runner), as for
a runner that reported `failed`. The implementer, fix-applier and finisher briefs
carry the one-line rule: *Exit 75 from the suite is not a test result; run the
command again.*

A slot holder killed without releasing is taken over by the next waiter under
the same `.reap` discipline as the ledger's lock; the wedges that discipline
cannot clear are in the runbook under **Writer policy**.

**Where `testCmd` comes from:** the repository's Test entrypoint, out of the
Recipe cache phase 0's Recipe derivation step proved —
`~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run derive-testcmd.sh . test --at origin/main` prints it — and the one you
hand specialists per **Give specialists a stack-free test command** above. Pass
the same command to the review, to the fix-applier, and to the finisher — whose
duty-2 mutation
gate runs it too — so every gate runs one command. Omit it from the review args
and the review (`review-core.mjs`, in a runner) reads the same cache itself,
refusing outright when there is none; the fix-applier has no such fallback, so
substituting `<testCmd>` with nothing leaves it no gate at all.

**Where `<branch>` comes from:** the PR's head branch — `gh pr view <N> --json headRefName -q .headRefName`, or the same branch you cut the worktree from. See references/reviewers.md.

**What a fix-applier receives.** Its standing text — the worktree and
session-root discipline, the review result file and every ruling on it, the
claim discipline, the refuter prompt, the kill rule, the stash prohibition, the
dispositions record and the report rules — is the body of
`agents/fleet-fix-applier.agent.md`, which the harness injects as its system
prompt, so none of it is pasted. The brief carries what varies, and the
renderer prints it: `~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run dispatch-prompt.mjs render
fix-applier --kind <review|conflict|dispositions-retry|red-check> --member <name>
--worktree <abs-path> --branch <branch> --testCmd <testCmd> --scratch <scratch>`,
plus `--pr <pr#> --run <run>` for a review or a dispositions retry and
`--mismatched-record <path> --violations <list>` for a retry. Then
`ledger.mjs dispatch <pr#> <name>` records it before the call.

**The standing CI facts are in the fix-applier body, not in per-event messages** —
otherwise you send "your red is staleness, do not rebase" once per member per
merge. `review-and-fix.md` states them; the body says they apply.

**The fix-applier pushes and exits — it does not hold the CI wait.** You own the
persistent Monitor; a turn-based member re-reading `gh pr checks` each idle cycle
rebuilds a 100k-token context for nothing the Monitor lacks. The body
carries the report-last rule and the brief says to push, write the report and exit; you do not have to restate either. When the
diff-validating `check` job is green **and no
heavy job is in `failure`** (the heavy diff-validating suites — not the
`rebase-check` currency gate; a `skipped` heavy job is behind-count staleness and
fine — **solely** off that count, which is a condition to establish rather than
infer, see the five-condition note in the fix-applier body) — or
`ci-state.mjs` reads `verdict: "no-ci"`, see below — **and once the PR's review
has returned and its fix-applier, if one was dispatched, has sent its report,
which the CI-completes edge above states in full** — dispatch a
**finisher** — a fresh small agent, not the fix-applier resumed. Render its brief
with `dispatch-prompt.mjs render finisher --kind fresh --member finisher-pr-<pr#> …`
(`--kind repair` once an earlier finisher reported `labelled` without the label landing), record it with
`ledger.mjs dispatch <pr#> finisher-pr-<pr#>` before the call, then **dispatch
it with the `agent` that command printed and omit `model` on the call** — the
tier lives in that definition's frontmatter, `agents/fleet-finisher.agent.md`,
as the `@smol:low` route, which resolves through the operator's `modelRoles`.
Its four duties are a checklist — audit the
worktree, confirm every deferral has a tracker home and re-run the acceptance
mutation, apply one release label, report — and the
merge gate downstream still catches whatever it gets wrong, the same argument
that puts the merge bot on the same tier below. **Never dispatch
one while you still owe the fix-applier a ruling**: the pinned SHA is only as good
as the guarantee nothing else is inbound. **The test is your OUTBOX, not the
member's last message** — anything you have decided that it has not received,
including a ruling you have since **withdrawn or reversed**. **That is the test
of THIS condition only**: an empty outbox says nothing is inbound from you, and
nothing about whether the member considers itself finished, which is what the
report condition above is for. A withdrawal you
recorded only in the ledger is undelivered: the member still holds the original
and will act on it. Relay everything — reversals too — then dispatch.

**That `dispatch` refuses a finisher — exit 2, nothing written — on a PR whose
latest `reviewed=` counts a survived or unverified finding, unless the
dispositions verdict answering that review's run is `ok`**: among the
`dispositions-*=fix-pr-<M>[-x]:<run>` tokens naming its run, the one
from the highest-suffixed fix-applier — so a second review at the same head is
answered by none of the first one's verdicts. A PR whose latest review counts
`0/<n>/0` is not gated. One counting `0/<n>/<u>` with `<u>` above zero is
gated like survivors, and the tick prints `DISPATCH fix-pr PR#<M>` for it: that
fix-applier's `no-op` and its `ok` verdict are what open the finisher. The
refusal names its cause. `dispositions
unchecked` — no verdict answers that review: run `dispositions-check.mjs` for
the fix-applier that answered the review, as `fleet-event.mjs`'s `fix-report`
entry states, then dispatch again. It names a `dispositions-unchecked=` verdict too —
no rule broke, but the check could not read where a deferral was filed, `gh`
unreachable or an issue unreadable: run the check again for that fix-applier
once `gh` answers (an issue that does not exist is unreadable too, and no re-run
answers that one: the check's stderr names it, and the record's issue number
needs correcting); the tick offers no fix-applier for it. `dispositions
mismatch` — no finisher: the tick prints `DISPATCH fix-pr PR#<M>` for it, and
the next-suffix fix-applier answers it (**Then dispatch a fix-applier**).
`dispositions escalate` — no finisher, no
retry and no further fix-applier: either a `critical` or `important` finding was
deferred `remedy-outside-diff`, or a second mismatch was drawn on one review, and
only a human can rule on either. Post the check's output, which names each
escalated finding or violating entry, with `gh pr comment <M>`, and flag the PR
for a human; re-running the check reprints it. Dispatch no fix-applier and no
finisher for that review, and expect no `fix-due` row for it; a new
review of the PR starts the check again. **On any PR with a
returned review, `0/<n>/0` included, it refuses too while a fix-applier on the
PR is still live, verdict or not** —
`fix-pr-<M>[-x] still live`: settle it, run the check for it, then dispatch
again. A re-review at the same head is a run of its own, so the earlier
round's verdict never answers it; once the check has run for the fix-applier
answering the new round, its verdict is the current one.

**It refuses a finisher, too, while the PR sits on a conflict hold no
fix-applier has cleared** — the same per-PR fold the tick prints `DISPATCH
fix-pr` off, ahead of the dispositions verdict. A PR known to conflict cannot
merge, and a finisher on it would race the conflict fix-applier rebasing it.
Dispatch that fix-applier, let it settle `applied:`/`no-op`, then dispatch the
finisher again.

**An unanswered question from the member is an outbox item, and it blocks dispatch with the same weight as a ruling you have already made.** See references/finisher.md.

**A final report is not proof the member stopped.** Observed twice: a ruling
relayed after dispatch produced a new commit mid-audit, and a fix-applier that
reported "nothing outstanding" resumed on a ledger-only withdrawal and was
cycling mutants through the worktree when the finisher audited it. Both finishers
correctly halted. Note what that costs to detect: two reads of the same worktree
a minute apart showed *different* mutants, so a member's report and any single
`git status` are each valid only at their instant. Its duties, in this order:

1. **Audit the worktree** by running one script, `finisher-audit.mjs` — the row
   lookup, the dirty check, the head-equality check and the cause derivation
   are one command, because each of them alone reads like the whole duty. Its
   exit code is the verdict of this duty:
   `~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run finisher-audit.mjs --worktree <abs-path> --pin <your dispatch pin>`,
   the path the one you were dispatched with, however it was spelled, and the
   pin the full SHA. It runs `worktree-audit.sh` itself and finds this
   worktree's row by its `realpath`, so a spelling reached through a symlink
   still finds a healthy worktree's row; it reads dirty from the row and from
   `git status --porcelain -unormal`; it compares the worktree's `HEAD` to your
   dispatch pin; and when the head differs from the pin it derives the cause
   from the reflog. It prints one JSON verdict,
   `{worktree, realpath, pin, head, cause, evidence}`. Exit 0, `cause` null, is
   the only result that means the worktree is clean at your pin. Exit 1 means
   `cause` names why not — `live-editor`, `rebase`, `past-pin`, `unreadable`,
   `missing`, `absent` or `other` — and exit 2 means the script could not
   look. Every non-zero exit halts the finisher *here*, before the label: it
   reports the verdict as printed and labels nothing, and an exit 2 is cause
   `other` with the line the script printed on stderr as its evidence. A
   finisher that cannot see the tree it labels cannot vouch for it, so none of
   the script's steps is run by hand to get past a halt. A finisher that
   verifies the dirt is harmless and labels anyway has substituted the rule's
purpose for the rule, and you find out at merge time. The halt-cause block in
`agents/fleet-finisher.agent.md` holds the script call and what each exit
means, and a bare SHA mismatch names no cause. **Pass `--testCmd` too** —
the same string you passed the workflow and the fix-applier — because duty
2's mutation gate runs it and nothing else hands the finisher one; the renderer
refuses a finisher brief rendered without it.
2. **Confirm every deferral — and every claimed APPLY — has a home that outlives the merge.** See references/finisher.md.

   **A fix-applier's "applied" is a claim like any other**, and nothing else
   checks it — the review ran against a snapshot cut before those edits existed.
   Confirm `git diff origin/main...HEAD` actually contains what it reported
   applying. Two finishers in one run extended duty 2 this way unprompted, and
   one found five applies where the controller's hand-written list named three:
   a controller's list of what to verify is itself a claim.

   **That range is right for the positive check and wrong for a negative one.** See references/finisher.md.

   **Whatever you verify by RUNNING, run in a tree nobody else owns.** See references/finisher.md.

   **Remove it on every path, the failing ones included** — a mutant that comes back green, a suite that will not start, your own halt at any duty. See references/finisher.md.

   **None of this licenses a write to the owned worktree.** Duty 1 is a read;
   you never restore that tree, because you never wrote to it. A controller
   instruction to restore mutated paths there is an instruction to perform the
   silent-destruction ordering above — report it back, do not run it. One
   finisher refused exactly that instruction live, on the grounds it could not
   prove the diff was its own; that was judgement, and this is the rule.
3. Add `ready-to-merge` by running one script, `finisher-label.mjs` — the
   release-label check and the label write are one command, because the check
   reads like the whole duty. Its exit code is the finisher's verdict:
   `~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run finisher-label.mjs --pr <pr> --pin <your dispatch pin>`,
   the pin the full SHA. In order, it finds **exactly one** release label,
   `patch`/`minor`/`major` — zero or more than one is exit 3 before anything is
   written, naming which it found; then it records the head you audited as a PR
   comment, which the merge bot reads as the head the label was applied to;
   then it adds the label and reads the labels back, and exits 0 only when that
   read-back carries `ready-to-merge`. A failed call is exit 2 and the read-back
   without the label is exit 4; no step after a failed one runs. The count is
   the backstop for a label lost wherever it was lost, a hand-created PR
   included: a `gh pr create` that outran its caller's tool timeout leaves the
   PR open with the flag unapplied and no exit status anywhere to notice, and
   nothing downstream re-derives the release label. It counts only those three
   — the PR carries other labels, `ready-to-merge` itself among them once the
   script adds it, so a PR wearing one release label beside them passes
   unchanged. A repo that defines none of the three does not gate on one — the
   script settles that from the repo's own label list and says
   `undefined-in-repo` in its receipt. Two finishers in one run stopped at the
   release-label check and reported `labelled` on PRs that sat out of the merge
   queue.
4. Report you the label (the script's receipt, the JSON line it printed, as
   printed), the deferral issue numbers — a `filed: #N <subject>` line for
   every issue duty 2 created, and `unrecorded: #N <subject>` for one whose
   `filed` failed twice — and anything
   it halted on — cause and evidence, below, never a bare "head moved". The
   cause is one word of the ledger's `halted:<cause>` vocabulary:
   `live-editor`, `rebase`, `past-pin`, `unreadable`, `missing` or `absent` as
   duty 1's verdict names it, and `other` for every other halt — that
   verdict's own `other`, and a halt at duty 2, duty 3, the instrument
   re-check or the CI gate. A duty 1 halt's report carries the verdict as
   printed, the JSON line, so a `rebase` halt's report carries the output of
   `git cherry <pin> HEAD origin/main` that its `evidence` holds.

**What a finisher receives.** The instrument re-check, the test-run verdict
rule, duty 1's audit script and what each of its exits means, duty 3's script
and the halt-cause rule are the body of `agents/fleet-finisher.agent.md`, which
the harness injects as its system prompt; none of them is pasted. The
instrument-set rule is stated once, at the top of this file, which no finisher
is dispatched to read, so it reaches one through that body. The brief carries
the PR, the worktree, the dispatch pin, `<testCmd>` and the scratch root:
`~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run dispatch-prompt.mjs render finisher --kind <fresh|repair>
--member finisher-pr-<pr#> --pr <pr#> --pin <sha> --worktree <abs-path>
--testCmd <testCmd> --scratch <scratch>`, which `ledger.mjs dispatch <pr#>
finisher-pr-<pr#>` records.

**Once the label is on, take it off before you approve any push.** The label is a
verdict on the tree the finisher read, and a GitHub label does not follow the
branch — on one PR it survived a push and came to sit on a commit nobody had
audited. Write `label-off=<latest finisher attempt>` onto the PR's row first
(`ledger.mjs token <PR number> label-off=<latest finisher attempt>`, which keeps
every token the row already has — **Run ledger**), then
remove `ready-to-merge`, then approve. The token is how the tick tells your
removal from a finisher that never labelled — a tick run between a removal and
its token re-dispatches a finisher into your take-off window. The label goes
before the approval because removing the artifact the merge bot gates on is
the reliable stop, where messaging the bot races it, and a label has been
observed holding until after an abort message arrived. Then
dispatch a **fresh** finisher against the new head; the first audit does not
transfer, since it verified a different tree. The merge bot refuses that head on
its own (`run-merge-bot.md`, **The labelled head**), so this is not the only
guard — but its refusal costs a pass and leaves the label lying, which is yours
to clear either way, the same way: `label-off=` first, then the removal.

A halt at duty 1 reads identical from a bare SHA mismatch whatever caused it,
and the causes `finisher-audit.mjs` names are the ones seen so far, not a
closed list; the finisher's agent body gives it the cause from one script
instead of asking anyone.

**Resolving a finisher halt.** A halt is the finisher working correctly — it
refused to label — so it is never `failed`, which stays for a finisher that
crashed or gave up. Record it `ledger.mjs settle finisher-pr-<M>=halted:<cause>`,
`<cause>` the word the report names; the ledger refuses any other. Every halt
escalates two ways: the cockpit flags the PR `halted:<cause>` at severity 4 off
that token, and you post the finisher's halt report — cause and evidence — with
`gh pr comment <M>`, so it outlives the run. **No label**: the missing
`ready-to-merge` already keeps the PR out of the merge queue. Then the cause
decides the rest — two resolve automatically, every other one escalates:

| Cause | Resolution |
|---|---|
| `live-editor` | **Automatic.** Ask the live member **by name** for its report, wait for it, then dispatch `finisher-pr-<M>-b` at the current head. If the head moved in the meantime, resolve it as `past-pin` instead. |
| `past-pin` | **Automatic, through the tick: re-review.** The head carries commits no reviewer read. The tick prints `DISPATCH review PR#<M>` for a PR whose latest finisher is `halted:past-pin` and whose latest `reviewed=<head>` is not its current head, until a review of it is running or has returned; record that review's tokens as any review's, with `ledger.mjs review <M>` onto the PR's row, its runner under the next letter the PR's rows do not carry yet (`review-pr-<M>-b`, or `-c` where a retry already took `-b`) — `review` refuses a second `review-pr-<M>` and names the free one — and its result reaches a fresh finisher through the same gate. |
| `rebase` | **Escalate** — comment and flag, nothing more. Read the report's `git cherry <pin> HEAD origin/main`: only `-` lines is a clean rebase, and a `+` line is a conflict resolution that changed content or a commit past the pin. No automatic rule until a live halt shows the case recurring. |
| `unreadable`, `missing`, `absent`, `other` | **Escalate** — comment and flag, no automatic retry. |

`past-pin` needs the tick because the dead-review path cannot reach it: once a
review has **returned**, its `reviewed=` token holds the PR out of `review-due=`,
and settling that review `=failed` re-queues nothing — that path covers only a
review that died before returning. A head that moved past `reviewed=` with no
such halt — a fix-applier's push — stays not due: duty 2 verifies what it
applied. **A rebase never gets a `reviewed=`:** the earlier review still
counts, because dispositions verdicts are tied to its head. Never write a
`reviewed=` you did not read off a review result file.

**Resolving a finisher that died.** A finisher settled `failed` or `killed` left
its PR without `ready-to-merge`, and nothing else notices: the PR is out of the
merge queue, and the tick dispatches no finisher for it. The cockpit flags a
REVIEW-column open PR without the label, whose latest finisher attempt settled
so, `finisher:failed` or `finisher:killed` at severity 4 — one token per
outcome, neither the implementer's bare `killed` flag nor `unlabelled`. You
resolve it by hand: investigate why the finisher died, or dispatch the
next-suffix finisher after the finisher gate: render its brief with
`dispatch-prompt.mjs render finisher --kind fresh --member finisher-pr-<M>-<x>
…` (`--kind repair` once an earlier finisher reported `labelled` without the
label landing), then `ledger.mjs dispatch <M> finisher-pr-<M>-<x>`. The flag
clears when a later attempt settles — `labelled`
(then `unlabelled` takes over while the label is still off), `halted:<cause>`,
or a live `-b` — or when the PR carries `ready-to-merge`, merges or closes.
You never add the label yourself, and the tick does not retry.

Gate on the `check` job, **not** on `ci-state --quiet` exit 0: a behind PR never
reaches full green, so an exit-0 gate strands it unlabelled. The finisher reads
per-job state (`ci-state.mjs` without `--quiet`, or its `jobs`), since `--quiet`
drops `jobs`, `missing` and `dropped`. Normal path, not only kill-recovery.

**`ci-state.mjs` reads `verdict: "no-ci"`** — no `check` job exists in this repo
to gate on, and that is not a third way to skip the wait. **The
`--declare-no-ci` declaration is caller-side, and reading it back out of the
payload verifies nothing**: the flag is echoed into `reasons` and flips the exit
code, so re-running with it and finding it there confirms only that you passed
it. Passing it yourself is not a second opinion. Check the two facts it stands
for instead:

1. `ci-state.mjs` **without** the flag still reads `verdict: "no-ci"`. A repo
   whose CI is merely misconfigured — workflow files present under other names,
   or `.github/workflows/` not a directory — exits 2 there rather than reading no-ci,
   so this is the check that separates real absence from misconfiguration, the
   case that must never ship silently.
2. The reviewer's own final verdict reports a green `testCmd` run on the SHA it
   pushed. `review-and-fix.md` step 3 requires it to, and that run is the only
   gate this repo actually has.

Both → add the label, and say it rests on the reviewer's suite run, not on CI.
Either missing → halt here, same as a dirty worktree: report `no CI configured,
no verified suite run on record` and add no label.

**Every implementer body carries the claim discipline, because tickets that restate facts ship new wrong claims** — inherited from the ticket, and minted in prose nobody asked for. See references/correction-tickets.md.

**The settling command for "which files read X" must never be a literal-path
grep.** The path is assembled in more than one spelling here, one of them behind
a local `read` helper, so a grep for the path string answers with the files that
merely *name* it — comments included — and misses the files that build it.
Replace the file with `MUTATED` in a throwaway copy, run the suite, and read off
which suites red: that answers which ones **depend on its contents**, which is
the question a coverage claim actually needs, and it returns a different set
from any spelling of the grep.

**A settling command over literal text uses `grep -F`, and its zero counts only after the same command finds a line known to match.** See references/correction-tickets.md.

### Merge bot

Per pass, named `merge-bot-<n>`, never two at once. `ledger.mjs dispatch
merge-bot` names it before the dispatch call — `n` is 1 + the highest
`merge-bot-<n>` the session holds, in the ledger's `## Dispatched` list, on a
row or in `## Retired`, so it restarts at 1 only when none was carried or
retired (a `dead` or `none` rotate, or a fresh start), a replacement for a
dead bot takes the next `n`, and nobody counts. With no brief rendered for
that name it refuses, naming the bot and the `dispatch-prompt.mjs render
merge-bot --member merge-bot-<n> …` to run — render it, then run `ledger.mjs
dispatch merge-bot` again. Dispatch
it on the tick's `DISPATCH merge-bot`: the first `ready-to-merge` label is
enough, and it never waits for the finisher's report. Its body
(`agents/fleet-merge-bot.agent.md`) tells it to read
`$(~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run --root)/commands/run-merge-bot.md` and run **one**
pass — drain the queue, re-evaluating after each merge, hold a 15-minute grace
for late labels, then report once and exit — and that you dispatched it,
which is what makes it hold that grace instead of arming its own watcher. Its
brief is `~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run dispatch-prompt.mjs render merge-bot --member
merge-bot-<n> --n <n> --scratch <scratch>`, `<scratch>` the absolute
`scratch-root.mjs` output: the bot writes only under `<scratch>/pr<N>/merge-bot-<n>/`. **Dispatch
it with the `agent` that `ledger.mjs dispatch merge-bot` printed and omit
`model` on the call** — the tier lives in that definition's frontmatter,
`agents/fleet-merge-bot.agent.md`, as the `@smol:low` route, which resolves
through the operator's `modelRoles`.

Rebase, wait for green, check the
label, merge is checklist work, and a bad merge still needs the label and the
per-job CI state to have been read correctly, which is exactly what a wrong
merge later surfaces and a human resolves; `no-undo-audit.sh` is the
deterministic, script-driven backstop run before every push specifically to
catch a wrongly-resolved conflict, so the tier buys nothing that backstop
doesn't already cover.

**The shell traps live in the merge bot's agent body, not in its brief and not
in a follow-up message.** A bot already looping cannot be corrected — the loop
consumes the turns a correction would land in — so
`agents/fleet-merge-bot.agent.md` carries **every entry in Shell traps**, each
written out in full: the rules in that section with the measurements from
`references/shell-traps.md` beside them, and the bot has them before its first
turn. The bot reads an exit code off `gh pr update-branch`, `merge-gate.mjs` and
`prove-merge.sh`, which is the `PIPESTATUS` and read-only-`status` pair, and its
grace poll captures `gh pr list` output and loops over it, which is the
assigned-variable trap. Its brief names the bot and `<scratch>`, plus the
one-line no-acknowledgement notice; do not paste the traps there. An edit to
Shell traps or to `references/shell-traps.md` lands in that body in the same
change.

**Its merge gate is one script, run twice.** Step 3 of `run-merge-bot.md` is
`merge-gate.mjs --pr <n> --pre <sha> [--post <sha>]`: read-only, it runs the
instrument re-check, the label and review-decision read and a run-bound
`ci-state`, and answers their conjunction — exit 0 mergeable, 1 blocked (the
bot reports `<reason>-#<pr>`), 2 could not evaluate. The bot runs it once
before any CI wait and again immediately before `gh pr merge`, and merges only
on that second exit 0. Nothing but the gate reads `ci-state` on the merge path,
so a bot's report names the gate's `reason`, never a field it read by hand.

**You own the watcher, not the bot.** A dying member takes a watcher down with it
and the queue stops silently. Arm one yourself, `persistent: true`, seeded before
the loop so handled PRs do not re-fire.

**Every merge invalidates every other open PR, silently.** The rest show *stale
green* until something re-triggers, then flip to `rebase-check: FAILURE` with the
slow jobs skipped. Behind-count is the only honest signal.
See references/ci-and-staleness.md.

**One rebase per PR, at merge time.** The bot establishes currency once, when the
PR is the merge candidate; requiring it earlier costs a full CI cycle per sibling
merge. Any behind-count you hand a bot is expired on arrival; say so. See
references/ci-and-staleness.md.

`run-merge-bot.md` carries the mechanics — intra-pass re-checks, run-binding, the
ancestry proof, post-rebase red triage. Do not restate them here.

### Reap after each merge pass

The merge bot deletes the remote branch after each merge (`delete-merged-branch.sh`,
in `run-merge-bot.md` step 4), leaving the local branch `[gone]` with its
worktree — and its installed dependencies — still on disk. Reap after **each** merge pass,
not once at the end: a stale worktree still answers `git worktree list`, so the
in-flight probe (`inflight.sh`, run by the Shortlist and by every Pull) reads an
already-merged ticket as taken and the queue quietly shrinks. The trigger is the
bot's `merge-bot-<n>=done`, and `tick --apply` reaps once for every one — a pass
that merged nothing included (phase 3, **Merge-bot pass reports done**). See
references/reaping.md.

`~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run reap.sh --apply` recomputes every precondition
inside the same invocation as the delete — `for-each-ref` for `[gone]`, `git
cherry origin/main` to authorize the `git update-ref -d` delete (plus a fresh
check that no worktree holds the branch), worktree removal without `--force` —
and reports reaped and kept-with-reason counts. Update the reaped tickets' ledger
rows in the same step. See references/reaping.md.

**It sweeps detached worktrees too — the shape a `[gone]` walk structurally
cannot see.** Bounded to `.worktrees/`, so a checkout of yours outside it is
reported, never removed. Read `worktreesRemoved` alongside `reaped`: a pass that
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

### Reclaim scratch after each merge pass

`tick --apply` runs it right after `reap.sh --apply`, every pass:
`~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run reclaim-scratch.mjs --root <scratch> --apply`,
`<scratch>` the path `scratch-root.mjs` prints. Reap authorizes on git's
evidence and never removes scratch; Reclaim authorizes on GitHub state and
age, reading which members are live off `.fleet/ledger.md`:

- **`pr<M>/` and `dispositions-fix-pr-<M>*.json`** go once PR #M is MERGED
  or CLOSED and no live `review-pr-<M>`, `fix-pr-<M>` or `finisher-pr-<M>`
  token names it. A live `merge-bot-<n>` holds every one of them for that
  sweep — its token names no PR. An OPEN PR's `pr<M>/` stays, all but its
  `run-*` roots idle past 7 days.
- **`impl-<N>/`** goes once issue #N is CLOSED, or when it is OPEN, no live
  `impl-<N>` token names it and nothing under it has changed in 7 days.
- **Anything else at the root** — your own ad-hoc files included — goes
  once nothing under it has changed in 7 days and no live token's name
  appears in its name.

No ledger refuses this call (exit 2, nothing removed): mid-run there is
always one, so its absence is a fault to look at, never permission. A `gh`
that cannot answer keeps every PR- and ticket-keyed entry. It prints one
JSON receipt — `removed`, `kept` and `failed`, each entry with its reason —
and exits 0 even when a removal failed; record nothing on the ledger. The
review snapshot runs the same script as `--pr <N>` on its own PR's stale
`run-*` roots.

### Release the claims that never became PRs — at end of run, and on drain

Phase 1 is serial and claims ahead of dispatch, so a ticket can be legitimately
claimed and then never sent: a collision surfaces after the claim, or the
maintainer says drain. The claim still holds the `in-progress`
label, a worktree and a branch, and **`reap.sh` will not take them** — the branch
is not `[gone]` and has no unique commits, so it is correctly not reapable. Reaping
fires after each merge pass and nothing fires at end of run, so the claim survives
it and the in-flight probe reads a free ticket as taken next run. Same silent queue
shrink as a stale merged worktree, from the opposite end.

`~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run release-ticket.sh <N> impl-<N> implementer --apply` —
the pair the claim took, so the two name the same branch and worktree — is the
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
`git update-ref -d` on the tip it read once before the recount — a
compare-and-swap that refuses if the branch has moved off that tip — authorized
by those two commit checks, the recount and a fresh check that no worktree holds
the branch, and by nothing else (not `git branch -d`: it measures against local
HEAD, and a claim has no upstream, so it refuses a pristine claim whenever local
`main` is behind `origin/main`). Any one of
them failing → it touches nothing and names the blocker. **That refusal is the
finding, never an obstacle**: a claim carrying commits or a pushed branch is not
auto-released, ever — run `worktree-audit.sh` (it audits every worktree; find
this claim's row in the output) and decide by hand.

Run it over every claimed ticket with no PR when the run ends or the maintainer
drains, and on the spot for a claim abandoned mid-run (a bail before
implementing, a collision found after the claim). Update the released tickets'
ledger rows in the same step. See references/reaping.md.

## Worktree and claim model

**Claim, release and reap are unchanged on omp.** `claim-ticket.sh`,
`release-ticket.sh`, `reap.sh` and `inflight.sh` are git-native and operate on
the single shared ref store every worktree and the main checkout read and
write directly (**Phase 1**, **Reap after each merge pass**, **Release the claims
that never became PRs** above); nothing in omp's `task` model touches that
store, so none of the four scripts carries a dialect branch.

**A fleet member is never dispatched with omp's `isolated: true`.** See references/isolation.md.

**A member's tree is the claimed worktree, addressed by absolute path.** See references/isolation.md.

**The one open gap that probe measured: `task` does not accept a per-dispatch working directory.** See references/isolation.md.

**The same gap reaches past the filesystem: `task`-dispatched members share one `eval` kernel.** See references/isolation.md.

**`release-ticket.sh` is not a no-op on omp, and `inflight.sh`'s probes are unaffected by a running member.** See references/isolation.md.

**The controller's own cwd stays the main checkout, unchanged.** Nothing in
this section's dispatch recipe — the cwd recipe above, the isolated-workspace
measurement, or the teardown scoping — moves
where the controller itself runs from.

## Queue depth

- **shortlist** — `.fleet/shortlist.json`'s entries with no `impl-` row and no
  live `excluded` row: admissible, not yet pulled. The tick's `unclaimed=`.
- **supply** — `scanned`, the open `ready-for-agent` tickets `shortlist.mjs`'s
  candidate scan returned, before any filter. Only a Pull's full read judges
  decided?, so a shortlist of undecided tickets is supply that every Pull
  relabels away — and relabelling is what stops it being counted next scan.
- **review backlog** — PRs owed a review. `fleet-tick.mjs` counts every
  open PR without `ready-to-merge` **that closes an issue** and carries no `review=`
  token on the ledger — one settled `=failed` is owed a review again, and so is
  one whose latest finisher halted `past-pin` past its latest `reviewed=` head
  (**Resolving a finisher halt**) — and it
  prints them as `review-due=`. Exact, not a wider read: the ledger records
  which PRs are under review or reviewed, so nothing about it is guesswork. The
  closing-issue test is what keeps it from widening: a PR that closes no issue
  — one you author yourself, for instance — is left unlabelled for the
  maintainer, so no member of the fleet will ever review it, and counting it
  floors the backlog at a depth nothing in the run can drain — the reviewer
  row would then report a review owed for the rest of the run.
  GitHub's own linked-issue set decides that, not a keyword regex over the body.
  **That exemption is for a PR THIS run authors, never one a PRIOR run left
  open** — step 0 folds those into this run's review queue, so count one when
  you reason about backlog BY HAND. **The `fleet-tick.mjs` number still
  excludes it**: nothing in its filter distinguishes an inherited PR from this
  run's own, since a PR closing no issue fails the closing-issue test either
  way — folding one in cannot reach the count. So the by-hand judgement and
  the script's output differ here, and such a PR's review is dispatched by
  hand.
- **In flight** — a ticket between its Claim and its PR's merge: an implementer
  live or owed a replacement on it, or an open PR closing it. A PR closing
  nothing is never in flight, and a ticket whose newest implementer settled
  `blocked` is not either. The tick's `n`; the implementer row's counts read it
  as `implementers=<i> prs=<p>`, n being i + p.
- **In-flight bound** — the most tickets a run lets be In flight at once, fixed
  for the run, set by `/run-team`'s one argument. Reaching it holds every Pull
  until a merge brings the count below it; reviewers, finishers and the merge
  bot never slow for it. The tick's `B`.

**Default: In-flight bound 5, fixed for the run.** See references/pull.md.

**The review backlog never gates, and the merge-queue depth is still no
signal.** The only gate on a Pull is the In-flight count. A deep backlog is a
`DISPATCH review` on the same tick, never a reason to idle an implementer. A
deep `ready-to-merge` queue adds no rebases per PR — each PR rebases exactly
once, when it becomes the candidate — and those PRs count as In flight because
they sit between Claim and merge, not because the queue is deep.

**Reconcile, do not wait for an event.** "A slot is free and the shortlist is
non-empty" is a *level* condition — re-derive the deficit on **every** tick,
whatever woke you: a member finishing, a member bailing before implementing, a
merge landing. An edge-triggered loop that only Pulls on completion stalls
silently the moment the shortlist empties, because 0 implementers emit no
completion event. With the shortlist empty the table below governs — refresh,
and never Pull a ticket the shortlist does not hold.

**Do not re-derive this by hand — `fleet-tick.mjs` computes it.** One invocation
prints per-role `actual/target` and an explicit ACTION with the backlog gate
above and every row of the table below already applied; every wake in Phase 3
ends in it. The deficit is then *computed, not remembered*, which is
the whole point: a table you must remember to consult is one you will not
consult under a merge-side event storm, and that is how implementers reached
0/target with one approved ticket waiting and ~57 `ready-for-agent` in supply while nobody
noticed (#3). What follows stays here as the explanation of what the script decides —
never as a second, hand-run copy of it.

| shortlist (unclaimed) | implementer row prints |
|---|---|
| ≥ 1 | `PULL #N …`, one head per free slot — a Pull each (phase 1) |
| below the In-flight bound, missing or empty | the tick refreshes first — `REFRESHED shortlist: n entries; k lifted` — and Pulls from what it found |
| 0 after that refresh | `SUGGEST /triage, hold idle` |

Whatever the row prints, a `specs-dropped=#<N> (…)` at the end of its counts
names the tickets the to-spec filter kept out of the shortlist — specs
awaiting to-tickets, so an empty shortlist carrying one is not "no work".

The refresh runs at unclaimed < B and, with every other refresh trigger, never
while the bound holds: a refresh then cannot feed a Pull, and the first tick
back under the bound refreshes and Pulls in the same tick.

Four holds outrank every row: `HOLD (draining)` once `ledger.mjs drain` has
recorded the drain, `HOLD (tier mismatch impl-<N>)` until a replacement is
dispatched at the right tier, `HOLD (tier unchecked impl-<N>)` until
`tier-check.mjs` has written its verdict on the newest implementer —
`tier-ok=`, `tier-mismatch=` or `tier-unverifiable=` — and
`HOLD (in-flight <n>/<B>)` when n tickets are between Claim and merge and
n ≥ B — refreshing to enable a Pull you are holding buys nothing.

`HOLD (in-flight <n>/<B>)` ranks last of the four: the other three print in
its place. Its detail is the implementer row's counts, `implementers=<i>
prs=<p> unclaimed=<k> supply=<s>`. It is quiet — a merge brings n below B and
the next tick Pulls — except for a ticket whose newest implementer settled
`killed` or `tier-mismatch`: it counts as In flight with no PR that could
merge, so the row asks for the replacement's dispatch and names it in the
detail. The reviewer row reads `<units>/<B>`, its live review units against
the same bound, and never holds on it.

A main checkout that is not `clean` against its Phase 0 baseline outranks all
of them, and every dispatching row besides: `HOLD (main checkout dirty)`,
`HOLD (main checkout unknown)` or `HOLD (main checkout no baseline)` on the
implementer, reviewer and merge-bot rows alike, beside the `MAIN-CHECKOUT-*`
line that says why.

`/triage` is user-invoked only — suggest, never run. The suggestion is a report,
not a blocking prompt. Counts come from cheap `gh issue list --search`, no bodies.
A starved implementer queue never stalls the review or merge side.

## Invariants

- In-flight tickets at most the bound (default 5), ≤ 1 merge bot. The bound
  counts tickets, not live agents — members fan out and their children consume
  slots you never dispatched.
- A grandchild surfaces as its own task-notification. An unrecognized task-id is
  not a member reporting done.
- A reviewer never reviews a PR it implemented.
- The merge bot only touches PRs whose implementer reported done. Rebasing a
  worktree someone is working in destroys uncommitted work.
- `ready-to-merge` is added by a reviewer only — never an implementer, never you.
  **The run's own artifact PR is exempt, and it is exempt because this invariant
  does not reach it:** what the line forbids is a fleet member signing off its own
  ticket work, which presupposes an issue, an implementer, a `review-pr` run and a
  finisher, and the metrics PR you author has none of them. Label and
  merge that one yourself instead of re-deriving a blocker from this line and
  stranding the rows behind it. The exemption belongs to the run that authors the
  PR and does not outlive it: one still open when the run ends is a PR a prior run
  left open, which phase 0 folds into the next run's review queue as ticket work —
  and a PR is not exempt from being wrong, only from waiting on a reviewer
  no phase of this run will ever dispatch against it.
- **Every member acts through the maintainer's `gh` credentials, so no write is
  attributable.** Any invariant about *who* did something is unenforceable after
  the fact: when a label moves unexpectedly, ask members directly, rule out
  automation with `grep -rn '<label>' .github/workflows/`, and do not re-add it.
- Phase 1 is serial. Everything else may run concurrently.

## Guards

**Verify every reported SHA.** `~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run verify-sha.sh
<branch> <sha>` before enqueueing — a member can commit in a nested worktree,
leaving the SHA on a stray branch while its report reads normally. Exit codes as
`inflight.sh`: `# 0 reachable, 1 not reachable, 2 unanswerable`. Not reachable
(exit 1) → flag, do not enqueue, do not return the ticket to the shortlist until the
maintainer rules. **Exit 2 is not a verdict** — the question could not be
answered, and every cause of it reaches you as one shape: no JSON on stdout at
all, the cause on stderr alone. Read that stderr, fix what it names and re-run;
escalate if it repeats. Never read exit 2 as `not reachable`, and never record it
as a stray commit — the flag and the maintainer's ruling above are what exit 1
earns, and spending them on a probe that never answered costs a member its
ticket over a failure a re-run would have cleared.

**Never `--delete-branch` — the merge bot deletes the head branch itself.**
`gh pr merge <n> --merge` alone: the flag's local cleanup errors on a `main`
held by another worktree, or strands the feature worktree on `main`. After the
merge, `delete-merged-branch.sh <pr>` deletes the branch from `origin` and reads
the deletion back; `reap.sh` takes the `[gone]` local branch and its worktree.
No repo setting is relied on to do it. A branch another open PR still
uses as its head or base is kept instead — `branch-kept-#<that PR>` in the bot's
report, a deliberate keep and not a failure.
The branch-delete step also releases the claim label: it drops `in-progress` from
every issue the PR closes.

**Never force a rebase to start.** No `git clean`, `git checkout .`,
`git reset --hard`, `git stash`. Uncommitted changes may exist nowhere else.
Non-empty `git status --porcelain -unormal` → stop and report — the explicit
mode, never bare `--porcelain`, or `status.showUntrackedFiles = no` reads an
empty answer here and licenses the rebase over work this check exists to
protect. Stashing empties it either way, so that check and
`no-undo-audit.sh` both go quiet on work nothing else holds.

**Cross-check what members report about their environment.** Wrong often enough
to matter, and a confident wrong report from a reviewer flips a verdict.

**Distrust negative claims hardest.** "Nothing else references this", "the sweep
is clean" — most likely false, least likely checked: a grep that found nothing
looks like a grep never run. Make members state their search scope. Negative claim
vs specific finding with paths → paths win.

**Members share one filesystem, one docker stack and one process table**, and the
failures arrive as *wrong findings*, not errors:

- **A pattern kill reaches siblings — the implementer, fix-applier and finisher briefs forbid it.** See references/isolation.md.

  **What the victim's output looks like depends on the signal — and one of the cases is a clean green.** See references/isolation.md.

  So **a complete summary block proves the runner survived, not that the run was
  uncontaminated.** Scrutinize reds, short counts *and* greens from inside the
  incident window; a killed **baseline** compared against a clean mutant is a
  wrong measurement that reads exactly like a real result.

  **The command line is no partition either — not reliably.** See references/isolation.md.

  Members report a stalled run to the controller instead of pattern-killing it,
  and the controller re-checks any measurement taken in the window.

  **Do not guess the victim — the blast radius is the machine, not the Pull.**
  In that incident the controller reasoned from dispatch scope to "almost
  certainly `impl-<N>`" and told the maintainer so; the named member then proved
  it was not the victim (it had never invoked those files standalone, and its
  mutation baselines post-dated the window). Idle members of *previous* runs,
  other omp sessions on the same machine, and the maintainer's own shell are
  all `pkill -f` targets and none of them appear in your ledger. Warn every live
  member, record the incident as unattributed, and re-check measurements by
  timestamp rather than by who you think was running.

- **A warning acted on silently is indistinguishable from one that never
  arrived.** The same incident: the controller's warning DID reach the member,
  which re-ran, found nothing changed, and said nothing — correctly reading
  "send once, never re-send" as covering it. The controller then had to spend a
  round trip asking whether its own outbox was lossy. So the briefs say that
  **confirmation state includes warnings received and acted on, even
  when the outcome is no change** — one line, in the report the member already
  owes. That is the cheap half of the *never read silence as assent* rule, paid
  by the member rather than by the controller's guesswork.

- **Specialist tree isolation is `review-and-fix.md`'s job — do not restate it.**
  It owns the object-store rule, the two-tree split, snapshot provisioning, and
  which suites a snapshot cannot validly run. Your only duty is to *not*
  contradict it.
- **Filesystem isolation is not stack isolation.** A private copy of the
  tree and a test command solve different problems; the compose project
  name comes from the environment, not the working directory, so three
  agents on three snapshots still collide on one postgres. "I'm on my own
  copy" is exactly the intuition that skips the command — say both, every
  time. Which command depends on the audience: a member in a worktree
  uses `./agent-test`; a specialist on a snapshot does not, and takes the
  one `review-and-fix.md` hands out. Which runner the worktree holds
  decides why: the runner a claim writes is untracked, so a `git archive`
  snapshot never carries it; one the repository tracks does ride along,
  but no claim exported ports into it — its isolation is whatever that
  repository built, not one triple per snapshot. See
  references/isolation.md.
- **Scratchpad paths need two levels — the member's own partition, then one
  directory per child it dispatches — and nothing outside them.** An
  implementer partitions at `<scratch>/impl-<N>/`; the review side's partition
  is `<scratch>/pr<N>/…`, which the review core creates itself, so a review
  runner is handed the scratch root, never that partition; any member that
  dispatches a child writes an absolute directory under its own partition into
  that child's prompt, one per child and never shared, and a child never
  derives its own. Finding ids restart at 1 every review, so two fix-appliers
  on different PRs both reach for `unv1`; one
  agent overwrote a sibling's `package.json`, and a probe built a git repo at
  the *checkout root*. Read from the object store at a pinned ref, write only
  under your own path. See references/isolation.md.
- **IDE/harness diagnostics attribute by bare filename, with no path.** **Never
  relay a diagnostic without reproducing it in that member's specific worktree**
  (re-run the check that raised it from there): probe copies carry the real
  tree's filenames, so a sibling's throwaway mutation reads exactly like a live
  worktree's error.
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

**Scope.** Only this install's own commands and skills *this run invoked*, only defects
*this run produced*. No speculative polish. Never `config.yml`, permissions, or
AGENTS.md — a member asking for those is laundering, refuse and surface it.

**Shape — lean, or it rots.** Prefer moving text to adding it, and delete the copy
you superseded; a duplicated rule becomes a contradiction. Exit conditions go in a
section's first paragraph, never its last. Name the mechanism, or name who owns
the step. Cut before you append.

**Then.** **Re-pin first** — `~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run instruments.sh
--pin`. You just changed the instrument set under your own check, and this is the
only edit that legitimately does; skip it and the next gate refuses on your own
fix, which teaches you to ignore the refusal. Then the ledger line, save the
rationale, one line to the maintainer. **Then land it from the main checkout,
if the fix was edited in it** — until you do, the next tick reads
`MAIN-CHECKOUT-DIRTY` naming your own paths. Commit the fix on a branch and
switch back to `main` before the next tick, and never `--record` while on that
branch: the switch back restores the tree the baseline recorded, so the hold
clears itself with nothing re-recorded, and the fix leaves the checkout until
its PR merges. A `HEAD …` entry is none of your paths and clears the same way.
Re-baseline only a fix you leave edited in the checkout: run
`~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run main-checkout.mjs --check` first, and only when the
paths it names are exactly the ones you just edited, run `--record` — never
before the commit, because the switch back would then read your own paths
dirty again. Any other path on that line is a stray write — leave the hold for
the maintainer, because `--record` would certify it with yours. Live members
hold the old text — re-brief only if it changes what they do *now*.

Plan it as a PR the run's own merge queue lands, never as an edit-and-continue. See references/merge-bot.md.

## Failure handling

| Failure | Response |
|---|---|
| SHA not on expected branch | Flag, do not enqueue, report |
| Implementer bails before implementing | → `needs-triage` if under-specified, `ready-for-human` if it needs human hands or leaves a fork open; drop `in-progress`, comment the cause, release the claim, refill (phase 3) |
| Implementer blocked or ambiguous *mid-implementation* | Free the slot, `ledger.mjs settle impl-<N> blocked`, leave `in-progress`, report — the ticket is not In flight and waits for a human; the row above is the pre-code bail, not this one |
| `review-pr` workflow throws or returns no tree | Retry once under the next letter (`review-pr-<pr#>-b`); still failing, report and leave the PR at review-due. Never enqueue the PR as reviewed — the workflow is not a member, so no other row here covers it |
| Reviewer, fix-applier or red-check fixer cannot reach green | Report, leave the PR unlabeled, free the slot — a fix-applier or red-check fixer settles `failed` |
| Merge bot hits the hold rule | Report `held-behind-#<lower>`, PR stays queued |
| Merge bot finds the worktree ahead of the PR head **on the local-rebase fallback** | `worktree-diverged-#<pr>`, PR stays queued. Read the stray commit; push-or-discard is yours, and the maintainer's if the evidence cannot settle it |
| Merge bot finds the head moved after `ready-to-merge` was applied | The label binds to the head's net change, not to one SHA: a proven rebase-carry keeps the label — the bot proceeds and reports `rebase-carry-#<pr>` with the labelled and accepted SHAs, and nothing is dispatched. Any other move is `head-moved-after-label-#<pr>`, PR stays queued, label untouched. Dispatch a **fresh** finisher against the new head — the first audit verified a different tree |
| Merge bot's gate finds the merge would remove lines `main` gained after the PR's work began (`main-gain-removed:<path>`, exit 1) | Relay `main-gain-removed:<path>-#<pr>` to a human with the hit list and the acknowledgement keys the bot printed. PR stays queued, label untouched, nothing written to the ledger, and no member is dispatched to restore the lines — the removal may be deliberate. It clears when the PR stops removing them or its body carries `main-gain-removal: <path> <key> - <why>` for each hit |
| Merge bot's gate cannot answer the main-gain check (`main-gain-unanswerable`, exit 2) | Report `main-gain-unanswerable-#<pr>` with what it printed, PR stays queued, label untouched |
| Merge bot cannot resolve a rebase safely | Stop that PR, report, continue. On a conflict the bot has already appended `conflict-hold:#<pr>` to the PR's row; the tick prints `DISPATCH fix-pr PR#<pr>` and holds the merge until that fix-applier settles. A PR that conflicts before any bot reaches it is the tick's `CONFLICT PR#<pr>` line, whose hold you record |
| Merge bot's gate refuses on its instrument re-check (`instrument-set-changed` or `instruments-unanswerable`, exit 2) | Report `<reason>-#<pr>` with what it printed, PR stays queued, label untouched. Do not re-run the gate |
| Merge bot's CI wait reaches its per-PR time bound with the run's `status` still not `completed` | The bot skips that PR and reports `ci-wait-timeout-#<pr>` with the run id and its status. PR stays queued, label untouched |
| Member silent or truncated | Send to ping or resume — same unit of work; see the state machine below |
| Member idle with work outstanding | Read the PR first, *then* ping. Idle ≠ done |
| Member **killed** (spend limit, API error, crash) | Confirm it is dead first — a frozen transcript does not establish that; see below — then new member, new name, prompt carries inherited state |
| Member **unaccounted** (a live token the tick flags `CHECK-LIVENESS`, or any live token nothing has reported on) | Registry census first: `read history://` once. A row other than `running` → `read agent://<member>` and the artifacts (PR head, worktree, labels), settle the real outcome with the existing vocabulary, and resume a `parked` member with `write agent://<member>` when its work is worth continuing. A `running` row → the mtime discriminator below, two polls: moved means BLOCKED and alive; frozen at both polls **and** no artifact movement → `write proc://<member>/kill`, `ledger.mjs settle <member> killed`, fresh name. Three independent alive-signals — the first poll, the second poll, the artifacts — must all be silent before a kill; the tick settles and kills nothing |

A red PR never silently becomes `ready-to-merge`.

**A frozen transcript does not establish that a member is dead — the discriminator is its scratch dir.** See references/failure-handling.md.

Settle outcome and liveness are different facts, not the same table with two
spellings. Recovery is a fresh member, fresh name (`impl-<N>-b`,
`fix-pr-<M>-b`, and for a reviewer the next letter PR M's rows do not carry
yet) whose prompt states what it inherits.

`hub cancel` leaves a peer hard-aborted and unmessageable, but a `failed` job's peer can stay `idle` and answer normally. No distinct truncated state exists.

Reviewers that went idle on CI recover as a **finisher, not a re-review** once
commits are pushed. See references/member-lifecycle.md.

Audit every worktree before dispatching replacements with
`~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run worktree-audit.sh` — it reports each worktree's
ahead-count and uncommitted files, the committed-vs-uncommitted distinction that
decides whether a replacement redoes or destroys work.

## Run ledger

One git-ignored `.fleet/ledger.md` per run, updated at **every** state change via
`~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run ledger.mjs` subcommands (`row`, `filed`, `ruled`,
`check`, `read`, `dispatch`, `settle`, `review`, `drain`, `rotate`). Your context is the least
durable thing in the run: it compacts, and a controller that loses the dispatch
map or the filed list redoes finished work. Two duplicate tickets shipped in one
run from exactly that.
Compaction parks every in-flight member and nothing reports it, so on resume
take the registry census first (**Member unaccounted**, in **Failure
handling**) before you trust a live token.

**The file lives one run.** Phase 0 rotates it before anything reads it, so
no exclusion, filing, ruling or drain marker outlives the run that wrote it,
and no row does either — except, when the previous run was this session's
own, a row still carrying a live token, which rotate carries forward with
its live `## Dispatched` entries (phase 0). Never rotate mid-run: it is
phase 0's step alone.

One line per ticket, rewritten in place (`ledger.mjs row <ticket> <text>`):

```
#<t1> impl-<t1>=PR#<p1> → PR#<p1> → MERGED 73b356de
#<t2> impl-<t2>=PR#<p2> → PR#<p2> · fix-pr-<p2> · ports=16<t2> · ruled:6-applies · held-behind:#<t3>
#<t3> impl-<t3> · tier=task-high
#<t4> excluded · behind-pr:#<p2>
#<t5> excluded · behind-issue:#<t3>
```

**A member's token is `<member>` while it is live and `<member>=<outcome>` once
it settles** — the grammar is `ledger-grammar.mjs`'s, and the tick derives every
live count from it, so nobody states one. Write neither by hand:

- **`ledger.mjs dispatch <ticket|pr> <member>`** — before the dispatch call,
  marks the member live on its row and appends it to `## Dispatched` with
  `brief=<first 8 hex of its brief's sha256>`. `dispatch
  merge-bot` names the next bot itself. It prints `{member, agent, ticket,
  line, created, total, brief}`, `brief` the `{path, sha256}` of the rendered
  brief the `task` call is handed; `agent` is the definition the `task` call names — an
  implementer's comes off its row's `tier=` (phase 2's tier check states the
  mapping), a finisher's and a merge bot's are their own definitions, and a
  fix-applier's is `fleet-fix-applier` for every kind of work. It
  refuses a member whose `briefs/<member>.json` beside the ledger is missing,
  names another role or carries no sha256, a brief file beside it that is missing or does not hash to that sha256, a name this session already used — on the ledger or in its
  `## Retired` — and names the replacement (`-b`, `-c` …), a
  second live member on one ticket or PR, any implementer once the run is
  draining, an implementer whose row's `tier=` names no single definition
  or one with no file under `agents/`, and a finisher on a ledger the tick
  itself refuses.
- **`ledger.mjs settle <member> <outcome>`** — rewrites the token to
  `<member>=<outcome>` in both places. Outcomes: `impl-N` = `PR#M | bailed |
  released | killed | tier-mismatch | blocked`; `fix-pr-M` = `applied:<head> | no-op |
  failed | killed`; `finisher-pr-M` = `labelled | failed | killed |
  halted:<cause>`, `<cause>` one of `live-editor | rebase | past-pin |
  unreadable | missing | absent | other` (**Resolving a finisher halt**);
  `merge-bot-n` = `done | killed`. A settled member stays settled. `settle
  impl-N=PR#M` also folds a `#M` row a PR-bound dispatch or a `review` made
  before the settle into `#N`'s row, so the PR's row is the one row naming
  each PR from then on — but only when `#N`'s row named no PR before this
  write (a second `PR#` on it would misattribute the fold, or bury `#N`'s own
  fresher `review=` state under an older one) and no implementer claims `#M`'s
  row as its own. `settle impl-N=PR#M` refuses a settle after which a PR maps
  to more than one row when it did not before, judged after the fold — a PR
  has one row, the PR's row; a split already on disk is carried.
- **`ledger.mjs settle <member> --from-report [--reports <dir>]`** — the
  settle for a member that wrote a report: reads `<dir>/<member>.json`
  (`<dir>` defaults to `<scratch>/reports`), derives the outcome from it and,
  before writing, checks what that outcome claims — `PR#M`: `verify-sha.sh`
  on the report's branch and head, and PR M OPEN and closing N; `bailed`: a
  `bailCause`, which the receipt names; `applied:<head>`: origin's branch at
  that head; `no-op`: origin's branch at the head the PR's latest
  `reviewed=` names; `labelled`: `ready-to-merge` on the PR and in the
  read-back; `halted:<cause>`: a cause and non-empty evidence; `done`: every
  PR the bot merged reads MERGED. It then records each `unrecorded` filing in
  **filed** and, for a fix-applier, each refutation the report defers in
  **ruled**, once however often it runs, and prints `{member, outcome,
  checks, filed, ruled}`. Exit 3: a check failed — the member's claim and the
  world disagree — and nothing is written; you rule. Exit 2: the report is
  absent or invalid, or a check could not look, and nothing is written; a
  check that could not look is run again once `gh` and `git` answer. The bare
  form above, for an outcome a report carries, warns `settled without
  --from-report` on stderr.
- **`ledger.mjs review <pr> <token>…`** — the only writer of `review=` and
  `reviewed=` (below): appends each to the PR's row — the ticket row once
  `settle impl-<N>=PR#M` has run, else `#M`, created when neither exists —
  and prints `{pr, row, line, created, next}`, `row` the key written and
  `next` the runner name the PR's next launch takes, null with every letter
  taken. A
  `review=<launch>=failed` whose `review=<launch>` the row holds settles that
  launch in place, alone or with the next launch in the same call. Any other
  token is refused.
- **`ledger.mjs drain "<reason>"`** — the one drain marker per run; supply
  stops, the review and merge sides keep going. It lives in this run's
  ledger, so the next run's rotation retires it with everything else.
- **`ledger.mjs rotate`** — phase 0's first ledger write, every run: moves
  the file as-is to `ledger.<UTC YYYY-MM-DDTHHMMSSZ>.md` beside it under the
  same `<file>.lock`, and the next write starts the empty skeleton — unless
  the previous run was this session's own, when it first writes the rows and
  `## Dispatched` entries still live into a new ledger, and every other
  settled name, or name given an out-of-vocabulary outcome, into its
  `## Retired` (references/phase-0.md, "Rotate the ledger", says which). Refused
  while the recorded controller is alive and not this run's ancestor, ledger
  or none — or, with no record and a ledger to move, while the heartbeat mark
  is still beating, or a tick or ledger write is inside its window with no
  beat — or when the archive name already exists, the process
  table cannot be read, or `.fleet/heartbeat.json` exists but cannot be used
  (unreadable, not JSON, not an object, or a `controller` it cannot judge);
  with no ledger and no such refusal it moves nothing and exits 0. Then it
  records this run's controller in `.fleet/heartbeat.json`. The guard is
  stated in references/phase-0.md, "Rotate the ledger".

`row` refuses a malformed member token anywhere in its text — one whose outcome
is outside the vocabulary above, e.g. `merge-bot-1=dispatched` — at exit 2,
naming the token and writing nothing, because every reader would take it as a
permanent settle. It refuses a write that adds a `review=`/`reviewed=` token
(one the row already holds is carried), and one after which a PR maps to more
than one row when it did not before — `row <M>` creating `#M` for a PR a ticket
row maps, or a rewrite adding a `PR#M` mention to another row — naming the
PR's row (`settle impl-N=PR#M` applies the same rule after its fold).

`→ PR#M` stays as the human-readable arrow; the tick reads only the `=`
tokens. `tier=<cell>` marks an Exploration Pull's cell and `route=<REASON>` a router fallback (phase 2), and `excluded ·
behind-pr:#M | behind-issue:#M` is an Exclusion (phase 1) — a ticket row like
any other, never a section of its own.

A PR's review is not a member, so it carries its own pair of row tokens,
written with `review` onto the PR's row (**Reviewers**): `review=wf:<runId>` |
`review=member:<name>` at launch, `<name>` being
`review-pr-<n>` for the PR's first runner and the next letter its rows do not
carry yet (`review-pr-<n>-b`, `-c`, …) for every later one,
settled dead as `…=failed`, then `reviewed=<head>:<survived>/<refuted>/<unverified>:<run>`
when the result lands, `<run>` the review's `run-XXXXXXXX` run root under
`<scratch>/pr<n>/`, which holds its `review.json`. A row with `review=` and no `reviewed=` is a review in
flight, and the tick counts it as a live review unit unless gh reports its PR
MERGED or CLOSED. `ci=<run-id>:<attempt>:<conclusion>`
and `held-behind:#<lower>` are row tokens the same way (Phase 3), and so is
`conflict-hold:#<pr>` — written by the merge bot itself (`run-merge-bot.md`
step 1), or by you off the tick's `CONFLICT` line, naming the row's own PR. It
is not an Exclusion: that gates a ticket's claim, this a PR's merge. `label-off=<finisher-pr-M[-x]>`
is yours, written before you take `ready-to-merge` off PR M on purpose (taking
it off before you approve a push, or clearing one left on a moved head),
naming that PR's latest finisher attempt: the tick reads a missing label as a
finisher's miss only after the last attempt a `label-off=` names, so without
it your own removal reads as one. `row` and `token` refuse a `label-off=` naming no
`finisher-pr` member that `## Dispatched` or some row already carries.

`review` holds a PR's review record to these rules, read across every row that
maps to the PR — its settled `impl-<N>=PR#<M>` token, else its first `PR#`
mention, else its key — in ledger order. Every `reviewed=` answers the nearest
earlier launch that is neither answered nor `=failed`. A launch identity (a
workflow's runId, or a runner's name, `=failed` aside) appears once, and no launch takes a runner name the
ledger's `## Retired` holds — an earlier run of this session launched it —
naming the next free reviewer name instead. No launch appears
while an earlier one is open — unanswered and not `=failed`. Every
`review=`/`reviewed=` parses. `row` holds the rest: a launch open before the
write is still on one of the PR's rows after it, `=failed` allowed, and a
member name appears once on the line, whatever its outcome. A write that adds
a violation is refused, exit 2, nothing written; one already on the ledger and
carried forward is not. A second launch refused for an open one waits for
that one's `reviewed=`, or — once the Member-killed row confirms its runner
dead — settles it `=failed` in the same `review` call as the new launch.

Plus two append-only lists:

- **filed** (`ledger.mjs filed <issue> <subject>`, checked with `ledger.mjs check
  <subject>` before every `gh issue create`) — so a finding already recorded
  this run is not filed twice. That is not a guarantee against duplicates at
  large; the tracker query below is what covers those. The FILER writes this
  one, not you: `review-and-fix.md` step 5 and finisher duty 2 each run `filed`
  immediately after their own `gh issue create`, with the subject they passed
  to `check`, and report `filed: #N <subject>`. A filer whose `filed` failed
  twice reports `unrecorded: #N <subject>` instead — an `unrecorded` entry of
  its report file — and `settle <member> --from-report` runs `filed` for it.
- **ruled** (`ledger.mjs ruled <pr> <decision>`) — PR + decision + one-line reason,
  so a replacement controller does not re-litigate a settled call.

**Writer policy: the controller owns run state (`row`/`token`/`settle`/`dispatch`/`review`/`drain`/`ruled`); filers append filings with `filed`; all writes are serialized by `<file>.lock`.** See references/ledger.md.

**The suite slots wedge the same ways, and clear the same way.**
`~/.fleet/suite-slots/<i>.lock` is built on the ledger's lock primitive, so an empty or
unparseable `<i>.lock` and a leftover `<i>.lock.reap` are permanent, a zombie
holder is transient, and a dead holder is taken over. A wait that expired with
exit 75 names each wedged file — remove it by hand once no suite run is
running, the way references/ledger.md removes `<file>.lock`.

**The gap the lock does not close:** `check` → `gh issue create` → `filed` is three commands, and the lock covers each one alone, so two filers can both read `clean` in the seconds before either records. See references/ledger.md.

`check` exits **0** clean, **1** already in this run's filed list, **2** usage error (no JSON on stdout), **3** the ledger is clean but open or closed tracker issues match — read those and decide. See references/ledger.md.

The ledger half reports its own readability as its own field, `ledger.ok`, the
peer of `tracker.ok`: false when the file did not exist, and false too when the
path led to something that did not parse as a ledger — which is what tells a
ledger that was read and held nothing filed from one there was nothing to read. The absent case is the normal one for a run's first `check` — `.fleet/`
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

Plus a queue-depth line: shortlist, supply, whether triage was suggested.

## Red flags

- "Fork the controller so the member has context" → fork inherits everything.
- "This member finished, send it the next ticket" → resumes its transcript.
- "The name is cosmetic" → the name is the ledger token and the hub address.
- "ready-for-agent came back empty, widen to ready-for-human" → empty with no `specs-dropped=` means no work; empty with drops means specs awaiting to-tickets, and is still never a reason to widen.
- "The reap at the end will pick up the claim I never dispatched" → it declines:
  not `[gone]`, no unique commits. Release it, or it reads as taken next run.
- "Touches eight files, too big for the fleet" → size is not the axis. Decided is.
- "Body is three lines, so it's simple" → short bodies hide open design choices.
- "The brief is thorough, so it's decided" → thorough ≠ decided. Read it for the
  choice it leaves open.
- "I'd have to pick an approach myself" → that IS undecided.
- "It reported the SHA, so it's on the branch" → verify.
- "Let the merge bot arm its own monitor" → it dies, the queue stops.
- "The member died, message it the state" → dead agents do not read mail.
- "Its CI is green, ship it" → check behind-count; green decays invisibly.
- "The specialist says nothing else references it" → the claim most often wrong.
  Ask what scope it searched.
- "Five implementers = five times throughput" → reviews are 3-5x longer. It means
  a backlog.
- "A quick install to set up the worktree" → the claim already ran the Recipe's
  Install step; any other install can rewrite the lockfile for the whole repo.
- "I'm on my own copy, so I'm isolated" → not from the docker stack.
- "`commit-commands:clean_gone` printed nothing, the tree is clean" → its
  `[gone]` detection works fine; it just runs `-D`/`--force` with no merged
  check, so "printed nothing" only means nothing was gone yet, not that it's safe.
- "`--force` the worktree removal, the PR merged anyway" → merged says nothing
  about uncommitted files, and the reviewer may still be in there.
- "Reap once at the end of the run" → stale worktrees make phase 0 read merged
  tickets as taken, so the starvation compounds with every Pull.
