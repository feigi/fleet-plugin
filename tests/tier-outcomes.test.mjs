// #2207: tier-outcomes.mjs writes the `tier` column instead of the controller
// typing it, and `check` compares it with what actually ran. Driven through
// the CLI against fixture files: the resolution order, the blank reasons and
// the idempotency are all observable only there, and `gh` is a PATH stub that
// logs every call so the no-op run can prove it never asked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { COLUMNS, LEGACY_WIDTH, RulingError, TIER_SWITCH_DATE, lastPullByTicket, parseTierOutcomes, rulingFor, rulingsByTicket } from "../plugin/scripts/tier-outcomes.mjs";
import { COLUMNS as MEMBER_COLUMNS } from "../plugin/scripts/member-outcomes.mjs";
import { sessionDate } from "../plugin/scripts/ticket-router.mjs";
import { writeExecStub } from "./support/exec-stub.mjs";

const SCRIPT = fileURLToPath(new URL("../plugin/scripts/tier-outcomes.mjs", import.meta.url));
const LATER = "2026-10-03";
assert.ok(LATER > TIER_SWITCH_DATE);
const PRE_SWITCH = "2026-09-17";
assert.ok(PRE_SWITCH < TIER_SWITCH_DATE);

const HEADER = `# ${COLUMNS.join("\t")}\n`;

// One member-outcomes.tsv row, every column present so parseTsv accepts it.
function memberRow({ member, ticket, type, role = "implementer" }) {
  const r = Object.fromEntries(MEMBER_COLUMNS.map((c) => [c, ""]));
  Object.assign(r, { session: "s1", run_date: TIER_SWITCH_DATE, role, member, ticket: String(ticket), agent: member, subagent_type: type });
  return MEMBER_COLUMNS.map((c) => r[c]).join("\t");
}

function tierRow({ date = TIER_SWITCH_DATE, pr, ticket, tier, closed = "yes", minted = "no" }) {
  return [date, pr, ticket, "routine", tier, closed, minted, "a note with spaces", "light", "production", "40", "2"].join("\t");
}

function ledgerText(rows = [], dispatched = []) {
  return `# Fleet run ledger\n\n## Rows\n${rows.map((r) => `- ${r}\n`).join("")}\n## Dispatched\n${dispatched.map((d) => `- ${d}\n`).join("")}\n## Filed\n\n## Ruled\n`;
}

// `clock` pins the child's `new Date()` to that instant and `tz` its TZ, so a
// date `append` stamps is independent of the host's clock and zone. `env` is
// laid over the child's environment.
function fixture(t, { members = [], tierRows = [], ledger = null, closes = [10], clock = null, tz = null, env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tier-outcomes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeExecStub(join(bin, "gh"), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$GH_LOG"\nprintf \'%s\\n\' "$GH_JSON"\n');
  const f = {
    tier: join(dir, "tier-outcomes.tsv"),
    members: join(dir, "member-outcomes.tsv"),
    ledger: join(dir, "ledger.md"),
    ghLog: join(dir, "gh.log"),
    bin,
    scratch: join(dir, "scratch"),
  };
  writeFileSync(f.tier, HEADER + tierRows.map((r) => `${r}\n`).join(""));
  writeFileSync(f.members, `# member facts\n${members.map((m) => `${memberRow(m)}\n`).join("")}`);
  if (ledger) writeFileSync(f.ledger, ledgerText(ledger.rows, ledger.dispatched));
  const preload = join(dir, "clock.mjs");
  if (clock) {
    writeFileSync(preload, `const at = ${Date.parse(clock)};
const Real = Date;
globalThis.Date = class extends Real {
  constructor(...a) { super(...(a.length ? a : [at])); }
  static now() { return at; }
};
`);
  }
  f.run = (...args) => {
    const node = clock ? ["--import", pathToFileURL(preload).href] : [];
    const r = spawnSync(process.execPath, [...node, SCRIPT, ...args, "--file", f.tier, "--member-outcomes", f.members, "--ledger", f.ledger], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        ...env,
        ...(tz ? { TZ: tz } : {}),
        PATH: `${bin}:${process.env.PATH}`,
        GH_LOG: f.ghLog,
        GH_JSON: JSON.stringify({ closingIssuesReferences: closes.map((number) => ({ number })) }),
      },
    });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  f.append = (pr = "20", { note = "a note with spaces", extra = [] } = {}) =>
    f.run("append", pr, "--closed-own-ticket", "yes", "--minted-false-claim", "no", "--note", note, "--scratch", f.scratch, ...extra);
  f.dataRows = () => readFileSync(f.tier, "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("#")).map((l) => l.split("\t"));
  f.ghCalls = () => (existsSync(f.ghLog) ? readFileSync(f.ghLog, "utf8").trim().split("\n").filter(Boolean) : []);
  return f;
}

const col = (name) => COLUMNS.indexOf(name);

// ---------------------------------------------------------------------------
// append
// ---------------------------------------------------------------------------

const utcDate = (d = new Date()) => d.toISOString().slice(0, 10);

test("append: the ledger's tier-ok token wins over member-outcomes.tsv", (t) => {
  const f = fixture(t, {
    ledger: { rows: ["#10 impl-10=PR#20 · class=routine · tier=alt · tier-ok=impl-10:fleet-implementer-alt"], dispatched: ["impl-10=PR#20"] },
    // An older dispatch of the same ticket under the default definition: step 2
    // alone would read `default`.
    members: [{ member: "impl-10", ticket: 10, type: "fleet-implementer" }],
  });
  const before = utcDate();
  const r = f.append();
  const after = utcDate();
  assert.equal(r.code, 0, r.stderr);
  const rows = f.dataRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].length, COLUMNS.length, "a new row is written to the full width");
  assert.equal(rows[0][col("pr")], "20");
  assert.equal(rows[0][col("ticket")], "10", "the ticket comes from gh's closingIssuesReferences");
  assert.equal(rows[0][col("tier")], "alt");
  assert.equal(rows[0][col("class")], "", "append writes the retired class column empty");
  // Stamped at ruling: the UTC day `append` ran — either side of a UTC
  // midnight the run straddled.
  assert.ok([before, after].includes(rows[0][col("run_date")]), `run_date ${rows[0][col("run_date")]} is not the day append ran`);
  assert.equal(rows[0][col("note")], "a note with spaces");
  assert.match(r.stderr, /tier-ok=impl-10:fleet-implementer-alt/);
  assert.deepEqual(f.ghCalls(), ["pr view 20 --json closingIssuesReferences"]);
});

