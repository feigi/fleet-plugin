import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Pin } from "./support/prose-pin.mjs";

// The Recipe derivation step's prose: where it lives in run-team's phase 0,
// what reuses a cache instead of deriving, when a run re-derives and when it
// stalls, and the deriver definition that carries the proof procedure. The
// proof's own behaviour is recipe-prove.test.mjs's; this file pins that the
// runbook routes to it, and that every refusal naming "the Recipe derivation
// step" names a step that exists.
const PLUGIN = join(import.meta.dirname, "..", "plugin");
const read = (rel) => Pin.file(join(PLUGIN, rel));
const RUN_TEAM = read("skills/run-team/SKILL.md");
const PHASE0 = read("skills/run-team/references/phase-0.md");
// Phase 1's claiming paragraphs moved into references/pull.md.
const PULL_MD = read("skills/run-team/references/pull.md");
const DERIVER = read("agents/fleet-recipe-deriver.agent.md").text;
const PROVER = read("scripts/recipe-prove.mjs").text;

const phase0 = () => PHASE0.text;
// The step ends at the next rule's opener, not at a blank line: its dispatch is
// rendered by dispatch-prompt.mjs, so the step carries no quoted prompt.
const step = () => Pin.of(phase0(), "phase0()").between("**Derive the Recipe — the Recipe derivation step — before the fold-in below", "**Mid-run, a cache that stops running", "the phase-0 Recipe derivation step").text;
const stall = () => Pin.of(phase0(), "phase0()").paragraph("**Mid-run, a cache that stops running is re-derived once", "the re-derive-once and stall rule", "## Fold in every PR a prior").text;

test("phase 0 derives the Recipe before the fold-in and before the first claim", () => {
  const p0 = phase0();
  const at = p0.indexOf("**Derive the Recipe");
  assert.ok(at !== -1 && at < p0.indexOf("**Fold in every PR a prior run left open"),
    "the Recipe derivation step must come before the fold-in: folded-in PRs are reviewed, and a review reads the Test entrypoint from the cache");
  assert.match(step(), Pin.phrase("before the first claim."));
});

test("a present, valid cache is used as it stands — derivation is the controller's, once per run start", () => {
  const s = step();
  assert.match(s, Pin.phrase("Both exit 0 → the cache is present and valid: use it as it stands and derive nothing."));
  assert.match(s, Pin.phrase("one derivation per run start at most, never one per member, and a member never derives."));
  assert.match(s, Pin.phrase("agent `fleet-recipe-deriver`"));
});

test("the dispatch names the proof: a clean install, and a non-zero count or a mutation turning the run red", () => {
  const s = step();
  assert.match(s, Pin.phrase("the Install step must leave the tree clean"));
  assert.match(s, Pin.phrase("the runner's own non-zero count, or a deliberate mutation of one test that turns the run red."));
  assert.match(s, Pin.phrase("Only a proof writes the cache"));
});

test("an invalid cache is re-derived once; a failed derivation stalls the run instead of looping", () => {
  const s = stall();
  assert.match(s, Pin.phrase("dispatch `derive-recipe` again exactly as above, then retry what refused."));
  assert.match(s, Pin.phrase("A red suite never triggers it: a failing test is a finding, not a stale Recipe."));
  assert.match(s, Pin.phrase("`RECIPE NOT PROVEN` from any derivation, or a second invalid-cache refusal after this run's one re-derivation, halts the run"));
  assert.match(s, Pin.phrase("It is never a loop: no third derivation, and never a cache written by hand."));
  assert.match(s, Pin.phrase("an Install step, Test entrypoint or mutation that hangs until the proof's own bound refuses it as timed out."));
});

test("the claim paragraph sends an absent or invalid cache to the derivation step, and infers no Install step", () => {
  const p = PULL_MD.paragraph("**The Install step comes from the Recipe cache", "references/pull.md claim Install paragraph", "**Materialize the isolation envelope as a").text;
  assert.match(p, Pin.phrase("never pass or infer one."));
  assert.match(p, Pin.phrase("No cache is phase 0's Recipe derivation step not having run"));
});

