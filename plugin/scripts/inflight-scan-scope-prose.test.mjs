// #1075. `inflight.sh`'s three probes each ask whether a branch-shaped claim
// exists on a ticket — a PR, a remote head, a local branch, or a worktree —
// and phase 0's in-flight step said only "any hit = taken", never what a MISS
// means. A controller reading a free verdict took it as "nobody is on this",
// which the three probes cannot tell it: work done directly against the
// shared checkout — a concurrent human or agent session editing the ticket's
// target files there — stakes no branch-shaped claim and trips none of them.
// #1075's own thread measured exactly this: a candidate read free while a
// concurrent `/triage` session was mid-edit on its target region, outside any
// branch the scan could see.
//
// The fix adds one paragraph to the SAME phase-0 step a reader is already in
// when they read the scan's verdict — bounded here identically to
// inflight-exit2-prose.test.mjs's own slice, "**In-flight check**" through
// the next item's heading — so wording landing outside that step, or in a
// general narrative section elsewhere, throws here rather than reading as
// covered.
//
// THE CEILING, same as finisher-pin-race-prose.test.mjs: the scope sentence
// pins two joined facts — "probes see branch-shaped claims only" and "so a
// free verdict proves nothing about editing" — as ONE contiguous phrase,
// never two separate assertions on the same sentence. Two assertions would
// leave the JOIN open to a spliced exception clause inserted between them
// (finisher-pin-race-prose.test.mjs's own demonstrated defect); one exact-span
// assertion reds on that splice instead, because `phrase()` requires every
// word adjacent with only whitespace between. Measured: splicing ", except
// when every probe reports clean," between "evidence" and "that nobody" reds
// this file's second test while every other test in the suite stays green; a
// benign rewrap at a different column stays green on both tests, since
// `phrase()` matches across the line-wrap whitespace by design.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..");
const RUN_TEAM = readFileSync(join(REPO, "skills", "run-team", "SKILL.md"), "utf8");

const step = () =>
  between(RUN_TEAM, "**In-flight check, again**", "**Read the ticket in full, once**", "run-team/SKILL.md phase 1 Pull step 2");

test("the in-flight step names the four branch-shaped claims the scan's probes look for", () => {
  assert.match(
    step(),
    phrase("a PR, a remote head, a local branch, or a worktree"),
    "the in-flight step no longer names what the three probes actually detect, so a reader has no way to know the ceiling on a free verdict",
  );
});

test("the in-flight step states, as one exact span, that a free verdict is not evidence nobody is editing the ticket's files", () => {
  assert.match(
    step(),
    phrase("A free verdict is not evidence that nobody is editing the ticket's target files."),
    "the scope claim is gone, reworded past recognition, or split into two halves — which would let a splice inserted between them go undetected",
  );
});
