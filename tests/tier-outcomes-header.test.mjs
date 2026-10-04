import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase, sentences, stripHashGutter, unemphasized } from "./support/prose-pin.mjs";
import { GATE, readout } from "../plugin/scripts/cell-readout.mjs";
import { COLUMNS } from "../plugin/scripts/tier-outcomes.mjs";

// #472: this file's header has never been pinned, while SKILL.md's guard tells
// the controller that "that file's header carries the column meanings" — so the
// guard's whole accumulate-across-runs mechanism rests on a shape nothing
// checks. The deferral said to add the pin alongside the first consumer. The
// four difficulty columns are that consumer's arrival: they are appended AFTER
// a free-text `note`, which is a shift nobody would see.
//
// The column list is tier-outcomes.mjs's own COLUMNS (#2207), the order its
// `append` writes in — so the header's column line is pinned against the
// writer, the way member-outcomes.tsv's is against its scraper.
const REPO = join(import.meta.dirname, "..");
const TSV = readFileSync(join(REPO, "docs", "metrics", "tier-outcomes.tsv"), "utf8");
const RUN_TEAM = readFileSync(join(REPO, "plugin", "skills", "run-team", "SKILL.md"), "utf8");

// The header is the LEADING comment block. Slicing it — rather than grepping
// `#` lines from anywhere — is what stops a stray comment among the data rows
// from satisfying a prose pin, the same reason member-outcomes-header.test.mjs
// slices.
const headerLines = [];
for (const l of TSV.split("\n")) {
  if (!l.startsWith("#") && l.trim()) break;
  headerLines.push(l);
}
const HEADER = headerLines.join("\n");

// The ruling step, and no more of SKILL.md than that — the same reason
// `prose-pin.mjs`'s own slicers give: a positive regex over the whole file is
// satisfiable from outside the paragraph it guards, and this file is 2700 lines
// of prose about exactly these words. One definition, because three hand-rolled
// copies of one slice is how two of them end up bounded differently.
const rulingStep = () => between(RUN_TEAM, "**Guard: accumulate per PR", "**Then record the run's member facts", "phase 3's ruling step");

// The first sentence of the ruling step that names `sizing` — the sentence the
// phase-0 negative below reads. `sentences()`, never a first-period `[^.]`
// window (#1983): the pin is NEGATIVE, so a window cut short is its silent
// direction, and "e.g.", `SKILL.md` or `v1.2` between `sizing` and "phase 0"
// ended the old window before the forbidden words and passed the misattribution
// green. RESIDUAL, both directions: sentences() still cuts short at a `.)`,
// `."`, a mid-sentence `?`, a capitalised "E.g." or an "etc." — the silent
// direction for this pin — and still merges two real sentences across its
// known shapes (#1987's `**late**.[1]`, #1899's sentence-final lowercase
// "vs."), which here can only over-fire. None of those four is in this slice
// today. `.**` itself IS in this slice (3 bold-lead sentence ends), but each
// is a genuine boundary between two unrelated sentences, not one straddling
// the `sizing`/`phase 0` attribution this pin reads.
const sizingSentence = (slice) => sentences(slice).find((s) => /`sizing`/i.test(s)) ?? "";

// Same reason as `rulingStep` above: one definition of the `minted_false_claim`
// slice, so two hand-rolled copies do not drift to different bounds.
const mfcDef = () => stripHashGutter(between(HEADER, "minted_false_claim", "# sizing", "the header"));

