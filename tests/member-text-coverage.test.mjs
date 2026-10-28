// What a member reads has two layers and each fact one owner: the agent body
// carries what never varies between dispatches of a role, the brief template
// carries what varies, and the command docs (review-and-fix.md, run-merge-bot.md)
// carry the procedures the bodies point at. Two checks keep that true.
//
//   COVERAGE. Every template under briefs/ — each of its kinds — and every
//   agent body has a golden fixture under tests/fixtures/briefs/, and no
//   fixture is an orphan. dispatch-block-golden-prose.test.mjs compares against
//   them; a template or body with no fixture is text a carve-out can be
//   appended to unseen.
//
//   DUPLICATION. A sentence (the text folded to single spaces, `>` gutters and
//   `**` dropped, split on `. `) that appears verbatim in more than one of
//   {agent body, brief template, review-and-fix.md, run-merge-bot.md} fails,
//   listing the files. The five implementer cells are one byte-identical body
//   and count once. A sentence shorter than seven words is a phrase, not a
//   fact, and is not counted.
//
// THE ALLOWLIST is by exact file set, each entry with its reason: a sentence
// shared by exactly those files is allowed, and a sentence shared by any other
// set of files — a copy into a third file included — fails. Each entry records a
// mirror that existed when this check landed and is held in step by the prose
// pin named beside it; removing a mirror removes its entry, and an entry that
// no sentence matches fails, so the list cannot outlive what it excuses. The
// `env $cfg sh ./probe.sh` instance SKILL.md's Shell traps names as the one
// deliberate copy sits in the first entry, the refuter prompt.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CASES, GOLDEN_DIR, PLUGIN, agentBody, agentNames, bodyFixtureName, briefFixtureName } from "./support/render-brief.mjs";

const BRIEFS = join(PLUGIN, "skills", "run-team", "briefs");
const COMMANDS = ["review-and-fix.md", "run-merge-bot.md"];

// --- coverage --------------------------------------------------------------

