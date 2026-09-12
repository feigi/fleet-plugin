import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase, stripHashGutter } from "./prose-pin.mjs";

// #472: this file's header has never been pinned, while SKILL.md's guard tells
// the controller that "that file's header carries the column meanings" — so the
// guard's whole accumulate-across-runs mechanism rests on a shape nothing
// checks. The deferral said to add the pin alongside the first consumer. The
// four difficulty columns are that consumer's arrival: they are appended AFTER
// a free-text `note`, which is a shift nobody would see.
//
// No COLUMNS export to compare against, unlike member-outcomes.tsv — no script
// reads this file, it is ruled by hand. Restating the list here IS the pin, and
// the header/SKILL.md agreement below is what keeps the restatement honest.
const REPO = join(import.meta.dirname, "..", "..");
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

const COLUMNS = [
  "run_date",
  "pr",
  "ticket",
  "class",
  "tier",
  "closed_own_ticket",
  "minted_false_claim",
  "note",
  "sizing",
  "profile",
  "loc",
  "files",
];

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
  const def = stripHashGutter(between(HEADER, "minted_false_claim", "# sizing", "the header"));
  assert.match(
    def,
    phrase("the diff AS SUBMITTED added a factual claim"),
    "the header no longer says `minted_false_claim` scores the diff AS SUBMITTED",
  );
  assert.match(
    def,
    phrase("a claim review caught and the fix pass corrected before merge still counts yes"),
    "the header no longer settles the caught-before-merge case, the half a scorer would otherwise infer",
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
  const at = RUN_TEAM.indexOf("**Guard: accumulate per PR");
  assert.notEqual(at, -1, "'**Guard: accumulate per PR' moved — update this test");
  const end = RUN_TEAM.indexOf("**Then record the run's member facts", at);
  assert.notEqual(end, -1, "'**Then record the run's member facts' moved — update this test");
  const slice = RUN_TEAM.slice(at, end);

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
  const at = RUN_TEAM.indexOf("**Guard: accumulate per PR");
  const end = RUN_TEAM.indexOf("**Then record the run's member facts", at);
  const slice = RUN_TEAM.slice(at, end);
  // Negative pinned on the ATTRIBUTION, not on one phrasing of it: the first
  // draft of this test forbade the literal `sizing` is phase 0's and stayed
  // green under a reworded restatement of the same error.
  const sizingSentence = /`sizing`[^.]{0,120}/i.exec(slice)?.[0] ?? "";
  assert.ok(sizingSentence, "the ruling step no longer describes `sizing` at all");
  assert.doesNotMatch(
    sizingSentence,
    /phase 0/i,
    `the ruling step attributes sizing to phase 0 again — phase 0 shortlists, it does not size: ${sizingSentence}`,
  );
  assert.match(
    sizingSentence,
    /member/i,
    "the ruling step no longer says the sizing verdict is the member's",
  );
  assert.match(
    slice,
    /PR body|Sizing:/,
    "the ruling step no longer says where the controller reads the sizing verdict from",
  );
});

test("the dispatch brief tells the member to emit the Sizing line the ruling step reads", () => {
  // Both ends or neither: a ruling step that reads `Sizing:` off a PR body no
  // member was told to write is the same blank column with more words. Pinned
  // apart from the reader above so dropping either end reds.
  assert.match(
    RUN_TEAM,
    /`Sizing: light` or `Sizing: heavy`/,
    "the dispatch brief no longer tells the member to put its sizing verdict in the PR body",
  );
});
