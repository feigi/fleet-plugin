// #23. `next-ticket` and `sizing-a-ticket` both open by telling the reader to
// fetch a ticket with the same `gh issue view --json title,body,comments` form,
// and both then have to say which text wins and which wrong forms lose. Those
// sentences were stated once each, independently, so one fact had two wordings
// and only one of the two files carried the wrong-forms caveat at all.
//
// These pin AGREEMENT rather than a literal, so a deliberate reword applied to
// both files stays green while a reword applied to one reddens. That is the
// property the ticket asks for: not this wording, one wording.
//
// `run-team/SKILL.md` and `docs/agents/issue-tracker.md` are deliberately not
// compared here. `run-team`'s copy sits inside a verbatim subagent prompt that
// has to carry its own context and cannot reference anything, so it is prose
// for a different audience; `issue-tracker.md` is pinned for its own content by
// `issue-tracker-prose.test.mjs` under #79.
//
// THE CEILING, same as `issue-tracker-prose.test.mjs`: this proves the two
// clauses AGREE. It cannot prove either is correct — a wrong sentence written
// into both files agrees with itself and passes here.
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
// introduce.
const clause = (text, from, to, what) =>
  between(text, from, to, what).split(/\s+/).join(" ");

// Bounded at both ends: `between` asserts each anchor is present in each file,
// so a clause deleted from one side reddens on the missing anchor rather than
// comparing empty against empty and passing.
const caveat = (text, what) =>
  clause(text, "Not `--json body`", "silent loss).", what);
const brief = (text, what) =>
  clause(text, "`## Agent Brief` comment outranks body", "hypotheses body raises.", what);

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

test("a rewrapped copy still counts as agreement", () => {
  // The accept case for the normalization above. Feeding the comparison prose
  // it MUST accept is the only thing that pins reflow-safety; a suite of
  // already-agreeing single-line inputs would pass with the normalization
  // deleted.
  const rewrapped = SIZING.replace(
    "Not `--json body` (body only,",
    "Not `--json body`\n  (body   only,",
  );
  assert.notEqual(rewrapped, SIZING, "the rewrap fixture no longer matches the file — update it");
  assert.equal(caveat(rewrapped, "rewrapped sizing-a-ticket"), caveat(NEXT, "next-ticket"));
});
