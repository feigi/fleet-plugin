# The workflow's specialists have no diff, so they read whole files to find the change

Ticket: #194. Base: `ac110b5`. Suite at base: 262 pass.
All line references below verified against `ac110b5`.

Closes #194 — and declines the mechanism #194's second comment proposes. See
**Out of scope**.

## Problem

`workflows/review-pr.js` dispatches six specialists (`:356-383`) and up to two
refuters per finding (`:400-412`). Their prompts carry snapshot isolation, the
`testCmd` reading rule, a scratch dir, and report-what-you-ran. They carry no
rule about how to read a file, and no way to see what the PR changed.

#181 measured the consequence: 88 unpiped whole-file reads carrying 434 KB
(~110k tokens), re-billed as cache-read on every subsequent turn — the largest
attributed line item in a 92-subagent run.

### 1. The specialists cannot see the diff

`review-pr.js` hands each specialist a snapshot path and a PR number. The
snapshot is cut with `git archive HEAD | tar -x` (`:284`), so it is **not a git
repository** — `skills/fleet/commands/review-and-fix.md:42` already records this
("a `git archive` copy is not a git repo"). No `git diff`, no `git show`, no
`git log` runs inside it.

The specialists are `pr-review-toolkit` agents. Their stated default is to read
`git diff`:

- `agents/code-reviewer.md:21` — "By default, review unstaged changes from
  `git diff`. The user may specify different files or scope to review."
- `commands/review-pr.md:31` — "Run `git diff --name-only` to see modified
  files"

In a non-repo snapshot that default fails. The only fallback available to an
agent that must find a change and cannot diff is to read files whole.

**This is the root cause of the measured cost.** A bounded-read rule alone does
not remove it: an agent that does not know which lines changed cannot choose a
line range. It treats the symptom.

### 2. Nothing tells them to bound a read

