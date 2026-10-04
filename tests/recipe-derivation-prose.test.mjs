import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, paragraph, phrase } from "./support/prose-pin.mjs";

// The Recipe derivation step's prose: where it lives in run-team's phase 0,
// what reuses a cache instead of deriving, when a run re-derives and when it
// stalls, and the deriver definition that carries the proof procedure. The
// proof's own behaviour is recipe-prove.test.mjs's; this file pins that the
// runbook routes to it, and that every refusal naming "the Recipe derivation
// step" names a step that exists.
const PLUGIN = join(import.meta.dirname, "..", "plugin");
const read = (rel) => readFileSync(join(PLUGIN, rel), "utf8");
const RUN_TEAM = read("skills/run-team/SKILL.md");
const DERIVER = read("agents/fleet-recipe-deriver.agent.md");
const PROVER = read("scripts/recipe-prove.mjs");

const phase0 = () => between(RUN_TEAM, "## Phase 0 — shortlist", "## Phase 1 — Pull", "run-team/SKILL.md phase 0");
// The step spans its quoted dispatch prompt, so it is bounded by the next
// rule's opener rather than by a blank line.
const step = () => between(phase0(), "**Derive the Recipe — the Recipe derivation step — before the fold-in below", "**Mid-run, a cache that stops running", "the phase-0 Recipe derivation step");
const stall = () => paragraph(phase0(), "**Mid-run, a cache that stops running is re-derived once", "the re-derive-once and stall rule", "**Fold in every PR a prior");

test("phase 0 derives the Recipe before the fold-in and before the first claim", () => {
  const p0 = phase0();
  const at = p0.indexOf("**Derive the Recipe");
  assert.ok(at !== -1 && at < p0.indexOf("**Fold in every PR a prior run left open"),
    "the Recipe derivation step must come before the fold-in: folded-in PRs are reviewed, and a review reads the Test entrypoint from the cache");
  assert.match(step(), phrase("before the first claim."));
});

test("a present, valid cache is used as it stands — derivation is the controller's, once per run start", () => {
  const s = step();
  assert.match(s, phrase("Both exit 0 → the cache is present and valid: use it as it stands and derive nothing."));
  assert.match(s, phrase("one derivation per run start at most, never one per member, and a member never derives."));
  assert.match(s, phrase("agent `fleet-recipe-deriver`"));
});

test("the dispatch names the proof: a clean install, and a non-zero count or a mutation turning the run red", () => {
  const s = step();
  assert.match(s, phrase("the Install step must leave the tree clean"));
  assert.match(s, phrase("the runner's own non-zero count, or a deliberate mutation of one test that turns the run red."));
  assert.match(s, phrase("Only a proof writes the cache"));
});

test("an invalid cache is re-derived once; a failed derivation stalls the run instead of looping", () => {
  const s = stall();
  assert.match(s, phrase("dispatch `derive-recipe` again exactly as above, then retry what refused."));
  assert.match(s, phrase("A red suite never triggers it: a failing test is a finding, not a stale Recipe."));
  assert.match(s, phrase("`RECIPE NOT PROVEN` from any derivation, or a second invalid-cache refusal after this run's one re-derivation, halts the run"));
  assert.match(s, phrase("It is never a loop: no third derivation, and never a cache written by hand."));
  assert.match(s, phrase("an Install step, Test entrypoint or mutation that hangs until the proof's own bound refuses it as timed out."));
});

test("the claim paragraph sends an absent or invalid cache to the derivation step, and infers no Install step", () => {
  const p = paragraph(RUN_TEAM, "**The Install step comes from the Recipe cache", "run-team/SKILL.md claim Install paragraph", "**Materialize the isolation envelope as a");
  assert.match(p, phrase("never pass or infer one."));
  assert.match(p, phrase("No cache is phase 0's Recipe derivation step not having run"));
});

// Every refusal that sends its reader to re-derive names the step by the same
// words. If phase 0 stopped carrying a step by that name, each refusal would
// point at nothing.
test("every refusal naming the Recipe derivation step names one that phase 0 carries", () => {
  const sources = {
    "derive-testcmd.sh": read("scripts/derive-testcmd.sh").match(/^derive="([^"]*)"/m),
    "claim-ticket.sh": read("scripts/claim-ticket.sh").match(/^rederive="([^"]*)"/m),
    "review-core.mjs": read("scripts/review-core.mjs").match(/DERIVATION_STEP =\s*"([^"]*)"/),
  };
  for (const [file, m] of Object.entries(sources)) {
    assert.ok(m, `${file}: could not find its derivation-step message — update this test`);
    assert.match(m[1], /run the Recipe derivation step \(run-team phase 0, before the first claim/, `${file} no longer names the step`);
  }
  assert.match(step(), /the Recipe derivation step/);
});

test("the deriver is told never to write the cache itself, and to prove through recipe-prove.mjs", () => {
  assert.match(DERIVER, phrase("never write `.fleet/recipe.json` yourself"));
  assert.match(DERIVER, phrase("~/.fleet/bin/fleet-run recipe-prove.mjs <repo> --install '<install>' --test '<test>'"));
  assert.match(DERIVER, phrase("A count of 0 is a failed proof, never a pass."));
  assert.match(DERIVER, phrase("requires the suite to go red"));
});

test("every flag the deriver's procedure passes is one recipe-prove.mjs accepts", () => {
  // The invocations are the indented command blocks naming recipe-prove.mjs;
  // flags elsewhere in the definition (its `git` reads) are not the proof's.
  const blocks = DERIVER.split(/\n[ \t]*\n/).filter((b) => /^ {4,}/.test(b) && b.includes("recipe-prove.mjs"));
  assert.equal(blocks.length, 3, "expected the observe, count-proof and mutation-proof invocations — update this test");
  const used = new Set(blocks.join("\n").match(/--[a-z][a-z-]+/g));
  const accepted = new Set(PROVER.match(/new Set\(\[([^\]]*)\]\)/)[1].match(/--[a-z-]+/g));
  assert.ok(used.size >= 6, `found only ${[...used].join(", ")} in the deriver — the procedure lost its proof flags`);
  for (const flag of used) assert.ok(accepted.has(flag), `the deriver passes ${flag}, which recipe-prove.mjs does not accept`);
});

test("the deriver reports one of two lines, naming vacuity and a timeout as causes", () => {
  assert.match(DERIVER, /`RECIPE PROVEN` followed by the JSON line/);
  assert.match(DERIVER, /`RECIPE NOT PROVEN` followed by the last run's `NOT PROVEN` reason/);
  assert.match(DERIVER, /\*\*vacuous\*\*/);
  assert.match(DERIVER, /\*\*timed out\*\*/);
  assert.match(DERIVER, phrase("the Install step, the Test entrypoint or the mutation — hung until the script's own bound stopped it"));
});

// recipe-prove.mjs bounds its own commands and refuses one that overruns; an
// outside kill would end the run with no refusal for the deriver to report.
test("the deriver is told the script bounds its own commands, and never to wrap the call in a timeout", () => {
  assert.match(DERIVER, phrase("The script bounds each command it runs itself"));
  assert.match(DERIVER, phrase("**Never wrap the `recipe-prove.mjs` call in a timeout of your own**"));
  assert.match(DERIVER, phrase("refuses one still running at that bound as `timed out`"));
  assert.match(DERIVER, phrase("so give that call `timeout: 0` and wait for the script"));
  assert.match(PROVER, /timed out: still running after/, "recipe-prove.mjs no longer names a timeout the way the deriver's cause reads it");
});
