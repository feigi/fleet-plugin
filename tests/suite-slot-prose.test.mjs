// The suite slot bound reaches its readers through prose: the controller reads
// run-team/SKILL.md to hand a fix-applier and a finisher the wrapped command,
// tell a no-slot review from a red one, and clear a wedged slot by hand; a
// reader of CONTEXT.md meets the term. What the wrapper DOES — the bound, the
// arity rule, the nested run, the capped wait and exit 75 — is pinned by
// suite-slot.test.mjs, and SKILL.md no longer restates it.
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

test("SKILL.md tells the controller to hand the fix-applier and the finisher the wrapped string as <testCmd>", () => {
  const p = RUN_TEAM.paragraph("The review wraps its own one run", "run-team/SKILL.md suite slot hand-out paragraph", "**Where `<branch>` comes from:**").text;
  assert.match(p, Pin.phrase("The fix-applier and the finisher run what you hand them, so hand them the wrapped string as `<testCmd>` — `~/.fleet/bin/fleet-run suite-slot.mjs '<command>'`, each `'` inside the command written `'\\''`"),
    "the hand-out no longer gives the fix-applier and the finisher the wrapped string — their gate then runs unbounded");
  assert.match(p, Pin.phrase("a wrapped string handed to it anyway is harmless"),
    "the hand-out no longer says the review's own wrapper makes a wrapped string harmless");
});

test("SKILL.md says exit 75 is not a test result, and what a no-slot review asks of the controller", () => {
  const p = RUN_TEAM.paragraph("**`suiteVerdict` is the review's one judgement", "run-team/SKILL.md suiteVerdict paragraph", "**`cwdAudit` is the specialist's own").text;
  assert.match(p, Pin.phrase("**Exit 75 is not a test result.**"), "the prose no longer says exit 75 is not a test result");
  // #3048: the controller recognises a no-slot review by the verdict's reason,
  // which begins "no suite slot" — not by an entry in `dimensionsUnrun`, which
  // only a crashed specialist is named in.
  assert.match(p, Pin.phrase("it makes `suiteVerdict` not usable, `suiteVerdict.reason` beginning \"no suite slot within <n> s"), "the prose no longer tells the controller to read the no-slot verdict off suiteVerdict.reason");
  assert.match(p, Pin.phrase("re-review it under the next runner letter"), "the prose no longer sends a no-slot review to the next runner letter");
  assert.doesNotMatch(p, /every\s+dimension\s+unrun/i, "the prose says an exit 75 leaves every dimension unrun");
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