// Every refusal that sends its reader to re-derive names the step by the same
// words. If phase 0 stopped carrying a step by that name, each refusal would
// point at nothing.
test("every refusal naming the Recipe derivation step names one that phase 0 carries", () => {
  const sources = {
    "derive-testcmd.sh": read("scripts/derive-testcmd.sh").text.match(/^derive="([^"]*)"/m),
    "claim-ticket.sh": read("scripts/claim-ticket.sh").text.match(/^rederive="([^"]*)"/m),
    "review-core.mjs": read("scripts/review-core.mjs").text.match(/DERIVATION_STEP =\s*"([^"]*)"/),
  };
  for (const [file, m] of Object.entries(sources)) {
    assert.ok(m, `${file}: could not find its derivation-step message — update this test`);
    assert.match(m[1], /run the Recipe derivation step \(run-team phase 0, before the first claim/, `${file} no longer names the step`);
  }
  assert.match(step(), /the Recipe derivation step/);
});

test("the deriver is told never to write the cache itself, and to prove through recipe-prove.mjs", () => {
  assert.match(DERIVER, Pin.phrase("never write `.fleet/recipe.json` yourself"));
  assert.match(DERIVER, Pin.phrase("~/.fleet/bin/fleet-run recipe-prove.mjs <repo> --install '<install>' --check '<check>' --test '<test>'"));
  assert.match(DERIVER, Pin.phrase("A count of 0 is a failed proof, never a pass."));
  assert.match(DERIVER, Pin.phrase("requires the suite to go red"));
});

// recipe-prove.mjs refuses a count line carrying any number but the claim; the
// deriver is the one choosing the literal, so it is told which number and how
// to trim to it — and that a runner whose count includes its skips has no such
// number, so its example must not be one and it goes to the mutation proof.
test("the deriver is told the count is the tests that ran, and to trim the count line to that one number", () => {
  assert.match(DERIVER, Pin.phrase("The number is the tests that ran — never the skipped, the failed, or a total that includes skips."));
  assert.match(DERIVER, Pin.phrase("A runner whose count includes its skipped tests (Maven Surefire's `Tests run:`, node's `# tests`) prints no number that is the tests that ran: prove it with the mutation proof instead."));
  assert.match(DERIVER, Pin.phrase("Trim the literal to the text around that one number, so it carries no other: `5 passed` off pytest's `5 passed, 2 skipped in 0.31s`."));
  assert.match(DERIVER, Pin.phrase("A literal carrying any other number is refused."));
  assert.match(PROVER, /as its one number/, "recipe-prove.mjs no longer refuses a count line the way the deriver is told it does");
});

// The cache reader probes an unquoted pattern from the repository root; a
// program that resolves it under its own directory option needs it quoted.
test("the deriver is told to quote a pattern a program resolves under its own directory option", () => {
  assert.match(DERIVER, Pin.phrase("Quote a pattern that a program resolves under its own directory option, e.g. `git -C web ls-files -- '*.test.ts'`: the reader accepts a quoted pattern unchecked."));
});

