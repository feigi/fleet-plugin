#!/usr/bin/env node
// The dispatch-pool preflight. #1420 refills implementer slots from an omp
// workpool, and a pool hands a queued item to a WORKER: by default omp routes
// that item onto the idle worker with the lowest context usage and extends
// that worker's transcript. For a refill that is a Wake — the one thing a
// refill may never be, because waking a finished member drags its old ticket
// back in (skills/run-team/references/member-lifecycle.md) — and it is silent
// when it happens. The item runs, the member answers, and no field anywhere
// says the previous ticket's worktree paths and claim state came with it.
//
// `eval.workpool.freshAgents: true` turns that reuse off outright. It is NOT a
// pool argument: `workpool(agent, name, context, tools)` carries no such field,
// so there is nothing to pass at call time and nothing to override per pool. It
// is session-wide configuration whose default is `false` — which means the
// never-Wake guarantee, stated as prose, is silently untrue in a
// default-configured session. So it is stated here instead, as a refusal:
// before a pool is opened, read the setting; anything other than `true`
// refuses, loudly, naming the key.
//
// EFFECTIVE, not a file. omp builds a setting's value from five layers —
// built-in defaults, the global config, project settings under
// `<cwd>/.omp/config.yml`, `--config` overlays, then runtime overrides — so
// reading any single file answers a different question than the one the pool
// depends on, and answers it in the fail-open direction whenever a lower layer
// is the one that says `false`. `omp config get <key> --json` prints the merged
// effective value of one key, which is the question this guard has. The child
// inherits this process's cwd and environment deliberately: the project layer
// is resolved against the working directory, and the overlay and agent-directory
// layers arrive as `PI_CONFIG_FILES`/`PI_CODING_AGENT_DIR`, so a child that
// inherits both reads the same five layers its caller does. No CLI flag or
// environment variable maps onto this key, so the one layer a separate process
// cannot see — in-memory runtime overrides — has nothing in it to miss.
//
// Nothing here writes. `omp config set` would land in the operator's GLOBAL
// file and govern every other pool in the session, so a controller that set the
// key to open its own pool would be editing a machine-wide configuration to
// dispatch a wave. Setting it is install-time work for the operator (#1589) and
// the dispatch instruction that calls this is #1590's; this file only reads,
// and refuses.
//
// The decision is `classify()`, pure and table-driven over the object spawnSync
// returns, so every reading — including the ones a correctly configured machine
// can never produce — is testable with no live harness. main() does the I/O.

// The key, spelled once. Every refusal names it, because a refusal that does
// not is a refusal the operator cannot act on.
export const SETTING = "eval.workpool.freshAgents";

// The read, as data, so the refusals can quote the exact command that produced
// them and a test can assert that this is the only thing ever run.
export const READ_ARGV = ["config", "get", SETTING, "--json"];
const READ = `omp ${READ_ARGV.join(" ")}`;

// A config read is a local file merge: measured at ~0.4s against the real
// binary. The bound is not about slowness, it is about a read that never
// returns — a preflight blocked forever is a pool that is neither opened nor
// refused, which is the silence this guard exists to end. A timeout arrives
// below as a spawn error and refuses like every other failed read.
const READ_TIMEOUT_MS = 10_000;

// The cause that permits. Kept apart from the refusing causes because it is the
// one row that owes no reason: it opens nothing, so there is nothing to justify.
const PERMIT = "enabled";

// Why each refusing reading refuses, quoted back at whoever hit it. Keyed by
// cause rather than by row, because several rows reach the same verdict by
// different routes and they owe one reason between them, not three spellings
// of it. Exported with the table above so the pairing check below is asserted
// over the REAL pair and not only over a synthetic one.
export const WHY = {
  disabled:
    "A pool opened with fresh agents off routes each queued item onto the idle worker with the lowest context "
    + "usage and extends that worker's transcript — a wake, which a refill may never be, and silent when it happens.",
  absent:
    "A harness that reports no value for the key has not said `true`. Reading that as the schema default would be "
    + "guessing the value; reading it as permission would open the pool on a setting nothing confirmed.",
  unreadable:
    "The reading the pool depends on is the one that could not be taken, and a guard that fails open on "
    + "\"could not look\" protects nothing.",
};

