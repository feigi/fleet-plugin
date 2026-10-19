// #3445. A consumer's commit-time hooks now run for a member, because the
// Install step no longer runs under the agent shell's `CI` (claim-ticket.test.mjs,
// recipe-prove.test.mjs and snapshot-repo.test.mjs execute that half). This file
// pins what the member rules say once a hook DOES run:
//
//   - one no-bypass rule, carrying the same qualifier wherever it appears:
//     never `--no-verify` on a commit you push, or on the push. The
//     qualifier is the point — an unqualified "never" collides with the WIP
//     commit that stands in for `git stash`, whose exemption
//     stash-prohibition-prose.test.mjs pins. The fix-applier runs
//     review-and-fix.md's step 3, so that step carries it too;
//   - a hook that rewrites a file the PR does not otherwise change is a stale
//     base, and the member stages every change of its own BEFORE the commit
//     that runs the hook, so what is still unstaged after it is the hook's
//     alone and the restore touches nothing of the member's;
//   - the Recipe deriver is told the Install step runs with `CI` unset;
//   - the next-ticket claim step runs the Install step as `env -u CI sh -c`,
//     and never as a bare or subshell `unset CI`.
//
// THE CEILING: these are presence-and-order pins. A sentence appended after a
// pinned span that carves an exception into it stays green here;
// dispatch-block-golden-prose.test.mjs holds the fix-applier's whole block and
// body to a golden fixture, which an appended carve-out reds. The next-ticket
// skill and review-and-fix.md have no golden fixture behind this file's pins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pin } from "./support/prose-pin.mjs";
import { agentBody, renderBrief } from "./support/render-brief.mjs";

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

const RULE = "Never `--no-verify` on a commit you push, or on the push itself.";
const HOOK_REWRITE =
  "A hook that rewrites a file the PR does not otherwise change is the same stale base. Stage every change of your own before the commit that runs the hook, so every change still unstaged after it is the hook's alone: never stage those, `git restore -- <that path>` for each such path alone, then rebase and re-run.";

const NEXT_TICKET = flatten(read("skills", "next-ticket", "SKILL.md"));

test("the next-ticket skill's no-bypass rule sits before step 5 and carries the on-a-commit-you-push qualifier", () => {
  const rule = NEXT_TICKET.indexOf(RULE);
  assert.notEqual(rule, -1, "the skill lost its no-bypass rule, or the qualifier");
  const claim = NEXT_TICKET.indexOf("## 5. Claim it");
  assert.ok(claim !== -1, "the skill's step 5 heading moved — move this pin with it");
  assert.ok(rule < claim, "the no-bypass rule no longer sits before step 5, so it does not cover every commit and push the skill drives");
});

test("the next-ticket skill never states --no-verify without the qualifier", () => {
  for (const { index: at } of NEXT_TICKET.matchAll(/Never `--no-verify`/g)) {
    assert.ok(NEXT_TICKET.startsWith(RULE, at), `an unqualified --no-verify rule: ${NEXT_TICKET.slice(at, at + 80)}`);
  }
});

const FIX_APPLIER_BRIEF = flatten(read("skills", "run-team", "briefs", "fix-applier.md"));

test("the fix-applier brief qualifies its --no-verify rule to a commit it pushes, or the push", () => {
  assert.match(
    FIX_APPLIER_BRIEF,
    Pin.phrase("Never `--no-verify` on a commit you push, or on the push — a failing hook is a finding you report, not an obstacle you route around."),
    "the fix-applier brief's --no-verify rule lost its qualifier",
  );
  assert.doesNotMatch(FIX_APPLIER_BRIEF, /Never `--no-verify` —/, "the unqualified rule is back");
});

const REVIEW_AND_FIX = flatten(read("commands", "review-and-fix.md"));

