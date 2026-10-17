// The suite slot bound reaches its readers through prose: the controller reads
// run-team/SKILL.md to hand a fix-applier and a finisher the wrapped command,
// tell a member what exit 75 is, and clear a wedged slot by hand; a reader of
// CONTEXT.md meets the term. What the wrapper DOES is pinned by
// suite-slot.test.mjs, and each clause below states a behaviour that file runs.
// A clause here goes red when its sentence is reworded or gutted; the span
// convention is tests/support/prose-pin.mjs's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Pin } from "./support/prose-pin.mjs";
import { CASES, label, renderBrief } from "./support/render-brief.mjs";

const ROOT = join(import.meta.dirname, "..");
const RUN_TEAM = Pin.file(join(ROOT, "plugin", "skills", "run-team", "SKILL.md"));
const CONTEXT = Pin.file(join(ROOT, "CONTEXT.md"));

test("SKILL.md says a full run takes a slot, a narrowed one takes none, and a nested wrapper takes no second", () => {
  const p = RUN_TEAM.paragraph("**The suite slot bound.**", "run-team/SKILL.md suite slot bound paragraph", "Each seat that runs the full suite is wrapped").text;
  assert.match(p, Pin.phrase("It decides by arity. No appended arguments is a full run, and waits for a free slot. Appended arguments are a narrowed run, which takes none"),
    "the bound no longer says it is decided by arity, with a narrowed run taking none");
  assert.match(p, Pin.phrase("A wrapper that finds `FLEET_SUITE_SLOT` set, which a slot holder exports to its child, is nested inside a held slot and runs straight through"),
    "the bound no longer says a nested wrapper runs straight through");
  assert.match(p, Pin.phrase("At most `FLEET_SUITE_SLOTS` full suite runs execute on a host at once"),
    "the bound no longer names its override");
});

test("SKILL.md tells the controller to hand the fix-applier and the finisher the wrapped string as <testCmd>", () => {
  const p = RUN_TEAM.paragraph("Each seat that runs the full suite is wrapped", "run-team/SKILL.md suite slot hand-out paragraph", "The wait is capped and never counts against the run").text;
  assert.match(p, Pin.phrase("The fix-applier and the finisher run what you hand them, so hand them the wrapped string as `<testCmd>` — `~/.fleet/bin/fleet-run suite-slot.mjs '<command>'`, each `'` inside the command written `'\\''`"),
    "the hand-out no longer gives the fix-applier and the finisher the wrapped string — their gate then runs unbounded");
  assert.match(p, Pin.phrase("A repository that tracks its own runner wraps it itself"),
    "the hand-out no longer says a repository's own runner is its own to wrap");
});

test("SKILL.md says the wait is capped, exit 75 is not a test result, and what each seat does about it", () => {
  const p = RUN_TEAM.paragraph("The wait is capped and never counts against the run", "run-team/SKILL.md suite slot wait paragraph", "A slot holder killed without releasing").text;
  assert.match(p, Pin.phrase("`FLEET_SUITE_WAIT_S` seconds, 1800 by default, then exit **75** with `suite-slot: no slot after <n>s` on stderr, having launched nothing"),
    "the wait cap, its exit status or its message changed");
  assert.match(p, Pin.phrase("**Exit 75 is not a test result.**"), "the prose no longer says exit 75 is not a test result");
  // #3048: the controller recognises a no-slot review by the verdict's reason,
  // which begins "no suite slot" — not by an entry in `dimensionsUnrun`, which
  // only a crashed specialist is named in.
  assert.match(p, Pin.phrase("it makes `suiteVerdict` not usable, `suiteVerdict.reason` beginning \"no suite slot within <n> s"), "the prose no longer tells the controller to read the no-slot verdict off suiteVerdict.reason");
  assert.match(p, Pin.phrase("re-review it under the next runner letter"), "the prose no longer sends a no-slot review to the next runner letter");
  assert.doesNotMatch(p, /every\s+dimension\s+unrun/i, "the prose says an exit 75 leaves every dimension unrun");
  assert.match(p, Pin.phrase("The implementer, fix-applier and finisher briefs carry the one-line rule: *Exit 75 from the suite is not a test result; run the command again.*"),
    "the prose no longer says the briefs carry the exit-75 line");
});

// The sentence above is a claim about the templates, so it is pinned against what
// each of those roles' briefs renders, every kind.
test("every implementer, fix-applier and finisher brief carries the exit-75 line", () => {
  const cases = CASES.filter((c) => ["implementer", "fix-applier", "finisher"].includes(c.role));
  assert.ok(cases.length >= 3, "the cases this pins went missing");
  for (const c of cases) {
    assert.match(renderBrief(c.role, c.kind), Pin.phrase("Exit 75 from the suite is not a test result; run the command again."),
      `${label(c)}'s brief no longer says exit 75 is not a test result`);
  }
});

test("the runbook names the slot directory and the files its takeover cannot clear", () => {
  const p = RUN_TEAM.paragraph("**The suite slots wedge the same ways, and clear the same way.**", "run-team/SKILL.md suite slots runbook paragraph", "**The gap the lock does not close:**").text;
  assert.match(p, Pin.phrase("`~/.fleet/suite-slots/<i>.lock` is built on the ledger's lock primitive, so an empty or unparseable `<i>.lock` and a leftover `<i>.lock.reap` are permanent"),
    "the runbook no longer names the two slot files that wedge");
  assert.match(p, Pin.phrase("remove it by hand once no suite run is running"), "the runbook no longer says to remove a wedged slot by hand");
});

test("CONTEXT.md defines the suite slot by its lock, its bound and its arity", () => {
  const term = CONTEXT.between("**Suite slot**:", "_Avoid_: test lock", "CONTEXT.md suite slot entry").text;
  assert.match(term, Pin.phrase("a narrowed run (arguments appended) takes none"), "the glossary no longer says a narrowed run takes no slot");
  assert.match(term, Pin.phrase("N is 2 unless `FLEET_SUITE_SLOTS` says otherwise"), "the glossary no longer states the default bound");
});
