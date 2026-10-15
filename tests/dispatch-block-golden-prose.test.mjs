// What a member RECEIVES, pinned whole. A member's context is two texts: its
// agent body, which the harness injects as the system prompt, and the brief
// `dispatch-prompt.mjs render <role> [--kind <kind>]` prints for it, which is
// the `task` call's prompt. Nothing else reaches it — run-team/SKILL.md carries
// no copy of either for the controller to paste. So this file holds each of the
// two against a known-good copy it owns:
//
//   tests/fixtures/briefs/<role>[-<kind>].md      the rendered brief, for the
//                                                 fixed argument set of
//                                                 support/render-brief.mjs
//   tests/fixtures/briefs/bodies/<agent>.md       the agent body, frontmatter
//                                                 excluded; the implementer
//                                                 cells carry one body and
//                                                 share one fixture
//
// The presence pins beside this file — dispatch-block-pins-prose,
// member-prompt-prose, stash-prohibition-prose, fix-applier-correction-rules-
// prose — cover the LOCATION half: they render the member prompt and name WHICH
// rule was lost. They cannot see a sentence APPENDED inside a block, carving an
// exception out of a rule already pinned in it, nor a meaning-changing clause
// inserted MID-GAP between the two anchors of an `<anchor A>.{0,N}?<anchor B>`
// span. Both shapes were measured green against those pins; the controls below
// re-measure each against this file's equality.
//
// MECHANISM. Whole-text equality against a known-good copy, not a tighter
// regex: a blacklist (`/\bunless\b|\bexcept\b/i`) failed its own controls — it
// did not kill its mutant when scoped to the pinned sentence, four trivial
// rewordings survived when broadened, and it reds on a legitimate standing rule
// containing "unless". An LLM judge and a schema'd rule format were considered
// and rejected for a nondeterministic gate and a large change that still has to
// keep these texts readable as prose. What settles it is what the texts ARE:
// text whose whole purpose is reaching the member unchanged. The assertion that
// fits that is equality against a known-good copy.
//
// THE COST IS INTENDED. The expected text lives in a fixture, so a legitimate
// edit to a body or a template reds until its fixture is updated in the same
// change. These texts are change-controlled by construction, and that
// re-blessing is the review point a presence pin does not have. Every failure
// message says so and says where.
//
// THE FIXTURES ARE OWNED HERE, never derived from a template or a body at test
// time: a fixture read out of the file it checks compares that file to itself
// and asserts nothing.
//
// Wrapping is normalized away on both sides, and nothing else is. Every editor
// that touches a body reflows it, and a pin that reds on a rewrap is one the
// next person weakens or deletes. `**` emphasis, punctuation and word choice are
// NOT normalized: they are the verbatim text itself. Paragraph boundaries are
// kept — a line with no words on it is a break the member reads, so merging two
// paragraphs is a change and not a rewrap. NESTING DEPTH IS STRUCTURE: the
// fix-applier body quotes a refuter prompt inside itself, and un-nesting it
// changes what the fix-applier hands a refuter, so every `>` level is counted
// and re-emitted as a marker, relative to the text's own outermost level, which
// is also what makes the comparison reflow-proof.
//
// What each text must carry is the other half, and the coverage suite owns it:
// member-text-coverage.test.mjs fails a template or an agent body with no fixture
// here, and a sentence stated in more than one member-facing file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Pin } from "./support/prose-pin.mjs";
import { CASES, GOLDEN_DIR, agentBody, agentNames, bodyFixtureName, briefFixtureName, label, renderBrief } from "./support/render-brief.mjs";

const norm = (text) => {
  const rows = text.split("\n").map((line) => {
    const gutter = line.match(/^(?:>[ \t]?)*/)[0];
    return { depth: (gutter.match(/>/g) ?? []).length, words: line.slice(gutter.length).trim() };
  });
  const written = rows.filter((r) => r.words !== "");
  const base = written.length === 0 ? 0 : Math.min(...written.map((r) => r.depth));
  const paragraphs = [];
  for (const { depth, words } of rows) {
    const open = paragraphs[paragraphs.length - 1];
    if (words === "") {
      if (open) open.closed = true;
      continue;
    }
    if (open && !open.closed && open.depth === depth) open.words.push(words);
    else paragraphs.push({ depth, words: [words], closed: false });
  }
  return paragraphs
    .map((p) => `${"> ".repeat(Math.max(p.depth - base, 0))}${p.words.join(" ").split(/\s+/).join(" ")}`)
    .join("\n\n");
};

