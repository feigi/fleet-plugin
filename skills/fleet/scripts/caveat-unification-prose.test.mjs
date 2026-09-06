// #23. `next-ticket` and `sizing-a-ticket` both open by telling the reader to
// fetch a ticket with the same `gh issue view --json title,body,comments` form,
// and both then have to say which text wins and which wrong forms lose. Two
// different failure shapes, not one: the brief-outranks-body sentence was
// duplicated with nothing holding the copies together, though they read
// identically; the wrong-forms caveat was absent from `sizing-a-ticket`
// altogether.
//
// These pin AGREEMENT rather than a literal, so a deliberate reword applied to
// both files stays green while a reword applied to one reddens. That is the
// property the ticket asks for: not this wording, one wording.
//
// `run-team/SKILL.md` and `docs/agents/issue-tracker.md` are deliberately not
// compared here. `run-team`'s copy sits inside a verbatim subagent prompt that
// has to carry its own context and cannot reference anything, so it is prose
// for a different audience. `issue-tracker.md`'s brief-outranks-body rule is
// pinned by `issue-tracker-prose.test.mjs` under #79 (the sibling `Respec`
// rule that test also pinned was dropped repo-wide by #25 — undefined,
// uninstanced, and redundant with brief-outranks-body), but its wrong-forms
// caveat is pinned by nothing, and is deliberately left that way here: the
// four-site decision #23's last comment asks for is not made in this ticket.
//
// THE CEILING: this proves the two clauses AGREE. It cannot prove either is
// correct — a wrong sentence written into both files agrees with itself and
// passes here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..", "..", "..");
const skill = (name) =>
  readFileSync(join(REPO, "skills", "fleet", "skills", name, "SKILL.md"), "utf8");

const NEXT = skill("next-ticket");
const SIZING = skill("sizing-a-ticket");

// Whitespace-insensitive, for the same reason `prose-pin.mjs`'s `phrase()` is:
// either file may hard-wrap its copy at any width, and a rewrap is not drift.
// Without this the pin refuses a pair whose prose is identical and whose line
// breaks are not — a wrong refusal, and the one this comparison could newly
// introduce. Normalized BEFORE `between` locates the anchors, not after it
// returns: `between` finds them with `indexOf` on literal text, so a wrap
// landing mid-anchor would redden the pin on the anchor itself, where no amount
// of normalizing the slice can help. Scoped to this file rather than pushed
// into `between`, whose other callers pass anchors chosen against raw layout.
const clause = (text, from, to, what) =>
  between(text.split(/\s+/).join(" "), from, to, what);

// Bounded at both ends: `between` asserts each anchor is present in each file,
// so a clause deleted from one side reddens on the missing anchor rather than
// comparing empty against empty and passing.
const caveat = (text, what) =>
  clause(text, "Not `--json body`", "silent loss).", what);
const brief = (text, what) =>
  clause(text, "`## Agent Brief` comment outranks body", ".", what);

test("both skills state the wrong-forms caveat in one wording", () => {
  // The half this ticket was filed for: the sizing skill carried the read
  // command with no caveat at all, so a reader of that entry point never
  // learned that bare `--comments` drops the title and body at exit 0.
  assert.equal(caveat(SIZING, "sizing-a-ticket"), caveat(NEXT, "next-ticket"));
});

test("both skills state the brief-outranks-body rules in one wording", () => {
  // These agree today. Nothing held them there, and the caveat above shows what
  // an unpinned sibling pair does over time.
  assert.equal(brief(SIZING, "sizing-a-ticket"), brief(NEXT, "next-ticket"));
});

// Each rewrap asserts it changed something: chained blindly, a fixture whose
// source sentence was reworded silently stops rewrapping and the test goes on
// passing against unwrapped prose.
const rewrap = (text, at, into) => {
  const out = text.replace(at, into);
  assert.notEqual(out, text, `the rewrap fixture no longer matches the file at "${at}" — update it`);
  return out;
};

test("a rewrapped copy still counts as agreement", () => {
  // The accept case for the normalization above. Feeding the comparison prose
  // it MUST accept is the only thing that pins reflow-safety; a suite of
  // already-agreeing single-line inputs would pass with the normalization
  // deleted.
  // Two breaks, because they fail differently: one inside the slice, and one
  // ACROSS the `to` anchor — the second is the case a slice-only normalization
  // cannot survive, so a fixture that only ever wraps between the anchors
  // passes with the anchors still wrap-brittle.
  const rewrapped = rewrap(
    rewrap(SIZING, "Not `--json body` (body only,", "Not `--json body`\n  (body   only,"),
    "exit 0 — silent loss).",
    "exit 0 — silent\n  loss).",
  );
  assert.equal(caveat(rewrapped, "rewrapped sizing-a-ticket"), caveat(NEXT, "next-ticket"));
});
