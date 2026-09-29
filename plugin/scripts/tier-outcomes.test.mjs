// #2207: tier-outcomes.mjs writes the `tier` column instead of the controller
// typing it, and `check` compares it with what actually ran. Driven through
// the CLI against fixture files: the resolution order, the blank reasons and
// the idempotency are all observable only there, and `gh` is a PATH stub that
// logs every call so the no-op run can prove it never asked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { COLUMNS, TIER_SWITCH_DATE } from "./tier-outcomes.mjs";
import { COLUMNS as MEMBER_COLUMNS } from "./member-outcomes.mjs";

const SCRIPT = fileURLToPath(new URL("./tier-outcomes.mjs", import.meta.url));
const PRE_SWITCH = "2026-09-17";
assert.ok(PRE_SWITCH < TIER_SWITCH_DATE);

const HEADER = `# run_date\t${COLUMNS.slice(1).join("\t")}\n`;

// One member-outcomes.tsv row, every column present so parseTsv accepts it.
function memberRow({ member, ticket, type, role = "implementer" }) {
  const r = Object.fromEntries(MEMBER_COLUMNS.map((c) => [c, ""]));
  Object.assign(r, { session: "s1", run_date: TIER_SWITCH_DATE, role, member, ticket: String(ticket), agent: member, subagent_type: type });
  return MEMBER_COLUMNS.map((c) => r[c]).join("\t");
}

function tierRow({ date = TIER_SWITCH_DATE, pr, ticket, tier }) {
  return [date, pr, ticket, "routine", tier, "yes", "no", "a note with spaces", "light", "production", "40", "2"].join("\t");
}

function ledgerText(rows = [], dispatched = []) {
  return `# Fleet run ledger\n\n## Rows\n${rows.map((r) => `- ${r}\n`).join("")}\n## Dispatched\n${dispatched.map((d) => `- ${d}\n`).join("")}\n## Filed\n\n## Ruled\n`;
}

function fixture(t, { members = [], tierRows = [], ledger = null, closes = [10] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tier-outcomes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$GH_LOG"\nprintf \'%s\\n\' "$GH_JSON"\n');
  chmodSync(join(bin, "gh"), 0o755);
  const f = {
    dir,
    tier: join(dir, "tier-outcomes.tsv"),
    members: join(dir, "member-outcomes.tsv"),
    ledger: join(dir, "ledger.md"),
    ghLog: join(dir, "gh.log"),
  };
  writeFileSync(f.tier, HEADER + tierRows.map((r) => `${r}\n`).join(""));
  writeFileSync(f.members, `# member facts\n${members.map((m) => `${memberRow(m)}\n`).join("")}`);
  if (ledger) writeFileSync(f.ledger, ledgerText(ledger.rows, ledger.dispatched));
  f.run = (...args) => {
    const r = spawnSync(process.execPath, [SCRIPT, ...args, "--file", f.tier, "--member-outcomes", f.members, "--ledger", f.ledger], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GH_LOG: f.ghLog,
        GH_JSON: JSON.stringify({ closingIssuesReferences: closes.map((number) => ({ number })) }),
      },
    });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  f.append = (pr = "20", { note = "a note with spaces" } = {}) =>
    f.run("append", pr, "--class", "routine", "--closed-own-ticket", "yes", "--minted-false-claim", "no", "--note", note);
  f.dataRows = () => readFileSync(f.tier, "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("#")).map((l) => l.split("\t"));
  f.ghCalls = () => (existsSync(f.ghLog) ? readFileSync(f.ghLog, "utf8").trim().split("\n").filter(Boolean) : []);
  return f;
}

const col = (name) => COLUMNS.indexOf(name);

// ---------------------------------------------------------------------------
// append
// ---------------------------------------------------------------------------

const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

test("append: the ledger's tier-ok token wins over member-outcomes.tsv", (t) => {
  const f = fixture(t, {
    ledger: { rows: ["#10 impl-10=PR#20 · class=routine · tier=alt · tier-ok=impl-10:fleet-implementer-alt"], dispatched: ["impl-10=PR#20"] },
    // An older dispatch of the same ticket under the default definition: step 2
    // alone would read `default`.
    members: [{ member: "impl-10", ticket: 10, type: "fleet-implementer" }],
  });
  const before = localDate();
  const r = f.append();
  const after = localDate();
  assert.equal(r.code, 0, r.stderr);
  const rows = f.dataRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].length, COLUMNS.length, "a new row is written to the full width");
  assert.equal(rows[0][col("pr")], "20");
  assert.equal(rows[0][col("ticket")], "10", "the ticket comes from gh's closingIssuesReferences");
  assert.equal(rows[0][col("tier")], "alt");
  // Stamped at ruling: the day `append` ran, in local time — either side of a
  // midnight the run straddled.
  assert.ok([before, after].includes(rows[0][col("run_date")]), `run_date ${rows[0][col("run_date")]} is not the day append ran`);
  assert.equal(rows[0][col("note")], "a note with spaces");
  assert.match(r.stderr, /tier-ok=impl-10:fleet-implementer-alt/);
  assert.deepEqual(f.ghCalls(), ["pr view 20 --json closingIssuesReferences"]);
});

