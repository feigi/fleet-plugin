import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./support/temp-dir.mjs";
import { writeExecStub } from "./support/exec-stub.mjs";
import {
  MODEL_ROLES_EVERY_MS, MODEL_ROLES_TIMEOUT_MS, carryModelRoles, gather, readAgents, readGuardFile, readMetricsStep, readModelRoles,
  readHeldImplementers, readInstall, readObjective, readRouterTable, receiptSpendDir,
} from "../plugin/scripts/board-gather.mjs";
import { CLOSEOUT_RECEIPT, RECEIPT, RECEIPT_HELD, formatRouting } from "../plugin/scripts/ledger-grammar.mjs";
import { computeBoard } from "../plugin/scripts/compute-board.mjs";
import { identityRoles, seededRepo } from "./support/label-map-seed.mjs";

// What gather() reads for the Cell evidence tab: the guard through the tick's
// reader, the receipts' `metrics` steps, the installed definitions and `modelRoles`,
// which is read at most once a minute and carried in board.json.

const ROLES = { slow: "anthropic/claude-opus-5:high", task: "anthropic/claude-sonnet-5-5:high", smol: "anthropic/claude-haiku-5-5:auto" };

// -- carryModelRoles: at most one read a minute ------------------------------------------

const reader = (...answers) => {
  const calls = [];
  const read = async () => { calls.push(1); return answers[Math.min(calls.length, answers.length) - 1]; };
  return { read, calls };
};
const NOW = Date.UTC(2026, 9, 28, 9, 0, 0);

test("modelRoles: the first read happens, and is carried as { value, readAt, error }", async () => {
  const { read, calls } = reader({ ok: true, value: ROLES });
  assert.deepEqual(await carryModelRoles(null, NOW, read), { value: ROLES, readAt: NOW, error: null });
  assert.equal(calls.length, 1);
});

test("modelRoles: read at most once a minute: a carried read under 60 s old is returned as it is", async () => {
  const { read, calls } = reader({ ok: true, value: ROLES });
  const carried = { value: ROLES, readAt: NOW, error: null };
  assert.equal(MODEL_ROLES_EVERY_MS, 60_000);
  assert.deepEqual(await carryModelRoles(carried, NOW + 15_000, read), carried);
  assert.deepEqual(await carryModelRoles(carried, NOW + 59_999, read), carried);
  assert.equal(calls.length, 0);
  // At 60 s it is read again.
  const next = await carryModelRoles(carried, NOW + 60_000, read);
  assert.equal(calls.length, 1);
  assert.equal(next.readAt, NOW + 60_000);
});

test("modelRoles: a failed read keeps the carried value, shows when it was read and why reading fails, and is not retried within the minute", async () => {
  const { read, calls } = reader({ ok: false, why: "omp config get modelRoles --json failed (ENOENT)" });
  const carried = { value: ROLES, readAt: NOW, error: null };
  const failed = await carryModelRoles(carried, NOW + 60_000, read);
  assert.deepEqual(failed, { value: ROLES, readAt: NOW, error: { at: NOW + 60_000, message: "omp config get modelRoles --json failed (ENOENT)" } });
  assert.equal(calls.length, 1);
  // Ticks inside the next minute carry the failure as it stands: one more spawn per tick in four, not one more per tick.
  assert.deepEqual(await carryModelRoles(failed, NOW + 75_000, read), failed);
  assert.deepEqual(await carryModelRoles(failed, NOW + 119_999, read), failed);
  assert.equal(calls.length, 1);
  // A later read that works clears the failure.
  const ok = reader({ ok: true, value: { slow: "x/y:high" } });
  assert.deepEqual(await carryModelRoles(failed, NOW + 120_000, ok.read), { value: { slow: "x/y:high" }, readAt: NOW + 120_000, error: null });
});

test("modelRoles: a first read that fails carries no value, and says why", async () => {
  const { read } = reader({ ok: false, why: "boom" });
  assert.deepEqual(await carryModelRoles(null, NOW, read), { value: null, readAt: null, error: { at: NOW, message: "boom" } });
});

test("modelRoles: a carried value that is not a read (a hand-edited or older board.json) is ignored, not trusted", async () => {
  for (const bad of [undefined, null, 5, "x", [], { value: "x", readAt: NOW, error: null }, { value: ROLES, readAt: "now", error: null },
    { value: ROLES, readAt: NOW, error: "boom" }, { value: ROLES, readAt: NOW, error: { at: "x", message: "m" } }, { value: ROLES, readAt: NOW, error: { at: NOW } },
    // A time held as a string that reads as a number: trusted, it would hold a fresh read off for the minute.
    { value: ROLES, readAt: String(NOW), error: null }, { value: ROLES, readAt: NOW, error: { at: String(NOW), message: "m" } }]) {
    const { read, calls } = reader({ ok: true, value: ROLES });
    assert.deepEqual(await carryModelRoles(bad, NOW + 1000, read), { value: ROLES, readAt: NOW + 1000, error: null }, JSON.stringify(bad));
    assert.equal(calls.length, 1, JSON.stringify(bad));
  }
});

