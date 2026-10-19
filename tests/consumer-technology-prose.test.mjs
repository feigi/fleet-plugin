import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Pin } from "./support/prose-pin.mjs";

// The prose that describes the consumer repo as "whatever the Recipe says"
// rather than as a Node project: every shipped runbook and the requirement
// docs name the Recipe's Install step and Test entrypoint, and none of them
// names a Node package manager, a lockfile or a Node-only tool as the way a
// consumer is installed or tested. Each pin below holds ONE contiguous clause
// of that vocabulary inside the bounded slice that carries it.
const PLUGIN = join(import.meta.dirname, "..", "plugin");
const ROOT = join(PLUGIN, "..");
const readPlugin = (rel) => Pin.file(join(PLUGIN, rel));
const readRoot = (rel) => Pin.file(join(ROOT, rel));
const RUN_TEAM = readPlugin("skills/run-team/SKILL.md");
const REAPING = readPlugin("skills/run-team/references/reaping.md");
const ISOLATION = readPlugin("skills/run-team/references/isolation.md");
const REVIEW_AND_FIX = readPlugin("commands/review-and-fix.md");
const REQUIREMENTS = readRoot("docs/requirements.md");
const PULL_AND_CLAIM = readRoot("docs/components/pull-and-claim.md");
const EXTERNAL = readRoot("docs/research/external-assumptions.md");

// A Node-consumer assumption: a lockfile or `node_modules` named as the
// consumer's install state, or a Node package-manager / runner invocation
// named as how a consumer is installed or checked. omp's own plugin install
// dir, `~/.omp/plugins/node_modules`, is where the fleet itself is installed,
// not a consumer's install state, so it is not a hit.
const NODE_CONSUMER = /npm ci|(?<!\.omp\/plugins\/)node_modules|package-lock|pnpm-lock|yarn\.lock|npm install|npx (?:vitest|tsc)/;

const markdownUnder = (dir) =>
  readdirSync(join(PLUGIN, dir), { recursive: true })
    .filter((rel) => rel.endsWith(".md"))
    .map((rel) => join(PLUGIN, dir, rel));

test("the sweep's own pattern matches each Node-consumer form it exists to catch", () => {
  for (const sample of ["npm ci", "its node_modules still on disk", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "run npm install", "npx tsc --noEmit", "npx vitest run"]) {
    assert.match(sample, NODE_CONSUMER, `the pattern no longer matches "${sample}"`);
  }
});

test("the sweep's own pattern passes omp's plugin install dir, which is the fleet's install, not a consumer's", () => {
  assert.doesNotMatch("~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-bootstrap", NODE_CONSUMER);
  assert.match("~/.omp/plugins/node_modules beside the consumer's node_modules", NODE_CONSUMER);
  // The exemption is only omp's install dir: another slash-preceded
  // `node_modules` is still a consumer's.
  assert.match("/app/node_modules", NODE_CONSUMER);
  assert.match("~/.other/plugins/node_modules", NODE_CONSUMER);
});

test("no runbook, command, agent definition or requirement doc names a Node-consumer install state or tool", () => {
  const files = [
    ...markdownUnder("skills"),
    ...markdownUnder("commands"),
    ...markdownUnder("agents"),
    join(ROOT, "docs", "requirements.md"),
    join(ROOT, "docs", "components", "pull-and-claim.md"),
    join(ROOT, "README.md"),
  ];
  assert.ok(files.includes(join(PLUGIN, "skills", "run-team", "SKILL.md")), "the sweep no longer reaches run-team/SKILL.md");
  const offenders = files.filter((f) => NODE_CONSUMER.test(readFileSync(f, "utf8")));
  assert.deepEqual(offenders, [], `Node-consumer wording is back in: ${offenders.join(", ")}`);
});

test("the claim step runs the Recipe's Install step in the worktree, read from the cache", () => {
  const step = PULL_AND_CLAIM.bullet("4. **Claim.**", "5. **Dispatch**", "pull-and-claim.md step 4").text;
  assert.match(step, Pin.phrase("runs the [Recipe](recipe.md)'s Install step there — read from the Recipe cache, refusing if it changed the tree"));
});

