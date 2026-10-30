import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./support/temp-dir.mjs";
import { writeExecStub } from "./support/exec-stub.mjs";
import { computeCellEvidence } from "../plugin/scripts/compute-cell-evidence.mjs";
import { costGuardFault, readCostGuard } from "../plugin/scripts/fleet-tick.mjs";
import { parseGuard, readGuard } from "../plugin/scripts/ticket-router.mjs";
import {
  MAIN_METRICS_EVERY_MS, carryMainMetrics, readCheckoutTable, readCloseoutPr, readGuardJson, readMainMetrics,
} from "../plugin/scripts/board-gather.mjs";
import { CLOSEOUT_RECEIPT } from "../plugin/scripts/ledger-grammar.mjs";

// The Cell evidence tab's alerts (records not on main, merged with no Ruling,
// guard readers disagree), the checks that cannot run and are never alerts, and
// the reads that feed them.

const SHIPPED = JSON.parse(readFileSync(new URL("../plugin/scripts/router-table.json", import.meta.url), "utf8"));
const INSTALL = { name: "@feigi/fleet-ctl", version: "3.104.0", repository: "git+https://github.com/feigi/fleet-plugin.git", error: null };
const HERE = "https://github.com/feigi/fleet-plugin";
const AGENTS = { list: [], error: null };
const TIER = "docs/metrics/tier-outcomes.tsv";
const MEMBERS = "docs/metrics/member-outcomes.tsv";
const GUARD_TIER = "9df10b12aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MAIN_TIER = "84123e74bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const MEMBERS_ID = "e08ea9cdcccccccccccccccccccccccccccccccc";
const COMPUTED = "2026-10-26T19:17:33.000Z";

const entry = (cell, o = {}) => ({
  cell, generation: "claude-opus-5", n: 69, n_merged: 69, n_claims: 69, n_failed: 8, fail_rate: 0.1159, mean_usd: 14.9,
  by_hand: 56, no_ruling: 0, pending: 0, left_out: 0, unpriced: 0, untimed: 0, excluded: 0, older: [], ...o,
});
const guardJson = (o = {}) => ({
  computed_at: COMPUTED, window_start: "2026-10-03", min_n: 20, trip_points: 15, verdict: "ok", tripped: [], retire: false,
  baseline: { cell: "slow-high", generation: "claude-opus-5", n: 69, mean_usd: 14.9, fail_rate: 0.1159 },
  cells: [entry("slow-high"), entry("task-high", { generation: "claude-sonnet-5-5" })],
  tsv_blobs: { [MEMBERS]: MEMBERS_ID, [TIER]: GUARD_TIER }, ...o,
});
const accepted = (json) => ({ status: "ok", guard: json });
const read = (blobs, extra = {}) => ({ value: { blobs }, readAt: Date.UTC(2026, 9, 30, 8, 0), error: null, ...extra });
const MAIN = () => read({ [MEMBERS]: MEMBERS_ID, [TIER]: MAIN_TIER, "docs/metrics/pricing.json": "ffffffff" });
const ROLES = { value: { slow: "anthropic/claude-opus-5:high", task: "anthropic/claude-sonnet-5-5:high", smol: "anthropic/claude-haiku-5-5:auto" }, readAt: Date.UTC(2026, 9, 30, 8, 0), error: null };
const build = (o = {}) => {
  const json = o.guardJson ?? guardJson();
  return computeCellEvidence({
    guard: accepted(json), guardJson: json, receipts: { phase0: null, closeout: null }, agents: AGENTS, modelRoles: ROLES, table: SHIPPED, install: INSTALL, repoUrl: HERE,
    mainMetrics: MAIN(), openPrs: { numbers: [], capped: false }, ...o,
  });
};
const ids = (ce) => ce.alerts.map((a) => a.id);

// -- records not on main -------------------------------------------------------

test("today's records: the guard read tier-outcomes at one blob, main holds another, no receipt PR is open: the third state, with both ids", () => {
  const ce = build();
  assert.deepEqual(ids(ce), ["records-not-on-main"]);
  const [a] = ce.alerts;
  assert.equal(a.headline, "Records not on main");
  assert.equal(a.sentence, "main's records changed after 2026-10-26 19:17Z; the next phase 0 recomputes");
  assert.deepEqual(a.lines, [`${TIER}: the guard read 9df10b12; main holds 84123e74`]);
  assert.deepEqual(ce.guard.notes, [], "an alert is not also a heading note");
});

