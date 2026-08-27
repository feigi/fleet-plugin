# Declared Per-Role Tiers and Within-Run Pairing — Implementation Plan (Part 2 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the **implementer's** model and effort an explicit, pinned
declaration instead of an accident of the session, then dispatch one implementer
per wave at the alternate tier so the comparison is never again confounded with
the calendar.

**Architecture:** Agent-definition frontmatter is the only mechanism that
decouples model from effort — the `Agent` tool takes `model` but has no `effort`
parameter, so an Agent-dispatched member always inherits the session's effort.
Declaring the tier in frontmatter changes nothing on the first commit (the
declaration states what already happens); the change is that the tier becomes
readable and pinnable. Only then does one implementer per wave move.

**Scope: implementers only.** Reviewer, finisher and merge-bot are deliberately
not declared — maintainer's call, 2026-08-27. Their rows are still recorded by
Part 1's scraper, so the review side (the larger cost, and the acknowledged next
target) accumulates history for free while no decision is made about it.

**Tech Stack:** Markdown agent definitions under `~/.claude/agents/`, `node:test`
prose pins, no runtime code.

**Spec:** `docs/specs/2026-08-27-fleet-member-outcomes-instrumentation-design.md`

**Depends on:** Part 1 (`...-plan-1-scraper.md`) must be merged — this plan's
value is only realised if rows are being recorded. It does not depend on Part 1's
code, only on its existence.

## Global Constraints

- **Declare the bare alias (`opus`, `sonnet`, `haiku`), never a pinned versioned
  id.** An alias tracks the newest generation. A pinned id silently rots into the
  superseded generation, which is both weaker and *more expensive* — pricing
  falls with each generation. This is a hard rule, not a style preference.
- **Never `tools:` without `Agent`.** A `tools:` list that omits `Agent` costs the
  member its delegation, silently and with no error
  (`references/member-lifecycle.md:7`). Omit the key entirely.
- **First commit changes no behaviour.** A config change and a measurement change
  landing together is unreadable. Declarations first, movement second.
- Repo root is the worktree `.worktrees/member-outcomes`, branch
  `feature/member-outcomes-instrumentation`. Do not edit the main checkout.
- Run tests with `node --test skills/fleet/scripts/` from the repo root.
- **`#N` in the commit messages below is this plan's own issue, not Part 1's.**
  File it before Task 1:

```bash
gh issue create --repo feigi/claude-config \
  --title "Declare the implementer tier in frontmatter, and pair within each run" \
  --label ready-for-agent \
  --body "Spec: docs/specs/2026-08-27-fleet-member-outcomes-instrumentation-design.md
Part 2 of 2. Depends on the Part 1 scraper being merged.

Declares the implementer's model+effort in an agent definition (the only
mechanism that decouples the two — the Agent tool has no effort parameter), then
moves one implementer per wave to the alternate tier so tier stops being
confounded with calendar date. Closes #864 and #472 along the way.

Implementers ONLY. Reviewer/finisher/merge-bot are not declared here — their
rows are recorded by the Part 1 scraper regardless, so the review side (84% of
run cost, the bigger prize) accumulates history without a decision being made
about it yet."
```

---

### Task 1: Confirm frontmatter `effort:` is actually honoured

**Files:**
- Create: none (measurement only)

**Interfaces:**
- Consumes: nothing
- Produces: a yes/no that gates every task below

This is the spec's first Unknown. `effort:` ships on five agents in the official
`claude-security` plugin, which is strong evidence, but nothing in this repo has
run one, and `meta.json` never records effort — so it cannot be confirmed after
the fact from the board. **If this comes back no, stop and re-plan:** the whole
"cheaper model, higher effort" trade depends on it.

- [ ] **Step 1: Write a throwaway probe agent**

```bash
cat > ~/.claude/agents/effort-probe.agent.md <<'EOF'
---
name: effort-probe
description: Throwaway probe confirming frontmatter effort is honoured. Delete after use.
model: sonnet
effort: xhigh
---

Reply with exactly the word: probe
EOF
```

- [ ] **Step 2: Dispatch it and read back what actually ran**

