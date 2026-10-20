// The phase-0 receipt, read. `.fleet/phase0.json` is written by phase0.mjs
// after every step (its header gives the shape); this module is its readers'
// half: the tick's dispatch gate, the session directory tier-check.mjs
// and ticket-router.mjs take when their own flag is omitted, and the In-flight
// bound the drivers hand the tick, with its default. One reading of the file,
// so the gate and the session readers cannot disagree about what a receipt is.
//
// Zero deps: node builtins and sibling modules only.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fleetFile, FleetDirUnresolvable } from "./fleet-dir.mjs";
import { RECEIPT } from "./ledger-grammar.mjs";

const isRecord = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

// The steps phase0.mjs runs, in order: its receipt always carries every one,
// a step not yet run being `pending`. A receipt missing one was not written
// by a finished phase 0.
export const STEP_NAMES = Object.freeze([
  "alarm", "branch", "fast-forward", "pin", "baseline", "preflight", "ruleset", "tier-roles", "metrics",
  "cockpit", "rotate", "reclaim", "recipe", "fold-in", "stranded", "shortlist",
]);

// The statuses a step can end in that let the run go on: `ok`, and the two
// a ruleset check answers with when the gate drifted or could not be asked.
// Every other status — `failed`, `pending`, or one this reader does not know
// — is a step not done.
const ADVICE = new Set(["drift", "unanswered"]);
const DONE = new Set(["ok", ...ADVICE]);

/**
 * `{ state: "missing" }`, `{ state: "unreadable", why }`, or
 * `{ state: "ok", receipt }`. A receipt is a JSON object carrying `run`, a
 * string `session` and a `steps` object whose every entry has a string
 * `status` — the shape phase0.mjs writes and resumes from.
 */
export function readReceipt(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { state: "missing" };
    return { state: "unreadable", why: e.code ?? e.message };
  }
  let r;
  try {
    r = JSON.parse(text);
  } catch (e) {
    return { state: "unreadable", why: `not JSON (${e.message})` };
  }
  if (!(isRecord(r) && isRecord(r.steps) && Object.hasOwn(r, "run") && typeof r.session === "string")) {
    return { state: "unreadable", why: "not a receipt: it needs run, session and steps" };
  }
  for (const [name, step] of Object.entries(r.steps)) {
    if (!isRecord(step) || typeof step.status !== "string") return { state: "unreadable", why: `step ${name} has no status` };
  }
  return { state: "ok", receipt: r };
}

// The receipt at its resolved place — resolved the way phase0.mjs resolves
// it, so a worktree and the main checkout name one file — or the reason it
// has none: an unresolvable workspace is a receipt nobody can read.
export function readRunReceipt(opts) {
  let path;
  try {
    path = fleetFile(RECEIPT, opts);
  } catch (e) {
    if (!(e instanceof FleetDirUnresolvable)) throw e;
    return { path: RECEIPT, read: { state: "unreadable", why: e.message } };
  }
  return { path, read: readReceipt(path) };
}

const phase0Command = (session) => `~/.fleet/bin/fleet-run phase0.mjs --session ${session ?? "<session>"}`;

/**
 * The tick's gate over one read of the receipt. `controllerAt` is the `at`
 * of the controller record in `.fleet/heartbeat.json` now, null when there is
 * no record or it carries no `at` — the value phase0.mjs records as `run`, and
 * compares the same way. `controller` is what that record's process is now,
 * as proc.mjs's judgeController() answers (`none`, `dead`, `alive`,
 * `ancestor`), or `unreadable` when the process table could not be read.
 *
 * `run` alone cannot tell this run's receipt from the previous run's: the
 * record keeps the previous run's `at` until this run's rotation writes the
 * next, so a finished receipt of the run before still matches it. A record
 * whose process is gone, or cannot be judged, is that case, and holds.
 *
 * `{ held, line, session }`: `held` holds every dispatching row; `line` is the
 * one line printed above the rows, or null when there is nothing to say;
 * `session` is the receipt's session directory when the receipt is this
 * run's, else null.
 *
 * A step `failed` or `pending`, in a status this reader does not know, or
 * absent from the receipt, holds. `drift` and `unanswered`, and a `NEED` line
 * in a `fold-in` step's output, are advice: named on the line, holding
 * nothing.
 */
