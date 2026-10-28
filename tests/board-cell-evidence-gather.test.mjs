import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./support/temp-dir.mjs";
import { writeExecStub } from "./support/exec-stub.mjs";
import {
  MODEL_ROLES_EVERY_MS, carryModelRoles, gather, readAgents, readGuardFile, readMetricsStep, readModelRoles,
} from "../plugin/scripts/board-gather.mjs";
import { CLOSEOUT_RECEIPT, RECEIPT } from "../plugin/scripts/ledger-grammar.mjs";
import { computeBoard } from "../plugin/scripts/compute-board.mjs";

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
    { value: ROLES, readAt: NOW, error: "boom" }, { value: ROLES, readAt: NOW, error: { at: "x", message: "m" } }, { value: ROLES, readAt: NOW, error: { at: NOW } }]) {
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

// A cockpit workspace in a temp dir: `.fleet/` with a guard and a phase-0 receipt, an
// installed `agents/` beside `scripts/`, and a stub `omp` that counts its spawns.
function workspace(t, { guard = GUARD, ompBody = null } = {}) {
  const root = tempDir("cell-evidence-gather-");
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
  return { root, stateDir, scriptDir, spawns, opts: { ledgerFile: join(root, "none.md"), prevFile: join(root, "prev.json"), scriptDir, stateDir, interval: 15, spendDir: null } };
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
  const board = computeBoard({ ledger: { rows: [] }, issues: [], prs: [], ci: {}, prev: null, now: 1 });
  assert.equal(board.cellEvidence.guard.heading, "no cost guard");
  assert.equal(board.cellEvidence.guard.cells.length, 5);
  assert.equal(board.modelRoles, null);
  assert.equal(board.cellEvidence.declared.heading, "Declared, not measured: 0 other members");
});
