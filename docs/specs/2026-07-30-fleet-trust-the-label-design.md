# Fleet admissibility — trust the label, gate on *decided*, not on *size*

Date: 2026-07-30
Status: implemented in PR #59 (`candidates.mjs`, `run-team`, `sizing-a-ticket`, `next-ticket`)

Artifacts: `skills/fleet/skills/run-team/SKILL.md`,
`skills/fleet/skills/sizing-a-ticket/SKILL.md`,
`skills/fleet/scripts/candidates.mjs` (repo `feigi/claude-config`)

Base: `6eb0442`. All line references verified against that commit.

## Problem

Phase 0 admits a ticket only if `sizing-a-ticket` calls it **light**
(`run-team:57-61`). That gate is wrong on the axis and expensive in the way it
is paid.

**Wrong axis.** The design of record already argues for the axis we want.
`docs/specs/2026-07-22-run-team-agent-fleet-design.md:211-213` justifies the
filter as: *"A ticket can be correctly labeled `ready-for-agent` and still be
too open-ended to hand a background implementer."* Open-endedness — whether
what to build is decided. But `:193` implements it by importing `next-ticket`'s
row table wholesale, and that table (`sizing-a-ticket:14-15`) ANDs open-endedness
together with *"one-two files"* / *"more than ~3 files"*. Intent is ambiguity;
mechanism is size. A large, fully-decided ticket — a mechanical rename across
eight files with acceptance criteria — is heavy by the table and excluded, forever.

The exclusion is also unappealable by construction. `sizing-a-ticket:25` and
`run-team:547` both state that a thorough Agent Brief *never* promotes a heavy
row. The brief is the artifact that makes a big ticket safe to run unattended,
and it is ruled inadmissible as evidence.

**Expensive shape.** Sizing is a subagent per survivor, each reading the full
issue body and comments. It is re-paid on every re-shortlist (whenever the pool
empties), and the verdict is deliberately discarded — `run-team:164-165` refuses
to write it back, on the sound principle that *"an unclaimed ticket is not yours
to reclassify."* The member then re-derives it a third time at `run-team:133`.
Three payments, per ticket, per wave, for a property of the ticket that does not
change.

**The label already carries the verdict.** `~/.agents/skills/triage/SKILL.md:35`
defines `ready-for-agent` as *"fully specified, ready for an AFK agent"*, and
`:80` makes `ready-for-human` record *why* a ticket cannot be delegated. The live
label description reads *"Needs a maintainer session, not an AFK agent."* Triage
reaches that verdict with the maintainer in the loop (`:72` waits for direction),
after codebase exploration and a redundancy check, and attaches a brief (`:79`).
Phase 0 recomputes that judgment with strictly worse inputs.

## What this changes

Admissibility asks **is what to build decided?** — never **how big is it**.

## The criterion

Applied at phase 0 during a read that already happens, and again by the member
in phase 2 with the repo in front of it.

**The question.** Would two competent implementers, reading only this ticket,
build materially different things?

**What "material" means.** Defined by inventory, not by feel. For each decision
the ticket leaves to the implementer:

| Left open | Verdict |
| --- | --- |
| architecture, API shape, schema, UX | **undecided** |
| new dependency, new seam | **undecided** |
| naming, file layout, ordering, test arrangement | decided — ignore |

Any undecided item → the ticket is not decided. Name the item; it is the
exclusion or demotion comment.

**Torn → surface, never guess.** A hard case is not resolved by phase 0. It goes
to the maintainer in the multi-select, flagged with the open decision. This is
the tie-break, and it is the *opposite* of `sizing-a-ticket:8`.

**Size is not the axis.** Red flags, to be stated in both skills:

- *"touches eight files, too big"* → size is not the axis.
- *"body is three lines, so it's simple"* → short bodies hide open choices.
- *"the brief is thorough, so it's decided"* → thorough ≠ decided; read it for
  the choice it leaves open.
- *"I'd have to pick an approach myself"* → that **is** undecided.

## Phase 0

Steps 1–3 unchanged: candidate scan with `--require-label ready-for-agent` and
no fallback, dependency scan, in-flight check.

**Step 4** keeps the full-issue read and now answers two questions from it —
`Out of scope` sequencing (as today, `run-team:57-58`, and still load-bearing per
`:75-76`) *and* decided? No sizing subagent, no second fetch. The judgment rides
a read that is already paid for.