test("requirements 2.3 describes the Recipe derivation: any technology, what it reads, what proves it, what it caches", () => {
  const section = REQUIREMENTS.section("### 2.3 Installable and testable — HARD", "requirements.md section 2.3").text;
  assert.match(section, Pin.phrase("Any technology. Fleet derives your repo's Recipe (Install step, Check step and Test entrypoint) by agent reasoning, proves it in a throwaway worktree"));
  const reads = Pin.of(section, "section").bullet("- **What the derivation reads:**", "- **What the proof requires:**", "requirements.md 2.3 derivation bullet").text;
  assert.match(reads, Pin.phrase("nothing checks for a particular manifest or lockfile."));
  const proof = Pin.of(section, "section").bullet("- **What the proof requires:**", "- **The cache:**", "requirements.md 2.3 proof bullet").text;
  assert.match(proof, Pin.phrase("the Check step runs green on `origin/main`, leaving the tree clean, and one deliberate mutation turns it red — `true`, when your CI has no non-test merge-gating check, needs no proof, and a non-test check red on `origin/main` is left out of the Check step and listed in `uncovered`"));
  assert.match(proof, Pin.phrase("`RECIPE NOT PROVEN` writes no cache and halts the run."));
  const cache = Pin.of(section, "section").bullet("- **The cache:**", "Hard rules for any technology:", "requirements.md 2.3 cache bullet").text;
  assert.match(cache, Pin.phrase("carrying the `origin/main` commit it was derived at, the proof, the Check step and `uncovered`."));
  assert.match(cache, Pin.phrase("Every claim reads its Install step and Test entrypoint from it and every review its Install step, Test entrypoint and `uncovered`; members run its Check step before pushing, the review does not."));
  assert.match(cache, Pin.phrase("A missing or unproven cache, or one without a well-formed Check step, is a refusal naming the derivation step, never a guess."));
  assert.match(section, Pin.phrase("4. All three commands run in a fresh worktree. The Check step and the Test entrypoint need no running service, including one the command starts itself"));
  assert.match(section, Pin.phrase("A merge-gating step that needs one is listed in `uncovered` whether or not the service is up when the Recipe is derived; with no service-free test step the derivation reports `RECIPE NOT PROVEN`."));
  assert.match(section, Pin.phrase("The rule forces no re-derivation: delete a Recipe cache derived with a service up under the earlier rule by hand, once (`<main checkout>/.fleet/recipe.json`), and the next derivation follows this rule."));
  assert.doesNotMatch(section, /no ambient environment/, "rule 4 names only shared services again");
  assert.doesNotMatch(section, /proves both|Both commands|both commands/, "2.3 describes a two-command Recipe again");
  // Ends at the line's end: the fence line is the whole command, so a longer ref (`origin/main-old`) or a trailing `&& …` is a different command.
  assert.match(section, new RegExp(`${Pin.phrase("~/.fleet/bin/fleet-run derive-testcmd.sh . install && ~/.fleet/bin/fleet-run derive-testcmd.sh . test --at origin/main").source}[ \\t]*$`, "m"));
});

test("requirements 1.1 adds whatever the Recipe runs to the tool floor", () => {
  assert.match(
    REQUIREMENTS.between("| `shasum` | any |", "### 1.2", "requirements.md section 1.1 table tail").text,
    Pin.phrase("Plus whatever your Recipe runs (§2.3): `mvn`, `go`, `cargo`, …"),
  );
});

test("the research note marks the Node-only consumer rows superseded by the Recipe ruling", () => {
  const row = EXTERNAL.bullet("- ~~Contains `package.json`", "\n- `node` on PATH", "external-assumptions.md consumer-repo row").text;
  assert.match(row, Pin.phrase("Superseded by ADR 0015: the claim reads the Install step and Test entrypoint from the Recipe cache, and nothing checks for a manifest, a test-file name or a lockfile."));
  const implied = EXTERNAL.bullet("- Consumer must be a Node project", "\n- `python3` and `shasum` on PATH", "external-assumptions.md implied-only row").text;
  assert.match(implied, Pin.phrase("Ruled 2026-09-28: ADR 0015 — any technology, Recipe by agent reasoning"));
});

test("review-and-fix step 3 reads the standalone testCmd off the Recipe cache and derives when there is none", () => {
  const step = REVIEW_AND_FIX.bullet("3. **Run `checkCmd` and `testCmd` before you commit**", "\n4. **", "review-and-fix.md step 3").text;
  assert.match(step, Pin.phrase("the repo's own Check step and Test entrypoint**, read off the repo's Recipe cache (`derive-testcmd.sh <repo> check` prints the first, `derive-testcmd.sh <repo> test` the second)"));
  assert.match(step, Pin.phrase("run the Recipe derivation step first"));
  assert.doesNotMatch(step, /node --test/, "step 3 names this repository's own test command again");
});

