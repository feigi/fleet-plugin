import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { END, between, bullet, paragraph, phrase } from "./support/prose-pin.mjs";

// The prose that describes the consumer repo as "whatever the Recipe says"
// rather than as a Node project: every shipped runbook and the requirement
// docs name the Recipe's Install step and Test entrypoint, and none of them
// names a Node package manager, a lockfile or a Node-only tool as the way a
// consumer is installed or tested. Each pin below holds ONE contiguous clause
// of that vocabulary inside the bounded slice that carries it.
const PLUGIN = join(import.meta.dirname, "..", "plugin");
const ROOT = join(PLUGIN, "..");
const readPlugin = (rel) => readFileSync(join(PLUGIN, rel), "utf8");
const readRoot = (rel) => readFileSync(join(ROOT, rel), "utf8");
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
  const step = bullet(PULL_AND_CLAIM, "4. **Claim.**", "5. **Dispatch**", "pull-and-claim.md step 4");
  assert.match(step, phrase("runs the [Recipe](recipe.md)'s Install step there — read from the Recipe cache, refusing if it changed the tree"));
});

test("requirements 2.3 describes the Recipe derivation: any technology, what it reads, what proves it, what it caches", () => {
  const section = between(REQUIREMENTS, "### 2.3 Installable and testable — HARD", "### 2.4", "requirements.md section 2.3");
  assert.match(section, phrase("Any technology. Fleet derives your repo's Recipe (Install step + Test entrypoint) by agent reasoning"));
  const reads = bullet(section, "- **What the derivation reads:**", "- **What the proof requires:**", "requirements.md 2.3 derivation bullet");
  assert.match(reads, phrase("nothing checks for a particular manifest or lockfile."));
  const proof = bullet(section, "- **What the proof requires:**", "- **The cache:**", "requirements.md 2.3 proof bullet");
  assert.match(proof, phrase("`RECIPE NOT PROVEN` writes no cache and halts the run."));
  const cache = bullet(section, "- **The cache:**", "Hard rules for any technology:", "requirements.md 2.3 cache bullet");
  assert.match(cache, phrase("Every claim reads both commands from it and every review its Test entrypoint; a missing or unproven cache is a refusal naming the derivation step, never a guess."));
  assert.match(section, phrase("~/.fleet/bin/fleet-run derive-testcmd.sh . install && ~/.fleet/bin/fleet-run derive-testcmd.sh . test"));
});

test("requirements 1.1 adds whatever the Recipe runs to the tool floor", () => {
  assert.match(
    between(REQUIREMENTS, "| `shasum` | any |", "### 1.2", "requirements.md section 1.1 table tail"),
    phrase("Plus whatever your Recipe runs (§2.3): `mvn`, `go`, `cargo`, …"),
  );
});

test("the research note marks the Node-only consumer rows superseded by the Recipe ruling", () => {
  const row = bullet(EXTERNAL, "- ~~Contains `package.json`", "\n- `node` on PATH", "external-assumptions.md consumer-repo row");
  assert.match(row, phrase("Superseded by ADR 0015: the claim reads the Install step and Test entrypoint from the Recipe cache, and nothing checks for a manifest, a test-file name or a lockfile."));
  const implied = bullet(EXTERNAL, "- Consumer must be a Node project", "\n- `python3` and `shasum` on PATH", "external-assumptions.md implied-only row");
  assert.match(implied, phrase("Ruled 2026-09-28: ADR 0015 — any technology, Recipe by agent reasoning"));
});

test("review-and-fix step 3 reads the standalone testCmd off the Recipe cache and derives when there is none", () => {
  const step = bullet(REVIEW_AND_FIX, "3. **Run `testCmd` before you commit**", "\n4. **", "review-and-fix.md step 3");
  assert.match(step, phrase("the Test entrypoint in the repo's Recipe cache (`derive-testcmd.sh <repo> test` prints it)"));
  assert.match(step, phrase("run the Recipe derivation step first"));
  assert.doesNotMatch(step, /node --test/, "step 3 names this repository's own test command again");
});

test("review-and-fix's git archive bullet runs the Install step in the copy, read from a tree that holds the cache", () => {
  const archive = bullet(REVIEW_AND_FIX, "- **`git archive` carries tracked files only.**", "\n- **Initialize the copy", "review-and-fix.md git archive bullet");
  assert.match(archive, phrase("run the Install step in the copy (read it off the worktree or main checkout, `derive-testcmd.sh <worktree or main checkout> install`; pointed at the copy it refuses, since a copy holds no Recipe cache)"));
});

test("run-team: a tree with no runner gets the Recipe's Test entrypoint only when it brings up no shared stack", () => {
  const p = paragraph(RUN_TEAM, "**A reused worktree may lack the runner.**", "run-team/SKILL.md reused-worktree runner paragraph", "**A reused worktree may also be");
  assert.match(p, phrase("the Recipe's Test entrypoint (`~/.fleet/bin/fleet-run derive-testcmd.sh <main checkout> test --at origin/main` prints it) only when it brings up no shared stack to collide on, else that repo's own stack-free command."));
});

test("run-team: testCmd comes from the Recipe cache and names no repository's own command", () => {
  const p = paragraph(RUN_TEAM, "**Where `testCmd` comes from:**", "run-team/SKILL.md testCmd source paragraph", "**Where `<branch>` comes from:** the PR's");
  assert.match(p, phrase("the repository's Test entrypoint, out of the Recipe cache phase 0's Recipe derivation step proved — `~/.fleet/bin/fleet-run derive-testcmd.sh . test --at origin/main` prints it — and the one you hand specialists"));
  assert.doesNotMatch(p, /node --test/, "the testCmd source paragraph names this repository's own test command again");
});

test("run-team: the quick-install red flag points at the Recipe's Install step, not at an install command", () => {
  const flag = bullet(RUN_TEAM, "- \"A quick install to set up the worktree\"", "- \"I'm on my own copy, so I'm isolated\"", "run-team/SKILL.md quick-install red flag");
  assert.match(flag, phrase("the claim already ran the Recipe's Install step; any other install can rewrite the lockfile for the whole repo."));
});

test("a merged branch's stale worktree is said to keep its installed dependencies, in SKILL.md and in reaping.md", () => {
  const skill = paragraph(RUN_TEAM, "The merge bot deletes the remote branch after each merge", "run-team/SKILL.md reap paragraph", "`~/.fleet/bin/fleet-run reap.sh --apply` recomputes every precondition");
  assert.match(skill, phrase("with its worktree — and its installed dependencies — still on disk."));
  const evidence = paragraph(REAPING, "Merge deletes remote branch, leaves local branch", "reaping.md reap-after-each-merge paragraph", "## Why `commit-commands:clean_gone` is disqualified");
  assert.match(evidence, phrase("with worktree — and its installed dependencies — still on disk."));
});

test("the isolation reference says symlinking installed dependencies in does not isolate the stack, and reproduces a diagnostic by re-running the check", () => {
  const stack = paragraph(ISOLATION, "Private copy and test command solve different problems", "isolation.md stack-isolation paragraph", "## Scratchpad paths need two levels");
  assert.match(stack, phrase("Symlinking installed dependencies in does not help."));
  const diag = paragraph(ISOLATION, "Probe copies carry same filenames as real tree", "isolation.md diagnostics paragraph", END);
  assert.match(diag, phrase("(re-run the check that raised it — the typechecker, the linter — from there)"));
});