**Step 5** — *"Light row only"* — is deleted.

**Step 7** presents three groups instead of two, each ordered FIFO (below), and
each entry annotated when step 4's `Out of scope` read sequences it after another
survivor in the same list:

- **admitted** — decided, staged into the pool by the maintainer;
- **unsure** — torn, each flagged with the open decision;
- **excluded** — undecided, each with the decision that is missing.

The sequencing annotation is what keeps `run-team:75-76` enforceable once FIFO
puts a chain's members next to each other. Without it, two consecutive numbers
read as two independent tickets.

**The tick is staging, not vetting.** This distinction is load-bearing, because
phase 0 was conflating two questions. *Is this ticket fit for an agent?* was
already answered by triage when it applied `ready-for-agent`, with the maintainer
present — phase 0 must not re-litigate it, or the double-payment this design
removes in tokens simply reappears in the maintainer's attention. *Which of these
do I start now?* — how many, in what order, what collides — is a dispatch
decision that stays the maintainer's, every wave. An unticked ticket is therefore
deferred, never judged unfit. The **unsure** group is the only place phase 0 asks
for a judgment rather than a dispatch choice.

No relabelling at phase 0, preserving `run-team:164-165`. An unticked ticket
keeps `ready-for-agent` and re-surfaces next wave.

## Candidate ordering — FIFO

Nothing sorts today. `gh issue list` defaults to created-desc, so the list
arrives newest-first and "best first" (`run-team:71`, `next-ticket:44-46`) is a
model re-rank on every wave against *unblocks #X, small, adjacent to current
branch*.

`candidates.mjs` sorts ascending by issue number — monotonic in creation order,
already in the payload, no extra field or query semantics. The ranking prose
reduces to one line: **among the survivors, oldest first.**

Dependencies are a *constraint*, not a ranking input. Step 2 already drops any
ticket whose blocker is open, so everything reaching step 7 is free to start, and
step 7's annotation keeps a sequenced pair out of a single wave. Neither needs
the ordering to express it — which is what lets the sort avoid the `d` array the
*Out of scope* section records as empty for every `to-tickets` chain. FIFO also
gets blocker-before-blocked for free: `to-tickets` publishes chains
blockers-first, so blockers carry the lower numbers.

All three "best first" criteria go. **"Unblocks #X"** ranked among tickets that
step 2 has already established are unblocked. **"Small"** is the same size axis
this spec removes from the gate — keeping it as a ranking input would leave two
rules about size pointing opposite ways in one skill. **"Adjacent to current
branch"** is meaningless to the fleet, whose members each get a fresh worktree;
it stays relevant only to `next-ticket`'s solo flow, where it is retained.

Ordering moves from the model to the script, so a wave costs one deterministic
sort instead of a ranking judgment.

**Known interaction.** `to-tickets:63` publishes chains blockers-first, so a
sequenced pair gets consecutive numbers and FIFO renders them adjacent — while
`run-team:75-76` forbids putting both in one wave. Step 2 should drop the blocked
one, but that is the scan the *Out of scope* section records as broken for
`to-tickets` output. FIFO does not cause this and is not blocked by it; it does
make the pairing more visible, which raises the dependency-scan fix's priority.
Until it lands, the `Out of scope` sequencing note read at step 4 is the only
guard, and phase 0 flags a sequenced pair rather than presenting both as free.

## Phase 2

The member reads the issue before touching code. If what to build is still
undecided with the repo in front of it — or the ticket needs human hands the
member does not have — it bails before implementing, **naming the cause**, and
demotes accordingly:

| Cause | Label | Why |
| --- | --- | --- |
| brief does not decide *what* to build | `needs-triage` | routes back to `/triage`, the producer that can fix it; returns as `ready-for-agent` |
| needs human hands — external access, manual testing, judgment during the work | `ready-for-human` | matches `triage:80` |

Either way: drop `in-progress`, comment the reason, release the claim, refill
with a different ticket. Dropping `in-progress` remains the load-bearing half
(`run-team:157-162`) — both `candidates.mjs:43` and `next-ticket` exclude it, so
leaving it makes the ticket invisible to every scan.

