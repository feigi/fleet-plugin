// The review reads the PR body and the PR's commit messages as the implementer
// submitted them, and only the comments dimension is told to check them. Three
// halves: `usableMessages`/`messagesNote` as pure functions, the dispatch each
// dimension actually receives (a scripted host records every prompt), and the
// agent definition and fix-pass prose that carry the rules a prompt cannot.
// The capture block itself — one read, saved beside `pr.diff` — is executed in
// review-core-pr-repo.test.mjs.
//
// Zero deps: `node --test tests/review-core-messages.test.mjs`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ARGS, SNAP, parallel, pipeline, review, scriptedHost } from "./support/review-host-fixture.mjs";
import { SNAPSHOT_SCHEMA, messagesNote, runReview, usableMessages } from "../plugin/scripts/review-core.mjs";

const ROOT = join(import.meta.dirname, "..", "plugin");
const MESSAGES = `${SNAP.runRoot}/pr-messages.md`;

test("messagesPath is a declared optional snapshot field", () => {
  assert.deepEqual(SNAPSHOT_SCHEMA.properties.messagesPath, { type: "string" }, "undeclared: additionalProperties:false drops it");
  assert.ok(!SNAPSHOT_SCHEMA.required.includes("messagesPath"), "required: a failed read would then refuse the whole snapshot");
});

test("usableMessages is the file under the checked run root, and only when the capture was reported", () => {
  assert.equal(usableMessages({ runRoot: SNAP.runRoot }), null, "no messagesPath reported");
  // The reported value only says the capture ran; the path is the caller's.
  assert.equal(usableMessages({ runRoot: SNAP.runRoot, messagesPath: "/elsewhere/pr-messages.md" }), MESSAGES);
});

async function dispatched(snapshot) {
  const run = scriptedHost({
    snapshot: [snapshot],
    "review:correctness": [review([])],
    "review:comments": [{ ...review([]), dimension: "comments" }],
  });
  await runReview({ ...run.host, log: () => {}, pipeline, parallel }, { ...ARGS, dimensions: ["correctness", "comments"] });
  return run.prompts;
}

test("the comments dimension's dispatch carries the file and the rules; no other dimension's does", async () => {
  const prompts = await dispatched({ ...SNAP, messagesPath: MESSAGES });
  const comments = prompts["review:comments"][0];
  assert.ok(comments.includes(MESSAGES), "the comments dispatch does not name the messages file");
  assert.match(comments, /=== PR body ===/);
  assert.match(comments, /=== commit <sha> ===/);
  assert.match(comments, /carries no\s+`file` and no `line`/);
  assert.match(comments, /would falsify the\s+claim/, "the untouched-code tiebreak is not in the dispatch");
  const other = prompts["review:correctness"][0];
  assert.ok(!other.includes("pr-messages.md"), "a non-comments dispatch names the messages file");
  assert.ok(!/commit message/.test(other), "a non-comments dispatch mentions commit messages");
});

test("a capture that never ran is said so in the comments dispatch, never read as a clean body", async () => {
  const prompts = await dispatched(SNAP);
  const comments = prompts["review:comments"][0];
  assert.ok(!comments.includes("pr-messages.md"), "names a file that was never written");
  assert.match(comments, /were NOT captured/);
});

test("messagesNote with a path asks for claims about the change only", () => {
  const note = messagesNote(MESSAGES);
  assert.match(note, /about THIS\s+change/);
  assert.match(note, /not a\s+finding/);
});

const agent = readFileSync(join(ROOT, "agents", "fleet-review-comments.agent.md"), "utf8").replace(/\s+/g, " ");

test("the comments agent checks both bodies, files no file or line, and drops claims about untouched code", () => {
  assert.match(agent, /PR body and the PR's commit messages/);
  assert.match(agent, /"PR body:" or "commit <sha>:"/);
  assert.match(agent, /carries no `file` and no `line`/);
  assert.match(agent, /A claim about code the change does not touch is not a finding/);
});

test("the fix pass corrects a false commit-body claim in the PR body, and the finding still stands", () => {
  const fix = readFileSync(join(ROOT, "commands", "review-and-fix.md"), "utf8").replace(/\s+/g, " ");
  assert.match(fix, /A commit body cannot be rewritten\*\* — never rewrite history/);
  assert.match(fix, /correct a false commit-body claim in the PR body instead[^.]*counts as applying the finding/);
  assert.match(fix, /does not withdraw the Charge it carries/);
});
