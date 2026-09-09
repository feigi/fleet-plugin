import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..");
const RUN_TEAM = readFileSync(join(REPO, "skills", "run-team", "SKILL.md"), "utf8");

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

const SLICE = () => section("Append one row", "**Why not decide inside one run.**");

// Everything the instruction needs in order to RUN. Matching only the filename
// was mutation-proven vacuous: the pin stayed green both when the command was
// corrupted (wrong script path, unquoted variable) and when the entire fenced
// block was deleted and replaced with the prose "the controller should remember
// to run member-outcomes.mjs somehow". That is the exact defect class that
// already shipped once here — a phase-3 instruction whose `$SESSION_DIR` was
// defined nowhere, guarded by a pin that only grepped for the filename.
const RUNNABLE = [
  // the fenced block itself, not prose describing one
  /```bash\n[\s\S]*?```/,
  // the derivation, from the helper rather than a hand-guessed path
  /encodeProjectDir/,
  // the invocation, at the path it actually lives at
  /node scripts\/member-outcomes\.mjs/,
  // every shell expansion quoted — an unquoted one splits on the spaces in a
  // stringified error object and turns exit 2 into a usage error
  /"\$HOME\/\.claude\/projects\/\$PROJECT_DIR"/,
];

test("the ruling step carries a RUNNABLE scraper invocation, not a mention of one", () => {
  const slice = SLICE();
  for (const re of RUNNABLE) assert.match(slice, re);
  // Every variable the block uses must be assigned inside the same block.
  const block = /```bash\n([\s\S]*?)```/.exec(slice)[1];
  for (const [, name] of block.matchAll(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g)) {
    if (name === "HOME") continue; // supplied by the shell
    assert.match(block, new RegExp(`^${name}=`, "m"), `${name} is used but never assigned`);
  }
});

test("the ruling step scrapes EVERY session for the cwd, not one guessed session", () => {
  // findSubagentsDir answers "newest transcript for this cwd", which is not
  // "this run". 86 sessions share ~/.claude and 17 of 21 active days had two or
  // more writing, so the wrong-session pick is routine, silent, and exits 0.
  const slice = SLICE();
  assert.match(slice, /for d in .*\/\*\/subagents/, "the scrape must loop every session dir");
  // Banned from the COMMAND, not from the prose — the paragraph that explains
  // why the single-session helper is wrong has to be able to name it.
  const block = /```bash\n([\s\S]*?)```/.exec(slice)[1];
  assert.doesNotMatch(block, /findSubagentsDir/, "the single-session helper is the defect, not the fix");
});

test("the ruling step does NOT ask the controller to hand-write member rows", () => {
  // The whole invariant: member-outcomes.tsv is derived. An instruction to
  // author a row there would make it un-regenerable.
  assert.doesNotMatch(SLICE(), /append .{0,40}member-outcomes/i);
});
