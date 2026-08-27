import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..", "..", "..");
const RUN_TEAM = readFileSync(join(REPO, "skills", "fleet", "skills", "run-team", "SKILL.md"), "utf8");

// Slice by named anchors and fail loudly when one moves; slice SIZE is what does
// the work. The end anchor is the paragraph immediately after the insertion
// point (not the next "## " heading, which is 174 lines away and would satisfy
// this pin on prose it never touches).
function section(start, end) {
  const a = RUN_TEAM.indexOf(start);
  assert.notEqual(a, -1, `anchor moved: ${start}`);
  const b = RUN_TEAM.indexOf(end, a + start.length);
  assert.notEqual(b, -1, `anchor moved: ${end}`);
  return RUN_TEAM.slice(a, b);
}

test("the ruling step runs the scraper and says the run is what scopes it", () => {
  const slice = section("Append one row", "**Why not decide inside one run.**");
  assert.match(slice, /member-outcomes\.mjs/);
  assert.match(slice, /session director(y|ies)/i);
});

test("the ruling step does NOT ask the controller to hand-write member rows", () => {
  // The whole invariant: member-outcomes.tsv is derived. An instruction to
  // author a row there would make it un-regenerable.
  const slice = section("Append one row", "**Why not decide inside one run.**");
  assert.doesNotMatch(slice, /append .{0,40}member-outcomes/i);
});