export function phase0Gate(read, { path, controllerAt = null, controller = "none" }) {
  const held = (why, session = null) => ({
    held: true,
    line: `PHASE0-INCOMPLETE ${why} — dispatch held: run ${phase0Command(session)} and act on what it prints`,
    session,
  });
  if (read.state === "missing") return held(`no receipt at ${path}`);
  if (read.state !== "ok") return held(`receipt ${path} unreadable: ${read.why}`);
  const { receipt } = read;
  if (receipt.run !== controllerAt) {
    return held(`receipt ${path} is another run's: run ${receipt.run ?? "none"}, controller record ${controllerAt ?? "none"}`);
  }
  if (controller === "dead" || controller === "unreadable") {
    const why = controller === "dead" ? "its controller has exited" : "its controller cannot be judged";
    return held(`receipt ${path} is run ${receipt.run ?? "none"}'s and ${why}: not this session's finished phase 0`);
  }
  const steps = Object.entries(receipt.steps);
  const absent = STEP_NAMES.filter((name) => !Object.hasOwn(receipt.steps, name));
  const incomplete = [
    ...steps.filter(([, step]) => !DONE.has(step.status)).map(([name]) => name),
    ...absent,
  ];
  const advice = [
    ...steps.filter(([, step]) => ADVICE.has(step.status)).map(([name, step]) => `${name} ${step.status}`),
    ...String(receipt.steps["fold-in"]?.output ?? "").split("\n").map((l) => l.trim())
      .filter((l) => l.startsWith("NEED ")).map((l) => `fold-in ${l}`),
  ];
  const session = receipt.session === "" ? null : receipt.session;
  if (incomplete.length) {
    const said = held(incomplete.join(", "), session);
    return advice.length ? { ...said, line: `${said.line}; advice: ${advice.join(", ")}` } : said;
  }
  return { held: false, line: advice.length ? `PHASE0-ADVICE ${advice.join(", ")}` : null, session };
}

/**
 * The session directory the receipt records, for a reader whose own flag was
 * omitted. Throws an Error naming the receipt when it has none to give.
 */
export function sessionFromReceipt(opts) {
  const { path, read } = readRunReceipt(opts);
  if (read.state === "ok" && read.receipt.session !== "") return read.receipt.session;
  const why = read.state === "missing" ? "no receipt"
    : read.state === "unreadable" ? `unreadable: ${read.why}`
    : "it records no session";
  throw new Error(`no session given and none in the phase-0 receipt ${path} (${why}) — give one, or run ${phase0Command(null)} first`);
}

// The In-flight bound a run takes when nobody gives one: the most tickets
// between Claim and merge at once. Its one definition — phase0.mjs and the
// tick's own flag default both read it from here.
export const IN_FLIGHT_DEFAULT = 5;

/**
 * The bound the receipt in `fleetDir` records, as the tick's own flag:
 * `{ args }` — `--in-flight <B>` for the `inFlight` phase 0 ran with, none
 * when there is no receipt or it records no bound — or `{ error }` for a
 * receipt that is there and cannot be read.
 */
export function tickCaps(fleetDir) {
  let phase0;
  try {
    phase0 = JSON.parse(readFileSync(join(fleetDir, RECEIPT), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return { args: [] };
    return { error: `cannot read ${join(fleetDir, RECEIPT)}: ${e.message}` };
  }
  const bound = phase0?.inFlight;
  return { args: bound == null ? [] : ["--in-flight", String(bound)] };
}