test("append: the verdict of the member that opened the PR, not a replaced attempt's", (t) => {
  const f = fixture(t, {
    ledger: {
      rows: ["#10 impl-10=released · tier-ok=impl-10:fleet-implementer · impl-10-b=PR#20 · tier-ok=impl-10-b:fleet-implementer-alt"],
      dispatched: ["impl-10=released", "impl-10-b=PR#20"],
    },
  });
  assert.equal(f.append().code, 0);
  assert.equal(f.dataRows()[0][col("tier")], "alt");
});

test("append: with no ledger verdict, the ticket's single fleet-implementer* row in member-outcomes.tsv supplies it", (t) => {
  // The PR ruled in a later run than the one that dispatched it: this run's
  // ledger has no row for the ticket at all.
  const f = fixture(t, { members: [{ member: "impl-10", ticket: 10, type: "fleet-implementer" }] });
  const r = f.append();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(f.dataRows()[0][col("tier")], "default");
  assert.doesNotMatch(r.stderr, /WARNING/);
});

test("append: a per-cell definition's short name is its suffix, not refused", (t) => {
  const f = fixture(t, { members: [{ member: "impl-10", ticket: 10, type: "fleet-implementer-slow-high" }] });
  assert.equal(f.append().code, 0);
  assert.equal(f.dataRows()[0][col("tier")], "slow-high");
});

for (const [why, members, reason] of [
  ["no member row", [{ member: "impl-11", ticket: 11, type: "fleet-implementer" }], /no implementer row for #10/],
  [
    "several member rows",
    [{ member: "impl-10", ticket: 10, type: "fleet-implementer" }, { member: "impl-10-b", ticket: 10, type: "fleet-implementer-alt" }],
    /2 implementer rows for #10/,
  ],
  ["a `task` row", [{ member: "impl-10", ticket: 10, type: "task" }], /impl-10 ran as 'task', not a fleet-implementer\* definition/],
]) {
  test(`append: ${why} leaves tier blank, warns why, and still writes the row`, (t) => {
    const f = fixture(t, { members });
    const r = f.append();
    assert.equal(r.code, 0, r.stderr);
    const rows = f.dataRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].length, COLUMNS.length);
    assert.equal(rows[0][col("tier")], "");
    assert.match(r.stderr, /WARNING tier left blank for PR #20 \(ticket #10\)/);
    assert.match(r.stderr, reason);
  });
}

test("append: a tier-mismatch verdict blanks the tier instead of falling back to an older dispatch", (t) => {
  const f = fixture(t, {
    ledger: { rows: ["#10 impl-10=PR#20 · tier-mismatch=impl-10:fleet-implementer"], dispatched: ["impl-10=PR#20"] },
    members: [{ member: "impl-10", ticket: 10, type: "fleet-implementer" }],
  });
  const r = f.append();
  assert.equal(r.code, 0);
  assert.equal(f.dataRows()[0][col("tier")], "");
  assert.match(r.stderr, /tier-mismatch=impl-10:fleet-implementer/);
});