Dispatch one agent with `subagent_type: "effort-probe"` from a session whose own
effort is NOT `xhigh` — otherwise inheritance and the frontmatter produce the
same answer and the probe proves nothing. Check the session's effort first:

```bash
SESS=~/.claude/projects/-Users-chris--claude/<this-session-uuid>.jsonl
grep -o '"effort":"[a-z]*"' "$SESS" | sort -u
```

Then read the probe's own transcript:

```bash
D=~/.claude/projects/-Users-chris--claude/<this-session-uuid>/subagents
grep -o '"model":"[^"]*"' "$D"/agent-*effort-probe*.jsonl | sort -u
grep -o '"effort":"[a-z]*"' "$D"/agent-*effort-probe*.jsonl | sort -u
```

Expected if honoured: `claude-sonnet-5` and `xhigh`, with `xhigh` differing from
the session's own value.

- [ ] **Step 3: Record the result in the spec**

Replace the first bullet of the spec's "Unknowns" section with what was measured
— the date, the session's effort, the probe's effort, and the verdict. An
unknown that was resolved and left written as unknown is worse than one never
investigated, because the next reader re-runs the probe.

- [ ] **Step 4: Delete the probe**

```bash
rm ~/.claude/agents/effort-probe.agent.md
```

- [ ] **Step 5: Commit**

```bash
git add docs/specs/2026-08-27-fleet-member-outcomes-instrumentation-design.md
git commit -m "docs(spec): resolve the frontmatter-effort unknown by measurement (#N)"
```

---

### Task 2: Declare the implementer's current tier — a behavioural no-op

**Files:**
- Create: `agents/fleet-implementer.agent.md`
- Modify: `skills/fleet/skills/run-team/SKILL.md` (phase 2 dispatch instruction)

**Interfaces:**
- Consumes: Task 1's verdict
- Produces: subagent type `fleet-implementer`, dispatched as
  `Agent({ name: "impl-<N>", subagent_type: "fleet-implementer", ... })`

`name` is what confers team membership and carries the `Agent` tool
(`references/member-lifecycle.md:7`); `subagent_type` is orthogonal and selects
the definition. Both are set. `name` keeps the existing `impl-<N>` convention —
Part 1's `parseMemberName()` reads it, and the spend classifier keys on it.

Note where this file lives: `~/.claude/agents/` is `agents/` in this repo (the
repo IS `~/.claude`). It is not under `skills/fleet/`.

- [ ] **Step 1: Write the agent definition**

```bash
cat > agents/fleet-implementer.agent.md <<'EOF'
---
name: fleet-implementer
description: A /fleet:run-team implementer — takes one ticket, works in its own claimed worktree, opens one PR. Dispatched by the controller in phase 2, never invoked directly.
model: opus
effort: xhigh
---

Follow the dispatch brief you were given. It is the whole of your task.
EOF
```

`model: opus` is the bare alias deliberately — it tracks the newest Opus
generation. A pinned `claude-opus-5` would rot into a superseded generation that
is both weaker and dearer the day a successor ships.

There is no `tools:` key: a `tools:` list would drop the `Agent` tool and cost the
member its delegation, silently.

- [ ] **Step 2: Verify it is a no-op before wiring it in**

The current effective tier is the session's. Confirm the declaration matches what
implementers actually ran, from Part 1's data rather than from memory:

```bash
awk -F'\t' '!/^#/ && $3=="implementer" {print $5, $6}' docs/metrics/member-outcomes.tsv \
  | sort | uniq -c | sort -rn | head
```

If the dominant pair is not the current Opus at `xhigh`, this declaration is NOT
a no-op — stop, and reconcile the spec's claim with the data before continuing.

- [ ] **Step 3: Wire phase 2 to dispatch the type**

In `SKILL.md`, find the phase-2 dispatch instruction near line 395
(`grep -n "Dispatch every implementer" skills/fleet/skills/run-team/SKILL.md`).
Replace the "omit `model`" rule with:

