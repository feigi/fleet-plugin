// #443. Step 7's push was documented unconditionally with `--force-with-lease`,
// on a path whose common case is a first push where the lease buys nothing —
// and it is the exact string #149 documents as intermittently denied by the
// auto-mode classifier, before the push is attempted — so a denial is not a
// lease race. It is judged per invocation and intermittently, never once for
// the command, so a retry is a coin flip rather than a fix
// (`run-merge-bot.md`: "judged and intermittently denied per invocation").
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

const REPO = join(import.meta.dirname, "..");
const NEXT_TICKET = readFileSync(join(REPO, "skills", "next-ticket", "SKILL.md"), "utf8");

const step7 = () =>
  between(NEXT_TICKET, "## 7. When the superpowers path reports done", "## Red flags", "next-ticket/SKILL.md step 7");

// Narrow to the note itself before pinning anything, the way
// candidates-exit3-prose.test.mjs narrows to one table row. A positive
// `assert.match` over the whole step-7 slice is presence-only: it reddens when
// a pinned phrase is DELETED and stays green when a contradicting clause is
// spliced in beside it, phrases intact. Both halves below were measured passing
// 3/3 against a section-wide slice while asserting the opposite of the truth.
const note = () =>
  between(step7(), "`--force-with-lease` matters only on a re-push", "`Closes #N` closes issue on merge", "step 7's lease note");

// The note's own `;` splits it into the two claims that must not leak into each
// other: the force is required on a re-push, the plain push is safe only on a
// first one. Slicing at the LAST `;` keeps every appended clause inside the
// fallback half rather than letting a new one escape both pins.
const semi = () => {
  const at = note().lastIndexOf(";");
  assert.notEqual(at, -1, "step 7's lease note no longer joins its two halves with `;` — update this test");
  return at;
};
const reasonHalf = () => note().slice(0, semi());
const fallbackHalf = () => note().slice(semi());

test("step 7 still pushes with the lease, unconditionally — the command itself is untouched", () => {
  assert.match(
    step7(),
    /git push --force-with-lease -u origin HEAD/,
    "step 7's push command changed — the ruling was to add a sentence beside it, not to touch the command",
  );
});

test("step 7 says the lease matters only on a re-push, and why", () => {
  const s = reasonHalf();
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
  // Both pins above are subject-side, so a reversal that rewrites only the
  // PREDICATE leaves them verbatim. Pin the predicate too, and ban its
  // negation, or the note can carry the refuted "the flag is unconditionally
  // useless" claim with every pinned phrase still in place.
  assert.match(
    s,
    phrase("needs the force to land the rebased commits"),
    "step 7 no longer says what the force is FOR on a re-push — the claim's predicate is what a reversal rewrites first",
  );
  assert.doesNotMatch(
    s,
    /\b(?:not|never)\b[\s\S]{0,40}\bneeds?\b/i,
    "step 7 now denies that a re-push needs the force — measured false, and #443's Brief refuted it: step 7 rebases immediately before pushing, so the force is load-bearing there",
  );
});

test("step 7 scopes the plain-push fallback to a branch that has never been pushed", () => {
  const s = fallbackHalf();
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
  // Scoping the fallback IN to the first push does not scope it OUT of the
  // re-push: both pins above survive a clause that widens it, appended right
  // beside them. This half is the one that hands out the plain push, so the
  // re-push must not be named in it at all.
  assert.doesNotMatch(
    s,
    /\bre-?push\b/i,
    "step 7's plain-push fallback now reaches the re-push case — that is the AC-4 defect: on a re-push the force is load-bearing and a denial there is not routed around",
  );
});

// #1049. The ruling above settled WHY the lease is documented; it left open
// what a member does when the force is DENIED on a re-push. There is no route
// around that one — the force is load-bearing there — so the page states the
// only correct move: stop and report the denial. The failure it closes is a
// member reading a denial as "use more force" and retrying with a plain
// `--force`, which drops the lease the step exists to keep.
//
// NOT a route, measured (#1049) and banned here so a later author does not add
// it back: `gh pr update-branch` is server-side and pulls changes FROM the base
// branch, so it cannot upload locally-rebased commits — which is exactly what a
// step-7 re-push has to do. The merge bot's own denial-recovery route runs that
// command for a different purpose; the analogy does not carry to step 7.
test("step 7 routes a denied re-push to stop-and-report, never to a plain force", () => {
  // In the REASON half, never the fallback one: that half bans the term
  // `re-push` outright (the test above), so the same clause moved after the
  // note's last `;` reds both this pin and that ban — measured, two reds — and
  // correctly, since the fallback half is the one that hands out a plain push.
  const s = reasonHalf();
  assert.match(
    s,
    phrase("stop and report the denial"),
    "step 7 no longer says what to do when the force is denied on a re-push — the gap #1049 was filed for",
  );
  assert.match(
    s,
    phrase("never retry with a plain `--force`"),
    "step 7 no longer bans the plain-force retry — the move a member makes when a denial reads as 'use more force', and the one that drops the lease",
  );
  // Both pins above are deletion-only: they red when the clause goes, and on a
  // reversal to "retry with a plain `--force` until it lands" (both measured).
  // They stay green when a clause licensing the retry is spliced in BESIDE
  // them, phrases intact — measured with "— if the classifier still denies it,
  // `git push --force` lands the rebase" appended inside the reason half: the
  // file goes 3/4 and the ONLY assertion that reds is the ban below. What such
  // a clause has to name is the bare command, so that is what is banned — over
  // the whole note, not one half, since either half could carry it. The
  // lookahead is load-bearing rather than cautious: `\b` sits between `force`
  // and `-with`, so the step's own documented command matches without it.
  assert.doesNotMatch(
    note(),
    /git push\s+--force(?!-with-lease)/,
    "step 7's lease note now names a bare `git push --force` — a denial has no forcing route around it, and this is the command a member reaches for when the page implies there is",
  );
});
