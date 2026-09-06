// #22. Step 2's cut to 3–5 survivors runs before step 3 ever fetches the
// Agent Brief, so a candidate the Brief would have promoted into the
// shortlist is dropped on step 1 data alone and never gets read. Widening
// the fetch to every candidate was rejected (issue discussion): reading
// comments for ~100 candidates instead of 3–5 is the cost blowup step 1
// exists to avoid. This pins the documented-limitation half of the
// acceptance criteria instead — the cut states, at the point it happens,
// that it never sees the Brief.
//
// THE CEILING, same as candidates-exit3-prose.test.mjs: a PRESENCE pin over a
// bounded slice. It proves the clause is there, not that nothing near it
// contradicts it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..", "..", "..");
const NEXT_TICKET = readFileSync(
  join(REPO, "skills", "fleet", "skills", "next-ticket", "SKILL.md"),
  "utf8",
);

const dependenciesStep = () =>
  between(
    NEXT_TICKET,
    "## 2. Dependencies",
    "## 3. In-flight check",
    "next-ticket/SKILL.md",
  );

test("the dependencies step says the cut runs on step 1 data alone, never the Agent Brief", () => {
  const s = dependenciesStep();
  assert.match(s, phrase("Cut runs on step 1 data alone"));
  assert.match(s, phrase("never the Agent Brief"));
});

test("the dependencies step still states the cut this limitation is about", () => {
  // The antecedent the line-41 clause depends on — without it, "never sees
  // the Agent Brief" is an orphaned note about a cut the doc no longer states.
  assert.match(dependenciesStep(), phrase("Cut to oldest 3–5 here"));
});

test("the dependencies step says a Brief-promoted candidate is dropped before the Brief is fetched", () => {
  // The consequence that makes the limitation concrete: without this an
  // agent reads "cut runs on step 1 data alone" as a description, not a
  // warning that a specific candidate can be lost to it.
  assert.match(
    dependenciesStep(),
    phrase("a candidate the Brief would have promoted into survivors is dropped here"),
  );
});
