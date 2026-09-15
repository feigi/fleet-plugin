// #814. Phase 0 step 4's staleness recipe named the commit that removed a
// string with `git log -S '<old string>' --oneline origin/main -- <file>` and
// then prescribed `git merge-base --is-ancestor <sha> origin/main` to "prove it
// is not a pre-rebase orphan". `git log <ref>` enumerates only commits
// reachable from `<ref>`, so that sha is an ancestor of `origin/main` BY
// CONSTRUCTION, and `--is-ancestor` is true again when the two are equal: the
// step could not answer no in the position it was written into, and a step that
// always passes reads as a check that was performed.
//
// Measured in this repository while the defect was live: the walk for the
// defect's own wording, `git log -S 'proves it is not a pre-rebase orphan'
// --format=%H -n1 origin/main -- plugin/skills/run-team/SKILL.md`, names
// `9c930a7`, and `git merge-base --is-ancestor 9c930a7 origin/main` exits 0;
// `git merge-base --is-ancestor origin/main origin/main` exits 0 as well. The
// check is not inert — on a commit that did NOT come from that walk it exits 1
// (measured on this branch's own tip, unreachable from `origin/main`) — so the
// defect is the position, never the check.
//
// WHY A PIN AT ALL, given the check's own redundancy is the finding: the
// vacuous wording shipped and survived the entire suite for the whole of its
// life, because nothing in `*.test.mjs` read this paragraph. The probe that
// carries the same reasoning in code (`staleness.mjs`'s call-site comment) is
// itself backed by a test that the citation walk is scoped to `origin/main`
// (`staleness.test.mjs`, #813) — the prose half had no equivalent. A revert of
// the fix is one sentence, and `git revert` reproduces the old wording
// byte-for-byte.
//
// THE SLICE IS WHAT ANCHORS. Matched over the whole document these phrases are
// satisfiable from outside the rule: this file discusses `origin/main`
// scoping, `--is-ancestor`, orphans and pre-rebase shas across several
// neighbouring paragraphs, and `plugin/commands/run-merge-bot.md` prescribes
// the same command for its own (non-vacuous) input. `paragraph()` cuts the
// recipe to the one block carrying the rule and throws rather than widening if
// the anchor moves.
//
// MUTATION-VERIFIED BOTH WAYS, on a copy of this worktree's file kept outside
// it (`<scratch>/impl-814/SKILL.md.orig`, restored and sha-256-compared after
// every run). Five tests here; three of the 35 pre-existing prose pins over
// this same document — liveness-rationale, staleness-verdict,
// staleness-qualifier, 12 tests together — stayed green on every mutation,
// which is the discrimination:
//   - the old wording restored whole (`git show origin/main:` before this fix):
//     5 of 5 red. That wording is green on origin/main's own CI, which is the
//     measurement that this paragraph was unpinned.
//   - the reachability reason cut out ("so every commit it can print is
//     reachable from `origin/main` by construction" → "so the commit it names
//     is the one to cite"): 3 red — the no-check-here pin plus the two
//     accept-side tests, which derive their fixtures FROM the live paragraph
//     and so red whenever a pinned span leaves it. The relocation pin and the
//     negative both stay green: the mutation removed the reason, not the
//     position.
//   - the relocated input unnamed ("a sha the TICKET quotes" → "a sha from
//     some other source"): 3 red — the relocation pin and the same two
//     accept-side tests; the no-check-here pin stays green.
//   - THE ACCEPT SIDE, measured on the file rather than a fixture: the whole
//     paragraph re-wrapped at a width nothing here assumes — 5 of 5 GREEN.
//     These pins refuse drift, not reflow.
//   - the decoy, which is what the slice bound is for: both pinned spans
//     deleted from the recipe and appended verbatim as a stray paragraph at
//     the end of the file — 4 red, not bought off by the copy. The negative
//     pin stays green there, correctly: nothing re-attached the proof claim.
//
// THE CEILING: two positive spans and one negative. The negative pins the
// LITERAL reverted clause — the walk's output bound to the proof claim — and a
// reworded re-attachment evades it; the positive spans are what carry the
// meaning. Neither half pins the exit-1/exit-128 reading note that follows
// them, which is a reading aid, not the rule. `git show` resolving an orphan is
// stated in the prose and not asserted here: it is a property of git, not of
// this document.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { paragraph, phrase } from "./prose-pin.mjs";

const SKILL = "skills/run-team/SKILL.md";
const ANCHOR = "**Grep for the ticket's ASKED-FOR CHANGE, not only its subject construct**";
const text = () => readFileSync(join(import.meta.dirname, "..", ...SKILL.split("/")), "utf8");

// `**` stripped, nothing else: every pinned span below opens on a bolded lead
// clause, and where the emphasis sits is not what this file is about — dropping
// or moving the asterisks must not red a pin that holds the words. Whitespace
// is left to `phrase()`, which joins on `\s+` and so already absorbs the
// hard-wrap.
const recipe = () => paragraph(text(), ANCHOR, SKILL).replace(/\*\*/g, "");