test("modelRoles: a clock that went backwards does not hold the read off for good", async () => {
  const { read, calls } = reader({ ok: true, value: ROLES });
  await carryModelRoles({ value: ROLES, readAt: NOW + 3_600_000, error: null }, NOW, read);
  assert.equal(calls.length, 1);
});

// -- readModelRoles: `omp config get modelRoles --json` in the cockpit's own environment -----

async function withOmp(t, body, fn) {
  const bin = tempDir("cell-evidence-omp-");
  writeExecStub(join(bin, "omp"), `#!/bin/sh\n${body}\n`);
  const saved = process.env.PATH;
  t.after(() => { process.env.PATH = saved; });
  process.env.PATH = `${bin}:${saved}`;
  return fn(bin);
}

test("readModelRoles: asks omp for modelRoles and returns the record", async (t) => {
  await withOmp(t, `echo "$@" > "$(dirname "$0")/argv"\necho '{"key":"modelRoles","value":${JSON.stringify(ROLES)},"type":"record"}'`, async (bin) => {
    assert.deepEqual(await readModelRoles(), { ok: true, value: ROLES });
    assert.equal(readFileSync(join(bin, "argv"), "utf8").trim(), "config get modelRoles --json");
  });
});

test("readModelRoles: a failing omp, non-JSON and a record-less answer are each a failed read with their own why", async (t) => {
  await withOmp(t, "exit 3", async () => {
    const r = await readModelRoles();
    assert.equal(r.ok, false);
    assert.equal(r.why, "omp config get modelRoles --json failed (exit 3)");
  });
  await withOmp(t, "echo not json", async () => {
    assert.deepEqual(await readModelRoles(), { ok: false, why: "omp config get modelRoles --json printed non-JSON" });
  });
  for (const out of ["null", "[]", '{"value":null}', '{"value":"slow"}', "{}"]) {
    await withOmp(t, `echo '${out}'`, async () => {
      assert.deepEqual(await readModelRoles(), { ok: false, why: "omp config get modelRoles --json printed no modelRoles record" }, out);
    });
  }
  const empty = tempDir("cell-evidence-nobin-");
  const saved = process.env.PATH;
  t.after(() => { process.env.PATH = saved; });
  process.env.PATH = empty;
  const gone = await readModelRoles();
  assert.equal(gone.ok, false);
  assert.match(gone.why, /^omp config get modelRoles --json failed \(ENOENT\)$/);
});

test("readModelRoles: an omp that never answers is killed at the timeout and is a failed read, so it cannot hold the tick", async (t) => {
  assert.equal(MODEL_ROLES_TIMEOUT_MS, 10_000);
  await withOmp(t, "exec sleep 5", async () => {
    const started = Date.now();
    assert.deepEqual(await readModelRoles(200), { ok: false, why: "omp config get modelRoles --json failed (killed by SIGTERM)" });
    assert.ok(Date.now() - started < 3_000, "answered at the timeout, not when omp gave up");
  });
});

// -- the guard, the receipts and the definitions -------------------------------------------

const GUARD = {
  computed_at: "2026-10-26T19:17:33.000Z", window_start: "2026-10-03", min_n: 20, trip_points: 15, verdict: "ok", tripped: [], retire: false, tsv_blobs: {},
  baseline: { cell: "slow-high", generation: "claude-opus-5", n: 40, mean_usd: 10, fail_rate: 0.1 },
  cells: [{ cell: "slow-high", generation: "claude-opus-5", n: 40, n_merged: 40, n_claims: 40, n_failed: 4, mean_usd: 10, fail_rate: 0.1 }],
};

test("readGuardFile: figures come only from a guard the tick's reader accepts", () => {
  const dir = tempDir("cell-evidence-guard-");
  assert.deepEqual(readGuardFile(dir), { status: "missing" });
  writeFileSync(join(dir, "cost-guard.json"), JSON.stringify(GUARD));
  assert.equal(readGuardFile(dir).status, "ok");
  assert.equal(readGuardFile(dir).guard.cells[0].n_claims, 40);
  writeFileSync(join(dir, "cost-guard.json"), JSON.stringify({ ...GUARD, verdict: "tripped" }));
  assert.deepEqual(readGuardFile(dir), { status: "unreadable", why: "not a guard verdict" });
  writeFileSync(join(dir, "cost-guard.json"), "{ nope");
  assert.deepEqual(readGuardFile(dir), { status: "unreadable", why: "not JSON" });
});

const receipt = (steps) => ({ run: null, session: "/s", scratch: "/x", inFlight: 5, steps });