Otherwise the member runs `sizing-a-ticket` for the **process path** and proceeds
on **either row**. Heavy is never a bail reason.

**On the heavy row a fleet member enters at `superpowers:writing-plans` and skips
`superpowers:brainstorming`.** Brainstorming's `<HARD-GATE>` forbids writing any
code until a design has been presented and the user has approved it, and its
checklist requires approval per section. A fleet member has no channel to the
maintainer (`run-team:51-52`), so running that step leaves it two bad options:
stall waiting for an approval that cannot arrive — which the controller reads as
idle, burning the slot — or answer its own questions and approve its own design,
which is the fleet deciding *what* to build, forbidden by the invariants below.

A decided ticket has already been brainstormed. The `## Agent Brief` is that
output, produced by `/triage` with the maintainer in the loop, and admissibility
has already established that it decides what to build. If the brief will not
support a plan, that is the undecided case above — bail and demote, do not
brainstorm.

`next-ticket`'s solo flow is unaffected: a user is present there, so it runs the
full heavy path including brainstorming.

`run-team:479` is untouched: ambiguity discovered *mid-implementation* frees the
slot, leaves `in-progress`, and reports. Early bail has no diff; mid-implementation
does, and demoting would hide committed work behind a label that does not mention it.

## Two opposite tie-breaks, deliberately

`sizing-a-ticket` keeps *"torn → take the heavier"* (`:8`) for its own question,
process depth, where conservatism is correct. The admissibility gate takes
*"torn → surface"*. Both must be stated explicitly in both files. An agent that
reads one and applies the other's bias reverts this design silently, and that is
the most likely way it fails.

`sizing-a-ticket:19` currently reads *"unattended fleet excludes ticket"*. That
sentence is removed — the skill no longer decides admissibility for anyone.

## The `to-spec` filter

Independent of the gate. `/to-spec` publishes a whole spec as one issue and
stamps it `ready-for-agent` with *"no need for additional triage"*
(`skills/to-spec/SKILL.md:19`). A spec is `to-tickets`' input (`to-tickets:17`),
not a claimable ticket — inadmissible regardless of how well decided it is.

`candidates.mjs` drops candidates whose body carries a `## User Stories` heading,
mandatory in to-spec's template and absent from every ticket template. The scan
joins the existing `--jq` reduction, so it costs nothing extra:

```js
'spec:((.body//"")|test("(?m)^##\\\\s+User Stories\\\\s*$")),'
```

Dropped numbers are logged, per the file's own no-silent-caps rule
(`candidates.mjs:77-78`). A `ponytail:` comment names the ceiling, and the
ceiling is sharper than it first looked: this filter is the *only* line of
defence. Nothing downstream catches a spec — it is decided and needs no human
hands, so both of phase 2's bail tests pass it, and this same design makes heavy
never a bail reason, retiring the light-row gate that used to stop it. An
upstream template change to to-spec must be mirrored here in the same commit.

`skills/to-spec/SKILL.md` is a detached copy, not a symlink into
`~/.agents/skills/`, so editing it *would* be safe. Deliberately not done: the
filter defends against every producer, is versioned, and does not drift from
upstream.

## Edits

| File | Change |
| --- | --- |
| `run-team:57-58` | step 4 reads for sequencing **and** decided?; no sizing subagent |
| `run-team:59-61` | step 5 deleted |
| `run-team:71-73` | multi-select gains the **unsure** group; "best first" → FIFO among survivors; sequenced survivors annotated |
| `run-team:133-135` | member: read → bail+demote if undecided; else size for path, proceed on either row, heavy entering at `writing-plans` |
| `run-team:157-162` | demotion split by cause |
| `run-team:352-353` | supply = open `ready-for-agent` surviving in-flight scan |
| `run-team:478` | failure row: trigger becomes "what to build is not decided" |
| `run-team:547` | red flag deleted; replaced by the size-is-not-the-axis flags |
| `sizing-a-ticket:8` | scope the tie-break to process depth, not admissibility |
| `sizing-a-ticket:15` | note that the fleet enters the heavy path at `writing-plans`; row table unchanged |
| `sizing-a-ticket:19` | drop "unattended fleet excludes ticket" |
| `sizing-a-ticket:25` | scope the flag to process depth |
| `candidates.mjs:44-46` | `spec:` predicate in the jq; drop and log matches |
| `candidates.mjs` (after parse) | sort ascending by `n` |
| `next-ticket:44-46` | FIFO among survivors; drop "unblocks #X" and "small"; keep "adjacent to current branch" for the solo flow |