```markdown
**Dispatch every implementer as `subagent_type: "fleet-implementer"`, and still
omit `model` on the Agent call.** The tier now lives in that definition's
frontmatter (`agents/fleet-implementer.agent.md`), which is what an omitted
`model` takes first — the session's tier applies only when the definition names
none. Omitting `model` is therefore still the mechanism; what changed is that the
tier it resolves to is now declared and pinned rather than inherited by accident.
Keep `name: impl-<N>`: the name is what makes a member, and both the spend
classifier and `member-outcomes.mjs` read it.

**The declaration names a bare alias (`opus`), never a versioned id.** An alias
tracks the newest generation; a pinned id rots into a superseded one that is
weaker AND more expensive, because pricing falls with each generation.
```

- [ ] **Step 4: Run the existing tier pins**

Run: `node --test skills/fleet/scripts/implementer-model-tier.test.mjs`
Expected: FAIL — its negative pins anchor on the old wording.

This failure is the point: it proves those pins are load-bearing. Task 3 rewrites
them. Do not weaken a pin to make it pass.

- [ ] **Step 5: Commit** (with the suite red — Task 3 closes it)

```bash
git add agents/fleet-implementer.agent.md skills/fleet/skills/run-team/SKILL.md
git commit -m "feat(fleet): declare the implementer tier in frontmatter, no behaviour change (#N)"
```

---

### Task 3: Extend the tier pins to the agent definition

**Files:**
- Modify: `skills/fleet/scripts/implementer-model-tier.test.mjs`

**Interfaces:**
- Consumes: `agents/fleet-implementer.agent.md`
- Produces: nothing

This is the hazard the spec names. The existing pins read `SKILL.md` **only**, so
a tier changed in frontmatter leaves them green while the dispatched tier flips —
the exact silent-drift class the pins exist to prevent, routed around.

- [ ] **Step 1: Write the failing test**

```javascript
import { readFileSync } from "node:fs";
import { join } from "node:path";

const IMPLEMENTER = readFileSync(join(REPO, "agents", "fleet-implementer.agent.md"), "utf8");
const frontmatter = IMPLEMENTER.split("---")[1] ?? "";

test("the implementer definition declares BOTH a model and an effort", () => {
  // Declaring only one leaves the other inherited, which is the ambiguity this
  // whole change exists to remove.
  assert.match(frontmatter, /^model:\s*\S+$/m);
  assert.match(frontmatter, /^effort:\s*\S+$/m);
});

test("the declared model is a bare alias, never a pinned version", () => {
  // A pinned id rots into a superseded generation that is weaker AND dearer —
  // pricing falls with each generation. The alias tracks the newest.
  const model = /^model:\s*(\S+)$/m.exec(frontmatter)[1];
  assert.ok(["opus", "sonnet", "haiku"].includes(model), `pinned version: ${model}`);
});

test("the definition does not list tools — a list would drop the Agent tool", () => {
  // member-lifecycle.md:7 — omit it and the member loses delegation, silently
  // and with no error.
  assert.doesNotMatch(frontmatter, /^tools:/m);
});

test("SKILL.md points at the definition, so the tier is findable from the dispatch rule", () => {
  const slice = section("Dispatch every implementer", "**`class=routine`");
  assert.match(slice, /fleet-implementer/);
  assert.match(slice, /frontmatter/);
});
```

- [ ] **Step 2: Rewrite the two stale negative pins**

The existing pins assert `sonnet` is absent from the phase-0 and phase-2 slices.
That claim is now wrong in a different way: the tier is not stated in prose at
all, it is declared in frontmatter. Replace each with a pin that the slice
**points at the definition** rather than one that names a tier.

Keep the two-slice structure. Phase 0 and phase 2 each stated the binding
independently, and changing only one is exactly the half-revert the original test
was written to catch.

- [ ] **Step 3: Run and mutation-test both directions**

Run: `node --test skills/fleet/scripts/implementer-model-tier.test.mjs`
Expected: PASS

Then, one at a time, confirm each pin can actually fail:
- change `model: opus` to `model: claude-opus-5` → the alias test goes RED
- add a `tools: Read, Bash` line → the tools test goes RED
- delete `fleet-implementer` from the SKILL.md slice → the pointer test goes RED

