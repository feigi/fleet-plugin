// The `=`-token parser (#1799, spec 2026-09-24 § 6 §2). Everything that
// derives liveness from the ledger reads a member's state off its token, so
// what this parser claims — and what it declines to claim — is the whole
// contract: a token it misreads is a member counted live forever, or a live
// one counted gone.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parseMember, parseToken, memberTokens, rowPr, premisesOf, nextMergeBot, nextRetry, liveOnLedger, settledOnLedger, retiredOnLedger, isRetirable, readRetired, escapeText, unescapeText, expectedDefinition, agentDefinition, MEMBER_FAMILIES, CELL, CELL_DEF, drawCell, REVIEW, isReviewToken, parseDispatchedEntry, dispatchedEntry, memberRole, firstReview, prTokens, ledgerSection } from "../plugin/scripts/ledger-grammar.mjs";

// Every outcome word the spec names, per family, verbatim — the must-ACCEPT
// half. A parser that refused everything would pass every refusal below.
const VOCABULARY = [
  ["impl-412", ["PR#420", "bailed", "released", "killed", "tier-mismatch", "blocked"]],
  ["fix-pr-346", ["applied:73b356de", "applied:73b356de0123456789abcdef0123456789abcdef", "no-op", "failed", "killed"]],
  ["finisher-pr-346", [
    "labelled", "failed", "killed",
    "halted:live-editor", "halted:rebase", "halted:past-pin", "halted:unreadable", "halted:missing", "halted:absent", "halted:other", "halted:human",
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
    ["impl-412=done", /expected PR#M \| bailed \| released \| killed \| tier-mismatch \| blocked/],
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
    "review=wf:abc123", "review=member:review-pr-346", "reviewed=73b356de:3/1/0:run-73b356dr", "held-behind:#313",
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

// n = 1 + the highest `merge-bot-` entry — settled ones included, since a
// dead bot's replacement "gets a new n", and other families never counted.
// Within a run that is the count; across an ancestor rotate, which carries a
// live bot without its settled predecessors and retires them by name, the
// highest of either section is free.
test("nextMergeBot numbers past every merge-bot entry, live, settled or in the other names given, and nothing else", () => {
  assert.equal(nextMergeBot([]), "merge-bot-1");
  assert.equal(nextMergeBot(["impl-412", "fix-pr-346=no-op", "finisher-pr-346"]), "merge-bot-1");
  assert.equal(nextMergeBot(["impl-412", "merge-bot-1=done", "fix-pr-346", "merge-bot-2=killed", "merge-bot-3"]), "merge-bot-4");
  assert.equal(nextMergeBot(["merge-bot-2"]), "merge-bot-3", "a carried merge-bot-2 alone must not hand out its own name");
  assert.equal(nextMergeBot([], ["impl-9", "merge-bot-1"]), "merge-bot-2", "a retired bot's number is taken");
  assert.equal(nextMergeBot(["merge-bot-4"], ["merge-bot-2"]), "merge-bot-5", "the highest of either list");
  // A malformed entry is not a merge-bot entry, however much it starts like
  // one: counting by prefix instead of by parseToken() inflated n past what
  // ## Dispatched's real entries justify (measured: merge-bot-3, not -2).
  assert.equal(nextMergeBot(["merge-bot-1=done", "merge-bot-2x-garbage"]), "merge-bot-2");
  assert.equal(nextMergeBot([], ["merge-bot-2x-garbage", "merge-bot-1=done"]), "merge-bot-1", "a retired entry is a bare name");
});

// What the new ledger carries, as retiredOnLedger() takes it: the texts of the
// rows liveOnLedger() picked, and its `## Dispatched` entries.
const carriedBy = (rows, live) => ({ rows: live.rows.map((i) => rows[i]), dispatched: live.dispatched });

// What a ledger that carries nothing passes as `carried`.
const none = { rows: [], dispatched: [] };

test("retiredOnLedger: every settled name liveOnLedger leaves behind, the prior ## Retired first, once each", () => {
  const rows = [
    "#3 impl-3=PR#5 → PR#5 · fix-pr-5",
    "#9 impl-9=PR#10 → PR#10 · finisher-pr-10=labelled",
    "#11 impl-11-b=bailed",
  ];
  const dispatched = ["impl-3=PR#5", "fix-pr-5", "impl-9=PR#10", "finisher-pr-10=labelled", "impl-11=killed", "merge-bot-1=done", "merge-bot-2x-garbage"];
  const live = liveOnLedger(rows, dispatched);
  assert.deepEqual(live.dispatched, ["impl-3=PR#5", "fix-pr-5"]);
  assert.deepEqual(retiredOnLedger(rows, dispatched, ["impl-1", "impl-9"], carriedBy(rows, live)),
    ["impl-1", "impl-9", "finisher-pr-10", "impl-11", "merge-bot-1", "impl-11-b"]);
  // A carried row's settled tokens and a carried settled entry stay in
  // their sections and are not retired alongside.
  assert.ok(!retiredOnLedger(rows, dispatched, [], carriedBy(rows, live)).includes("impl-3"));
});

test("retiredOnLedger: a settled token on a carried row is on the new ledger already, whether or not ## Dispatched names it", () => {
  const rows = ["#5 impl-5=killed · impl-6"];
  const live = liveOnLedger(rows, []);
  assert.deepEqual(live.rows, [0], "the live impl-6 carries its row");
  assert.deepEqual(retiredOnLedger(rows, [], [], carriedBy(rows, live)), []);
});

test("retiredOnLedger: an unsettled token on a row nothing carried retires nothing, a settled one does", () => {
  // A row the tick refuses is passed with the parsed ones and carried by
  // nobody; only a settled name on it is known gone.
  assert.deepEqual(retiredOnLedger(["#9 impl-9"], [], [], none), []);
  assert.deepEqual(retiredOnLedger(["#9 impl-9 · impl-8=killed"], [], [], none), ["impl-8"]);
});

test("retiredOnLedger: a name whose outcome is outside its family's vocabulary retires, in dispatched and on a row, once", () => {
  assert.notEqual(parseToken("impl-5=bogus").error, null, "the fixture token is malformed");
  assert.deepEqual(retiredOnLedger([], ["impl-5=bogus"], [], none), ["impl-5"]);
  assert.deepEqual(retiredOnLedger(["#6 impl-6=bogus"], [], [], none), ["impl-6"]);
  assert.deepEqual(retiredOnLedger(["#6 impl-6=bogus · impl-6=bogus"], ["impl-6=bogus", "impl-5=bogus"], [], none), ["impl-6", "impl-5"],
    "in dispatched order, each name once");
  assert.deepEqual(retiredOnLedger([], ["impl-5=bogus"], ["impl-5"], none), ["impl-5"], "the archive's own retired name is not repeated");
  // What must still retire nothing: a bare token, and a name that does not parse.
  assert.deepEqual(retiredOnLedger(["#6 impl-6 · nope=bogus"], ["impl-7", "nope=bogus", "=bogus"], [], none), []);
});

test("retiredOnLedger: a name the new ledger carries is not listed for its own out-of-vocabulary entry", () => {
  const rows = ["#12 impl-12"];
  const dispatched = ["impl-12", "impl-12=bogus", "impl-14=bogus", "impl-13=bogus"];
  const carried = { rows: ["#12 impl-12"], dispatched: ["impl-13=killed"] };
  assert.deepEqual(retiredOnLedger(rows, dispatched, [], carried), ["impl-14"],
    "impl-12 rides on a carried row and impl-13 on a carried entry; only impl-14 is unaccounted for");
});

test("retiredOnLedger: a reviewer runner a row launched is retired, a workflow launch and another name are not", () => {
  const done = "reviewed=abc1234:0/0/0:run-abcdefgh";
  const rows = [
    `#5 impl-5=PR#6 → PR#6 · review=member:review-pr-6 ${done} · review=member:review-pr-6-b=failed`,
    `#7 impl-7=PR#8 → PR#8 · review=wf:review-pr-8 ${done} · review=member:some-runner ${done}`,
    `#9 impl-9=PR#10 → PR#10 · review=member:review-pr-10 ${done} · impl-10`,
  ];
  const live = liveOnLedger(rows, []);
  assert.deepEqual(live.rows, [2], "only #9 holds a live token");
  assert.deepEqual(retiredOnLedger(rows, [], [], carriedBy(rows, live)), ["impl-5", "review-pr-6", "review-pr-6-b", "impl-7"],
    "the carried row's own runner stays with the row");
});

test("REVIEW reads a workflow or a runner launch, settled or not, and refuses a launch of the removed kind", () => {
  for (const ok of ["review=wf:r1", "review=member:review-pr-1", "review=member:review-pr-1-b", "review=member:review-pr-1-b=failed"]) {
    assert.ok(REVIEW.test(ok), ok);
  }
  const removed = "fallback";
  for (const bad of [`review=${removed}:review-pr-1-b`, `review=${removed}:review-pr-1-b=failed`]) assert.ok(!REVIEW.test(bad), bad);
});

test("isRetirable: a member's name or a reviewer's, bare", () => {
  for (const ok of ["impl-4", "impl-4-b", "merge-bot-2", "review-pr-6", "review-pr-6-c"]) assert.ok(isRetirable(ok), ok);
  for (const bad of ["impl-4=killed", "garbage-name", "merge-bot-2-b", "impl-5-zz", "review-pr-6-a", "review-pr-0", "review-pr-6=failed"]) {
    assert.ok(!isRetirable(bad), bad);
  }
});

test("readRetired: a line's name is the text before its first `=`, retired whatever follows; a line whose name is not retirable is malformed", () => {
  const lines = ["impl-1", "impl-4=killed", "review-pr-9=failed", "impl-5=", "merge-bot-3=done=x", "garbage-name", "merge-bot-2-b", "=impl-6", "impl-7 =killed"];
  assert.deepEqual(readRetired(lines), {
    names: ["impl-1", "impl-4", "review-pr-9", "impl-5", "merge-bot-3"],
    malformed: ["garbage-name", "merge-bot-2-b", "=impl-6", "impl-7 =killed"],
  });
  assert.deepEqual(readRetired([]), { names: [], malformed: [] }, "no ## Retired reads as nothing retired");
});

test("nextRetry: one letter past the highest used on the number, across every name given, null past -z", () => {
  assert.equal(nextRetry("impl-42", []), "impl-42-b");
  assert.equal(nextRetry("impl-42", ["impl-42-c", "impl-43-d", "fix-pr-42-e"]), "impl-42-d", "same family and number only");
  assert.equal(nextRetry("impl-42-b", ["impl-42"]), "impl-42-c");
  assert.equal(nextRetry("finisher-pr-7", ["finisher-pr-7-z"]), null);
});

test("liveOnLedger: unsettled members and open launches, once each, with the first row carrying them", () => {
  const rows = [
    "#3 impl-3=PR#5 → PR#5 · review=member:review-pr-5",
    "#4 impl-4=PR#6 · review=wf:r1 · reviewed=abc1234:0/0/0:run-abcdefgh · fix-pr-6=no-op",
    "#6 fix-pr-6 · finisher-pr-6",
    "#9 impl-9 · review=member:review-pr-9=failed",
    "#10 excluded · behind-pr:#6",
  ];
  const out = liveOnLedger(rows, ["impl-3=PR#5", "impl-4=PR#6", "fix-pr-6=no-op", "finisher-pr-6", "impl-9", "merge-bot-1=done", "merge-bot-2"]);
  assert.deepEqual(out.rows, [0, 1, 2, 3], "a launch, a live member beside a settled one, and a live impl beside a failed launch — and #4, which shares PR 6 with the live #6");
  assert.deepEqual(out.dispatched, ["impl-3=PR#5", "impl-4=PR#6", "fix-pr-6=no-op", "finisher-pr-6", "impl-9", "merge-bot-2"]);
  assert.deepEqual(out.tokens, [
    { name: "review-pr-5", token: "review=member:review-pr-5", row: "#3" },
    { name: "finisher-pr-6", token: "finisher-pr-6", row: "#6" },
    { name: "impl-9", token: "impl-9", row: "#9" },
    { name: "merge-bot-2", token: "merge-bot-2", row: null },
  ]);
});

test("liveOnLedger: a PR-bound member's settled copy on another PR's row settles nothing — the tick's own reading", () => {
  const rows = ["#7 impl-7=PR#8 · fix-pr-5=no-op", "#5 fix-pr-5"];
  assert.deepEqual(liveOnLedger(rows, []).tokens, [{ name: "fix-pr-5", token: "fix-pr-5", row: "#5" }]);
  assert.deepEqual(liveOnLedger(rows, ["fix-pr-5=no-op"]).tokens, [], "## Dispatched settles it wherever its tokens sit");
});

test("settledOnLedger: a settled copy on a row settles its member with no ## Dispatched entry, a PR-bound one only on its own PR's row", () => {
  assert.deepEqual([...settledOnLedger(["#7 impl-7=killed", "#5 fix-pr-5=no-op"], [])], ["impl-7", "fix-pr-5"]);
  assert.deepEqual([...settledOnLedger(["#7 impl-7=PR#8 · fix-pr-5=no-op"], [])], ["impl-7"], "fix-pr-5 settled on PR 8's row is not settled");
});

test("liveOnLedger: a launch answered on another of its PR's rows is not open", () => {
  const rows = ["#3 impl-3=PR#5 · review=member:review-pr-5", "#5 reviewed=abc1234:0/0/0:run-abcdefgh"];
  assert.deepEqual(liveOnLedger(rows, []), { rows: [], dispatched: [], tokens: [] });
});

test("liveOnLedger: a live row brings every other row of its PR's stream, and a carried ledger reads as live exactly what the whole one did", () => {
  const rows = [
    "#5 review=wf:r1 · reviewed=abc1234:2/0/0:run-abcdefgh",
    "#3 impl-3=PR#5 → PR#5 · fix-pr-5",
    "#20 impl-20=PR#21 → PR#21",
  ];
  const dispatched = ["impl-3=PR#5", "fix-pr-5", "impl-20=PR#21"];
  const out = liveOnLedger(rows, dispatched);
  assert.deepEqual(out.rows, [0, 1], "the PR's review record rides with its live row; another PR's settled row stays");
  assert.deepEqual(out.dispatched, ["impl-3=PR#5", "fix-pr-5"]);
  const kept = liveOnLedger(out.rows.map((i) => rows[i]), out.dispatched);
  assert.deepEqual(kept.tokens, out.tokens);
});

test("liveOnLedger: a bare token beside its settled ## Dispatched copy carries that copy, so it does not read live again", () => {
  const rows = ["#5 fix-pr-5 · review=member:review-pr-5"];
  const out = liveOnLedger(rows, ["fix-pr-5=no-op", "merge-bot-1=done"]);
  assert.deepEqual(out.tokens, [{ name: "review-pr-5", token: "review=member:review-pr-5", row: "#5" }]);
  assert.deepEqual(out.dispatched, ["fix-pr-5=no-op"], "the settled entry of a member no carried row names stays behind");
  const kept = liveOnLedger(out.rows.map((i) => rows[i]), out.dispatched);
  assert.deepEqual(kept.tokens, out.tokens);
});

test("liveOnLedger: an open launch is credited to the row that names it, not to every row of its PR", () => {
  const rows = ["#3 impl-3=PR#5 → PR#5", "#5 review=member:review-pr-5"];
  const out = liveOnLedger(rows, ["impl-3=PR#5"]);
  assert.deepEqual(out.tokens, [{ name: "review-pr-5", token: "review=member:review-pr-5", row: "#5" }]);
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

// A family agentDefinition has no case for must throw, never read as a
// definition. This walks every family parseMember can yield (MEMBER is built
// from MEMBER_FAMILIES) — a family added to FAMILIES without a case here fails
// this test, not a dispatch.
test("agentDefinition names a definition for every member family, and throws on one it has no case for", () => {
  const agents = join(import.meta.dirname, "..", "plugin", "agents");
  for (const family of MEMBER_FAMILIES) {
    const member = parseMember(`${family}-7`);
    const definition = agentDefinition(member, "");
    assert.match(definition, /^fleet-/, `${family}: ${definition}`);
    // #2129 deleted the bare `fleet-implementer`: a name with no file behind
    // it is what `ledger.mjs dispatch` refuses, so an untiered impl row
    // pointing at it would stop every such dispatch.
    assert.ok(existsSync(join(agents, `${definition}.agent.md`)), `${family}: ${definition} has no agents/${definition}.agent.md`);
  }
  // The must-ACCEPT half: a fix-applier is its own definition, whatever the row says.
  assert.equal(agentDefinition(parseMember("fix-pr-7"), ""), "fleet-fix-applier");
  assert.equal(agentDefinition(parseMember("fix-pr-7"), "impl-7=PR#7 · tier=task-high · conflict-hold:#7"), "fleet-fix-applier");
  assert.throws(
    () => agentDefinition({ name: "review-pr-7", family: "review-pr", number: 7 }, ""),
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

// `ledger.mjs token` writes every row token that is neither a member's nor
// the review pair's. The grammar claims those two kinds and no other, so the
// must-ACCEPT half is every other family a real row carries: a `token` that
// refused one would leave the controller to re-type the whole row with `row`.
const FREEFORM_FAMILIES = [
  "ci=123:1:success",
  "held-behind:#313",
  "conflict-hold:#346",
  "label-off=finisher-pr-346",
  "tier=slow-high",
  "route=exploration",
  "tier-ok=impl-324:fleet-implementer-slow-high",
  "tier-mismatch=impl-324:fleet-implementer-task-low",
  "tier-unverifiable=impl-324:no-transcript",
  "dispositions-ok=fix-pr-346:run-abcd1234",
  "dispositions-mismatch=fix-pr-346:run-abcd1234",
  "dispositions-escalate=fix-pr-346:run-abcd1234",
  "dispositions-unchecked=fix-pr-346:run-abcd1234",
  "ports=16324",
];

test("token accepts every non-member, non-review token family a row carries, each appended after what the row held", (t) => {
  for (const tok of FREEFORM_FAMILIES) {
    assert.equal(parseToken(tok), null, `${tok}: a member token is dispatch's or settle's, not token's`);
    assert.equal(isReviewToken(tok), false, `${tok}: a review token is review's, not token's`);
  }
  const dir = mkdtempSync(join(tmpdir(), "ledger-token-families-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "ledger.md");
  const row = "#346 impl-324=PR#346 → PR#346 · finisher-pr-346=labelled";
  writeFileSync(file, `# Fleet run ledger\n\n## Rows\n\n- ${row}\n\n## Filed\n\n## Ruled\n\n`);
  const script = fileURLToPath(new URL("../plugin/scripts/ledger.mjs", import.meta.url));
  const env = { ...process.env, PATH: dir };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  for (const tok of FREEFORM_FAMILIES) {
    const r = spawnSync(process.execPath, [script, "--file", file, "token", "346", tok], { encoding: "utf8", env, cwd: dir });
    assert.equal(r.status, 0, `${tok}: got exit ${r.status}\n${r.stderr}`);
    assert.deepEqual(JSON.parse(r.stdout).added, [tok]);
  }
  const written = JSON.parse(spawnSync(process.execPath, [script, "--file", file, "read"], { encoding: "utf8", env, cwd: dir }).stdout);
  assert.deepEqual(written.rows, [`${row} · ${FREEFORM_FAMILIES.join(" · ")}`]);
  assert.ok(readFileSync(file, "utf8").includes(FREEFORM_FAMILIES.at(-1)));
});

test("a ## Dispatched entry's brief= word is parsed off its member token, live or settled, and written back beside it", () => {
  for (const token of ["impl-412", "impl-412-b=PR#420", "fix-pr-346=applied:73b356de", "finisher-pr-346=halted:past-pin", "merge-bot-2=done"]) {
    assert.deepEqual(parseDispatchedEntry(`${token} brief=0123abcd`), { token, brief: "0123abcd", queued: null, agent: null });
    assert.equal(dispatchedEntry(token, "0123abcd"), `${token} brief=0123abcd`);
    // An entry from before the brief was recorded is its token alone.
    assert.deepEqual(parseDispatchedEntry(token), { token, brief: null, queued: null, agent: null });
    assert.equal(dispatchedEntry(token, null), token);
  }
});

test("a merge bot's queued= word follows its brief= word, a list of PR numbers or none, and is written back the same way", () => {
  for (const token of ["merge-bot-2", "merge-bot-2=done"]) {
    for (const [word, queued] of [["queued=12,30", [12, 30]], ["queued=7", [7]], ["queued=none", []]]) {
      assert.deepEqual(parseDispatchedEntry(`${token} brief=0123abcd ${word}`), { token, brief: "0123abcd", queued, agent: null });
      assert.equal(dispatchedEntry(token, "0123abcd", queued), `${token} brief=0123abcd ${word}`);
    }
  }
});

test("an implementer's agent= word ends its entry, live or settled, and is written back the same way", () => {
  for (const token of ["impl-7", "impl-7=bailed", "impl-7-b=PR#420"]) {
    for (const agent of ["fleet-implementer-smol-high", "fleet-implementer-slow-high", "x", "a1-b2"]) {
      const entry = `${token} brief=0123abcd agent=${agent}`;
      assert.deepEqual(parseDispatchedEntry(entry), { token, brief: "0123abcd", queued: null, agent });
      assert.equal(dispatchedEntry(token, "0123abcd", null, agent), entry);
    }
  }
  // A bot's queued= word still precedes it; an entry without one is unchanged.
  assert.deepEqual(parseDispatchedEntry("merge-bot-2 brief=0123abcd queued=7 agent=fleet-merge-bot"), { token: "merge-bot-2", brief: "0123abcd", queued: [7], agent: "fleet-merge-bot" });
  assert.equal(dispatchedEntry("merge-bot-2", "0123abcd", [7], "fleet-merge-bot"), "merge-bot-2 brief=0123abcd queued=7 agent=fleet-merge-bot");
  assert.equal(dispatchedEntry("impl-7", "0123abcd", null, null), "impl-7 brief=0123abcd");
});

test("an entry that is not a member token plus one well-formed brief= word, then at most one well-formed queued= word and one agent= word, is kept whole, for parseToken to refuse", () => {
  for (const entry of [
    "impl-412 brief=0123abc", "impl-412 brief=0123abcde", "impl-412 brief=0123ABCD", "impl-412 brief=",
    "impl-412 brief=0123abcd brief=0123abcd", "impl-412  brief=0123abcd", "impl-412 sha=0123abcd",
    "review-pr-5 brief=0123abcd", "brief=0123abcd",
    "merge-bot-1 queued=12", "merge-bot-1 queued=12 brief=0123abcd", "merge-bot-1 brief=0123abcd queued=",
    "merge-bot-1 brief=0123abcd queued=0", "merge-bot-1 brief=0123abcd queued=012", "merge-bot-1 brief=0123abcd queued=12,",
    "merge-bot-1 brief=0123abcd queued=#12", "merge-bot-1 brief=0123abcd queued=none,12",
    "merge-bot-1 brief=0123abcd queued=12 queued=12",
    "impl-7 agent=fleet-implementer-slow-high", "impl-7 agent=fleet-implementer-slow-high brief=0123abcd",
    "impl-7 brief=0123abcd agent=", "impl-7 brief=0123abcd agent=../etc", "impl-7 brief=0123abcd agent=a/b",
    "impl-7 brief=0123abcd agent=Fleet-Implementer", "impl-7 brief=0123abcd agent=-a", "impl-7 brief=0123abcd agent=a-",
    "impl-7 brief=0123abcd agent=a--b", "impl-7 brief=0123abcd agent=a_b", "impl-7 brief=0123abcd agent=a.b",
    "impl-7 brief=0123abcd agent=a agent=a", "impl-7 brief=0123abcd agent=a ", "impl-7 brief=0123abcd  agent=a",
  ]) {
    assert.deepEqual(parseDispatchedEntry(entry), { token: entry, brief: null, queued: null, agent: null }, entry);
    assert.equal(parseToken(entry), null, `${entry}: kept whole, it parses as no member token`);
  }
  // An outcome outside the family's vocabulary is the token's own error, not the brief's.
  assert.deepEqual(parseDispatchedEntry("impl-412=bogus brief=0123abcd"), { token: "impl-412=bogus", brief: "0123abcd", queued: null, agent: null });
});

test("each ledger family renders from its own dispatch-prompt.mjs role", () => {
  assert.deepEqual(Object.fromEntries(MEMBER_FAMILIES.map((f) => [f, memberRole(f)])), {
    impl: "implementer", "fix-pr": "fix-applier", "finisher-pr": "finisher", "merge-bot": "merge-bot",
  });
});

// A PR's first review, read off its token stream.
const RV = (counts, run) => `reviewed=abc1234:${counts}:${run}`;

test("firstReview prefers a first review that counted no survived and no unverified finding over a later answered one", () => {
  const tokens = ["review=member:review-pr-40", RV("0/2/0", "run-AAAA0001"), "review=member:review-pr-40-b", RV("1/0/0", "run-BBBB0002"),
    "fix-pr-40=applied:abc1234", "dispositions-ok=fix-pr-40:run-BBBB0002"];
  assert.deepEqual(firstReview(tokens), { head: "abc1234", survived: 0, refuted: 2, unverified: 0, run: "run-AAAA0001" });
});

test("firstReview prefers an answered review over an earlier one no fix-applier answered, which was superseded", () => {
  const tokens = [RV("2/0/1", "run-AAAA0001"), RV("1/0/0", "run-BBBB0002"), "dispositions-mismatch=fix-pr-40:run-BBBB0002"];
  assert.equal(firstReview(tokens).run, "run-BBBB0002");
  // An unverified finding alone is a finding: unanswered, that review is superseded too.
  assert.equal(firstReview([RV("0/0/1", "run-AAAA0001"), RV("1/0/0", "run-BBBB0002"), "dispositions-ok=fix-pr-40:run-BBBB0002"]).run, "run-BBBB0002");
});

test("firstReview counts the runs it is handed as answered, and is null when no review qualifies", () => {
  const tokens = [RV("2/0/1", "run-AAAA0001"), RV("1/0/0", "run-BBBB0002")];
  assert.equal(firstReview(tokens), null);
  assert.equal(firstReview(tokens, ["run-BBBB0002"]).run, "run-BBBB0002");
  assert.equal(firstReview(tokens, ["run-AAAA0001", "run-BBBB0002"]).run, "run-AAAA0001");
  assert.equal(firstReview([]), null);
  // A verdict that is no dispositions token answers nothing.
  assert.equal(firstReview([...tokens, "dispositions-ok=finisher-pr-40:run-AAAA0001"]), null);
});

test("prTokens is a PR's stream in row order, across every row resolving to it, and no other PR's", () => {
  const rows = [
    `#10 impl-10=PR#40 review=member:review-pr-40 ${RV("2/0/0", "run-AAAA0001")}`,
    `#11 impl-11=PR#41 ${RV("0/0/0", "run-CCCC0003")}`,
    "#40 fix-pr-40 dispositions-ok=fix-pr-40:run-AAAA0001",
  ];
  assert.deepEqual(prTokens(rows, 40), ["#10", "impl-10=PR#40", "review=member:review-pr-40", RV("2/0/0", "run-AAAA0001"), "#40", "fix-pr-40", "dispositions-ok=fix-pr-40:run-AAAA0001"]);
  assert.equal(firstReview(prTokens(rows, 40)).run, "run-AAAA0001");
  assert.deepEqual(prTokens(rows, 99), []);
});

test("ledgerSection reads a section's entries unescaped, and none for a section that is absent", () => {
  const text = "# Fleet run ledger\n\n## Rows\n\n- #10 impl-10=PR#40\n- #11 a\\nb\n\n## Dispatched\n\n- impl-10=PR#40 brief=0123abcd\n";
  assert.deepEqual(ledgerSection(text, "## Rows"), ["#10 impl-10=PR#40", "#11 a\nb"]);
  assert.deepEqual(ledgerSection(text, "## Filed"), []);
});
