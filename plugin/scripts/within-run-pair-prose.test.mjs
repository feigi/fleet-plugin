import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between as section } from "./prose-pin.mjs";

// #864's finding is that tier is entangled with calendar date and therefore
// with prompt evolution — 8 of 9 sonnet rows in one week, 23 of 24 opus rows in
// the next. Dispatching every 5th Pull at an exploration cell (ADR 0013 §6 and
// its 2026-09-28 Amendment, which replaced the alternate tier with the cell
// draw) makes the cell orthogonal to date BY CONSTRUCTION, which is the only
// thing that lets the accumulated rows ever answer the question they are
// collected for.
//
// This is the one part of the change that costs something on every run, so it
// is also the part a compression pass is likeliest to quietly drop. These pins
// are what notices.
const REPO = join(import.meta.dirname, "..");
const RUN_TEAM = readFileSync(join(REPO, "skills", "run-team", "SKILL.md"), "utf8");

// Paragraph-tight, and deliberately NARROWER than the dispatch slice in
// implementer-model-tier.test.mjs: widened to the phase, the tier-guard
// paragraphs below would satisfy half of these pins on their own.
const dispatch = () =>
  section(RUN_TEAM, "**Dispatch every implementer", "The raw split still favours the top tier", "run-team phase 2 dispatch rule");

test("phase 2 dispatches an exploration cell's implementer on every 5th Pull", () => {
  const slice = dispatch();
  assert.match(slice, /fleet-implementer-<cell>/, "phase 2 no longer dispatches an exploration cell at all");
  // The RATE, not just the existence. "Dispatch some at an exploration cell"
  // reproduces the block design the pairing exists to replace.
  //
  // Bound to `exploration cell` inside one sentence: an unbound rate pin once
  // stayed GREEN through exactly that mutation, because the "**Why one … and
  // not a week…**" rationale below satisfied it on its own. The rate has to be
  // pinned where the rate is ORDERED, not wherever the words co-occur. Order is
  // not assumed — the mirrored phrasing binds the same rate.
  assert.match(
    slice,
    /every 5th Pull[^.]{0,60}exploration cell|exploration cell[^.]{0,60}every 5th Pull/i,
    "phase 2 no longer orders the rate — every 5th Pull is what makes the pair within-run",
  );
});

// The RATE pin above catches "every 5th Pull" going missing or reworded to a
// different fraction, but not the MECHANISM that fraction is measured
// against. Confirmed live: a contradicting cadence ("row 2, 4, 6 …") stays
// green through every existing run-team prose test, because nothing reads
// the concrete row-count claim — only the "every 5th Pull" phrase two
// sentences above it.
test("phase 2 counts the exploration cell by ledger row 5, 10, 15 …, not by any other cadence", () => {
  const slice = dispatch();
  assert.match(
    slice,
    /the Pull that creates row 5, 10, 15 …/,
    "phase 2 no longer names row 5, 10, 15 … as the concrete exploration-cell cadence",
  );
});

test("phase 2 does not tell the exploration member it is a control", () => {
  // A member that knows it is being measured is not measuring the same thing.
  assert.match(
    dispatch(),
    /do not tell the member it is a control/i,
    "phase 2 no longer withholds the control status from the member",
  );
});

test("phase 2 does NOT ask the controller to label the control", () => {
  // A hand-set control column would not survive the metrics file's
  // regeneration, and one derived against today's declared tiers would
  // mislabel every historical row. The pairing is a QUERY over
  // member-outcomes.tsv: a session+role carrying more than one distinct model.
  const slice = dispatch();
  assert.doesNotMatch(
    slice,
    /control=yes|mark .{0,20}control/i,
    "phase 2 asks for a hand-set control label — it cannot survive a regeneration",
  );
  assert.match(
    slice,
    /member-outcomes\.tsv/,
    "phase 2 no longer says where the pairing is recovered from, so the label comes back",
  );
});

test("phase 2 says why the pairing is within-run and not week-by-week", () => {
  // Without the reason, the every-5th-Pull rate reads as arbitrary overhead and the next
  // cost-trimming pass converts it back into a block design — which is the
  // state #864 documents.
  assert.match(
    dispatch(),
    /confounded with calendar date|confounded with the calendar/i,
    "phase 2 no longer says what within-run pairing buys — the rate reads as arbitrary cost",
  );
});

// The cells' definitions — named for their routes, bodies byte-identical — are
// pinned in implementer-model-tier.test.mjs, over every
// `fleet-implementer-<cell>` file on disk. The old two-definition pins here
// (#1801's body identity, and the alternate differing from the default in
// ROLE ONLY) went with the pair: the grid varies role, level, or both by
// design (spec 2026-09-28 § 2).