Revert each. A pin that stays green when its subject is broken is pinning
nothing — an earlier draft of this very file passed with the rule INVERTED end to
end, because every token it looked for was still somewhere in the slice.

- [ ] **Step 4: Run the whole suite**

Run: `node --test skills/fleet/scripts/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add skills/fleet/scripts/implementer-model-tier.test.mjs
git commit -m "test(fleet): pin the implementer tier at its declaration, not only in prose (#N)"
```

---

### Task 4: The within-run pairing rule

**Files:**
- Create: `agents/fleet-implementer-alt.agent.md`
- Modify: `skills/fleet/skills/run-team/SKILL.md` (phase 2)
- Test: `skills/fleet/scripts/within-run-pair-prose.test.mjs`

**Interfaces:**
- Consumes: `fleet-implementer`
- Produces: subagent type `fleet-implementer-alt`

This is the only task that changes behaviour, and the only one that costs
something on every run. It is also the whole point: #864's finding is that tier
is entangled with calendar date and therefore with prompt evolution — 8 of 9
sonnet rows in one week, 23 of 24 opus rows in the next. Within-run pairing makes
tier orthogonal to date by construction.

- [ ] **Step 1: Write the alternate definition**

```bash
cat > agents/fleet-implementer-alt.agent.md <<'EOF'
---
name: fleet-implementer-alt
description: A /fleet:run-team implementer dispatched at the ALTERNATE tier, one per wave, so every run carries its own unconfounded comparison. Identical to fleet-implementer except for the tier.
model: sonnet
effort: xhigh
---

Follow the dispatch brief you were given. It is the whole of your task.
EOF
```

`effort` deliberately matches `fleet-implementer`. Varying model and effort at
once yields a pair that answers neither question. The effort comparison is a
later, separate experiment — the spec says so.

- [ ] **Step 2: Write the failing prose pin**

This is a NEW file, so it needs its own `REPO`, `RUN_TEAM` and `section()`
helpers — copy them from `implementer-model-tier.test.mjs`. The repo already
duplicates `section()` between two test files rather than sharing it (seven
lines, two copies, nothing detects drift between them); follow that convention
rather than extracting a third module.

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..", "..", "..");
const RUN_TEAM = readFileSync(join(REPO, "skills", "fleet", "skills", "run-team", "SKILL.md"), "utf8");

// Slice by named anchors and fail loudly when one moves; slice SIZE is what does
// the work. One slice per paragraph, never per phase.
function section(start, end) {
  const a = RUN_TEAM.indexOf(start);
  assert.notEqual(a, -1, `anchor moved: ${start}`);
  const b = RUN_TEAM.indexOf(end, a + start.length);
  assert.notEqual(b, -1, `anchor moved: ${end}`);
  return RUN_TEAM.slice(a, b);
}

test("phase 2 dispatches exactly one alternate-tier implementer per wave", () => {
  const slice = section("Dispatch every implementer", "**`class=routine`");
  assert.match(slice, /fleet-implementer-alt/);
  assert.match(slice, /\bone\b[^.]{0,80}\bwave\b/i);
});

test("phase 2 does NOT ask the controller to label the control", () => {
  // A hand-set control column would be un-regenerable, and one derived against
  // today's declared tiers would mislabel every historical row. The pairing is
  // a query over member-outcomes.tsv, not a label.
  const slice = section("Dispatch every implementer", "**`class=routine`");
  assert.doesNotMatch(slice, /control=yes|mark .{0,20}control/i);
});

