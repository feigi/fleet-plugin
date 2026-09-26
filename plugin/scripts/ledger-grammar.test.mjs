// The `=`-token parser (#1799, spec 2026-09-24 § 6 §2). Everything that
// derives liveness from the ledger reads a member's state off its token, so
// what this parser claims — and what it declines to claim — is the whole
// contract: a token it misreads is a member counted live forever, or a live
// one counted gone.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseToken, memberTokens, nextMergeBot } from "./ledger-grammar.mjs";

// Every outcome word the spec names, per family, verbatim — the must-ACCEPT
// half. A parser that refused everything would pass every refusal below.
const VOCABULARY = [
  ["impl-412", ["PR#420", "bailed", "released", "killed", "tier-mismatch"]],
  ["fix-pr-346", ["applied:73b356de", "applied:73b356de0123456789abcdef0123456789abcdef", "no-op", "failed", "killed"]],
  ["finisher-pr-346", ["labelled", "failed", "killed"]],
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
    ["finisher-pr-346=done", /expected labelled \| failed \| killed/],
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
// #1773's `review=`/`reviewed=` pair) are not members, and neither is
// anything that only resembles one. Claiming any of them would count a
// phantom member live.
test("tokens that are not members are not claimed", () => {
  for (const token of [
    "#412", "→", "·", "PR#344", "MERGED", "73b356de", "class=routine", "ports=16324", "ci=123:1:success",
    "review=wf:abc123", "review=member:review-pr-346", "reviewed=73b356de:3/1/0", "held-behind:#313",
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