// A Pull's `run_date` in ticket-features.tsv is the UTC date of its session
// id, and cell-readout.mjs's stopping rule and pr-cost.mjs join a ruling to a
// Pull with `run_date >=`. A ruling dated in the host's zone lands a day
// before a same-instant Pull west of UTC, so the join drops it. Each instant
// below is one where the zone's date and the UTC date differ.
for (const [tz, clock] of [
  ["America/Los_Angeles", "2026-10-05T03:30:00Z"],
  ["Asia/Tokyo", "2026-10-04T20:30:00Z"],
]) {
  test(`append: under TZ=${tz} at ${clock} run_date is the UTC date a same-instant session id carries`, (t) => {
    const local = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(clock));
    const session = `${clock.replace(/:/g, "-").replace("Z", "-000Z")}_abcdef12-3456-7890-abcd-ef1234567890`;
    assert.notEqual(local, sessionDate(session), `${clock} is an instant where ${tz}'s date is the UTC date`);
    const f = fixture(t, { members: [{ member: "impl-10", ticket: 10, type: "fleet-implementer-alt" }], clock, tz });
    const r = f.append();
    assert.equal(r.code, 0, r.stderr);
    assert.equal(f.dataRows()[0][col("run_date")], sessionDate(session));
  });
}

// A Pull's `run_date` in ticket-features.tsv is the UTC date of its session id
// (`sessionDate`), and the fit's and cell-readout's join drops a ruling dated
// before the Pull it rules. A ruling stamped with the host's zone date lands a
// day before a same-instant Pull west of UTC, so the join drops it. At any
// instant, one of these two zones is on a different calendar day than UTC.
for (const tz of ["Pacific/Kiritimati", "Pacific/Pago_Pago"]) {
  test(`append: under TZ=${tz} run_date is the UTC date`, (t) => {
    const f = fixture(t, {
      ledger: { rows: ["#10 impl-10=PR#20 · class=routine · tier=alt · tier-ok=impl-10:fleet-implementer-alt"], dispatched: ["impl-10=PR#20"] },
      tz,
    });
    const before = utcDate();
    const r = f.append();
    const after = utcDate();
    assert.equal(r.code, 0, r.stderr);
    assert.ok([before, after].includes(f.dataRows()[0][col("run_date")]), `run_date ${f.dataRows()[0][col("run_date")]} is not the UTC day append ran`);
  });
}

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

