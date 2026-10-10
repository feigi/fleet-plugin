// The `=`-token parser (#1799, spec 2026-09-24 § 6 §2). Everything that
// derives liveness from the ledger reads a member's state off its token, so
// what this parser claims — and what it declines to claim — is the whole
// contract: a token it misreads is a member counted live forever, or a live
// one counted gone.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseMember, parseToken, memberTokens, rowPr, premisesOf, nextMergeBot, escapeText, unescapeText, expectedDefinition, agentDefinition, MEMBER_FAMILIES, CELL, CELL_DEF, drawCell } from "../plugin/scripts/ledger-grammar.mjs";

// Every outcome word the spec names, per family, verbatim — the must-ACCEPT
// half. A parser that refused everything would pass every refusal below.
const VOCABULARY = [
  ["impl-412", ["PR#420", "bailed", "released", "killed", "tier-mismatch"]],
  ["fix-pr-346", ["applied:73b356de", "applied:73b356de0123456789abcdef0123456789abcdef", "no-op", "failed", "killed"]],
  ["finisher-pr-346", [
    "labelled", "failed", "killed",
    "halted:live-editor", "halted:rebase", "halted:past-pin", "halted:unreadable", "halted:missing", "halted:absent", "halted:other",
  ]],
  ["merge-bot-2", ["done", "killed"]],
];

test("a bare member token is live, and names its family, number and binding", () => {
  assert.deepEqual(parseToken("impl-412"), {
    name: "impl-412", family: "impl", number: 412, retry: null, bound: "ticket", outcome: null, error: null,
  });
  assert.deepEqual(parseToken("fix-pr-346"), {
    name: "fix-pr-346", family: "fix-pr", number: 346, retry: null, bound: "pr", outcome: null, error: null,
  });
  assert.deepEqual(parseToken("finisher-pr-346"), {
    name: "finisher-pr-346", family: "finisher-pr", number: 346, retry: null, bound: "pr", outcome: null, error: null,
  });
  assert.deepEqual(parseToken("merge-bot-3"), {
    name: "merge-bot-3", family: "merge-bot", number: 3, retry: null, bound: null, outcome: null, error: null,
  });
});

// "Replacement members (`-b`) get their own token": the suffix is part of the
// name, so `impl-412-b` settles apart from `impl-412` while working the same
// ticket. `retry` carries the suffix letter on its own, so a reader ordering
// a ticket's attempts reads it here rather than re-parsing the name.
test("a replacement member's retry suffix is its own token, bound to the same number", () => {
  const b = parseToken("impl-412-b");
  assert.equal(b.name, "impl-412-b");
  assert.equal(b.number, 412);
  assert.equal(b.retry, "b");
  const c = parseToken("fix-pr-346-c=no-op");
  assert.equal(c.name, "fix-pr-346-c");
  assert.equal(c.retry, "c");
  assert.equal(parseToken("finisher-pr-346-b").family, "finisher-pr");
});

test("every outcome in the spec's vocabulary settles its own family", () => {
  for (const [member, outcomes] of VOCABULARY) {
    for (const outcome of outcomes) {
      const t = parseToken(`${member}=${outcome}`);
      assert.equal(t?.error, null, `${member}=${outcome} must parse: ${t?.error}`);
      assert.equal(t.name, member);
      assert.equal(t.outcome, outcome);
    }
  }
});

