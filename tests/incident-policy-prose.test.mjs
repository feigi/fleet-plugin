// Pins `docs/agents/incident-policy.md` and the three places that point at it.
// The policy's whole content is an ORDER: a member-reliability incident closes
// with a script, else a schema field, else a tick row or hold, else a brief
// template line, and prose only for a judgement. A page that names the same
// four mechanisms in another order states a different policy and reads just as
// complete, so the pin binds each mechanism to its numeral AND the numerals to
// their sequence (a mutant that moves an item to the top and leaves its
// numeral standing keeps every numbered phrase present).
//
// `AGENTS.md` is where an agent working in this repo meets the policy; a page
// nobody links is not a policy, so the link is pinned in the heading's own
// section, not anywhere in the file.
//
// Each check is a function of its slice, run on the real file and on mutants:
// the swap and the dropped link must go red, a reflow and an appended sentence
// must stay green. THE CEILING of prose pins applies: a negating sentence added
// beside an intact span stays green.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Pin } from "./support/prose-pin.mjs";

const REPO = join(import.meta.dirname, "..");
const PAGE = Pin.file(join(REPO, "docs", "agents", "incident-policy.md"));
const AGENTS = Pin.file(join(REPO, "AGENTS.md"));
const TRIAGE = Pin.file(join(REPO, "docs", "agents", "triage-labels.md"));
const TRACKER = Pin.file(join(REPO, "docs", "agents", "issue-tracker.md"));

const PAGE_PATH = "`docs/agents/incident-policy.md`";

const ORDER = [
  "1. A script that refuses or does the duty.",
  "2. A schema field a settle checks.",
  "3. A tick row or hold.",
  "4. A brief template line.",
];

// The closing-order section, each mechanism at its own numeral and the
// numerals in sequence.
function checkOrder(page) {
  const text = Pin.unemphasized(page.section("## How an incident closes", "the closing-order section").text);
  assert.match(text, Pin.phrase("In order of preference:"), "the closing order no longer says it is an order of preference");
  let last = -1;
  for (const item of ORDER) {
    const hit = text.match(Pin.phrase(item));
    assert.ok(hit, `the closing order no longer says "${item}" — mechanism and numeral are one span`);
    assert.ok(hit.index > last, `"${item}" is out of sequence — the order of preference is the policy`);
    last = hit.index;
  }
}

function checkLink(agents) {
  const s = agents.section("## Incident policy", "the AGENTS.md incident section");
  assert.match(s.text, Pin.phrase(PAGE_PATH), "AGENTS.md's incident section no longer links the policy page");
}

// Exchange the two mechanisms' titles, leaving each numeral where it stands.
const swapTitles = (text, a, b) => {
  assert.ok(text.includes(a) && text.includes(b), "mutation anchors moved");
  return text.replace(a, "\u0000").replace(b, a).replace("\u0000", b);
};

test("the policy page has its four sections", () => {
  for (const h of [
    "## What a member-reliability incident is",
    "## How an incident closes",
    "## What an incident ticket carries",
    "## Where the policy comes from",
  ]) {
    assert.ok(PAGE.section(h, `the policy page's "${h}" section`).text.length > h.length, `${h} is empty`);
  }
});

test("the incident definition carries the four shapes, each with its tracker example", () => {
  const def = PAGE.section("## What a member-reliability incident is", "the definition section");
  const shapes = [
    ["**A duty skipped.**", "#2331"],
    ["**A report lost.**", "`plugin/skills/run-team/references/member-lifecycle.md`"],
    ["**A step run out of order or twice.**", "#3047"],
    ["**A brief missing, or contradicting, a line.**", "#2884"],
  ];
  shapes.forEach(([shape, example], i) => {
    const next = shapes[i + 1];
    const bullet = def.bullet(`- ${shape}`, next ? `\n- ${next[0]}` : "\n\n", `the ${shape} bullet`).text;
    assert.ok(bullet.includes(example), `the ${shape} bullet no longer cites ${example}`);
  });
});

test("the closing order names the four mechanisms in order", () => {
  checkOrder(PAGE);
});

