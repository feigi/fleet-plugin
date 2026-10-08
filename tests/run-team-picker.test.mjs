// #1381. omp's `/` picker folds every skill into one `skill:` row unless the
// skill's bare name matches the typed prefix at a STRICTLY higher tier than
// every non-skill command name does — a tie keeps the popup command-only.
// `disable-model-invocation` plays no part in it. So a shipped command whose
// name shares a prefix with `run-team` hides `skill:run-team` at that prefix:
// the `run-team-…` help command the plugin used to ship did, from `/run-t`
// through `/run-tea`.
//
// The rule below is a copy of pi-tui's `collapseSkillNamespace`,
// `commandBreakoutTier` and `skillBareNameBreakoutTier`
// (`src/autocomplete.ts`, read on omp 18.8.5). The predicate cases are the
// rows the issue measured with omp's own `CombinedAutocompleteProvider`, so a
// drift between this copy and the measured behaviour fails here first.
// `run-team-x` stands in for the deleted help command: every measured prefix
// relates to the two names alike (neither equals it, both start with it or
// neither does).
//
// THE CEILING: only this plugin's own commands are checked. omp's built-in
// commands, and any other plugin's, sit in the same tier comparison and are
// out of this repo's reach.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const COMMANDS = join(import.meta.dirname, "..", "plugin", "commands");

// The prefixes README.md's Quickstart sends a user to type: `/team`, and
// `/run-t` onward. `/skill:run` bypasses the fold entirely.
const DOCUMENTED_PREFIXES = ["team", "run-t", "run-te", "run-tea", "run-team"];

function commandTier(prefix, name) {
  if (prefix === name) return 1000;
  if (name.startsWith(prefix)) return 900;
  return 0;
}

function skillTier(prefix, bare) {
  if (prefix.length === 0) return 0;
  if (prefix === bare) return 1000;
  if (bare.startsWith(prefix)) return 900;
  let start = 0;
  while (start < bare.length) {
    while (start < bare.length && bare[start] !== "-") start += 1;
    start += 1;
    if (start >= bare.length) break;
    if (bare.startsWith(prefix, start)) {
      let end = start;
      while (end < bare.length && bare[end] !== "-") end += 1;
      return prefix.length === end - start ? 1000 : 900;
    }
  }
  return 0;
}

function skillShown(prefix, bare, commandNames) {
  const best = Math.max(0, ...commandNames.map((n) => commandTier(prefix, n)));
  return skillTier(prefix, bare) > best;
}

const shippedCommands = () =>
  readdirSync(COMMANDS)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -".md".length));

test("the tie rule reproduces the measured picker rows", () => {
  const before = ["review-and-fix", "run-merge-bot", "run-team-x"];
  const after = ["review-and-fix", "run-merge-bot"];
  for (const p of ["run", "run-", "run-t", "run-tea"]) {
    assert.equal(skillShown(p, "run-team", before), false, `/${p} with the help command`);
  }
  for (const p of ["run-team", "team"]) {
    assert.equal(skillShown(p, "run-team", before), true, `/${p} with the help command`);
  }
  for (const p of ["run", "run-"]) {
    assert.equal(skillShown(p, "run-team", after), false, `/${p} without the help command`);
  }
  for (const p of ["run-t", "run-tea", "run-team", "team"]) {
    assert.equal(skillShown(p, "run-team", after), true, `/${p} without the help command`);
  }
});

test("the tie rule accepts a command that only shares a shorter prefix", () => {
  // `teamwork` beats the skill at `/tea` but loses to the exact hyphen-segment
  // match at `/team`; only a command named `team` itself ties there.
  assert.equal(skillShown("team", "run-team", ["teamwork"]), true);
  assert.equal(skillShown("team", "run-team", ["team"]), false);
  assert.equal(skillShown("run-t", "run-team", ["run-merge-bot", "review-and-fix"]), true);
});

test("no shipped command hides skill:run-team at a prefix README.md documents", () => {
  const names = shippedCommands();
  assert.ok(names.includes("run-merge-bot"), `plugin/commands/ listing looks wrong: ${names}`);
  const hidden = DOCUMENTED_PREFIXES.filter((p) => !skillShown(p, "run-team", names));
  assert.deepEqual(hidden, [], `skill:run-team is hidden at /${hidden.join(", /")} by ${names}`);
});