// The Test entrypoint covers every merge-gating CI test step this host can
// run in a fresh worktree; what it leaves out — a step no single invocation
// covers beside the rest, or one this host cannot run — is recorded with its
// reason, and is never a refusal.
test("the deriver is told the coverage rule, the widest-invocation fallback, and to record what it leaves out", () => {
  assert.match(DERIVER, Pin.phrase("**Test entrypoint** — every test step in the merge-gating CI jobs that can run in a fresh worktree without a running service."));
  assert.match(DERIVER, Pin.phrase("so it is one invocation: an `&&` chain hands those arguments to its last command alone."));
  assert.match(DERIVER, Pin.phrase("When no single invocation covers every qualifying step, take the widest one and list every qualifying step it leaves out; that is never a reason to report `RECIPE NOT PROVEN`."));
  assert.match(DERIVER, Pin.phrase("A test step or a non-test step that needs a running service is always listed too, with that reason, whether or not the service is up while you derive; so is a test step that needs another OS."));
  assert.doesNotMatch(DERIVER, /on this host|this host lacks/, "the deriver's coverage is host-relative again");
  assert.match(DERIVER, Pin.phrase("~/.fleet/bin/fleet-run recipe-prove.mjs <repo> --install '<install>' --check '<check>' --test '<test>' --uncovered '<uncovered>'"));
  assert.doesNotMatch(DERIVER, /the whole suite, the way CI runs it/);
});

test("the deriver is told what a running service is, that the Test entrypoint and Check step never need one, and to refuse when no test step qualifies", () => {
  assert.match(DERIVER, Pin.phrase("**The Test entrypoint and the Check step need no running service — including one the command starts itself.**"));
  assert.match(DERIVER, Pin.phrase("A *running service* is anything a command needs that it does not start as its own child process: a Docker daemon (so any container, compose stack or testcontainers use), a database or other server installed on the host, a host daemon, secrets or credentials in the environment."));
  assert.match(DERIVER, Pin.phrase("Whether that service happens to be up while you derive never changes the answer."));
  assert.match(DERIVER, Pin.phrase("every merge-gating CI step that is not a test step, that the Test entrypoint does not run, and that needs no running service"));
  assert.match(DERIVER, Pin.phrase("When no merge-gating test step runs without a running service, there is nothing to prove: report `RECIPE NOT PROVEN` with the cause **needs a running service**, never an entrypoint that needs one. That is not the case above of no single invocation covering every qualifying step."));
  assert.match(DERIVER, Pin.phrase("**needs a running service** (every merge-gating test step needs one)"));
  assert.match(DERIVER, Pin.phrase("With **needs a running service** no run happened: give each merge-gating test step and the service it needs in place of the reason and the commands."));
});

// The accept side: what the running-service rule must NOT refuse.
test("the deriver's running-service rule admits a test's own child server, network access and the Install step", () => {
  assert.match(DERIVER, Pin.phrase("A test that spawns its own server process as a child needs none."));
  assert.match(DERIVER, Pin.phrase("Network reachability is not a service: the fleet machine is assumed online."));
  assert.match(DERIVER, Pin.phrase("The Install step is exempt."));
});

test("every flag the deriver's procedure passes is one recipe-prove.mjs accepts", () => {
  // The invocations are the indented command blocks naming recipe-prove.mjs;
  // flags elsewhere in the definition (its `git` reads) are not the proof's.
  const blocks = DERIVER.split(/\n[ \t]*\n/).filter((b) => /^ {4,}/.test(b) && b.includes("recipe-prove.mjs"));
  assert.equal(blocks.length, 4, "expected the observe, count-proof, mutation-proof and Check-proof invocations — update this test");
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
  assert.match(DERIVER, Pin.phrase("the Install step, the Check step, the Test entrypoint or a mutation — hung until the script's own bound stopped it"));
});

// recipe-prove.mjs bounds its own commands and refuses one that overruns; an
// outside kill would end the run with no refusal for the deriver to report.
test("the deriver is told the script bounds its own commands, and never to wrap the call in a timeout", () => {
  assert.match(DERIVER, Pin.phrase("The script bounds each command it runs itself"));
  assert.match(DERIVER, Pin.phrase("**Never wrap the `recipe-prove.mjs` call in a timeout of your own**"));
  assert.match(DERIVER, Pin.phrase("refuses one still running at that bound as `timed out`"));
  assert.match(DERIVER, Pin.phrase("so give that call `timeout: 0` and wait for the script"));
  assert.match(PROVER, /timed out: still running after/, "recipe-prove.mjs no longer names a timeout the way the deriver's cause reads it");
});