// ONE contiguous span, never three presence checks: the rule is the JOIN of the
// instruction (no ancestry check here), its reason (reachable by construction,
// because that is where the walk starts) and the tautology's second case (true
// again when the sha IS the ref). Independent matches on those three would each
// stay green with the reason attached to the wrong clause, which is the shape
// the defect had.
const NO_CHECK_HERE =
  "No ancestry check on what that walk printed. `origin/main` is where the walk starts, so every commit it can print is reachable from `origin/main` by construction, and `git merge-base --is-ancestor <sha> origin/main` is true for all of them — true again when the sha *is* `origin/main`.";

// The relocation, as one span for the same reason: the check, the input it
// belongs to (a sha the TICKET quotes) and the mechanism that lets that input
// answer no. "It can fail somewhere" with no named input is what the recipe
// already read like.
const BELONGS_TO_TICKET_SHA =
  "That check belongs one input over — a sha the TICKET quotes, where it can answer no: a rebase leaves the commit it orphaned a whole object, so `git show` resolves it happily while nothing in `origin/main`'s history reaches it";

// The reverted clause, verbatim from `origin/main` before this fix: the walk's
// output bound to the proof claim. Narrow on purpose — the phrase "pre-rebase
// orphan" is LEGITIMATE in this paragraph when it describes the ticket-quoted
// sha, which is the whole point of the relocation, so a bare search for it
// would red correct prose. The accept-side test below feeds exactly that
// wording in and requires this pin to stay green on it.
const REVERTED =
  "the commit that removed it, `git merge-base --is-ancestor <sha> origin/main` proves it is not a pre-rebase orphan";

test("the phase-0 recipe states the walk's own output needs no ancestry check, and why", () => {
  assert.match(
    recipe(),
    phrase(NO_CHECK_HERE),
    `${SKILL}'s "${ANCHOR}" paragraph no longer says "${NO_CHECK_HERE}". Without the reason bound to the instruction, the next reader restores the check — it looks like evidence, and nothing on the page says the walk already answers it. #814.`,
  );
});

test("the phase-0 recipe keeps the ancestry check on the input where it can answer no", () => {
  assert.match(
    recipe(),
    phrase(BELONGS_TO_TICKET_SHA),
    `${SKILL}'s "${ANCHOR}" paragraph no longer says "${BELONGS_TO_TICKET_SHA}". The check is not wrong, it was in the wrong position — dropping the ticket-quoted-sha case loses the one input it is evidence for, and a sha a ticket quotes is where a stale premise hides. #814.`,
  );
});

test("the phase-0 recipe does not re-attach the proof claim to the sha the walk printed", () => {
  assert.doesNotMatch(
    recipe(),
    phrase(REVERTED),
    `${SKILL}'s "${ANCHOR}" paragraph says "${REVERTED}" again — that is the #814 defect verbatim: the sha came from a walk starting at \`origin/main\`, so the check cannot answer no about it and proves nothing. Run it on a sha the ticket quotes instead.`,
  );
});

// ACCEPT SIDE 1 — the guard's own false-positive class. "Pre-rebase orphan" is
// correct English about the ticket-quoted sha; the relocation is the reason
// that wording still belongs in this paragraph, so a future author spelling
// the relocated check that way must not red anything here. The fixture is the
// live paragraph plus exactly that sentence, about the ticket's sha: the
// negative pin stays green because what it refuses is the ADJACENCY to the
// walk's output, not the words.
test("naming the relocated check a pre-rebase-orphan test is ACCEPTED, not refused", () => {
  const live = recipe();
  const reworded = `${live} Run \`git merge-base --is-ancestor <sha> origin/main\` on the sha the ticket quotes: exit 0 proves it is not a pre-rebase orphan, exit 1 says it is one and the premise is stale.`;
  assert.doesNotMatch(
    reworded,
    phrase(REVERTED),
    "the negative pin fires on a LEGITIMATE use of the orphan wording on the ticket-quoted sha — narrow it to the walk-output adjacency",
  );
  assert.match(reworded, phrase(NO_CHECK_HERE));
  assert.match(reworded, phrase(BELONGS_TO_TICKET_SHA));
});

// ACCEPT SIDE 2 — reflow. Derived from the live paragraph, never a quoted copy
// of today's lines, so a reword of the surrounding prose is not what this
// measures: re-wrapped at a width nothing here assumes, every pin above still
// holds. These pins refuse drift, not line breaks.
test("a rewrapped recipe paragraph still matches every pin above", () => {
  const live = recipe();
  const narrow = live
    .split(/\s+/)
    .filter(Boolean)
    .reduce((acc, w) => {
      const last = acc[acc.length - 1];
      if (last && `${last} ${w}`.length <= 45) acc[acc.length - 1] = `${last} ${w}`;
      else acc.push(w);
      return acc;
    }, [])
    .join("\n   ");
  assert.notEqual(narrow, live, "the rewrap fixture no longer changes the paragraph's wrapping — update it");
  assert.match(narrow, phrase(NO_CHECK_HERE));
  assert.match(narrow, phrase(BELONGS_TO_TICKET_SHA));
  assert.doesNotMatch(narrow, phrase(REVERTED));
});
