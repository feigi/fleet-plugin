import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OBJECTIVE_DEFAULT, OBJECTIVES, objectiveFromReceipt, readReceipt, phase0Gate, sessionFromReceipt, STEP_NAMES } from "../plugin/scripts/phase0-receipt.mjs";
import { gitEnv } from "../plugin/scripts/git-env.mjs";

const STEPS = ["alarm", "branch", "fast-forward", "pin", "baseline", "preflight", "ruleset", "tier-roles", "metrics",
  "cockpit", "rotate", "reclaim", "recipe", "fold-in", "stranded", "shortlist"];
const receipt = ({ run = 5, session = "/s/run", steps = {}, ...rest } = {}) => ({
  run, session, scratch: "/scratch", ...rest,
  steps: Object.fromEntries(STEPS.map((n) => [n, { status: "ok", at: "t", output: "", ...steps[n] }])),
});
const ok = (r) => ({ state: "ok", receipt: r });
const PATH = "/w/.fleet/phase0.json";

function dir(t) {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "phase0-receipt-")));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

test("readReceipt: missing, not JSON, not a receipt, a step with no status, and a receipt", (t) => {
  const d = dir(t);
  const at = (name, text) => { const p = join(d, name); writeFileSync(p, text); return p; };
  assert.deepEqual(readReceipt(join(d, "absent.json")), { state: "missing" });
  assert.match(readReceipt(at("junk.json", "{")).why, /^not JSON/);
  for (const shape of [[], { steps: {}, session: "/s" }, { run: null, session: 3, steps: {} }, { run: null, session: "/s", steps: [] }]) {
    assert.equal(readReceipt(at("shape.json", JSON.stringify(shape))).state, "unreadable", JSON.stringify(shape));
  }
  assert.deepEqual(readReceipt(at("step.json", JSON.stringify({ run: null, session: "/s", steps: { recipe: {} } }))),
    { state: "unreadable", why: "step recipe has no status" });
  const r = receipt();
  assert.deepEqual(readReceipt(at("ok.json", JSON.stringify(r))), ok(r));
});

test("phase0Gate: every step ok on this run's receipt holds nothing and says nothing", () => {
  assert.deepEqual(phase0Gate(ok(receipt()), { path: PATH, controllerAt: 5 }), { held: false, line: null, session: "/s/run" });
  // No controller record and a rotation that wrote none: `run` null matches.
  assert.equal(phase0Gate(ok(receipt({ run: null })), { path: PATH, controllerAt: null }).held, false);
});

test("phase0Gate: missing, unreadable and another run's receipt hold, naming why", () => {
  const cmd = "dispatch held: run ~/.fleet/bin/fleet-run phase0.mjs --session <session> and act on what it prints";
  assert.deepEqual(phase0Gate({ state: "missing" }, { path: PATH, controllerAt: 5 }),
    { held: true, line: `PHASE0-INCOMPLETE no receipt at ${PATH} — ${cmd}`, session: null });
  assert.deepEqual(phase0Gate({ state: "unreadable", why: "EACCES" }, { path: PATH, controllerAt: 5 }),
    { held: true, line: `PHASE0-INCOMPLETE receipt ${PATH} unreadable: EACCES — ${cmd}`, session: null });
  assert.deepEqual(phase0Gate(ok(receipt({ run: 4 })), { path: PATH, controllerAt: 5 }),
    { held: true, line: `PHASE0-INCOMPLETE receipt ${PATH} is another run's: run 4, controller record 5 — ${cmd}`, session: null });
  assert.match(phase0Gate(ok(receipt({ run: 4 })), { path: PATH, controllerAt: null }).line, /run 4, controller record none — /);
  assert.match(phase0Gate(ok(receipt({ run: null })), { path: PATH, controllerAt: 5 }).line, /run none, controller record 5 — /);
});

test("phase0Gate: failed, pending and unknown statuses hold, every one named in step order", () => {
  const g = phase0Gate(ok(receipt({ steps: { baseline: { status: "failed" }, recipe: { status: "pending" }, stranded: { status: "skipped" } } })),
    { path: PATH, controllerAt: 5 });
  assert.deepEqual(g, {
    held: true,
    line: "PHASE0-INCOMPLETE baseline, recipe, stranded — dispatch held: run ~/.fleet/bin/fleet-run phase0.mjs --session /s/run and act on what it prints",
    session: "/s/run",
  });
});

test("phase0Gate: a receipt that records no session holds with the <session> placeholder and hands out none", () => {
  const g = phase0Gate(ok(receipt({ session: "", steps: { recipe: { status: "failed" } } })), { path: PATH, controllerAt: 5 });
  assert.deepEqual(g, {
    held: true,
    line: "PHASE0-INCOMPLETE recipe — dispatch held: run ~/.fleet/bin/fleet-run phase0.mjs --session <session> and act on what it prints",
    session: null,
  });
  assert.deepEqual(phase0Gate(ok(receipt({ session: "" })), { path: PATH, controllerAt: 5 }), { held: false, line: null, session: null });
});

