// #3668. `recipe-check.mjs` records the `git write-tree` of the staged index
// before the commit, and `ledger.mjs settle --from-report` requires that tree
// to be the reported head's `^{tree}`. A consumer's pre-commit hook that
// rewrites and re-stages files after the record was written commits a tree
// the record does not name, so settle refuses a green report. Every surface
// that tells a member to run `recipe-check.mjs` before the commit therefore
// also tells it, after the commit and before the push or the report, to
// compare `HEAD^{tree}` with its record's `tree` and to re-run on a mismatch:
//
//   - the implementer brief, rendered;
//   - the fix-applier brief, rendered, for every kind it has;
//   - the next-ticket skill's open-the-PR step;
//   - review-and-fix.md's step 3, which the fix-applier runs.
//
// The two surfaces that carry the hook-rewrite stale-base rule (the
// next-ticket skill and the fix-applier brief) also say that rule still
// applies and runs first; hook-rule-prose.test.mjs pins the rule itself.
//
// THE CEILING: presence pins. dispatch-block-golden-prose.test.mjs holds the
// two briefs whole; the next-ticket skill and review-and-fix.md have no golden
// fixture behind these pins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pin } from "./support/prose-pin.mjs";
import { CASES, renderBrief } from "./support/render-brief.mjs";

const PLUGIN = join(import.meta.dirname, "..", "plugin");
const read = (...p) => readFileSync(join(PLUGIN, ...p), "utf8");

// `>` gutter and `**` emphasis stripped, whitespace collapsed: a pin survives
// a rewrap or a bold move.
const flatten = (s) =>
  s
    .split("\n")
    .map((l) => l.replace(/^\s*>?\s?/, ""))
    .join(" ")
    .replace(/\*\*/g, "")
    .split(/\s+/)
    .join(" ")
    .trim();

const compare = (scratch) =>
  `After the commit, and before you push or report, compare \`git rev-parse 'HEAD^{tree}'\` with the \`tree\` field of your record, \`${scratch}/reports/<your name>.check.json\`.`;
const RERUN =
  "A commit hook that rewrote and re-staged files after the record was written makes the two differ; when they do, run `recipe-check.mjs` again with the same arguments. Right after the commit the index holds the committed tree, so the re-run runs both commands on that tree and records it, leaving the head's sha as it is. Equal trees need no re-run.";
const COMPOSE =
  "The stale-base rule for a hook that rewrites a file the PR does not otherwise change still applies, and runs first: `recipe-check.mjs` refuses a working tree with unstaged changes.";
const HOOK_REWRITE_HEAD = "A hook that rewrites a file the PR does not otherwise change is the same stale base.";

const assertPostCommit = (text, scratch, what) => {
  const at = text.indexOf(compare(scratch));
  assert.notEqual(at, -1, `${what} does not tell the member to compare HEAD^{tree} with its record's tree after the commit`);
  assert.match(text, Pin.phrase(RERUN), `${what} lost the re-run-on-mismatch sentence, or its cause, or that the head is unchanged`);
  assert.ok(text.indexOf(RERUN) > at, `${what} states the re-run before the comparison that triggers it`);
};

const scratchOf = (role, kind) => CASES.find((c) => c.role === role && c.kind === kind).args.scratch;

test("the rendered implementer brief compares HEAD^{tree} with the record after the commit and re-runs on a mismatch", () => {
  assertPostCommit(flatten(renderBrief("implementer")), scratchOf("implementer", null), "the implementer brief");
});

for (const kind of CASES.filter((c) => c.role === "fix-applier").map((c) => c.kind)) {
  test(`the rendered fix-applier ${kind} brief compares HEAD^{tree} with the record after the commit, re-runs on a mismatch, and keeps the hook-rewrite rule`, () => {
    const brief = flatten(renderBrief("fix-applier", kind));
    assertPostCommit(brief, scratchOf("fix-applier", kind), `the fix-applier ${kind} brief`);
    assert.match(brief, Pin.phrase(COMPOSE), `the fix-applier ${kind} brief does not say the hook-rewrite stale-base rule still applies first`);
    assert.match(brief, Pin.phrase(HOOK_REWRITE_HEAD), `the fix-applier ${kind} brief lost the hook-rewrite stale-base rule`);
  });
}

const NEXT_TICKET = flatten(read("skills", "next-ticket", "SKILL.md"));

test("the next-ticket open-the-PR step compares HEAD^{tree} with the record after the commit, re-runs on a mismatch, and keeps the hook-rewrite rule", () => {
  const step7 = Pin.of(NEXT_TICKET, "the next-ticket skill").between("## 7. When the sizing-a-ticket path reports done", "## Red flags", "step 7").text;
  assertPostCommit(step7, "<scratch>", "next-ticket step 7");
  assert.match(step7, Pin.phrase(COMPOSE), "next-ticket step 7 does not say the hook-rewrite stale-base rule still applies first");
  assert.match(step7, Pin.phrase(HOOK_REWRITE_HEAD), "next-ticket step 7 lost the hook-rewrite stale-base rule");
});

const REVIEW_AND_FIX = flatten(read("commands", "review-and-fix.md"));

test("review-and-fix step 3 compares HEAD^{tree} with the record after the commit and re-runs on a mismatch", () => {
  const step3 = Pin.of(REVIEW_AND_FIX, "review-and-fix.md").between("3. Run `checkCmd` and `testCmd`", "4. Under the fleet", "step 3").text;
  assertPostCommit(step3, "<scratch>", "review-and-fix step 3");
});

// Accept side: a message-only amend leaves the tree, so the record stays valid
// and no surface may now demand a re-run after every commit.
test("every surface keeps the message-only amend valid where it said so", () => {
  for (const [text, what] of [
    [NEXT_TICKET, "the next-ticket skill"],
    [REVIEW_AND_FIX, "review-and-fix.md"],
    [flatten(renderBrief("fix-applier", "review")), "the fix-applier review brief"],
  ]) {
    assert.match(text, /a message-only amend keeps (?:it|the record) valid/, `${what} lost the message-only-amend rule`);
  }
});

// The contract the prose relies on: the record's `tree` is the staged index's
// `git write-tree`, and settle compares it with `<head>^{tree}`.
test("recipe-check.mjs records git write-tree, and settle compares the record's tree with the head's ^{tree}", () => {
  const check = read("scripts", "recipe-check.mjs");
  assert.match(check, /const tree = gitOut\("git write-tree", \["write-tree"\]\);/);
  assert.match(check, /JSON\.stringify\(\{ member, tree, check, test \}\)/);
  const ledger = read("scripts", "ledger.mjs");
  assert.match(ledger, /check\(`the recorded tree \$\{tree\} is \$\{head\}'s tree \$\{headTree\}`, tree === headTree\);/);
  assert.match(ledger, /"rev-parse", "--verify", `\$\{head\}\^\{tree\}`/);
});