test("readMetricsStep: the metrics step of a receipt, or null for no receipt, an unreadable one and a step it lacks", () => {
  const dir = tempDir("cell-evidence-receipt-");
  const path = join(dir, RECEIPT);
  assert.equal(readMetricsStep(path), null, "no receipt");
  writeFileSync(path, "{ nope");
  assert.equal(readMetricsStep(path), null, "unreadable");
  writeFileSync(path, JSON.stringify(receipt({ preflight: { status: "ok", at: "2026-10-28T08:00:00.000Z", output: "x" } })));
  assert.equal(readMetricsStep(path), null, "no metrics step");
  writeFileSync(path, JSON.stringify(receipt({ metrics: { status: "failed", at: "2026-10-28T08:01:00.000Z", output: "metrics-refresh.mjs failed: exit 1" } })));
  assert.deepEqual(readMetricsStep(path), { status: "failed", at: "2026-10-28T08:01:00.000Z", output: "metrics-refresh.mjs failed: exit 1" });
});

test("readAgents: every definition's own `model:`, and a directory that cannot be listed is an error, not an empty list", () => {
  const root = tempDir("cell-evidence-agents-");
  const scripts = join(root, "scripts");
  mkdirSync(scripts);
  assert.match(readAgents(scripts).error, /agents: ENOENT$/);
  assert.deepEqual(readAgents(scripts).list, []);
  mkdirSync(join(root, "agents"));
  writeFileSync(join(root, "agents", "fleet-a.agent.md"), '---\nname: fleet-a\nmodel: "@task:high"\n---\nbody\n');
  writeFileSync(join(root, "agents", "fleet-b.agent.md"), "---\nname: fleet-b\n---\nbody\n");
  writeFileSync(join(root, "agents", "notes.md"), "not a definition");
  assert.deepEqual(readAgents(scripts), { list: [{ file: "fleet-a.agent.md", model: '"@task:high"' }, { file: "fleet-b.agent.md", model: null }].sort(() => 0), error: null });
});

// -- gather(): the whole read, and the board it makes --------------------------------------------

// A cockpit workspace in a temp repository seeded with the identity Label map:
// `.fleet/` with a guard and a phase-0 receipt, an installed `agents/` beside
// `scripts/`, and a stub `omp` that counts its spawns.
function workspace(t, { guard = GUARD, ompBody = null } = {}) {
  const root = seededRepo("cell-evidence-gather-");
  const stateDir = join(root, ".fleet");
  const scriptDir = join(root, "scripts");
  const bin = join(root, "bin");
  for (const d of [stateDir, scriptDir, join(root, "agents"), bin]) mkdirSync(d, { recursive: true });
  if (guard) writeFileSync(join(stateDir, "cost-guard.json"), JSON.stringify(guard));
  writeFileSync(join(stateDir, RECEIPT), JSON.stringify(receipt({ metrics: { status: "ok", at: "2026-10-28T08:00:00.000Z", output: "metrics-refresh: cost guard: verdict ok" } })));
  writeFileSync(join(root, "agents", "fleet-finisher.agent.md"), '---\nname: fleet-finisher\nmodel: "@slow:high"\n---\n');
  const calls = join(root, "omp-calls");
  writeExecStub(join(bin, "omp"), ompBody ?? `#!/bin/sh\necho x >> "${calls}"\necho '{"value":${JSON.stringify(ROLES)}}'\n`);
  // Every other read degrades: this is about the Cell evidence reads.
  writeExecStub(join(bin, "gh"), "#!/bin/sh\nexit 1\n");
  const saved = process.env.PATH;
  t.after(() => { process.env.PATH = saved; });
  process.env.PATH = `${bin}:${saved}`;
  const spawns = () => (existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean).length : 0);
  return { root, stateDir, scriptDir, spawns, opts: { ledgerFile: join(root, "none.md"), prevFile: join(root, "prev.json"), scriptDir, stateDir, interval: 15, spendDir: null, cwd: root } };
}

async function quiet(fn) {
  const write = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => { rest.find((a) => typeof a === "function")?.(); return true; };
  try { return await fn(); } finally { process.stderr.write = write; }
}

test("gather: reads the guard, the receipts, the definitions and modelRoles, and the board built from them draws the tab's model", async (t) => {
  const w = workspace(t);
  const r = await quiet(() => gather(w.opts));
  assert.equal(r.guard.status, "ok");
  assert.deepEqual(r.receipts, { phase0: { status: "ok", at: "2026-10-28T08:00:00.000Z", output: "metrics-refresh: cost guard: verdict ok" }, closeout: null });
  assert.deepEqual(r.agents, { list: [{ file: "fleet-finisher.agent.md", model: '"@slow:high"' }], error: null });
  assert.deepEqual(r.modelRoles, { value: ROLES, readAt: r.now, error: null });

  const board = computeBoard(r);
  assert.deepEqual(board.modelRoles, r.modelRoles, "the carried read rides board.json");
  assert.equal(board.cellEvidence.guard.heading, "trips nothing");
  assert.equal(board.cellEvidence.guard.cells.length, 5);
  assert.equal(board.cellEvidence.guard.cells[0].figures.merged.text, "40 ≥ 20 ✓");
  assert.equal(board.cellEvidence.guard.cells[0].route.text, "Tier route: anthropic/claude-opus-5 · high");
  assert.equal(board.cellEvidence.declared.heading, "Declared, not measured: 1 other member");
  JSON.stringify(board);
});