test("append: running it twice is a no-op that names the existing row and never asks gh", (t) => {
  const f = fixture(t, { members: [{ member: "impl-10", ticket: 10, type: "fleet-implementer" }] });
  assert.equal(f.append().code, 0);
  const before = readFileSync(f.tier, "utf8");
  const again = f.append("20", { note: "a different note" });
  assert.equal(again.code, 0, again.stderr);
  assert.equal(readFileSync(f.tier, "utf8"), before);
  assert.match(again.stdout, /PR #20 already has a row/);
  assert.ok(again.stdout.includes(before.trim().split("\n").at(-1)), "the existing row is printed");
  assert.equal(f.ghCalls().length, 1, "the second run asked gh again");
});

test("append: a tab in --note is refused before anything is written", (t) => {
  const f = fixture(t, { members: [{ member: "impl-10", ticket: 10, type: "fleet-implementer" }] });
  const before = readFileSync(f.tier, "utf8");
  const r = f.append("20", { note: "shifted\tfields" });
  assert.equal(r.code, 2);
  assert.equal(readFileSync(f.tier, "utf8"), before);
});

test("append: a PR closing no issue is refused, not written with a blank ticket", (t) => {
  const f = fixture(t, { closes: [] });
  const before = readFileSync(f.tier, "utf8");
  const r = f.append();
  assert.equal(r.code, 2);
  assert.match(r.stderr, /closes no issue/);
  assert.equal(readFileSync(f.tier, "utf8"), before);
});

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

test("check: a tier equal to the single implementer row's short name passes", (t) => {
  const f = fixture(t, {
    members: [{ member: "impl-10", ticket: 10, type: "fleet-implementer-alt" }, { member: "impl-12", ticket: 12, type: "fleet-implementer" }],
    tierRows: [tierRow({ pr: 20, ticket: 10, tier: "alt" }), tierRow({ pr: 22, ticket: 12, tier: "default" })],
  });
  const r = f.run("check");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /2 checked, 0 failed/);
});

test("check: a tier naming a different definition than ran fails", (t) => {
  const f = fixture(t, {
    members: [{ member: "impl-10", ticket: 10, type: "fleet-implementer-alt" }],
    tierRows: [tierRow({ pr: 20, ticket: 10, tier: "default" })],
  });
  const r = f.run("check");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /FAIL PR #20 \(ticket #10\): tier=default, but impl-10 ran as fleet-implementer-alt \(alt\)/);
});

test("check: a lone `task` implementer row fails a filled tier", (t) => {
  const f = fixture(t, {
    members: [{ member: "impl-10", ticket: 10, type: "task" }],
    tierRows: [tierRow({ pr: 20, ticket: 10, tier: "default" })],
  });
  const r = f.run("check");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /FAIL PR #20 .*ran as 'task'/);
});

test("check: blank, several-row and no-row rows are skipped, not failed", (t) => {
  const f = fixture(t, {
    members: [
      { member: "impl-10", ticket: 10, type: "task" },
      { member: "impl-11", ticket: 11, type: "fleet-implementer" },
      { member: "impl-11-b", ticket: 11, type: "task" },
    ],
    tierRows: [
      tierRow({ pr: 20, ticket: 10, tier: "" }),
      tierRow({ pr: 21, ticket: 11, tier: "default" }),
      tierRow({ pr: 22, ticket: 12, tier: "default" }),
    ],
  });
  const r = f.run("check");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /0 checked, 0 failed; skipped 0 before \S+, 1 blank, 1 with no member row, 1 with several member rows/);
});

test("check: rows dated before the switch are skipped, whatever they say", (t) => {
  const f = fixture(t, {
    members: [{ member: "impl-10", ticket: 10, type: "task" }],
    tierRows: [tierRow({ date: PRE_SWITCH, pr: 20, ticket: 10, tier: "opus" })],
  });
  const r = f.run("check");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /skipped 1 before/);
});

test("check --live: warns on each reviewed PR with no row, and the warning alone never fails", (t) => {
  const f = fixture(t, {
    members: [{ member: "impl-10", ticket: 10, type: "fleet-implementer" }],
    tierRows: [tierRow({ pr: 20, ticket: 10, tier: "default" })],
    ledger: {
      rows: [
        "#10 impl-10=PR#20 · reviewed=abcdef1:0/0/0",
        "#13 impl-13=PR#23 · reviewed=abcdef2:1/0/0",
        "#30 review=member:review-pr-30 · reviewed=abcdef3:0/1/0",
        "#14 impl-14=PR#24 · review=member:review-pr-24",
      ],
      dispatched: ["impl-10=PR#20", "impl-13=PR#23", "impl-14=PR#24"],
    },
  });
  const r = f.run("check", "--live");
  assert.equal(r.code, 0, r.stderr);
  const warned = [...r.stderr.matchAll(/WARNING PR #(\d+) carries reviewed=/g)].map((m) => Number(m[1]));
  assert.deepEqual(warned, [23, 30], "a reviewed PR with a row, or an unreviewed one, was warned about");
});

test("check --live: a run ledger that does not exist is refused, not read as empty", (t) => {
  const f = fixture(t, { tierRows: [tierRow({ pr: 20, ticket: 10, tier: "" })] });
  const r = f.run("check", "--live");
  assert.equal(r.code, 2);
  assert.match(r.stderr, /ledger/);
});
