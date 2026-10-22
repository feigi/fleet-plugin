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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeBoard } from "../plugin/scripts/compute-board.mjs";
import { deriveRun, LedgerError } from "../plugin/scripts/fleet-tick.mjs";
import { rowPr } from "../plugin/scripts/ledger-grammar.mjs";
import { rendering, renderBrief } from "./support/rendered-brief.mjs";
import { writeQueueGh, closes, titled, failsOn, ghCalls } from "./support/queue-gh.mjs";
import { writeExecStub } from "./support/exec-stub.mjs";

const SCRIPT = fileURLToPath(new URL("../plugin/scripts/ledger.mjs", import.meta.url));

function fixture(t, body = null) {
  // The ledger sits in `<root>/.fleet/`, as it does in a main checkout, so the
  // tier-outcomes file a finisher dispatch reads is `<root>/docs/metrics/`'s.
  const root = mkdtempSync(join(tmpdir(), "ledger-dispatch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, ".fleet");
  mkdirSync(dir);
  // A git repository, as a main checkout is: the gh a finisher dispatch runs
  // resolves its repo from the ledger's root.
  assert.equal(spawnSync("git", ["init", "-q", root]).status, 0);
  const file = join(dir, "ledger.md");
  if (body !== null) writeFileSync(file, body);
  const tierOutcomes = join(root, "docs", "metrics", "tier-outcomes.tsv");
  // PR `pr`'s ruling, the row a finisher dispatch for an implementer's PR waits
  // on, and the closing references `pr view` then answers with: `refs` is that
  // list, `null` for none. `ticket` and the verdicts are any a ruling can carry.
  const rule = (pr, ticket = "1", closed = "yes", refs = null) => {
    mkdirSync(dirname(tierOutcomes), { recursive: true });
    appendFileSync(tierOutcomes, `2026-10-21\t${pr}\t${ticket}\troutine\tslow-high\t${closed}\tno\truled\n`);
    if (refs !== null) closes(bin, pr, refs);
  };
  // PATH is a directory holding one gh stub. It answers the queue `dispatch
  // merge-bot` records, and the closing references and titles a finisher
  // dispatch reads, as `closes`, `titled` and `failsOn` set them; `ghCalls`
  // lists what it was asked.
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeQueueGh(bin);
  const env = { ...process.env, PATH: bin };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  // Every dispatch through `cli` finds its member's brief rendered beside the
  // ledger, as a controller's does; `bare` renders nothing, for the tests of
  // that gate.
  const bare = (...args) => {
    const r = spawnSync(process.execPath, [SCRIPT, "--file", file, ...args], { encoding: "utf8", env, cwd: dir });
    return { ...r, json: r.status === 0 ? JSON.parse(r.stdout) : null };
  };
  const cli = rendering(dir, bare);
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
  // A row's text written straight into the file, past `row`'s guards: the
  // ledger state a test is about, carrying review tokens only `review`
  // writes, or a PR split across two rows as a ledger from before #2288 holds.
  const put = (key, text) => {
    const l = read();
    const line = `#${key} ${text}`;
    const i = l.rows.findIndex((r) => r.split(/\s/)[0] === `#${key}`);
    const rows = i === -1 ? [...l.rows, line] : l.rows.with(i, line);
    const list = (entries) => entries.map((e) => `- ${e}\n`).join("");
    writeFileSync(file, `# Fleet run ledger\n\n## Rows\n\n${list(rows)}\n## Dispatched\n\n${list(l.dispatched)}\n## Filed\n\n${list(l.filed)}\n## Ruled\n\n${list(l.ruled)}`
      + (l.drain === null ? "" : `\n## Drain\n\n- ${l.drain}\n`));
  };
  // The `brief` a dispatch prints for `member`: the sidecar's sha256, and the
  // brief file beside it.
  const briefOf = (member) => ({
    path: join(dir, "briefs", `${member}.md`),
    sha256: JSON.parse(readFileSync(join(dir, "briefs", `${member}.json`), "utf8")).sha256,
  });
  return { dir, file, bin, env, bare, cli, ok, read, bytes, refused, put, briefOf, tierOutcomes, rule };
}

test("dispatch appends a live member row and records the dispatch in ## Dispatched", (t) => {
  const { ok, read, bytes, briefOf } = fixture(t);
  const out = ok("dispatch", "412", "impl-412");
  assert.deepEqual(out, {
    member: "impl-412", agent: "fleet-implementer-slow-high", ticket: "#412", line: "#412 impl-412", created: true, total: 1, brief: briefOf("impl-412"), queued: null,
  });
  const l = read();
  assert.deepEqual(l.rows, ["#412 impl-412"]);
  assert.deepEqual(l.dispatched, ["impl-412"]);
  assert.match(bytes(), new RegExp(`^## Dispatched\\n\\n- impl-412 brief=${out.brief.sha256.slice(0, 8)}$`, "m"));
});

// SKILL.md's phase 2 writes `row <N> "impl-<N> · class=routine"` at dispatch
// today, so a row that already carries the live token is the ordinary case
// and must be accepted without a second copy of it.
test("dispatch keeps an existing row's text, appending the token only where it is missing", (t) => {
  const { ok, read, briefOf } = fixture(t);
  ok("row", "412", "impl-412 · class=routine");
  ok("row", "415", "claimed · class=correction");
  assert.deepEqual(ok("dispatch", "412", "impl-412"), {
    member: "impl-412", agent: "fleet-implementer-slow-high", ticket: "#412", line: "#412 impl-412 · class=routine", created: false, total: 1, brief: briefOf("impl-412"), queued: null,
  });
  assert.equal(ok("dispatch", "#415", "impl-415").line, "#415 claimed · class=correction · impl-415");
  assert.deepEqual(read().dispatched, ["impl-412", "impl-415"]);
});

test("a PR-bound member lands on the row carrying its PR, named by PR or by ticket", (t) => {
  const { ok, read, briefOf, rule } = fixture(t);
  rule(346, "1", "yes", [324]);
  ok("dispatch", "324", "impl-324");
  ok("settle", "impl-324", "PR#346");
  // By the PR number: found through the implementer's own settled token.
  assert.deepEqual(ok("dispatch", "346", "fix-pr-346"), {
    member: "fix-pr-346", agent: "fleet-fix-applier", ticket: "#324", line: "#324 impl-324=PR#346 · fix-pr-346", created: false, total: 2, brief: briefOf("fix-pr-346"), queued: null,
  });
  // By the ticket number whose row carries that PR.
  assert.equal(ok("dispatch", "324", "finisher-pr-346").line, "#324 impl-324=PR#346 · fix-pr-346 · finisher-pr-346");
  // The human-readable arrow is found the same way on a row with no impl
  // token, which is read by its first `PR#` mention...
  ok("row", "330", "→ PR#350");
  assert.equal(ok("dispatch", "350", "fix-pr-350").ticket, "#330");
  // ...never on a live implementer's row, whose PR is its settled token's
  // alone (#2888): that PR gets a row of its own.
  ok("row", "331", "impl-331 → PR#351");
  assert.equal(ok("dispatch", "351", "fix-pr-351").ticket, "#351");
  // A PR no row carries gets a row of its own.
  assert.deepEqual(ok("dispatch", "777", "fix-pr-777"), {
    member: "fix-pr-777", agent: "fleet-fix-applier", ticket: "#777", line: "#777 fix-pr-777", created: true, total: 6, brief: briefOf("fix-pr-777"), queued: null,
  });
  assert.equal(read().rows.length, 5);
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
  refused(["dispatch", "412", "impl-412"], /impl-412 was already dispatched this session \(impl-412\) — a replacement takes a name of its own \(impl-412-b\)/);
  ok("settle", "impl-412", "killed");
  refused(["dispatch", "412", "impl-412"], /impl-412 was already dispatched this session \(impl-412=killed\) — a replacement takes a name of its own \(impl-412-b\)/);
  assert.equal(ok("dispatch", "412", "impl-412-b").line, "#412 impl-412=killed · impl-412-b");
  assert.deepEqual(read().dispatched, ["impl-412=killed", "impl-412-b"]);
});

test("merge-bot-<n> counts the ## Dispatched merge-bot entries, and a new ledger starts again at 1", (t) => {
  const { ok, read, refused, briefOf } = fixture(t);
  assert.deepEqual(ok("dispatch", "merge-bot"), { member: "merge-bot-1", agent: "fleet-merge-bot", ticket: null, line: null, created: false, total: 1, brief: briefOf("merge-bot-1"), queued: [] });
  ok("dispatch", "412", "impl-412");
  ok("settle", "merge-bot-1", "done");
  // A settled bot still counts: its replacement gets a new n.
  assert.equal(ok("dispatch", "merge-bot").member, "merge-bot-2");
  // The explicit name is accepted when it is the next one, and only then.
  assert.equal(ok("dispatch", "merge-bot-3").member, "merge-bot-3");
  refused(["dispatch", "merge-bot-5"], /the next merge bot this session is merge-bot-4/);
  refused(["dispatch", "merge-bot-2"], /the next merge bot this session is merge-bot-4/);
  const l = read();
  assert.deepEqual(l.dispatched, ["merge-bot-1=done", "impl-412", "merge-bot-2", "merge-bot-3"]);
  assert.deepEqual(l.rows, ["#412 impl-412"], "a merge bot works no ticket, so it writes no row");

  const fresh = fixture(t);
  assert.equal(fresh.ok("dispatch", "merge-bot").member, "merge-bot-1");
});

// A merge bot's report is judged at its settle against the queue its
// dispatch recorded, so that queue is gh's answer at dispatch, written beside
// the bot's brief where no report field reaches it, and a settle keeps it.
test("dispatch merge-bot records the ready-to-merge queue gh lists on its ## Dispatched entry, and settle keeps it", (t) => {
  const { ok, read, bytes, bin } = fixture(t);
  writeQueueGh(bin, [30, 12, 30]);
  assert.deepEqual(ok("dispatch", "merge-bot").queued, [12, 30]);
  assert.match(bytes(), /^- merge-bot-1 brief=[0-9a-f]{8} queued=12,30$/m);
  ok("settle", "merge-bot-1", "done");
  assert.match(bytes(), /^- merge-bot-1=done brief=[0-9a-f]{8} queued=12,30$/m);
  writeQueueGh(bin);
  assert.deepEqual(ok("dispatch", "merge-bot").queued, []);
  assert.match(bytes(), /^- merge-bot-2 brief=[0-9a-f]{8} queued=none$/m);
  assert.deepEqual(read().queued, { "merge-bot-1": [12, 30], "merge-bot-2": [] });
  // No other member's dispatch reads the queue: a gh that fails every call
  // stops none of them.
  writeExecStub(join(bin, "gh"), "#!/bin/sh\nexit 1\n");
  assert.equal(ok("dispatch", "412", "impl-412").queued, null);
  assert.deepEqual(read().queued, { "merge-bot-1": [12, 30], "merge-bot-2": [] });
});

test("dispatch merge-bot lists the queue with GIT_DIR and GIT_WORK_TREE scrubbed from gh's environment", (t) => {
  const { ok, bin, dir, env } = fixture(t);
  const log = join(dir, "gh-env.log");
  writeExecStub(join(bin, "gh"), `#!/bin/sh\nprintf '%s|%s\\n' "\${GIT_DIR-unset}" "\${GIT_WORK_TREE-unset}" > '${log}'\nprintf '[]\\n'\n`);
  env.GIT_DIR = join(dir, "elsewhere.git");
  env.GIT_WORK_TREE = join(dir, "elsewhere");
  assert.equal(ok("dispatch", "merge-bot").member, "merge-bot-1");
  assert.equal(readFileSync(log, "utf8"), "unset|unset\n");
});

test("dispatch merge-bot refuses, writing nothing, when gh does not give it the whole queue", (t) => {
  const { refused, bin } = fixture(t);
  for (const [body, why] of [
    ["#!/bin/sh\nprintf 'gh: not logged in\\n' >&2\nexit 4\n", /could not read the queue to record — gh pr list --state open --label ready-to-merge --limit 1000 --json number exited 4: gh: not logged in; nothing written/],
    ["#!/bin/sh\nkill -9 $$\n", /could not read the queue to record — gh pr list --state open --label ready-to-merge --limit 1000 --json number killed by SIGKILL; nothing written/],
    ["#!/bin/sh\nprintf 'not json\\n'\n", /printed no list of PR numbers: not json/],
    ["#!/bin/sh\nprintf '[{\"number\":\"7\"}]\\n'\n", /printed no list of PR numbers/],
    ["#!/bin/sh\nprintf '[{\"number\":0}]\\n'\n", /printed no list of PR numbers/],
    ["#!/bin/sh\nprintf '[{\"number\":-3}]\\n'\n", /printed no list of PR numbers/],
  ]) {
    writeExecStub(join(bin, "gh"), body);
    refused(["dispatch", "merge-bot"], why);
  }
  writeQueueGh(bin, Array.from({ length: 1000 }, (_, i) => i + 1));
  refused(["dispatch", "merge-bot"], /answered 1000 PRs, the limit, so the queue may be longer/);
});

test("merge-bot-<n> numbers past a settled merge-bot token a row holds that ## Dispatched never saw", (t) => {
  const { ok, put, refused } = fixture(t);
  put("5", "merge-bot-1=done");
  // Counting only ## Dispatched would hand out merge-bot-1 again, and the
  // refusal of it would name merge-bot-1 as its own replacement.
  refused(["dispatch", "merge-bot-1"], /merge-bot-1 is not next — the next merge bot this session is merge-bot-2/);
  assert.equal(ok("dispatch", "merge-bot").member, "merge-bot-2");
});

test("a refused name's replacement climbs past every letter the session holds, wherever it sits, and runs out at -z", (t) => {
  const { ok, put, refused } = fixture(t);
  // `-b` is held only by a settled token on a row, not by ## Dispatched.
  put("412", "impl-412=killed · impl-412-b=killed");
  refused(["dispatch", "412", "impl-412"], /impl-412 was already dispatched this session \(impl-412=killed\) — a replacement takes a name of its own \(impl-412-c\)/);
  const z = fixture(t);
  z.ok("dispatch", "7", "impl-7-z");
  z.ok("settle", "impl-7-z", "killed");
  z.refused(["dispatch", "7", "impl-7-z"], /impl-7-z was already dispatched this session \(impl-7-z=killed\) — a replacement takes a name of its own, and impl-7-z has no retry letter left/);
});

// #2208: the controller names the `task` call's `agent` off this output, not
// off prose a compaction drops — so every family's definition is printed, and
// an implementer's follows its row's `tier=` the way tier-check.mjs reads it:
// none is the policy cell, `slow-high`.
test("dispatch prints the agent definition the call names: the row's tier for an implementer, fixed for a fix-applier, finisher and merge bot", (t) => {
  const { ok, rule } = fixture(t);
  rule(70, "1", "yes", [7]);
  assert.equal(ok("dispatch", "7", "impl-7").agent, "fleet-implementer-slow-high");
  ok("row", "8", "impl-8 · class=routine · tier=task-high");
  assert.equal(ok("dispatch", "8", "impl-8").agent, "fleet-implementer-task-high");
  // A replacement inherits the row's tier, because it reads the same row.
  ok("settle", "impl-8", "killed");
  assert.equal(ok("dispatch", "8", "impl-8-b").agent, "fleet-implementer-task-high");
  // Neither verdict token is a `tier=` token.
  ok("row", "10", "impl-10 · tier-ok=impl-10:fleet-implementer-task-high · tier-mismatch=impl-10:fleet-implementer-task-high");
  assert.equal(ok("dispatch", "10", "impl-10").agent, "fleet-implementer-slow-high");
  ok("settle", "impl-7", "PR#70");
  assert.equal(ok("dispatch", "70", "finisher-pr-70").agent, "fleet-finisher");
  assert.equal(ok("dispatch", "70", "fix-pr-70").agent, "fleet-fix-applier");
  assert.equal(ok("dispatch", "merge-bot").agent, "fleet-merge-bot");
});

// A `tier=` of the right shape whose definition has no file is refused the
// same way: a `task` call naming it cannot resolve. Two of those: a cell
// outside the shipped grid (`smol-max` — haiku has no `max`), and the
// pre-cell `alt`, whose definition is deleted. `row` refuses a non-cell
// `tier=` before it is written, so the rows `row` would refuse are written
// as a ledger edited by hand — the case dispatch's own check still meets.
test("dispatch refuses an implementer whose row names no single definition, or one with no file, before marking it live", (t) => {
  const rows = ["#7 class=routine · tier=alt · tier=slow-high", "#8 class=routine · tier=../../etc", "#9 class=routine · tier=", "#11 class=routine · tier=alt"];
  const { ok, read, refused } = fixture(t, `# Fleet run ledger\n\n## Rows\n\n${rows.map((r) => `- ${r}\n`).join("")}\n## Filed\n\n## Ruled\n\n`);
  refused(["dispatch", "7", "impl-7"], /impl-7: row carries conflicting tier= tokens \(tier=alt, tier=slow-high\) — fix the row with `ledger\.mjs row` — not dispatching impl-7/);
  refused(["dispatch", "8", "impl-8"], /impl-8: tier=\.\.\/\.\.\/etc is not a definition suffix — expected \[a-z0-9\] words joined by '-' — fix the row with `ledger\.mjs row` — not dispatching impl-8/);
  refused(["dispatch", "9", "impl-9"], /impl-9: tier= is not a definition suffix/);
  ok("row", "10", "class=routine · tier=smol-max");
  refused(["dispatch", "10", "impl-10"], /impl-10: row #10's tier= names fleet-implementer-smol-max, which has no agents\/fleet-implementer-smol-max\.agent\.md — fix the row with `ledger\.mjs row` — not dispatching impl-10/);
  refused(["dispatch", "11", "impl-11"], /impl-11: row #11's tier= names fleet-implementer-alt, which has no agents\/fleet-implementer-alt\.agent\.md/);
  ok("row", "12", "class=routine · tier=task-high · tier=slow-high");
  refused(["dispatch", "12", "impl-12"], /impl-12: row carries conflicting tier= tokens \(tier=task-high, tier=slow-high\)/);
  assert.deepEqual(read().dispatched, []);
});

// `row` holds `tier=` to the cell grammar, so a retired or misspelt tier is
// refused at the Pull's own write, before the claim is dispatched on — and a
// cell token is accepted whether or not its definition has shipped, which is
// `dispatch`'s to check. The value is held to the whole grammar, not a prefix
// of it: a real family with an unknown level, a cell with trailing text, or a
// case-variant of a cell is refused. Only a token that STARTS with `tier=` is
// a tier token, so one that merely contains it (`x-tier=alt`) is written as is.
test("row refuses a tier= that is not a cell token, and accepts every cell token", (t) => {
  const { ok, read, refused } = fixture(t);
  const bads = [
    "tier=alt", "tier=", "tier=../../etc", "tier=Task-High", "tier=task-high · tier=alt", "tier=haiku-high",
    "tier=slow-ultra", "tier=task-", "tier=smol-", "tier=slow", "tier=task-high-x", "tier=task-high-", "tier=task-highx",
    "tier==task-high", "tier=task-high,", "tier=TASK-HIGH", "tier=Slow-High", "tier=slow-HIGH", "tier=xslow-high",
  ];
  for (const bad of bads) {
    refused(["row", "7", `impl-7 · ${bad}`], /row #7: 'tier=[^']*' is not tier=<cell>/);
  }
  assert.deepEqual(read().rows, []);
  const goods = ["tier=task-high", "tier=slow-high", "tier=smol-max", "tier-ok=impl-7:fleet-implementer-task-high", "x-tier=alt", "x-tier=Slow-ultra · tier=task-high"];
  // Each on its own row: rewriting one row's cell while its implementer has
  // not settled is refused.
  for (const [i, good] of goods.entries()) {
    const n = 7 + i;
    assert.equal(ok("row", String(n), `impl-${n} · ${good}`).line, `#${n} impl-${n} · ${good}`);
  }
});

// The refusal is about the implementer's own definition: a member whose
// definition does not come off `tier=` must still be dispatchable on such a
// row, or one bad token would strand the PR's finisher and fix-applier.
test("a malformed tier= on a row does not refuse a member whose definition ignores it", (t) => {
  const { ok, rule } = fixture(t);
  rule(70, "1", "yes", [7]);
  ok("row", "7", "impl-7=PR#70 · tier=task-high · tier=slow-high");
  assert.equal(ok("dispatch", "70", "fix-pr-70").agent, "fleet-fix-applier");
  assert.equal(ok("dispatch", "7", "finisher-pr-70").agent, "fleet-finisher");
});

// A fix-applier on a review, on a conflict hold and on a dispositions mismatch
// is one definition, `fleet-fix-applier`, whatever the row's tier or the hold's
// spelling — the dispositions-mismatch case sits beside the dispositions gate
// below, whose fixtures it reads.
test("dispatch names a fix-applier fleet-fix-applier on a review and on a conflict hold, whatever the row's tier or the hold's spelling", (t) => {
  const { ok } = fixture(t);
  // A review's fix-applier, on a row with no hold.
  ok("row", "30", "impl-30=PR#31");
  assert.equal(ok("dispatch", "31", "fix-pr-31").agent, "fleet-fix-applier");

  // A conflict hold: unresolved, and its replacement after a failed attempt.
  ok("row", "20", "impl-20=PR#21 · conflict-hold:#21");
  assert.equal(ok("dispatch", "21", "fix-pr-21").agent, "fleet-fix-applier");
  ok("settle", "fix-pr-21", "failed");
  assert.equal(ok("dispatch", "21", "fix-pr-21-b").agent, "fleet-fix-applier");

  // `tier=` is not consulted — conflicting values neither change nor refuse it.
  ok("row", "50", "impl-50=PR#51 · tier=task-high · conflict-hold:#51");
  assert.equal(ok("dispatch", "51", "fix-pr-51").agent, "fleet-fix-applier");
  ok("row", "60", "impl-60=PR#61 · tier=task-high · tier=slow-high · conflict-hold:#61");
  assert.equal(ok("dispatch", "61", "fix-pr-61").agent, "fleet-fix-applier");

  // The hold's other spelling the tick reads (fleet-tick.mjs's CONFLICT_HOLD).
  ok("row", "70", "impl-70=PR#71 · conflict-hold-71");
  assert.equal(ok("dispatch", "71", "fix-pr-71").agent, "fleet-fix-applier");

  // A hold a fix-applier settled `applied:`/`no-op` after is cleared, and the
  // row's next fix-applier works a review's survivors: the same definition.
  ok("row", "80", "impl-80=PR#81 · conflict-hold:#81 · fix-pr-81=applied:def5678");
  ok("review", "81", "review=member:review-pr-81", "reviewed=abc1234:1/0/0:run-abc1234r");
  assert.equal(ok("dispatch", "81", "fix-pr-81-b").agent, "fleet-fix-applier");
});

// A finisher's conflict-hold and dispositions gates read the tick's fold, so a
// ledger the tick refuses — here a hold recorded on another PR's row — is
// refused for it, naming the ledger as the cause, before the member is live.
test("dispatch refuses a finisher on a ledger the tick refuses, before marking it live", (t) => {
  const { ok, read, refused } = fixture(t);
  ok("row", "40", "impl-40=PR#41 · conflict-hold:#42");
  refused(["dispatch", "41", "finisher-pr-41"], /— fleet-tick\.mjs refuses this ledger, so finisher-pr-41's conflict hold and dispositions verdict cannot be read off it/);
  assert.deepEqual(read().dispatched, []);
});

test("settle rewrites the member's token in its row and in ## Dispatched, and nothing else", (t) => {
  const { ok, read, rule } = fixture(t);
  rule(420, "1", "yes", [412]);
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

test("settle accepts impl-<N>=blocked in both spellings, keeping the row and the claim", (t) => {
  const { ok, read } = fixture(t);
  ok("row", "412", "impl-412 · class=routine");
  ok("dispatch", "412", "impl-412");
  // The one-token spelling.
  assert.deepEqual(ok("settle", "impl-412=blocked"), {
    member: "impl-412", outcome: "blocked", ticket: "#412", line: "#412 impl-412=blocked · class=routine", changed: true,
  });
  // The two-token spelling.
  ok("dispatch", "415", "impl-415");
  assert.equal(ok("settle", "impl-415", "blocked").line, "#415 impl-415=blocked");
  assert.deepEqual(read().dispatched, ["impl-412=blocked", "impl-415=blocked"]);
  assert.deepEqual(read().rows, ["#412 impl-412=blocked · class=routine", "#415 impl-415=blocked"]);
  // Another family has no such outcome.
  const f = fixture(t);
  f.ok("dispatch", "20", "fix-pr-20");
  f.refused(["settle", "fix-pr-20", "blocked"], /'blocked' is not an outcome of fix-pr-M/);
});

test("settle refuses an outcome outside the member's vocabulary, and a malformed call, writing nothing", (t) => {
  const { ok, refused } = fixture(t);
  ok("dispatch", "412", "impl-412");
  ok("dispatch", "merge-bot");
  for (const [args, why] of [
    [["settle", "impl-412", "done"], /'done' is not an outcome of impl-N — expected PR#M \| bailed \| released \| killed \| tier-mismatch \| blocked/],
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
    ["8", "impl-8=PR#9 · fix-pr-9=applied:73b356de · ci=123:1:success"],
    ["10", "held-behind:#9 · merge-bot-1=done"],
    ["11", "impl-11 · tier=task-high · tier-ok=impl-11:fleet-implementer-task-high"],
    ["12", "impl-12=bailed · tier-mismatch=impl-12:fleet-implementer · impl-12: dispatched task, expected fleet-implementer"],
  ];
  for (const [ticket, text] of rows) ok("row", ticket, text);
  assert.deepEqual(read().rows, rows.map(([n, text]) => `#${n} ${text}`));
});

// #2331: `label-off=<attempt>` marks the controller's own removal of
// `ready-to-merge`, so the tick does not read it as a finisher's miss. One
// naming no finisher this run ever had would hide a real miss behind a record
// of nothing, so `row` refuses it — locally, off `## Dispatched` and the rows'
// member tokens, the same two places dispatch's live-sibling check reads.
test("row refuses a label-off naming no finisher this run has, writing nothing", (t) => {
  const { ok, read, refused, rule } = fixture(t);
  rule(40, "1", "yes", [10]); rule(41);
  ok("dispatch", "10", "impl-10");
  ok("settle", "impl-10", "PR#40");
  ok("dispatch", "40", "finisher-pr-40");
  const before = read().rows;
  for (const [tok, why] of [
    ["label-off=finisher-pr-40-b", /'label-off=finisher-pr-40-b' names no finisher-pr member/], // never dispatched
    ["label-off=finisher-pr-41", /'label-off=finisher-pr-41'/], // another PR's, never dispatched
    ["label-off=impl-10", /'label-off=impl-10' names no finisher-pr member/], // a member, not a finisher
    ["label-off=finisher-pr-40=labelled", /'label-off=finisher-pr-40=labelled'/], // a token, not a name
    ["label-off=", /'label-off='/],
  ]) {
    refused(["row", "10", `impl-10=PR#40 → PR#40 · finisher-pr-40 ${tok}`], why);
  }
  // The new line's own copy of a name does not vouch for it.
  refused(["row", "10", "impl-10=PR#40 → PR#40 · finisher-pr-40-c=labelled label-off=finisher-pr-40-c"], /'label-off=finisher-pr-40-c'/);
  assert.deepEqual(read().rows, before);
});

test("row accepts a label-off naming a finisher in ## Dispatched or on any row, settled or live", (t) => {
  const { ok, read, rule } = fixture(t);
  rule(40, "1", "yes", [10]); rule(50);
  ok("dispatch", "10", "impl-10");
  ok("settle", "impl-10", "PR#40");
  ok("dispatch", "40", "finisher-pr-40");
  ok("settle", "finisher-pr-40", "labelled");
  // Only in `## Dispatched`: a whole-line rewrite dropped the settled token
  // from the row first, so no row names the attempt any more.
  ok("row", "10", "impl-10=PR#40 → PR#40");
  ok("row", "10", "impl-10=PR#40 → PR#40 label-off=finisher-pr-40");
  // Only on a row — a token `row` wrote never enters `## Dispatched`.
  ok("row", "50", "finisher-pr-50");
  ok("row", "50", "finisher-pr-50 label-off=finisher-pr-50");
  assert.deepEqual(read().rows, [
    "#10 impl-10=PR#40 → PR#40 label-off=finisher-pr-40",
    "#50 finisher-pr-50 label-off=finisher-pr-50",
  ]);
  assert.deepEqual(read().dispatched, ["impl-10=PR#40", "finisher-pr-40=labelled"]);
});

// #1876: the tick owes an open PR a review while its implementer is still
// live, so a PR-bound member can be dispatched before `settle impl-N=PR#M`
// names the PR on the ticket row. dispatch's fallback then keys a row of its
// own to the PR — truthful until the settle, when two rows would name one PR:
// the cockpit drew two REVIEW cards and the tick's `byPr`, first-row-wins until
// #2283, lost the live review. The settle folds the PR-keyed row into the ticket row.
test("settle impl-N=PR#M folds the PR-keyed row a pre-settle dispatch created into the ticket row", (t) => {
  const { ok, read, rule } = fixture(t);
  rule(1301, "1", "yes", [1300]);
  ok("dispatch", "1300", "impl-1300");
  assert.equal(ok("dispatch", "1301", "fix-pr-1301").line, "#1301 fix-pr-1301");
  assert.equal(ok("review", "1301", "review=member:review-pr-1301").row, "#1301");
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

// A PR has one row. `settle impl-N=PR#M` refuses a PR another row already
// maps to, through the same added-only check `row` uses, judged on the folded
// ledger; the refused member settles `=bailed`.
test("settle impl-N=PR#M refuses a PR another row already maps to, writing nothing", (t) => {
  const { ok, read, refused } = fixture(t);
  ok("row", "658", "Pull · impl-658");
  ok("row", "659", "Pull · impl-659");
  ok("dispatch", "658", "impl-658");
  ok("dispatch", "659", "impl-659");
  ok("settle", "impl-658", "PR#724");
  refused(["settle", "impl-659=PR#724"], /PR #724 would map to more than one row/);
  refused(["settle", "impl-659=PR#724"], /PR's row is #658\b/);
  refused(["settle", "impl-659", "PR#724"],
    /^ledger: settle impl-659=PR#724: PR #724 would map to more than one row — its PR's row is #658; settle impl-659 =bailed or to a PR of its own$/m);

  assert.equal(ok("settle", "impl-659=bailed").line, "#659 Pull · impl-659=bailed");
  const l = read();
  assert.deepEqual(l.rows.filter((r) => rowPr(r) === 724), ["#658 Pull · impl-658=PR#724"]);
  const run = deriveRun({ rows: l.rows, dispatched: l.dispatched, drain: null },
    [{ number: 724, labels: [], closingIssuesReferences: [{ number: 658 }, { number: 659 }] }]);
  assert.equal(run.implLive, 0);
});

test("settle impl-N=PR#M still accepts every write that adds no second row for the PR", async (t) => {
  await t.test("the same outcome again", (t) => {
    const { ok, bytes } = fixture(t);
    ok("dispatch", "658", "impl-658");
    ok("settle", "impl-658=PR#724");
    const before = bytes();
    assert.equal(ok("settle", "impl-658=PR#724").changed, false);
    assert.equal(bytes(), before);
  });
  await t.test("a replacement on the PR's own row", (t) => {
    const { ok, read } = fixture(t);
    ok("dispatch", "658", "impl-658");
    ok("settle", "impl-658=PR#724");
    ok("dispatch", "658", "impl-658-b");
    assert.equal(ok("settle", "impl-658-b=PR#724").ticket, "#658");
    assert.deepEqual(read().rows.filter((r) => rowPr(r) === 724), ["#658 impl-658=PR#724 · impl-658-b=PR#724"]);
  });
  await t.test("a #M fallback row the fold absorbs — the check runs after the fold", (t) => {
    const { ok, read } = fixture(t);
    ok("dispatch", "658", "impl-658");
    assert.equal(ok("dispatch", "724", "fix-pr-724").line, "#724 fix-pr-724");
    assert.equal(ok("settle", "impl-658=PR#724").line, "#658 impl-658=PR#724 · fix-pr-724");
    assert.deepEqual(read().rows, ["#658 impl-658=PR#724 · fix-pr-724"]);
  });
  await t.test("a split already on disk", (t) => {
    const { ok, read, put } = fixture(t);
    put("658", "Pull · impl-658=PR#724 · impl-658-b");
    put("659", "Pull · impl-659=PR#724");
    assert.equal(ok("settle", "impl-658-b=PR#724").line, "#658 Pull · impl-658=PR#724 · impl-658-b=PR#724");
    assert.equal(read().rows.filter((r) => rowPr(r) === 724).length, 2);
  });
});

// #2064: merge-bot records a conflict its local-rebase fallback would not
// force with `row`, and the fix-applier is recorded with the ordinary
// `dispatch`/`settle`. The tick clears the hold only on a settle positioned
// AFTER the hold token, so the writers must put it there — including when
// the PR's review-fix `fix-pr-<M>` already settled earlier on the same row.
test("a conflict hold written by row is cleared by a later dispatch + settle, in the order the tick reads", (t) => {
  const { ok, read, put } = fixture(t);
  const before = "impl-10=PR#40 · review=member:review-pr-40 reviewed=abc1234:1/0/0:run-abc1234r · fix-pr-40=applied:73b356de";
  put("10", before);
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

// #2328: the conflict fix-applier rebases without the review file, so once it
// lands the PR's unanswered survivors come back due, and the next fix-applier
// answers them.
test("a review's survivors outlive a conflict fix-applier's settle: the next fix-applier is a review one", (t) => {
  const { ok, read, put } = fixture(t);
  put("20", "impl-20=PR#21 · review=member:review-pr-21 reviewed=abc1234:2/0/0:run-abc1234r · conflict-hold:#21");
  const tick = () => {
    const l = read();
    return deriveRun({ rows: l.rows, dispatched: l.dispatched, drain: null },
      [{ number: 21, labels: [], closingIssuesReferences: [{ number: 20 }] }]);
  };
  assert.deepEqual([tick().fixDue, tick().conflictHeld], [[21], [21]]);
  assert.equal(ok("dispatch", "21", "fix-pr-21").agent, "fleet-fix-applier");
  assert.deepEqual(tick().fixDue, [], "one fix-applier at a time");
  ok("settle", "fix-pr-21", "applied:def5678");
  assert.deepEqual([tick().fixDue, tick().conflictHeld], [[21], []], "the survivors it never read are due again");
  assert.equal(ok("dispatch", "21", "fix-pr-21-b").agent, "fleet-fix-applier");
  ok("settle", "fix-pr-21-b", "applied:0123abc");
  assert.deepEqual(tick().fixDue, []);
});

test("the fold takes the PR row's settled tokens in order, under the two-argument spelling, wherever the PR row sits", (t) => {
  const { ok, read, put } = fixture(t);
  // The PR's row comes first here, and a third row follows the ticket's.
  ok("dispatch", "1311", "fix-pr-1311");
  ok("settle", "fix-pr-1311", "applied:73b356de");
  put("1311", "fix-pr-1311=applied:73b356de · review=wf:r1=failed review=wf:r2 reviewed=abc1234:1/0/0:run-abc1234r · ci=9:1:success");
  ok("row", "1310", "impl-1310 · class=routine");
  ok("dispatch", "1320", "impl-1320");
  const folded = "#1310 impl-1310=PR#1311 · class=routine · fix-pr-1311=applied:73b356de · review=wf:r1=failed review=wf:r2 reviewed=abc1234:1/0/0:run-abc1234r · ci=9:1:success";
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
// is today's token rewrite and nothing more. A row keyed #M whose implementer
// names no PR still maps to M by its key, so settling to M there would put a
// second row on M and is refused, writing nothing.
test("settle folds no row keyed to another PR, no row carrying an impl- token, and nothing when the PR has no row", (t) => {
  const { ok, read, put, refused } = fixture(t);
  ok("dispatch", "412", "impl-412");
  ok("dispatch", "777", "fix-pr-777");
  ok("dispatch", "420", "impl-420");
  put("421", "impl-421=killed · review=wf:r2");
  put("422", "impl-422=PR#900 · review=wf:r3");
  ok("dispatch", "413", "impl-413");
  ok("dispatch", "414", "impl-414");
  ok("dispatch", "415", "impl-415");
  const before = read().rows;

  // #420 and #421 are keyed to the PR but are implementers' own rows (live or
  // settled) naming no PR; #422 is keyed to the PR but its implementer's PR is 900.
  refused(["settle", "impl-412", "PR#420"], /PR #420 would map to more than one row — its PR's row is #420\b/);
  refused(["settle", "impl-413=PR#421"], /PR #421 would map to more than one row — its PR's row is #421\b/);
  assert.equal(ok("settle", "impl-415=PR#422").line, "#415 impl-415=PR#422");
  // No row keyed #500 at all; #777 belongs to a PR nobody here settles to.
  assert.equal(ok("settle", "impl-414", "PR#500").line, "#414 impl-414=PR#500");
  assert.deepEqual(read().rows, before.map((r) => r
    .replace(/^#415 impl-415$/, "#415 impl-415=PR#422")
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
// to it must never be folded from — `rowPr()`, the tick's reading too, takes
// the FIRST settled `impl-<N>=PR#<M>` token on a row, so folding here would let a
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
  ok("review", "160", "review=member:review-pr-160");
  assert.equal(ok("settle", "impl-100-b", "PR#160").line, "#100 impl-100=PR#150 · impl-100-b=PR#160");
  assert.deepEqual(read().rows, [
    "#100 impl-100=PR#150 · impl-100-b=PR#160",
    "#160 fix-pr-160 · review=member:review-pr-160",
  ]);
});

// A ticket row whose first attempt settled to one PR and whose replacement
// settled to another: the ledger keeps both on the row (above) and the tick
// keys the row's tokens to the first. The board reads each PR's state off the
// tick's own fold, so the PR the latest attempt opened is one card, with that
// PR's state and none of the first PR's.
const REPLACED_HEAD = "abc1234";
const boardOf = (ledger, prs) => computeBoard({
  ledger: { rows: ledger.rows, dispatched: ledger.dispatched, filed: [], ruled: [] },
  issues: [], merged: [], ci: {}, prev: { tickets: [] }, now: 0, prs,
});

test("a ticket row retried under a second PR is one board card on the latest PR, with that PR's own state", (t) => {
  const { ok, read, rule, bin } = fixture(t);
  rule(724, "1", "yes", [658]);
  closes(bin, 724, [659]);
  ok("dispatch", "659", "impl-659");
  ok("settle", "impl-659", "PR#800");
  ok("dispatch", "659", "impl-659-b");
  ok("dispatch", "724", "fix-pr-724");
  ok("settle", "impl-659-b", "PR#724");
  ok("dispatch", "724", "finisher-pr-724");
  ok("review", "800", "review=member:review-pr-800");
  ok("review", "800", `reviewed=${REPLACED_HEAD}:0/0/0:run-abcd1234`);
  ok("settle", "fix-pr-724", "no-op");
  ok("settle", "finisher-pr-724", "failed");
  const ledger = read();
  assert.deepEqual(ledger.rows, [
    `#659 impl-659=PR#800 · impl-659-b=PR#724 · review=member:review-pr-800 · reviewed=${REPLACED_HEAD}:0/0/0:run-abcd1234`,
    "#724 fix-pr-724=no-op · finisher-pr-724=failed",
  ], "the fold was skipped, as designed");
  const board = boardOf(ledger, [{ number: 724, state: "OPEN", labels: [], title: "pr 724", headRefOid: "def5678def5678def5678def5678def5678def" }]);
  const cards = board.tickets.filter((c) => c.pr !== null);
  assert.deepEqual(cards.map((c) => [c.issue, c.pr]), [[659, 724]], "one card per PR: no #724 card, none for PR 800");
  assert.equal(board.queue.reviewBacklog, 1, "PR 724 has no review of its own, and PR 800's reviewed= is not it");
  assert.equal(cards.filter((c) => c.flags.includes("finisher:failed")).length, 1);
  const run = deriveRun({ rows: ledger.rows, dispatched: ledger.dispatched, drain: null },
    [{ number: 724, labels: [], closingIssuesReferences: [{ number: 659 }], headRefOid: "def5678" }]);
  assert.deepEqual(run.reviewDue, [724], "the tick agrees");
});

test("a ticket row and an unrelated fallback row each keep their own card", (t) => {
  const { ok } = fixture(t);
  ok("dispatch", "900", "impl-900");
  ok("settle", "impl-900", "PR#901");
  ok("dispatch", "950", "fix-pr-950");
  const board = boardOf(ok("read"), [
    { number: 901, state: "OPEN", labels: [], title: "pr 901" },
    { number: 950, state: "OPEN", labels: [], title: "pr 950" },
  ]);
  assert.deepEqual(board.tickets.map((c) => [c.issue, c.pr]).sort((a, b) => a[0] - b[0]), [[900, 901], [950, 950]]);
  assert.equal(board.queue.reviewBacklog, 1, "PR 901 is owed a review; PR 950's fix-applier is working it");
});

test("a skipped fallback row's own signals land on the card that claims its PR", () => {
  const rows = [
    "#659 impl-659=PR#800 · impl-659-b=PR#724",
    "#724 fix-pr-724 · reviewed=zzz · held-behind:#900 · BLOCKED",
  ];
  const board = boardOf({ rows, dispatched: [] }, [{ number: 724, state: "OPEN", labels: [], title: "pr 724" }]);
  assert.equal(board.tickets.length, 1, "one card for PR 724");
  const [card] = board.tickets;
  assert.deepEqual([card.issue, card.pr, card.agent], [659, 724, "fix-pr-724"]);
  for (const flag of ["ledger-error", "held-behind:#900", "blocked"]) assert.ok(card.flags.includes(flag), flag);
});

test("a row for another ticket that merely names a claimed PR keeps its own card, and the PR is owed one review", () => {
  const rows = ["#659 impl-659=PR#724", "#800 PR#724"];
  const board = boardOf({ rows, dispatched: [] }, [{ number: 724, state: "OPEN", labels: [], title: "pr 724" }]);
  assert.deepEqual(board.tickets.map((c) => [c.issue, c.pr]), [[659, 724], [800, 724]]);
  assert.equal(board.queue.reviewBacklog, 1, "two cards, one PR, one review owed");
});

test("a MERGED token on a skipped fallback row moves the claiming card to MERGED", () => {
  const rows = ["#659 impl-659=PR#800 · impl-659-b=PR#724", "#724 fix-pr-724=no-op → MERGED deadbeef"];
  const board = boardOf({ rows, dispatched: [] }, []);
  assert.deepEqual(board.tickets.map((c) => [c.issue, c.pr, c.column]), [[659, 724, "MERGED"]]);
  assert.equal(board.queue.reviewBacklog, 0);
});

test("a malformed reviewed= token on a PR's row still yields a board, flags that card ledger-error, and the tick still refuses", (t) => {
  const { put, read } = fixture(t);
  put("910", "impl-910=PR#911 · reviewed=abc1234:0/0/0");
  put("920", "impl-920=PR#921 · review=member:review-pr-921 · reviewed=abc1234:0/0/0:run-abcd1234");
  const ledger = read();
  const prs = [911, 921].map((number) => ({ number, state: "OPEN", labels: [], title: `pr ${number}` }));
  const board = boardOf(ledger, prs);
  assert.ok(board.tickets.find((c) => c.issue === 910).flags.includes("ledger-error"));
  assert.ok(!board.tickets.find((c) => c.issue === 920).flags.includes("ledger-error"), "a well-formed row is not flagged");
  assert.throws(() => deriveRun({ rows: ledger.rows, dispatched: ledger.dispatched, drain: null },
    prs.map((p) => ({ ...p, labels: [], closingIssuesReferences: [] }))), LedgerError);
});

test("every token the tick refuses is skipped and flagged by the board, none thrown", (t) => {
  const { put, read } = fixture(t);
  const bad = ["review=bogus:x", "reviewed=zzz", "label-off=impl-1", "conflict-hold:#99", "impl-5=exploded", "reviewed=abc1234:0/0/0"];
  bad.forEach((tok, i) => put(String(930 + i), `impl-${930 + i}=PR#${940 + i} · ${tok}`));
  const ledger = { ...read(), dispatched: ["not a member token"] };
  const prs = bad.map((_, i) => ({ number: 940 + i, state: "OPEN", labels: [], title: "pr" }));
  const board = boardOf(ledger, prs);
  bad.forEach((tok, i) => assert.ok(board.tickets.find((c) => c.issue === 930 + i).flags.includes("ledger-error"), tok));
  bad.forEach((tok, i) => assert.throws(() => deriveRun({ rows: [ledger.rows[i]], dispatched: [], drain: null },
    prs.map((p) => ({ ...p, closingIssuesReferences: [] }))), LedgerError, tok));
});

// #2288: a row keyed `#M` that no implementer claims is folded whatever it
// holds — a review-only row `review` created before the implementer settled
// included — its tokens after the ticket row's, which is write order: nothing
// about PR M can sit on the ticket row before it names `PR#M`. Rows an
// implementer claims, rows keyed to another PR, and a settling row that
// already named a PR stay as they were (above).
test("settle folds a #M row no implementer claims, a review-only one included", (t) => {
  const { ok, read } = fixture(t);
  ok("dispatch", "351", "impl-351");
  assert.equal(ok("review", "358", "review=member:review-pr-358").row, "#358");
  assert.equal(ok("settle", "impl-351", "PR#358").line, "#351 impl-351=PR#358 · review=member:review-pr-358");
  ok("dispatch", "360", "impl-360");
  ok("row", "361", "PR#361 · ci=1:1:success");
  assert.equal(ok("settle", "impl-360", "PR#361").line, "#360 impl-360=PR#361 · PR#361 · ci=1:1:success");
  assert.deepEqual(read().rows, ["#351 impl-351=PR#358 · review=member:review-pr-358", "#360 impl-360=PR#361 · PR#361 · ci=1:1:success"]);
});

// An Exclusion row is keyed to a ticket, so one keyed `#M` is a premise on a
// mistyped PR number, never a row for PR M: the fold leaves it alone, since
// folding it would delete the premise a settled member can never restore. The
// row's key still maps it to M, so the settle would put a second row on M and
// is refused, writing nothing.
test("settle to a mistyped PR number does not fold an Exclusion row keyed #M", (t) => {
  const { ok, read, refused } = fixture(t);
  ok("row", "358", "excluded · behind-pr:#346");
  ok("dispatch", "351", "impl-351");
  refused(["settle", "impl-351", "PR#358"], /PR #358 would map to more than one row — its PR's row is #358\b/);
  assert.deepEqual(read().rows, ["#358 excluded · behind-pr:#346", "#351 impl-351"]);
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

test("a ledger written before ## Dispatched existed reads as none dispatched, none retired and not draining, and survives a dispatch", (t) => {
  const { ok, read, briefOf } = fixture(t, "# Fleet run ledger\n\n## Rows\n\n- #7 impl-7 · class=routine\n\n## Filed\n\n- #8 a filed subject\n\n## Ruled\n\n- #9 MERGE · green\n");
  const legacy = { rows: ["#7 impl-7 · class=routine"], filed: ["#8 a filed subject"], ruled: ["#9 MERGE · green"] };
  assert.deepEqual(read(), { ...legacy, dispatched: [], briefs: {}, queued: {}, drain: null, retired: [] });
  assert.equal(ok("dispatch", "merge-bot").member, "merge-bot-1");
  assert.deepEqual(read(), { ...legacy, dispatched: ["merge-bot-1"], briefs: { "merge-bot-1": briefOf("merge-bot-1").sha256.slice(0, 8) }, queued: { "merge-bot-1": [] }, drain: null, retired: [] });
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

// The dispositions gate. A finisher labels a PR `ready-to-merge`, so it is
// recorded only once the PR's current dispositions verdict is ok: among the
// `dispositions-*=fix-pr-<M>[-x]:<run>` tokens naming the latest
// `reviewed=<head>:…:<run>`'s run, the one from the highest-suffixed fix-applier.
// A refusal is exit 2 and writes nothing — the `refused` helper checks both.
const GATE_HEAD = `${"abc1234".repeat(5)}abcde`;
const OTHER_HEAD = `${"def5678".repeat(5)}defab`;
const GATE_RUN = "run-Gate0001";
const OTHER_RUN = "run-Other002";
const ROUND2_RUN = "run-Round2bb";
const gateRow = (counts, ...tokens) =>
  ["impl-10=PR#40 → PR#40", `review=member:review-pr-40 reviewed=${GATE_HEAD.slice(0, 7)}:${counts}:${GATE_RUN}`, "fix-pr-40=applied:def5678", ...tokens].join(" · ");

test("a finisher is refused on a dispositions mismatch and recorded on a dispositions ok", (t) => {
  const { ok, read, refused, put, rule } = fixture(t);
  rule(40, "1", "yes", [10]);
  put("10", gateRow("1/0/0", `dispositions-mismatch=fix-pr-40:${GATE_RUN}`));
  refused(["dispatch", "40", "finisher-pr-40"],
    /finisher-pr-40: dispositions mismatch — fix-pr-40's disposition record fails the check against review run-Gate0001; .*dispositions-check\.mjs/);
  assert.deepEqual(read().dispatched, []);

  put("10", gateRow("1/0/0", `dispositions-ok=fix-pr-40:${GATE_RUN}`));
  assert.equal(ok("dispatch", "40", "finisher-pr-40").agent, "fleet-finisher");
  assert.deepEqual(read().dispatched, ["finisher-pr-40"]);
});

test("a finisher is refused as unchecked while no verdict answers the latest review's run", (t) => {
  const { ok, refused, put } = fixture(t);
  const unchecked = /finisher-pr-40: dispositions unchecked — no dispositions-ok=\/dispositions-mismatch=\/dispositions-escalate=\/dispositions-unchecked= token .* run dispositions-check\.mjs --member fix-pr-40/;
  // No token at all.
  put("10", gateRow("1/0/0"));
  refused(["dispatch", "40", "finisher-pr-40"], unchecked);
  // An unverified finding alone puts the PR under the gate too.
  put("10", gateRow("0/2/1"));
  refused(["dispatch", "40", "finisher-pr-40"], unchecked);
  // An ok answering another review's run satisfies nothing, wherever it sits on the row.
  put("10", gateRow("1/0/0", `dispositions-ok=fix-pr-40:${OTHER_RUN}`));
  refused(["dispatch", "40", "finisher-pr-40"], unchecked);
  put("10", `impl-10=PR#40 → PR#40 · dispositions-ok=fix-pr-40:${OTHER_RUN} · review=member:review-pr-40 reviewed=${GATE_HEAD}:1/0/0:${GATE_RUN}`);
  refused(["dispatch", "40", "finisher-pr-40"], unchecked);
  // An earlier review's ok, answered before a later review returned, does not
  // carry over to the later one.
  put("10", `impl-10=PR#40 → PR#40 · review=member:review-pr-40 reviewed=${OTHER_HEAD}:1/0/0:${OTHER_RUN} · dispositions-ok=fix-pr-40:${OTHER_RUN} · review=member:review-pr-40-b reviewed=${GATE_HEAD}:1/0/0:${GATE_RUN}`);
  refused(["dispatch", "40", "finisher-pr-40"], unchecked);
  // Another PR's fix-applier's verdict is no answer for this PR.
  put("10", gateRow("1/0/0", `dispositions-ok=fix-pr-41:${GATE_RUN}`));
  refused(["dispatch", "40", "finisher-pr-40"], unchecked);
});

test("a finisher is refused as unchecked on a dispositions-unchecked verdict answering the latest review's run, until a re-run writes ok", (t) => {
  const { ok, refused, put, rule } = fixture(t);
  rule(40, "1", "yes", [10]);
  put("10", gateRow("1/0/0", `dispositions-unchecked=fix-pr-40:${GATE_RUN}`));
  refused(["dispatch", "40", "finisher-pr-40"],
    /finisher-pr-40: dispositions unchecked — fix-pr-40's check of review run-Gate0001 could not read where a deferral was filed .* an issue that does not exist is unreadable too, and no re-run answers that one.* run dispositions-check\.mjs --member fix-pr-40 --scratch <scratch> again once gh answers/);
  put("10", gateRow("1/0/0", `dispositions-ok=fix-pr-40:${GATE_RUN}`));
  assert.equal(ok("dispatch", "40", "finisher-pr-40").agent, "fleet-finisher");
});

test("a PR whose latest review counts no survived and no unverified finding dispatches a finisher with no verdict", (t) => {
  const { ok, read, put, rule } = fixture(t);
  rule(40, "1", "yes", [10]); rule(41, "1", "yes", [11]);
  put("10", `impl-10=PR#40 → PR#40 · review=member:review-pr-40 reviewed=${GATE_HEAD}:0/3/0:${GATE_RUN}`);
  assert.equal(ok("dispatch", "40", "finisher-pr-40").agent, "fleet-finisher");
  // A PR never reviewed is outside the gate as well: no review file, no record.
  ok("row", "11", "impl-11=PR#41 → PR#41");
  assert.equal(ok("dispatch", "41", "finisher-pr-41").agent, "fleet-finisher");
  assert.deepEqual(read().dispatched, ["finisher-pr-40", "finisher-pr-41"]);
});

// #2877, the gate's half: the tick names a fix-applier for a review counting
// only unverified findings (pinned in fleet-tick.test.mjs), and its `no-op`
// with an ok verdict is what opens this gate.
test("a PR whose latest review counts only unverified findings dispatches a finisher once a no-op fix-applier's verdict is ok", (t) => {
  const { ok, read, refused, put, rule } = fixture(t);
  rule(40, "1", "yes", [10]);
  put("10", `impl-10=PR#40 → PR#40 · review=member:review-pr-40 reviewed=${GATE_HEAD.slice(0, 7)}:0/2/6:${GATE_RUN}`);
  refused(["dispatch", "40", "finisher-pr-40"], /dispositions unchecked/);
  ok("dispatch", "40", "fix-pr-40");
  ok("settle", "fix-pr-40", "no-op");
  ok("row", "10", `impl-10=PR#40 → PR#40 · review=member:review-pr-40 reviewed=${GATE_HEAD.slice(0, 7)}:0/2/6:${GATE_RUN} · fix-pr-40=no-op · dispositions-ok=fix-pr-40:${GATE_RUN}`);
  assert.equal(ok("dispatch", "40", "finisher-pr-40").agent, "fleet-finisher");
  assert.deepEqual(read().dispatched, ["fix-pr-40=no-op", "finisher-pr-40"]);
});

test("the current verdict is the highest-suffixed fix-applier's, in either text order", (t) => {
  const { ok, read, refused, put, rule } = fixture(t);
  rule(40, "1", "yes", [10]);
  const a = `dispositions-mismatch=fix-pr-40:${GATE_RUN}`;
  const b = `dispositions-ok=fix-pr-40-b:${GATE_RUN}`;
  for (const [i, tokens] of [[a, b], [b, a]].entries()) {
    put("10", gateRow("1/0/0", ...tokens));
    assert.equal(ok("dispatch", "40", `finisher-pr-40${i === 0 ? "" : "-b"}`).agent, "fleet-finisher");
    ok("settle", `finisher-pr-40${i === 0 ? "" : "-b"}`, "failed");
  }
  // Swapped between the two members, the -b's mismatch is current.
  const swapped = [`dispositions-ok=fix-pr-40:${GATE_RUN}`, `dispositions-mismatch=fix-pr-40-b:${GATE_RUN}`];
  for (const tokens of [swapped, [...swapped].reverse()]) {
    put("10", gateRow("1/0/0", ...tokens));
    refused(["dispatch", "40", "finisher-pr-40-c"], /finisher-pr-40-c: dispositions mismatch — fix-pr-40-b's disposition record/);
  }
  assert.deepEqual(read().dispatched, ["finisher-pr-40=failed", "finisher-pr-40-b=failed"]);
});

test("a mismatch is retried by the next fix-applier suffix: ok from it ends the refusal, escalate from it never does", (t) => {
  const { ok, read, refused, put, rule } = fixture(t);
  rule(40, "1", "yes", [10]);
  put("10", gateRow("1/0/0", `dispositions-mismatch=fix-pr-40:${GATE_RUN}`));
  refused(["dispatch", "40", "finisher-pr-40"], /dispositions mismatch/);
  // The retry is dispatched under the next suffix; the first name is spent.
  refused(["dispatch", "40", "fix-pr-40"], /fix-pr-40/);
  ok("dispatch", "40", "fix-pr-40-b");
  ok("settle", "fix-pr-40-b", `applied:${GATE_HEAD.slice(0, 7)}`);
  // Settled with no verdict of its own: the earlier mismatch still stands.
  refused(["dispatch", "40", "finisher-pr-40"], /dispositions mismatch — fix-pr-40's/);
  put("10", gateRow("1/0/0", `dispositions-mismatch=fix-pr-40:${GATE_RUN}`, `dispositions-ok=fix-pr-40-b:${GATE_RUN}`, "fix-pr-40-b=applied:0123abc"));
  assert.equal(ok("dispatch", "40", "finisher-pr-40").agent, "fleet-finisher");
  assert.ok(read().dispatched.includes("finisher-pr-40"));
  // Escalated instead: a finisher is refused naming it, whichever way the tokens sit.
  ok("settle", "finisher-pr-40", "failed");
  const escalated = [`dispositions-mismatch=fix-pr-40:${GATE_RUN}`, `dispositions-escalate=fix-pr-40-b:${GATE_RUN}`];
  for (const tokens of [escalated, [...escalated].reverse()]) {
    put("10", gateRow("1/0/0", ...tokens, "fix-pr-40-b=applied:0123abc"));
    refused(["dispatch", "40", "finisher-pr-40-b"], /finisher-pr-40-b: dispositions escalate — fix-pr-40-b deferred/);
  }
  // A new review (a new head) starts the gate over: the old escalate answers nothing.
  put("10", `impl-10=PR#40 → PR#40 · review=member:review-pr-40 reviewed=${GATE_HEAD}:1/0/0:${GATE_RUN} · ${escalated[1]} · review=wf:x reviewed=${OTHER_HEAD}:1/0/0:${OTHER_RUN}`);
  refused(["dispatch", "40", "finisher-pr-40-b"], /dispositions unchecked/);
});

test("the retry of a dispositions mismatch is dispatched as fleet-fix-applier, the same definition as a review's", (t) => {
  const { ok, refused, put } = fixture(t);
  put("10", gateRow("1/0/0", `dispositions-mismatch=fix-pr-40:${GATE_RUN}`));
  refused(["dispatch", "40", "finisher-pr-40"], /dispositions mismatch/);
  assert.equal(ok("dispatch", "40", "fix-pr-40-b").agent, "fleet-fix-applier");
});

test("a later fix-applier that writes no verdict neither satisfies nor resets the gate", (t) => {
  const { ok, refused, put, rule } = fixture(t);
  rule(40, "1", "yes", [10]); rule(41, "1", "yes", [11]);
  // A conflict-hold fix-applier after the review one: no review file, no token.
  put("10", gateRow("1/0/0", `dispositions-ok=fix-pr-40:${GATE_RUN}`, "conflict-hold:#40", "fix-pr-40-b=no-op"));
  assert.equal(ok("dispatch", "40", "finisher-pr-40").agent, "fleet-finisher");
  put("11", ["impl-11=PR#41 → PR#41", `review=member:review-pr-41 reviewed=${GATE_HEAD}:1/0/0:${GATE_RUN}`, "fix-pr-41=applied:def5678",
    `dispositions-mismatch=fix-pr-41:${GATE_RUN}`, "conflict-hold:#41", "fix-pr-41-b=no-op"].join(" · "));
  refused(["dispatch", "41", "finisher-pr-41"], /finisher-pr-41: dispositions mismatch — fix-pr-41's/);
});

// A finisher labels its PR; one known to conflict would be labelled for a merge
// that cannot happen, or race the fix-applier rebasing it.
test("a finisher is refused while its PR sits on a conflict hold no fix-applier has cleared, and accepted on the same PR without one", (t) => {
  const { ok, read, refused, put, rule } = fixture(t);
  rule(40, "1", "yes", [10]);
  const held = "impl-10=PR#40 → PR#40 · conflict-hold:#40 (conflict: mergeable=CONFLICTING)";
  ok("row", "10", held);
  refused(["dispatch", "40", "finisher-pr-40"],
    /finisher-pr-40: PR #40 is on a conflict hold no fix-applier has cleared — .*fix-pr-40.* — not dispatching finisher-pr-40/);
  // Ahead of the dispositions verdict, which an ok does not lift.
  put("10", gateRow("1/0/0", `dispositions-ok=fix-pr-40:${GATE_HEAD}`, "conflict-hold:#40"));
  refused(["dispatch", "40", "finisher-pr-40"], /finisher-pr-40: PR #40 is on a conflict hold/);
  // A live fix-applier is still working it.
  ok("row", "10", `${held} · fix-pr-40`);
  refused(["dispatch", "40", "finisher-pr-40"], /finisher-pr-40: PR #40 is on a conflict hold/);
  assert.deepEqual(read().dispatched, []);
  // The same PR with no hold, and with the hold cleared by a landed fix-applier.
  ok("row", "10", "impl-10=PR#40 → PR#40");
  assert.equal(ok("dispatch", "40", "finisher-pr-40").agent, "fleet-finisher");
  ok("settle", "finisher-pr-40", "failed");
  ok("row", "10", `${held} · fix-pr-40=no-op`);
  assert.equal(ok("dispatch", "40", "finisher-pr-40-b").agent, "fleet-finisher");
  assert.deepEqual(read().dispatched, ["finisher-pr-40=failed", "finisher-pr-40-b"]);
});

test("a finisher is refused on a dispositions escalate, naming it, and nothing retries it", (t) => {
  const { ok, read, refused, put } = fixture(t);
  put("10", gateRow("1/0/0", `dispositions-escalate=fix-pr-40:${GATE_RUN}`));
  refused(["dispatch", "40", "finisher-pr-40"],
    /finisher-pr-40: dispositions escalate — fix-pr-40 deferred .*review run-Gate0001 gets no finisher and no retry; dispositions-check\.mjs --member fix-pr-40/);
  assert.deepEqual(read().dispatched, []);
  const l = read();
  const run = deriveRun({ rows: l.rows, dispatched: l.dispatched, drain: null },
    [{ number: 40, labels: [], closingIssuesReferences: [{ number: 10 }] }]);
  assert.deepEqual(run.fixDue, [], "an escalation never returns the PR to fixDue");
  assert.deepEqual(run.reviewed.find((r) => r.pr === 40).dispositions, { verdict: "escalate", member: "fix-pr-40" });
});

test("an escalate is the current verdict only until a higher-suffixed fix-applier's own verdict answers the review, and outranks a mismatch of the same member", (t) => {
  const { ok, refused, put, rule } = fixture(t);
  rule(40, "1", "yes", [10]);
  const esc = `dispositions-escalate=fix-pr-40:${GATE_RUN}`;
  const okB = `dispositions-ok=fix-pr-40-b:${GATE_RUN}`;
  for (const [i, tokens] of [[esc, okB], [okB, esc]].entries()) {
    put("10", gateRow("1/0/0", ...tokens));
    assert.equal(ok("dispatch", "40", `finisher-pr-40${i === 0 ? "" : "-b"}`).agent, "fleet-finisher");
    ok("settle", `finisher-pr-40${i === 0 ? "" : "-b"}`, "failed");
  }
  const swapped = [`dispositions-ok=fix-pr-40:${GATE_RUN}`, `dispositions-escalate=fix-pr-40-b:${GATE_RUN}`];
  for (const tokens of [swapped, [...swapped].reverse()]) {
    put("10", gateRow("1/0/0", ...tokens));
    refused(["dispatch", "40", "finisher-pr-40-c"], /finisher-pr-40-c: dispositions escalate — fix-pr-40-b deferred/);
  }
  put("10", gateRow("1/0/0", `dispositions-mismatch=fix-pr-40:${GATE_RUN}`, esc));
  refused(["dispatch", "40", "finisher-pr-40-c"], /dispositions escalate/);
});

test("one fix-applier carrying both verdicts for the same review reads as a mismatch", (t) => {
  const { ok, refused, put } = fixture(t);
  put("10", gateRow("1/0/0", `dispositions-ok=fix-pr-40:${GATE_RUN}`, `dispositions-mismatch=fix-pr-40:${GATE_RUN}`));
  refused(["dispatch", "40", "finisher-pr-40"], /dispositions mismatch/);
});

test("only a fix-applier's well-formed verdict answers the gate: another family's, a head's, a short run's or a non-verdict's never does", (t) => {
  const { ok, read, refused, put, rule } = fixture(t);
  rule(40, "1", "yes", [10]);
  const unchecked = /finisher-pr-40: dispositions unchecked/;
  for (const token of [
    `dispositions-ok=finisher-pr-40:${GATE_RUN}`, // a finisher writes no disposition record
    `dispositions-ok=impl-10:${GATE_RUN}`,
    `dispositions-ok=fix-pr-40:${GATE_HEAD}`, // the shape before verdicts named a run: no review it answers
    "dispositions-ok=fix-pr-40:run-Gate", // not the eight characters mktemp chose
    `dispositions-maybe=fix-pr-40:${GATE_RUN}`,
  ]) {
    put("10", gateRow("1/0/0", token));
    refused(["dispatch", "40", "finisher-pr-40"], unchecked);
  }
  // Case is not a verdict's meaning: an upper-case verdict still answers.
  put("10", gateRow("1/0/0", `DISPOSITIONS-OK=fix-pr-40:${GATE_RUN}`));
  assert.equal(ok("dispatch", "40", "finisher-pr-40").agent, "fleet-finisher");
  assert.deepEqual(read().dispatched, ["finisher-pr-40"]);
});

// #2886: a second review at the same head is a second run, and round 1's ok
// answered round 1's findings only.
test("a finisher is refused after a same-head re-review whose run no verdict answers, even with round 1's ok on the row", (t) => {
  const { ok, read, refused, put, rule } = fixture(t);
  rule(40, "1", "yes", [10]); rule(41, "1", "yes", [11]);
  put("10", gateRow("1/0/0", `dispositions-ok=fix-pr-40:${GATE_RUN}`, `review=member:review-pr-40-b reviewed=${GATE_HEAD.slice(0, 7)}:2/0/0:${ROUND2_RUN}`));
  refused(["dispatch", "40", "finisher-pr-40"], new RegExp(`finisher-pr-40: dispositions unchecked — .* latest review, ${ROUND2_RUN} at ${GATE_HEAD.slice(0, 7)};`));
  // Control: before the re-review returned, round 1's ok opened the gate.
  put("11", ["impl-11=PR#41 → PR#41", `review=member:review-pr-41 reviewed=${GATE_HEAD.slice(0, 7)}:1/0/0:${GATE_RUN}`, "fix-pr-41=applied:def5678",
    `dispositions-ok=fix-pr-41:${GATE_RUN}`].join(" · "));
  assert.equal(ok("dispatch", "41", "finisher-pr-41").agent, "fleet-finisher");
  assert.deepEqual(read().dispatched, ["finisher-pr-41"]);
});

test("a finisher is refused while a fix-applier on the PR is live, even with an earlier ok answering an earlier review at the same head", (t) => {
  const { ok, read, refused, put, rule } = fixture(t);
  rule(40, "1", "yes", [10]); rule(41, "1", "yes", [11]);
  // A re-review at the same head: fix-pr-40 answered the first round, and
  // fix-pr-40-b, answering the second, is still working.
  put("10", gateRow("1/0/0", `dispositions-ok=fix-pr-40:${GATE_RUN}`, `review=member:review-pr-40-b reviewed=${GATE_HEAD.slice(0, 7)}:3/0/2:${ROUND2_RUN}`, "fix-pr-40-b"));
  refused(["dispatch", "40", "finisher-pr-40"], /finisher-pr-40: fix-pr-40-b still live on PR #40 — a fix-applier answering review run-Round2bb has not settled, .*settle it, run dispositions-check\.mjs for it/);
  // A PR outside the verdict gate is still held while its fix-applier works.
  put("11", `impl-11=PR#41 → PR#41 · review=member:review-pr-41 reviewed=${GATE_HEAD}:0/1/0:${GATE_RUN} · fix-pr-41`);
  refused(["dispatch", "41", "finisher-pr-41"], /finisher-pr-41: fix-pr-41 still live on PR #41/);
  // Settled with its own verdict written, the -b's answer is the current one.
  put("10", gateRow("1/0/0", `dispositions-ok=fix-pr-40:${GATE_RUN}`, `review=member:review-pr-40-b reviewed=${GATE_HEAD.slice(0, 7)}:3/0/2:${ROUND2_RUN}`,
    "fix-pr-40-b=applied:fedcba9", `dispositions-ok=fix-pr-40-b:${ROUND2_RUN}`));
  assert.equal(ok("dispatch", "40", "finisher-pr-40").agent, "fleet-finisher");
  assert.deepEqual(read().dispatched, ["finisher-pr-40"]);
});

// The ruling gate. An implementer's PR — one a settled `impl-<N>=PR#<M>` token
// names — gets its finisher only once the main checkout's tier-outcomes.tsv
// has a row for it, so the ruling is written while the PR's review evidence
// is still in scratch. The ruling reads the ledger and that file alone, so a
// refusal here makes no gh call, which `ghCalls` shows.
const RULED_ROW = `impl-3545=PR#3606 · tier-ok=impl-3545:fleet-implementer-slow-high · reviewed=${GATE_HEAD}:0/0/0:${GATE_RUN}`;
const UNRULED = /finisher-pr-3606: PR #3606, the implementer PR of ticket #3545, has no ruling — \S+\/docs\/metrics\/tier-outcomes\.tsv has no row for it; rule its review with `~\/\.fleet\/bin\/fleet-run tier-outcomes\.mjs append 3606 --closed-own-ticket yes\|no --minted-false-claim yes\|no --note "<text>"`, then dispatch the finisher again — not dispatching finisher-pr-3606/;

test("a finisher for an implementer's PR is refused until the PR has a tier-outcomes row, then recorded, and so is its replacement", (t) => {
  const f = fixture(t);
  f.put("3545", RULED_ROW);
  // No tier-outcomes file at all is no row.
  assert.equal(existsSync(f.tierOutcomes), false);
  f.refused(["dispatch", "3606", "finisher-pr-3606"], UNRULED);
  // A file whose rows rule other PRs only.
  f.rule(3600, "3540");
  f.refused(["dispatch", "3606", "finisher-pr-3606"], UNRULED);
  assert.deepEqual(f.read().dispatched, []);
  assert.deepEqual(ghCalls(f.bin), []);

  f.rule(3606, "3545");
  closes(f.bin, 3606, [3545]);
  const out = f.ok("dispatch", "3606", "finisher-pr-3606");
  assert.equal(out.agent, "fleet-finisher");
  assert.equal(out.line, `#3545 ${RULED_ROW} · finisher-pr-3606`);
  assert.deepEqual(f.read().dispatched, ["finisher-pr-3606"]);
  f.ok("settle", "finisher-pr-3606", "failed");
  assert.equal(f.ok("dispatch", "3606", "finisher-pr-3606-b").agent, "fleet-finisher");
  assert.deepEqual(f.read().dispatched, ["finisher-pr-3606=failed", "finisher-pr-3606-b"]);
});

test("any row for the PR passes the ruling, whatever its date or width; a row whose verdicts were never ruled refuses the finisher on the closing gate", (t) => {
  const f = fixture(t);
  f.put("3545", RULED_ROW);
  mkdirSync(dirname(f.tierOutcomes), { recursive: true });
  // A header, then a row of the full width whose verdicts were never ruled.
  writeFileSync(f.tierOutcomes, "# run_date\tpr\n2026-01-01\t3606\t3545\troutine\t\t\t\t\t\t\t\t\n");
  f.refused(["dispatch", "3606", "finisher-pr-3606"], /finisher-pr-3606: PR #3606's row in \S+tier-outcomes\.tsv has no closed_own_ticket verdict/);
  assert.deepEqual(f.read().dispatched, []);
});

test("a tier-outcomes file that cannot be parsed or read refuses the finisher, naming the file, and is never a pass", (t) => {
  const f = fixture(t);
  f.put("3545", RULED_ROW);
  f.rule(3606, "3545");
  // A row for the PR, behind a row with a tab too many.
  writeFileSync(f.tierOutcomes, `2026-10-21\t3600\t3540\troutine\tslow-high\tyes\tno\tnote\textra\n${readFileSync(f.tierOutcomes, "utf8")}`);
  const where = f.tierOutcomes.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const unreadable = new RegExp(`finisher-pr-3606: cannot read the PR's ruling off ${where}: .*malformed row.* — not dispatching finisher-pr-3606`);
  f.refused(["dispatch", "3606", "finisher-pr-3606"], unreadable);
  // A path that is no file to read.
  rmSync(f.tierOutcomes);
  mkdirSync(f.tierOutcomes);
  f.refused(["dispatch", "3606", "finisher-pr-3606"], new RegExp(`finisher-pr-3606: cannot read the PR's ruling off ${where}: EISDIR`));
  assert.deepEqual(f.read().dispatched, []);
  assert.deepEqual(ghCalls(f.bin), []);
});

test("a finisher for a PR no settled impl token names is not gated on a ruling", (t) => {
  const f = fixture(t);
  f.put("3631", `review=member:review-pr-3631 · reviewed=${GATE_HEAD}:0/0/0:${GATE_RUN}`);
  assert.equal(f.ok("dispatch", "3631", "finisher-pr-3631").agent, "fleet-finisher");
  // A live implementer's arrow is no settled token either.
  f.ok("row", "3700", "impl-3700 → PR#3701");
  assert.equal(f.ok("dispatch", "3701", "finisher-pr-3701").agent, "fleet-finisher");
  assert.deepEqual(f.read().dispatched, ["finisher-pr-3631", "finisher-pr-3701"]);
  assert.equal(existsSync(f.tierOutcomes), false);
});

test("the ruling refusal names every ticket claiming the PR once, in the plural", (t) => {
  const f = fixture(t);
  f.put("3545", RULED_ROW);
  f.put("3546", `impl-3546=PR#3606 · reviewed=${GATE_HEAD}:0/0/0:${GATE_RUN}`);
  f.refused(["dispatch", "3606", "finisher-pr-3606"], /finisher-pr-3606: PR #3606, the implementer PR of tickets #3545, #3546, has no ruling — /);
  assert.deepEqual(ghCalls(f.bin), []);
});

test("the ruling refusal names a ticket claiming the PR twice once, in the singular", (t) => {
  const f = fixture(t);
  f.put("3545", `${RULED_ROW} · impl-3545-b=PR#3606`);
  f.refused(["dispatch", "3606", "finisher-pr-3606"], /finisher-pr-3606: PR #3606, the implementer PR of ticket #3545, has no ruling — /);
  assert.deepEqual(ghCalls(f.bin), []);
});

test("a conflict hold and a dispositions refusal are each still the one printed for an unruled implementer PR", (t) => {
  const f = fixture(t);
  f.put("3545", `${RULED_ROW} · conflict-hold:#3606`);
  // The only line on stderr, so the ruling's refusal is not printed after it.
  f.refused(["dispatch", "3606", "finisher-pr-3606"], /^\nledger: finisher-pr-3606: PR #3606 is on a conflict hold no fix-applier has cleared — [^\n]*\n$/);
  f.put("3545", `impl-3545=PR#3606 · reviewed=${GATE_HEAD}:1/0/0:${GATE_RUN} · fix-pr-3606=applied:def5678 · dispositions-mismatch=fix-pr-3606:${GATE_RUN}`);
  f.refused(["dispatch", "3606", "finisher-pr-3606"], /^\nledger: finisher-pr-3606: dispositions mismatch — [^\n]*\n$/);
  assert.deepEqual(ghCalls(f.bin), []);
});

test("implementer, fix-applier and merge-bot dispatches are not gated on a ruling or a closing reference", (t) => {
  const f = fixture(t);
  f.put("3545", RULED_ROW);
  f.ok("dispatch", "3550", "impl-3550");
  f.ok("settle", "impl-3550", "PR#3610");
  assert.equal(f.ok("dispatch", "3606", "fix-pr-3606").agent, "fleet-fix-applier");
  assert.equal(f.ok("dispatch", "3610", "fix-pr-3610").agent, "fleet-fix-applier");
  // The merge bot reads its queue off gh, so it gets the stub back.
  writeQueueGh(f.bin);
  assert.equal(f.ok("dispatch", "merge-bot").member, "merge-bot-1");
  assert.equal(existsSync(f.tierOutcomes), false);
  assert.deepEqual(ghCalls(f.bin).filter((c) => c.startsWith("pr view") || c.startsWith("issue view")), []);
});

// The closing-reference gate, after the ruling. A finisher's PR is checked
// against its ruling: when closed_own_ticket=yes, each ticket claiming the PR
// must be a closing reference of its body; when closed_own_ticket=no, none may
// be. No closing reference may be the suggestion-band record of the PR's own
// review, whatever the ruling. A read that cannot answer dies, naming the read.

test("a PR ruled closed_own_ticket=yes is refused while its body does not close the ticket, and recorded once it does", (t) => {
  const f = fixture(t);
  f.put("3545", RULED_ROW);
  f.rule(3606, "3545");
  f.refused(["dispatch", "3606", "finisher-pr-3606"], /finisher-pr-3606: PR #3606 does not close #3545, ruled closed_own_ticket=yes — add "Closes #3545" to its body/);
  assert.deepEqual(f.read().dispatched, []);
  closes(f.bin, 3606, [3545]);
  assert.equal(f.ok("dispatch", "3606", "finisher-pr-3606").agent, "fleet-finisher");
});

test("an ordinary issue among a PR's closing references does not refuse it", (t) => {
  const f = fixture(t);
  f.put("3545", RULED_ROW);
  f.rule(3606, "3545");
  closes(f.bin, 3606, [3545, 3600]);
  assert.equal(f.ok("dispatch", "3606", "finisher-pr-3606").agent, "fleet-finisher");
});

test("a PR ruled closed_own_ticket=no is recorded while its body does not close the ticket", (t) => {
  const f = fixture(t);
  f.put("3545", RULED_ROW);
  f.rule(3606, "3545", "no");
  assert.equal(f.ok("dispatch", "3606", "finisher-pr-3606").agent, "fleet-finisher");
});

test("a PR ruled closed_own_ticket=no is refused while its body closes the ticket, naming the rephrasing", (t) => {
  const f = fixture(t);
  f.put("3545", RULED_ROW);
  f.rule(3606, "3545", "no");
  closes(f.bin, 3606, [3545]);
  f.refused(["dispatch", "3606", "finisher-pr-3606"], /finisher-pr-3606: PR #3606 closes #3545, ruled closed_own_ticket=no — rephrase it as "Refs #3545"/);
  assert.deepEqual(f.read().dispatched, []);
});

test("a closing reference to the PR's own suggestion-band record refuses the finisher, whatever the ruling", (t) => {
  const f = fixture(t);
  f.put("3545", RULED_ROW);
  f.rule(3606, "3545");
  // The check reads the title alone: the record's state and labels do not matter.
  closes(f.bin, 3606, [3545, 3637]);
  titled(f.bin, 3637, "PR #3606 review: the suggestion band, checked");
  f.refused(["dispatch", "3606", "finisher-pr-3606"], /finisher-pr-3606: PR #3606 closes #3637, its own suggestion-band record — rephrase the mention as "Refs #3637" or "issue #3637"/);
  assert.deepEqual(f.read().dispatched, []);
});

test("a ruling the body fails and an own-record reference are both named in the one refusal", (t) => {
  const f = fixture(t);
  f.put("3545", RULED_ROW);
  f.rule(3606, "3545");
  closes(f.bin, 3606, [3637]);
  titled(f.bin, 3637, "PR #3606 review: the suggestion band, checked");
  f.refused(["dispatch", "3606", "finisher-pr-3606"], /finisher-pr-3606: PR #3606 does not close #3545, ruled closed_own_ticket=yes .*; PR #3606 closes #3637, its own suggestion-band record/);
});

test("every ticket claiming the PR is checked against the body, not only the first", (t) => {
  const f = fixture(t);
  f.put("3545", RULED_ROW);
  f.put("3546", `impl-3546=PR#3606 · reviewed=${GATE_HEAD}:0/0/0:${GATE_RUN}`);
  f.rule(3606, "3545");
  closes(f.bin, 3606, [3545]);
  f.refused(["dispatch", "3606", "finisher-pr-3606"], /PR #3606 does not close #3546, ruled closed_own_ticket=yes/);
});

test("a blank closing-reference verdict, with a ticket claiming the PR, refuses the finisher", (t) => {
  const f = fixture(t);
  f.put("3545", RULED_ROW);
  mkdirSync(dirname(f.tierOutcomes), { recursive: true });
  writeFileSync(f.tierOutcomes, "2026-10-21\t3606\t3545\troutine\tslow-high\t\t\tnote\n");
  f.refused(["dispatch", "3606", "finisher-pr-3606"], /finisher-pr-3606: PR #3606's row in \S+tier-outcomes\.tsv has no closed_own_ticket verdict/);
  assert.deepEqual(f.read().dispatched, []);
});

test("the PR's latest tier-outcomes row is its ruling, so a re-ruling replaces an earlier row's verdict", (t) => {
  // An earlier blank verdict, ruled yes later: the body closing the ticket passes.
  const blankThenYes = fixture(t);
  blankThenYes.put("3545", RULED_ROW);
  mkdirSync(dirname(blankThenYes.tierOutcomes), { recursive: true });
  writeFileSync(blankThenYes.tierOutcomes, "2026-10-20\t3606\t3545\troutine\tslow-high\t\t\tnote\n");
  blankThenYes.rule(3606, "3545", "yes", [3545]);
  assert.equal(blankThenYes.ok("dispatch", "3606", "finisher-pr-3606").agent, "fleet-finisher");
  // An earlier yes, ruled no later: the body closing nothing passes.
  const yesThenNo = fixture(t);
  yesThenNo.put("3545", RULED_ROW);
  yesThenNo.rule(3606, "3545", "yes");
  yesThenNo.rule(3606, "3545", "no");
  assert.equal(yesThenNo.ok("dispatch", "3606", "finisher-pr-3606").agent, "fleet-finisher");
});

test("a closing reference titled the PR's own record past surrounding whitespace still refuses the finisher", (t) => {
  const f = fixture(t);
  f.put("3545", RULED_ROW);
  f.rule(3606, "3545", "yes", [3545, 3637]);
  titled(f.bin, 3637, "  PR #3606 review: the suggestion band, checked ");
  f.refused(["dispatch", "3606", "finisher-pr-3606"], /finisher-pr-3606: PR #3606 closes #3637, its own suggestion-band record — rephrase the mention as "Refs #3637" or "issue #3637"/);
  assert.deepEqual(f.read().dispatched, []);
});

test("a gh pr view that fails refuses the finisher, naming the read, and writes nothing", (t) => {
  const f = fixture(t);
  f.put("3545", RULED_ROW);
  f.rule(3606, "3545");
  failsOn(f.bin, "pr", 3606);
  f.refused(["dispatch", "3606", "finisher-pr-3606"], /dispatch finisher-pr-3606: could not look — gh pr view 3606 --json closingIssuesReferences exited 1/);
  assert.deepEqual(f.read().dispatched, []);
});

test("a gh issue view that fails refuses the finisher, naming the read, and writes nothing", (t) => {
  const f = fixture(t);
  f.put("3545", RULED_ROW);
  f.rule(3606, "3545");
  closes(f.bin, 3606, [3545]);
  failsOn(f.bin, "issue", 3545);
  f.refused(["dispatch", "3606", "finisher-pr-3606"], /dispatch finisher-pr-3606: could not look — gh issue view 3545 --json title exited 1/);
  assert.deepEqual(f.read().dispatched, []);
});

// ── the rendered brief ───────────────────────────────────────────────────────
//
// `dispatch` records the brief a member is dispatched with, and refuses a
// member whose brief was never rendered for its role. These calls go through
// `bare`, which renders nothing on the member's behalf.

// A gate refusal: exit 2, the reason, no payload, the ledger's bytes as they
// were.
function refusedBare(f, args, why) {
  const before = f.bytes();
  const r = f.bare(...args);
  assert.equal(r.status, 2, `${args.join(" ")}: got exit ${r.status}\n${r.stderr}`);
  if (typeof why === "string") assert.ok(r.stderr.includes(why), `${args.join(" ")}: stderr was ${r.stderr}`);
  else assert.match(r.stderr, why, `${args.join(" ")}: stderr was ${r.stderr}`);
  assert.equal(r.stdout, "", `${args.join(" ")}: a refusal must not also emit a payload`);
  assert.equal(f.bytes(), before, `${args.join(" ")}: a refusal must not touch the ledger`);
  return r;
}

test("dispatch refuses a member with no rendered brief, naming the render command for its family, and writes nothing", (t) => {
  const f = fixture(t);
  f.rule(346, "1", "yes", [324]);
  f.ok("dispatch", "324", "impl-324");
  f.ok("settle", "impl-324", "PR#346");
  for (const [args, member, role] of [
    [["dispatch", "412", "impl-412"], "impl-412", "implementer"],
    [["dispatch", "346", "fix-pr-346"], "fix-pr-346", "fix-applier"],
    [["dispatch", "346", "finisher-pr-346"], "finisher-pr-346", "finisher"],
    [["dispatch", "merge-bot"], "merge-bot-1", "merge-bot"],
  ]) {
    const sidecar = join(f.dir, "briefs", `${member}.json`);
    const r = refusedBare(f, args, `no rendered brief for ${member} — run \`dispatch-prompt.mjs render ${role} --member ${member} …\``);
    assert.ok(r.stderr.includes(`${sidecar} does not exist`), `${member}: the refusal names the sidecar it looked for: ${r.stderr}`);
    assert.equal(existsSync(sidecar), false, `${member}: a refusal renders nothing`);
  }
  assert.deepEqual(f.read().dispatched, ["impl-324=PR#346"]);
});

test("dispatch refuses a brief rendered for another role, naming both, and writes nothing", (t) => {
  const f = fixture(t);
  for (const role of ["fix-applier", "review-runner", "recipe-deriver"]) {
    renderBrief(f.dir, "impl-412", { role });
    refusedBare(f, ["dispatch", "412", "impl-412"], `is a brief for role "${role}", but impl-412 is dispatched as implementer`);
  }
  renderBrief(f.dir, "merge-bot-1", { sidecar: { role: undefined } });
  refusedBare(f, ["dispatch", "merge-bot"], "is a brief for role null, but merge-bot-1 is dispatched as merge-bot");
  // The other half of the gate: each family's own role is the one it accepts.
  renderBrief(f.dir, "impl-412", { role: "implementer" });
  assert.equal(f.bare("dispatch", "412", "impl-412").status, 0);
});

test("dispatch refuses a sidecar with no 64-hex sha256, or one that is no JSON object, and writes nothing", (t) => {
  const f = fixture(t);
  for (const sha256 of [undefined, "abc", "A".repeat(64), "g".repeat(64), "a".repeat(65), 42]) {
    renderBrief(f.dir, "impl-412", { sidecar: { sha256 } });
    refusedBare(f, ["dispatch", "412", "impl-412"], /carries no sha256 of 64 lowercase hex/);
  }
  const sidecar = join(f.dir, "briefs", "impl-412.json");
  writeFileSync(sidecar, "{ not json");
  refusedBare(f, ["dispatch", "412", "impl-412"], /impl-412\.json is not JSON/);
  for (const body of ["[]", "null", "\"implementer\""]) {
    writeFileSync(sidecar, body);
    refusedBare(f, ["dispatch", "412", "impl-412"], /impl-412\.json is not a JSON object/);
  }
});

test("dispatch refuses a sidecar whose brief file is missing, or does not hash to the sidecar's sha256, and writes nothing", (t) => {
  const f = fixture(t);
  const rendered = renderBrief(f.dir, "impl-412");
  rmSync(rendered.path);
  const r = refusedBare(f, ["dispatch", "412", "impl-412"], "no rendered brief for impl-412 — run `dispatch-prompt.mjs render implementer --member impl-412 …`");
  assert.ok(r.stderr.includes(`${rendered.path} does not exist`), `the refusal names the brief it looked for: ${r.stderr}`);

  writeFileSync(rendered.path, "NOT THE BRIEF HASHED\n");
  const edited = refusedBare(f, ["dispatch", "412", "impl-412"], `${rendered.path} hashes to `);
  assert.ok(edited.stderr.includes(`carries ${rendered.sha256}`), `the refusal names the sidecar's hash: ${edited.stderr}`);
  assert.ok(edited.stderr.includes("dispatch-prompt.mjs render implementer --member impl-412"), `the refusal names the render command: ${edited.stderr}`);

  // The other half of the gate: the brief as rendered is accepted.
  writeFileSync(rendered.path, "The brief for impl-412.\n");
  assert.equal(f.bare("dispatch", "412", "impl-412").status, 0);
});

test("a rendered brief is recorded as brief=<first 8 hex> on the ## Dispatched entry, the path and sha256 are printed, and settle keeps the brief", (t) => {
  const f = fixture(t);
  const text = "Implement ticket #412.\n";
  // Every field the renderer writes beside the two the gate reads is accepted as it is.
  const rendered = renderBrief(f.dir, "impl-412", { text, sidecar: { kind: null, args: { ticket: "412" } } });
  const out = f.bare("dispatch", "412", "impl-412");
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(out.json.brief, { path: rendered.path, sha256: rendered.sha256 });
  assert.equal(readFileSync(out.json.brief.path, "utf8"), text, "the path printed is the brief the task call is handed");
  const hash = rendered.sha256.slice(0, 8);
  assert.match(f.bytes(), new RegExp(`\\n## Dispatched\\n\\n- impl-412 brief=${hash}\\n`));
  assert.deepEqual(f.read().dispatched, ["impl-412"], "read's dispatched stays the member tokens every reader parses");
  assert.deepEqual(f.read().briefs, { "impl-412": hash });

  f.ok("settle", "impl-412", "PR#500");
  assert.match(f.bytes(), new RegExp(`\\n- impl-412=PR#500 brief=${hash}\\n`), "settle rewrites the token and keeps its brief");
  // A fix-applier's brief carries a kind; the gate reads only role and sha256.
  const fix = renderBrief(f.dir, "fix-pr-500", { sidecar: { kind: "conflict", args: { pr: "500" } } });
  assert.deepEqual(f.bare("dispatch", "500", "fix-pr-500").json.brief, { path: fix.path, sha256: fix.sha256 });
  assert.deepEqual(f.read().dispatched, ["impl-412=PR#500", "fix-pr-500"]);
  assert.deepEqual(f.read().briefs, { "impl-412": hash, "fix-pr-500": fix.sha256.slice(0, 8) });
});

test("a ## Dispatched entry with no brief= still settles, and one whose brief= is malformed is refused as unparseable", (t) => {
  const legacy = fixture(t, "# Fleet run ledger\n\n## Rows\n\n- #7 impl-7\n\n## Dispatched\n\n- impl-7\n\n## Filed\n\n## Ruled\n");
  legacy.ok("settle", "impl-7", "killed");
  assert.match(legacy.bytes(), /\n## Dispatched\n\n- impl-7=killed\n/);
  assert.deepEqual(legacy.read().briefs, {});

  for (const entry of ["impl-7 brief=1234567", "impl-7 brief=ABCDEF12", "impl-7 brief=12345678 brief=12345678", "impl-7  brief=12345678"]) {
    const f = fixture(t, `# Fleet run ledger\n\n## Rows\n\n- #7 impl-7\n\n## Dispatched\n\n- ${entry}\n\n## Filed\n\n## Ruled\n`);
    f.refused(["settle", "impl-7", "killed"], new RegExp(`## Dispatched has an entry '${entry}' this grammar cannot parse`));
  }
});

test("a dispatch refused for a cause of its own names that cause, not the missing brief", (t) => {
  const f = fixture(t);
  f.ok("drain", "budget");
  refusedBare(f, ["dispatch", "5", "impl-5"], /the run is draining \(budget\)/);
  f.ok("dispatch", "6", "fix-pr-6");
  refusedBare(f, ["dispatch", "6", "fix-pr-6"], /fix-pr-6 was already dispatched this session/);
});

// A member's report under `<scratch>/reports` is the last run's claim about
// that member. Dispatch clears it, so a stale report cannot be read as the new
// run's. The scratch is read from the brief's sidecar, where dispatch-prompt.mjs
// records the arguments it rendered with.
const reportAt = (scratch, member) => join(scratch, "reports", `${member}.json`);
const staleReport = (scratch, member) => {
  mkdirSync(join(scratch, "reports"), { recursive: true });
  writeFileSync(reportAt(scratch, member), `{"member":"${member}","stale":true}\n`);
};

test("dispatch clears the member's stale report, whatever the family", (t) => {
  const f = fixture(t);
  const scratch = join(f.dir, "scratch");
  for (const [member, ...args] of [["impl-412", "412", "impl-412"], ["fix-pr-413", "413", "fix-pr-413"], ["finisher-pr-414", "414", "finisher-pr-414"], ["merge-bot-1", "merge-bot"]]) {
    renderBrief(f.dir, member, { sidecar: { args: { scratch } } });
    staleReport(scratch, member);
    assert.equal(f.ok("dispatch", ...args).member, member);
    assert.equal(existsSync(reportAt(scratch, member)), false, `${member}'s stale report survived its dispatch`);
  }
});

test("a dispatch with no prior report is accepted, and a refused dispatch clears nothing", (t) => {
  const f = fixture(t);
  const scratch = join(f.dir, "scratch");
  renderBrief(f.dir, "impl-412", { sidecar: { args: { scratch } } });
  f.ok("dispatch", "412", "impl-412");
  staleReport(scratch, "impl-412");
  f.refused(["dispatch", "412", "impl-412"], /impl-412 was already dispatched this session/);
  assert.equal(existsSync(reportAt(scratch, "impl-412")), true);
});

test("a brief that does not hash to its sidecar refuses the dispatch and clears no report", (t) => {
  const f = fixture(t);
  const scratch = join(f.dir, "scratch");
  const b = renderBrief(f.dir, "impl-412", { sidecar: { args: { scratch } } });
  writeFileSync(b.path, "tampered\n");
  staleReport(scratch, "impl-412");
  f.refused(["dispatch", "412", "impl-412"], /hashes to/);
  assert.equal(existsSync(reportAt(scratch, "impl-412")), true);
});

test("a report that cannot be cleared refuses the dispatch, naming the path, and writes nothing", (t) => {
  const f = fixture(t);
  const scratch = join(f.dir, "scratch");
  renderBrief(f.dir, "impl-412", { sidecar: { args: { scratch } } });
  // A non-empty directory where the report file should be: unlink refuses it.
  mkdirSync(reportAt(scratch, "impl-412"), { recursive: true });
  writeFileSync(join(reportAt(scratch, "impl-412"), "kept"), "x");
  f.refused(["dispatch", "412", "impl-412"], /cannot clear .*reports\/impl-412\.json/);
});

test("a brief whose sidecar names no scratch dispatches, says on stderr that the prior report was not cleared, and leaves it", (t) => {
  const f = fixture(t);
  const scratch = join(f.dir, "scratch");
  renderBrief(f.dir, "impl-412");
  staleReport(scratch, "impl-412");
  const r = f.cli("dispatch", "412", "impl-412");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /impl-412's brief sidecar names no scratch, so its prior report was not cleared/);
  assert.equal(existsSync(reportAt(scratch, "impl-412")), true);
});

// The ledger runs with the fixture's directory as its cwd, so a relative
// `scratch` there would resolve onto the very report staleReport writes.
test("a sidecar scratch that is not an absolute path clears nothing, and dispatch says so", (t) => {
  const f = fixture(t);
  const scratch = join(f.dir, "scratch");
  for (const [key, member, value] of [["412", "impl-412", "scratch"], ["413", "impl-413", 123]]) {
    renderBrief(f.dir, member, { sidecar: { args: { scratch: value } } });
    staleReport(scratch, member);
    const r = f.cli("dispatch", key, member);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, new RegExp(`${member}'s brief sidecar .*prior report was not cleared`));
    assert.equal(existsSync(reportAt(scratch, member)), true, `${member}'s report was removed`);
  }
});

test("a non-directory where `reports` would be holds no report, so dispatch proceeds", (t) => {
  const f = fixture(t);
  const scratch = join(f.dir, "scratch");
  renderBrief(f.dir, "impl-412", { sidecar: { args: { scratch } } });
  mkdirSync(scratch);
  writeFileSync(join(scratch, "reports"), "not a directory\n");
  assert.equal(f.ok("dispatch", "412", "impl-412").member, "impl-412");
});

test("two settled implementer tokens on one PR both owe the closing reference: refuses naming the one left out, and accepts once both are closed", (t) => {
  const { rule, put, refused, ok, bin } = fixture(t);
  rule(40, "10", "yes", [10]);
  put("10", "impl-10=PR#40 → PR#40");
  put("11", "impl-11=PR#40 → PR#40");
  refused(["dispatch", "40", "finisher-pr-40"], /#11/);
  closes(bin, 40, [10, 11]);
  assert.equal(ok("dispatch", "40", "finisher-pr-40").agent, "fleet-finisher");
});
