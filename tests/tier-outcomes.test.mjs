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
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { COLUMNS, LEGACY_WIDTH, RulingError, TIER_SWITCH_DATE, deriveRuling, isDerivedNote, lastPullByTicket, parseTierOutcomes, rulingFor, rulingsByTicket } from "../plugin/scripts/tier-outcomes.mjs";
import { COLUMNS as MEMBER_COLUMNS } from "../plugin/scripts/member-outcomes.mjs";
import { sessionDate } from "../plugin/scripts/ticket-router.mjs";
import { writeExecStub } from "./support/exec-stub.mjs";
import { ref, prUrl } from "./support/queue-gh.mjs";

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

// `gh pr view <pr> --json closingIssuesReferences,url` as the stub answers it:
// PR <pr>'s url in the fixture's own repository and the references GH_REFS
// holds. `gh pr view <pr> --json state` answers GH_STATE.
const PR_VIEW_ANSWER = "if [ \"$5\" = state ]; then printf '{\"state\":\"%s\"}\\n' \"$GH_STATE\"; exit 0; fi\n"
  + "printf '{\"closingIssuesReferences\":%s,\"url\":\"%s%s\"}\\n' \"$GH_REFS\" \"$GH_PULL\" \"$3\"\n";

// `clock` pins the child's `new Date()` to that instant and `tz` its TZ, so a
// date `append` stamps is independent of the host's clock and zone. `env` is
// laid over the child's environment. `closes` is the PR's closing references:
// each an issue number in its own repository, or a reference object as it
// stands — `ref(n, "other/repo")` for another repository's issue.
function fixture(t, { members = [], tierRows = [], ledger = null, closes = [10], clock = null, tz = null, env = {}, state = "MERGED" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tier-outcomes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeExecStub(join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$GH_LOG"\n${PR_VIEW_ANSWER}`);
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
        GH_REFS: JSON.stringify(closes.map((r) => (typeof r === "number" ? ref(r) : r))),
        GH_PULL: prUrl(""),
        GH_STATE: state,
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
  assert.deepEqual(f.ghCalls(), ["pr view 20 --json state", "pr view 20 --json closingIssuesReferences,url"]);
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
  assert.equal(f.ghCalls().length, 2, "the second run asked gh again");
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

// A PR whose closing references are not exactly one takes its ticket from the
// one settled `impl-<N>=PR#<pr>` token in the run ledger, and from no other row.
test("append: a PR closing no issue takes its ticket from the settled impl token, with either verdict", (t) => {
  for (const closed of ["yes", "no"]) {
    const f = fixture(t, {
      closes: [],
      members: [{ member: "impl-10", ticket: 10, type: "fleet-implementer" }],
      ledger: {
        rows: ["#10 impl-10=PR#20 · tier-ok=impl-10:fleet-implementer-alt · reviewed=abcdef1:0/0/0:run-abcdef1r", "#11 PR #20 review: a fold note"],
        dispatched: ["impl-10=PR#20"],
      },
    });
    const r = f.run("append", "20", "--closed-own-ticket", closed, "--minted-false-claim", "no", "--note", "a note", "--scratch", f.scratch);
    assert.equal(r.code, 0, r.stderr);
    const rows = f.dataRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0][col("ticket")], "10");
    assert.equal(rows[0][col("closed_own_ticket")], closed);
    assert.equal(rows[0][col("tier")], "alt");
  }
});

test("append and check --live: several closing references take the settled impl token's ticket and that row's tier", (t) => {
  const f = fixture(t, {
    closes: [10, 37],
    members: [{ member: "impl-10", ticket: 10, type: "fleet-implementer-smol-high" }],
    ledger: {
      rows: ["#10 impl-10=PR#20 · tier-ok=impl-10:fleet-implementer-smol-high · reviewed=abcdef1:0/0/0:run-abcdef1r"],
      dispatched: ["impl-10=PR#20"],
    },
  });
  const before = f.run("check", "--live");
  assert.equal(before.code, 0, before.stderr);
  assert.match(before.stderr, /WARNING PR #20 carries reviewed=/);
  const r = f.append();
  assert.equal(r.code, 0, r.stderr);
  const rows = f.dataRows();
  assert.equal(rows[0][col("ticket")], "10");
  assert.equal(rows[0][col("tier")], "smol-high");
  const after = f.run("check", "--live");
  assert.doesNotMatch(after.stderr, /WARNING PR #20/);
});

// The token's N decides, not GitHub's order: here it is not the first closing issue.
test("append: several closing references take the settled impl token's ticket wherever it sits among them", (t) => {
  const f = fixture(t, {
    closes: [37, 10],
    members: [{ member: "impl-10", ticket: 10, type: "fleet-implementer" }],
    ledger: { rows: ["#10 impl-10=PR#20 · reviewed=abcdef1:0/0/0:run-abcdef1r"], dispatched: ["impl-10=PR#20"] },
  });
  const r = f.append();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(f.dataRows()[0][col("ticket")], "10");
});

test("check --live and append: several closing references with no settled impl token are noted, and append refuses them", (t) => {
  const f = fixture(t, {
    closes: [14, 15, 16],
    members: [{ member: "impl-10", ticket: 10, type: "fleet-implementer" }],
    tierRows: [tierRow({ pr: 20, ticket: 10, tier: "default" })],
    ledger: { rows: ["#31 review=member:review-pr-31 · reviewed=abcdef3:0/1/0:run-abcdef3r"] },
  });
  const before = readFileSync(f.tier, "utf8");
  const c = f.run("check", "--live");
  assert.equal(c.code, 0, c.stderr);
  assert.doesNotMatch(c.stderr, /WARNING PR #31/);
  assert.match(c.stderr, /note PR #31 carries reviewed= on the ledger and closes 3 issues, and no settled impl token names it/);
  const r = f.append("31");
  assert.equal(r.code, 2);
  assert.match(r.stderr, /no run-ledger row carries a settled impl-N=PR#31 token/);
  assert.equal(readFileSync(f.tier, "utf8"), before);
});

test("check --live and append: a PR closing no issue with no impl token is noted, and append refuses it", (t) => {
  const f = fixture(t, { closes: [], ledger: { rows: ["#13 PR#23 · reviewed=abcdef2:1/0/0:run-abcdef2r"] } });
  const c = f.run("check", "--live");
  assert.equal(c.code, 0, c.stderr);
  assert.doesNotMatch(c.stderr, /WARNING PR #23/);
  assert.match(c.stderr, /note PR #23 carries reviewed= on the ledger and closes no issue, and no settled impl token names it/);
  const r = f.append("23");
  assert.equal(r.code, 2);
  assert.match(r.stderr, /closes no issue/);
  assert.equal(f.dataRows().length, 0);
});

test("check --live and append: a PR closing no issue, with a settled impl token naming it, is warned about and takes that ticket", (t) => {
  const f = fixture(t, {
    closes: [],
    members: [{ member: "impl-13", ticket: 13, type: "fleet-implementer" }],
    ledger: { rows: ["#13 impl-13=PR#23 · reviewed=abcdef2:1/0/0:run-abcdef2r"], dispatched: ["impl-13=PR#23"] },
  });
  const c = f.run("check", "--live");
  assert.equal(c.code, 0, c.stderr);
  assert.match(c.stderr, /WARNING PR #23 carries reviewed=/);
  assert.doesNotMatch(c.stderr, /note PR #23/);
  const r = f.append("23");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(f.dataRows()[0][col("ticket")], "13");
});

test("append: no ledger row carrying a settled impl token for the PR is refused, with zero closing references", (t) => {
  const f = fixture(t, { closes: [], ledger: { rows: ["#10 impl-10=PR#21 · reviewed=abcdef1:0/0/0:run-abcdef1r"] } });
  const before = readFileSync(f.tier, "utf8");
  const r = f.append("20");
  assert.equal(r.code, 2);
  assert.match(r.stderr, /no run-ledger row carries a settled impl-N=PR#20 token/);
  assert.equal(readFileSync(f.tier, "utf8"), before);
});

test("append: a settled impl token naming a longer PR number that starts with this one's is not a claim", (t) => {
  const f = fixture(t, { closes: [], ledger: { rows: ["#10 impl-10=PR#200 · reviewed=abcdef1:0/0/0:run-abcdef1r"] } });
  const before = readFileSync(f.tier, "utf8");
  const r = f.append("20");
  assert.equal(r.code, 2);
  assert.match(r.stderr, /no run-ledger row carries a settled impl-N=PR#20 token/);
  assert.equal(readFileSync(f.tier, "utf8"), before);
});

test("append: two rows with a settled impl token for the PR are refused, naming both rows, with zero or several closing references", (t) => {
  for (const closes of [[], [10, 11]]) {
    const f = fixture(t, {
      closes,
      ledger: { rows: ["#10 impl-10=PR#20 · reviewed=abcdef1:0/0/0:run-abcdef1r", "#12 impl-12=PR#20 · reviewed=abcdef2:0/0/0:run-abcdef2r"] },
    });
    const r = f.append();
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /#10, #12/);
    assert.equal(f.dataRows().length, 0);
  }
});

test("append: several closing references that do not include the settled impl token's ticket are refused, naming both", (t) => {
  const f = fixture(t, { closes: [10, 11], ledger: { rows: ["#12 impl-12=PR#20 · reviewed=abcdef2:0/0/0:run-abcdef2r"] } });
  const r = f.append();
  assert.equal(r.code, 2);
  assert.match(r.stderr, /#12/);
  assert.match(r.stderr, /closes 2 issues \(#10, #11\)/);
  assert.equal(f.dataRows().length, 0);
});

// A PR that settled impl tokens name but that append still refuses stays a NEED,
// and its warning carries append's reason, so the close-out is told what to fix.
test("check --live: a PR whose settled impl tokens append refuses keeps its warning, and says why append refuses it", (t) => {
  for (const [closes, rows, why] of [
    [[10, 11], ["#10 impl-10=PR#20 · reviewed=abcdef1:0/0/0:run-abcdef1r", "#12 impl-12=PR#20 · reviewed=abcdef2:0/0/0:run-abcdef2r"], /2 run-ledger rows carry a settled impl-N=PR#20 token \(#10, #12\)/],
    [[10, 11], ["#12 impl-12=PR#20 · reviewed=abcdef2:0/0/0:run-abcdef2r"], /names #12, which is not among them/],
  ]) {
    const f = fixture(t, { closes, ledger: { rows } });
    const r = f.run("check", "--live");
    assert.equal(r.code, 0, r.stderr);
    const warning = r.stderr.split("\n").find((l) => l.includes("WARNING PR #20 carries reviewed="));
    assert.ok(warning, r.stderr);
    assert.match(warning, /`tier-outcomes\.mjs append 20` refuses it: PR #20 closes 2 issues \(#10, #11\)/);
    assert.match(warning, why);
    assert.doesNotMatch(r.stderr, /note PR #20/);
  }
});

test("append: exactly one closing issue is the ticket, whatever the ledger says", (t) => {
  const f = fixture(t, { closes: [10], ledger: { rows: ["#12 impl-12=PR#20 · reviewed=abcdef2:0/0/0:run-abcdef2r"] } });
  const r = f.append();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(f.dataRows()[0][col("ticket")], "10");
});

test("append: a PR closing no issue and no ledger is refused, not written with a blank ticket", (t) => {
  const f = fixture(t, { closes: [] });
  const before = readFileSync(f.tier, "utf8");
  const r = f.append();
  assert.equal(r.code, 2);
  assert.match(r.stderr, /closes no issue/);
  assert.equal(readFileSync(f.tier, "utf8"), before);
});

// A closing reference with no integer issue number is a read that did not
// answer: append refuses it rather than taking a ticket from the ledger, and
// check --live keeps the PR's warning after naming why.
test("append and check --live: a closing reference with no integer issue number is refused and warned about, whatever the ledger says", (t) => {
  const { number: _n, ...unnumbered } = ref(10);
  for (const closes of [[unnumbered], [null], [{ ...ref(10), number: "10" }], [null, 10]]) {
    const f = fixture(t, { closes, ledger: { rows: ["#10 impl-10=PR#20 · reviewed=abcdef1:0/0/0:run-abcdef1r"], dispatched: ["impl-10=PR#20"] } });
    const r = f.append();
    assert.equal(r.code, 2, r.stderr);
    assert.ok(r.stderr.includes("gh pr view 20 answered a reference with no issue number"), r.stderr);
    assert.equal(f.dataRows().length, 0);
    const c = f.run("check", "--live");
    assert.equal(c.code, 0, c.stderr);
    assert.match(c.stderr, /could not read the closing references of PR #20: .*no issue number/);
    assert.match(c.stderr, /WARNING PR #20 carries reviewed=/);
  }
});

// Another repository's reference closes none of this repository's issues,
// whatever its number: a PR whose only reference is one closes no issue here,
// and takes its ticket from its settled impl token or is refused.
test("append: a PR whose only closing reference is another repository's takes its settled impl token's ticket", (t) => {
  const f = fixture(t, {
    closes: [ref(10, "other-org/other-repo")],
    members: [{ member: "impl-13", ticket: 13, type: "fleet-implementer" }],
    ledger: { rows: ["#13 impl-13=PR#20 · reviewed=abcdef2:1/0/0:run-abcdef2r"], dispatched: ["impl-13=PR#20"] },
  });
  const r = f.append();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(f.dataRows()[0][col("ticket")], "13");
});

test("append: a PR whose only closing reference is another repository's, with no settled impl token, is refused as closing no issue", (t) => {
  const f = fixture(t, { closes: [ref(10, "other-org/other-repo")], ledger: { rows: ["#10 PR#20 · reviewed=abcdef1:0/0/0:run-abcdef1r"] } });
  const before = readFileSync(f.tier, "utf8");
  const r = f.append();
  assert.equal(r.code, 2);
  assert.match(r.stderr, /PR #20 closes no issue per GitHub's closingIssuesReferences, and no run-ledger row carries a settled impl-N=PR#20 token/);
  assert.equal(readFileSync(f.tier, "utf8"), before);
});

test("append: another repository's reference beside the PR's own one leaves the own one its ticket", (t) => {
  const f = fixture(t, { closes: [ref(11, "other-org/other-repo"), 10], members: [{ member: "impl-10", ticket: 10, type: "fleet-implementer" }] });
  const r = f.append();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(f.dataRows()[0][col("ticket")], "10");
});

test("append and check --live: a reference with neither a url nor a repository is refused and warned about", (t) => {
  const { url: _url, repository: _repository, ...unplaced } = ref(10);
  const f = fixture(t, { closes: [unplaced], ledger: { rows: ["#10 impl-10=PR#20 · reviewed=abcdef1:0/0/0:run-abcdef1r"], dispatched: ["impl-10=PR#20"] } });
  const r = f.append();
  assert.equal(r.code, 2, r.stderr);
  assert.ok(r.stderr.includes("gh pr view 20 answered a reference to #10 with neither a url nor a repository"), r.stderr);
  assert.equal(f.dataRows().length, 0);
  const c = f.run("check", "--live");
  assert.equal(c.code, 0, c.stderr);
  assert.match(c.stderr, /could not read the closing references of PR #20: gh pr view 20 answered a reference to #10 with neither a url nor a repository/);
  assert.match(c.stderr, /WARNING PR #20 carries reviewed=/);
  assert.doesNotMatch(c.stderr, /note PR #20/);
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

test("append: a fresh consumer with no docs/metrics/ gets the directory, the header and the row", (t) => {
  const f = fixture(t, {
    ledger: { rows: ["#10 impl-10=PR#20 · class=routine · tier-ok=impl-10:fleet-implementer"], dispatched: ["impl-10=PR#20"] },
    members: [{ member: "impl-10", ticket: 10, type: "fleet-implementer" }],
  });
  f.tier = join(dirname(f.ledger), "docs", "metrics", "tier-outcomes.tsv");
  assert.equal(existsSync(dirname(f.tier)), false);
  const r = f.append();
  assert.equal(r.code, 0, r.stderr);
  const lines = readFileSync(f.tier, "utf8").split("\n").filter(Boolean);
  assert.equal(lines[0], HEADER.trimEnd());
  assert.equal(lines.length, 2);
  assert.equal(f.dataRows()[0][col("pr")], "20");
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

// A PR that closes no issue, or several, and that no settled impl token names,
// has no ticket append can key a row on, so the close-out must not be asked for
// one: it is noted, never warned about.
test("check --live: a reviewed PR that closes no issue and names no implementer is noted, never warned about", (t) => {
  const f = fixture(t, {
    members: [{ member: "impl-10", ticket: 10, type: "fleet-implementer" }],
    tierRows: [tierRow({ pr: 20, ticket: 10, tier: "default" })],
    closes: [],
    ledger: { rows: ["#13 PR#23 · reviewed=abcdef2:1/0/0:run-abcdef2r"] },
  });
  const r = f.run("check", "--live");
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /WARNING PR #23/);
  assert.match(r.stderr, /note PR #23 carries reviewed= on the ledger and closes no issue, and no settled impl token names it/);
  assert.deepEqual(f.ghCalls(), ["pr view 23 --json closingIssuesReferences,url"]);
});

// A settled impl token naming the PR makes it an implementer PR whose ticket
// append can read, so a PR that closes no issue then keeps its warning.
test("check --live: a reviewed PR that closes no issue but has a settled impl token keeps its warning", (t) => {
  const f = fixture(t, {
    members: [{ member: "impl-10", ticket: 10, type: "fleet-implementer" }],
    tierRows: [tierRow({ pr: 20, ticket: 10, tier: "default" })],
    closes: [],
    ledger: { rows: ["#13 impl-13=PR#23 · reviewed=abcdef2:1/0/0:run-abcdef2r"], dispatched: ["impl-13=PR#23"] },
  });
  const r = f.run("check", "--live");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /WARNING PR #23 carries reviewed=/);
  assert.doesNotMatch(r.stderr, /note PR #23/);
});

// The skip is only for a read that answered "no issue" or "several": a read that
// failed says nothing, so the PR keeps its warning, after a line naming why the read failed.
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

// An answer that is not an array is no answer of "no issue" or "several" either,
// whatever its length reads as.
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
  const logRepo = `#!/bin/sh\nprintf '%s GH_REPO=[%s]\\n' "$*" "\${GH_REPO-unset}" >> "$GH_LOG"\n${PR_VIEW_ANSWER}`;
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
  assert.deepEqual(live.ghCalls(), ["pr view 23 --json closingIssuesReferences,url GH_REPO=[]"]);

  const appended = fixture(t, { members: [{ member: "impl-10", ticket: 10, type: "fleet-implementer" }], env: { GH_REPO: "someone/else" } });
  writeExecStub(join(appended.bin, "gh"), logRepo);
  const a = appended.append();
  assert.equal(a.code, 0, a.stderr);
  assert.deepEqual(appended.ghCalls(), ["pr view 20 --json state GH_REPO=[]", "pr view 20 --json closingIssuesReferences,url GH_REPO=[]"]);
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

// ---------------------------------------------------------------------------
// append: the verdict columns and the note worked out from the Charges
// ---------------------------------------------------------------------------

const RUN_1 = "run-aaaaaaa1";
const RUN_2 = "run-bbbbbbb2";
const HEAD_1 = "1111111aaaa";
const HEAD_2 = "2222222bbbb";
const reviewedToken = (head, survived, refuted, unverified, run) => `reviewed=${head}:${survived}/${refuted}/${unverified}:${run}`;
const answeredToken = (run, member = "fix-pr-20", verdict = "ok") => `dispositions-${verdict}=${member}:${run}`;

const finding = (claim) => ({ severity: "important", claim, evidence: "ran it", file: "a.mjs", line: 1 });
const entry = (bucket, index, extra = {}) => ({ bucket, index, scope: "in", claimKind: "behavior", disposition: "apply", ...extra });
const charged = (bucket, index, charge, extra = {}) => entry(bucket, index, { charge, ...extra });
const chargedNone = (bucket, index, chargeReason) => entry(bucket, index, { charge: "none", chargeReason });

// The review result file the ledger's `reviewed=` token names, under the scratch root.
function writeReview(f, { run, head, survived = [], refuted = [], unverified = [], dimensionsUnrun = [] }) {
  const dir = join(f.scratch, "pr20", run);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "review.json"), JSON.stringify({
    pr: 20, head, dimensionsRun: ["correctness", "tests"], dimensionsUnrun,
    counts: { survived: survived.length, refuted: refuted.length, unverified: unverified.length, crashed: 0 },
    survived, refuted, unverified,
  }));
}

// A fix-applier's record, `letter` its retry suffix (none for the first attempt).
function writeRecord(f, { letter = "", run, entries }) {
  mkdirSync(f.scratch, { recursive: true });
  writeFileSync(join(f.scratch, `dispositions-fix-pr-20${letter ? `-${letter}` : ""}.json`), JSON.stringify({ head: HEAD_1, run, entries }));
}

// PR 20's run on the ledger, its review files and records in scratch.
function ruled(t, { tokens, reviews = [], records = [], ...options }) {
  const f = fixture(t, {
    ledger: { rows: [`#10 impl-10=PR#20 · tier-ok=impl-10:fleet-implementer · ${tokens.join(" · ")}`], dispatched: ["impl-10=PR#20"] },
    ...options,
  });
  for (const r of reviews) writeReview(f, r);
  for (const r of records) writeRecord(f, r);
  f.derive = (...extra) => f.run("append", "20", "--scratch", f.scratch, ...extra);
  return f;
}

// One survived finding on review 1, answered by the record `entries`.
function oneReview(t, { survived = [finding("the claim")], refuted = [], unverified = [], entries, review = {}, ...options }) {
  return ruled(t, {
    tokens: [reviewedToken(HEAD_1, survived.length, refuted.length, unverified.length, RUN_1), answeredToken(RUN_1)],
    reviews: [{ run: RUN_1, head: HEAD_1, survived, refuted, unverified, ...review }],
    records: [{ run: RUN_1, entries }],
    ...options,
  });
}

const verdicts = (f) => {
  const [row] = f.dataRows();
  return { closed: row[col("closed_own_ticket")], minted: row[col("minted_false_claim")], note: row[col("note")] };
};

test("append: a survived finding charged false-claim is ruled minted_false_claim=yes although the fix pass applied it", (t) => {
  const f = oneReview(t, { entries: [charged("survived", 0, "false-claim", { disposition: "apply" })] });
  const r = f.derive();
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(verdicts(f), {
    closed: "yes", minted: "yes",
    note: `review ${RUN_1} at 1111111, record dispositions-fix-pr-20.json: survived[0] false-claim "the claim"`,
  });
  assert.equal(f.dataRows()[0].length, COLUMNS.length);
  assert.ok(r.stderr.includes(`from the Charges on review ${RUN_1}\n`), r.stderr);
});

test("append: a refuted finding the fix-applier reversed and charged unmet rules closed_own_ticket=no", (t) => {
  const f = oneReview(t, {
    survived: [finding("another")], refuted: [finding("it breaks the build")],
    entries: [chargedNone("survived", 0, "defect-outside-acceptance"), charged("refuted", 0, "unmet", { reason: "the build does break" })],
  });
  const r = f.derive();
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(verdicts(f), {
    closed: "no", minted: "no",
    note: `review ${RUN_1} at 1111111, record dispositions-fix-pr-20.json: refuted[0] unmet "it breaks the build"; none: survived[0] defect-outside-acceptance`,
  });
});

test("append: a Charge of both fails both columns", (t) => {
  const f = oneReview(t, { entries: [charged("survived", 0, "both")] });
  assert.equal(f.derive().code, 0);
  const v = verdicts(f);
  assert.equal(v.closed, "no");
  assert.equal(v.minted, "yes");
  assert.match(v.note, /survived\[0\] both "the claim"/);
});

test("append: a survived finding deferred false-rationale fails nothing, and the note lists it as cleared", (t) => {
  const f = oneReview(t, { entries: [entry("survived", 0, { disposition: "defer", reason: "false-rationale", issue: 5 })] });
  const r = f.derive();
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(verdicts(f), {
    closed: "yes", minted: "no",
    note: `review ${RUN_1} at 1111111, record dispositions-fix-pr-20.json: cleared: survived[0] false-rationale`,
  });
});

test("append: standing findings all charged none rule a pass, and the note names each reason", (t) => {
  const f = oneReview(t, {
    survived: [finding("one"), finding("two")], refuted: [finding("three")],
    entries: [
      chargedNone("survived", 0, "defect-outside-acceptance"),
      chargedNone("survived", 1, "claim-about-untouched-code"),
      { ...chargedNone("refuted", 0, "not-the-implementers-text"), reason: "reversed on evidence" },
    ],
  });
  const r = f.derive();
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(verdicts(f), {
    closed: "yes", minted: "no",
    note: `review ${RUN_1} at 1111111, record dispositions-fix-pr-20.json: none: survived[0] defect-outside-acceptance, survived[1] claim-about-untouched-code, refuted[0] not-the-implementers-text`,
  });
});

test("append: the note lists charged entries, then none, cleared and unrun, in that order", (t) => {
  const f = oneReview(t, {
    survived: [finding("a"), finding("b"), finding("c")],
    entries: [
      charged("survived", 0, "unmet"),
      chargedNone("survived", 1, "defect-outside-acceptance"),
      entry("survived", 2, { disposition: "defer", reason: "false-rationale" }),
    ],
    review: { dimensionsUnrun: [{ dimension: "docs", reason: "crashed" }, { dimension: "tests", reason: "crashed" }] },
  });
  assert.equal(f.derive().code, 0);
  assert.equal(
    verdicts(f).note,
    `review ${RUN_1} at 1111111, record dispositions-fix-pr-20.json: survived[0] unmet "a"; none: survived[1] defect-outside-acceptance; cleared: survived[2] false-rationale; unrun: docs, tests`,
  );
});

test("append: a dimension that never ran does not stop the Ruling, and the note names it", (t) => {
  const f = oneReview(t, {
    entries: [chargedNone("survived", 0, "defect-outside-acceptance")],
    review: { dimensionsUnrun: [{ dimension: "tests", reason: "the reviewer returned nothing" }] },
  });
  const r = f.derive();
  assert.equal(r.code, 0, r.stderr);
  assert.match(verdicts(f).note, /; unrun: tests$/);
  assert.equal(verdicts(f).closed, "yes");
});

test("append: --note follows the composed note after an em dash", (t) => {
  const f = oneReview(t, { entries: [chargedNone("survived", 0, "defect-outside-acceptance")] });
  assert.equal(f.derive("--note", "also seen by hand").code, 0);
  assert.match(verdicts(f).note, /^review run-aaaaaaa1 at 1111111, record dispositions-fix-pr-20\.json: none: survived\[0\] defect-outside-acceptance — also seen by hand$/);
});

test("append: tabs and newlines in a claim become spaces, so the row keeps its width", (t) => {
  const f = oneReview(t, { survived: [finding("PR body:\tsays\nit works\r\nfine")], entries: [charged("survived", 0, "false-claim")] });
  const r = f.derive();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(f.dataRows().length, 1);
  assert.equal(f.dataRows()[0].length, COLUMNS.length);
  assert.match(verdicts(f).note, /survived\[0\] false-claim "PR body: says it works  fine"$/);
});

test("append: a first review that counted no survived and no unverified finding is a pass with no record, even when a later review found more", (t) => {
  const f = ruled(t, {
    tokens: [reviewedToken(HEAD_1, 0, 2, 0, RUN_1), reviewedToken(HEAD_2, 3, 0, 1, RUN_2)],
    reviews: [
      { run: RUN_1, head: HEAD_1, refuted: [finding("x"), finding("y")] },
      { run: RUN_2, head: HEAD_2, survived: [finding("p"), finding("q"), finding("r")], unverified: [finding("s")] },
    ],
  });
  const r = f.derive();
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(verdicts(f), {
    closed: "yes", minted: "no",
    note: `review ${RUN_1} at 1111111, no record: counted no survived and no unverified finding`,
  });
});

test("append: a review superseded before any fix-applier answered it is skipped, and the next review is used", (t) => {
  const f = ruled(t, {
    tokens: [reviewedToken(HEAD_1, 1, 0, 0, RUN_1), reviewedToken(HEAD_2, 1, 0, 0, RUN_2), answeredToken(RUN_2)],
    reviews: [
      { run: RUN_1, head: HEAD_1, survived: [finding("first")] },
      { run: RUN_2, head: HEAD_2, survived: [finding("second")] },
    ],
    records: [{ run: RUN_2, entries: [charged("survived", 0, "false-claim")] }],
  });
  const r = f.derive();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(verdicts(f).minted, "yes");
  assert.match(verdicts(f).note, /^review run-bbbbbbb2 at 2222222, record dispositions-fix-pr-20\.json: survived\[0\] false-claim "second"$/);
});

test("append: a retry's record replaces the first attempt's on the same run, and a record from a later review changes nothing", (t) => {
  const f = ruled(t, {
    tokens: [
      reviewedToken(HEAD_1, 1, 0, 0, RUN_1), answeredToken(RUN_1, "fix-pr-20-b", "mismatch"), answeredToken(RUN_1, "fix-pr-20", "mismatch"),
      reviewedToken(HEAD_2, 1, 0, 0, RUN_2), answeredToken(RUN_2, "fix-pr-20-c"),
    ],
    reviews: [
      { run: RUN_1, head: HEAD_1, survived: [finding("same run")] },
      { run: RUN_2, head: HEAD_2, survived: [finding("later run")] },
    ],
    records: [
      { run: RUN_1, entries: [chargedNone("survived", 0, "defect-outside-acceptance")] },
      { letter: "b", run: RUN_1, entries: [charged("survived", 0, "false-claim")] },
      { letter: "c", run: RUN_2, entries: [charged("survived", 0, "unmet")] },
    ],
  });
  const r = f.derive();
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(verdicts(f), {
    closed: "yes", minted: "yes",
    note: `review ${RUN_1} at 1111111, record dispositions-fix-pr-20-b.json: survived[0] false-claim "same run"`,
  });
});

test("append: a record whose dispositions-check verdict was escalate still yields a row", (t) => {
  const f = ruled(t, {
    tokens: [reviewedToken(HEAD_1, 1, 0, 0, RUN_1), answeredToken(RUN_1, "fix-pr-20", "escalate")],
    reviews: [{ run: RUN_1, head: HEAD_1, survived: [finding("deferred outside the diff")] }],
    records: [{ run: RUN_1, entries: [charged("survived", 0, "unmet", { disposition: "defer", reason: "remedy-outside-diff" })] }],
  });
  const r = f.derive();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(verdicts(f).closed, "no");
});

test("append: a unverified finding never stands, so a record answering only it needs no Charge", (t) => {
  const f = oneReview(t, { survived: [], unverified: [finding("suggestion")], entries: [entry("unverified", 0, { disposition: "defer" })] });
  const r = f.derive();
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(verdicts(f), {
    closed: "yes", minted: "no",
    note: `review ${RUN_1} at 1111111, record dispositions-fix-pr-20.json: no finding stands`,
  });
});

test("append: a derivation on an open PR is written, and asks gh nothing about its state", (t) => {
  const f = oneReview(t, { state: "OPEN", entries: [charged("survived", 0, "false-claim")] });
  const r = f.derive();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(verdicts(f).minted, "yes");
  assert.deepEqual(f.ghCalls(), ["pr view 20 --json closingIssuesReferences,url"]);
});

// A standing finding with no Charge writes no row, and the refusal names it.
for (const [what, entries] of [
  ["no entry answers it", [charged("survived", 0, "unmet")]],
  ["its entry carries no charge", [charged("survived", 0, "unmet"), entry("survived", 1)]],
  ["its charge is none with no reason", [charged("survived", 0, "unmet"), entry("survived", 1, { charge: "none" })]],
  ["its charge is not one of the Charges", [charged("survived", 0, "unmet"), entry("survived", 1, { charge: "guilty" })]],
]) {
  test(`append: a standing finding with no Charge is refused, naming it, and writes no row — ${what}`, (t) => {
    const f = oneReview(t, { state: "OPEN", survived: [finding("charged one"), finding("the uncharged one")], entries });
    const before = readFileSync(f.tier, "utf8");
    const r = f.derive();
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /survived\[1\] "the uncharged one"/);
    assert.doesNotMatch(r.stderr, /survived\[0\]/);
    assert.match(r.stderr, /check the record again/);
    assert.match(r.stderr, /dispatch the fix-applier again as a dispositions retry/);
    assert.equal(readFileSync(f.tier, "utf8"), before);
  });
}

// A record entry the Ruling cannot read writes no row, and the refusal names it.
for (const [what, entries, message] of [
  ["a second entry for a finding carries a harsher Charge", [chargedNone("survived", 0, "defect-outside-acceptance"), charged("survived", 0, "both")], /entries\[1\] is a second entry for survived\[0\], which entries\[0\] already answers/],
  ["an entry names an index past its bucket", [chargedNone("survived", 0, "defect-outside-acceptance"), charged("survived", 5, "unmet")], /entries\[1\] names survived\[5\], and survived holds 1/],
  ["an entry names a bucket the review has not got", [chargedNone("survived", 0, "defect-outside-acceptance"), charged("standing", 0, "unmet")], /entries\[1\] names bucket "standing", not survived, refuted or unverified/],
  ["an entry is not an object", [chargedNone("survived", 0, "defect-outside-acceptance"), null], /entries\[1\] is not an object/],
]) {
  test(`append: a record entry a Ruling cannot read is refused, naming it, and writes no row — ${what}`, (t) => {
    const f = oneReview(t, { state: "OPEN", entries });
    const before = readFileSync(f.tier, "utf8");
    const r = f.derive();
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, message);
    assert.match(r.stderr, /check the record again/);
    assert.equal(readFileSync(f.tier, "utf8"), before);
  });
}

// The ledger's head and review.json's are one commit when either is a prefix
// of the other, whatever case review.json spells it in.
for (const [what, tokenHead, fileHead] of [
  ["review.json spells it longer and in upper case", "abcdef1", "ABCDEF1AAAA"],
  ["the ledger spells it longer, review.json in upper case", "abcdef1aaaa", "ABCDEF1"],
]) {
  test(`append: a review file whose head is the ledger's in another spelling derives a row — ${what}`, (t) => {
    const f = ruled(t, { tokens: [reviewedToken(tokenHead, 0, 0, 0, RUN_1)], reviews: [{ run: RUN_1, head: fileHead }] });
    const r = f.derive();
    assert.equal(r.code, 0, r.stderr);
    assert.match(verdicts(f).note, /^review run-aaaaaaa1 at abcdef1, no record: /);
  });
}

test("append: a record from a member lettered a answers the run, ahead of the first attempt's", (t) => {
  const f = oneReview(t, { entries: [chargedNone("survived", 0, "defect-outside-acceptance")] });
  writeRecord(f, { letter: "a", run: RUN_1, entries: [charged("survived", 0, "unmet")] });
  const r = f.derive();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(verdicts(f).closed, "no");
  assert.match(verdicts(f).note, /, record dispositions-fix-pr-20-a\.json: survived\[0\] unmet "the claim"$/);
});

for (const [what, at] of [
  ["review.json", (f) => join(f.scratch, "pr20", RUN_1, "review.json")],
  ["the record", (f) => join(f.scratch, "dispositions-fix-pr-20.json")],
]) {
  test(`append: ${what} that cannot be read is refused by its error code, not as bad JSON`, (t) => {
    const f = oneReview(t, { entries: [chargedNone("survived", 0, "defect-outside-acceptance")] });
    const path = at(f);
    rmSync(path);
    mkdirSync(path);
    const r = f.derive();
    assert.equal(r.code, 2, r.stderr);
    assert.ok(r.stderr.includes(`${path} cannot be read: EISDIR`), r.stderr);
    assert.doesNotMatch(r.stderr, /JSON/);
    assert.equal(f.dataRows().length, 0);
  });
}

test("append: an unrun dimension that names no dimension is written as its JSON, never as a blank", (t) => {
  const f = oneReview(t, {
    entries: [chargedNone("survived", 0, "defect-outside-acceptance")],
    review: { dimensionsUnrun: [{ reason: "crashed" }, 5, null, "docs"] },
  });
  const r = f.derive();
  assert.equal(r.code, 0, r.stderr);
  assert.match(verdicts(f).note, /; unrun: \{"reason":"crashed"\}, 5, null, docs$/);
});

test("append: a reversed refutation with no Charge is refused, naming it", (t) => {
  const f = oneReview(t, { survived: [finding("kept")], refuted: [finding("reversed")], entries: [chargedNone("survived", 0, "defect-outside-acceptance"), entry("refuted", 0, { reason: "evidence" })] });
  const r = f.derive();
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /refuted\[0\] "reversed"/);
  assert.equal(f.dataRows().length, 0);
});

// Every refusal below leaves the file untouched and names the controller's next step.
const REFUSALS = [
  ["the ledger carries no first review", { tokens: ["review=member:review-pr-20"] }, /PR #20 has no first review on the ledger/],
  ["the review's result file is missing", {
    tokens: [reviewedToken(HEAD_1, 1, 0, 0, RUN_1), answeredToken(RUN_1)],
    records: [{ run: RUN_1, entries: [charged("survived", 0, "unmet")] }],
  }, /review run-aaaaaaa1's result file \S+review\.json is missing/],
  ["no record answers the review", {
    tokens: [reviewedToken(HEAD_1, 1, 0, 0, RUN_1), answeredToken(RUN_1)],
    reviews: [{ run: RUN_1, head: HEAD_1, survived: [finding("x")] }],
  }, /no \S+dispositions-fix-pr-20\[-x\]\.json names review run-aaaaaaa1/],
  ["the only record answers another run", {
    tokens: [reviewedToken(HEAD_1, 1, 0, 0, RUN_1), answeredToken(RUN_1)],
    reviews: [{ run: RUN_1, head: HEAD_1, survived: [finding("x")] }],
    records: [{ run: RUN_2, entries: [charged("survived", 0, "unmet")] }],
  }, /names review run-aaaaaaa1 as the run it answers/],
  ["the review file is another head's", {
    tokens: [reviewedToken(HEAD_1, 0, 0, 0, RUN_1)],
    reviews: [{ run: RUN_1, head: HEAD_2 }],
  }, /is the review of head 2222222bbbb, not the ledger's review run-aaaaaaa1 at 1111111aaaa/],
  ["the review file holds a finding the ledger's review did not count", {
    tokens: [reviewedToken(HEAD_1, 0, 0, 0, RUN_1)],
    reviews: [{ run: RUN_1, head: HEAD_1, survived: [finding("x")] }],
  }, /review\.json holds 1 survived and 0 unverified, not the 0 and 0 the ledger's review run-aaaaaaa1 counted/],
  ["the review file holds fewer findings than the ledger's review counted", {
    tokens: [reviewedToken(HEAD_1, 1, 0, 1, RUN_1), answeredToken(RUN_1)],
    reviews: [{ run: RUN_1, head: HEAD_1, unverified: [finding("x")] }],
    records: [{ run: RUN_1, entries: [entry("unverified", 0, { disposition: "defer" })] }],
  }, /review\.json holds 0 survived and 1 unverified, not the 1 and 1 the ledger's review run-aaaaaaa1 counted/],
];
for (const [what, setup, message] of REFUSALS) {
  for (const state of ["OPEN", "CLOSED"]) {
    test(`append: ${state === "OPEN" ? "an open" : "a closed"} PR is refused when ${what}, the next step being the record, never typed verdicts`, (t) => {
      const f = ruled(t, { reviews: [], records: [], ...setup, state });
      const before = readFileSync(f.tier, "utf8");
      const r = f.derive();
      assert.equal(r.code, 2, r.stderr);
      assert.match(r.stderr, message);
      assert.match(r.stderr, /check the record again/);
      assert.match(r.stderr, /dispatch the fix-applier again as a dispositions retry/);
      assert.doesNotMatch(r.stderr, /--closed-own-ticket|--minted-false-claim|yes\|no/);
      assert.equal(readFileSync(f.tier, "utf8"), before);
    });
  }
  test(`append: a merged PR is refused when ${what}, and the refusal names the flags to give`, (t) => {
    const f = ruled(t, { reviews: [], records: [], ...setup });
    const before = readFileSync(f.tier, "utf8");
    const r = f.derive();
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, message);
    assert.match(r.stderr, /append 20 --closed-own-ticket yes\|no --minted-false-claim yes\|no --note "<the evidence>"/);
    assert.equal(readFileSync(f.tier, "utf8"), before);
  });
}

test("append: a record that is not JSON refuses rather than letting an older record stand in for a retry's", (t) => {
  const f = oneReview(t, { entries: [chargedNone("survived", 0, "defect-outside-acceptance")] });
  writeFileSync(join(f.scratch, "dispositions-fix-pr-20-b.json"), "{ not json");
  const r = f.derive();
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /dispositions-fix-pr-20-b\.json is not valid JSON/);
  assert.equal(f.dataRows().length, 0);
});

test("append: a refusal says so when the PR's state cannot be read, and still gives no verdict flags", (t) => {
  const f = ruled(t, { tokens: ["review=member:review-pr-20"] });
  writeExecStub(join(f.bin, "gh"), "#!/bin/sh\nif [ \"$5\" = state ]; then echo 'HTTP 401' >&2; exit 1; fi\n" + PR_VIEW_ANSWER);
  const r = f.derive();
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /the PR's state could not be read: gh pr view 20 failed: HTTP 401/);
  assert.doesNotMatch(r.stderr, /yes\|no/);
});

test("append: with no --scratch and no repository to key a scratch root on, the derivation refuses and says why", (t) => {
  const f = oneReview(t, { state: "OPEN", entries: [charged("survived", 0, "false-claim")] });
  const r = f.run("append", "20");
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /no scratch root to look in/);
  assert.equal(f.dataRows().length, 0);
});

// ---------------------------------------------------------------------------
// deriveRuling: the same Ruling over in-memory values, no scratch and no process
// ---------------------------------------------------------------------------

const RECORD_FILE = "dispositions-fix-pr-20.json";
const RECORD_PATH = join("/nowhere", RECORD_FILE);
// A record lookup that answers with `entries`, counting how often it is asked.
function lookup(entries) {
  const fn = () => {
    fn.calls += 1;
    return { file: RECORD_FILE, path: RECORD_PATH, value: { head: HEAD_1, run: RUN_1, entries } };
  };
  fn.calls = 0;
  return fn;
}
const derive = ({ survived = [finding("the claim")], refuted = [], unverified = [], dimensionsUnrun = [], record }) =>
  deriveRuling({ run: RUN_1, head: HEAD_1, review: { survived, refuted, unverified, dimensionsUnrun }, record });

test("deriveRuling: a survived finding charged false-claim rules minted_false_claim=yes, and the note carries no --note", () => {
  assert.deepEqual(derive({ record: lookup([charged("survived", 0, "false-claim")]) }), {
    closed_own_ticket: "yes", minted_false_claim: "yes",
    note: `review ${RUN_1} at 1111111, record ${RECORD_FILE}: survived[0] false-claim "the claim"`,
  });
});

test("deriveRuling: a refuted finding charged unmet rules closed_own_ticket=no", () => {
  const record = lookup([chargedNone("survived", 0, "defect-outside-acceptance"), charged("refuted", 0, "unmet", { reason: "the build does break" })]);
  assert.deepEqual(derive({ survived: [finding("another")], refuted: [finding("it breaks the build")], record }), {
    closed_own_ticket: "no", minted_false_claim: "no",
    note: `review ${RUN_1} at 1111111, record ${RECORD_FILE}: refuted[0] unmet "it breaks the build"; none: survived[0] defect-outside-acceptance`,
  });
});

test("deriveRuling: a survived finding charged both fails both columns", () => {
  assert.deepEqual(derive({ record: lookup([charged("survived", 0, "both")]) }), {
    closed_own_ticket: "no", minted_false_claim: "yes",
    note: `review ${RUN_1} at 1111111, record ${RECORD_FILE}: survived[0] both "the claim"`,
  });
});

test("deriveRuling: a standing finding charged none rules a pass, and the note names its reason", () => {
  assert.deepEqual(derive({ record: lookup([chargedNone("survived", 0, "claim-about-untouched-code")]) }), {
    closed_own_ticket: "yes", minted_false_claim: "no",
    note: `review ${RUN_1} at 1111111, record ${RECORD_FILE}: none: survived[0] claim-about-untouched-code`,
  });
});

test("deriveRuling: a survived finding deferred false-rationale is cleared and fails nothing", () => {
  const record = lookup([entry("survived", 0, { disposition: "defer", reason: "false-rationale", issue: 5 })]);
  assert.deepEqual(derive({ record }), {
    closed_own_ticket: "yes", minted_false_claim: "no",
    note: `review ${RUN_1} at 1111111, record ${RECORD_FILE}: cleared: survived[0] false-rationale`,
  });
});

test("deriveRuling: a dimension that never ran does not stop the Ruling, and the note names it", () => {
  const r = derive({
    dimensionsUnrun: [{ dimension: "tests", reason: "crashed" }, "docs"],
    record: lookup([chargedNone("survived", 0, "defect-outside-acceptance")]),
  });
  assert.equal(r.note, `review ${RUN_1} at 1111111, record ${RECORD_FILE}: none: survived[0] defect-outside-acceptance; unrun: tests, docs`);
});

test("deriveRuling: a record that cannot be read is {missing} with the lookup's own wording", () => {
  const problem = `${join("/nowhere", "dispositions-fix-pr-20-b.json")} is not valid JSON: Unexpected token`;
  assert.deepEqual(derive({ record: () => ({ missing: problem }) }), { missing: problem });
});

test("deriveRuling: a record entry the Ruling cannot read is {missing}, naming the record's path", () => {
  const record = lookup([chargedNone("survived", 0, "defect-outside-acceptance"), null]);
  assert.deepEqual(derive({ record }), { missing: `${RECORD_PATH} has an entry a Ruling cannot read: entries[1] is not an object` });
});

test("deriveRuling: a survived finding added to the review after it ran is ruled like any other", () => {
  const survived = [finding("the claim"), finding("added later")];
  assert.deepEqual(derive({ survived, record: lookup([chargedNone("survived", 0, "defect-outside-acceptance"), charged("survived", 1, "unmet")]) }), {
    closed_own_ticket: "no", minted_false_claim: "no",
    note: `review ${RUN_1} at 1111111, record ${RECORD_FILE}: survived[1] unmet "added later"; none: survived[0] defect-outside-acceptance`,
  });
  assert.deepEqual(derive({ survived, record: lookup([chargedNone("survived", 0, "defect-outside-acceptance")]) }), {
    missing: `${RECORD_PATH} carries no Charge on this standing finding: survived[1] "added later"`,
  });
});

test("deriveRuling: a review with no survived and no unverified finding passes and never consults the record", () => {
  const record = lookup([charged("refuted", 0, "both")]);
  assert.deepEqual(derive({ survived: [], refuted: [finding("x")], record }), {
    closed_own_ticket: "yes", minted_false_claim: "no",
    note: `review ${RUN_1} at 1111111, no record: counted no survived and no unverified finding`,
  });
  assert.equal(record.calls, 0);
});

test("deriveRuling: a review whose only finding is unverified consults the record, and nothing stands", () => {
  const record = lookup([entry("unverified", 0, { disposition: "defer" })]);
  assert.deepEqual(derive({ survived: [], unverified: [finding("suggestion")], record }), {
    closed_own_ticket: "yes", minted_false_claim: "no",
    note: `review ${RUN_1} at 1111111, record ${RECORD_FILE}: no finding stands`,
  });
  assert.equal(record.calls, 1);
});

// ---------------------------------------------------------------------------
// append: verdicts given by hand, for a merged PR only
// ---------------------------------------------------------------------------

const BY_HAND = ["--closed-own-ticket", "no", "--minted-false-claim", "yes", "--note", "backfill: ruled from the merged PR's review"];

test("append: verdicts given by hand are written as given for a merged PR, with --note as the whole note", (t) => {
  const f = fixture(t);
  const r = f.run("append", "20", ...BY_HAND, "--scratch", f.scratch);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(verdicts(f), { closed: "no", minted: "yes", note: "backfill: ruled from the merged PR's review" });
  assert.deepEqual(f.ghCalls(), ["pr view 20 --json state", "pr view 20 --json closingIssuesReferences,url"]);
});

test("append: --minted-false-claim yes is refused on an open PR, naming the record as the next step", (t) => {
  const f = fixture(t, { state: "OPEN" });
  const before = readFileSync(f.tier, "utf8");
  const r = f.run("append", "20", ...BY_HAND, "--scratch", f.scratch);
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /PR #20 is open, and verdicts are given by hand only for a merged PR/);
  assert.match(r.stderr, /check the record again/);
  assert.match(r.stderr, /dispatch the fix-applier again as a dispositions retry/);
  assert.doesNotMatch(r.stderr, /append 20 --closed-own-ticket/);
  assert.equal(readFileSync(f.tier, "utf8"), before);
});

test("append: --minted-false-claim yes is refused on a PR closed without merging", (t) => {
  const f = fixture(t, { state: "CLOSED" });
  const before = readFileSync(f.tier, "utf8");
  const r = f.run("append", "20", ...BY_HAND, "--scratch", f.scratch);
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /PR #20 is closed without merging, and verdicts are given by hand only for a merged PR/);
  assert.equal(readFileSync(f.tier, "utf8"), before);
});

test("append: a hand-given pass is refused on an open PR too — the refusal is for the verdicts, not for yes", (t) => {
  const f = fixture(t, { state: "OPEN" });
  const r = f.run("append", "20", "--closed-own-ticket", "yes", "--minted-false-claim", "no", "--note", "n", "--scratch", f.scratch);
  assert.equal(r.code, 2, r.stderr);
  assert.equal(f.dataRows().length, 0);
});

test("append: hand-given verdicts need a --note, and both verdict flags together", (t) => {
  const f = fixture(t);
  const bare = f.run("append", "20", "--closed-own-ticket", "yes", "--minted-false-claim", "no", "--scratch", f.scratch);
  assert.equal(bare.code, 2, bare.stderr);
  assert.match(bare.stderr, /verdicts given by hand need --note/);
  const one = f.run("append", "20", "--minted-false-claim", "yes", "--note", "n", "--scratch", f.scratch);
  assert.equal(one.code, 2, one.stderr);
  assert.match(one.stderr, /--minted-false-claim comes with --closed-own-ticket or not at all/);
  assert.equal(f.dataRows().length, 0);
  assert.deepEqual(f.ghCalls(), [], "refused before gh was asked");
});

test("append: hand-given verdicts are refused when gh cannot say whether the PR merged", (t) => {
  const f = fixture(t);
  writeExecStub(join(f.bin, "gh"), "#!/bin/sh\necho 'HTTP 502' >&2\nexit 1\n");
  const r = f.run("append", "20", ...BY_HAND, "--scratch", f.scratch);
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /could not read PR #20's state/);
  assert.equal(f.dataRows().length, 0);
});

test("append: a PR that already has a row gets nothing written and nothing asked, by either mode", (t) => {
  const f = fixture(t, { state: "OPEN", tierRows: [tierRow({ pr: 20, ticket: 10, tier: "default" })] });
  const before = readFileSync(f.tier, "utf8");
  for (const args of [[], BY_HAND]) {
    const r = f.run("append", "20", ...args, "--scratch", f.scratch);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /PR #20 already has a row/);
  }
  assert.equal(readFileSync(f.tier, "utf8"), before);
  assert.deepEqual(f.ghCalls(), []);
});

// ---------------------------------------------------------------------------
// isDerivedNote: which notes `append` derives
// ---------------------------------------------------------------------------

test("isDerivedNote: both note forms deriveRuling writes are derived, with or without unrun dimensions", () => {
  const record = derive({ record: lookup([charged("survived", 0, "false-claim")]) }).note;
  const noRecord = derive({ survived: [], record: lookup([]) }).note;
  const unrun = derive({ survived: [], record: lookup([]), dimensionsUnrun: ["tests"] }).note;
  assert.match(record, /^review \S+ at 1111111, record /);
  assert.match(noRecord, /^review \S+ at 1111111, no record: /);
  for (const note of [record, noRecord, unrun]) assert.equal(isDerivedNote(note), true, note);
});

test("isDerivedNote: a derived note followed by --note's text is still derived", () => {
  const note = derive({ survived: [], record: lookup([]) }).note;
  assert.equal(isDerivedNote(`${note} — also seen by hand`), true);
});

test("isDerivedNote: a note typed by hand, blank, missing or merely resembling the opening is not derived", () => {
  for (const note of [
    "backfill: ruled from the merged PR's review", "n", "", null, undefined,
    `review ${RUN_1} at 1111111`, `review ${RUN_1} at 1111111, by hand`, `review ${RUN_1} at 111, no record: x`,
    `see review ${RUN_1} at 1111111, no record: x`, `review ${RUN_1} at 1111111, record : x`,
  ]) assert.equal(isDerivedNote(note), false, String(note));
});

test("isDerivedNote: the note append writes for a derived Ruling is derived, and for verdicts given by hand is not", (t) => {
  const derived = oneReview(t, { entries: [chargedNone("survived", 0, "defect-outside-acceptance")] });
  assert.equal(derived.derive().code, 0);
  assert.equal(isDerivedNote(verdicts(derived).note), true);
  const withNote = oneReview(t, { entries: [chargedNone("survived", 0, "defect-outside-acceptance")] });
  assert.equal(withNote.derive("--note", "also seen by hand").code, 0);
  assert.equal(isDerivedNote(verdicts(withNote).note), true);
  const byHand = fixture(t);
  assert.equal(byHand.run("append", "20", ...BY_HAND, "--scratch", byHand.scratch).code, 0);
  assert.equal(isDerivedNote(verdicts(byHand).note), false);
});