test("the header's column line names every column, in order", () => {
  // Drift here is silent and total: the header's own awk one-liners and every
  // recount in SKILL.md index by position, so a column inserted anywhere but
  // the end shifts $N for every reader of an append-only file.
  //
  // Anchored on the tab-separated shape rather than a substring lookup, so a
  // future paragraph that merely mentions run_date cannot be taken for the
  // column line.
  const line = headerLines.find((l) => l.startsWith("# run_date\t"));
  assert.ok(line, "header has no `# run_date<TAB>...` column line");
  assert.deepEqual(line.replace(/^#\s*/, "").split("\t"), COLUMNS);
});

const LEGACY_COLUMNS = COLUMNS.length - 4;

test("every data row has exactly the legacy or the full field count, never between", () => {
  // Rows predating the four covariates are SHORT on purpose — blank means
  // unknown, and padding them would mint measurements. So the pin cannot simply
  // require the full width.
  //
  // It cannot be an UPPER BOUND either, and that is measured: `n <= 12` stayed
  // green when a tab was typed into a legacy row's free-text `note`, because
  // the row went from 8 fields to 9 and 9 is still under the header. A tab in
  // `note` shifts all four appended columns for that row and for no other,
  // which is the one corruption this layout makes invisible — `note` is the
  // only free-text field and it now sits in front of them.
  //
  // Exactly-8-or-exactly-12 is what discriminates: any tab typed into a note
  // lands on 9 or 13 and reds here. A partially-known row is written to the
  // full width with the unknown fields EMPTY, not truncated.
  const rows = TSV.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  assert.ok(rows.length > 0, "no data rows — the header slice above ate the file");
  const wrong = rows
    .map((r, i) => [i, r.split("\t").length])
    .filter(([, n]) => n !== LEGACY_COLUMNS && n !== COLUMNS.length);
  assert.deepEqual(
    wrong,
    [],
    `rows (0-indexed among data rows) whose field count is neither ${LEGACY_COLUMNS} nor ${COLUMNS.length} — a tab inside \`note\`?`,
  );
});

test("the header says blank means unknown and forbids backfilling a guess", () => {
  // Neither rule is enforceable in code, which is exactly what makes them worth
  // pinning. Dropping the second is how a covariate gets filled in from memory
  // and then read as measured.
  assert.match(HEADER, /BLANK MEANS UNKNOWN/, "the header no longer says blank means unknown");
  assert.match(
    HEADER,
    /Never fill one in\s*\n?#?\s*retroactively/,
    "the header no longer forbids backfilling the four covariates",
  );
  assert.match(
    HEADER,
    /`note` IS FREE TEXT AND NOW SITS BEFORE FOUR COLUMNS/,
    "the header no longer warns that a tab in `note` shifts the appended columns",
  );
});

test("the header names WHICH diff `minted_false_claim` scores, and settles the caught-before-merge case", () => {
  // #1029: the definition read "the diff" and a PR has two — as submitted and
  // as merged. Two rows in one arm scored it opposite ways before the ruling
  // named the submitted one. Nothing derives this column, so neither half is
  // enforceable in code, and a scorer left to infer the convention re-derives
  // the same ambiguity: the caught-before-merge case is the half that decides
  // most rows, and stating only "as submitted" leaves it inferable.
  //
  // Sliced to the definition itself, so a stray "as submitted" elsewhere in the
  // header cannot buy the pass with this one gutted. `stripHashGutter` because
  // `\s+` does not span the `#` a wrapped comment line begins with.
  const def = mfcDef();
  assert.match(
    def,
    phrase("the work AS SUBMITTED asserted a factual claim"),
    "the header no longer says `minted_false_claim` scores the work AS SUBMITTED",
  );
  assert.match(
    def,
    phrase("a claim review caught and the fix pass corrected before merge still counts yes"),
    "the header no longer settles the caught-before-merge case, the half a scorer would otherwise infer",
  );
});

test("the header rules `minted_false_claim` by REFERENT, not by surface, and names the tiebreak", () => {
  // #1457: #1029 settled submitted-vs-merged and left the surface axis
  // implicit. Rulings inferred it two incompatible ways — some rows scored a
  // PR-body-only claim `yes`, one scored a PR-body-only claim `no` citing "the
  // column's diff-scoped definition", a phrase the header never stated. The
  // ruling is referent-scoped: a claim scores on ANY surface the implementer
  // wrote it on when it is about the change being submitted, and is out of
  // scope when it is about code the change does not touch, regardless of
  // surface. A pin that only asserted inclusion of PR/commit bodies would stay
  // green under the narrower "diff-scoped" reading too (every diff-carried
  // claim's surface is trivially the diff); the exclusion clause is what makes
  // this pin red on either kind of drop or inversion.
  const def = mfcDef();
  assert.match(
    def,
    phrase("a diff comment, a doc, a test name, a PR body, a commit body"),
    "the header no longer lists a PR body and a commit body among the surfaces a claim can be written on",
  );
  assert.match(
    def,
    phrase("A PR body and a commit body are IN SCOPE on the same terms as a diff comment"),
    "the header no longer states that a PR/commit body claim scores on the same terms as a diff comment",
  );
  assert.match(
    def,
    phrase("A claim about code the change does not touch is OUT of scope even when the implementer wrote it"),
    "the header no longer excludes a claim about code the change does not touch, regardless of who wrote it or where",
  );
  assert.match(
    def,
    phrase(
      "Tiebreak: would reading the change itself — its diff, its evidence, " +
        "its behaviour — falsify this claim? If yes, it scores.",
    ),
    "the header no longer states the referent tiebreak: would reading the change falsify this claim",
  );
});

test("SKILL.md's guard still delegates the column meanings to this header", () => {
  // #472's finding in one line: the guard PROMISES this header carries the
  // meanings. If that sentence is ever replaced by an inline column list, the
  // two go out of sync silently and this whole file stops being the contract.
  assert.match(
    RUN_TEAM,
    /header carries the column meanings/,
    "SKILL.md no longer delegates the column meanings to the TSV header",
  );
});

test("SKILL.md's ruling step names all four covariates and says a missing one stays blank", () => {
  // The columns are useless unless the ruling step tells the controller to fill
  // them, and worse than useless if it does not say what to do without a value:
  // a guessed covariate looks measured.
  const slice = rulingStep();

  for (const col of ["sizing", "profile", "loc", "files"]) {
    assert.match(slice, new RegExp("`" + col + "`"), `the ruling step never names \`${col}\``);
  }
  assert.match(
    slice,
    /left BLANK, never estimated/,
    "the ruling step no longer says a value not in hand is left blank",
  );
  assert.match(
    slice,
    /diff-stats\.mjs/,
    "the ruling step names the covariates without saying where three of them come from",
  );
});

test("the documented `profile` value set is exactly what diff-stats.mjs emits", () => {
  // Restating an enum in prose is how it drifts: the first draft of this header
  // said `docs-only`, which the script never emits — `docsOnly` is a separate
  // boolean on the same stats object — and omitted `empty`, which the CLI does
  // reach on a genuine zero-file PR. Two spellings for one stratum split the
  // group the column exists to compare, and nothing here noticed, because the
  // pins above cover the column NAMES and not their values.
  //
  // So derive rather than restate. Both halves are guarded: an unguarded
  // `.match()[0]` at module scope takes the whole file down on a reformat that
  // changed no behaviour, which is why this lives inside the test and asserts
  // before it indexes.
  const src = readFileSync(join(REPO, "plugin", "scripts", "diff-stats.mjs"), "utf8");
  const emitted = [...src.matchAll(/^\s*(?:else\s+)?(?:if\s*\([^)]*\)\s*)?profile = "([a-z-]+)";/gm)].map((m) => m[1]);
  assert.ok(emitted.length >= 5, `diff-stats.mjs profile ladder not found — got ${emitted.length}`);

  // The header is wrapped across comment lines, so normalise before reading the
  // parenthetical: strip the `# ` gutter, join, drop whitespace inside the list.
  const flat = HEADER.replace(/^#\s?/gm, "").replace(/\n/g, " ");
  const hit = /it prints \(([^)]+)\)/.exec(flat);
  assert.ok(hit, "the header no longer lists the `profile` value set in parentheses");
  const documented = hit[1].replace(/\s+/g, "").split("/").filter(Boolean);

  assert.deepEqual(
    [...documented].sort(),
    [...new Set(emitted)].sort(),
    "the header's `profile` value set and diff-stats.mjs's ladder disagree",
  );
});

test("the header forbids the `docs-only` spelling the script never emits", () => {
  // The narrow trap, kept separate from the set comparison above: a future edit
  // could satisfy the set while dropping the warning, and "docs-only" is the
  // spelling every other paragraph in the repo uses as an English adjective —
  // which is exactly why it reached this header as a value in the first place.
  assert.match(HEADER, /never\s*\n?#?\s*"docs-only"/, "the header no longer warns off the `docs-only` spelling");
});

test("the sizing verdict has a stated collection channel, and it is not phase 0", () => {
  // The column shipped described as "phase 0's light/heavy verdict ... recorded
  // at claim time", which is wrong twice — phase 0 shortlists (`## Phase 0 —
  // shortlist`), phase 1 claims, and the sizing run happens inside the member in
  // phase 2 — and named no channel at all. With the adjacent rule "a value not in
  // hand is left BLANK, never estimated", that made the covariate correct-to-omit
  // on every row forever: documented as the thing a tier comparison must condition
  // on, and uncollectable.
  const slice = rulingStep();
  // Negative pinned on the ATTRIBUTION, not on one phrasing of it: the first
  // draft of this test forbade the literal `sizing` is phase 0's and stayed
  // green under a reworded restatement of the same error.
  const sentence = sizingSentence(slice);
  assert.ok(sentence, "the ruling step no longer describes `sizing` at all");
  assert.doesNotMatch(
    sentence,
    /phase 0/i,
    `the ruling step attributes sizing to phase 0 again — phase 0 shortlists, it does not size: ${sentence}`,
  );
  // Bound to the word `sizing` itself, not just "somewhere in the sentence":
  // found in review, widening `sizingSentence` from a 120-char window to the
  // whole ~326-char sentence also widened THIS pre-existing positive check,
  // which used to be tight against that same window. A misattribution that
  // keeps "member" alive later in the sentence (e.g. in the trailing
  // `diff-stats.mjs` clause) would otherwise still pass.
  assert.match(
    sentence,
    /`sizing`[\s\S]{0,40}member/i,
    "the ruling step no longer says the sizing verdict is the member's, within reach of `sizing` itself",
  );
  assert.match(
    slice,
    /PR body|Sizing:/,
    "the ruling step no longer says where the controller reads the sizing verdict from",
  );
});

test("a period in the gap does not hide a phase-0 attribution, and the next sentence's phase 0 is not this one's", () => {
  // #1983's reproduction, both directions. Refuse: "e.g." sat between `sizing`
  // and "phase 0" and the first-period window stopped at it, green. Accept: the
  // window is the sentence, so a "phase 0" in the NEXT sentence is not an
  // attribution — widening past the real end would red a true statement.
  const slice = rulingStep();
  const opening = phrase("`sizing` is the");
  const misattributed = slice.replace(opening, "`sizing` is the member's verdict, e.g. the one phase 0 records. `sizing` is the");
  assert.notEqual(misattributed, slice, "the fixture's anchor no longer matches the ruling step — update it, do not delete it");
  assert.match(sizingSentence(misattributed), /phase 0/i, "a phase-0 attribution with an abbreviation before it read as clean");
  const nextSentence = slice.replace(opening, "`sizing` is the member's verdict, e.g. from its own run. Phase 0 only shortlists. `sizing` is the");
  assert.doesNotMatch(sizingSentence(nextSentence), /phase 0/i, "the sizing sentence ran on into the next one");
});

test("a `member` mentioned later in the sentence does not cover a `sizing` misattributed near its own start", () => {
  // Found in review of #1983: extracting the WHOLE sentence (up from a 120-char
  // window) also widened the pre-existing positive check above, which used to
  // require "member" within that same 120 chars. A misattribution that keeps
  // "member" alive later in the ~326-char sentence — here, in the trailing
  // `diff-stats.mjs` clause — passed silently until that check was re-bound to
  // the word `sizing` itself.
  const slice = rulingStep();
  const misattributed = slice
    .replace("`sizing` is the\n**member's** own", "`sizing` is the\n**controller's** own")
    .replace(
      "`profile`, `loc` and `files` all come from `diff-stats.mjs` over the merged\ndiff.",
      "`profile`, `loc` and `files` all come from `diff-stats.mjs` over the member's merged\ndiff.",
    );
  assert.notEqual(misattributed, slice, "the fixture's anchors no longer match the ruling step — update it, do not delete it");
  assert.doesNotMatch(
    sizingSentence(misattributed),
    /`sizing`[\s\S]{0,40}member/i,
    "a `sizing` misattributed to the controller read as the member's because `member` appears later in the sentence",
  );
});

test("the dispatch brief tells the member to emit the Sizing line the ruling step reads", () => {
  // Both ends or neither: a ruling step that reads `Sizing:` off a PR body no
  // member was told to write is the same blank column with more words. Pinned
  // apart from the reader above so dropping either end reds. The brief is the
  // implementer agent body since #1804 (spec 2026-09-24 § 2 Decision 2) — the
  // member's system prompt, where run-team's phase 2 used to paste it.
  const brief = readFileSync(join(REPO, "plugin", "agents", "fleet-implementer-slow-high.agent.md"), "utf8").split("---").slice(2).join("---");
  assert.match(
    brief,
    /`Sizing: light` or `Sizing: heavy`/,
    "the dispatch brief no longer tells the member to put its sizing verdict in the PR body",
  );
});

test("the ruling step refuses to record a sizing verdict it cannot date", () => {
  // #1070. The channel pinned above says WHERE the verdict is read from; it says
  // nothing about whether the line was produced by the run it claims. A
  // `Sizing:` line typed in before `sizing-a-ticket` ever ran is byte-identical
  // to one the skill produced, so the body is not a second source for itself —
  // measured on a member that wrote the verdict first and caught itself
  // afterwards, which is the only reason anyone knows this can happen.
  const slice = rulingStep();

  // The rule as ONE span, both conditions joined. Split into two presence
  // checks, a controller holding a signalled-but-undated verdict satisfies the
  // half it is looking at and records it, which is the whole defect.
  assert.match(
    slice,
    phrase("Record `sizing` only when the report places that run before the PR AND the line carries its signal"),
    "recording `sizing` is no longer conditioned on the report's ordering together with the line's signal",
  );
  // The else-branch, bound to the action it demands. A rule with no stated
  // failure action is read as advice, and the adjacent BLANK rule is about a
  // value not in hand — an undated verdict IS in hand, which is what makes it
  // dangerous.
  assert.match(
    slice,
    phrase("leave the field BLANK and say which in `note`"),
    "the ruling step no longer says what to do when the verdict cannot be dated",
  );
  // The three failure cases, as the one sentence that enumerates them: a
  // controller told only about a missing clause still records the case where
  // the member reported writing the line early.
  assert.match(
    slice,
    phrase("Ordering clause missing, verdict authored before the run with no corrected value reported, or body and report naming different verdicts"),
    "the ruling step no longer enumerates which failures blank the covariate",
  );
  // The rejected alternative, kept explicit: deriving the verdict from the diff
  // was ruled premature on #1070, and a controller staring at a blank column
  // with `diff-stats.mjs` output already in hand is exactly who would reach for
  // it — producing a value that reads as measured, which is the defect again.
  assert.match(
    slice,
    phrase("Do not re-derive the verdict from the diff to fill the gap"),
    "the ruling step no longer forbids substituting a diff-derived proxy for the member's verdict",
  );
});

// `run_date` is DERIVED in `member-outcomes.tsv` (a transcript mtime) and
// STAMPED AT RULING here, and phase 2's per-cell gate counts distinct
// `run_date`s — ten comparisons across five dates — over the other file, never
// this one. Read as a count over THIS file, it answers a different question,
// and nothing in this header used to say so.
//
// The paragraph that now says it makes claims about files this one does not
// contain, which is the shape that rots silently: it stays true only while
// cell-readout.mjs keeps dating comparisons off member-outcomes.tsv,
// `member-outcomes.mjs` keeps stamping dates off an mtime, and SKILL.md keeps
// the floor's numbers. So the pins below DERIVE each claim from its real
// source — the same reason the `profile` pin above derives the enum instead of
// restating it.
const MEMBER_SRC = readFileSync(join(REPO, "plugin", "scripts", "member-outcomes.mjs"), "utf8");

// Bounded at both ends, for `between`'s own stated reason: this header is 140
// lines about exactly these words, so an unbounded match is satisfiable from
// the provenance block above the paragraph or the column legend below it. The
// end bound is the column line's tab-separated shape, which no prose line has.
const runDateSources = () =>
  stripHashGutter(between(HEADER, "WHICH FILE'S `run_date` SUPPLIES", "# run_date\t", "the header"));

test("the header says which file each distinct-`run_date` count is read from, and that the two columns differ", () => {
  const block = runDateSources();

  // The floor bound to its file in ONE span. Split into a mention of the
  // number and a separate mention of the file, a reader counting the ten/five
  // floor over this file satisfies both halves and is wrong anyway — which is
  // the defect, not a wording preference.
  assert.match(
    block,
    phrase(
      "at least ten comparisons across five or more distinct `run_date`s, the floor that forbids reading a cell early — is NOT read here at all. It comes from `plugin/scripts/cell-readout.mjs`, which dates each comparison by its session's `run_date` in `docs/metrics/member-outcomes.tsv`",
    ),
    "the header no longer says the per-cell gate's distinct-date count is read from member-outcomes.tsv through cell-readout.mjs, not here",
  );

  // The definitional halves, each joined to what it makes the column MEAN. A
  // reader told only that the two are "different" still has to guess which way.
  assert.match(
    block,
    phrase(
      "Here it is STAMPED AT RULING — `tier-outcomes.mjs append` reads the clock when the controller rules a PR's review, where before 2026-09-29 the controller typed it at that same moment — so it records WHICH RUN THE PR BELONGS TO",
    ),
    "the header no longer says this file's `run_date` is stamped at ruling and records which run the PR belongs to, as one contiguous claim",
  );
  assert.match(
    block,
    phrase(
      "In `member-outcomes.tsv` it is DERIVED in code: `member-outcomes.mjs` stamps every row of a session from the NEWEST TRANSCRIPT MTIME in that session directory rather than a clock read, so it records WHEN THE SESSION LAST WROTE",
    ),
    "the header no longer says member-outcomes.tsv's `run_date` is derived from a transcript mtime",
  );

  // The correction the ticket itself got wrong: it reported the derived date as
  // drifting "if the session is re-scraped after midnight". A re-scrape moves
  // nothing — the mtime is fixed once written, which is why a December backfill
  // still dates an August session in August. Dropping this sentence restores
  // the false claim into a header other prose cites.
  assert.match(
    block,
    phrase("It moves only when the session WRITES AGAIN"),
    "the header no longer says the derived date moves on a re-write, not on a re-scrape",
  );
  assert.match(
    block,
    phrase("never because the file was merely re-scraped"),
    "the header no longer rules out a bare re-scrape as a cause of date drift",
  );
});

test("the header's `run_date` source claims still hold against the readout, the scraper and the guard", () => {
  const block = runDateSources();

  // The gate half: the count lives in cell-readout.mjs and dates each
  // comparison off the OTHER file's `run_date`. Run, not read: one comparison
  // whose ticket-features date and member-outcomes date differ, and the date
  // the readout counts must be the member-outcomes one. If the readout ever
  // keys its dates elsewhere, "it comes from there" stops being true.
  const session = "s-tier-hdr";
  const pull = (agent, chosen_cell) => ({ run_date: "2026-01-01", session, agent, chosen_cell });
  const member = (agent, cell, model) => ({
    session, agent, run_date: "2026-02-02", model, effort: "high", subagentType: `fleet-implementer-${cell}`,
  });
  const { cells: [task] } = readout({
    features: [pull("impl-1", "task-high"), pull("impl-2", "slow-high")],
    members: [member("impl-1", "task-high", "m-task"), member("impl-2", "slow-high", "m-slow")],
  });
  assert.deepEqual([task.cell, task.comparisons, task.runDates], ["task-high", 1, 1]);
  assert.deepEqual([...task.dates], ["2026-02-02"], "cell-readout.mjs no longer dates a comparison by member-outcomes.tsv's `run_date`");
  assert.match(block, /`plugin\/scripts\/cell-readout\.mjs`/);
  assert.match(block, /`docs\/metrics\/member-outcomes\.tsv`/);

  // The DERIVED half as code, not prose: the date comes off a transcript
  // mtime. A scraper switched to a clock read would make this header's
  // central contrast false while every prose pin above stayed green. Bound
  // to rowsForSession, member-outcomes.mjs's one stamp site, rather than
  // scanning the whole file — a regression outside this slice could
  // otherwise satisfy `assert.match` over MEMBER_SRC as a whole through
  // unrelated text elsewhere.
  const rowsForSessionSrc = between(
    MEMBER_SRC,
    "export function rowsForSession(sessionDir, stats = {}) {",
    "export const COLUMNS",
    "member-outcomes.mjs's rowsForSession",
  );
  assert.match(
    rowsForSessionSrc,
    /newest = Math\.max\(newest, statSync\(.+\)\.mtimeMs\)/,
    "member-outcomes.mjs's rowsForSession no longer takes its date from a transcript mtime",
  );
  assert.match(
    rowsForSessionSrc,
    /const run_date = newest \? new Date\(newest\)/,
    "member-outcomes.mjs's rowsForSession no longer stamps `run_date` from that mtime",
  );

  // The STAMPED-AT-RULING half is the writer's behaviour since #2207, not a
  // SKILL.md duty: tier-outcomes.test.mjs runs `append` and pins the date it
  // writes to the day it ran.

  // The floor's numbers, as the paragraph quotes them. It names figures it
  // does not own; a threshold changed in SKILL.md or in the readout alone
  // leaves this header quietly citing the old one.
  assert.match(
    unemphasized(RUN_TEAM),
    phrase("there are at least ten of them across five or more distinct `run_date`s"),
    "SKILL.md's per-cell floor is no longer ten comparisons across five dates — the header quotes those numbers",
  );
  assert.deepEqual({ ...GATE }, { comparisons: 10, runDates: 5 }, "cell-readout.mjs's gate is no longer ten across five — the header quotes those numbers");
  assert.match(
    block,
    phrase("at least ten comparisons across five or more"),
    "the header no longer states the per-cell floor it attributes to the other file",
  );
});
