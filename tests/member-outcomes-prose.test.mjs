import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Pin } from "./support/prose-pin.mjs";

const REPO = join(import.meta.dirname, "..", "plugin");
const CLOSE_OUT = Pin.file(join(REPO, "skills", "run-team", "references", "close-out.md"));
const RUN_TEAM = Pin.file(join(REPO, "skills", "run-team", "SKILL.md"));

// Slice by named anchors and fail loudly when one moves; slice SIZE is what does
// the work. The scrape and its check are one section of the close-out reference
// file, so the slice ends at the next heading rather than on a later duty's
// prose it never touches.
const SLICE = () => CLOSE_OUT.section("## Scrape the member facts and check the tier rows", "member-outcomes scrape section").text;

// The paragraph where the controller still rules each PR's review: it stays in
// the skill file, and its end anchor is the subsection that follows it in the
// wake section.
const RULING = () => RUN_TEAM.between("**Guard: accumulate per PR", "### Nothing to do: arm the beat", "tier-outcomes ruling paragraph").text;

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
  /"\$HOME\/\.omp\/agent\/sessions\/\$PROJECT_DIR"/,
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
  // The newest session for this cwd is not "this run" — any other session
  // sharing this cwd can hold a newer transcript at the moment this step
  // runs, so the wrong-session pick is routine, silent, and exits 0. Narrowed
  // to the one session the phase-0 receipt or PI_ARTIFACTS_DIR names, the
  // scrape is still one session where the step owes every one.
  const slice = SLICE();
  assert.match(slice, /for d in .*\*\/;/, "the scrape must loop every session dir");
  // Banned from the COMMAND, not from the prose — the paragraph that explains
  // why one session is wrong has to be able to name the ways of picking it.
  const block = /```bash\n([\s\S]*?)```/.exec(slice)[1];
  assert.doesNotMatch(block, /PI_ARTIFACTS_DIR|phase0\.json/, "a single session is the defect, not the fix");
});

test("the ruling step does NOT ask the controller to hand-write member rows", () => {
  // The whole invariant: member-outcomes.tsv is derived. An instruction to
  // author a row there would make it un-regenerable. Two places carry the
  // controller's side of it: the scrape section in the close-out reference
  // and the ruling paragraph that stays in the skill file.
  assert.doesNotMatch(SLICE(), /append .{0,40}member-outcomes/i);
  assert.doesNotMatch(RULING(), /append .{0,40}member-outcomes/i);
});