test("prose closes an incident only for a judgement no script can take", () => {
  const s = PAGE.section("## How an incident closes", "the closing-order section").text;
  assert.match(
    s,
    Pin.phrase("Prose in `run-team/SKILL.md` closes an incident only when the action is a judgement no script can take."),
    "the page no longer limits prose to a judgement no script can take",
  );
  assert.match(s, Pin.phrase("states the judgement and nothing else"), "the page no longer says the prose states the judgement and nothing else");
});

test("the ticket section names the Mechanism line and its judgement form", () => {
  const s = PAGE.section("## What an incident ticket carries", "the ticket section").text;
  assert.match(s, Pin.phrase("A `Mechanism:` line in its body"), "the ticket section no longer asks for a `Mechanism:` line");
  assert.match(s, Pin.phrase("`judgement` followed by the question the controller must answer"), "the ticket section lost the judgement form");
});

test("the series pointer names the six 2026-10-13 specs by issue number", () => {
  const s = PAGE.section("## Where the policy comes from", "the series section").text;
  for (const n of ["#3177", "#3178", "#3179", "#3180", "#3181", "#3182"]) assert.ok(s.includes(n), `the series pointer lost ${n}`);
});

test("AGENTS.md links the policy page under its own heading", () => {
  checkLink(AGENTS);
});

test("triage-labels.md files an incident ticket without a Mechanism line as needs-triage", () => {
  const g = TRIAGE.between("**Filing time.**", "\n\n", "the filing-time gloss").text;
  assert.match(
    g,
    Pin.phrase("An incident ticket without a `Mechanism:` line is `needs-triage`"),
    "the filing-time gloss no longer files an incident ticket without a `Mechanism:` line as `needs-triage`",
  );
});

test("issue-tracker.md asks the filer for a Mechanism line under Create an issue", () => {
  const b = TRACKER.between("- **Create an issue**", "- **Read an issue**", "the Create an issue convention").text;
  assert.match(b, Pin.phrase("carries a `Mechanism:` line in its body"), "the Create an issue convention no longer asks for a `Mechanism:` line");
});

test("MUTANT: swapping two mechanisms' order goes red", () => {
  const mutant = swapTitles(PAGE.text, "**A script that refuses or does the duty.**", "**A schema field a settle checks.**");
  assert.throws(() => checkOrder(Pin.of(mutant, "mutant: items 1 and 2 swapped")), /closing order|out of sequence/);
});

test("MUTANT: moving an item up with its numeral left standing goes red", () => {
  const lines = PAGE.text.split("\n");
  const at = lines.findIndex((l) => l.startsWith("3. **A tick row or hold.**"));
  const item = lines.slice(at, at + 3);
  assert.ok(item.length === 3 && at !== -1, "mutation anchors moved");
  const rest = [...lines.slice(0, at), ...lines.slice(at + 3)];
  const first = rest.findIndex((l) => l.startsWith("1. **A script"));
  rest.splice(first, 0, ...item);
  assert.throws(() => checkOrder(Pin.of(rest.join("\n"), "mutant: item 3 hoisted")), /out of sequence|closing order/);
});

test("MUTANT: dropping the AGENTS.md link goes red", () => {
  const mutant = AGENTS.text.replace(PAGE_PATH, "the incident page");
  assert.notEqual(mutant, AGENTS.text, "mutation anchor moved");
  assert.throws(() => checkLink(Pin.of(mutant, "mutant: AGENTS.md without the link")), /no longer links/);
});

test("harmless changes stay green: a reflow and an appended sentence", () => {
  const reflowed = PAGE.text.replace("**A schema field a settle checks.**", "**A schema field a\n   settle checks.**");
  assert.notEqual(reflowed, PAGE.text, "mutation anchor moved");
  checkOrder(Pin.of(reflowed, "reflowed page"));
  checkOrder(Pin.of(`${PAGE.text}\nA sentence appended after the last section.\n`, "page with an appended sentence"));
  checkLink(Pin.of(`${AGENTS.text}\n## Another section\n\nUnrelated prose.\n`, "AGENTS.md with another section"));
});
