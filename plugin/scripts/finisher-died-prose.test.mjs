// A finisher settled `failed` or `killed` leaves its PR without
// `ready-to-merge` and nothing dispatches for it. The ruling: flag only — the
// cockpit raises one severity-4 token per outcome and the controller resolves
// it by hand, never an automatic retry and never the label itself. Each pin is
// sliced to the paragraph or table row carrying its claim.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { paragraph } from "./prose-pin.mjs";

const RUN_TEAM = readFileSync(join(import.meta.dirname, "..", "skills", "run-team", "SKILL.md"), "utf8");
const flat = (s) => s.replace(/\s+/g, " ");

test("a finisher that died is flagged by the cockpit and resolved by hand — no automatic retry, no label from the controller", () => {
  const para = flat(paragraph(RUN_TEAM, "**Resolving a finisher that died.**", "died-finisher resolution"));
  assert.match(para, /`finisher:failed` or `finisher:killed` at severity 4/);
  assert.match(para, /neither the implementer's bare `killed` flag nor `unlabelled`/);
  assert.match(para, /the tick dispatches no finisher for it/);
  assert.match(para, /You resolve it by hand: investigate why the finisher died, or dispatch the next-suffix finisher after the finisher gate/);
  assert.match(para, /You never add the label yourself, and the tick does not retry\./);
});

test("the finisher-report wake row records failed and killed and points at the by-hand resolution", () => {
  const row = flat(RUN_TEAM.split("\n").find((l) => l.startsWith("| Finisher report (failed / killed) |")) ?? "");
  assert.match(row, /settle finisher-pr-<M>=failed` for a finisher that crashed or gave up, `=killed` for one that was killed/);
  assert.match(row, /the tick prints no dispatch for it/);
  assert.match(row, /`finisher:failed` \/ `finisher:killed` at severity 4/);
  assert.match(row, /\*\*Resolving a finisher that died\*\*/);
});