// Named separately from WHY so the refusal's last sentence is identical on
// every route: whatever went wrong, the operator is owed the key and the value.
const SET_THE_KEY =
  `Set \`${SETTING}\` to true — it is session-wide omp configuration, read here from the merged effective `
  + "settings and never written here, because a run that edits the operator's configuration to dispatch a wave "
  + "has changed every other pool in the session too.";

// The last few lines of whatever the harness said for itself. The cause an
// operator can act on — `Unknown setting: …`, an auth failure, a parse error in
// their own config — lives in omp's message and nowhere else, so dropping it
// leaves a refusal that names the key without saying why it could not be read.
// Bounded, because a refusal is read in a controller's context.
function harnessSaid(r) {
  const said = `${r.stderr ?? ""}`.trim().split("\n").map((l) => l.trim()).filter(Boolean).slice(-3).join(" / ");
  return said ? ` — ${said}` : "";
}

// One observation of one read, computed once so the table below is a list of
// questions about it rather than a list of re-parses. `parsed.ok` is false for
// stdout that is empty or is not JSON; `shaped` is the documented
// `{ key, value, type, description }` object; `value` is `undefined` when that
// object carries no value at all, which is a different state from `null`
// only in JSON and the same state to this guard.
function observe(reading) {
  const r = { error: null, signal: null, status: 0, stdout: "", stderr: "", ...reading };
  const text = `${r.stdout ?? ""}`.trim();
  let parsed;
  if (text === "") parsed = { ok: false, why: "printed nothing on stdout" };
  else {
    try {
      parsed = { ok: true, payload: JSON.parse(text) };
    } catch (e) {
      parsed = { ok: false, why: `printed something that is not JSON: ${e.message}` };
    }
  }
  const payload = parsed.ok ? parsed.payload : null;
  const shaped = payload !== null && typeof payload === "object" && !Array.isArray(payload);
  return { r, parsed, shaped, value: shaped ? payload.value : undefined };
}

// Every reading this guard can get back, in the order they are asked, first
// match winning. Two properties of the order are load-bearing and neither is
// stylistic:
//
//   - Permission is a POSITIVE determination — the `enabled` row tests
//     `value === true` rather than sitting at the end as an else. A table whose
//     last row permits by default opens the pool on every reading a future row
//     forgets to name, which is the one direction this guard may never fail in.
//   - The catch-all is a REFUSAL, and it is last. A reading no row above can
//     name is a reading this guard cannot read as a boolean, and an unnameable
//     reading refuses like every other one.
export const READINGS = [
  {
    cause: "unreadable",
    when: (o) => o.r.error !== null && o.r.error !== undefined,
    detail: (o) => `\`${READ}\` did not complete: ${o.r.error.code ?? o.r.error.message}`,
  },
  {
    cause: "unreadable",
    when: (o) => o.r.signal !== null && o.r.signal !== undefined,
    detail: (o) => `\`${READ}\` was killed by ${o.r.signal}`,
  },
  {
    cause: "unreadable",
    when: (o) => o.r.status !== 0,
    detail: (o) => `\`${READ}\` exited ${o.r.status}${harnessSaid(o.r)}`,
  },
  {
    cause: "unreadable",
    when: (o) => !o.parsed.ok,
    detail: (o) => `\`${READ}\` ${o.parsed.why}${harnessSaid(o.r)}`,
  },
  {
    cause: "unreadable",
    when: (o) => !o.shaped,
    detail: () => `\`${READ}\` answered with something other than the documented { key, value, type, description } object`,
  },
  {
    cause: "absent",
    when: (o) => o.value === undefined || o.value === null,
    detail: () => `\`${READ}\` reported no value for \`${SETTING}\``,
  },
  {
    cause: PERMIT,
    when: (o) => o.value === true,
    detail: () => `\`${SETTING}\` is effectively true`,
  },
  {
    cause: "disabled",
    when: (o) => o.value === false,
    detail: () => `\`${SETTING}\` is effectively false`,
  },
  {
    cause: "unreadable",
    when: () => true,
    detail: (o) => `\`${READ}\` reported \`${SETTING}\` as ${JSON.stringify(o.value)}, which is not the boolean this guard needs`,
  },
];

