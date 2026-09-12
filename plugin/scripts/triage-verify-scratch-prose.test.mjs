// #1081. Verifying a test-coverage claim means mutating source and checking
// something reds, and the step prescribing that verification named no location
// for the mutation — so the default reading was the file in front of the
// reader, which is this checkout, shared by every concurrent session.
//
// Measured 2026-08-30: a one-character mutation to `ledger.mjs`'s verdict
// expression, run and reverted inside a single tool call, was read mid-window
// by a concurrent `/fleet:run-team` controller's `instruments.sh` gate, which
// refused (`instrument set CHANGED under this run`). The guard was correct —
// it exists to catch exactly that — and the tree was already clean by the time
// a human-paced follow-up looked, which cost that run an investigation and two
// incorrect comments before it self-corrected. So "restore it promptly" is not
// the remedy: the exposure is an instant, and one tool call is wide enough.
//
// WHY THE RULE LIVES IN `CLAUDE.md` AND NOT IN THE SKILL THAT PRESCRIBES THE
// STEP: the step is `/triage`'s "3. Verify the claim", and that skill is
// `~/.agents/skills/triage/SKILL.md` — outside this repo, outside any git
// repo, vendored from `mattpocock/skills` and pinned by hash in
// `~/.agents/.skill-lock.json` (installed 2026-04-30, updated 2026-08-11), so
// an edit there is unversioned here and is reverted by the next skill
// update — reason enough on its own, no precedent needed. `docs/agents/issue-tracker.md`
// is the wrong home for the opposite reason, recorded in
// `issue-tracker-prose.test.mjs`'s own header: nothing routes a reader there,
// it is a catch-up copy. Root `CLAUDE.md` is auto-loaded into every session in
// this repo, so the rule is in the reader's context at the moment the step
// tells them to verify — which is the acceptance criterion this placement is
// answering, not a fallback.
//
// SHAPE, and why each pin is one exact contiguous span rather than several
// matches on the same slice: every rule here is a JOIN — a mutation bound to
// its location, a location bound to its reason, a prohibition bound to the
// transience it refuses to excuse — and N independent matches pin N facts and
// never the text between them, so a clause spliced into a join reverses the
// rule with every token an assertion wants still present. `phrase()` rebuilds
// each span with `\s+` between words, which is what keeps an exact-span pin
// from reddening on a reflow; "a reflowed section still matches" below is what
// holds that open.
//
// THE CEILING: these prove the three clauses are PRESENT and unspliced. They
// cannot prove the rule is not negated by a sentence added elsewhere in the
// section, and they say nothing about whether a reader obeys it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..", "..");
const CLAUDE = readFileSync(join(REPO, "CLAUDE.md"), "utf8");

// Bounded at both ends. Run to EOF and the domain-docs section below, plus any
// section a later edit appends, supplies enough prose to satisfy a loose
// assertion with this section deleted outright; the next `###` is the
// boundary, and `between()` reddens loudly if either anchor goes stale rather
// than widening the slice.
//
// Flattened, not raw: an editor may rewrap this paragraph at any width, so
// every assertion below runs against the flattened text and is reflow-safe.
const section = (text = CLAUDE) =>
  between(text, "### Verifying a claim", "\n### ", "CLAUDE.md")
    .split(/\s+/)
    .join(" ");

// Positive control. An equality-free suite of `match` assertions is exactly
// the shape that passes on a slice that has degenerated to its own heading,
// and a stale-but-still-findable anchor pair is how it would get there.
test("the section slice is more than its own heading", () => {
  assert.ok(section().length > 300, "the slice collapsed to (near) its heading — the extractor is broken, not the docs");
});

