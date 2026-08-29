// #443. Step 7's push was documented unconditionally with `--force-with-lease`,
// on a path whose common case is a first push where the lease buys nothing —
// and it is the exact string #149 documents as intermittently denied by the
// auto-mode classifier, before the push is attempted, so a denial is not a
// lease race and retrying does not help.
//
// Two stronger claims were measured and REFUTED — this file must never pin
// either back in:
//   - the lease does NOT fail on a fresh branch. `git push --force-with-lease
//     -u origin HEAD` on a never-pushed branch succeeds cleanly at rc 0
//     (measured, git 2.50.1, bare origin + clone).
//   - the flag is NOT unconditionally useless. Step 7 rebases immediately
//     before pushing, so a member re-entering step 7 after an earlier push
//     genuinely needs the force — removing the flag would be wrong.
//
// Ruling: keep the push command exactly as written, add one sentence saying
// WHY the lease is there — a member who knows it protects a re-push can
// reason about a denial; one told only "use a plain push if denied" uses a
// plain push on the re-push too, where the force is load-bearing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..", "..", "..");
const NEXT_TICKET = readFileSync(join(REPO, "skills", "fleet", "skills", "next-ticket", "SKILL.md"), "utf8");

const step7 = () =>
  between(NEXT_TICKET, "## 7. When the superpowers path reports done", "## Red flags", "next-ticket/SKILL.md step 7");

test("step 7 still pushes with the lease, unconditionally — the command itself is untouched", () => {
  assert.match(
    step7(),
    /git push --force-with-lease -u origin HEAD/,
    "step 7's push command changed — the ruling was to add a sentence beside it, not to touch the command",
  );
});

test("step 7 says the lease matters only on a re-push, and why", () => {
  const s = step7();
  assert.match(
    s,
    phrase("rebases immediately before pushing"),
    "step 7 lost the mechanism the reason rests on — without it a reader can't tell why a re-push needs the force",
  );
  assert.match(
    s,
    phrase("re-entering step 7 after an earlier push"),
    "step 7 no longer ties the force to the re-push case — the reason is now floating, unattached to when it applies",
  );
});

test("step 7 scopes the plain-push fallback to a branch that has never been pushed", () => {
  const s = step7();
  // The wrongly-ACCEPT half (AC-4): a reader must not come away licensed to
  // plain-push on a re-push, where a denial means the force is load-bearing.
  assert.match(
    s,
    phrase("a branch that has never been pushed"),
    "step 7 no longer scopes the plain-push fallback to a first push — a reader could now use it on a denied re-push, where the force is load-bearing",
  );
  assert.match(
    s,
    phrase("git push -u origin HEAD"),
    "step 7 no longer names the plain-push fallback command itself",
  );
});