test("phase 2 counts the rate off the ledger's impl- rows, and a replacement does not count again", () => {
  // The pin above binds the WORDS, not a countable rule — the same gap the old
  // one-per-staged-set rate had, measured then: appending either explicit
  // resolution of its wording left every assertion GREEN while the two readings
  // differed by an order of magnitude in how much of the fleet ran off the
  // default.
  //
  // Under Pull the count is the ledger's (ADR 0013 §6), and what disambiguates
  // it is what a row IS: one `impl-` row per pulled ticket, so a replacement
  // member inherits its row's tier instead of drawing a Pull number of its
  // own. Without that clause a killed-and-replaced member shifts every later
  // exploration assignment by one, silently.
  const slice = dispatch();
  assert.match(
    slice,
    /Count\s+the\s+`impl-`\s+rows\s+in\s+`\.fleet\/ledger\.md`\s+at\s+Pull\s+time/,
    "phase 2 no longer says what the every-5th count is counted over — the rate is ambiguous again",
  );
  assert.match(
    slice,
    /records\s+`tier=<cell>`\s+in\s+the\s+row,\s+and\s+a\s+replacement\s+inherits\s+the\s+row's\s+tier/,
    "phase 2 no longer records the cell on the row, or no longer says a replacement inherits it rather than counting as a Pull",
  );
  // The cell is the router's draw, never one this prose names: a cell
  // written here is a second copy of the routing, free to disagree with the
  // table the router reads.
  assert.match(slice, /the\s+router\s+draws\s+its\s+cell/, "phase 2 no longer says the router draws the exploration cell");
  assert.doesNotMatch(slice, /Until\s+the\s+router\s+draws/, "phase 2 names a stand-in exploration cell again");
  assert.match(
    slice,
    /While\s+the\s+table's\s+`burn_in`\s+is\s+true\s+every\s+Pull\s+draws,\s+over\s+every\s+cell,\s+the\s+policy\s+cell\s+included/,
    "phase 2 no longer says burn-in draws on every Pull, over every cell",
  );
  // The roll: a Pull that lands on a chain head passes the exploration cell to
  // the next Pull rather than skipping it, which is the rule ADR 0013 §6 states
  // and the difficulty caveat below depends on.
  assert.match(
    slice,
    /assignment\s+rolls\s+to\s+the\s+next\s+Pull\s+when\s+another\s+open\s+ticket\s+sequences\s+after\s+it/,
    "phase 2 no longer rolls the exploration cell past chain heads",
  );
});

// The Pull's own write: the router's line decides the row, and `tier=` is
// the draw's record — on a row exactly when the router drew. Written for a
// row the router did not draw for, `ledger.mjs dispatch` would print a cell
// nothing chose.
const pullStep7 = () => section(RUN_TEAM, "7. **Route, row, then dispatch**", "**The Pull table**", "run-team Pull step 7");

test("Pull step 7 routes through ticket-router.mjs and writes tier= exactly when it drew", () => {
  const slice = pullStep7();
  assert.match(slice, /ticket-router\.mjs\s+route\s+--session\s+<session>\s+--ticket\s+<N>\s+--arm\s+<A\|B>\s+--impl-row\s+<k>/, "step 7 no longer calls the router");
  assert.match(slice, /--issue\s+<scratch>\/impl-<N>\/issue\.json/, "step 7 no longer hands the router the Pull's own read");
  assert.match(slice, /`tier=<CELL>`\s+exactly\s+when\s+`DRAW`\s+is\s+not\s+`-`/, "step 7 no longer ties tier= to the draw");
  assert.match(slice, /Router\s+exit\s+2\s+→\s+no\s+row\s+and\s+no\s+dispatch/, "step 7 dispatches on a router usage error");
  // The Pull's one read is what the router reads: a second fetch would be a
  // second network call per Pull.
  const step3 = section(RUN_TEAM, "3. **Read the ticket in full, once**", "Record the ticket's real", "run-team Pull step 3");
  assert.match(step3, /--json\s+title,body,comments,labels,createdAt`\s+written\s+to\s+`<scratch>\/impl-<N>\/issue\.json`/, "step 3 no longer writes the file the router reads");
});

// The difficulty caveat lives in the counter-evidence section, past this file's
// dispatch slice, so it needs its own anchor pair.
const counterEvidence = () =>
  section(RUN_TEAM, "within-run pairing above**", "`minted_false_claim`", "run-team tier-guard counter-evidence");

test("the orthogonality claim is scoped — date only, not difficulty", () => {
  // The claim itself is literally true and narrowly scoped, so this is not a
  // false-claim pin. It is the caveat that goes missing: the alternate member
  // rolls past every chain head, while the top tier absorbs all of those. That
  // makes tier SYSTEMATICALLY correlated with ticket
  // kind, in a known direction — a different hazard from the "difficulty adds
  // noise" the covariates are elsewhere sold as handling, and the one a reader
  // who trusts "by construction" will skip.
  const slice = counterEvidence();
  assert.match(
    slice,
    /rolling\s+past\s+every\s+ticket\s+another\s+open\s+one\s+sequences\s+after[\s\S]{0,120}the\s+top\s+tier\s+absorbs\s+all\s+of\s+those/,
    "the counter-evidence section no longer says which tickets the alternate tier skips and the top tier absorbs",
  );
  assert.match(
    slice,
    /difficulty/i,
    "the orthogonality claim no longer names difficulty as the confound it does NOT remove",
  );
  assert.match(
    slice,
    /`sizing`\/`profile`\/`loc`\/`files`|condition a pair comparison/i,
    "the caveat no longer routes the reader to the covariates before reading a pair",
  );
});
