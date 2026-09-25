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
