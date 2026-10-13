// #836. `docs/agents/triage-labels.md`'s Meaning column is a TRANSCRIPT of the
// tracker's own label descriptions — three of the five cells were byte-identical
// to `gh api repos/feigi/claude-config/labels/<name> --jq .description` when this
// was written. A transcript has no owner, so it drifts against whichever side
// moves. ADR 0001 repriced the filing bar to "is the defect confirmed", and the
// `ready-for-agent` cell's "Fully specified" contradicted it; #836 stripped the
// criterion out of the cell.
//
// #3171 (ADR 0032) supersedes that bar: every issue the plugin creates is filed
// `needs-triage`, and only triage sets `ready-for-agent`. The contradiction
// #836 guarded is gone with the bar, so the `ready-for-agent` pin is inverted:
// what it holds now is that the cell names triage as the only seat that sets
// the label, and the file's filing-time gloss states the rule itself. The
// vector is the old one in reverse — anyone restating ADR 0001's bar here puts
// a filing path to `ready-for-agent` back into the file the skills read their
// label vocabulary from.
//
// #836 raises the `ready-for-agent` cell alone. The `ready-for-human` pin below
// is an ADDITION, made under the ticket's own acceptance criterion that "the
// other four rows are checked for the same drift while the file is open". That
// check found the same narrowing in `ready-for-human` and nothing to correct in
// the other three. Its vector is not the re-sync above — the tracker's own
// `ready-for-human` description does not narrow to implementation — so what is
// pinned there is the narrowing itself.
//
// CEILING: each row test pins one row slice — the role-to-label-string mapping,
// that the gloss still says who the label routes work to, and one cell claim.
// The gloss test pins one paragraph. None of this proves the file carries no
// OTHER restated criterion — no assertion can.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Pin } from "./support/prose-pin.mjs";

const REPO = join(import.meta.dirname, "..");
const TABLE = Pin.file(join(REPO, "docs", "agents", "triage-labels.md"));

// One table row per slice. The claim is a single cell, so anything wider lets
// a neighbouring row satisfy the assertion with the cell rewritten.
const row = (label) => TABLE.between(`| \`${label}\``, "\n|", `the ${label} row`).text;

test("the ready-for-agent row maps the role and names triage as the only seat that sets it", () => {
  const r = row("ready-for-agent");
  assert.match(
    r,
    Pin.phrase("| `ready-for-agent` | `ready-for-agent` |"),
    "the ready-for-agent row no longer maps the role to its label string — that mapping is what scripts read",
  );
  assert.match(
    r,
    /AFK agent/,
    "the ready-for-agent gloss no longer says who the label routes work to",
  );
  assert.match(
    r,
    Pin.phrase("only triage sets it"),
    "the ready-for-agent gloss no longer says only triage sets the label — a filer reading the cell may file straight to `ready-for-agent` again",
  );
});

// The filing-time gloss, one paragraph: bounded by its own bold lead and the
// blank line that closes it.
const filingGloss = () => TABLE.between("**Filing time.**", "\n\n", "the filing-time gloss").text;

test("the filing-time gloss files every plugin-created issue needs-triage, a confirmed defect included", () => {
  const g = filingGloss();
  // The rule and the case ADR 0001 sent elsewhere as ONE span: a confirmed
  // defect is exactly the finding the superseded bar filed `ready-for-agent`.
  assert.match(
    g,
    Pin.phrase("Every issue the plugin creates is filed `needs-triage` — a confirmed defect included, because confirming a defect does not settle its remedy."),
    "the filing-time gloss no longer files every plugin-created issue `needs-triage`, a confirmed defect included",
  );
  assert.match(g, Pin.phrase("Only triage sets `ready-for-agent`."), "the filing-time gloss no longer reserves `ready-for-agent` to triage");
  // Duplicates never relabel: a pin on the comment-only rule.
  assert.match(
    g,
    Pin.phrase("comments there and changes no label, so an issue triage already promoted stays `ready-for-agent`."),
    "the filing-time gloss no longer says a duplicate finding changes no label",
  );
});

test("the ready-for-human row does not narrow the role to implementation", () => {
  const r = row("ready-for-human");
  assert.match(
    r,
    Pin.phrase("| `ready-for-human` | `ready-for-human` |"),
    "the ready-for-human row no longer maps the role to its label string — that mapping is what scripts read",
  );
  assert.match(
    r,
    /AFK agent/,
    "the ready-for-human gloss no longer says who the label routes work to, so the negative below is passing on an empty cell",
  );
  // Stem again: "Requires a human to implement" carries the same narrowing
  // with the noun gone.
  assert.doesNotMatch(
    r,
    /implement/i,
    "the ready-for-human gloss is back to requiring human implementation — `skills/run-team/SKILL.md` also routes work needing a human BEFORE implementation here",
  );
});