test("the alternate definition differs from the default in MODEL ONLY", () => {
  // Varying two things at once yields a pair that answers neither question.
  const fm = (n) => readFileSync(join(REPO, "agents", `${n}.agent.md`), "utf8").split("---")[1];
  const eff = (s) => /^effort:\s*(\S+)$/m.exec(s)[1];
  assert.equal(eff(fm("fleet-implementer-alt")), eff(fm("fleet-implementer")));
  assert.notEqual(
    /^model:\s*(\S+)$/m.exec(fm("fleet-implementer-alt"))[1],
    /^model:\s*(\S+)$/m.exec(fm("fleet-implementer"))[1],
  );
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test skills/fleet/scripts/within-run-pair-prose.test.mjs`
Expected: FAIL — no `fleet-implementer-alt` in the slice

- [ ] **Step 4: Add the rule to phase 2**

```markdown
**One implementer per wave goes at the alternate tier.** Dispatch it exactly as
the others but with `subagent_type: "fleet-implementer-alt"`. Pick the ticket
that is most ordinary — never the hardest, never the one whose ticket the run
depends on — and do not tell the member it is a control; a member that knows it
is being measured is not measuring the same thing.

**Do not label it anywhere.** The pairing is a query over
`docs/metrics/member-outcomes.tsv`: a `session`+`role` carrying more than one
distinct `model`. A hand-set column would not survive the file's regeneration,
and one derived against today's declared tiers would mislabel every historical
row.

**Why one per wave and not a week of one tier followed by a week of the other:**
tier would then be confounded with calendar date and therefore with prompt
evolution, which is exactly the state #864 documents and the reason the existing
rows cannot answer the question they were collected for.
```

- [ ] **Step 5: Run and mutation-test**

Run: `node --test skills/fleet/scripts/within-run-pair-prose.test.mjs`
Expected: PASS

Then set `effort: high` in `fleet-implementer-alt.agent.md` and confirm the
model-only test goes RED. Revert.

- [ ] **Step 6: Run the whole suite**

Run: `node --test skills/fleet/scripts/`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add agents/fleet-implementer-alt.agent.md skills/fleet/skills/run-team/SKILL.md skills/fleet/scripts/within-run-pair-prose.test.mjs
git commit -m "feat(run-team): one alternate-tier implementer per wave, unlabelled (#N)"
```

---

### Task 5: The four difficulty columns on `tier-outcomes.tsv`

**Files:**
- Modify: `docs/metrics/tier-outcomes.tsv` (header only — no row is rewritten)
- Modify: `skills/fleet/skills/run-team/SKILL.md` (the ruling step)

**Interfaces:**
- Consumes: nothing
- Produces: four new trailing columns — `sizing`, `profile`, `loc`, `files`

These are per-PR facts, so they belong on the per-PR verdict row, not on a
per-member one. Appending columns to an append-only file leaves every existing
row short: **rows predating this change carry blanks, permanently, and blank
means unknown.** Never backfill them by guessing.

- [ ] **Step 1: Append the columns to the header, and say what blank means**

Add to the header block, and extend the `# run_date	pr	...` column line with the
four names:

```
# sizing   phase 0's light/heavy verdict for this ticket, recorded at claim time
# profile  diff-stats.mjs profile for the merged diff (docs-only/single-file/small/
#          tests-only/production)
# loc      lines changed; files = files touched, both from diff-stats.mjs
#
# THE FOUR COLUMNS ABOVE WERE ADDED 2026-08-27 AND ARE BLANK ON EVERY EARLIER
# ROW. Blank means UNKNOWN, never a value. An earlier PR can be counted in a
# whole-file tally and CANNOT enter a stratified comparison. Never fill one in
# retroactively: a guessed covariate is worse than an absent one, because it
# looks measured.
```

- [ ] **Step 2: Extend the ruling instruction**

In `SKILL.md`, at the `Append one row` step, name the four new fields and where
each comes from. State explicitly that a value not in hand is left **blank**, not
estimated.

- [ ] **Step 3: Pin the header against its own column line**

Add to the header test from Part 1's Task 8 (or a sibling file) a check that the
`# run_date ...` column line has exactly the documented names in order, and that
the blank-means-unknown sentence is present. #472 is open because this file's
header has never been pinned — closing that is in scope here.

- [ ] **Step 4: Run the suite**

Run: `node --test skills/fleet/scripts/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add docs/metrics/tier-outcomes.tsv skills/fleet/skills/run-team/SKILL.md skills/fleet/scripts/
git commit -m "feat(tier-outcomes): record sizing and diff profile per ruled PR; pin the header (#N, closes #472)"
```

---

### Task 6: Reconcile the stale tier-guard prose

**Files:**
- Modify: `skills/fleet/skills/run-team/SKILL.md` (the tier-guard section)

**Interfaces:**
- Consumes: nothing
- Produces: nothing

#864 is open against this section: every figure in it is stale and one stated
conclusion no longer follows. This plan changes the dispatch rule those
paragraphs describe, so leaving them is not an option — they would now be wrong
about the mechanism as well as the numbers.

- [ ] **Step 1: Recount from the file, do not trust the prose**

```bash
grep -vc '^#' docs/metrics/tier-outcomes.tsv
awk -F'\t' '!/^#/ && $4=="routine" {n++; d[$1]=1; if($6=="no") no++} \
  END{print n, length(d), no+0}' docs/metrics/tier-outcomes.tsv
awk -F'\t' '!/^#/ && $4=="routine" {t[$5]++; if($6=="no") f[$5]++} \
  END{for(k in t) print k, t[k], f[k]+0}' docs/metrics/tier-outcomes.tsv
```

Measured at `c82c5a5` on 2026-08-27: 93 rows; routine/sonnet 11 rows with 3
failures, routine/opus 48 with 3. **Recount — these are a snapshot and every run
appends.**

- [ ] **Step 2: Rewrite the section**

Three things must be true of the result:
- The figures carry an explicit as-of anchor (date **and** row count), because
  prose citing an append-only file rots on every append and a hard pin would go
  red on every legitimate append.
- The guard is described in its **fired** state with no further move, and the
  live question named as the opposite one — restoring a cheaper tier — which the
  guard does not decide.
- The date confound is described as **weakened, not resolved**, and the new
  within-run pairing named as what replaces it going forward.

Do not delete the counter-evidence. It was recorded rather than suppressed on
purpose, and this section's whole value is that it argues against its own
conclusion.

- [ ] **Step 3: Run the suite**

Run: `node --test skills/fleet/scripts/`
Expected: PASS. If a tier pin fails, its anchor moved — fix the anchor, never the
assertion.

- [ ] **Step 4: Commit**

```bash
git add skills/fleet/skills/run-team/SKILL.md
git commit -m "docs(run-team): recount the tier-guard figures and describe within-run pairing (#N, closes #864)"
```

---

## Done when

- The **implementer** model and effort are declared in frontmatter, as a bare
  alias, pinned by a test that fails when the declaration changes.
- One implementer per wave runs at the alternate tier, unlabelled.
- `tier-outcomes.tsv` records the two difficulty covariates going forward, with
  blanks on earlier rows and a header that says blank means unknown.
- #864 and #472 are closed.

## Explicitly NOT done here

- **No declarations for reviewer, finisher or merge-bot.** Maintainer's call,
  2026-08-27: implementers only for now. Three agent definitions that no
  experiment uses are three more files to keep true for no return, and every
  role declared at once means an observed effect has four candidate causes.
  Their rows are still recorded by Part 1's scraper at zero cost, so the history
  accumulates whether or not anything is declared.
- **No review-side tiering, despite it being the bigger prize.** Review work has
  measured at 84% of a run's cache-write tokens and specialists are 1416 of the
  2,671 members on disk, so this is the acknowledged next target — not an
  oversight. Specialist tiers live in `workflows/review-pr.js`, not in agent
  definitions, so reaching them is a different change with a different blast
  radius. Separate ticket, after the implementer question resolves.
- **No new guard, and no automatic revert.** The spec's read-out rules gate on
  ≥10 within-run pairs across ≥5 run dates. Below that, report the count and
  stop. Writing policy against data that does not exist yet is how the last guard
  ended up firing with n=1 on the control side.
- **No pairing-rate taper.** One per wave is a starting rate and the intent is to
  pair less often later, but the rate to taper to is exactly what the first ≥10
  pairs are for. Choosing it now would repeat the last guard's mistake.
- **No effort experiment.** Both implementer definitions share one effort on
  purpose. Varying effort is a separate change, after the model question
  resolves.