## Testing

`candidates.mjs` is the only executable change. Cases:

1. spec-shaped body (`## User Stories`) → dropped;
2. ticket-shaped body → kept;
3. a drop emits the issue number on stderr;
4. the `spec` key is stripped from the emitted payload;
5. results ascending by number whatever order `gh` returned them in.

**Accepted false positive.** The match is a plain regex with no markdown
awareness, so a ticket whose body quotes `## User Stories` inside a fenced block
is dropped too. Not worth a fence parser: every drop is logged by number, so the
failure is loud rather than silent, and the maintainer sees the ticket leave the
queue. Recorded in the `ponytail:` comment beside the predicate.

Everything else is skill prose, which has no test coverage. The existing 125 tests
stay green as a regression gate on the script, not as evidence about the prose —
the check on the prose is that the two opposite tie-breaks are stated in both
files.

## Acceptance criteria

1. All five test cases above pass; the existing 125 stay green.
2. `sizing-a-ticket` is not invoked anywhere in phase 0.
3. Both tie-breaks — *torn → surface* for admissibility, *torn → heavier* for
   process depth — appear in **both** `run-team` and `sizing-a-ticket`.
4. No file-count or ticket-size wording survives in any admissibility rule —
   including the *ranking* prose, where "small" is removed.
5. Phase 0 presents every group FIFO, and annotates any survivor the `Out of
   scope` read sequences after another survivor in the same list.
6. **Caveman compression applies to every edited line of LLM-consumed prose** —
   `run-team/SKILL.md`, `sizing-a-ticket/SKILL.md`, `next-ticket/SKILL.md`,
   and any `references/*.md` touched. Drop articles and filler; fragments are
   fine; keep code, paths, commands, and line references verbatim. It is a
   standing rule, not specific to this change: skill prose is re-read into
   context on every invocation, so wording is billed per read, not per write.
   This document is not LLM-consumed and stays normal prose.

## Invariants

- The fleet **demotes** autonomously and **never promotes**. Only triage, with
  the maintainer, writes `ready-for-agent`. A mislabelled ticket therefore costs
  one member bail and lands in a human's queue — bounded, and self-correcting
  toward the human.
- Phase 0 never relabels an unclaimed ticket.
- Ordering is a script sort, never a model judgment. Dependencies constrain which
  tickets appear and which may share a wave; they never reorder what is left.
- Phase 0 never resolves a torn case; it surfaces it.
- `--require-label ready-for-agent` stays mandatory with no fallback.

## Out of scope

- **Dependency-scan defect.** Verified this session: `candidates.mjs:46`'s regex
  requires `blocked by #12` inline, but `to-tickets:99-101` writes a
  `## Blocked by` heading with `- #12` list items, and `:63` prefers GitHub
  native sub-issue links, which are not in the body at all. Measured against the
  live expression:

  | body | `d` |
  | --- | --- |
  | `## Blocked by\n\n- #12\n- #13` | `[]` |
  | `Blocked by #99 inline form` | `["Blocked by #99"]` |

  Every `to-tickets` chain reaches the fleet with no dependencies, so phase 0
  step 2 admits blocked tickets — exactly what `run-team:75-76` warns bites
  hardest at five wide. Own ticket; no ordering dependency with this work, which
  neither causes nor worsens it.
- **`to-spec:19` producer edit** — redundant with the filter.
- **Label-remap coupling.** `setup-matt-pocock-skills` Section B lets a repo
  rename all five labels; `candidates.mjs:43` and `run-team` hardcode them.
  Against a remapped repo the query matches nothing and reads as "no work", which
  `candidates.mjs:11` treats as authoritative. Only bites if this repo remaps.
- **Dead starvation counts.** Moot as of #54 — `needs-triage` and `needs-info`
  now exist, so `2026-07-22:292`'s counts resolve.
- **Doc gloss mismatch.** `docs/agents/triage-labels.md` glosses `ready-for-human`
  as "Requires human implementation"; the live label reads "Needs a maintainer
  session, not an AFK agent". Close enough that the phase 2 split is unambiguous.