test("gather: modelRoles is read once, then carried tick to tick through board.json, not read again within the minute", async (t) => {
  const w = workspace(t);
  const first = await quiet(() => gather(w.opts));
  assert.equal(w.spawns(), 1);
  writeFileSync(w.opts.prevFile, JSON.stringify(computeBoard(first)));
  const second = await quiet(() => gather(w.opts));
  assert.equal(w.spawns(), 1, "the second tick spawned no omp");
  assert.deepEqual(second.modelRoles, first.modelRoles);
});

test("gather: a failing omp keeps the carried value and the board shows 'as read at <time>; reading fails: <why>'", async (t) => {
  const w = workspace(t);
  const first = await quiet(() => gather(w.opts));
  const aged = computeBoard(first);
  // The carried read is two minutes old, and omp now fails.
  aged.modelRoles = { ...aged.modelRoles, readAt: first.now - 120_000 };
  writeFileSync(w.opts.prevFile, JSON.stringify(aged));
  writeExecStub(join(w.root, "bin", "omp"), "#!/bin/sh\nexit 1\n");
  const second = await quiet(() => gather(w.opts));
  assert.deepEqual(second.modelRoles.value, ROLES);
  assert.equal(second.modelRoles.readAt, first.now - 120_000);
  assert.match(second.modelRoles.error.message, /^omp config get modelRoles --json failed \(exit 1\)$/);
  const cell = computeBoard(second).cellEvidence.guard.cells[0];
  assert.match(cell.route.label, /^as read at 2026-\d\d-\d\d \d\d:\d\dZ; reading fails: omp config get modelRoles --json failed \(exit 1\)$/);
  assert.equal(cell.route.text, "Tier route: anthropic/claude-opus-5 · high");
});

test("gather: with no guard on disk the board says 'no cost guard' and quotes the receipt's metrics line", async (t) => {
  const w = workspace(t, { guard: null });
  const board = computeBoard(await quiet(() => gather(w.opts)));
  assert.equal(board.cellEvidence.guard.heading, "no cost guard");
  assert.equal(board.cellEvidence.guard.state, "no-guard");
  assert.ok(board.cellEvidence.guard.notes.includes("ran at 2026-10-28 08:00Z: verdict ok"), JSON.stringify(board.cellEvidence.guard.notes));
  for (const c of board.cellEvidence.guard.cells) assert.equal(c.figures, null);
});

test("gather: a close-out receipt newer than phase 0's is the one quoted", async (t) => {
  const w = workspace(t, { guard: null });
  writeFileSync(join(w.stateDir, CLOSEOUT_RECEIPT), JSON.stringify({ reason: "x", begun: null, branch: null, pr: null,
    steps: { metrics: { status: "failed", at: "2026-10-28T12:00:00.000Z", output: "metrics-refresh.mjs failed: metrics-refresh: cost guard failed: bad row" } } }));
  const board = computeBoard(await quiet(() => gather(w.opts)));
  assert.ok(board.cellEvidence.guard.notes.includes("failed at 2026-10-28 12:00Z: bad row"), JSON.stringify(board.cellEvidence.guard.notes));
});

test("gather: a caller that names no state directory reads no guard, no receipt and spawns no omp", async (t) => {
  const w = workspace(t);
  const { stateDir, ...rest } = w.opts;
  const r = await quiet(() => gather(rest));
  assert.equal(w.spawns(), 0);
  assert.deepEqual(r.guard, { status: "missing" });
  assert.deepEqual(r.receipts, { phase0: null, closeout: null });
  assert.equal(r.modelRoles, null);
  assert.equal(computeBoard(r).cellEvidence.guard.heading, "no cost guard");
});

test("computeBoard: inputs that read none of the tab's records draw its no-guard state, not a missing field", () => {
  const board = computeBoard({ ledger: { rows: [] }, issues: [], prs: [], ci: {}, prev: null, now: 1, roles: identityRoles() });
  assert.equal(board.cellEvidence.guard.heading, "no cost guard");
  assert.equal(board.cellEvidence.guard.cells.length, 5);
  assert.equal(board.modelRoles, null);
  assert.equal(board.cellEvidence.declared.heading, "Declared, not measured: 0 other members");
});

// -- the cards' Cell lines: each implementer's dispatch record ---------------------------------

const SCRIPTS = join(import.meta.dirname, "..", "plugin", "scripts");
const SESSION = "2026-10-28T08-00-00-000Z_01a08126-ee04-7095-a695-14e3249f1127";

