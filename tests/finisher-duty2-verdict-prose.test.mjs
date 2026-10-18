import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Pin } from "./support/prose-pin.mjs";

// #3472. Finisher duty 2 re-judged, by hand, deferral homes that
// dispositions-check.mjs had already judged, and its hand test never named the
// PR's closed `wontfix` suggestion-band record — so a finisher read that record
// as "not a home" and halted a PR whose dispatch had required, and got, a
// dispositions verdict of `ok`. The ruling defers duty 2 to that verdict for a
// deferral of a finding in the review's result, names the record, and keeps the
// hand test for everything the script does not read.
//
// Pinned in both places duty 2 is stated in full: the agent body the finisher
// is handed, and references/finisher.md, which the body mirrors. The golden
// body fixture pins the body's whole text; these pins name what each sentence
// is for, so a deletion reds with its reason.
//
// CEILING: presence over a bounded slice, flattened so a rewrap stays green.
// These cannot prove a later sentence in the same slice does not carve out an
// exception.
const REPO = join(import.meta.dirname, "..", "plugin");
const flat = (s) => s.replace(/\s+/g, " ");

const BODY = Pin.file(join(REPO, "agents", "fleet-finisher.agent.md"));
const FINISHER_MD = Pin.file(join(REPO, "skills", "run-team", "references", "finisher.md"));
const DUTY2_LEAD = "**Confirm every deferral — and every claimed APPLY — has a home that outlives";
const slices = () => [
  ["the finisher agent body", flat(BODY.between(DUTY2_LEAD, "**A fix-applier's \"applied\" is a claim like any other**", "fleet-finisher duty 2").text)],
  [
    "references/finisher.md",
    flat(FINISHER_MD.section("## Duty 2: every deferral, and every claimed APPLY, has a home that outlives the merge", "references/finisher.md duty 2").text),
  ],
];

test("duty 2 defers a deferral of a finding in the review's result to the dispositions verdict dispatch required", () => {
  for (const [where, d] of slices()) {
    assert.match(
      d,
      Pin.phrase("A deferral of a finding in the review's result is not yours to re-judge when the PR's latest review counted a survived or unverified finding:"),
      `${where}: duty 2 no longer hands a review-result deferral to the dispositions verdict`,
    );
    assert.match(
      d,
      Pin.phrase("`ledger.mjs dispatch` then dispatched you only once the PR's ledger row held a `dispositions-ok` verdict from `dispositions-check.mjs` on that review (`dispositionsRefusal`)"),
      `${where}: duty 2 no longer says dispatch required the ok verdict`,
    );
    assert.match(
      d,
      Pin.phrase("That verdict is the judgement of those homes: do not halt on a home the script accepted, and do not re-file one as an open issue."),
      `${where}: duty 2 lets the finisher re-judge, halt on, or re-file a home the script accepted`,
    );
  }
});

test("duty 2 names the closed wontfix suggestion-band record as a home, and covers dispatch with no verdict without loosening it", () => {
  for (const [where, d] of slices()) {
    assert.match(
      d,
      Pin.phrase("One such home is the PR's own `PR #<M> review: the suggestion band, checked` issue, which counts although it is closed and labelled `wontfix`."),
      `${where}: duty 2 no longer names the closed wontfix record as a home`,
    );
    assert.match(
      d,
      Pin.phrase(
        "Where the latest review counted no survived and no unverified finding, dispatch required no verdict; that record is still a home there when it matches the script's own definition — `homeHolds` in `dispositions-check.mjs`: state `CLOSED`, labelled `wontfix`, titled exactly `recordTitle(<M>)` — and any other closed issue is not.",
      ),
      `${where}: duty 2 leaves the record unnamed where dispatch required no verdict, or no longer holds it to the script's definition`,
    );
    // The REFUSE side: the record is a home by the script's definition, never
    // "any closed issue".
    assert.doesNotMatch(d, /any closed issue (?:counts|is a home|qualifies)/i, `${where}: duty 2 loosened the record to any closed issue`);
  }
});

test("duty 2 keeps the hand test for what the script does not read, and the open-home rule", () => {
  for (const [where, d] of slices()) {
    assert.match(
      d,
      Pin.phrase("Everything else — a claimed APPLY, a deferral the review's result does not carry, and a deferral no verdict judged — you judge by hand, by the test below."),
      `${where}: duty 2 no longer routes what the script does not read to the hand test`,
    );
    assert.match(
      d,
      Pin.phrase("What fails is a promise living only in a PR body, or on the PR's *own* source issue, which `Closes #N` buries on merge."),
      `${where}: duty 2's hand test lost the PR-body and source-issue failure`,
    );
    assert.match(d, Pin.phrase("Not filed → file it or halt, never label over it"), `${where}: duty 2's hand test lost file-it-or-halt`);
    assert.match(d, Pin.phrase("labelled `needs-triage` as every issue the plugin creates is"), `${where}: duty 2 no longer files open homes \`needs-triage\``);
    assert.match(
      d,
      Pin.phrase("an open `ready-for-agent` issue triage already promoted holds the deferral as it stands"),
      `${where}: duty 2 no longer accepts an already-promoted \`ready-for-agent\` home`,
    );
  }
});
