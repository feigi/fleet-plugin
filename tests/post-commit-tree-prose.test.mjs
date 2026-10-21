// #3668. `recipe-check.mjs` records the `git write-tree` of the staged index
// before the commit, and `ledger.mjs settle --from-report` requires that tree
// to be the reported head's `^{tree}`. A consumer's pre-commit hook that
// rewrites and re-stages files after the record was written commits a tree
// the record does not name, so settle refuses a green report. Every surface
// that tells a member to run `recipe-check.mjs` before the commit therefore
// also tells it, after the commit and before the push or the report, to
// compare `HEAD^{tree}` with its record's `tree`, to list the paths the hook
// changed on a mismatch, and to re-run only when the PR changes every one of
// them anyway:
//
//   - the implementer brief, rendered;
//   - the fix-applier brief, rendered, for every kind it has;
//   - the next-ticket skill's open-the-PR step;
//   - review-and-fix.md's step 3, which the fix-applier runs.
//
// A listed path the PR does not otherwise change is a stale base the hook
// staged instead of leaving unstaged: the unstaged-only stale-base rule
// (hook-rule-prose.test.mjs) never sees it, and a bare re-run would record the
// unrelated rewrite green and let settle pass it. So every surface also routes
// that case to a rebase and a re-commit without the path, and none may say the
// old unconditional "when they do, run recipe-check.mjs again".
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
const listHook = (scratch) =>
  `A commit hook that rewrote and re-staged files after the record was written makes the two differ. When they do, list the paths it changed, \`git diff --name-only "$(jq -r .tree ${scratch}/reports/<your name>.check.json)" HEAD\`.`;
const RERUN =
  "If the PR changes every listed path anyway, run `recipe-check.mjs` again with the same arguments: right after the commit the index holds the committed tree, so the re-run runs both commands on that tree and records it, leaving the head's sha as it is.";
const STALE =
  "A listed path the PR does not otherwise change is a stale base the hook staged rather than left unstaged, and a re-run would record it green: `git fetch origin && git rebase origin/main`, take the commit back with `git reset --soft HEAD^`, put each such path alone back with `git restore --source=HEAD --staged --worktree -- <that path>`, run `recipe-check.mjs`, then `git commit -C ORIG_HEAD` and compare again.";
const AGAIN = "A hook that stages such a path again on the rebased base →";
const UNCONDITIONAL = /when they do, run `recipe-check\.mjs` again/;
const HOOK_REWRITE_HEAD = "A hook that rewrites a file the PR does not otherwise change is the same stale base.";

const assertPostCommit = (text, scratch, what) => {
  const at = text.indexOf(compare(scratch));
  assert.notEqual(at, -1, `${what} does not tell the member to compare HEAD^{tree} with its record's tree after the commit`);
  const list = text.indexOf(listHook(scratch));
  assert.ok(list > at, `${what} does not list the paths the hook changed, after the comparison that finds the mismatch`);
  assert.match(text, Pin.phrase(RERUN), `${what} lost the re-run for a hook that changed only the PR's own paths, or its cause, or that the head is unchanged`);
  assert.ok(text.indexOf(RERUN) > list, `${what} states the re-run before the listing that gates it`);
  assert.match(text, Pin.phrase(STALE), `${what} lets a hook-staged path the PR does not otherwise change be re-recorded green`);
  assert.ok(text.indexOf(AGAIN) > text.indexOf(STALE), `${what} lost what to do when the hook stages that path again on the rebased base`);
  assert.doesNotMatch(text, UNCONDITIONAL, `${what} still re-runs on any mismatch, whatever the hook staged`);
};

const scratchOf = (role, kind) => CASES.find((c) => c.role === role && c.kind === kind).args.scratch;

test("the rendered implementer brief compares HEAD^{tree} with the record after the commit and re-runs only over the PR's own paths", () => {
  assertPostCommit(flatten(renderBrief("implementer")), scratchOf("implementer", null), "the implementer brief");
});

for (const kind of CASES.filter((c) => c.role === "fix-applier").map((c) => c.kind)) {
  test(`the rendered fix-applier ${kind} brief compares HEAD^{tree} with the record after the commit, re-runs only over the PR's own paths, and keeps the hook-rewrite rule`, () => {
    const brief = flatten(renderBrief("fix-applier", kind));
    assertPostCommit(brief, scratchOf("fix-applier", kind), `the fix-applier ${kind} brief`);
    assert.match(brief, Pin.phrase(HOOK_REWRITE_HEAD), `the fix-applier ${kind} brief lost the hook-rewrite stale-base rule`);
  });
}

const NEXT_TICKET = flatten(read("skills", "next-ticket", "SKILL.md"));

test("the next-ticket open-the-PR step compares HEAD^{tree} with the record after the commit, re-runs only over the PR's own paths, and keeps the hook-rewrite rule", () => {
  const step7 = Pin.of(NEXT_TICKET, "the next-ticket skill").between("## 7. When the sizing-a-ticket path reports done", "## Red flags", "step 7").text;
  assertPostCommit(step7, "<scratch>", "next-ticket step 7");
  assert.match(step7, Pin.phrase(HOOK_REWRITE_HEAD), "next-ticket step 7 lost the hook-rewrite stale-base rule");
});

const REVIEW_AND_FIX = flatten(read("commands", "review-and-fix.md"));

test("review-and-fix step 3 compares HEAD^{tree} with the record after the commit and re-runs only over the PR's own paths", () => {
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