test("append: a stale tier-ok from a member who released the ticket is not used when nobody owns this PR", (t) => {
  const f = fixture(t, {
    ledger: { rows: ["#10 impl-10=released · tier-ok=impl-10:fleet-implementer-alt"], dispatched: ["impl-10=released"] },
  });
  const r = f.append();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(f.dataRows()[0][col("tier")], "");
  assert.match(r.stderr, /WARNING tier left blank for PR #20 \(ticket #10\): no implementer row for #10/);
});

test("append: with no ledger verdict, the ticket's single fleet-implementer* row in member-outcomes.tsv supplies it", (t) => {
  // The PR ruled in a later run than the one that dispatched it: this run's
  // ledger has no row for the ticket at all.
  const f = fixture(t, { members: [{ member: "impl-10", ticket: 10, type: "fleet-implementer" }] });
  const r = f.append();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(f.dataRows()[0][col("tier")], "default");
  assert.doesNotMatch(r.stderr, /WARNING tier/);
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

test("append: a member settled tier-mismatch on the ledger blanks the tier even with no free-text tier-mismatch= token", (t) => {
  // tier-check.mjs's main path (a mismatch caught while the member is still
  // live) settles the member as `tier-mismatch` directly and writes no
  // free-text token — see tier-check.mjs's recordImplementer.
  const f = fixture(t, {
    ledger: { rows: ["#10 impl-10=tier-mismatch"], dispatched: ["impl-10=tier-mismatch"] },
    members: [{ member: "impl-10", ticket: 10, type: "fleet-implementer" }],
  });
  const r = f.append();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(f.dataRows()[0][col("tier")], "");
  assert.match(r.stderr, /the ledger settled impl-10=tier-mismatch/);
});

test("append: a tier-unverifiable token is no verdict — the tier falls through to member-outcomes.tsv, never read as tier-ok", (t) => {
  // The token's tail is definition-shaped on purpose: a reader that took
  // `tier-unverifiable=` for a tier verdict would read `alt` off it, where
  // tier-check's own `:no-transcript` tail names no tier and would hide that.
  const f = fixture(t, {
    ledger: { rows: ["#10 impl-10=PR#20 · tier-unverifiable=impl-10:fleet-implementer-alt"], dispatched: ["impl-10=PR#20"] },
    members: [{ member: "impl-10", ticket: 10, type: "fleet-implementer" }],
  });
  const r = f.append();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(f.dataRows()[0][col("tier")], "default");
  assert.doesNotMatch(r.stderr, /tier-ok|tier-unverifiable/);
});

test("append: a replaced attempt's tier-unverifiable leaves the PR owner's own tier-ok standing", (t) => {
  const f = fixture(t, {
    ledger: {
      rows: ["#10 impl-10=killed · tier-unverifiable=impl-10:no-transcript · impl-10-b=PR#20 · tier-ok=impl-10-b:fleet-implementer-alt"],
      dispatched: ["impl-10=killed", "impl-10-b=PR#20"],
    },
  });
  assert.equal(f.append().code, 0);
  assert.equal(f.dataRows()[0][col("tier")], "alt");
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

test("append: a leading zero in the PR argument is normalized, not treated as a different PR", (t) => {
  const f = fixture(t, { members: [{ member: "impl-10", ticket: 10, type: "fleet-implementer" }] });
  assert.equal(f.append("020").code, 0);
  assert.equal(f.dataRows().length, 1);
  assert.equal(f.dataRows()[0][col("pr")], "20", "the stored PR is normalized, not the raw '020' argument");
  const again = f.append("20", { note: "a different note" });
  assert.equal(again.code, 0, again.stderr);
  assert.equal(f.dataRows().length, 1, "the normalized PR is recognized as already having a row, not duplicated");
});

test("append: a tab in --note is refused before anything is written", (t) => {
  const f = fixture(t, { members: [{ member: "impl-10", ticket: 10, type: "fleet-implementer" }] });
  const before = readFileSync(f.tier, "utf8");
  const r = f.append("20", { note: "shifted\tfields" });
  assert.equal(r.code, 2);
  assert.equal(readFileSync(f.tier, "utf8"), before);
});

test("append: a newline or carriage return in a flag value is refused, the same as a tab", (t) => {
  const f = fixture(t, { members: [{ member: "impl-10", ticket: 10, type: "fleet-implementer" }] });
  const before = readFileSync(f.tier, "utf8");
  for (const bad of ["shifted\nfields", "shifted\rfields"]) {
    const r = f.append("20", { note: bad });
    assert.equal(r.code, 2, `note ${JSON.stringify(bad)} was not refused`);
  }
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

test("append: --class is refused as an unknown flag before anything is written", (t) => {
  const f = fixture(t, { members: [{ member: "impl-10", ticket: 10, type: "fleet-implementer" }] });
  const before = readFileSync(f.tier, "utf8");
  const r = f.run("append", "20", "--class", "routine", "--closed-own-ticket", "yes", "--minted-false-claim", "no", "--note", "n");
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown flag --class/);
  assert.equal(readFileSync(f.tier, "utf8"), before);
  assert.deepEqual(f.ghCalls(), [], "refused before gh was asked");
});

test("append: a verdict that is not exactly yes or no is refused naming the flag, before gh is asked or anything is written", (t) => {
  for (const [flag, closed, minted] of [
    ["closed-own-ticket", "YES", "no"],
    ["closed-own-ticket", "yes ", "no"],
    ["minted-false-claim", "yes", "No"],
    ["minted-false-claim", "yes", "maybe"],
  ]) {
    const f = fixture(t, { members: [{ member: "impl-10", ticket: 10, type: "fleet-implementer" }] });
    const before = readFileSync(f.tier, "utf8");
    const r = f.run("append", "20", "--closed-own-ticket", closed, "--minted-false-claim", minted, "--note", "n");
    const got = flag === "closed-own-ticket" ? closed : minted;
    assert.equal(r.code, 2, `${flag}=${JSON.stringify(got)}\n${r.stdout}${r.stderr}`);
    assert.ok(r.stderr.includes(`--${flag} must be yes or no, got '${got}'`), r.stderr);
    assert.equal(readFileSync(f.tier, "utf8"), before);
    assert.deepEqual(f.ghCalls(), [], "refused before gh was asked");
  }
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
      // A single-member row (ticket 13) is CHECKED, not skipped — closes the
      // boundary between this and the several-member-rows case above.
      { member: "impl-13", ticket: 13, type: "fleet-implementer" },
    ],
    tierRows: [
      tierRow({ pr: 20, ticket: 10, tier: "" }),
      tierRow({ pr: 21, ticket: 11, tier: "default" }),
      tierRow({ pr: 22, ticket: 12, tier: "default" }),
      tierRow({ pr: 23, ticket: 13, tier: "default" }),
    ],
  });
  const r = f.run("check");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /1 checked, 0 failed; skipped 0 before \S+, 1 blank, 1 with no member row, 1 with several member rows/);
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

// The vacuous pass #2433 closes: the latest run's filled post-switch rows all
// lost their join to the member file, so nothing from it was compared and
// `0 checked` used to exit 0.
test("check: a run whose filled post-switch rows all lack a member row fails, naming them", (t) => {
  // impl-327-2 is an implementer name parseMemberName leaves with a blank ticket.
  const f = fixture(t, {
    members: [{ member: "impl-327-2", ticket: "", type: "fleet-implementer" }],
    tierRows: [
      tierRow({ date: PRE_SWITCH, pr: 19, ticket: 326, tier: "opus" }),
      tierRow({ pr: 20, ticket: 327, tier: "default" }),
      tierRow({ pr: 21, ticket: 328, tier: "default" }),
      tierRow({ pr: 22, ticket: 329, tier: "" }),
    ],
  });
  const r = f.run("check");
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stderr, new RegExp(`FAIL nothing from ${TIER_SWITCH_DATE}, .*was checked: .*PR #20 \\(ticket #327\\), PR #21 \\(ticket #328\\)$`, "m"));
  assert.doesNotMatch(r.stderr, /PR #19|PR #22/, "a pre-switch or blank-tier row is not a lost join");
  assert.match(r.stdout, /0 checked/);
});

test("check: a missing member file fails a filled post-switch row the same way", (t) => {
  const f = fixture(t, { tierRows: [tierRow({ pr: 20, ticket: 10, tier: "default" })] });
  rmSync(f.members);
  const r = f.run("check");
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /FAIL nothing from .*was checked: .*PR #20/);
});

// The tsv is cumulative, so an earlier run that checked fine must not hide a
// later run that lost every join.
test("check: a later run that lost every join fails even though an earlier run was checked", (t) => {
  const f = fixture(t, {
    members: [
      { member: "impl-10", ticket: 10, type: "fleet-implementer" },
      { member: "impl-327-2", ticket: "", type: "fleet-implementer" },
    ],
    tierRows: [
      tierRow({ pr: 20, ticket: 10, tier: "default" }),
      tierRow({ date: LATER, pr: 21, ticket: 327, tier: "default" }),
      tierRow({ date: LATER, pr: 22, ticket: 328, tier: "default" }),
    ],
  });
  const r = f.run("check");
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stderr, new RegExp(`FAIL nothing from ${LATER}, .*PR #21 .*PR #22`));
  assert.match(r.stdout, /1 checked, 1 failed/);
});

// A several-member-rows skip is by design, but it is no comparison and must
// not cancel the no-member-row alarm.
test("check: a several-member-rows row does not hide lost joins beside it", (t) => {
  const f = fixture(t, {
    members: [
      { member: "impl-11", ticket: 11, type: "task" },
      { member: "impl-11-b", ticket: 11, type: "task" },
    ],
    tierRows: [
      tierRow({ pr: 20, ticket: 327, tier: "default" }),
      tierRow({ pr: 21, ticket: 328, tier: "default" }),
      tierRow({ pr: 22, ticket: 329, tier: "default" }),
      tierRow({ pr: 23, ticket: 11, tier: "default" }),
    ],
  });
  const r = f.run("check");
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /FAIL nothing from .*PR #20 .*PR #21 .*PR #22/);
  assert.doesNotMatch(r.stderr, /PR #23/);
  assert.match(r.stdout, /0 checked.*3 with no member row, 1 with several member rows/);
});

// What the vacuity guard must ACCEPT: 0 checked is fine whenever no filled
// post-switch row of the latest run is missing its member row.
test("check: 0 checked still passes when every row is pre-switch, blank, or has several member rows", (t) => {
  const f = fixture(t, {
    members: [
      { member: "impl-11", ticket: 11, type: "task" },
      { member: "impl-11-b", ticket: 11, type: "task" },
    ],
    tierRows: [
      tierRow({ date: PRE_SWITCH, pr: 20, ticket: 10, tier: "opus" }),
      tierRow({ pr: 21, ticket: 10, tier: "" }),
      tierRow({ pr: 22, ticket: 11, tier: "default" }),
    ],
  });
  const r = f.run("check");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /0 checked, 0 failed/);
});

test("check: one checked row keeps a no-member-row sibling a skip, not a failure", (t) => {
  const f = fixture(t, {
    members: [{ member: "impl-10", ticket: 10, type: "fleet-implementer" }],
    tierRows: [tierRow({ pr: 20, ticket: 10, tier: "default" }), tierRow({ pr: 21, ticket: 99, tier: "default" })],
  });
  const r = f.run("check");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /1 checked, 0 failed.*1 with no member row/);
});

// Only the latest run is held to the guard: rows of an earlier run that lost
// their join stay a skip once a later run was checked.
test("check: an earlier run's lost joins do not fail a later run that was checked", (t) => {
  const f = fixture(t, {
    members: [{ member: "impl-10", ticket: 10, type: "fleet-implementer" }],
    tierRows: [
      tierRow({ pr: 20, ticket: 327, tier: "default" }),
      tierRow({ date: LATER, pr: 21, ticket: 10, tier: "default" }),
    ],
  });
  const r = f.run("check");
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /1 checked, 0 failed.*1 with no member row/);
});

test("check: a missing tier-outcomes.tsv file fails loudly instead of passing 0 checked", (t) => {
  const f = fixture(t, {
    members: [{ member: "impl-10", ticket: 10, type: "fleet-implementer" }],
    tierRows: [tierRow({ pr: 20, ticket: 10, tier: "default" })],
  });
  rmSync(f.tier);
  const r = f.run("check");
  assert.equal(r.code, 2);
  assert.match(r.stderr, /no .*tier-outcomes\.tsv — no rows to check/);
});

// Every reader of the file judges the floor as `minted_false_claim === "yes" ||
// closed_own_ticket === "no"`, so any other spelling would read as a pass.
test("check: a verdict column that is not yes, no or blank is refused as malformed, on full and legacy rows", (t) => {
  for (const [col, row] of [
    ["closed_own_ticket", tierRow({ pr: 21, ticket: 11, tier: "default", closed: "No" })],
    ["minted_false_claim", tierRow({ pr: 21, ticket: 11, tier: "default", minted: "YES" })],
    ["minted_false_claim", tierRow({ pr: 21, ticket: 11, tier: "default", minted: "no " })],
    ["closed_own_ticket", tierRow({ date: PRE_SWITCH, pr: 21, ticket: 11, tier: "opus", closed: "y" }).split("\t").slice(0, LEGACY_WIDTH).join("\t")],
  ]) {
    const f = fixture(t, {
      members: [{ member: "impl-10", ticket: 10, type: "fleet-implementer" }],
      tierRows: [tierRow({ pr: 20, ticket: 10, tier: "default" }), row],
    });
    const r = f.run("check");
    assert.equal(r.code, 2, `${row}\n${r.stdout}${r.stderr}`);
    const value = row.split("\t")[COLUMNS.indexOf(col)];
    assert.ok(r.stderr.includes(`malformed row: ${col} is '${value}', expected yes, no or blank`), r.stderr);
    assert.equal(r.stdout, "");
  }
});

// What the refusal must ACCEPT: the committed file carries never-ruled rows
// with both verdict columns blank, and every reader parses the whole file.
test("check: blank verdict columns and every yes/no pair parse, on full and legacy rows", (t) => {
  const f = fixture(t, {
    members: [{ member: "impl-10", ticket: 10, type: "fleet-implementer" }],
    tierRows: [
      tierRow({ date: PRE_SWITCH, pr: 19, ticket: 9, tier: "", closed: "", minted: "" }).split("\t").slice(0, LEGACY_WIDTH).join("\t"),
      tierRow({ pr: 20, ticket: 10, tier: "default", closed: "", minted: "" }),
      tierRow({ pr: 21, ticket: 10, tier: "default", closed: "yes", minted: "yes" }),
      tierRow({ pr: 22, ticket: 10, tier: "default", closed: "no", minted: "no" }),
      tierRow({ pr: 23, ticket: 10, tier: "default", closed: "no", minted: "yes" }),
    ],
  });
  const r = f.run("check");
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /4 checked, 0 failed/);
});

