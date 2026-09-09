// The finisher's member name is a convention two documents state and one
// module reads. Nothing pinned it: adding it to run-team's naming list moved no
// test, which is why the convention could be read by `classifyRole` while being
// written down nowhere (#326).
//
// The fix-applier's own presence in the same paragraph is pinned separately, in
// review-path-default.test.mjs by "the member-naming rule still names the
// fix-applier". These are not duplicates: that one guards one name against
// deletion, these guard the list against disagreeing with the module that
// reads it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyRole } from "./compute-spend.mjs";
import { between } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..");
const read = (...p) => readFileSync(join(REPO, ...p), "utf8");

// Every slice is flattened before matching, so a rewrap of the same words is a
// no-op. A pin that reds on a reflow discriminates nothing — it only teaches the
// next editor to work around it.
const flat = (s) => s.replace(/\s+/g, " ");

// Read RAW, not flattened: the slice below ends at the blank line that closes
// the paragraph, and flattening collapses it away. Flattening happens after.
const SKILL = read("skills", "run-team", "SKILL.md");
const LIFECYCLE = read("skills", "run-team", "references", "member-lifecycle.md");
const SPEND = flat(read("scripts", "compute-spend.mjs"));

const MEMBER_NAMES = ["impl-<issue#>", "fix-pr-<pr#>", "review-pr-<pr#>", "finisher-pr-<pr#>", "merge-bot-<wave#>"];

// Sliced to the naming PARAGRAPH, never file-wide: run-team mentions the
// finisher in its narrative dozens of times, and any of those hits would
// satisfy a file-wide match, leaving this list free to lose the name with the
// pin green. The paragraph, not the sentence: ending the slice at the first "."
// truncates on any inner period — an abbreviation, or the
// references/member-lifecycle.md pointer this very paragraph already carries —
// which reds the pin and reports every name as removed while none was. A blank
// line outlives a rewrap the way a sentence boundary does not. `between` is the
// shared two-ended slicer the rest of this directory already uses, and it
// carries the "update this test" guard for either anchor moving.
const namingSentence = (doc, label) => flat(between(doc, "Names follow", "\n\n", label));

test("both member-naming lists name every member, the finisher included", () => {
  // Both, not just the runbook's: SKILL.md's list ends by pointing at
  // references/member-lifecycle.md, which carries the same list, so a reader who
  // follows the pointer must not land on one that omits the finisher.
  //
  // Compared as a SET. List order carries no instruction, and a pin that fires
  // on a reorder is one the next editor learns to work around. Every missing
  // name is collected and reported at once — asserting inside the loop would let
  // the first miss mask the rest, and the count of failures would read as the
  // count of defects.
  for (const [label, doc] of [["run-team/SKILL.md", SKILL], ["references/member-lifecycle.md", LIFECYCLE]]) {
    const sentence = namingSentence(doc, label);
    const missing = MEMBER_NAMES.filter((n) => !sentence.includes(`\`${n}\``));
    assert.deepEqual(
      missing,
      [],
      `${label}'s member-naming list no longer names ${missing.join(", ")} — a controller reading it names that member something else, and a misnamed member loses the Agent tool with no error`,
    );
  }
});

test("every name compute-spend calls stable-because-run-team-fixes-it is one run-team fixes", () => {
  // The comment's claim is about run-team, so it is only true while run-team's
  // own list carries every name the comment cites. Derived from the comment
  // rather than restated: a name added to the comment alone — the exact half-fix
  // #326 was deferred to avoid — reds here, and a restated list would not.
  const m = /run-team fixes them \(([^)]*)\)/.exec(SPEND);
  assert.ok(m, "compute-spend.mjs's 'run-team fixes them' comment moved — re-anchor this pin");
  const cited = [...m[1].matchAll(/`([a-z-]+)-<n>`/g)].map((x) => x[1]);
  assert.ok(cited.length > 0, `no member names parsed out of the comment's list: ${m[1]}`);
  assert.ok(cited.includes("finisher-pr"), "the finisher is missing from the list the comment claims run-team fixes");
  // The naming list, not the whole file — which is what the comment above says
  // this checks. A name cited here reaches SKILL.md's narrative without ever
  // being added to the list, and a file-wide haystack scores that as a hit.
  const list = namingSentence(SKILL, "run-team/SKILL.md");
  for (const role of cited) {
    assert.match(
      list,
      new RegExp("`" + role + "-<(?:issue|pr|wave)#>`"),
      `compute-spend.mjs claims run-team fixes \`${role}-<n>\`, but run-team's naming list never mentions it`,
    );
  }
});

test("classifyRole still accepts every finisher spelling the record contains", () => {
  // The other half. Documenting one canonical name must not narrow what the
  // classifier accepts: all five of these were really dispatched and are in
  // docs/metrics/member-outcomes.tsv, and a member that stops classifying as a
  // finisher books as "other" and moves the spend headline for a run already
  // recorded. The descriptions deliberately carry no finisher word — the
  // agentType has to carry the match, or this passes for the wrong reason. The
  // last is a retry suffix: the same member's second attempt, not a different
  // name, and the record carries it under that exact agentType. It is the only
  // one of the five that reds when the match is anchored to a trailing number.
  for (const type of ["finisher-pr-945", "finish-pr-751", "finisher-933", "finish-315", "finisher-pr-958-b"]) {
    assert.equal(
      classifyRole({ spawnDepth: 0, agentType: type, description: "Apply reviewer findings" }),
      "finisher",
      `\`${type}\` is a spelling the record contains and must stay classifiable`,
    );
  }
});