// Loud when a fixture is missing: a loader that returned "" would compare an
// empty fixture against whatever the text was, or against nothing.
const fixture = (rel) => {
  const path = join(GOLDEN_DIR, rel);
  if (!existsSync(path)) throw new Error(`no golden fixture at tests/fixtures/briefs/${rel} — bless one from the text it is meant to hold; this throws rather than comparing against nothing`);
  const text = readFileSync(path, "utf8");
  assert.notEqual(text.trim(), "", `tests/fixtures/briefs/${rel} is empty`);
  return text;
};

const reblessing = (what, rel) =>
  `${what} no longer matches its golden fixture. This text reaches a member VERBATIM and is change-controlled, so this red is a re-blessing point, not necessarily a defect: if you edited it on purpose, update tests/fixtures/briefs/${rel} in the SAME change. A pure re-wrap cannot cause this; wrapping is normalized away on both sides. If you did NOT edit it, a sentence or clause was added to it, which is what this fixture exists to catch.`;

// --- the rendered briefs ---------------------------------------------------

for (const c of CASES) {
  const rel = briefFixtureName(c);
  test(`${label(c)}'s rendered brief matches its golden fixture`, () => {
    assert.equal(norm(renderBrief(c.role, c.kind)), norm(fixture(rel)), reblessing(`${label(c)}'s rendered brief`, rel));
  });
}

// --- the agent bodies ------------------------------------------------------

for (const agent of agentNames()) {
  const rel = `bodies/${bodyFixtureName(agent)}`;
  test(`${agent}'s body matches its golden fixture`, () => {
    assert.equal(norm(agentBody(agent)), norm(fixture(rel)), reblessing(`${agent}'s body`, rel));
  });
}

// --- the controls: what this mechanism must ACCEPT, and what it must REFUSE ----

// Re-wrapped, one gutter depth at a time, so the fix-applier body's nested
// refuter prompt is re-wrapped as its own quote rather than having its inner `>`
// markers shuffled into the outer text. Wrapping at word boundaries, never one
// word per line: an unconditional break would split a block's own opener.
const rewrap = (text, width) =>
  text
    .split("\n")
    .reduce((groups, line) => {
      const gutter = line.match(/^(?:>[ \t]?)*/)[0];
      const depth = (gutter.match(/>/g) ?? []).length;
      const words = line.slice(gutter.length).trim();
      const last = groups[groups.length - 1];
      if (words !== "" && last && last.text.length > 0 && last.depth === depth) last.text.push(words);
      else groups.push({ gutter, depth, text: words === "" ? [] : [words] });
      return groups;
    }, [])
    .map(({ gutter, text: t }) => {
      const words = t.join(" ").split(/\s+/).filter(Boolean);
      if (words.length === 0) return gutter.trimEnd();
      return words
        .reduce((out, w) => {
          const tail = out[out.length - 1];
          if (tail !== undefined && `${tail} ${w}`.length <= width) out[out.length - 1] = `${tail} ${w}`;
          else out.push(w);
          return out;
        }, [])
        .map((l) => `${gutter}${l}`)
        .join("\n");
    })
    .join("\n");

// The ACCEPT side, and the half that decides whether this mechanism survives
// contact with an editor. Every text, not one: the fixtures were blessed at
// TODAY'S wrap points, so a `norm` that handled them by accident would pass a
// single-text control. The staleness guard is per text for the same reason.
test("a re-wrapped body or brief does not red — this mechanism refuses drift, not reflow", () => {
  const texts = [
    ...CASES.map((c) => [`${label(c)}'s rendered brief`, renderBrief(c.role, c.kind), fixture(briefFixtureName(c))]),
    ...agentNames().map((a) => [`${a}'s body`, agentBody(a), fixture(`bodies/${bodyFixtureName(a)}`)]),
  ];
  for (const [what, raw, golden] of texts) {
    const narrow = rewrap(raw, 45);
    assert.notEqual(narrow, raw, `the rewrap fixture no longer changes ${what}'s wrapping — it is already at or below 45 columns, so this control proves nothing about it`);
    assert.equal(norm(narrow), norm(golden), `${what} reds on a pure re-wrap — the words are identical and only the wrap points moved, so the normalization above is broken, not the text`);
  }
});