// A row with ONE verdict column blank is what a hand-edit leaves when it blanks
// a failing value; `append` never writes it and a no-ruling backfill blanks both.
test("check: a row with exactly one verdict column blank is refused as malformed, on full and legacy rows", (t) => {
  for (const [closed, minted] of [["", "no"], ["", "yes"], ["yes", ""], ["no", ""]]) {
    for (const legacy of [false, true]) {
      const full = tierRow({ date: legacy ? PRE_SWITCH : TIER_SWITCH_DATE, pr: 21, ticket: 11, tier: "default", closed, minted });
      const row = legacy ? full.split("\t").slice(0, LEGACY_WIDTH).join("\t") : full;
      const f = fixture(t, {
        members: [{ member: "impl-10", ticket: 10, type: "fleet-implementer" }],
        tierRows: [tierRow({ pr: 20, ticket: 10, tier: "default" }), row],
      });
      const r = f.run("check");
      const label = `${JSON.stringify({ closed, minted, legacy })}\n${r.stdout}${r.stderr}`;
      assert.equal(r.code, 2, label);
      assert.ok(r.stderr.includes(`malformed row: closed_own_ticket is '${closed}' but minted_false_claim is '${minted}', expected both blank or both yes or no`), label);
      assert.equal(r.stdout, "");
    }
  }
});

