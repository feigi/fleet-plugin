// `ledger.mjs dispatch | settle | drain` and the `## Dispatched` list (#1799;
// spec 2026-09-24 § 6 §2 and § 4 item 2). The token grammar these write is
// ledger-grammar.test.mjs's subject; this file is about what lands in the
// file, and what the three subcommands refuse to write.
//
// Every call is its own process against one ledger file, with nothing carried
// between calls but that file — the position a replacement controller is in
// after a context loss, which is who these records exist for.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeBoard } from "./compute-board.mjs";
import { deriveRun } from "./fleet-tick.mjs";

const SCRIPT = fileURLToPath(new URL("./ledger.mjs", import.meta.url));

function fixture(t, body = null) {
  const dir = mkdtempSync(join(tmpdir(), "ledger-dispatch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "ledger.md");
  if (body !== null) writeFileSync(file, body);
  // PATH is an empty directory: none of these subcommands may reach gh or
  // git, and with `--file` given nothing else in ledger.mjs does either.
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const env = { ...process.env, PATH: bin };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [SCRIPT, "--file", file, ...args], { encoding: "utf8", env, cwd: dir });
    return { ...r, json: r.status === 0 ? JSON.parse(r.stdout) : null };
  };
  const ok = (...args) => {
    const r = cli(...args);
    assert.equal(r.status, 0, `${args.join(" ")}: got exit ${r.status}\n${r.stderr}`);
    return r.json;
  };
  const read = () => ok("read");
  const bytes = () => (existsSync(file) ? readFileSync(file, "utf8") : null);
  // A refusal is exit 2, a reason on stderr, no payload — and no write.
  const refused = (args, why) => {
    const before = bytes();
    const r = cli(...args);
    assert.equal(r.status, 2, `${args.join(" ")}: got exit ${r.status}\n${r.stderr}`);
    assert.match(r.stderr, why, `${args.join(" ")}: stderr was ${r.stderr}`);
    assert.equal(r.stdout, "", `${args.join(" ")}: a refusal must not also emit a payload`);
    assert.equal(bytes(), before, `${args.join(" ")}: a refusal must not touch the ledger`);
  };
  return { file, cli, ok, read, bytes, refused };
}

