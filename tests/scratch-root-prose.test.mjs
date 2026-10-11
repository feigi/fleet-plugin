// Prose and source pins for the scratch-root cutover (ADR 0027): no shipped
// text says a harness injects the scratch root, no standalone path keeps a
// `/tmp/review-pr-<pr>` of its own, and every controller dispatch template that
// carries `<scratch>` says where it comes from.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN = fileURLToPath(new URL("../plugin", import.meta.url));
const read = (...p) => readFileSync(join(PLUGIN, ...p), "utf8");

const INJECTED = /injected\s+unprompted|injected\s+into\s+every\s+dispatched|injected\s+root/;

test("no agent body or command says a harness injects the scratch root", () => {
  for (const dir of ["agents", "commands"]) {
    for (const f of readdirSync(join(PLUGIN, dir))) {
      assert.doesNotMatch(read(dir, f), INJECTED, `${dir}/${f} claims the scratch root is injected`);
    }
  }
});

test("the five implementer bodies stay byte-identical below their frontmatter", () => {
  const bodies = readdirSync(join(PLUGIN, "agents"))
    .filter((f) => /^fleet-implementer-.*\.agent\.md$/.test(f))
    .map((f) => read("agents", f).replace(/^---\n[\s\S]*?\n---\n/, ""));
  assert.equal(bodies.length, 5);
  for (const b of bodies) assert.equal(b, bodies[0]);
});

test("review-core keeps no /tmp/review-pr fallback and resolves a missing scratch through scratchRoot()", () => {
  const src = read("scripts", "review-core.mjs");
  assert.doesNotMatch(src, /\/tmp\/review-pr/);
  assert.match(src, /A\.scratch === undefined \? standaloneScratchRoot\(\)/);
});

test("run-team names scratch-root.mjs where it first defines <scratch>, and in each dispatch template that carries one", () => {
  const flat = (t) => t.replace(/\s+/g, " ");
  const skill = flat(read("skills", "run-team", "SKILL.md"));
  assert.match(skill, /\*\*The scratch root is computed, never invented and never recorded\.\*\*/);
  for (const [what, needle] of [
    ["recipe deriver", "`<scratch>` is the absolute path `scratch-root.mjs` prints"],
    ["implementer", "`<scratch>` as `scratch-root.mjs` printed it"],
    ["review runner", "the absolute path `scratch-root.mjs` prints, never the review side's"],
    ["fix-applier", "Every `<scratch>` in that prompt is the absolute path `scratch-root.mjs` printed"],
    ["finisher", "`<scratch>` is the absolute root your dispatch prompt names"],
    ["merge bot", "Its prompt names the absolute `<scratch>` (`scratch-root.mjs`'s output)"],
  ]) {
    assert.ok(skill.includes(needle), `run-team/SKILL.md: the ${what} dispatch no longer says where <scratch> comes from`);
  }
});

test("the standalone entry points resolve <scratch> through scratch-root.mjs when nothing dispatched them", () => {
  assert.match(read("commands", "review-and-fix.md"), /Run standalone, with no dispatcher, it is what `~\/\.fleet\/bin\/fleet-run scratch-root\.mjs` prints/);
  assert.match(read("skills", "sizing-a-ticket", "SKILL.md"), /with no dispatcher, the output of `~\/\.fleet\/bin\/fleet-run scratch-root\.mjs`/);
  assert.match(read("skills", "next-ticket", "SKILL.md"), /`<scratch>` the output of `~\/\.fleet\/bin\/fleet-run scratch-root\.mjs`/);
  assert.match(read("agents", "fleet-recipe-deriver.agent.md"), /scratch-root\.mjs/);
});
