import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase, markedLine } from "./prose-pin.mjs";

// ADR 0011: on omp the declared alias routes through a role, and the
// finisher/merge bot dispatch by their own definitions rather than a
// per-call `model: "haiku"`. Three CLAUDE:/OMP: marked pairs were introduced
// for this — review-dialect-pins.test.mjs's own finding on #1361 is that a
// same-rule (or does-not-apply) pair is not actually pinned unless something
// asserts it differs from its partner ONLY in dialect tokens (CONTEXT.md §
// Dialect's "Pair"), so each pair below gets its own `doesNotMatch` for the
// other harness's token.
const REPO = join(import.meta.dirname, "..");
const RUN_TEAM = readFileSync(join(REPO, "skills", "run-team", "SKILL.md"), "utf8");

test("SKILL.md's phase-2 routing pair: CLAUDE says the precheck does not apply, OMP names the runnable tier-roles.mjs --check", () => {
  const region = between(
    RUN_TEAM,
    "**On omp the alias is the fleet's tier name",
    "**Every 5th Pull by ledger count",
    "run-team phase-2 routing-precheck pair",
  );
  const claude = markedLine(region, "CLAUDE", "run-team phase-2 routing CLAUDE line");
  const omp = markedLine(region, "OMP", "run-team phase-2 routing OMP line");

  assert.match(claude, /does not apply/);
  assert.match(claude, phrase("`Agent`"));
  assert.doesNotMatch(claude, /tier-roles|task\.agentModelOverrides/, "the CLAUDE line must not also carry omp's routing vocabulary");

  assert.match(omp, /~\/\.fleet\/bin\/fleet-run tier-roles\.mjs --check/);
  assert.match(omp, /task\.agentModelOverrides/);
  assert.match(omp, /\*\*stops the run\*\*/);
  assert.doesNotMatch(omp, /does not apply|has no slot for/, "the OMP line must not also carry a does-not-apply idiom — the rule DOES apply on omp");
});

test("SKILL.md's finisher name pair: CLAUDE namespaces `fleet-ctl:fleet-finisher`, OMP stays bare, both route by definition not per-call model", () => {
  const region = between(
    RUN_TEAM,
    "**finisher** — a fresh small agent, not the fix-applier resumed.",
    "Its four duties are a checklist",
    "run-team finisher name pair",
  );
  const claude = markedLine(region, "CLAUDE", "run-team finisher CLAUDE line");
  const omp = markedLine(region, "OMP", "run-team finisher OMP line");

  assert.match(claude, /^CLAUDE: `fleet-ctl:fleet-finisher`\./);
  assert.match(omp, /^OMP: `fleet-finisher`\./);
  assert.doesNotMatch(omp, /fleet-ctl:/, "the OMP line must not also carry Claude's fleet-ctl: namespace");

  assert.match(region, /omit `model` on the call/);
  assert.match(region, /agents\/fleet-finisher\.agent\.md/);
});

test("SKILL.md's merge-bot name pair: CLAUDE namespaces `fleet-ctl:fleet-merge-bot`, OMP stays bare, both route by definition not per-call model", () => {
  const region = between(
    RUN_TEAM,
    "### Merge bot",
    "**Put the shell traps in the bot's brief",
    "run-team merge-bot name pair",
  );
  const claude = markedLine(region, "CLAUDE", "run-team merge-bot CLAUDE line");
  const omp = markedLine(region, "OMP", "run-team merge-bot OMP line");

  assert.match(claude, /^CLAUDE: `fleet-ctl:fleet-merge-bot`\./);
  assert.match(omp, /^OMP: `fleet-merge-bot`\./);
  assert.doesNotMatch(omp, /fleet-ctl:/, "the OMP line must not also carry Claude's fleet-ctl: namespace");

  assert.match(region, /omit `model` on the call/);
  assert.match(region, /agents\/fleet-merge-bot\.agent\.md/);
});

// Any spelling of the per-call arg, not only the double-quoted one: a
// single-quoted, backticked, or quoted-key (`"model": "haiku"`) override is
// the same dropped argument.
test("SKILL.md carries no per-call model: \"haiku\" override anywhere — the finisher and merge bot route by their own definitions", () => {
  assert.doesNotMatch(RUN_TEAM, /model["'`]?\s*:\s*["'`]haiku["'`]/i);
});

// The definitions the two pairs above point at, plus the omp review runner
// (#1802, spec 2026-09-24 § 3 §1: `model: haiku`, `effort: low`,
// `thinking-level: low`, no `tools:`). Same five-key/no-tools shape
// implementer-model-tier.test.mjs pins for the two implementer definitions —
// a `tools:` list would drop a tool the member cannot work without (`Agent`
// for the finisher and merge bot, `eval` for the runner, whose whole job is
// one eval cell), and #1298's ruling fixes the same five required keys for
// every fleet agent file.
const frontmatterOf = (name) =>
  readFileSync(join(REPO, "agents", `${name}.agent.md`), "utf8").split("---")[1] ?? "";

test("fleet-finisher, fleet-merge-bot and fleet-review-runner declare haiku/low/low, all five required keys, and no tools:", () => {
  for (const name of ["fleet-finisher", "fleet-merge-bot", "fleet-review-runner"]) {
    const fm = frontmatterOf(name);
    assert.match(fm, /^model:\s*haiku$/m, `${name}.agent.md does not declare model: haiku`);
    assert.match(fm, /^effort:\s*low$/m, `${name}.agent.md does not declare effort: low`);
    assert.match(fm, /^thinking-level:\s*low$/m, `${name}.agent.md does not declare thinking-level: low`);
    for (const key of ["name", "description", "model", "effort", "thinking-level"]) {
      assert.match(fm, new RegExp(`^${key}:\\s*\\S`, "m"), `${name}.agent.md declares no ${key}`);
    }
    assert.doesNotMatch(fm, /^tools:/m, `${name}.agent.md lists tools — a list would drop a tool the member needs`);
  }
});