test("check --live: warns on each reviewed PR with no row, and the warning alone never fails", (t) => {
  const f = fixture(t, {
    members: [{ member: "impl-10", ticket: 10, type: "fleet-implementer" }],
    tierRows: [tierRow({ pr: 20, ticket: 10, tier: "default" })],
    ledger: {
      rows: [
        "#10 impl-10=PR#20 · reviewed=abcdef1:0/0/0:run-abcdef1r",
        "#13 impl-13=PR#23 · reviewed=abcdef2:1/0/0:run-abcdef2r",
        "#30 review=member:review-pr-30 · reviewed=abcdef3:0/1/0:run-abcdef3r",
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

// A PR that closes no issue can never get a row (append keys on exactly one
// ticket), so the close-out must not be asked for one.
test("check --live: a reviewed PR that closes no issue is noted, never warned about", (t) => {
  const f = fixture(t, {
    members: [{ member: "impl-10", ticket: 10, type: "fleet-implementer" }],
    tierRows: [tierRow({ pr: 20, ticket: 10, tier: "default" })],
    closes: [],
    ledger: { rows: ["#13 impl-13=PR#23 · reviewed=abcdef2:1/0/0:run-abcdef2r"], dispatched: ["impl-13=PR#23"] },
  });
  const r = f.run("check", "--live");
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /WARNING PR #23/);
  assert.match(r.stderr, /note PR #23 carries reviewed= on the ledger and closes no issue/);
  assert.deepEqual(f.ghCalls(), ["pr view 23 --json closingIssuesReferences"]);
});

// The skip is only for a read that answered "no issue": a read that failed says
// nothing, so the PR keeps its warning, after a line naming why the read failed.
test("check --live: a PR whose closing references cannot be read keeps its warning, and says why", (t) => {
  const f = fixture(t, {
    members: [{ member: "impl-10", ticket: 10, type: "fleet-implementer" }],
    tierRows: [tierRow({ pr: 20, ticket: 10, tier: "default" })],
    ledger: { rows: ["#13 impl-13=PR#23 · reviewed=abcdef2:1/0/0:run-abcdef2r"], dispatched: ["impl-13=PR#23"] },
  });
  writeExecStub(join(f.bin, "gh"), "#!/bin/sh\necho 'HTTP 401: Bad credentials' >&2\nexit 1\n");
  const r = f.run("check", "--live");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /WARNING PR #23 carries reviewed=/);
  assert.match(r.stderr, /could not read the closing references of PR #23: gh pr view 23 failed: HTTP 401: Bad credentials/);
  assert.doesNotMatch(r.stderr, /note PR #23/);
});

// An answer that is not an array is no "closes no issue" either, whatever its
// length reads as.
test("check --live: a closingIssuesReferences that is not an array keeps the warning", (t) => {
  const f = fixture(t, {
    members: [{ member: "impl-10", ticket: 10, type: "fleet-implementer" }],
    tierRows: [tierRow({ pr: 20, ticket: 10, tier: "default" })],
    ledger: { rows: ["#13 impl-13=PR#23 · reviewed=abcdef2:1/0/0:run-abcdef2r"], dispatched: ["impl-13=PR#23"] },
  });
  writeExecStub(join(f.bin, "gh"), "#!/bin/sh\nprintf '%s\\n' '{\"closingIssuesReferences\":\"\"}'\n");
  const r = f.run("check", "--live");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /WARNING PR #23 carries reviewed=/);
  assert.match(r.stderr, /could not read the closing references of PR #23: gh pr view 23 returned no closingIssuesReferences array/);
  assert.doesNotMatch(r.stderr, /note PR #23/);
});

// An ambient GH_REPO naming another repository must not decide which PR either
// read of closing references asks about: `gh` sees it blanked.
test("append and check --live read closing references with an ambient GH_REPO blanked", (t) => {
  const logRepo = "#!/bin/sh\nprintf '%s GH_REPO=[%s]\\n' \"$*\" \"${GH_REPO-unset}\" >> \"$GH_LOG\"\nprintf '%s\\n' \"$GH_JSON\"\n";
  const live = fixture(t, {
    members: [{ member: "impl-10", ticket: 10, type: "fleet-implementer" }],
    tierRows: [tierRow({ pr: 20, ticket: 10, tier: "default" })],
    closes: [],
    ledger: { rows: ["#13 impl-13=PR#23 · reviewed=abcdef2:1/0/0:run-abcdef2r"], dispatched: ["impl-13=PR#23"] },
    env: { GH_REPO: "someone/else" },
  });
  writeExecStub(join(live.bin, "gh"), logRepo);
  const r = live.run("check", "--live");
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(live.ghCalls(), ["pr view 23 --json closingIssuesReferences GH_REPO=[]"]);

  const appended = fixture(t, { members: [{ member: "impl-10", ticket: 10, type: "fleet-implementer" }], env: { GH_REPO: "someone/else" } });
  writeExecStub(join(appended.bin, "gh"), logRepo);
  const a = appended.append();
  assert.equal(a.code, 0, a.stderr);
  assert.deepEqual(appended.ghCalls(), ["pr view 20 --json closingIssuesReferences GH_REPO=[]"]);
});

test("check --live: a run ledger that does not exist is refused, not read as empty", (t) => {
  const f = fixture(t, { tierRows: [tierRow({ pr: 20, ticket: 10, tier: "" })] });
  const r = f.run("check", "--live");
  assert.equal(r.code, 2);
  assert.match(r.stderr, /ledger/);
});

// File order is the contract for both picks; a date only sets the floor.
test("rulingFor: of two qualifying rulings, the later row in file order wins even when it is older-dated", () => {
  const rows = parseTierOutcomes(HEADER + [
    tierRow({ date: "2026-10-03", pr: 20, ticket: 10, tier: "default", closed: "yes", minted: "no" }),
    tierRow({ date: "2026-10-02", pr: 21, ticket: 10, tier: "default", closed: "no", minted: "no" }),
  ].join("\n"));
  const v = rulingFor(rulingsByTicket(rows), "10", "2026-10-01");
  assert.equal(v.pr, "21", "the earlier row, dated later, was picked");
  assert.equal(rulingFor(rulingsByTicket(rows), "10", "2026-10-03").pr, "20", "a ruling dated before the Pull still counted");
});

// Built by hand, since parseTierOutcomes refuses these verdicts before rulingFor sees them.
const ruling = (run_date, pr, closed_own_ticket, minted_false_claim) => ({ run_date, pr: String(pr), closed_own_ticket, minted_false_claim });

test("rulingFor: a malformed verdict on any ruling of the ticket is refused, not only on the picked one", () => {
  const valid = ruling("2026-10-05", 21, "no", "yes");
  for (const [label, rows, pr, col, value] of [
    ["superseded by a later valid ruling", [ruling("2026-10-03", 20, "maybe", "no"), valid], 20, "closed_own_ticket", "maybe"],
    ["dated before the Pull's floor", [ruling("2026-09-20", 20, "yes", "YES"), valid], 20, "minted_false_claim", "YES"],
    ["with no ruling clearing the floor", [ruling("2026-09-20", 20, "", "no")], 20, "closed_own_ticket", ""],
    ["the picked ruling itself", [valid, ruling("2026-10-06", 22, "yes", "No")], 22, "minted_false_claim", "No"],
  ]) {
    assert.throws(() => rulingFor(new Map([["10", rows]]), "10", "2026-10-01"),
      (e) => e instanceof RulingError && e.message === `ticket #10 (PR #${pr}): ${col} is '${value}', expected yes or no`, label);
  }
});

// What the refusal must ACCEPT: every yes/no pair on a superseded or pre-floor ruling.
test("rulingFor: superseded and pre-floor rulings holding every yes/no pair leave the pick unchanged", () => {
  const rows = [
    ruling("2026-09-20", 19, "no", "yes"),
    ruling("2026-10-04", 20, "yes", "yes"),
    ruling("2026-10-03", 21, "no", "no"),
    ruling("2026-10-02", 22, "yes", "no"),
    ruling("2026-09-21", 23, "no", "yes"),
  ];
  const rulings = new Map([["10", rows]]);
  assert.equal(rulingFor(rulings, "10", "2026-10-01"), rows[3], "the last qualifying row in file order");
  assert.equal(rulingFor(rulings, "10", "2026-10-05"), null, "no row clears the floor");
  assert.equal(rulingFor(rulings, "11", "2026-10-01"), null, "an unruled ticket");
});

test("lastPullByTicket: of two Pulls in reverse date order, the later row in file order is the ruling's date floor", () => {
  const pull = (run_date, agent) => ({ run_date, session: "s1", agent, ticket: "10", chosen_cell: "slow-high" });
  const later = pull("2026-10-01", "impl-10-2");
  const pulls = lastPullByTicket([pull("2026-10-05", "impl-10"), later, { ...pull("2026-10-02", "impl-11"), ticket: "11" }]);
  assert.equal(pulls.get("10"), later, "the whole later row, not the later-dated one");
  assert.equal(pulls.get("11").agent, "impl-11", "a ticket with one Pull was dropped");
  const rulings = rulingsByTicket(parseTierOutcomes(HEADER + tierRow({ date: "2026-10-03", pr: 20, ticket: 10, tier: "default" })));
  assert.equal(rulingFor(rulings, "10", pulls.get("10").run_date)?.pr, "20", "the later-dated Pull set the floor");
});

// ---------------------------------------------------------------------------
// append: `sizing` from the implementer's report file
// ---------------------------------------------------------------------------

const SHA = "a".repeat(40);
// A report that checks against report-schema.mjs's `impl` family.
const implReport = (member, sizing) => ({
  member, outcome: "pr", pr: 20, head: SHA, branch: `implementer/${member}`,
  sizing, bailCause: null, bailDetail: null, confirmation: [],
});
const MEASURED = (verdict, extra = {}) => ({ verdict, signal: "two implementation files, one consumer", ranBeforePr: true, ...extra });
const writeReport = (f, member, body) => {
  mkdirSync(join(f.scratch, "reports"), { recursive: true });
  writeFileSync(join(f.scratch, "reports", `${member}.json`), typeof body === "string" ? body : JSON.stringify(body));
};
const sizingOf = (f) => f.dataRows()[0][col("sizing")];
const IMPL = { members: [{ member: "impl-10", ticket: 10, type: "fleet-implementer" }] };

test("append: sizing is filled from a report whose sizing ran before the PR, and stderr names the file", (t) => {
  const f = fixture(t, IMPL);
  writeReport(f, "impl-10", implReport("impl-10", MEASURED("heavy")));
  const r = f.append();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(sizingOf(f), "heavy");
  assert.ok(r.stderr.includes(`sizing=heavy from ${join(f.scratch, "reports", "impl-10.json")}`), r.stderr);
  assert.doesNotMatch(r.stderr, /WARNING sizing/);
});

test("append: a report whose sizing ran AFTER the PR leaves sizing blank and the WARNING names ranBeforePr", (t) => {
  const f = fixture(t, IMPL);
  writeReport(f, "impl-10", implReport("impl-10", MEASURED("light", { ranBeforePr: false })));
  const r = f.append();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(sizingOf(f), "");
  assert.match(r.stderr, /WARNING sizing left blank for PR #20 \(ticket #10\): .*impl-10\.json: sizing\.ranBeforePr is not true/);
});

test("append: a report whose sizing names no signal leaves sizing blank and the WARNING names signal", (t) => {
  for (const signal of ["", "  \t "]) {
    const f = fixture(t, IMPL);
    writeReport(f, "impl-10", implReport("impl-10", MEASURED("light", { signal })));
    const r = f.append();
    assert.equal(r.code, 0, r.stderr);
    assert.equal(sizingOf(f), "", `signal ${JSON.stringify(signal)} was accepted`);
    assert.match(r.stderr, /WARNING sizing left blank .*sizing\.signal is empty/);
    assert.doesNotMatch(r.stderr, /ranBeforePr/, "a condition that held was named as failed");
  }
});

test("append: both failed conditions are named, not just the first", (t) => {
  const f = fixture(t, IMPL);
  writeReport(f, "impl-10", implReport("impl-10", MEASURED("light", { ranBeforePr: false, signal: "" })));
  const r = f.append();
  assert.match(r.stderr, /sizing\.ranBeforePr is not true and sizing\.signal is empty/);
});

test("append: no report file leaves sizing blank and the WARNING says there is none for the ticket", (t) => {
  const f = fixture(t, IMPL);
  const r = f.append();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(sizingOf(f), "");
  assert.match(r.stderr, /WARNING sizing left blank for PR #20 \(ticket #10\): no implementer report for ticket #10 under /);
});

test("append: another ticket's report is not this ticket's, whatever its digits start with", (t) => {
  const f = fixture(t, IMPL);
  writeReport(f, "impl-100", implReport("impl-100", MEASURED("heavy")));
  writeReport(f, "impl-1", implReport("impl-1", MEASURED("heavy")));
  writeReport(f, "fix-pr-20", implReport("fix-pr-20", MEASURED("heavy")));
  const r = f.append();
  assert.equal(sizingOf(f), "");
  assert.match(r.stderr, /no implementer report for ticket #10/);
});

test("append: the highest retry letter's report wins, the unlettered name ranking lowest", (t) => {
  const f = fixture(t, IMPL);
  writeReport(f, "impl-10", implReport("impl-10", MEASURED("light")));
  writeReport(f, "impl-10-b", implReport("impl-10-b", MEASURED("heavy")));
  writeReport(f, "impl-10-c", implReport("impl-10-c", MEASURED("light")));
  const r = f.append();
  assert.equal(sizingOf(f), "light");
  assert.ok(r.stderr.includes("impl-10-c.json"), r.stderr);
  // The later attempt is the one read even when it is the one that failed:
  // falling back to an older attempt's verdict would record a measurement
  // the winning attempt did not make.
  const f2 = fixture(t, IMPL);
  writeReport(f2, "impl-10", implReport("impl-10", MEASURED("light")));
  writeReport(f2, "impl-10-d", implReport("impl-10-d", MEASURED("heavy", { ranBeforePr: false })));
  const r2 = f2.append();
  assert.equal(sizingOf(f2), "");
  assert.match(r2.stderr, /impl-10-d\.json: sizing\.ranBeforePr is not true/);
});

test("append: a report that fails its schema, or is not JSON, or has no sizing, leaves sizing blank with that reason", (t) => {
  const cases = [
    [implReport("impl-10", MEASURED("light")), (r) => { r.head = "not-hex"; return r; }, /does not check against its schema: \$\.head/],
    ["{ not json", null, /does not check against its schema: \$: not JSON/],
    [implReport("impl-10", null), null, /carries no sizing \(sizing is null\)/],
    [implReport("impl-10", MEASURED("medium")), null, /does not check against its schema: \$\.sizing\.verdict/],
  ];
  for (const [body, mutate, want] of cases) {
    const f = fixture(t, IMPL);
    writeReport(f, "impl-10", mutate ? mutate(body) : body);
    const r = f.append();
    assert.equal(r.code, 0, r.stderr);
    assert.equal(sizingOf(f), "", `${want} was accepted`);
    assert.match(r.stderr, want);
  }
});

test("append: an explicit --sizing wins over the report, and stderr names the flag as the source", (t) => {
  const f = fixture(t, IMPL);
  writeReport(f, "impl-10", implReport("impl-10", MEASURED("heavy")));
  const r = f.append("20", { extra: ["--sizing", "light"] });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(sizingOf(f), "light");
  assert.match(r.stderr, /sizing=light from --sizing/);
  assert.doesNotMatch(r.stderr, /WARNING sizing/);
  // Explicit with no report file at all: still the flag, no lookup warning.
  const g = fixture(t, IMPL);
  const r2 = g.append("20", { extra: ["--sizing", "heavy"] });
  assert.equal(sizingOf(g), "heavy");
  assert.doesNotMatch(r2.stderr, /WARNING sizing/);
});

test("append: a --sizing that is not light or heavy is still refused", (t) => {
  const f = fixture(t, IMPL);
  const r = f.append("20", { extra: ["--sizing", "medium"] });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--sizing must be light or heavy/);
});

test("append: with no --scratch and no repository to key a scratch root on, sizing is blank and says why", (t) => {
  const f = fixture(t, IMPL);
  const r = f.run("append", "20", "--closed-own-ticket", "yes", "--minted-false-claim", "no", "--note", "n");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(sizingOf(f), "");
  assert.match(r.stderr, /WARNING sizing left blank for PR #20 \(ticket #10\): no scratch root to look in/);
});

test("check: --scratch is an append flag and is refused by name", (t) => {
  const f = fixture(t);
  const r = f.run("check", "--scratch", f.scratch);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--scratch is an append flag/);
});
