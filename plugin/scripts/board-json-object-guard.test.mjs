// #1546: board.mjs had three copies of one policy — "this parsed, but it is not
// a JSON object, so refuse the whole payload and say what arrived instead."
// readAgent's sidecar-meta read, gather's `--prev` payload, and gather's
// per-entry `tickets[i]` check each spelled out both the predicate and the
// three-arm kind word inline. They now share `isJsonObject`/`jsonKind`.
//
// Two of the three callers were already pinned down to the kind word, by
// board-prev-shape.test.mjs's REFUSED table (#1192) — `null`, `array`, `number`
// and `string` all appear there for gather's two sites. readAgent's was NOT:
// board.test.mjs's "a meta.json holding valid JSON of the wrong SHAPE is a
// SIDECAR fault" drives this guard with `null` and asserts the COUNT of stderr
// lines, the file named on them, and the spend fields — never the message. So
// the naming half of the third caller was invisible to the suite: the arm that
// tells `null` from `[]` could have been dropped at this site alone and every
// test still passed. Extracting the helper is exactly what makes that gap
// matter, because the wiring is now the only thing this site owns.
//
// A separate file rather than more of board.test.mjs, the reason
// board-prev-shape.test.mjs and board-tryparse-null.test.mjs both give: the
// fleet runs several implementers at once and two PRs appending to one test
// file conflict, which costs the PR its CI entirely.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatherSpend } from "./board.mjs";

// One assistant turn, enough for readAgent to have a transcript worth booking
// beside the sidecar it is being handed. The tokens matter to the assertions
// below only as "the transcript still counted" — the sidecar fault must not
// cost this agent its spend.
const TURN = { type: "assistant", message: { id: "msg_1", usage: { cache_creation_input_tokens: 1000, output_tokens: 1 }, content: [] } };

// `metaBody` is written RAW, not through JSON.stringify: the point is what
// JSON.parse yields, and `"null"` is a payload JSON.stringify would launder
// into the string `"null"` instead.
function spendWith(metaBody) {
  const dir = mkdtempSync(join(tmpdir(), "sidecar-kind-"));
  writeFileSync(join(dir, "agent-x.jsonl"), JSON.stringify(TURN) + "\n");
  writeFileSync(join(dir, "agent-x.meta.json"), metaBody);
  const lines = [];
  const real = console.error;
  console.error = (...a) => lines.push(a.join(" "));
  let s;
  try { s = gatherSpend({ dir }); } finally { console.error = real; }
  return { s, lines };
}

// One row per BRANCH of the shared kind word, not per value. `null` and `[]`
// are the two that a `typeof`-only naming collapses into "object" — the
// diagnostic an operator cannot act on, since it names neither the shape they
// have nor the one they needed. The scalar rows are the fall-through arm.
const KINDS = [
  ["null", "null"],
  ["[]", "array"],
  ["[{\"description\":\"x\"}]", "array"],
  ["5", "number"],
  ["\"a sidecar\"", "string"],
  ["true", "boolean"],
];

for (const [body, kind] of KINDS) {
  test(`readAgent: a sidecar holding ${body} is refused and named "${kind}" (#1546)`, () => {
    const { s, lines } = spendWith(body);
    assert.equal(lines.length, 1, `expected exactly one stderr line, got ${JSON.stringify(lines)}`);
    assert.match(lines[0], new RegExp(`expected a JSON object, got ${kind}\\b`));
    // The message stays the sidecar's, not the transcript's: naming the wrong
    // file is the #602 defect this guard's wording was written to avoid, and a
    // shared helper must not have quietly re-generalised it.
    assert.match(lines[0], /agent-x\.meta\.json/);
    // And the fault still costs the agent only its ROLE, never its tokens —
    // the {} fallback, not a throw into gatherSpend's per-file catch.
    assert.equal(s.totals.cacheWrite, 1000);
    assert.equal(s.skipped, 0);
    assert.equal(s.metaErrors, 1);
  });
}

// ── the accept side: what the shared predicate must NOT refuse ───────────────
//
// `isJsonObject` replaced three inline `typeof v === "object" && v !== null &&
// !Array.isArray(v)` spellings. A predicate written any narrower — `v
// .constructor === Object`, `v instanceof Object` — refuses payloads that work
// today, and the sidecar rows below are the ones that would go first: a
// prototype-less object is exactly what a `JSON.parse` reviver or another
// producer can hand this read, and it carries a perfectly readable
// `description`.
const ACCEPTED = [
  ['{"description":"Review PR 1"}', "Review PR 1"],
  // No `description` at all is not a fault — it is the ordinary sidecar of an
  // agent that never set one, and readAgent falls back to the filename stem.
  // The guard must stay silent on it rather than treating absent as wrong-shape.
  ['{"spawnDepth":0}', "x"],
  ['{}', "x"],
];

for (const [body, label] of ACCEPTED) {
  test(`readAgent: a well-formed sidecar ${body} is read, not refused (#1546)`, () => {
    const { s, lines } = spendWith(body);
    assert.deepEqual(lines, [], "a usable sidecar must produce no diagnostic");
    assert.equal(s.metaErrors, 0);
    assert.equal(s.top[0].label, label);
    assert.equal(s.totals.cacheWrite, 1000);
  });
}