// An omp member transcript: its `session_init` (definition and dispatch model),
// its thinking level, and one turn on `last`.
const transcript = ({ agent, model, thinking, last = model }) => [
  { type: "session", version: 3, id: "s1", timestamp: "2026-10-28T08:00:01.000Z", cwd: "/w" },
  { type: "session_init", id: "i1", parentId: null, timestamp: "2026-10-28T08:00:02.000Z", task: "Implement ticket", agent, resolvedModelIdentity: `anthropic/${model}` },
  { type: "thinking_level_change", id: "t1", parentId: "i1", timestamp: "2026-10-28T08:00:03.000Z", thinkingLevel: thinking, configured: null },
  { type: "message", id: "m1", parentId: "t1", timestamp: "2026-10-28T08:00:04.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "ok" }], model: last, usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, cost: { total: 0.01 } } } },
].map((l) => JSON.stringify(l)).join("\n") + "\n";

// A workspace whose ledger holds a row from before the Routing, or one with the
// `## Routed` entries given, and an omp session holding its implementer's
// transcript and a reviewer's. `entry` is the implementer's `## Dispatched`
// entry. The real scripts read the ledger; every `gh` read degrades.
function cardsWorkspace(t, { routed = [], entry = "impl-3862 brief=7f685cae agent=fleet-implementer-slow-high" } = {}) {
  const root = tempDir("cell-line-gather-");
  const stateDir = join(root, ".fleet");
  const session = join(root, "sessions", SESSION);
  const bin = join(root, "bin");
  for (const d of [stateDir, session, bin]) mkdirSync(d, { recursive: true });
  writeFileSync(join(session, "impl-3862.jsonl"), transcript({ agent: "fleet-implementer-slow-high", model: "claude-opus-5", thinking: "high", last: "claude-sonnet-5" }));
  writeFileSync(join(session, "review-pr-9.jsonl"), transcript({ agent: "fleet-reviewer", model: "claude-sonnet-5", thinking: "high" }));
  const ledgerFile = join(root, "ledger.md");
  writeFileSync(ledgerFile, `# Fleet run ledger\n\n## Rows\n\n- #3862 impl-3862 · tier=slow-high · route=guard-tripped\n\n## Dispatched\n\n- ${entry}\n`
    + (routed.length ? `\n## Routed\n\n${routed.map((e) => `- ${e}`).join("\n")}\n` : ""));
  writeExecStub(join(bin, "omp"), `#!/bin/sh\necho '{"value":${JSON.stringify(ROLES)}}'\n`);
  writeExecStub(join(bin, "gh"), "#!/bin/sh\nexit 1\n");
  const saved = process.env.PATH;
  t.after(() => { process.env.PATH = saved; });
  process.env.PATH = `${bin}:${saved}`;
  return { root, stateDir, session, opts: { ledgerFile, prevFile: join(root, "prev.json"), scriptDir: SCRIPTS, stateDir, interval: 15 } };
}

const IMPL_3862 = { member: "impl-3862", model: "claude-sonnet-5", resolvedModelIdentity: "anthropic/claude-opus-5", thinking: "high", subagent_type: "fleet-implementer-slow-high" };

test("gather: keeps each implementer's dispatch-time model, thinking level and definition off the transcripts the spend reads, and the card reads them", async (t) => {
  const w = cardsWorkspace(t);
  writeFileSync(join(w.stateDir, RECEIPT), JSON.stringify({ ...receipt({}), session: w.session }));
  const r = await quiet(() => gather({ ...w.opts, spendDir: receiptSpendDir(w.stateDir) }));
  assert.deepEqual(r.implementers, [IMPL_3862], "implementers only: the reviewer's transcript is not kept");
  assert.equal(r.spend.ok, true, "the spend panel reads the same session, unchanged");
  const line = computeBoard(r).tickets.find((x) => x.issue === 3862).cellLine;
  assert.deepEqual(line.lines.map((ps) => ps.map((p) => p.sep + p.text).join("")), [
    "slow-high · recorded as guard-tripped",
    "not on record · claude-opus-5 · high · fell back to claude-sonnet-5",
  ]);
});

test("gather: between runs, with no phase0.json, the cards read the session phase0.previous.json names, and the spend panel does not", async (t) => {
  const w = cardsWorkspace(t);
  writeFileSync(join(w.stateDir, RECEIPT_HELD), JSON.stringify({ ...receipt({}), session: w.session }));
  const r = await quiet(() => gather({ ...w.opts, spendDir: receiptSpendDir(w.stateDir) }));
  assert.deepEqual(r.implementers, [IMPL_3862]);
  assert.equal(r.spend.ok, false, "the Tokens panel is unchanged by this: it still names no session");

  // While phase0.json is there, the held receipt is not read.
  writeFileSync(join(w.stateDir, RECEIPT), JSON.stringify(receipt({})));
  const live = await quiet(() => gather({ ...w.opts, spendDir: receiptSpendDir(w.stateDir) }));
  assert.deepEqual(live.implementers, []);
});

test("gather: with --spend-dir named, a held receipt is not read: the operator's directory is the one session read", async (t) => {
  const w = cardsWorkspace(t);
  writeFileSync(join(w.stateDir, RECEIPT_HELD), JSON.stringify({ ...receipt({}), session: w.session }));
  const r = await quiet(() => gather({ ...w.opts, spendDir: tempDir("cell-line-spend-dir-"), spendDirExplicit: true }));
  assert.deepEqual(r.implementers, []);
});

test("gather: the Tokens window bounds the spend alone: an implementer transcript older than --spend-since still reaches its card", async (t) => {
  const w = cardsWorkspace(t);
  writeFileSync(join(w.stateDir, RECEIPT), JSON.stringify({ ...receipt({}), session: w.session }));
  const r = await quiet(() => gather({ ...w.opts, spendDir: receiptSpendDir(w.stateDir), spendSince: Date.now() + 3_600_000 }));
  assert.deepEqual(r.implementers, [IMPL_3862]);
  assert.equal(r.spend, null, "the spend panel still books nothing from before its window");
  const line = computeBoard(r).tickets.find((x) => x.issue === 3862).cellLine;
  assert.equal(line.lines[1].map((p) => p.sep + p.text).join(""), "not on record · claude-opus-5 · high · fell back to claude-sonnet-5");
});

test("gather: hands the installed router table to the board, so a policy row with no row for its Stratum reads 'follows *'", async (t) => {
  const w = cardsWorkspace(t, { routed: [`impl-3862 ${formatRouting({
    policy: "slow-high", cell: "slow-high", draw: null, by: null, stratum: "heavy", brief: 9658, criteria: 8, parent: null, sized: null, objective: "cost", tripped: [], reason: "ok",
  })}`] });
  writeFileSync(join(w.stateDir, RECEIPT), JSON.stringify({ ...receipt({}), session: w.session }));
  const r = await quiet(() => gather({ ...w.opts, spendDir: receiptSpendDir(w.stateDir) }));
  assert.deepEqual(r.routerTable, readRouterTable(SCRIPTS));
  const line = computeBoard(r).tickets.find((x) => x.issue === 3862).cellLine;
  assert.equal(line.lines[0].map((p) => p.sep + p.text).join(""), "slow-high · cost row, heavy · follows *");
});

// -- a carried row's implementer, in the session its entry's session= names -----------------

const NEW_SESSION = "2026-10-29T09-00-00-000Z_02b19237-ff15-7106-b7a6-25f435a02238";
const STAMPED_ENTRY = `impl-3862 brief=7f685cae agent=fleet-implementer-slow-high session=${SESSION}`;
const CELL_LINE_3862 = "not on record · claude-opus-5 · high · fell back to claude-sonnet-5";
const cellLine2 = (r) => computeBoard(r).tickets.find((x) => x.issue === 3862).cellLine.lines[1].map((p) => p.sep + p.text).join("");

// The next run's phase0.json, naming its own session — empty, or holding `files`.
function nextRun(w, files = {}) {
  const next = join(w.root, "sessions", NEW_SESSION);
  mkdirSync(next);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(next, name), text);
  writeFileSync(join(w.stateDir, RECEIPT), JSON.stringify({ ...receipt({}), session: next }));
  return next;
}