test("the rule binds the mutation to a scratch copy, bars the shared tree, and carries its reason in the same span", () => {
  // Three facts that are worthless apart: "use a scratch copy" without the
  // prohibition reads as one option among several; the prohibition without
  // the reason is a rule a reader talks themselves out of; the reason without
  // either is trivia. Asserted whole so a spliced exception ("never in this
  // shared working tree, unless you restore it in the same tool call,
  // because…") reddens rather than sliding between separate matches.
  assert.match(
    section(),
    phrase(
      "that edit goes in a scratch copy, never in this shared working tree, because a concurrent session may be reading it",
    ),
  );
});

test("the rule refuses prompt restoration as compliance and says why in the same breath", () => {
  // The clause the incident exists to install. Without it a reader concludes
  // that mutating and reverting inside one tool call is compliant — which is
  // precisely what was done on 2026-08-30 and precisely what the concurrent
  // gate caught. Pinning "not enough" apart from "a single tool call is a
  // wide enough window" would leave a swap green: a window declared narrow
  // enough to be safe still matches both halves.
  assert.match(
    section(),
    phrase(
      "Restoring it quickly is not enough: the exposure is an instant, and a single tool call is a wide enough window",
    ),
  );
});

test("the rule exempts read-only verification instead of leaving it to inference", () => {
  // The carve-out is load-bearing in the OTHER direction: a rule stated
  // without it reads as "copy the tree before you verify anything", and a
  // reader who believes that pays the copy on every suite run and grep. The
  // exemption and the instances it covers are one span, so deleting the list
  // and keeping the sentence — or keeping the list and dropping "needs no
  // copy" — reddens.
  assert.match(
    section(),
    phrase(
      "Read-only verification — running the suite unmodified, grepping, reading a diff — touches nothing and needs no copy",
    ),
  );
});

test("a reflowed section still matches", () => {
  // The ACCEPT direction, and the only thing here proving the exact-span pins
  // discriminate content rather than layout. A pin that reddened on a rewrap
  // would be loosened by the next person who reflowed this paragraph, and a
  // loosened span pin is the vacuous keyword pin this shape exists to avoid.
  //
  // The rewrap is DERIVED from the section's own body, re-broken at every word
  // boundary — the most extreme reflow there is — never a hardcoded
  // before/after pair, and never read off a single physical line. Two measured
  // false reds drove that, both of them an incidental fixture collision
  // presenting as a content failure, which is the exact confusion this control
  // exists to rule out:
  //
  //   1. A literal pair (`"never in this shared working tree, because"` ->
  //      those words wrapped) reds on a BENIGN rewrap of that very sentence:
  //      the literal is then absent, and the staleness assert fires.
  //   2. Reading the paragraph as `split("\n")[0]` reds once the paragraph is
  //      wrapped at all, because the first physical line is then a fragment.
  //
  // Splitting the body on `\s+` is immune to both: it cannot go stale against
  // a reword it never names, and it does not care how the source is wrapped.
  // The headings are left alone on purpose — `between()` finds its anchors by
  // literal `indexOf`, so rewrapping those would fail the slice rather than
  // exercise the pins.
  const HEAD = "### Verifying a claim";
  const at = CLAUDE.indexOf(HEAD);
  assert.notEqual(at, -1, `'${HEAD}' moved — update this test`);
  const stop = CLAUDE.indexOf("\n### ", at + HEAD.length);
  assert.notEqual(stop, -1, "the section lost the sibling heading that bounds it — update this test");
  const body = CLAUDE.slice(at + HEAD.length, stop).split(/\s+/).filter(Boolean);
  const rewrapped = CLAUDE.slice(0, at + HEAD.length) + "\n\n" + body.join("\n  ") + CLAUDE.slice(stop);
  // The fixture has to actually break the pinned span across lines, or this
  // control passes while proving nothing about layout.
  assert.match(rewrapped, /scratch\n\s+copy/, "the derived rewrap left the pinned span on one line — it proves nothing");
  assert.match(
    section(rewrapped),
    phrase("that edit goes in a scratch copy, never in this shared working tree, because a concurrent session may be reading it"),
  );
});
