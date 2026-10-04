// #2748. claim-ticket.sh's runner-stamp comment told a reader that a stamp
// mismatch means "re-materialize to be sure". Nothing re-materializes a
// runner: the same comment says the runner is written once at claim time and
// never rewritten, and a claim refuses a worktree that already exists. The
// action it named was the retired bootstrap's, and the sweep #2740 adds to
// hold that vocabulary out of the runbook reads only shipped markdown, so a
// code comment is outside its reach.
//
// Two pins. The sweep holds the retired verb out of every shipped file that
// is not markdown and not a test — markdown is that sweep's, and a
// test quotes the retired form to refuse it. The positive pin holds the
// remedy the stamp comment names to the one a claim actually provides.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { between, phrase, stripHashGutter } from "./support/prose-pin.mjs";

const PLUGIN = join(import.meta.dirname, "..", "plugin");
const read = (rel) => readFileSync(join(PLUGIN, rel), "utf8");

const REMATERIALIZE = /re-?materiali[sz]/i;

const stampComment = () =>
  stripHashGutter(between(read("scripts/claim-ticket.sh"), "# The stamp the runner carries.", "\n#\n", "claim-ticket.sh runner-stamp comment"));

test("the retired-verb pattern matches each form it exists to catch", () => {
  for (const form of [
    'a mismatch means "re-materialize to be sure"',
    "The runner is re-materialized on every invocation",
    "rematerialise the runner",
  ]) assert.match(form, REMATERIALIZE, form);
  // The must-accept half: the build verb on its own is not the retired remedy.
  assert.doesNotMatch("`.agent-test.sh` was claim-ticket.sh's heredoc output, materialized beside", REMATERIALIZE);
});

test("no shipped script tells a reader to re-materialize a runner", () => {
  const files = readdirSync(PLUGIN, { recursive: true }).filter(
    (rel) => !rel.endsWith(".md") && !rel.endsWith(".test.mjs") && !rel.split("/").includes("node_modules") && statSync(join(PLUGIN, rel)).isFile(),
  );
  assert.ok(files.includes(join("scripts", "claim-ticket.sh")), "the sweep no longer reaches claim-ticket.sh");
  const hits = files.filter((rel) => REMATERIALIZE.test(read(rel)));
  assert.deepEqual(hits, [], "a shipped script still names re-materializing a runner, an action no command performs");
});

test("the stamp comment names a fresh claim as the only source of the current runner", () => {
  assert.match(stampComment(), phrase("only a fresh claim writes the current runner"));
});