test("review-and-fix step 3, which the fix-applier runs, qualifies its --no-verify rule and never states it bare", () => {
  const step3 = Pin.of(REVIEW_AND_FIX, "review-and-fix.md").between("3. Run `checkCmd` and `testCmd`", "4. Under the fleet", "step 3").text;
  assert.match(step3, Pin.phrase(RULE), "review-and-fix step 3 lost its no-bypass rule, or the qualifier");
  for (const at of [...REVIEW_AND_FIX.matchAll(/Never `--no-verify`/g)].map((m) => m.index)) {
    assert.equal(REVIEW_AND_FIX.slice(at, at + RULE.length), RULE, `an unqualified --no-verify rule: ${REVIEW_AND_FIX.slice(at, at + 80)}`);
  }
});

// Accept side. The rule forbids the bypass on what reaches the branch and
// nowhere else, so the review snapshot's own commit — a throwaway repository
// the fleet cuts before the Install step, never pushed — still skips hooks.
test("the review snapshot's fleet-internal commit still takes --no-verify", () => {
  assert.match(read("scripts", "review-core.mjs"), /git -c user\.name=fleet -c user\.email=fleet@invalid commit -q --no-verify -m "review snapshot of \$SHA"/);
});

const assertHookRewrite = (p) => {
  assert.match(p, Pin.phrase(HOOK_REWRITE), "the red Check step paragraph lost the hook-rewrite sentence");
  assert.ok(p.indexOf("Stage every change of your own before the commit that runs the hook") < p.indexOf("`git restore -- <that path>`"), "the restore comes before the staging");
};

test("the hook-rewrite sentence is in the next-ticket red-Check paragraph, staging before the restore", () => {
  const p = Pin.of(NEXT_TICKET, "the next-ticket skill").between("A red Check step is yours to judge.", "In a detached worktree, push by refspec.", "the red Check step paragraph").text;
  assertHookRewrite(p);
});

for (const kind of ["review", "conflict"]) {
  test(`the hook-rewrite sentence is in the fix-applier's red-Check paragraph (${kind} brief), staging before the restore`, () => {
    const p = Pin.of(flatten(renderBrief("fix-applier", kind)), `the fix-applier ${kind} brief`).between(
      "A red `CHECKCMD-",
      "Your report is a file",
      "the red Check step paragraph",
    ).text;
    assertHookRewrite(p);
  });
}

test("the Recipe deriver is told the Install step runs with CI unset, so it spells the frozen or locked mode itself", () => {
  const body = flatten(agentBody("fleet-recipe-deriver"));
  const bullet = Pin.of(body, "the deriver body").between("- Install step —", "- Test entrypoint —", "the Install step bullet").text;
  assert.match(
    bullet,
    Pin.phrase("The fleet and a standalone next-ticket session run the Install step with `CI` unset, so spell the frozen or locked mode in the command; never rely on the environment to imply it."),
    "the deriver's Install step bullet lost the CI-unset clause",
  );
});

// The standalone claim runs the Install step by hand in the agent's own shell,
// where the harness's `CI` is set and an `unset CI` there, bare or in a
// subshell, can leave `CI` set for the command, so the step names `env -u CI`
// and nothing else as the way.
const claimStep = () => Pin.of(NEXT_TICKET, "the next-ticket skill").between("## 5. Claim it", "## 6. Size the ticket", "step 5").text;

test("the next-ticket claim step runs the Install step as env -u CI sh -c, and only the Install step loses CI", () => {
  assert.match(
    claimStep(),
    Pin.phrase('Run the Install step with `CI` removed, from the new worktree\'s root: `env -u CI sh -c "<install>"`'),
    "step 5 lost the env -u CI form of the Install step",
  );
  assert.match(
    claimStep(),
    Pin.phrase("Only the Install step loses `CI`; the Check step and the Test entrypoint baseline run in your shell's own environment."),
    "step 5 lost the clause scoping the CI removal to the Install step",
  );
});

// Reject side: neither a bare `unset CI` nor the subshell form may come back,
// since in the agent shell either can leave `CI` set for the command.
test("the next-ticket claim step never tells the agent to unset CI in its shell", () => {
  assert.doesNotMatch(claimStep(), /unset\s+(?:-v\s+)?CI\b/, "step 5 tells the agent to unset CI in its own shell");
  assert.doesNotMatch(claimStep(), /\(\s*unset\b/, "step 5 carries the subshell unset form");
});
