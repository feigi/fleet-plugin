// The records that say the root sweep evicts the trees of every pr<N>/ it keeps,
// by the kind of member that made them, and that one script builds every
// measuring copy. PRESENCE pins over the phrases each record carries; the
// behaviour itself is pinned by reclaim-scratch.test.mjs, fleet-tick.test.mjs
// and measure-copy.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pin } from "./support/prose-pin.mjs";

const ROOT = join(import.meta.dirname, "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

test("CONTEXT.md's Evict entry says a fix-applier's round copies, a dead runner's run root and a dead finisher's tree lose their dependencies once no member of their kind is live", () => {
  const evict = Pin.of(read("CONTEXT.md"), "CONTEXT.md").between("**Evict**:", "_Avoid_: prune, cleanup, reap, dehydrate", "CONTEXT.md's Evict entry").text;
  assert.match(evict, Pin.phrase("A fix-applier's round copies lose their installed dependencies once no fix-applier is live on the PR, and so do a review run root whose runner died and a finisher tree whose finisher died, once no member of their kind is live"));
});

test("ADR 0029 and ADR 0036 carry the amendment on their Status line", () => {
  const adr29 = read("docs/adr/0029-scratch-is-reclaimed-on-github-terminal-state-and-age.md").split("\n## Context")[0];
  assert.match(adr29, Pin.phrase("Amended by #4274: the root sweep also evicts the trees in every `pr<N>` directory it keeps whose kind of member is not live on the ledger (fix-applier round roots, review run roots, finisher trees), and the tick runs it after every fix-applier, failed review launch and finisher settle."));
  const adr36 = read("docs/adr/0036-an-idle-claim-tree-is-evicted-its-dependencies-go-the-claim-stays.md").split("\n## Context")[0];
  assert.match(adr36, Pin.phrase("Amended by #4274: a fix-applier's round copies, a dead review runner's run root and a dead finisher's tree are evicted too, by the root sweep, once no member of their kind is live on the PR."));
});

test("scratch-reclaim.md names the third trigger and the rule", () => {
  const doc = read("docs/components/scratch-reclaim.md");
  assert.match(doc, Pin.phrase("the tick's `--apply` runs it, alone, after every settle of a `fix-pr-<N>[-x]`, of a review launch to `=failed` and of a `finisher-pr-<N>[-x]`"));
  assert.match(doc, Pin.phrase("a sweep that exits non-zero or prints no receipt is not recorded and runs again on the next `--apply` tick"));
  assert.match(doc, Pin.phrase("The root sweep evicts the trees of every `pr<N>/` it keeps, by the kind of member that made them."));
  assert.match(doc, Pin.phrase("the trees under every `fix-*` round root, and under a `mutate/` left from before, when no `fix-pr-<N>[-x]` is live"));
  assert.match(doc, Pin.phrase("every `finish-*` tree, when no `finisher-pr-<N>[-x]` is live"));
  assert.match(doc, Pin.phrase("which the bot's hold keeps from removal but not from this"));
});

test("both isolation documents say the script builds every measuring copy, inside a round root or a run root, and that no pr<N>/mutate/ is made", () => {
  const components = read("docs/components/isolation.md");
  assert.match(components, Pin.phrase("is built by [`measure-copy.mjs`](../../plugin/scripts/measure-copy.mjs)"));
  assert.match(components, Pin.phrase("inside a `fix-*` round root or a `run-*` run root directly under `<scratch>/pr<N>/`"));
  assert.match(components, Pin.phrase("no `pr<N>/mutate/` is made"));
  const skill = read("plugin/skills/run-team/references/isolation.md");
  assert.match(skill, Pin.phrase("**One script builds every measuring copy.**"));
  assert.match(skill, Pin.phrase("inside a `fix-*` round root or a `run-*` run root directly under `<scratch>/pr<N>/`"));
  assert.match(skill, Pin.phrase("no `pr<N>/mutate/` is made"));
});