// The REFUSE side, mutant by mutant. Each entry is a carve-out appended right
// after the sentence it contradicts, keeping every word the presence pins
// match — the shape measured green against those pins. `after` is asserted to
// occur exactly once in the body, so a control that stops testing the measured
// insertion point says so instead of quietly moving to a different one.
const APPENDED = [
  { agent: "fleet-implementer-slow-high", after: "effectively unrecoverable.", carveOut: "A single commit at the end is fine when the diff is small." },
  { agent: "fleet-implementer-slow-high", after: "A green suite is evidence only about the paths it exercises.", carveOut: "Skip the enumeration entirely when the ticket names only one case." },
  { agent: "fleet-implementer-slow-high", after: "say which, and stop.", carveOut: "If the criterion looks close enough, implement it anyway." },
  { agent: "fleet-implementer-slow-high", after: "finds a line known to match.", carveOut: "Skip all of this when the ticket is a pure code change." },
  { agent: "fleet-implementer-slow-high", after: "bail, name the cause, do not implement.", carveOut: "Unless the tree looks tractable to you, in which case implement anyway." },
  { agent: "fleet-fix-applier", after: "manufacture a commit to make CI fire.", carveOut: "A commit is fine when CI is slow to start." },
  { agent: "fleet-finisher", after: "never a reason to skip it.", carveOut: "A named cause that looks harmless may be labelled over." },
  { agent: "fleet-merge-bot", after: "instead of arming your own watcher.", carveOut: "Arm your own watcher as well when the queue is long." },
];

test("a carve-out appended inside a body reds — the shape the presence pins cannot see", () => {
  for (const { agent, after, carveOut } of APPENDED) {
    const raw = agentBody(agent);
    // Located through `phrase()`: a sentence wraps wherever the body's editor
    // left it, and a literal anchor would stop finding it on a reflow.
    const anchor = new RegExp(Pin.phrase(after).source, "g");
    assert.equal([...raw.matchAll(anchor)].length, 1, `${agent}'s body no longer holds "${after}" exactly once — this mutant's measured insertion point moved`);
    const mutant = raw.replace(anchor, (hit) => `${hit} ${carveOut}`);
    assert.notEqual(mutant, raw, "the mutant is identical to the body — nothing was appended");
    assert.notEqual(
      norm(mutant),
      norm(fixture(`bodies/${bodyFixtureName(agent)}`)),
      `a carve-out appended after "${after}" in ${agent}'s body does not red its golden fixture — the mechanism is not seeing an insertion, which is the entire defect`,
    );
  }
});

// The second measured shape: a meaning-changing clause inserted strictly
// BETWEEN the two anchors of an ordered span, touching neither fragment.
// Located through `phrase()`, never a literal: the words sit two thirds of the
// way through a wrapped line, so a literal anchor stops finding them the moment
// the body is reflowed and the guard below would decline a control that should
// have run.
test("a clause inserted mid-gap reds — the second shape the gap-bounded spans absorb", () => {
  const raw = agentBody("fleet-implementer-slow-high");
  const midGap = "every member of that class (yes, even the boring ones) —";
  const mutant = raw.replace(Pin.phrase("every member of that class —"), () => midGap);
  assert.notEqual(mutant, raw, "the mid-gap insertion point moved — the clause was never inserted, so what follows would measure nothing");
  assert.notEqual(
    norm(mutant),
    norm(fixture(`bodies/${bodyFixtureName("fleet-implementer-slow-high")}`)),
    "a clause inserted between the enumerate pin's two anchors does not red its golden fixture — the gap tolerance that absorbs it is still the only thing reading this text",
  );
});

// A rendered brief refuses the same way: the templates are text too, and a line
// dropped from one never reaches a member. The mutation edits a COPY of the
// template the renderer reads, never the shipped file.
test("a line dropped from a template reds the rendered brief's golden fixture", () => {
  const dropped = "Push, write your report, exit; never poll a CI run.";
  const mutated = renderBrief("fix-applier", "review", {
    edit: (briefs) => {
      const path = join(briefs, "fix-applier.md");
      const text = readFileSync(path, "utf8");
      assert.ok(text.includes(dropped), "the line this control drops is gone from the template — move the control with it");
      writeFileSync(path, text.replace(dropped, ""));
    },
  });
  assert.notEqual(mutated, renderBrief("fix-applier", "review"), "the edit never reached the render — this control did not run");
  assert.notEqual(norm(mutated), norm(fixture("fix-applier-review.md")), "a line dropped from the template did not red the golden fixture");
});

// The loaders' loud half. A mechanism whose loader returns "" for a fixture it
// cannot find compares empty against empty, or against a fixture nobody
// blessed, and a DELETED fixture passes — the one failure that would make every
// test above vacuous.
test("a missing fixture throws, and an emptied body reds, instead of comparing against nothing", () => {
  assert.throws(() => fixture("bodies/not-an-agent.md"), /no golden fixture at tests\/fixtures\/briefs\/bodies\/not-an-agent\.md/);
  assert.notEqual(norm(""), norm(fixture(`bodies/${bodyFixtureName("fleet-finisher")}`)), "an emptied finisher body equals its golden fixture");
});