const templates = () => readdirSync(BRIEFS).filter((f) => f.endsWith(".md")).sort();
const kindsOf = (text) => [...new Set(text.split("\n").flatMap((l) => /^## kind: (.+)$/.exec(l)?.[1].split(",").map((k) => k.trim()) ?? []))];
const expectedBriefFixtures = () =>
  templates().flatMap((f) => {
    const role = f.slice(0, -3);
    const kinds = kindsOf(readFileSync(join(BRIEFS, f), "utf8"));
    return (kinds.length === 0 ? [null] : kinds).map((kind) => briefFixtureName({ role, kind }));
  });

test("every template, each of its kinds, has a golden fixture, and the fixed argument set renders it", () => {
  const want = expectedBriefFixtures();
  assert.ok(want.length > 0, "no templates found under briefs/");
  for (const name of want) assert.ok(existsSync(join(GOLDEN_DIR, name)), `briefs/ holds a template whose golden fixture tests/fixtures/briefs/${name} does not exist — bless one`);
  const cased = new Set(CASES.map(briefFixtureName));
  for (const name of want) assert.ok(cased.has(name), `${name} has no fixed argument set in support/render-brief.mjs, so nothing renders it`);
  const present = readdirSync(GOLDEN_DIR).filter((f) => f.endsWith(".md"));
  for (const f of present) assert.ok(want.includes(f), `tests/fixtures/briefs/${f} is the golden fixture of no template kind — delete it or restore the template`);
});

test("every agent body has a golden fixture, and no body fixture is an orphan", () => {
  const want = new Set(agentNames().map(bodyFixtureName));
  for (const name of want) assert.ok(existsSync(join(GOLDEN_DIR, "bodies", name)), `an agent body has no golden fixture tests/fixtures/briefs/bodies/${name} — bless one`);
  for (const f of readdirSync(join(GOLDEN_DIR, "bodies"))) assert.ok(want.has(f), `tests/fixtures/briefs/bodies/${f} is the golden fixture of no agent body`);
});

// --- duplication -----------------------------------------------------------

/** The sentences of a text: gutters and emphasis dropped, whitespace folded, split on `. `, the closing full stop of the last one dropped so a sentence has one key wherever it sits. */
function sentencesOf(text) {
  const folded = text.replace(/^[ \t]*(>[ \t]?)+/gm, "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
  return folded.split(". ").map((s) => s.trim().replace(/\.$/, "")).filter((s) => s.split(" ").length >= 7);
}

/** `{label, text}` for every file in the compared set. */
function sources() {
  const out = [];
  const seen = new Set();
  for (const agent of agentNames()) {
    const label = `agents/${bodyFixtureName(agent).replace(/\.md$/, "")}.agent.md`;
    if (seen.has(label)) continue;
    seen.add(label);
    out.push({ label, text: agentBody(agent) });
  }
  for (const f of templates()) {
    const text = readFileSync(join(BRIEFS, f), "utf8").split("\n---\n").slice(1).join("\n---\n").replace(/^## kind: .*$/gm, "");
    out.push({ label: `briefs/${f}`, text });
  }
  for (const f of COMMANDS) out.push({ label: `commands/${f}`, text: readFileSync(join(PLUGIN, "commands", f), "utf8") });
  return out;
}

/** Every sentence found in more than one source, grouped by the exact set of files that hold it. */
function sharedSentences(srcs) {
  const holders = new Map();
  for (const { label, text } of srcs) {
    for (const s of sentencesOf(text)) {
      if (!holders.has(s)) holders.set(s, new Set());
      holders.get(s).add(label);
    }
  }
  const groups = new Map();
  for (const [s, set] of holders) {
    if (set.size < 2) continue;
    const key = [...set].sort().join(" | ");
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  return groups;
}

const A = (n) => `agents/fleet-${n}.agent.md`;
const BRIEF = (n) => `briefs/${n}.md`;
const ALLOWED = [
  {
    files: [A("fix-applier"), "commands/review-and-fix.md"],
    reason: "the refuter prompt, handed to a refuter word for word from both seats (the `env $cfg sh ./probe.sh` line among it), and the rules around it; reporter-output-rule-prose and kill-rule-prose hold both copies",
  },
  {
    files: [A("finisher"), A("fix-applier"), A("review-tests"), A("review-verifier"), "commands/review-and-fix.md"],
    reason: "the kill rule — Valid red, Narrowed run, Kill and Evidence line — quoted word for word at every seat that scores a kill; kill-rule-prose holds every copy",
  },
  { files: [A("finisher"), A("fix-applier")], reason: "the Valid red sentence in the two members that carry the kill rule beside a longer sentence; kill-rule-prose" },
  { files: [BRIEF("finisher"), BRIEF("fix-applier"), BRIEF("implementer")], reason: "the report paragraph's closing line, the one shape every ledger-family member answers in, the exit-75 line and the pattern-kill prohibition carried by every member that runs a suite; report-schema holds the shape, suite-slot-prose pins the exit-75 line and run-team-no-member-blocks-prose the prohibition in each brief" },
  { files: [BRIEF("finisher"), BRIEF("fix-applier"), BRIEF("implementer"), BRIEF("merge-bot"), BRIEF("review-runner")], reason: "the no-acknowledgement line and the warnings-acted-on line, carried by every brief; run-team-no-member-blocks-prose pins each" },
  { files: [A("fix-applier"), A("implementer")], reason: "the session-root rule both members that write in a worktree carry; stash-prohibition-prose and dispatch-block-pins-prose pin each" },
  { files: [BRIEF("fix-applier"), BRIEF("implementer"), "commands/review-and-fix.md"], reason: "the after-the-commit tree comparison, its listing of the paths a hook re-staged, and the re-run or the stale-base route that listing picks, carried by every member-facing file that tells a member to run recipe-check.mjs before the commit (#3668); post-commit-tree-prose pins each" },
  { files: [A("review-comments"), A("review-tests"), A("review-types")], reason: "the specialists' model-route sentence" },
  { files: [A("review-comments"), A("review-types")], reason: "the specialists' model-route and pre-cutover sentences" },
  { files: [A("review-correctness"), A("review-simplify")], reason: "the specialists' model-route sentence" },
  { files: [A("review-correctness"), A("review-silent-failure")], reason: "the specialists' severity sentence" },
  { files: [A("review-comments"), A("review-correctness"), A("review-silent-failure"), A("review-tests"), A("review-types")], reason: "the specialists' structured-output sentence" },
  { files: [A("review-comments"), A("review-correctness"), A("review-silent-failure"), A("review-simplify"), A("review-tests"), A("review-types")], reason: "the specialists' read-only sentence" },
  { files: [A("review-snapshot"), A("review-test-run"), A("review-verifier")], reason: "the three review-host agents' provenance sentence" },
  { files: [A("finisher"), A("fix-applier"), A("implementer"), A("merge-bot"), BRIEF("fix-applier"), "commands/review-and-fix.md"], reason: "the one-sentence role rule every file that names a label carries, stated once near the top of its body; label-map-solo-prose pins it above the first role name of each" },
  { files: ["commands/review-and-fix.md", "commands/run-merge-bot.md"], reason: "the head-record sentence, beside the record in the one file that writes it and the one that parses it; label-map-member-prose and label-map-solo-prose pin each copy" },
];
const keyOf = (files) => [...files].sort().join(" | ");

test("no sentence is stated in more than one member-facing file, beyond the allowlist's exact file sets", () => {
  const groups = sharedSentences(sources());
  const allowed = new Set(ALLOWED.map((a) => keyOf(a.files)));
  const refused = [...groups].filter(([key]) => !allowed.has(key));
  assert.deepEqual(
    refused.map(([key, ss]) => `${key} — ${ss.length} sentence(s), first: ${JSON.stringify(ss[0].slice(0, 100))}`),
    [],
    "a sentence appears verbatim in more than one member-facing file. A fact has one owner: keep it in the file that owns it and delete the copy. If the copy is deliberate, add the file set to ALLOWED in member-text-coverage.test.mjs with its reason.",
  );
});

test("every allowlist entry still excuses a shared sentence, so the list cannot outlive its mirrors", () => {
  const groups = sharedSentences(sources());
  for (const { files, reason } of ALLOWED) {
    assert.ok(groups.has(keyOf(files)), `the allowlist excuses ${keyOf(files)} (${reason}) but no sentence is shared by exactly those files any more — delete the entry`);
  }
});

test("the duplication check reds on a sentence copied into a third file, and accepts a reflowed copy of an allowed one", () => {
  const srcs = sources();
  const allowed = new Set(ALLOWED.map((a) => keyOf(a.files)));
  const sentence = "No maintainer is reachable, no user will answer you, and no approval gate will ever clear for you";
  const owner = srcs.find((s) => s.label === A("implementer"));
  assert.ok(owner && sentencesOf(owner.text).some((s) => s.startsWith(sentence)), "the control's sentence is gone from the implementer body");
  // Copied into the merge bot's brief: a pair no entry excuses.
  const copied = srcs.map((s) => (s.label === BRIEF("merge-bot") ? { ...s, text: `${s.text}\n${sentence}. A different closing sentence follows it here.\n` } : s));
  const refused = [...sharedSentences(copied)].filter(([key]) => !allowed.has(key));
  assert.ok(refused.some(([key]) => key === keyOf([A("implementer"), BRIEF("merge-bot")])), "a sentence copied into a brief did not red");
  // Copied as the last sentence of the brief, closing full stop and nothing after it: the same sentence, the same pair.
  const closing = srcs.map((s) => (s.label === BRIEF("merge-bot") ? { ...s, text: `${s.text}\n${sentence}.\n` } : s));
  assert.ok([...sharedSentences(closing)].filter(([key]) => !allowed.has(key)).some(([key]) => key === keyOf([A("implementer"), BRIEF("merge-bot")])), "a sentence copied as a file's last sentence did not red");
  // The same text reflowed and gutter-quoted still counts as the same sentence.
  const reflowed = srcs.map((s) => (s.label === BRIEF("merge-bot") ? { ...s, text: `${s.text}\n> ${sentence.split(" ").join("\n> ")}. A different closing sentence follows it here.\n` } : s));
  assert.ok([...sharedSentences(reflowed)].some(([key]) => key === keyOf([A("implementer"), BRIEF("merge-bot")])), "a reflowed copy escaped the check");
  // A sentence a mirror already shares, reflowed in the same two files, is still the allowed set.
  assert.ok(sharedSentences(srcs).has(keyOf([A("fix-applier"), "commands/review-and-fix.md"])), "the refuter-prompt mirror is not seen at all");
});