test("review-and-fix's git archive bullet runs the Install step in the copy, read from a tree that holds the cache", () => {
  const archive = REVIEW_AND_FIX.bullet("- **`git archive` carries tracked files only.**", "\n- **Initialize the copy", "review-and-fix.md git archive bullet").text;
  assert.match(archive, Pin.phrase("run the Install step in the copy (read it off the worktree or main checkout, `derive-testcmd.sh <worktree or main checkout> install`; pointed at the copy it refuses, since a copy holds no Recipe cache)"));
});

test("run-team: a tree with no runner gets the Recipe's Test entrypoint, with no shared-stack carve-out", () => {
  const p = ISOLATION.paragraph("**A reused worktree may lack the runner.**", "references/isolation.md reused-worktree runner paragraph", "**A reused worktree may also be").text;
  assert.match(p, Pin.phrase("tell the member the runner is absent and to run the Recipe's Test entrypoint directly (`~/.fleet/bin/fleet-run derive-testcmd.sh <main checkout> test --at origin/main` prints it)."));
  assert.doesNotMatch(p, /shared stack|stack-free|docker-free/, "the reused-worktree paragraph carves the Test entrypoint out for a stack again");
});

test("run-team: testCmd comes from the Recipe cache and names no repository's own command", () => {
  const p = RUN_TEAM.paragraph("**Where `testCmd` comes from:**", "run-team/SKILL.md testCmd source paragraph", "The review wraps its own one run").text;
  assert.match(p, Pin.phrase("the repository's Test entrypoint, out of the Recipe cache phase 0's Recipe derivation step proved — `~/.fleet/bin/fleet-run derive-testcmd.sh . test --at origin/main` prints it — and the one you hand specialists"));
  assert.doesNotMatch(p, /node --test/, "the testCmd source paragraph names this repository's own test command again");
});

test("run-team: checkCmd comes from the Recipe cache, and the review does not run it", () => {
  const p = readPlugin("skills/run-team/references/phase-0.md").paragraph("**Where `checkCmd` comes from:**", "references/phase-0.md checkCmd source paragraph", "**Mid-run, a cache that stops running").text;
  assert.match(p, Pin.phrase("`~/.fleet/bin/fleet-run derive-testcmd.sh . check` prints it"));
  assert.match(p, Pin.phrase("the review does not run it"));
});

test("run-team: the quick-install red flag points at the Recipe's Install step, not at an install command", () => {
  const flag = RUN_TEAM.bullet("- \"A quick install to set up the worktree\"", "- \"I'm on my own copy, so I'm isolated\"", "run-team/SKILL.md quick-install red flag").text;
  assert.match(flag, Pin.phrase("the claim already ran the Recipe's Install step; any other install can rewrite the lockfile for the whole repo."));
});

test("a merged branch's stale worktree is said to keep its installed dependencies, in reaping.md, which SKILL.md's merge-pass wake points at", () => {
  const skill = RUN_TEAM.bullet("- **Merge-bot pass reports done**", "- **The run ends", "run-team/SKILL.md merge-pass wake").text;
  assert.match(skill, Pin.phrase("See references/reaping.md."));
  const evidence = REAPING.paragraph("Merge deletes remote branch, leaves local branch", "reaping.md reap-after-each-merge paragraph", "## Why `commit-commands:clean_gone` is disqualified").text;
  assert.match(evidence, Pin.phrase("with worktree — and its installed dependencies — still on disk."));
});

test("the isolation reference says symlinking installed dependencies in does not isolate the stack, and reproduces a diagnostic by re-running the check", () => {
  const stack = ISOLATION.paragraph("Private copy and test command solve different problems", "isolation.md stack-isolation paragraph", "## Scratchpad paths need two levels").text;
  assert.match(stack, Pin.phrase("Symlinking installed dependencies in does not help."));
  const diag = ISOLATION.paragraph("Probe copies carry same filenames as real tree", "isolation.md diagnostics paragraph", "## Where the omp probes ran").text;
  assert.match(diag, Pin.phrase("(re-run the check that raised it — the typechecker, the linter — from there)"));
});