test("the receipt's PR is open and the guard was computed at or before its commit step: counts the rows of the open PR, not on main yet", () => {
  const closeoutPr = { number: 4021, at: "2026-10-26T19:18:00.000Z" };
  const at = (n) => build({ closeoutPr, openPrs: { numbers: [n], capped: false } });
  assert.equal(at(4021).alerts[0].sentence, "the guard counts the rows of open PR #4021, not on main yet");
  const equal = build({ closeoutPr: { number: 4021, at: COMPUTED }, openPrs: { numbers: [4021], capped: false } });
  assert.equal(equal.alerts[0].sentence, "the guard counts the rows of open PR #4021, not on main yet", "at the commit step counts as before it");
  assert.equal(at(4021).alerts[0].lines.length, 1, "the ids show under the headline in this state too");
});

test("the receipt's PR is open and the guard was computed after its commit step: lacks the rows of the open PR", () => {
  const ce = build({ closeoutPr: { number: 4021, at: "2026-10-26T19:17:32.000Z" }, openPrs: { numbers: [4021], capped: false } });
  assert.equal(ce.alerts[0].sentence, "the guard lacks the rows of open PR #4021");
});

test("a receipt PR that is no longer open is the third state; the receipt's PR being another open PR changes nothing", () => {
  const merged = build({ closeoutPr: { number: 4021, at: COMPUTED }, openPrs: { numbers: [7, 8], capped: false } });
  assert.match(merged.alerts[0].sentence, /^main's records changed after /);
  const none = build({ closeoutPr: null, openPrs: { numbers: [4021], capped: false } });
  assert.match(none.alerts[0].sentence, /^main's records changed after /, "no receipt: no PR to be open");
});

test("the alert clears when the guard's ids match main's, and when main moves under them", () => {
  const same = build({ mainMetrics: read({ [MEMBERS]: MEMBERS_ID, [TIER]: GUARD_TIER }) });
  assert.deepEqual(ids(same), []);
  assert.equal(same.guard.notes.length, 0, "no known gap shows no mark");
  const extra = build({ mainMetrics: read({ [MEMBERS]: MEMBERS_ID, [TIER]: GUARD_TIER, "docs/metrics/pricing.json": "ffffffff", "docs/metrics/x.tsv": "1" }) });
  assert.deepEqual(ids(extra), [], "a file the guard did not read is not compared");
});
test("the Preview fit's ids are compared too: the fit alone behind main raises the alert and names the fit", () => {
  const preview = { status: "ok", preview: { computed_at: "2026-10-26T19:17:40.000Z", guard_computed_at: COMPUTED, tsv_blobs: { [MEMBERS]: MEMBERS_ID, [TIER]: "0123456789abcdef0123456789abcdef01234567" }, prior: {}, table: SHIPPED } };
  const ce = build({ preview, mainMetrics: read({ [MEMBERS]: MEMBERS_ID, [TIER]: GUARD_TIER }), closeoutPr: { number: 9, at: "2026-10-26T19:18:00.000Z" }, openPrs: { numbers: [9], capped: false } });
  assert.equal(ce.alerts[0].sentence, "the Preview fit counts the rows of open PR #9, not on main yet");
  assert.deepEqual(ce.alerts[0].lines, [`${TIER}: the guard read 9df10b12, the Preview fit read 01234567; main holds 9df10b12`]);
  const both = build({ preview: { ...preview, preview: { ...preview.preview, tsv_blobs: { [MEMBERS]: MEMBERS_ID, [TIER]: GUARD_TIER } } } });
  assert.deepEqual(both.alerts[0].lines, [`${TIER}: the guard and the Preview fit read 9df10b12; main holds 84123e74`]);
  assert.match(both.alerts[0].sentence, /^main's records changed after /);
});

test("a file main lacks is a difference: main holds none", () => {
  const ce = build({ mainMetrics: read({ [MEMBERS]: MEMBERS_ID }) });
  assert.deepEqual(ce.alerts[0].lines, [`${TIER}: the guard read 9df10b12; main holds none`]);
});

test("an offline cockpit raises no alert: a failed read is 'not checked' in the guard section's heading, with why and when it last succeeded", () => {
  const failed = build({ mainMetrics: read({ [MEMBERS]: MEMBERS_ID, [TIER]: MAIN_TIER }, { error: { at: Date.UTC(2026, 9, 30, 9, 0), message: "gh api --hostname github.com repos/feigi/fleet-plugin/contents/docs/metrics failed (exit 1)" } }) });
  assert.deepEqual(ids(failed), [], "the carried value does not stand in for the read that failed");
  assert.deepEqual(failed.guard.notes, ["records against main: not checked: gh api --hostname github.com repos/feigi/fleet-plugin/contents/docs/metrics failed (exit 1); last succeeded 2026-10-30 08:00Z"]);
  const never = build({ mainMetrics: { value: null, readAt: null, error: { at: 1, message: "boom" } } });
  assert.deepEqual(ids(never), []);
  assert.deepEqual(never.guard.notes, ["records against main: not checked: boom; last succeeded never"]);
  const unread = build({ mainMetrics: { value: null, readAt: null, error: null } });
  assert.deepEqual([ids(unread), unread.guard.notes], [[], ["records against main: not checked: main's docs/metrics not read yet"]]);
});

test("a 404 from the named host reads 'main holds no metrics yet', and is no alert", () => {
  const ce = build({ mainMetrics: read(null) });
  assert.deepEqual(ids(ce), []);
  assert.deepEqual(ce.guard.notes, ["records against main: main holds no metrics yet"]);
});

test("the receipt's PR cannot be told open from a cut-short list: not checked, no alert", () => {
  const ce = build({ closeoutPr: { number: 4021, at: COMPUTED }, openPrs: { numbers: [7], capped: true } });
  assert.deepEqual(ids(ce), []);
  assert.match(ce.guard.notes[0], /^records against main: not checked: the close-out's PR #4021 is not among the open PRs read/);
  const listed = build({ closeoutPr: { number: 4021, at: COMPUTED }, openPrs: { numbers: [4021], capped: true } });
  assert.deepEqual(ids(listed), ["records-not-on-main"], "found in the list: open, whatever its length");
  const timeless = build({ closeoutPr: { number: 4021, at: null }, openPrs: { numbers: [4021], capped: false } });
  assert.deepEqual(ids(timeless), []);
  assert.match(timeless.guard.notes[0], /records no time for PR #4021's commit step/);
});

test("a guard that predates the blob ids has nothing to compare: 'not checked', no alert; a cockpit that read nothing says nothing", () => {
  const { tsv_blobs, ...old } = guardJson();
  const ce = build({ guardJson: old });
  assert.deepEqual(ids(ce), []);
  assert.deepEqual(ce.guard.notes.filter((n) => /^records/.test(n)), ["records against main: not checked: this guard predates the blob ids it needs"]);
  const silent = build({ mainMetrics: null });
  assert.deepEqual([ids(silent), silent.guard.notes], [[], []]);
});

test("no cost guard: nothing to compare, nothing alerts", () => {
  const ce = computeCellEvidence({ guard: { status: "missing" }, guardJson: null, receipts: { phase0: null, closeout: null }, agents: AGENTS, mainMetrics: MAIN() });
  assert.deepEqual(ce.alerts, []);
});

// -- merged with no Ruling -----------------------------------------------------

test("merged with no Ruling names each Cell and its count, and clears at zero", () => {
  const cells = [entry("slow-high"), entry("task-high", { generation: "claude-sonnet-5-5", no_ruling: 2 }), entry("smol-high", { generation: "claude-haiku-5-5", no_ruling: 1 })];
  const ce = build({ guardJson: guardJson({ cells }), mainMetrics: read({ [MEMBERS]: MEMBERS_ID, [TIER]: GUARD_TIER }) });
  assert.deepEqual(ce.alerts, [{
    id: "merged-with-no-ruling",
    headline: "Merged with no Ruling: task-high 2, smol-high 1",
    sentence: "each counts as not merged, so n reads low and $ per merged PR high",
    lines: [],
  }]);
  assert.deepEqual(ids(build({ mainMetrics: read({ [MEMBERS]: MEMBERS_ID, [TIER]: GUARD_TIER }) })), [], "today's count is 0 in every Cell");
  const absent = build({ guardJson: guardJson({ cells: [{ ...entry("slow-high"), no_ruling: undefined }] }), mainMetrics: null });
  assert.deepEqual(ids(absent), [], "a guard that predates the count is not 0 and not an alert");
});

// -- guard readers -------------------------------------------------------------

test("the Router's reader accepts and the tick's refuses: the alert names the accepting reader and why the other refuses", () => {
  const { verdict, ...noVerdict } = guardJson();
  assert.notEqual(readGuard(noVerdict), null);
  assert.equal(readCostGuard(null).status, "missing");
  const ce = computeCellEvidence({ guard: { status: "unreadable", why: "not a guard verdict" }, guardJson: noVerdict, receipts: { phase0: null, closeout: null }, agents: AGENTS });
  assert.deepEqual(ce.alerts, [{
    id: "guard-readers-disagree",
    headline: "Guard readers disagree",
    sentence: "the Router's reader (readGuard) accepts the guard and the tick's (readCostGuard) refuses it: `verdict` is not ok, tripped or none",
    lines: [],
  }]);
});

test("the tick's reader accepts and the Router's refuses: the reverse", () => {
  const odd = guardJson({ verdict: "tripped", tripped: ["weird"], cells: [entry("slow-high"), entry("weird")] });
  assert.equal(costGuardFault(odd), null);
  assert.equal(readGuard(odd), null);
  const ce = build({ guardJson: odd, mainMetrics: null });
  assert.equal(ce.alerts[0].sentence, "the tick's reader (readCostGuard) accepts the guard and the Router's (readGuard) refuses it: `tripped` names \"weird\", which is not a Cell");
  const nan = guardJson({ cells: [entry("slow-high", { n: 1.5 })] });
  assert.equal(parseGuard(nan).why, undefined, "a fractional n is finite: the Router's reader takes it");
  assert.notEqual(costGuardFault(nan), null, "and the tick's reader does not");
});

test("readers that agree raise nothing, whether they both accept or both refuse, and a file that is not there is no disagreement", () => {
  assert.deepEqual(ids(build({ mainMetrics: null })), []);
  for (const bad of [null, "x", 5, [], { verdict: "ok" }]) {
    const ce = computeCellEvidence({ guard: { status: "unreadable", why: "not a guard verdict" }, guardJson: bad, receipts: { phase0: null, closeout: null }, agents: AGENTS });
    assert.deepEqual(ce.alerts, [], JSON.stringify(bad));
  }
});

test("each reader's reason for refusing is the reader's own rule: every fault it names is one the reader acts on", () => {
  const cases = [
    [(g) => ({ ...g, computed_at: 5 }), "`computed_at` is not a string"],
    [(g) => ({ ...g, baseline: { cell: "slow-high", n: "1" } }), /^`baseline` is not a Cell entry/],
    [(g) => ({ ...g, cells: "x" }), "`cells` is not a list"],
    [(g) => ({ ...g, cells: [{ cell: "slow-high", n: 1, mean_usd: "3", fail_rate: null }] }), /^a `cells` entry is not/],
    [(g) => ({ ...g, min_n: "20" }), "`min_n` is not an integer"],
    [(g) => ({ ...g, tripped: "x" }), "`tripped` is not a list of Cell names"],
    [(g) => ({ ...g, verdict: "tripped" }), "`verdict` and `tripped` disagree"],
    [(g) => ({ ...g, verdict: "tripped", tripped: ["smol-high"] }), "`tripped` names a Cell that `cells` does not report"],
    [(g) => ({ ...g, retire: "yes" }), "`retire` is not a boolean"],
  ];
  for (const [mutate, why] of cases) {
    const fault = costGuardFault(mutate(guardJson()));
    assert.ok(typeof why === "string" ? fault === why : why.test(fault), `${fault}`);
  }
  assert.equal(costGuardFault(guardJson()), null);
  assert.deepEqual(parseGuard(null), { why: "not a JSON object" });
  assert.deepEqual(parseGuard({ tripped: [], cells: "x" }), { why: "`cells` is not a list" });
  assert.deepEqual(parseGuard({ tripped: "x", cells: [] }), { why: "`tripped` is not a list" });
  assert.deepEqual(parseGuard({ tripped: [], cells: [{ cell: "slow-high" }] }), { why: "a `cells` entry has no string `cell` or no finite `n`" });
  assert.deepEqual(parseGuard({ tripped: [{ cell: "slow-high" }, "slow-high"], cells: [{ cell: "slow-high", n: 1 }] }).guard, { tripped: ["slow-high"], n: { "slow-high": 1 }, window_start: null });
});

// -- the alert list -------------------------------------------------------------

test("every alert holds at once: three, in the order records, no Ruling, readers", () => {
  const cells = [entry("slow-high", { no_ruling: 1 })];
  const odd = guardJson({ cells, verdict: "tripped", tripped: ["weird"] });
  odd.cells.push(entry("weird"));
  const ce = build({ guardJson: odd });
  assert.deepEqual(ids(ce), ["records-not-on-main", "merged-with-no-ruling", "guard-readers-disagree"]);
});

// -- installed table behind main's ----------------------------------------------

const fitted = (o = {}) => ({ ...SHIPPED, fitted_commit: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d", n_rows: 198, ...o });
const routesNow = (ce) => ce.policy.sides[0];

test("this repository only: the checkout's table fitted where the installed one is not reads 'main's table is fitted at X on N Pulls; this install routes by Y until the plugin is updated'", () => {
  const behind = build({ mainMetrics: null, checkoutTable: { status: "ok", table: fitted() } });
  assert.deepEqual(routesNow(behind).labels, ["main's table is fitted at 1a2b3c4 on 198 Pulls; this install routes by a table never fitted until the plugin is updated"]);
  const older = build({ mainMetrics: null, table: fitted({ fitted_commit: "9999999aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", n_rows: 150 }), checkoutTable: { status: "ok", table: fitted() } });
  assert.deepEqual(routesNow(older).labels, ["main's table is fitted at 1a2b3c4 on 198 Pulls; this install routes by 9999999 until the plugin is updated"]);
  const rows = build({ mainMetrics: null, table: fitted(), checkoutTable: { status: "ok", table: fitted({ n_rows: 199 }) } });
  assert.equal(routesNow(rows).labels.length, 1, "the same commit on another count of Pulls differs");
});

test("the label clears when the install catches up, and today (both never fitted) there is none", () => {
  assert.deepEqual(routesNow(build({ mainMetrics: null, table: fitted(), checkoutTable: { status: "ok", table: fitted() } })).labels, []);
  assert.deepEqual(routesNow(build({ mainMetrics: null, checkoutTable: { status: "ok", table: SHIPPED } })).labels, []);
  assert.equal(ids(build({ mainMetrics: null, checkoutTable: { status: "ok", table: fitted() } })).length, 0, "a label is not an alert");
});

test("a consumer, whose install names another repository, is never compared, whatever its checkout holds", () => {
  const ce = build({ mainMetrics: null, repoUrl: "https://ghe.example.com/acme/widgets", checkoutTable: { status: "ok", table: fitted() } });
  assert.deepEqual(routesNow(ce).labels, []);
  assert.equal(routesNow(ce).source.check, null);
  const gone = build({ mainMetrics: null, repoUrl: "https://ghe.example.com/acme/widgets", checkoutTable: { status: "missing" } });
  assert.equal(routesNow(gone).source.check, null, "no table in a consumer's checkout is not a gap");
});

test("this repository with a checkout table that cannot be compared says 'not checked'", () => {
  assert.equal(routesNow(build({ mainMetrics: null, checkoutTable: { status: "missing" } })).source.check, "not checked: this checkout holds no plugin/scripts/router-table.json");
  assert.equal(routesNow(build({ mainMetrics: null, checkoutTable: { status: "unreadable", why: "not JSON" } })).source.check, "not checked: this checkout's router table was not read: not JSON");
  assert.equal(routesNow(build({ mainMetrics: null, checkoutTable: null })).source.check, null, "nothing read, nothing said");
});

// -- gather's reads ----------------------------------------------------------------

test("readGuardJson: the guard as parsed, null when missing or unparseable", () => {
  const dir = tempDir("alerts-guard-");
  assert.equal(readGuardJson(dir), null);
  writeFileSync(join(dir, "cost-guard.json"), "{");
  assert.equal(readGuardJson(dir), null);
  writeFileSync(join(dir, "cost-guard.json"), JSON.stringify(guardJson()));
  assert.deepEqual(readGuardJson(dir), guardJson());
});

test("readCloseoutPr: the number off `gh pr create`'s url and the commit step's time; null for no PR", () => {
  const dir = tempDir("alerts-closeout-");
  assert.equal(readCloseoutPr(dir), null);
  const write = (o) => writeFileSync(join(dir, CLOSEOUT_RECEIPT), JSON.stringify({ reason: "x", branch: "b", steps: { "commit-and-pr": { status: "ok", at: "2026-10-26T19:18:00.000Z", output: "" } }, ...o }));
  write({ pr: "https://github.com/feigi/fleet-plugin/pull/4021" });
  assert.deepEqual(readCloseoutPr(dir), { number: 4021, at: "2026-10-26T19:18:00.000Z" });
  write({ pr: "#7\n" });
  assert.equal(readCloseoutPr(dir).number, 7);
  write({ pr: null });
  assert.equal(readCloseoutPr(dir), null);
  write({ pr: "no pull request here" });
  assert.equal(readCloseoutPr(dir), null);
  write({ pr: "https://github.com/feigi/fleet-plugin/pull/9", steps: {} });
  assert.deepEqual(readCloseoutPr(dir), { number: 9, at: null });
  writeFileSync(join(dir, CLOSEOUT_RECEIPT), "{");
  assert.equal(readCloseoutPr(dir), null);
});

test("readCheckoutTable: the table under the workspace, missing for a checkout with none, unreadable for one that is refused", () => {
  const root = tempDir("alerts-checkout-");
  const stateDir = join(root, ".fleet");
  mkdirSync(stateDir);
  assert.deepEqual(readCheckoutTable(stateDir), { status: "missing" });
  mkdirSync(join(root, "plugin", "scripts"), { recursive: true });
  const file = join(root, "plugin", "scripts", "router-table.json");
  writeFileSync(file, JSON.stringify(SHIPPED));
  const ok = readCheckoutTable(stateDir);
  assert.equal(ok.status, "ok");
  assert.equal(ok.table.n_rows, SHIPPED.n_rows);
  writeFileSync(file, "{");
  assert.deepEqual(readCheckoutTable(stateDir), { status: "unreadable", why: "not JSON" });
  writeFileSync(file, JSON.stringify({ ...SHIPPED, stage: "x" }));
  assert.equal(readCheckoutTable(stateDir).status, "unreadable");
});

// A `gh` that records its argv and answers as the body says; `say` swaps the body.
function withGh(t, body) {
  const bin = tempDir("alerts-gh-");
  const calls = join(bin, "calls");
  const say = (b) => writeExecStub(join(bin, "gh"), `#!/bin/sh\necho "$*" >> "${calls}"\n${b}\n`);
  say(body);
  const saved = process.env.PATH;
  t.after(() => { process.env.PATH = saved; });
  process.env.PATH = `${bin}:${saved}`;
  return { say, calls: () => { try { return readFileSync(calls, "utf8").split("\n").filter(Boolean); } catch { return []; } } };
}
const quiet = async (fn) => {
  const write = process.stderr.write;
  process.stderr.write = () => true;
  try { return await fn(); } finally { process.stderr.write = write; }
};
const LISTING = [
  { name: "tier-outcomes.tsv", path: TIER, sha: MAIN_TIER, type: "file" },
  { name: "sub", path: "docs/metrics/sub", sha: "dddd", type: "dir" },
  { name: "pricing.json", path: "docs/metrics/pricing.json", sha: "ffff", type: "file" },
];

test("readMainMetrics: asks the named host for the repository's own docs/metrics, never through the {owner}/{repo} placeholder", async (t) => {
  const { calls } = withGh(t, `echo '${JSON.stringify(LISTING)}'`);
  const r = await readMainMetrics({ host: "ghe.example.com", name: "acme/widgets" });
  assert.deepEqual(r, { ok: true, value: { blobs: { [TIER]: MAIN_TIER, "docs/metrics/pricing.json": "ffff" } } });
  assert.deepEqual(calls(), ["api --hostname ghe.example.com repos/acme/widgets/contents/docs/metrics"]);
  assert.ok(!calls()[0].includes("{"), "no placeholder");
});

test("readMainMetrics: a 404 from the host is main holding no metrics yet; any other failure is a failed read", async (t) => {
  const { say } = withGh(t, `echo '{"message":"Not Found","status":"404"}'; echo "gh: Not Found (HTTP 404)" >&2; exit 1`);
  assert.deepEqual(await quiet(() => readMainMetrics({ host: "ghe.example.com", name: "acme/widgets" })), { ok: true, value: { blobs: null } });
  say(`echo "error connecting to api.github.com" >&2; exit 1`);
  const down = await quiet(() => readMainMetrics({ host: "github.com", name: "feigi/fleet-plugin" }));
  assert.equal(down.ok, false);
  assert.match(down.why, /^gh api --hostname github\.com repos\/feigi\/fleet-plugin\/contents\/docs\/metrics failed \(exit 1: error connecting to api\.github\.com\)$/);
  say(`echo "not json"`);
  assert.match((await readMainMetrics({ host: "github.com", name: "a/b" })).why, /printed non-JSON$/);
  say(`echo '{"message":"x"}'`);
  assert.match((await readMainMetrics({ host: "github.com", name: "a/b" })).why, /printed no directory listing$/);
});

const NOW = Date.UTC(2026, 9, 30, 9, 0, 0);
const reader = (...answers) => {
  const calls = [];
  return { calls, read: async (id) => { calls.push(id); return answers[Math.min(calls.length, answers.length) - 1]; } };
};
const OK = { ok: true, value: { blobs: { [TIER]: MAIN_TIER } } };

test("carryMainMetrics: read at most once a minute, the host and name from repoUrl", async () => {
  const { read: spy, calls } = reader(OK);
  assert.equal(MAIN_METRICS_EVERY_MS, 60_000);
  const first = await carryMainMetrics(null, NOW, HERE, spy);
  assert.deepEqual(first, { value: OK.value, readAt: NOW, error: null });
  assert.deepEqual(calls, [{ host: "github.com", name: "feigi/fleet-plugin" }]);
  assert.deepEqual(await carryMainMetrics(first, NOW + 15_000, HERE, spy), first);
  assert.deepEqual(await carryMainMetrics(first, NOW + 59_999, HERE, spy), first);
  assert.equal(calls.length, 1, "ticks inside the minute make no call");
  await carryMainMetrics(first, NOW + 60_000, HERE, spy);
  assert.equal(calls.length, 2);
  const enterprise = reader(OK);
  await carryMainMetrics(null, NOW, "https://ghe.example.com/acme/widgets", enterprise.read);
  assert.deepEqual(enterprise.calls, [{ host: "ghe.example.com", name: "acme/widgets" }]);
});

test("carryMainMetrics: a failed read keeps the carried value, says why, and is not retried within the minute", async () => {
  const { read: spy, calls } = reader({ ok: false, why: "offline" });
  const carried = { value: OK.value, readAt: NOW, error: null };
  const failed = await carryMainMetrics(carried, NOW + 60_000, HERE, spy);
  assert.deepEqual(failed, { value: OK.value, readAt: NOW, error: { at: NOW + 60_000, message: "offline" } });
  assert.deepEqual(await carryMainMetrics(failed, NOW + 119_999, HERE, spy), failed);
  assert.equal(calls.length, 1);
  const ok = reader(OK);
  assert.deepEqual(await carryMainMetrics(failed, NOW + 120_000, HERE, ok.read), { value: OK.value, readAt: NOW + 120_000, error: null });
});

test("carryMainMetrics: a repository the cockpit cannot name is a failed read with no call; a 404 is carried like any answer", async () => {
  for (const url of [null, undefined, "", "not a url"]) {
    const { read: spy, calls } = reader(OK);
    const r = await carryMainMetrics(null, NOW, url, spy);
    assert.deepEqual(r, { value: null, readAt: null, error: { at: NOW, message: "this workspace's repository is not known" } }, String(url));
    assert.equal(calls.length, 0, `${url}: no call, so none through a placeholder`);
  }
  const none = reader({ ok: true, value: { blobs: null } });
  const first = await carryMainMetrics(null, NOW, HERE, none.read);
  assert.deepEqual(first.value, { blobs: null });
  assert.deepEqual(await carryMainMetrics(first, NOW + 1000, HERE, none.read), first);
});

test("carryMainMetrics: a carried value that is not a read is ignored, not trusted", async () => {
  for (const bad of [undefined, null, 5, "x", [], { value: "x", readAt: NOW, error: null }, { value: {}, readAt: NOW, error: null },
    { value: { blobs: "x" }, readAt: NOW, error: null }, { value: { blobs: { a: 1 } }, readAt: NOW, error: null }, { value: OK.value, readAt: String(NOW), error: null }]) {
    const { read: spy, calls } = reader(OK);
    assert.deepEqual(await carryMainMetrics(bad, NOW + 1000, HERE, spy), { value: OK.value, readAt: NOW + 1000, error: null }, JSON.stringify(bad));
    assert.equal(calls.length, 1, JSON.stringify(bad));
  }
});
