// Review specialists and refuters carry the pattern-kill ban. A review
// specialist ran `pkill -f 'node --test'` and SIGTERMed another PR's shared
// test run, because members share one process table and the three run-team
// briefs were the only prompts that forbade it.
//
// The sentence is owned HERE, never read out of review-core.mjs, so a reword
// in one place reds instead of quietly becoming the fixture. It is read where
// it takes effect: the prompts runReview actually dispatches, for every
// dimension it can dispatch and for the refuter; the refuter prompt the
// fix-applier hands on word for word, in both seats that quote it (its member
// prompt and review-and-fix.md step 2); and the implementer brief it is quoted
// from.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runReview, DEFAULT_DIMENSIONS } from "../plugin/scripts/review-core.mjs";
import { pipeline, parallel, ARGS, SNAP, review, finding, vote, scriptedHost } from "./support/review-host-fixture.mjs";
import { Pin } from "./support/prose-pin.mjs";
import { memberPrompt } from "./support/render-brief.mjs";

const REPO = join(import.meta.dirname, "..");
const NO_PKILL =
  "Never run `pkill -f` on a pattern: members share one process table, so a pattern such as a test file's name matches every member's run, not only yours. Clearing your own leftover process needs its PID; report a stalled run to the controller instead.";

const keys = DEFAULT_DIMENSIONS.map((d) => d.key);

async function dispatched() {
  const script = { snapshot: [SNAP] };
  for (const k of keys) {
    script[`review:${k}`] = [review([finding("critical")])];
    script[`verify:${k}`] = [vote(false)];
  }
  const { host, prompts } = scriptedHost(script);
  await runReview({ ...host, pipeline, parallel }, { ...ARGS, dimensions: keys });
  return prompts;
}

test("every dimension's dispatched specialist prompt carries the pattern-kill ban", async () => {
  const prompts = await dispatched();
  for (const k of keys) {
    const sent = prompts[`review:${k}`];
    assert.equal(sent?.length, 1, `the ${k} specialist was not dispatched exactly once`);
    assert.ok(sent[0].includes(NO_PKILL), `the ${k} specialist's prompt no longer forbids a pattern kill`);
  }
});

test("every dimension's dispatched refuter prompt carries the pattern-kill ban", async () => {
  const prompts = await dispatched();
  for (const k of keys) {
    const sent = prompts[`verify:${k}`];
    assert.ok(sent?.length >= 1, `no refuter was dispatched for the ${k} finding`);
    for (const p of sent) assert.ok(p.includes(NO_PKILL), `the ${k} refuter's prompt no longer forbids a pattern kill`);
  }
});

// The fix-applier's copy sits in a `> ` blockquote, so a wrap point carries the
// gutter; drop it per line and fold whitespace so the sentence matches at any wrap.
const unwrapped = (text) => text.split("\n").map((l) => l.replace(/^(>\s?)+/, "")).join(" ").replace(/\s+/g, " ");
const FIX_STAGE_REFUTER_PROMPTS = [
  ["the fix-applier member prompt", () => Pin.of(memberPrompt("fix-applier", "review"), "the fix-applier member prompt").between("Try to REFUTE this finding", "Survives → apply it, with one hold", "the fix-applier member prompt").text],
  ["review-and-fix.md step 2", () => Pin.file(join(REPO, "plugin", "commands", "review-and-fix.md")).between("Try to REFUTE this finding", "That last clause is the whole mechanism", "review-and-fix.md").text],
];

for (const [name, prompt] of FIX_STAGE_REFUTER_PROMPTS) {
  test(`${name}: the refuter prompt the fix-applier hands on carries the pattern-kill ban`, () => {
    assert.ok(unwrapped(prompt()).includes(NO_PKILL), `${name}'s refuter prompt no longer forbids a pattern kill, so a fix-stage refuter is told nothing`);
  });
}

test("the sentence is the one the implementer brief carries, word for word", () => {
  const brief = readFileSync(join(REPO, "plugin", "skills", "run-team", "briefs", "implementer.md"), "utf8");
  assert.ok(brief.includes(NO_PKILL), "the implementer brief no longer says what the review prompts say");
});
