import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
const REPO = join(import.meta.dirname, "..", "..", "..");
const TSV = readFileSync(join(REPO, "docs", "metrics", "tier-outcomes.tsv"), "utf8");
const RUN_TEAM = readFileSync(join(REPO, "skills", "fleet", "skills", "run-team", "SKILL.md"), "utf8");

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
