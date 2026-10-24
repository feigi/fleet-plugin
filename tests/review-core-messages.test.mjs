// The review reads the PR body and the PR's commit messages as the implementer
// submitted them, and only the comments dimension is told to check them. Three
// halves: `usableMessages` as a pure function, the dispatches each dimension
// and each refuter actually receive (a scripted host records every prompt), and
// the agent definition and fix-pass prose that carry the rules a prompt cannot.
// The capture block itself — one read, saved beside `pr.diff` — is executed in
// review-core-pr-repo.test.mjs.
//
// Zero deps: `node --test tests/review-core-messages.test.mjs`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ARGS, SNAP, finding, parallel, pipeline, review, scriptedHost, vote } from "./support/review-host-fixture.mjs";
import { SNAPSHOT_SCHEMA, runReview, usableMessages } from "../plugin/scripts/review-core.mjs";

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
  assert.match(comments, /about THIS\s+change/);
  assert.match(comments, /not a\s+finding/);
  assert.match(comments, /saved when this\s+review began/, "the dispatch no longer says when the file was saved");
  assert.match(comments, /a later edit changes nothing you\s+read/);
  assert.match(comments, /Read it\s+bounded, like the diff/);
  assert.match(comments, /at most a PR's first 100 commits[^]*?was not\s+read, never checked clean/, "the dispatch no longer says gh's commit list stops at 100");
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

// A finding on a body carries no file and no line, and the snapshot holds
// neither body, so its refuters are told where the saved copy is — else the
// only thing left to check it against is a live `gh pr view`, the body as
// edited since. A refuter of any other dimension's finding is told nothing.
async function refuted(snapshot) {
  const body = { severity: "important", claim: "PR body: says 3 files, the diff touches 2", evidence: "git diff --stat" };
  const run = scriptedHost({
    snapshot: [snapshot],
    "review:correctness": [review([finding("important")])],
    "review:comments": [{ ...review([body]), dimension: "comments" }],
    "verify:correctness": [vote(false)],
    "verify:comments": [vote(false)],
  });
  await runReview({ ...run.host, log: () => {}, pipeline, parallel }, { ...ARGS, dimensions: ["correctness", "comments"] });
  return run.prompts;
}

test("a comments finding's refuters are told where the saved bodies are; no other refuter is", async () => {
  const prompts = await refuted({ ...SNAP, messagesPath: MESSAGES });
  assert.ok(prompts["verify:comments"].length > 0, "the body finding was never sent to a refuter");
  for (const p of prompts["verify:comments"]) {
    assert.ok(p.includes(MESSAGES), "a comments refuter is not told where the saved bodies are");
    assert.match(p, /never against a live `gh pr view`/);
  }
  for (const p of prompts["verify:correctness"]) assert.ok(!p.includes("pr-messages.md"), "a correctness refuter names the messages file");
});

test("with no capture, a comments finding's refuters are told there is no saved body", async () => {
  const prompts = await refuted(SNAP);
  for (const p of prompts["verify:comments"]) {
    assert.ok(!p.includes("pr-messages.md"), "names a file that was never written");
    assert.match(p, /were NOT captured/);
  }
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
  assert.match(fix, /does not withdraw the finding\./);
});
