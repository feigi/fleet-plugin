// A finisher settled `failed` or `killed` leaves its PR without
// `ready-to-merge` and nothing dispatches for it. The ruling: flag only — the
// cockpit raises one severity-4 token per outcome and the controller resolves
// it by hand, never an automatic retry and never the label itself. Each pin is
// sliced to the paragraph or table row carrying its claim.
import { test } from "node:test";
import assert from "node:assert/strict";

import { join } from "node:path";
import { Pin } from "./support/prose-pin.mjs";

const RUN_TEAM = Pin.file(join(import.meta.dirname, "..", "plugin", "skills", "run-team", "SKILL.md"));
const flat = (s) => s.replace(/\s+/g, " ");

test("a finisher that died is flagged by the cockpit and resolved by hand — no automatic retry, no label from the controller", () => {
  const para = flat(RUN_TEAM.paragraph("**Resolving a finisher that died.**", "died-finisher resolution", "### Dispositions escalation").text);
  assert.match(para, /`finisher:failed` or `finisher:killed` at severity 4/);
  assert.match(para, /neither the implementer's bare `killed` flag nor `unlabelled`/);
  assert.match(para, /the tick dispatches no finisher for it/);
  assert.match(para, /You resolve it by hand: investigate why the finisher died, or dispatch the next-suffix finisher after the finisher gate/);
  assert.match(para, /You never add the label yourself, and the tick does not retry\./);
});

test("the finisher-died wake bullet records failed and killed through member-died and points at the by-hand resolution", () => {
  const row = flat(RUN_TEAM.bullet("- **A finisher failed or was killed**", "- **Implementer bails before implementing**", "finisher-died wake").text);
  assert.match(row, /the \*\*Member confirmed dead or never dispatched\*\* wake \(`member-died finisher-pr-<M>`\), which settles it `failed` or `killed`/);
  assert.match(row, /the tick prints no dispatch for it/);
  assert.match(row, /`finisher:failed` \/ `finisher:killed` at severity 4/);
  assert.match(row, /\*\*Resolving a finisher that died\*\*/);
});