test("gather: with a new phase0.json naming a new, empty session, a carried row whose entry names session= reads its implementer's record there, and the card shows its model and level", async (t) => {
  const w = cardsWorkspace(t, { entry: STAMPED_ENTRY });
  nextRun(w);
  const r = await quiet(() => gather({ ...w.opts, spendDir: receiptSpendDir(w.stateDir) }));
  assert.deepEqual(r.implementers, [IMPL_3862]);
  assert.equal(cellLine2(r), CELL_LINE_3862);

  // Without the word, the same tick reads nothing for it, as before.
  const unstamped = cardsWorkspace(t);
  nextRun(unstamped);
  const before = await quiet(() => gather({ ...unstamped.opts, spendDir: receiptSpendDir(unstamped.stateDir) }));
  assert.deepEqual(before.implementers, []);
});

test("gather: a stamped session adds the stamped members' records only, not every implementer's transcript in it", async (t) => {
  const w = cardsWorkspace(t, { entry: STAMPED_ENTRY });
  writeFileSync(join(w.session, "impl-3900.jsonl"), transcript({ agent: "fleet-implementer-task-high", model: "claude-sonnet-5", thinking: "high" }));
  nextRun(w);
  const r = await quiet(() => gather({ ...w.opts, spendDir: receiptSpendDir(w.stateDir) }));
  assert.deepEqual(r.implementers, [IMPL_3862]);
});

test("gather: a member found both in the stamped session and in the session a receipt names takes the stamped session's record", async (t) => {
  const w = cardsWorkspace(t, { entry: STAMPED_ENTRY });
  // The current run's session holds a transcript under the same name, run at another level.
  nextRun(w, { "impl-3862.jsonl": transcript({ agent: "fleet-implementer-smol-high", model: "claude-haiku-5-5", thinking: "low" }) });
  const live = await quiet(() => gather({ ...w.opts, spendDir: receiptSpendDir(w.stateDir) }));
  assert.deepEqual(live.implementers, [IMPL_3862]);

  // Between runs alike: the held receipt names that session, and the stamp still wins.
  const between = cardsWorkspace(t, { entry: STAMPED_ENTRY });
  const held = nextRun(between, { "impl-3862.jsonl": transcript({ agent: "fleet-implementer-smol-high", model: "claude-haiku-5-5", thinking: "low" }) });
  rmSync(join(between.stateDir, RECEIPT));
  writeFileSync(join(between.stateDir, RECEIPT_HELD), JSON.stringify({ ...receipt({}), session: held }));
  const r = await quiet(() => gather({ ...between.opts, spendDir: receiptSpendDir(between.stateDir) }));
  assert.deepEqual(r.implementers, [IMPL_3862]);
  assert.equal(cellLine2(r), CELL_LINE_3862);
});