// A row that refuses must carry its own reason. Nothing but spelling ties a
// cause to its WHY entry, and a string-key miss is the quietest kind: the
// refusal still prints, still exits 2, still looks like a working guard, and
// says `undefined` where the reason belongs. Exported so the pairing is a
// test's subject and not only the import-time check below.
export function unpairedCauses(readings, why) {
  const refusing = [...new Set(readings.map((r) => r.cause))].filter((c) => c !== PERMIT);
  return refusing.filter((c) => !(c in why));
}

const unpaired = unpairedCauses(READINGS, WHY);
if (unpaired.length) {
  throw new Error(`pool-preflight: refusing causes with no WHY entry: ${unpaired.join(", ")}`);
}

// The whole decision. Takes a reading — spawnSync's own result shape — and
// returns `{ ok, cause, message }`; `ok` is the only thing a caller may open a
// pool on.
export function classify(reading) {
  const o = observe(reading);
  const row = READINGS.find((x) => x.when(o));
  const detail = row.detail(o);
  if (row.cause === PERMIT) {
    return { ok: true, cause: row.cause, message: `${detail} — a dispatch pool may be opened` };
  }
  return {
    ok: false,
    cause: row.cause,
    message: `refusing to open a dispatch pool: ${detail}. ${WHY[row.cause]} ${SET_THE_KEY}`,
  };
}

// --------------------------------------------------------------------------
// I/O. Everything below runs only as a CLI — importing this file must never
// spawn anything, or the decision above stops being testable without a harness.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { makeDie } from "./arg.mjs";

const NAME = "pool-preflight";
const die = makeDie(NAME);

// cwd and env are inherited, not scrubbed, and that is the read's whole
// correctness: see this file's header for which layer each one carries.
function readEffective() {
  return spawnSync("omp", READ_ARGV, { encoding: "utf8", timeout: READ_TIMEOUT_MS });
}

function main() {
  // No flags, no positionals, nothing to pass: the setting is session-wide, so
  // a caller that typed an argument meant something this script cannot do —
  // and a silently ignored argument is a preflight answering a question nobody
  // asked. Refused before the harness is touched.
  const given = process.argv.slice(2);
  if (given.length) {
    die(`takes no arguments, got '${given[0]}' — \`${SETTING}\` is session-wide configuration, `
      + "so there is nothing to pass and nothing to override at call time");
  }

  const verdict = classify(readEffective());
  // die() writes the refusal to stderr and exits 2. Nothing is printed on
  // stdout on that route: a caller reading stdout for the go-ahead must find
  // it empty, and a refusal that printed a line there would be a go-ahead.
  if (!verdict.ok) die(verdict.message);
  console.log(`${NAME}: ${verdict.message}`);
}

// Only run main() as a CLI, never when imported by a test. realpathSync
// resolves both sides (relative argv, symlinks) so the equality is reliable
// regardless of how node was invoked — an unresolved argv[1] compared against
// import.meta.url (which node always resolves through symlinks) diverges for
// any invocation path that traverses one, including a bare /tmp path on
// macOS, and main() silently never runs: the same exit code as an explicit
// PERMIT. See board.mjs's identical guard for the established pattern.
const isCLI = process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isCLI) main();