test("phase0Gate: a step the receipt does not carry holds, named after the steps it does carry", () => {
  const none = phase0Gate(ok({ ...receipt(), steps: {} }), { path: PATH, controllerAt: 5 });
  assert.deepEqual(none, {
    held: true,
    line: `PHASE0-INCOMPLETE ${STEPS.join(", ")} — dispatch held: run ~/.fleet/bin/fleet-run phase0.mjs --session /s/run and act on what it prints`,
    session: "/s/run",
  });
  const { recipe: _recipe, ...rest } = receipt({ steps: { baseline: { status: "failed" } } }).steps;
  const some = phase0Gate(ok({ ...receipt(), steps: rest }), { path: PATH, controllerAt: 5 });
  assert.match(some.line, /^PHASE0-INCOMPLETE baseline, recipe — dispatch held: /);
  // An entry beyond the known steps is read like any other.
  assert.equal(phase0Gate(ok(receipt({ steps: { extra: { status: "ok" } } })), { path: PATH, controllerAt: 5 }).held, false);
  assert.deepEqual(STEP_NAMES, STEPS);
});

test("phase0Gate: a finished receipt whose controller has exited or cannot be judged is the run before's and holds", () => {
  const cmd = "dispatch held: run ~/.fleet/bin/fleet-run phase0.mjs --session <session> and act on what it prints";
  assert.deepEqual(phase0Gate(ok(receipt()), { path: PATH, controllerAt: 5, controller: "dead" }), {
    held: true,
    line: `PHASE0-INCOMPLETE receipt ${PATH} is run 5's and its controller has exited: not this session's finished phase 0 — ${cmd}`,
    session: null,
  });
  assert.deepEqual(phase0Gate(ok(receipt()), { path: PATH, controllerAt: 5, controller: "unreadable" }), {
    held: true,
    line: `PHASE0-INCOMPLETE receipt ${PATH} is run 5's and its controller cannot be judged: not this session's finished phase 0 — ${cmd}`,
    session: null,
  });
  for (const controller of ["none", "alive", "ancestor"]) {
    assert.deepEqual(phase0Gate(ok(receipt()), { path: PATH, controllerAt: 5, controller }), { held: false, line: null, session: "/s/run" }, controller);
  }
});

test("phase0Gate: drift, unanswered and a fold-in NEED are advice — on the ADVICE line alone, after the steps when one holds", () => {
  const steps = {
    ruleset: { status: "unanswered" }, preflight: { status: "drift" },
    "fold-in": { status: "ok", output: "queued 1 PR(s)\nNEED review PR#7 (closes no issue)\nNEED review PR#8 (closes no issue)" },
  };
  assert.deepEqual(phase0Gate(ok(receipt({ steps })), { path: PATH, controllerAt: 5 }), {
    held: false,
    line: "PHASE0-ADVICE preflight drift, ruleset unanswered, fold-in NEED review PR#7 (closes no issue), fold-in NEED review PR#8 (closes no issue)",
    session: "/s/run",
  });
  const held = phase0Gate(ok(receipt({ steps: { ...steps, shortlist: { status: "pending" } } })), { path: PATH, controllerAt: 5 });
  assert.equal(held.held, true);
  assert.match(held.line, /^PHASE0-INCOMPLETE shortlist — dispatch held: .*; advice: preflight drift, ruleset unanswered, fold-in NEED review PR#7/);
});

test("sessionFromReceipt: the receipt's session, or a refusal naming the receipt", (t) => {
  const d = dir(t);
  assert.equal(spawnSync("git", ["init", "-q", d], { env: gitEnv() }).status, 0);
  mkdirSync(join(d, ".fleet"));
  const file = join(d, ".fleet", "phase0.json");
  assert.throws(() => sessionFromReceipt({ cwd: d }), (e) => e.message.includes(`phase-0 receipt ${file} (no receipt)`));
  writeFileSync(file, JSON.stringify(receipt({ session: "" })));
  assert.throws(() => sessionFromReceipt({ cwd: d }), /\(it records no session\)/);
  writeFileSync(file, "{");
  assert.throws(() => sessionFromReceipt({ cwd: d }), /\(unreadable: not JSON/);
  writeFileSync(file, JSON.stringify(receipt({ session: "/sessions/run-1" })));
  assert.equal(sessionFromReceipt({ cwd: d }), "/sessions/run-1");
});

test("objectiveFromReceipt: the receipt's objective, or a refusal naming the receipt; the default is cost", (t) => {
  assert.deepEqual([OBJECTIVE_DEFAULT, OBJECTIVES], ["cost", ["cost", "speed"]]);
  const d = dir(t);
  assert.equal(spawnSync("git", ["init", "-q", d], { env: gitEnv() }).status, 0);
  mkdirSync(join(d, ".fleet"));
  const file = join(d, ".fleet", "phase0.json");
  assert.throws(() => objectiveFromReceipt({ cwd: d }), (e) => e.message.includes(`no objective given and none in the phase-0 receipt ${file} (no receipt)`));
  writeFileSync(file, JSON.stringify(receipt({ session: "/sessions/run-1" })));
  assert.throws(() => objectiveFromReceipt({ cwd: d }), /\(it records no objective\)/);
  writeFileSync(file, JSON.stringify(receipt({ session: "/sessions/run-1", objective: "fast" })));
  assert.throws(() => objectiveFromReceipt({ cwd: d }), /\(it records no objective\)/, "a value that is no objective is none");
  writeFileSync(file, "{");
  assert.throws(() => objectiveFromReceipt({ cwd: d }), /\(unreadable: not JSON/);
  for (const objective of OBJECTIVES) {
    writeFileSync(file, JSON.stringify(receipt({ session: "/sessions/run-1", objective })));
    assert.equal(objectiveFromReceipt({ cwd: d }), objective);
  }
});