test("gather: a stamped session that no longer exists, or cannot be listed, adds nothing and the tick still answers", async (t) => {
  const gone = cardsWorkspace(t, { entry: STAMPED_ENTRY });
  rmSync(gone.session, { recursive: true });
  nextRun(gone);
  const r = await quiet(() => gather({ ...gone.opts, spendDir: receiptSpendDir(gone.stateDir) }));
  assert.deepEqual(r.implementers, []);
  assert.equal(cellLine2(r).startsWith("not on record"), true);

  const locked = cardsWorkspace(t, { entry: STAMPED_ENTRY });
  nextRun(locked);
  chmodSync(locked.session, 0o000);
  t.after(() => chmodSync(locked.session, 0o755));
  const l = await quiet(() => gather({ ...locked.opts, spendDir: receiptSpendDir(locked.stateDir) }));
  assert.deepEqual(l.implementers, []);
});

test("gather: with --spend-dir named, a stamped session is not read either: the operator's directory is the one session read", async (t) => {
  const w = cardsWorkspace(t, { entry: STAMPED_ENTRY });
  nextRun(w);
  const r = await quiet(() => gather({ ...w.opts, spendDir: tempDir("cell-line-spend-dir-"), spendDirExplicit: true }));
  assert.deepEqual(r.implementers, []);
});

// What `fn` writes to stderr, beside what it returns.
function stderrOf(fn) {
  const write = process.stderr.write;
  let err = "";
  process.stderr.write = (chunk, ...rest) => { err += chunk; rest.find((a) => typeof a === "function")?.(); return true; };
  try { return { value: fn(), err }; } finally { process.stderr.write = write; }
}

test("readHeldImplementers: a held receipt that is absent, unreadable or names no session directory adds nothing, and an unreadable one says why", () => {
  const dir = tempDir("cell-line-held-");
  const into = new Map();
  assert.equal(stderrOf(() => readHeldImplementers(dir, into)).err, "", "no held receipt is the ordinary state, and says nothing");
  writeFileSync(join(dir, RECEIPT_HELD), "{ nope");
  assert.match(stderrOf(() => readHeldImplementers(dir, into)).err, /no card reads .*: not JSON/);
  // A directory holding an implementer's transcript, named as no omp session is.
  const notSession = join(dir, "not-a-session");
  mkdirSync(notSession);
  writeFileSync(join(notSession, "impl-3862.jsonl"), transcript({ agent: "fleet-implementer-slow-high", model: "claude-opus-5", thinking: "high" }));
  writeFileSync(join(dir, RECEIPT_HELD), JSON.stringify({ ...receipt({}), session: notSession }));
  readHeldImplementers(dir, into);
  writeFileSync(join(dir, RECEIPT_HELD), JSON.stringify({ ...receipt({}), session: join(dir, SESSION) }));
  readHeldImplementers(dir, into);
  assert.equal(into.size, 0);
});