test("an outcome from another family's vocabulary, or none at all, is refused by name", () => {
  const refused = [
    ["impl-412=done", /expected PR#M \| bailed \| released \| killed \| tier-mismatch/],
    ["impl-412=labelled", /not an outcome of impl-N/],
    ["impl-412=", /'' is not an outcome of impl-N/],
    ["impl-412=PR#", /not an outcome of impl-N/],
    ["impl-412=#420", /not an outcome of impl-N/],
    ["impl-412=PR#420=x", /not an outcome of impl-N/],
    ["fix-pr-346=applied", /expected applied:<head> \| no-op \| failed \| killed/],
    ["fix-pr-346=applied:", /not an outcome of fix-pr-M/],
    ["fix-pr-346=applied:not-a-sha", /not an outcome of fix-pr-M/],
    // The hex-length bounds themselves (7 to 40 inclusive): one hex char
    // short of and one over the accepted range, so a bound loosened by one
    // either way is caught rather than passing on the interior cases alone.
    ["fix-pr-346=applied:abc123", /not an outcome of fix-pr-M/],
    ["fix-pr-346=applied:73b356de0123456789abcdef0123456789abcdef0", /not an outcome of fix-pr-M/],
    ["fix-pr-346=bailed", /not an outcome of fix-pr-M/],
    ["finisher-pr-346=done", /expected labelled \| failed \| killed \| halted:<cause>/],
    // #2083: a halt names one of the seven causes — a bare `halted`, an
    // unknown cause, a cause with trailing text, or a cause in another case
    // is not a halt the controller has a rule for.
    ["finisher-pr-346=halted", /expected labelled \| failed \| killed \| halted:<cause>/],
    ["finisher-pr-346=halted:", /not an outcome of finisher-pr-M/],
    ["finisher-pr-346=halted:bogus", /expected labelled \| failed \| killed \| halted:<cause>/],
    ["finisher-pr-346=halted:past-pin:x", /not an outcome of finisher-pr-M/],
    ["finisher-pr-346=halted:Rebase", /not an outcome of finisher-pr-M/],
    ["fix-pr-346=halted:rebase", /not an outcome of fix-pr-M/],
    ["merge-bot-2=labelled", /expected done \| killed/],
    ["merge-bot-2=PR#5", /not an outcome of merge-bot-n/],
  ];
  for (const [token, why] of refused) {
    const t = parseToken(token);
    assert.ok(t, `${token}: still a member token — its error is the answer, not silence`);
    assert.match(t.error ?? "", why, `${token}: got ${JSON.stringify(t.error)}`);
  }
});

// The other `=`-tokens a real row carries (`class=`, `ports=`, `ci=`, and
// #1773's `review=`/`reviewed=` pair) are not members, and neither are the
// merge holds nor anything that only resembles one. Claiming any of
// them would count a phantom member live.
test("tokens that are not members are not claimed", () => {
  for (const token of [
    "#412", "→", "·", "PR#344", "MERGED", "73b356de", "class=routine", "ports=16324", "ci=123:1:success",
    "review=wf:abc123", "review=member:review-pr-346", "reviewed=73b356de:3/1/0", "held-behind:#313",
    // `conflict-hold-346` — no `#` — is the fixture that actually matters:
    // it is a real CONFLICT_HOLD spelling (`#?` is optional there) AND the
    // exact shape MEMBER would also accept if its family alternation ever
    // grew a careless `conflict-hold` entry. The other two spellings below
    // carry a literal `#` where MEMBER wants a digit, so they would stay
    // unclaimed even under that mutation — this one does not.
    "conflict-hold:#346", "conflict-hold-#346", "conflict-hold-346",
    "ruled:6-applies", "review-pr-346", "impl", "impl-", "impl-0", "impl-0412", "impl-412x", "impl-412-bb",
    "impl-412-B", "merge-bot", "merge-bot-3-b", "fix-pr-", "finisher-346",
  ]) {
    assert.equal(parseToken(token), null, `${token} must not parse as a member token`);
  }
});

test("memberTokens reads a row's members in order and skips its free text", () => {
  const row = "#324 impl-324=PR#346 → PR#346 · fix-pr-346 · class=routine · ports=16324 · ruled:6-applies · held-behind:#313";
  assert.deepEqual(
    memberTokens(row).map((t) => [t.name, t.outcome]),
    [["impl-324", "PR#346"], ["fix-pr-346", null]],
  );
  assert.deepEqual(memberTokens("#7 nothing member-shaped here"), []);
});

test("rowPr: an impl row is its first settled =PR#M token's PR; any other row its first PR# mention", () => {
  // An impl token, malformed included, gates out every prose mention.
  assert.equal(rowPr("#480 → PR#481 · impl-480=PR#470"), 470);
  assert.equal(rowPr("#480 impl-480=bailed · PR#481"), null);
  assert.equal(rowPr("#480 impl-480=PR#0470 · PR#481"), null);
  assert.equal(rowPr("#480 impl-480=PR#470 · impl-480-b=PR#471"), 470);
  assert.equal(rowPr("#480 impl-480-b=PR#471 · impl-480=PR#470"), 471, "row order, as a first-mention scan read it");
  // No impl token: the first mention, spelled with or without a space.
  assert.equal(rowPr("#40 PR #44 · PR#45"), 44);
  assert.equal(rowPr("#40 fix-pr-44 · APR#44"), null, "a mention inside a longer word is none");
  assert.equal(rowPr("#350 review=wf:x"), null);
});

test("premisesOf: an Exclusion row's premises in row order, null for any other row", () => {
  assert.equal(premisesOf("#7 impl-7=PR#9"), null);
  assert.equal(premisesOf("#7 impl-7 · excluded · behind-pr:#880"), null, "excluded must be the text's first word");
  assert.equal(premisesOf("#7 excludedx · behind-pr:#880"), null);
  assert.deepEqual(premisesOf("#7 excluded"), []);
  assert.deepEqual(premisesOf("#7 excluded · conflicts with something"), []);
  assert.deepEqual(premisesOf("#7 excluded · xbehind-pr:#5"), [], "a premise token embedded in a longer word is not a premise");
  assert.deepEqual(
    premisesOf("#7 excluded · behind-issue:#12, behind-pr:implementer/1715-impl-1715; behind-pr:880"),
    [{ kind: "issue", target: "12" }, { kind: "pr", target: "implementer/1715-impl-1715" }, { kind: "pr", target: "880" }],
  );
});

test("escapeText/unescapeText round-trip a literal backslash and a newline, and keep one entry on one line", () => {
  const entry = "a\\nb\n\\\\ ## Filed\\";
  assert.equal(unescapeText(escapeText(entry)), entry);
  assert.equal(escapeText(entry).includes("\n"), false);
  assert.equal(escapeText("a\\b"), "a\\\\b");
  assert.equal(unescapeText("a\\\\nb"), "a\\nb", "an escaped backslash before n stays a backslash and an n");
});

// "n = 1 + the number of `merge-bot-` entries" — settled ones included, since
// a dead bot's replacement "gets a new n", and other families never counted.
test("nextMergeBot counts every merge-bot entry, live or settled, and nothing else", () => {
  assert.equal(nextMergeBot([]), "merge-bot-1");
  assert.equal(nextMergeBot(["impl-412", "fix-pr-346=no-op", "finisher-pr-346"]), "merge-bot-1");
  assert.equal(nextMergeBot(["impl-412", "merge-bot-1=done", "fix-pr-346", "merge-bot-2=killed", "merge-bot-3"]), "merge-bot-4");
  // A malformed entry is not a merge-bot entry, however much it starts like
  // one: counting by prefix instead of by parseToken() inflated n past what
  // ## Dispatched's real entries justify (measured: merge-bot-3, not -2).
  assert.equal(nextMergeBot(["merge-bot-1=done", "merge-bot-2x-garbage"]), "merge-bot-2");
});

test("expectedDefinition refuses a tier= it cannot name one definition file by", () => {
  assert.throws(() => expectedDefinition("impl-7 · tier=alt · tier=slow-high"), /conflicting tier= tokens \(tier=alt, tier=slow-high\)/);
  assert.throws(() => expectedDefinition("impl-7 · tier=../../etc"), /is not a definition suffix/);
  // Lowercase only: on a case-insensitive filesystem `tier=Task-High` would
  // find fleet-implementer-task-high.agent.md, so the existence check
  // `ledger.mjs dispatch` adds cannot refuse a name no definition carries.
  assert.throws(() => expectedDefinition("impl-7 · tier=Task-High"), /tier=Task-High is not a definition suffix/);
  assert.equal(expectedDefinition("impl-7 · tier=task-high · tier=task-high"), "fleet-implementer-task-high");
});

// #2330: null is a review fix-applier's deliberate "generic `task`", so a
// family agentDefinition has no case for must throw, never read as one. This
// walks every family parseMember can yield (MEMBER is built from
// MEMBER_FAMILIES) — a family added to FAMILIES without a case here fails
// this test, not a dispatch.
test("agentDefinition names a definition for every member family, and throws on one it has no case for", () => {
  const agents = join(import.meta.dirname, "..", "plugin", "agents");
  for (const family of MEMBER_FAMILIES) {
    const member = parseMember(`${family}-7`);
    const definition = agentDefinition(member, "", true);
    assert.match(definition, /^fleet-/, `${family}: ${definition}`);
    // #2129 deleted the bare `fleet-implementer`: a name with no file behind
    // it is what `ledger.mjs dispatch` refuses, so an untiered impl row or a
    // conflict-hold fix-applier pointing at it would stop every such dispatch.
    assert.ok(existsSync(join(agents, `${definition}.agent.md`)), `${family}: ${definition} has no agents/${definition}.agent.md`);
  }
  // The must-ACCEPT half: the deliberate null is still null, not a throw.
  assert.equal(agentDefinition(parseMember("fix-pr-7"), "", false), null);
  assert.throws(
    () => agentDefinition({ name: "review-pr-7", family: "review-pr", number: 7 }, "", false),
    /no case for member family 'review-pr' \(review-pr-7\)/,
  );
});

test("CELL is <role>-<level> over omp's three roles and six levels; CELL_DEF is its definition name", () => {
  for (const cell of ["slow-high", "task-max", "smol-minimal", "slow-xhigh"]) {
    assert.ok(CELL.test(cell), cell);
    assert.ok(CELL_DEF.test(`fleet-implementer-${cell}`), cell);
  }
  for (const cell of ["alt", "default", "fast-high", "slow-ultra", "slow-high-x", "Slow-High", "high-slow"]) {
    assert.ok(!CELL.test(cell), cell);
    assert.ok(!CELL_DEF.test(`fleet-implementer-${cell}`), cell);
  }
  // The family has no bare member: nothing is named `fleet-implementer` alone.
  assert.ok(!CELL_DEF.test("fleet-implementer"));
  assert.ok(!CELL_DEF.test("xfleet-implementer-slow-high"));
});

const GRID = ["slow-high", "slow-medium", "task-high", "task-max", "smol-high"];
const SESSION = "01a0815e-e141-716c-b2d8-2adf310fbe55";

test("drawCell with every non-default cell withdrawn runs the policy cell at k = K = 0", () => {
  assert.deepEqual(drawCell({ session: SESSION, ticket: 2129, policyCell: "slow-high", cells: ["slow-high"] }), { cell: "slow-high", k: 0, K: 0 });
  assert.deepEqual(drawCell({ session: SESSION, ticket: 2129, policyCell: "slow-high", cells: [] }), { cell: "slow-high", k: 0, K: 0 });
});

test("drawCell is sha256(session\\tticket)[0:8] mod K over the sorted non-policy cells", () => {
  // Golden: sha256("<SESSION>\t2129") starts 6b9befca; 0x6b9befca % 4 = 2, so
  // k = 3 over [slow-medium, smol-high, task-high, task-max].
  assert.deepEqual(drawCell({ session: SESSION, ticket: 2129, policyCell: "slow-high", cells: GRID }), { cell: "task-high", k: 3, K: 4 });
  // The input order of `cells` is not an input: the draw sorts by token.
  assert.deepEqual(drawCell({ session: SESSION, ticket: 2129, policyCell: "slow-high", cells: [...GRID].reverse() }), { cell: "task-high", k: 3, K: 4 });
});

test("drawCell never draws the policy cell, reaches every other one, and with no policy cell draws over all", () => {
  const drawn = new Set();
  for (let ticket = 1; ticket <= 200; ticket++) {
    const { cell, k, K } = drawCell({ session: "s", ticket, policyCell: "slow-high", cells: GRID });
    assert.equal(K, 4);
    assert.ok(k >= 1 && k <= K, `k=${k}`);
    drawn.add(cell);
  }
  assert.deepEqual([...drawn].sort(), ["slow-medium", "smol-high", "task-high", "task-max"]);
  // Burn-in (spec § 4 R4) calls it with `policyCell: null`: nothing withheld.
  const burnIn = new Set();
  for (let ticket = 1; ticket <= 200; ticket++) {
    const { cell, K } = drawCell({ session: "s", ticket, policyCell: null, cells: GRID });
    assert.equal(K, 5);
    burnIn.add(cell);
  }
  assert.deepEqual([...burnIn].sort(), [...GRID].sort());
});