`review-and-fix.md:47` owns the rule — source-of-truth first, then bound the
read, whole file only after a line count. `run-team/SKILL.md:684` delegates to
that file deliberately ("Specialist tree isolation is `review-and-fix.md`'s job
— do not restate it. It owns the object-store rule"). But `review-pr.js`'s
specialists never read `review-and-fix.md`; nothing in the workflow points at
it, and a subagent is not handed the command file its dispatcher used.

So the rule reaches the hand-dispatch path only, and the hand-dispatch path is
the fallback (`review-and-fix.md:33`, "The controller runs the workflow;
everything below is the fallback for when it cannot").

### 3. The ticket names only the specialist prompt; refuters read too

#194's acceptance criteria address "the specialist prompt block". The refuter
prompt at `:401-410` sends up to two agents per finding to "Verify against the
snapshot ${snap.path} by RUNNING something" — the same reads, the same files,
against a population that scales with finding count rather than dimension count.
Fixing one prompt and not the other repeats the exact drift shape #194 exists to
close.

### 4. The object-store rule is not executable where the workflow stands them

#194 asks for "the bounded-read rule — read at a revision via the object store".
On this path there is no reachable object store: the snapshot is not a repo, and
`:363` says "Never read or write `${worktree}`" without qualification, so
`git -C ${worktree} show <sha>:<path>` reads as forbidden.

It is also unnecessary. The snapshot **is** the object store, materialized: it
is `git archive HEAD`, and the snapshot agent already verifies byte-identity
against `git show HEAD:<path>` at `:286-287`. The contamination hazard that
motivates the object-store rule on the hand-dispatch path — a live worktree
mutating under a reader — does not exist here, because nobody reads the
worktree.

So the rule that ports to this path is the **bounding** half. The
source-of-truth half is already satisfied by construction and only needs to be
*stated*, so a specialist does not go looking for a git command to settle what
the snapshot already settles.

## What this changes

One file: `workflows/review-pr.js`. One new test file. No new scripts, no doc
edits, no change to `review-and-fix.md` or `run-team/SKILL.md`.

## Change 1 — the snapshot agent writes the diff once

The snapshot agent (`:280-312`) already runs in `${worktree}`, already runs
`gh`-backed tooling (`diff-stats.mjs --pr ${pr}`, `:291`), and already returns
structured data. Add two commands to its prompt and three optional schema
fields.

Prompt, after the archive block at `:283-284`:

```
Then capture the PR's diff for the specialists:

    gh pr diff ${pr} > ${scratch}/pr.diff

Report, always: `prHead` = 'gh pr view ${pr} --json headRefOid -q .headRefOid',
and `diffLines` = the line count of ${scratch}/pr.diff. Report `diffPath` only
if gh exited 0. Do not judge whether the diff is usable — report the three
values and let the caller decide.
```

Schema (`:298-312`), alongside `path`, `head`, `diffStats`:

```js
// All three optional, never required. `gh` reaches the network and can fail —
// no auth, PR deleted, rate limit — and a required field would abort a review
// that is otherwise fully runnable. The caller gates on them; see usableDiff().
diffPath: { type: "string" },
diffLines: { type: "integer" },
prHead: { type: "string" },
```

`gh pr diff` resolves owner/repo and merge base itself from the worktree, which
is why this needs no `base` sha and no `merge-base` call. One fetch serves every
specialist and every refuter, instead of each one deriving the change on its
own.

`${scratch}/pr.diff` sits beside `${scratch}/snapshot` (`:283`); the snapshot
agent already owns that directory.

### The diff is gated in JS, not by the agent

Two silent-failure paths, both measured at `ac110b5`:

- **`gh pr diff` writes an empty file on failure.** `gh pr diff 999999` exits 1
  and leaves 0 bytes. Redirected, the file exists. A specialist handed a 0-byte
  diff reads "this PR changed nothing" — the same silent green as `tests 0`.
- **The PR head and the snapshot head can disagree.** The snapshot is local
  `HEAD`; `gh pr diff` returns the *pushed* head against its merge base.
  Demonstrated at `ac110b5`: local `HEAD` was `ac110b5`, `gh pr view 216 --json
  headRefOid` returned `482e523`. A specialist reading a diff for a different
  commit than the tree it inspects can report a finding about code that is not
  in the snapshot.

So the workflow decides, not the agent:

```js
// The snapshot agent reports three raw values and no judgement. This is the
// judgement, in deterministic code, for the same reason `diffStats` is
// transported as an opaque string (schema comment at :305-310) and parsed by
// the caller (:330-337): an agent asked to decide can decide wrong and report a
// path anyway.
//
// Every clause is a measured failure, not a hypothetical. `gh pr diff` exits 1
// and writes 0 bytes on a bad PR number; local HEAD and the PR's headRefOid
// diverge whenever the worktree holds an unpushed commit. Either one hands
// specialists a diff that lies about the tree they are reading.
function usableDiff(snap) {
  if (!snap.diffPath) return null;
  if (!snap.diffLines) return null;
  if (snap.prHead && snap.prHead !== snap.head) return null;
  return snap.diffPath;
}
```

`prHead` missing is NOT disqualifying — `gh pr view` can fail on its own while
`gh pr diff` succeeded, and dropping a good diff over a missing cross-check
narrows coverage on absent input. That is the `=== true` convention
`review-pr.js:255-257` already records. A *present and mismatched* `prHead` is
disqualifying; that is a positive signal of divergence.

### Why not have each specialist run the diff itself

Considered and rejected. It requires a `base` sha in the schema, and it requires
narrowing `:363` from "never read or write `${worktree}`" to a two-clause rule
distinguishing working-tree reads from object-store reads. That rule is correct
but subtle, and every specialist would have to apply it correctly every time.
Writing the diff once turns it into a file path, and the blanket ban at `:363`
stays blanket.

## Change 2 — `readRules(diffPath, stats)`, interpolated into both prompts

A single module-level function, declared near `DEFAULT_DIMENSIONS` (`:85-123`),
returning the prompt block. Two call sites: the specialist prompt (`:360`) and
the refuter prompt (`:401`).

```js
// The read rules every agent in this workflow obeys — specialist and refuter
// alike. One function, two call sites: the Workflow sandbox forbids `import`
// ("no filesystem or Node.js API access"), so this is as close to single-source
// as this file gets, and `review-pr-reads.test.mjs` pins both interpolations
// rather than the prose. Prose lifted into a second copy disconnects in one
// token; that is this repo's recurring pin defect.
//
// `review-and-fix.md:47` owns the prose rationale, for the hand-dispatch path.
// This is the operational form for the workflow path, where the premise
// differs: there is no live worktree to be contaminated BY, because the
// snapshot IS the object store already materialized.
function readRules(diffPath, stats) {
  const change = diffPath
    ? `The PR's whole diff is at ${diffPath}. Read it FIRST, bounded — it is the
change you are reviewing, and the snapshot around it is context.`
    : stats && stats.paths && stats.paths.length
      ? `No diff file was captured. The PR touched exactly these files (changed
loc in parens) and no others:
${stats.paths.map((p) => `  ${p.path} (${p.loc})`).join("\n")}`
      : `No diff file and no file list were captured. Scope your reading from
the review request itself; do not survey the snapshot.`;

  return `${change}

The snapshot IS the source of truth: 'git archive HEAD', byte-identical to
'git show HEAD:<path>' — verified when it was cut. No agent can contaminate it
and no git command settles what the PR contains any better. A finding that
disagrees with the snapshot is a probe artifact.

BOUND EVERY READ: an offset and a limit, or '| sed -n A,Bp'. Take a file whole
only after 'wc -l' says it is small — a count, not a feeling. An unbounded read
is never a one-off cost: it rides your prefix for every remaining turn,
re-billed as cache-read each time. Measured over one run, 88 unpiped whole-file
reads carried 434 KB.`;
}
```

Both call sites are the identical expression
`${readRules(usableDiff(snap), stats)}`, which is what makes the call-site pin
in Change 3 a two-token check.

### Why refuters get the same block

A refuter is handed a claim, a `file:line` and evidence (`:403-405`) and told to
verify by running something. It reads the same files from the same snapshot. It
is also the population that scales with *findings*, not dimensions — on a PR
with twenty findings the refuters outnumber the specialists three to one. Giving
them the diff also makes "is the claim true of the code as merged?" (`:409`,
lens 1) answerable by reading the change rather than the file.

### The three branches are the failure handling

- `usableDiff` returned `null` — gh failed, the file was empty, or the heads
  diverged → the changed-file list carries, from `stats.paths`, which
  `diff-stats.mjs` already emits (`path`, `kind`, `loc` per file) and
  `review-pr.js:333` already parses. Today that data is used by
  `selectDimensions` and then dropped.
- `diff-stats.mjs` also failed, or its blob was unparseable → `stats` is already
  `null` at `:330-337` → third branch. Says so explicitly rather than emitting
  an empty list, which would read as "the PR touched no files".
- No path can produce a dangling reference or an empty interpolation. The
  degraded case is today's prompt plus the bounding rule, never a worse one.

## Change 3 — `skills/fleet/scripts/review-pr-reads.test.mjs`

New file, matching the sibling convention of one concern per test file
(`review-pr-testcmd.test.mjs`, `select-dimensions.test.mjs`,
`review-path-default.test.mjs`).

Lift `readRules` and `usableDiff` out of the source text with `new Function`,
exactly as `select-dimensions.test.mjs:23-40` lifts `selectDimensions` and for
the same reason: `review-pr.js` runs a top-level `await pipeline(...)`, so
importing it executes the workflow, and moving the functions to a module would
require `import` to resolve inside the Workflow sandbox — which nothing in
`workflows/` does, and a failed import bricks the fleet's default review path.

Ten tests.

**`readRules` behaviour** (against the lifted function):

1. diff path present → output names that exact path, and does **not** list
   files. Guards against emitting both and doubling the block on large PRs.
2. diff path absent, `stats.paths` present → every path appears, each with its
   `loc`, and the block says no diff was captured.
3. diff path absent, `stats` `null` → the third branch, and specifically **not**
   an empty file list. Assert the absence of a bare `touched exactly these
   files` header with nothing under it.
4. diff path absent, `stats` present but `paths` empty → third branch, same
   reasoning. `stats.paths.length` is the guard; a `stats` object without usable
   paths must not fall into branch 2.
5. Every branch carries the bounding rule. Assert on `BOUND EVERY READ` and on
   the `wc -l` clause, not on a word that also appears in the rationale prose.

**`usableDiff` gating** (against the lifted function) — each case is a measured
failure, not a hypothetical:

6. Returns `null` for: `diffPath` absent; `diffLines: 0` with a path present
   (the `gh pr diff 999999` case — exit 1, 0 bytes, file exists); `prHead`
   present and unequal to `head` (the `ac110b5` vs `482e523` case).
7. Returns the path when `prHead` is **absent** and everything else is good.
   Missing input must not narrow coverage — the inversion `review-pr.js:255-257`
   already records, and the one this guard is most likely to get wrong.

**Call-site pins** (against the source text) — the part that matters, per the
disconnect-in-one-token defect this repo has shipped:

8. `readRules` and `usableDiff` are each declared exactly once at top level.
9. The specialist prompt slice contains `${readRules(`. Anchor the slice on
   `READ ONLY FROM THE SNAPSHOT` and terminate it on `Scratch files go in`,
   asserting `indexOf !== -1` for **both** anchors — the same bounded-slice
   discipline as `review-pr-testcmd.test.mjs:103-107`, whose comment records
   that an unbounded slice ran to EOF and was satisfiable from the refuter
   prompt further down.
10. The refuter prompt slice contains `${readRules(`. Anchor on
    `Try to REFUTE this finding` and terminate on `Scratch: `.

**Mutation-tested both ways before merge**, per this repo's standing rule that a
pin proven to fail is not proven to discriminate. Record the results in the PR
body:

| Mutation | Expected |
|---|---|
| delete the specialist interpolation | 9 red, 10 green |
| delete the refuter interpolation | 10 red, 9 green |
| delete the `BOUND EVERY READ` paragraph | 5 red |
| branch 2 guard drops `.length` | 4 red |
| `usableDiff` drops the `diffLines` clause | 6 red |
| `usableDiff` drops the `prHead &&` presence check | 7 red |
| behaviour-preserving reformat of `readRules` | all green |

## Edits

| File | Location | Edit |
|---|---|---|
| `workflows/review-pr.js` | after `:123` | add `readRules(diffPath, stats)` + `usableDiff(snap)` + their comments |
| `workflows/review-pr.js` | `:284` | add the `gh pr diff` block to the snapshot prompt |
| `workflows/review-pr.js` | `:293-297` | extend the report instruction with `diffPath` / `diffLines` / `prHead`, restating that only `path` and `head` are required |
| `workflows/review-pr.js` | `:310` | add the three optional fields to the snapshot schema |
| `workflows/review-pr.js` | `:360` | interpolate `${readRules(usableDiff(snap), stats)}` |
| `workflows/review-pr.js` | `:401` | interpolate `${readRules(usableDiff(snap), stats)}` |
| `skills/fleet/scripts/review-pr-reads.test.mjs` | new | the 10 tests above |

Not edited: `:287` (see Out of scope), `:363` (blanket worktree ban stays),
`review-and-fix.md`, `run-team/SKILL.md`.

`additionalProperties: false` is set on the snapshot schema (`:300`), so all
three new fields must be declared or a compliant agent's report is rejected.

## Testing

`node --test skills/fleet/scripts/*.test.mjs` — 262 at base, expected 272.

`review-pr-testcmd.test.mjs:98-124` slices the specialist prompt between
`READ ONLY FROM THE SNAPSHOT` and `Scratch files go in`. Change 2 interpolates
inside that window, so confirm both its assertions still pass rather than
assuming they do — they match on `run exactly this` + `${testCmd}` and on
`'tests 0' is a FAILED run`, neither of which `readRules` emits.

## Acceptance criteria

- [ ] The specialist prompt in `workflows/review-pr.js` carries the bounded-read
      rule
- [ ] The refuter prompt carries it too, from the same source
- [ ] Specialists are handed the PR's change — a diff path, or the changed-file
      list when the diff could not be captured
- [ ] A `gh pr diff` failure degrades the prompt; it never aborts the review,
      never emits a dangling path, and never offers a 0-byte diff
- [ ] A diff whose head does not match the snapshot's head is not offered
- [ ] A *missing* `prHead` does not suppress an otherwise good diff
- [ ] The rule is not duplicated prose: one `readRules`, two interpolations, and
      a comment naming `review-and-fix.md:47` as the prose owner
- [ ] `:287` unchanged
- [ ] New tests mutation-tested in both directions, results recorded in the PR
      body
- [ ] Suite green, count stated, not "tests 0"

## Unknowns to settle during implementation

- **Diff size.** Measured: PR #216, seven files, `gh pr diff` → 1223 lines. Big
  enough that a specialist reading it whole is itself an unbounded read, though
  still far below the 434 KB the file-scanning it replaces cost. `diffLines` is
  already in the schema for the gate, so the cheap follow-up — state the count
  in the prompt so a specialist can decide to bound it — costs one
  interpolation. Ship without it; add it only if a run shows specialists reading
  `pr.diff` whole. Do not pre-build a diff splitter.
- **Whether `gh pr diff` works from the worktree in every fleet case.** It
  resolves owner/repo from the checkout's remote; a worktree with no remote has
  nothing to resolve. Behaviour lands in the `usableDiff → null` branch, which
  is handled — but confirm the failure is a clean non-zero exit and not a hang,
  since the snapshot agent has no timeout of its own.
- **Whether the head check ever fires in practice.** In the fleet the reviewer
  runs after the implementer pushed, so the heads should agree. The guard exists
  because the divergence is cheap to check and expensive to miss, not because it
  is expected. If it fires, that is a finding about the fleet's ordering, not
  about this code — report it rather than widening the guard.

## Invariants

- `:363`'s ban on the worktree stays blanket. No specialist runs git.
- The snapshot stays the only tree specialists read.
- All three new schema fields are optional, in the schema and in every consumer.
- A diff is offered only when it is non-empty **and** provably describes the
  snapshot's own head. Never offered on a guess.
- Absent input never narrows coverage — only a present, contradicting value
  does. Same convention as `review-pr.js:255-257`.
- `stats` may be `null` at every use; `readRules` must not dereference through
  it. `:330-337` guarantees only that it is `null` or a parsed object.

## Out of scope

- **`skills/fleet/scripts/show-bounded.sh`**, proposed in #194's second comment.
  Declined: it wraps `git show`, and this design leaves no `git show` in
  specialist hands — the snapshot is the materialized object store, so the
  command it guards is never issued on this path. Adding it would ship a script
  with no caller on the fleet's default review path. Record the reasoning as a
  comment on #194 when the PR opens.
- **`review-pr.js:187`** — now `:286-287` after intervening changes. #194 is
  explicit that its `git show HEAD:<path>` byte-identity check must not be given
  a `sed` range (a partial read cannot establish byte-identity) and that the
  optional `| cmp -` rewrite is not required. Left alone.
- **Fleet doc compression** — #66.
- **`run-team/SKILL.md` restating `review-and-fix.md`** — #219, needs an owner
  ruling.
- **Which dispatch path produced #181's 88 unpiped reads.** Still unestablished;
  the transcripts were not in that review's snapshot. The gap closed here is
  real on the workflow path either way, and Problem §1 gives it a mechanism that
  the hand-dispatch path does not share (a hand-dispatched specialist works in a
  real worktree where `git diff` runs).