test("readHeldImplementers: a transcript with a malformed middle line is still read, and said to be suspect", () => {
  const dir = tempDir("cell-line-held-damaged-");
  const session = join(dir, SESSION);
  mkdirSync(session);
  const lines = transcript({ agent: "fleet-implementer-slow-high", model: "claude-opus-5", thinking: "high" }).split("\n");
  lines.splice(2, 0, "{garbage");
  writeFileSync(join(session, "impl-3862.jsonl"), lines.join("\n"));
  writeFileSync(join(dir, RECEIPT_HELD), JSON.stringify({ ...receipt({}), session }));
  const into = new Map();
  const { err } = stderrOf(() => readHeldImplementers(dir, into));
  assert.equal(into.get("impl-3862")?.subagent_type, "fleet-implementer-slow-high");
  assert.match(err, /impl-3862\.jsonl: 1 malformed line\(s\) before its last, so its card's model and level may be wrong/);
});

test("readRouterTable: the installed table when validateTable accepts it, else null, and a table not read says why", () => {
  assert.equal(readRouterTable(SCRIPTS).rows.cost["*"], "slow-high");
  const dir = tempDir("cell-line-table-");
  const missing = stderrOf(() => readRouterTable(dir));
  assert.equal(missing.value, null, "no table");
  assert.match(missing.err, /router table not read, so no card says "follows \*": .*router-table\.json: ENOENT/);
  writeFileSync(join(dir, "router-table.json"), "{ corrupt");
  const corrupt = stderrOf(() => readRouterTable(dir));
  assert.equal(corrupt.value, null, "will not parse");
  assert.match(corrupt.err, /router table not read.*router-table\.json: /);
  writeFileSync(join(dir, "router-table.json"), JSON.stringify({ rows: {} }));
  const refused = stderrOf(() => readRouterTable(dir));
  assert.equal(refused.value, null, "not a table");
  assert.match(refused.err, /router table not read/);
  assert.equal(stderrOf(() => readRouterTable(dir)).err, "", "the same fault is said once");
});

// -- the policy rows' reads: the install's package.json and the live run's Objective --------------

test("readInstall: the install's own package.json, ../package.json from the script's directory, with its repository's url", () => {
  const root = tempDir("cell-evidence-install-");
  const scripts = join(root, "scripts");
  mkdirSync(scripts);
  const put = (pkg) => writeFileSync(join(root, "package.json"), typeof pkg === "string" ? pkg : JSON.stringify(pkg));
  put({ name: "@feigi/fleet-ctl", version: "3.104.0", repository: { type: "git", url: "git+https://github.com/feigi/fleet-plugin.git", directory: "plugin" } });
  assert.deepEqual(readInstall(scripts), { name: "@feigi/fleet-ctl", version: "3.104.0", repository: "git+https://github.com/feigi/fleet-plugin.git", error: null });
  put({ name: "x", version: "1.0.0", repository: "github:feigi/fleet-plugin" });
  assert.equal(readInstall(scripts).repository, "github:feigi/fleet-plugin", "the string form");
  put({ name: "x", version: "1.0.0" });
  assert.deepEqual(readInstall(scripts), { name: "x", version: "1.0.0", repository: null, error: null }, "a package naming no repository");
  put({ name: 3, version: null, repository: { directory: "plugin" } });
  assert.deepEqual(readInstall(scripts), { name: null, version: null, repository: null, error: null });
  for (const repository of [null, [], ["git+https://github.com/feigi/fleet-plugin.git"], 3]) {
    put({ name: "x", version: "1.0.0", repository });
    assert.deepEqual(readInstall(scripts), { name: "x", version: "1.0.0", repository: null, error: null }, `a repository field of ${JSON.stringify(repository)} names none`);
  }
});

test("readInstall: a package.json that is missing, not JSON or not an object is an error, with nothing guessed", () => {
  const root = tempDir("cell-evidence-install-");
  const scripts = join(root, "scripts");
  mkdirSync(scripts);
  assert.match(readInstall(scripts).error, /package\.json: ENOENT$/);
  writeFileSync(join(root, "package.json"), "{ nope");
  assert.match(readInstall(scripts).error, /package\.json: not JSON$/);
  writeFileSync(join(root, "package.json"), "[1]");
  assert.match(readInstall(scripts).error, /package\.json: not a JSON object$/);
  for (const r of [readInstall(scripts)]) assert.deepEqual([r.name, r.version, r.repository], [null, null, null]);
});

test("readObjective: the live run's Objective off phase0.json, and null between runs or when it records none", () => {
  const dir = tempDir("cell-evidence-objective-");
  assert.equal(readObjective(dir), null, "no receipt: between runs");
  writeFileSync(join(dir, RECEIPT), JSON.stringify({ ...receipt({}), objective: "speed" }));
  assert.equal(readObjective(dir), "speed");
  writeFileSync(join(dir, RECEIPT), JSON.stringify({ ...receipt({}), objective: "cost" }));
  assert.equal(readObjective(dir), "cost");
  writeFileSync(join(dir, RECEIPT), JSON.stringify({ ...receipt({}), objective: "fast" }));
  assert.equal(readObjective(dir), null, "an Objective the router does not know");
  writeFileSync(join(dir, RECEIPT), JSON.stringify(receipt({})));
  assert.equal(readObjective(dir), null, "a receipt written before the Objective");
  writeFileSync(join(dir, RECEIPT), "{ nope");
  assert.equal(readObjective(dir), null);
});

test("gather: hands the install and the live Objective to the board, whose policy rows read them", async (t) => {
  const w = workspace(t);
  writeFileSync(join(w.root, "package.json"), JSON.stringify({ name: "@feigi/fleet-ctl", version: "3.104.0", repository: { url: "git+https://github.com/feigi/fleet-plugin.git" } }));
  writeFileSync(join(w.stateDir, RECEIPT), JSON.stringify({ ...receipt({}), objective: "speed" }));
  const r = await quiet(() => gather(w.opts));
  assert.deepEqual(r.install, { name: "@feigi/fleet-ctl", version: "3.104.0", repository: "git+https://github.com/feigi/fleet-plugin.git", error: null });
  assert.equal(r.objective, "speed");
  const policy = computeBoard(r).cellEvidence.policy;
  assert.deepEqual(policy.objectives.map((o) => [o.objective, o.live]), [["cost", false], ["speed", true]]);
  assert.equal(policy.sides[0].source.text.split(" · ")[0], "feigi/fleet-plugin's runs", "the workspace's repository is unknown here, so it is never 'this repository's'");
  assert.equal(policy.sides[0].source.check, "not checked: this workspace's repository is not known");
  assert.equal(policy.sides[0].heading, "no router table read: the rows are not known", "this workspace's scripts directory holds no router-table.json");
});

test("gather: a caller that names no state directory reads no Objective", async (t) => {
  const w = workspace(t);
  const r = await quiet(() => gather({ ...w.opts, stateDir: null }));
  assert.equal(r.objective, null);
});