test("dispatch appends a live member row and records the dispatch in ## Dispatched", (t) => {
  const { ok, read, bytes } = fixture(t);
  assert.deepEqual(ok("dispatch", "412", "impl-412"), {
    member: "impl-412", ticket: "#412", line: "#412 impl-412", created: true, total: 1,
  });
  const l = read();
  assert.deepEqual(l.rows, ["#412 impl-412"]);
  assert.deepEqual(l.dispatched, ["impl-412"]);
  assert.match(bytes(), /^## Dispatched\n\n- impl-412$/m);
});

// SKILL.md's phase 2 writes `row <N> "impl-<N> · class=routine"` at dispatch
// today, so a row that already carries the live token is the ordinary case
// and must be accepted without a second copy of it.
test("dispatch keeps an existing row's text, appending the token only where it is missing", (t) => {
  const { ok, read } = fixture(t);
  ok("row", "412", "impl-412 · class=routine");
  ok("row", "415", "claimed · class=correction");
  assert.deepEqual(ok("dispatch", "412", "impl-412"), {
    member: "impl-412", ticket: "#412", line: "#412 impl-412 · class=routine", created: false, total: 1,
  });
  assert.equal(ok("dispatch", "#415", "impl-415").line, "#415 claimed · class=correction · impl-415");
  assert.deepEqual(read().dispatched, ["impl-412", "impl-415"]);
});

test("a PR-bound member lands on the row carrying its PR, named by PR or by ticket", (t) => {
  const { ok, read } = fixture(t);
  ok("dispatch", "324", "impl-324");
  ok("settle", "impl-324", "PR#346");
  // By the PR number: found through the implementer's own settled token.
  assert.deepEqual(ok("dispatch", "346", "fix-pr-346"), {
    member: "fix-pr-346", ticket: "#324", line: "#324 impl-324=PR#346 · fix-pr-346", created: false, total: 2,
  });
  // By the ticket number whose row carries that PR.
  assert.equal(ok("dispatch", "324", "finisher-pr-346").line, "#324 impl-324=PR#346 · fix-pr-346 · finisher-pr-346");
  // The human-readable arrow a `row` call writes is found the same way.
  ok("row", "330", "impl-330 → PR#350");
  assert.equal(ok("dispatch", "350", "fix-pr-350").ticket, "#330");
  // A PR no row carries gets a row of its own.
  assert.deepEqual(ok("dispatch", "777", "fix-pr-777"), {
    member: "fix-pr-777", ticket: "#777", line: "#777 fix-pr-777", created: true, total: 5,
  });
  assert.equal(read().rows.length, 3);
});

test("dispatch refuses a call that would record the wrong member, and writes nothing", (t) => {
  const { ok, refused } = fixture(t);
  ok("row", "324", "impl-324");
  for (const [args, why] of [
    [["dispatch", "415", "impl-412"], /impl-412 works ticket #412, not #415/],
    [["dispatch", "324", "fix-pr-346"], /fix-pr-346 works PR #346, and row #324 carries no PR#346/],
    [["dispatch", "412", "review-pr-412"], /unknown member 'review-pr-412'/],
    [["dispatch", "412", "impl-412x"], /unknown member 'impl-412x'/],
    [["dispatch", "5", "merge-bot"], /merge bots work no ticket or PR/],
    [["dispatch", "5", "merge-bot-1"], /merge bots work no ticket or PR/],
    [["dispatch", "--requre-file", "impl-412"], /unknown flag --requre-file — expected a ticket or PR number/],
    [["dispatch", "-require-file", "impl-412"], /unknown flag -require-file — expected a ticket or PR number/],
    [["dispatch", "abc", "impl-412"], /'abc' is not a ticket or PR number/],
    [["dispatch", "impl-412"], /impl-412 works a ticket or PR — usage: ledger\.mjs dispatch <ticket\|pr> <member>/],
    [["dispatch"], /usage: ledger\.mjs dispatch <ticket\|pr> <member>/],
    [["dispatch", "412", "impl-412", "extra"], /usage: ledger\.mjs dispatch <ticket\|pr> <member>/],
  ]) {
    refused(args, why);
  }
});

test("a member is dispatched once; its replacement takes a name of its own", (t) => {
  const { ok, read, refused } = fixture(t);
  ok("dispatch", "412", "impl-412");
  refused(["dispatch", "412", "impl-412"], /impl-412 was already dispatched this run/);
  ok("settle", "impl-412", "killed");
  refused(["dispatch", "412", "impl-412"], /impl-412 was already dispatched this run \(impl-412=killed\)/);
  assert.equal(ok("dispatch", "412", "impl-412-b").line, "#412 impl-412=killed · impl-412-b");
  assert.deepEqual(read().dispatched, ["impl-412=killed", "impl-412-b"]);
});

test("merge-bot-<n> counts the ## Dispatched merge-bot entries, and a new ledger starts again at 1", (t) => {
  const { ok, read, refused } = fixture(t);
  assert.deepEqual(ok("dispatch", "merge-bot"), { member: "merge-bot-1", ticket: null, line: null, created: false, total: 1 });
  ok("dispatch", "412", "impl-412");
  ok("settle", "merge-bot-1", "done");
  // A settled bot still counts: its replacement gets a new n.
  assert.equal(ok("dispatch", "merge-bot").member, "merge-bot-2");
  // The explicit name is accepted when it is the next one, and only then.
  assert.equal(ok("dispatch", "merge-bot-3").member, "merge-bot-3");
  refused(["dispatch", "merge-bot-5"], /the next merge bot this run is merge-bot-4/);
  refused(["dispatch", "merge-bot-2"], /the next merge bot this run is merge-bot-4/);
  const l = read();
  assert.deepEqual(l.dispatched, ["merge-bot-1=done", "impl-412", "merge-bot-2", "merge-bot-3"]);
  assert.deepEqual(l.rows, ["#412 impl-412"], "a merge bot works no ticket, so it writes no row");

  const fresh = fixture(t);
  assert.equal(fresh.ok("dispatch", "merge-bot").member, "merge-bot-1");
});

test("settle rewrites the member's token in its row and in ## Dispatched, and nothing else", (t) => {
  const { ok, read } = fixture(t);
  ok("row", "412", "impl-412 · class=routine · ports=16412");
  ok("dispatch", "412", "impl-412");
  assert.deepEqual(ok("settle", "impl-412", "PR#420"), {
    member: "impl-412", outcome: "PR#420", ticket: "#412", line: "#412 impl-412=PR#420 · class=routine · ports=16412", changed: true,
  });
  // The one-token spelling the spec's record-before-tick table uses.
  ok("dispatch", "415", "impl-415");
  assert.equal(ok("settle", "impl-415=tier-mismatch").line, "#415 impl-415=tier-mismatch");
  ok("dispatch", "420", "fix-pr-420");
  assert.equal(ok("settle", "fix-pr-420", "applied:73b356de").line, "#412 impl-412=PR#420 · class=routine · ports=16412 · fix-pr-420=applied:73b356de");
  ok("dispatch", "420", "finisher-pr-420");
  ok("settle", "finisher-pr-420", "labelled");
  ok("dispatch", "merge-bot");
  assert.deepEqual(ok("settle", "merge-bot-1", "done"), { member: "merge-bot-1", outcome: "done", ticket: null, line: null, changed: true });
  const l = read();
  assert.deepEqual(l.dispatched, [
    "impl-412=PR#420", "impl-415=tier-mismatch", "fix-pr-420=applied:73b356de", "finisher-pr-420=labelled", "merge-bot-1=done",
  ]);
  assert.deepEqual(l.rows, [
    "#412 impl-412=PR#420 · class=routine · ports=16412 · fix-pr-420=applied:73b356de · finisher-pr-420=labelled",
    "#415 impl-415=tier-mismatch",
  ]);
});

test("settle refuses an outcome outside the member's vocabulary, and a malformed call, writing nothing", (t) => {
  const { ok, refused } = fixture(t);
  ok("dispatch", "412", "impl-412");
  ok("dispatch", "merge-bot");
  for (const [args, why] of [
    [["settle", "impl-412", "done"], /'done' is not an outcome of impl-N — expected PR#M \| bailed \| released \| killed \| tier-mismatch/],
    [["settle", "impl-412=labelled"], /'labelled' is not an outcome of impl-N/],
    [["settle", "impl-412", "PR#420 extra"], /is not an outcome of impl-N/],
    [["settle", "merge-bot-1", "labelled"], /expected done \| killed/],
    [["settle", "review-pr-346", "failed"], /unknown member 'review-pr-346'/],
    [["settle", "--requre-file", "bailed"], /unknown flag --requre-file — expected a member name/],
    [["settle", "impl-412"], /usage: ledger\.mjs settle <member> <outcome>/],
    [["settle"], /usage: ledger\.mjs settle <member> <outcome>/],
    [["settle", "impl-412", "bailed", "extra"], /usage: ledger\.mjs settle <member> <outcome>/],
  ]) {
    refused(args, why);
  }
});

test("settle repeats harmlessly with the same outcome and refuses a different one", (t) => {
  const { ok, bytes, refused } = fixture(t);
  ok("dispatch", "412", "impl-412");
  ok("settle", "impl-412", "bailed");
  const before = bytes();
  assert.deepEqual(ok("settle", "impl-412", "bailed"), {
    member: "impl-412", outcome: "bailed", ticket: "#412", line: "#412 impl-412=bailed", changed: false,
  });
  assert.equal(bytes(), before, "a repeat settle writes nothing");
  refused(["settle", "impl-412", "PR#5"], /impl-412 is already settled as bailed/);
  refused(["settle", "impl-999", "bailed"], /no live impl-999 in the ledger/);
});

// The must-ACCEPT half of settle's lookup: a live token that `dispatch` never
// wrote (SKILL.md's `row` writes one today), and a dispatched member whose
// row a later whole-line `row` call rewrote without its token. Refusing either
// leaves that member counted live for the rest of the run.
test("settle accepts a live token `row` wrote, and restores a token a later `row` dropped", (t) => {
  const { ok, read } = fixture(t);
  ok("row", "412", "impl-412 · class=routine");
  assert.equal(ok("settle", "impl-412", "bailed").line, "#412 impl-412=bailed · class=routine");
  ok("dispatch", "415", "impl-415");
  ok("row", "415", "rewritten by hand");
  assert.equal(ok("settle", "impl-415", "PR#9").line, "#415 rewritten by hand · impl-415=PR#9");
  assert.deepEqual(read().dispatched, ["impl-415=PR#9"]);
});

// #2139: every reader parses member tokens anywhere in a row, so a malformed
// one `row` wrote used to land as a permanent settle — `settle merge-bot-1
// done` then refused as "already settled as dispatched". `row` refuses it
// instead, new row or rewrite alike, surfacing the grammar's own error.
test("row refuses a malformed member token anywhere in its text, writing nothing", (t) => {
  const { ok, read, refused } = fixture(t);
  ok("dispatch", "merge-bot");
  refused(
    ["row", "2136", "merge-bot-1=dispatched · ci=123:1:success"],
    /malformed member token 'merge-bot-1=dispatched' — 'dispatched' is not an outcome of merge-bot-n — expected done \| killed/,
  );
  assert.deepEqual(read().rows, []);
  // A rewrite of an existing row is refused the same way; the old line stays.
  ok("row", "412", "impl-412 · class=routine");
  for (const [text, why] of [
    ["impl-412=done · class=routine", /'impl-412=done' — 'done' is not an outcome of impl-N — expected PR#M \| bailed/],
    ["class=routine · impl-412-b=labelled", /'impl-412-b=labelled' — 'labelled' is not an outcome of impl-N/],
    ["impl-412 · fix-pr-9=applied:not-a-sha", /'fix-pr-9=applied:not-a-sha' — .* expected applied:<head> \| no-op/],
    ["impl-412=", /'impl-412=' — '' is not an outcome of impl-N/],
  ]) {
    refused(["row", "412", text], why);
  }
  assert.deepEqual(read().rows, ["#412 impl-412 · class=routine"]);
  assert.equal(ok("settle", "merge-bot-1", "done").outcome, "done");
});

// The must-ACCEPT half: every well-formed member token — live or settled —
// and every non-member key `row` carries today still goes through, including
// tier-check.mjs's `tier-ok=`/`tier-mismatch=` verdicts (#1398), which name
// a member but are not member tokens themselves.
test("row still writes well-formed member tokens and non-member keys", (t) => {
  const { ok, read } = fixture(t);
  ok("dispatch", "merge-bot");
  const rows = [
    ["7", "impl-7 · class=routine · ports=16007"],
    ["8", "impl-8=PR#9 · fix-pr-9=applied:73b356de · review=wf:r1=failed reviewed=abc1234:1/0/0 · ci=123:1:success"],
    ["10", "held-behind:#9 · merge-bot-1=done · review=member:review-pr-10"],
    ["11", "impl-11 · tier=alt · tier-ok=impl-11:fleet-implementer-alt"],
    ["12", "impl-12=bailed · tier-mismatch=impl-12:fleet-implementer · impl-12: dispatched task, expected fleet-implementer"],
  ];
  for (const [ticket, text] of rows) ok("row", ticket, text);
  assert.deepEqual(read().rows, rows.map(([n, text]) => `#${n} ${text}`));
});

// #1876: the tick owes an open PR a review while its implementer is still
// live, so a PR-bound member can be dispatched before `settle impl-N=PR#M`
// names the PR on the ticket row. dispatch's fallback then keys a row of its
// own to the PR — truthful until the settle, when two rows would name one PR:
// the cockpit drew two REVIEW cards and the tick's first-row-wins `byPr` lost
// the live review. The settle folds the PR-keyed row into the ticket row.
test("settle impl-N=PR#M folds the PR-keyed row a pre-settle dispatch created into the ticket row", (t) => {
  const { ok, read } = fixture(t);
  ok("dispatch", "1300", "impl-1300");
  assert.equal(ok("dispatch", "1301", "fix-pr-1301").line, "#1301 fix-pr-1301");
  ok("row", "1301", "fix-pr-1301 · review=member:review-pr-1301");
  assert.deepEqual(read().rows, ["#1300 impl-1300", "#1301 fix-pr-1301 · review=member:review-pr-1301"]);

  const folded = "#1300 impl-1300=PR#1301 · fix-pr-1301 · review=member:review-pr-1301";
  assert.deepEqual(ok("settle", "impl-1300=PR#1301"), {
    member: "impl-1300", outcome: "PR#1301", ticket: "#1300", line: folded, changed: true,
  });
  const l = read();
  assert.deepEqual(l.rows, [folded]);
  assert.deepEqual(l.dispatched, ["impl-1300=PR#1301", "fix-pr-1301"], "the fold moves row tokens only");

  // Both readers see one PR with one live review on it.
  const board = computeBoard({
    ledger: { rows: l.rows, filed: [], ruled: [] }, issues: [], merged: [], ci: {}, prev: { tickets: [] }, now: 0,
    prs: [{ number: 1301, state: "OPEN", labels: [], title: "pr 1301" }],
  });
  const cards = board.tickets.filter((c) => c.pr === 1301);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].column, "REVIEW");
  assert.equal(cards[0].agent, "review-pr-1301");
  assert.equal(board.queue.reviewBacklog, 0, "the PR is under review, not owed one");
  const run = deriveRun({ rows: l.rows, dispatched: l.dispatched, drain: null },
    [{ number: 1301, labels: [], closingIssuesReferences: [{ number: 1300 }] }]);
  assert.equal(run.reviewsLive, 1);
  assert.deepEqual(run.reviewDue, []);

  // Every later PR-bound write finds the one row naming the PR.
  assert.equal(ok("settle", "fix-pr-1301", "no-op").ticket, "#1300");
  assert.equal(ok("dispatch", "1301", "finisher-pr-1301").ticket, "#1300");
  assert.equal(read().rows.length, 1);
});

// #2064: merge-bot records a conflict its local-rebase fallback would not
// force with `row`, and the fix-applier is recorded with the ordinary
// `dispatch`/`settle`. The tick clears the hold only on a settle positioned
// AFTER the hold token, so the writers must put it there — including when
// the PR's review-fix `fix-pr-<M>` already settled earlier on the same row.
test("a conflict hold written by row is cleared by a later dispatch + settle, in the order the tick reads", (t) => {
  const { ok, read } = fixture(t);
  const before = "impl-10=PR#40 · reviewed=abc1234:1/0/0 · fix-pr-40=applied:73b356de";
  ok("row", "10", before);
  ok("row", "10", `${before} · conflict-hold:#40`);
  const tick = () => {
    const l = read();
    return deriveRun({ rows: l.rows, dispatched: l.dispatched, drain: null },
      [{ number: 40, labels: [{ name: "ready-to-merge" }], closingIssuesReferences: [{ number: 10 }] }]);
  };
  assert.deepEqual([tick().fixDue, tick().mergeHeld], [[40], 1], "the earlier settle cannot clear the newer hold");

  assert.equal(ok("dispatch", "40", "fix-pr-40-b").line, `#10 ${before} · conflict-hold:#40 · fix-pr-40-b`);
  assert.deepEqual([tick().fixDue, tick().mergeHeld], [[], 1], "dispatched is not settled");

  assert.equal(ok("settle", "fix-pr-40-b", "applied:def5678").line, `#10 ${before} · conflict-hold:#40 · fix-pr-40-b=applied:def5678`);
  assert.deepEqual([tick().fixDue, tick().mergeHeld], [[], 0]);
});

test("the fold takes the PR row's settled tokens in order, under the two-argument spelling, wherever the PR row sits", (t) => {
  const { ok, read } = fixture(t);
  // The PR's row comes first here, and a third row follows the ticket's.
  ok("dispatch", "1311", "fix-pr-1311");
  ok("settle", "fix-pr-1311", "applied:73b356de");
  ok("row", "1311", "fix-pr-1311=applied:73b356de · review=wf:r1=failed reviewed=abc1234:1/0/0 · ci=9:1:success");
  ok("row", "1310", "impl-1310 · class=routine");
  ok("dispatch", "1320", "impl-1320");
  const folded = "#1310 impl-1310=PR#1311 · class=routine · fix-pr-1311=applied:73b356de · review=wf:r1=failed reviewed=abc1234:1/0/0 · ci=9:1:success";
  assert.deepEqual(ok("settle", "impl-1310", "PR#1311"), {
    member: "impl-1310", outcome: "PR#1311", ticket: "#1310", line: folded, changed: true,
  });
  assert.deepEqual(read().rows, [folded, "#1320 impl-1320"]);
  // A PR row holding nothing past its key leaves no stray separator behind.
  ok("row", "1321", " ");
  assert.equal(ok("settle", "impl-1320=PR#1321").line, "#1320 impl-1320=PR#1321");
  assert.deepEqual(read().rows, [folded, "#1320 impl-1320=PR#1321"]);
});

// The must-LEAVE half: only the row keyed to the settled PR, and only when it
// carries no implementer, is folded. A settle to a PR with no row of its own
// is today's token rewrite and nothing more.
test("settle folds no row keyed to another PR, no row carrying an impl- token, and nothing when the PR has no row", (t) => {
  const { ok, read } = fixture(t);
  ok("dispatch", "412", "impl-412");
  ok("dispatch", "777", "fix-pr-777");
  ok("dispatch", "420", "impl-420");
  ok("row", "421", "impl-421=killed · review=wf:r2");
  ok("dispatch", "413", "impl-413");
  ok("dispatch", "414", "impl-414");
  const before = read().rows;

  // #420 is keyed to the PR but is an implementer's own row (live or settled).
  assert.equal(ok("settle", "impl-412", "PR#420").line, "#412 impl-412=PR#420");
  assert.equal(ok("settle", "impl-413=PR#421").line, "#413 impl-413=PR#421");
  // No row keyed #500 at all; #777 belongs to a PR nobody here settles to.
  assert.equal(ok("settle", "impl-414", "PR#500").line, "#414 impl-414=PR#500");
  assert.deepEqual(read().rows, before.map((r) => r
    .replace(/^#412 impl-412$/, "#412 impl-412=PR#420")
    .replace(/^#413 impl-413$/, "#413 impl-413=PR#421")
    .replace(/^#414 impl-414$/, "#414 impl-414=PR#500")));
  assert.ok(read().rows.includes("#777 fix-pr-777"));
});

// The fold's key match is exact, never a prefix: `#42` must not absorb an
// unrelated row keyed `#420` just because one key is a prefix of the other.
test("settle to PR#42 does not fold an unrelated row keyed #420", (t) => {
  const { ok, read } = fixture(t);
  ok("row", "420", "unrelated other content for #420");
  ok("dispatch", "100", "impl-100");
  assert.equal(ok("settle", "impl-100", "PR#42").line, "#100 impl-100=PR#42");
  assert.deepEqual(read().rows, ["#420 unrelated other content for #420", "#100 impl-100=PR#42"]);
});

// #1876 follow-up: a row that already names a PR before this settle writes
// to it must never be folded from — `rowPr()` and the tick's `PR_MENTION`
// read only the FIRST `PR#` mention on a row, so folding here would let a
// second PR's content ride on the first PR's identity (a replacement
// implementer opening a second, different PR for the same ticket), or bury
// the row's own fresher `review=` state under an older one the tick reads
// last. The pre-existing two-row shape is left as it was rather than risk
// either.
test("settle does not fold when its own row already names a PR", (t) => {
  const { ok, read } = fixture(t);
  ok("dispatch", "100", "impl-100");
  ok("settle", "impl-100", "PR#150");
  ok("dispatch", "100", "impl-100-b");
  ok("dispatch", "160", "fix-pr-160");
  ok("row", "160", "fix-pr-160 · review=member:review-pr-160");
  assert.equal(ok("settle", "impl-100-b", "PR#160").line, "#100 impl-100=PR#150 · impl-100-b=PR#160");
  assert.deepEqual(read().rows, [
    "#100 impl-100=PR#150 · impl-100-b=PR#160",
    "#160 fix-pr-160 · review=member:review-pr-160",
  ]);
});

// #1876 follow-up: a row keyed `#M` with no impl- token is not always
// dispatch's PR-M fallback — a mistyped PR number can coincide with an
// unrelated ticket row (an Exclusion, here) that carries no PR-bound member
// token at all. The fold must tell the two apart positively, not merely by
// the absence of an impl- token, or a typo silently deletes real state a
// settled member can never restore.
test("settle to a mistyped PR number does not fold an unrelated row with no PR-bound token", (t) => {
  const { ok, read } = fixture(t);
  ok("row", "358", "excluded · behind-pr:#346");
  ok("dispatch", "351", "impl-351");
  assert.equal(ok("settle", "impl-351", "PR#358").line, "#351 impl-351=PR#358");
  assert.deepEqual(read().rows, ["#358 excluded · behind-pr:#346", "#351 impl-351=PR#358"]);
});

// Two genuinely separate PR-bound dispatches (a fix-pr and, after its own
// settle, a finisher-pr replacement) can land on the same fallback row via
// runDispatch()'s rowKey fallback — not just one `row` call's worth of
// text — and an unrelated row between the fallback and the ticket must not
// disturb the splice/index-repair distance from either side.
test("the fold carries both families' settled tokens from separate dispatches, across an intervening unrelated row", (t) => {
  const { ok, read } = fixture(t);
  ok("dispatch", "900", "fix-pr-900");
  ok("settle", "fix-pr-900", "failed");
  ok("dispatch", "800", "impl-800");
  ok("dispatch", "900", "finisher-pr-900-b");
  ok("settle", "finisher-pr-900-b", "labelled");
  ok("dispatch", "700", "impl-700");
  assert.deepEqual(read().rows, ["#900 fix-pr-900=failed · finisher-pr-900-b=labelled", "#800 impl-800", "#700 impl-700"]);
  assert.equal(ok("settle", "impl-700", "PR#900").line, "#700 impl-700=PR#900 · fix-pr-900=failed · finisher-pr-900-b=labelled");
  assert.deepEqual(read().rows, ["#800 impl-800", "#700 impl-700=PR#900 · fix-pr-900=failed · finisher-pr-900-b=labelled"]);
});

test("drain writes one marker a later reader recognises, and it holds supply alone", (t) => {
  const { ok, read, bytes, refused } = fixture(t);
  ok("dispatch", "410", "impl-410");
  const reason = "maintainer asked to stop\n## Rows\n- #1 phantom";
  assert.deepEqual(ok("drain", reason), { drain: reason, created: true });
  const l = read();
  assert.equal(l.drain, reason);
  assert.deepEqual(l.rows, ["#410 impl-410"], "the reason is one escaped entry, never a line the parser reads back");
  assert.match(bytes(), /^## Drain\n\n- maintainer asked to stop\\n## Rows\\n- #1 phantom$/m);
  // One marker: a second drain reports the standing one and writes nothing.
  const before = bytes();
  assert.deepEqual(ok("drain", "again"), { drain: reason, created: false });
  assert.equal(bytes(), before);
  // Supply stops — a fresh implementer or a replacement for a live one...
  refused(["dispatch", "412", "impl-412"], /the run is draining \(maintainer asked to stop\n## Rows\n- #1 phantom\) — no implementer dispatch/);
  refused(["dispatch", "410", "impl-410-b"], /the run is draining/);
  // ...and everything else keeps firing until the open PRs are merged.
  ok("settle", "impl-410", "released");
  ok("dispatch", "346", "fix-pr-346");
  ok("dispatch", "346", "finisher-pr-346");
  assert.equal(ok("dispatch", "merge-bot").member, "merge-bot-1");
});

test("drain needs a reason", (t) => {
  const { refused } = fixture(t);
  refused(["drain"], /usage: ledger\.mjs drain "<reason>"/);
  refused(["drain", "   "], /usage: ledger\.mjs drain "<reason>"/);
});

test("a ledger written before ## Dispatched existed reads as none dispatched and not draining, and survives a dispatch", (t) => {
  const { ok, read } = fixture(t, "# Fleet run ledger\n\n## Rows\n\n- #7 impl-7 · class=routine\n\n## Filed\n\n- #8 a filed subject\n\n## Ruled\n\n- #9 MERGE · green\n");
  const legacy = { rows: ["#7 impl-7 · class=routine"], filed: ["#8 a filed subject"], ruled: ["#9 MERGE · green"] };
  assert.deepEqual(read(), { ...legacy, dispatched: [], drain: null });
  assert.equal(ok("dispatch", "merge-bot").member, "merge-bot-1");
  assert.deepEqual(read(), { ...legacy, dispatched: ["merge-bot-1"], drain: null });
});

// #1799 fix-applier follow-up: a `## Dispatched` entry this grammar cannot
// parse used to read, via `parseToken(e)?.name`, as "not this member" —
// silently treating a corrupted section as though the member it names were
// free, in both dispatch's duplicate guard and settle's lookup.
test("a `## Dispatched` entry this grammar cannot parse refuses dispatch and settle, naming it, rather than reading as absent", (t) => {
  const body = "# Fleet run ledger\n\n## Rows\n\n## Dispatched\n\n- impl-412x\n\n## Filed\n\n## Ruled\n";
  const { refused } = fixture(t, body);
  refused(["dispatch", "412", "impl-412"], /## Dispatched has an entry 'impl-412x' this grammar cannot parse/);
  refused(["settle", "impl-412", "PR#420"], /## Dispatched has an entry 'impl-412x' this grammar cannot parse/);
});

// A replacement's own name is never a duplicate of its predecessor's, so the
// exact-name guard above lets it through — but the predecessor is still live,
// and the spec counts liveness as "unsettled impl- tokens" per family+number,
// not per exact name. Two live tokens for #412 would double-count it.
test("dispatch refuses a replacement while its predecessor is still live, in ## Dispatched or on a row", (t) => {
  const { ok, refused, read } = fixture(t);
  ok("dispatch", "412", "impl-412");
  refused(["dispatch", "412", "impl-412-b"], /impl-412 is still live — `settle impl-412 killed`/);
  ok("settle", "impl-412", "killed");
  // The predecessor is settled now: the replacement is no longer refused.
  assert.equal(ok("dispatch", "412", "impl-412-b").line, "#412 impl-412=killed · impl-412-b");
  assert.deepEqual(read().dispatched, ["impl-412=killed", "impl-412-b"]);

  // The same refusal when the live token was `row`'s, never `dispatch`'s.
  ok("row", "415", "impl-415");
  refused(["dispatch", "415", "impl-415-b"], /impl-415 is still live — `settle impl-415 killed`/);
});

// `load()`'s one read path for every subcommand: the write side (`drain`'s
// own `created` guard) already refuses a second marker, but a corrupted file
// carrying two anyway used to have its second `## Drain` bullet silently
// dropped by `section(DRAIN)[0] ?? null`, with no warning on either stream.
test("a ledger carrying two `## Drain` entries refuses to load rather than silently keeping only the first", (t) => {
  const body = "# Fleet run ledger\n\n## Rows\n\n## Dispatched\n\n## Filed\n\n## Ruled\n\n## Drain\n\n- first reason\n- second reason\n";
  const { refused } = fixture(t, body);
  refused(["read"], /has 2 `## Drain` entries — one marker per run/);
});
