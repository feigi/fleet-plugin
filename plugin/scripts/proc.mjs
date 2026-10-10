// Process liveness and the process tree, in one place: the ledger lock's dead
// holder and the controller record in heartbeat.json are judged by the same
// predicate, so the two cannot disagree about what "dead" means.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename } from "node:path";

// ESRCH alone is dead. EPERM is a live process we may not signal, and any
// other error is not evidence of death either.
export function isDead(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return e.code === "ESRCH";
  }
}

// Thrown when the process tree or a start time cannot be read. A caller that
// would act on a verdict refuses instead: a controller nobody could judge is
// never judged dead.
export class ProcUnreadable extends Error {}

// The two reads the controller record needs — a process's parent and argv,
// and its start time — behind one source. The real one is `ps`. A
// FLEET_PROC_TABLE file replaces it whole: a test suite run from inside a live
// omp session would otherwise find that session's omp as its ancestor. The
// file is a JSON object keyed by pid:
//
//   { "<pid>": { "ppid": <pid>, "argv": ["bun", "/…/omp"], "lstart": "<start>" } }
//
// A pid the table does not name has no parent and no start time, as a pid
// `ps` does not list.
export function processSource(env = process.env) {
  return env.FLEET_PROC_TABLE ? tableSource(env.FLEET_PROC_TABLE) : psSource(env);
}

function tableSource(path) {
  let table;
  try {
    table = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ProcUnreadable(`cannot read the process table ${path}: ${e.message}`);
  }
  const bad = tableProblem(table);
  if (bad !== null) throw new ProcUnreadable(`cannot read the process table ${path}: ${bad}`);
  const entry = (pid) => (Object.hasOwn(table, String(pid)) ? table[String(pid)] : null);
  return {
    parentOf: (pid) => {
      const e = entry(pid);
      return e ? { ppid: e.ppid, argv: e.argv } : null;
    },
    startTime: (pid) => entry(pid)?.lstart ?? null,
  };
}

// Why `table` is not the shape processSource() documents, or null when it is:
// a plain object whose every entry names an integer parent, an argv of
// strings, and — when it names one at all — a start time that is a string.
function tableProblem(table) {
  if (table === null || typeof table !== "object" || Array.isArray(table)) return "it is not a JSON object keyed by pid";
  for (const [pid, e] of Object.entries(table)) {
    if (e === null || typeof e !== "object" || Array.isArray(e)) return `pid ${pid} is not an object`;
    if (!Number.isInteger(e.ppid)) return `pid ${pid} has no integer ppid`;
    if (!Array.isArray(e.argv) || !e.argv.every((a) => typeof a === "string")) return `pid ${pid} has no argv array of strings`;
    if (e.lstart !== undefined && typeof e.lstart !== "string") return `pid ${pid} has an lstart that is not a string`;
  }
  return null;
}

function psSource(env) {
  // `lstart` is printed in the caller's zone and locale, and a later run —
  // with its own TZ — compares it as an opaque string. Pinning both makes the
  // string a property of the process, not of whoever asked.
  const psEnv = { ...env, TZ: "UTC", LC_ALL: "C" };
  const ps = (args) => {
    const r = spawnSync("ps", args, { encoding: "utf8", env: psEnv });
    if (r.error) throw new ProcUnreadable(`cannot read the process table: ps: ${r.error.message}`);
    return r;
  };
  let parents = null;
  return {
    parentOf(pid) {
      if (parents === null) {
        // -ww: without it `args` is cut to the terminal width, and the
        // omp path can be the part that is cut.
        const r = ps(["-A", "-ww", "-o", "pid=,ppid=,args="]);
        if (r.status !== 0) throw new ProcUnreadable(`cannot read the process table: ps -A exited ${r.status}: ${r.stderr.trim()}`);
        parents = parsePs(r.stdout);
      }
      return parents.get(pid) ?? null;
    },
    startTime(pid) {
      const r = ps(["-o", "lstart=", "-p", String(pid)]);
      const out = r.stdout.trim();
      if (r.status === 0 && out !== "") return out;
      // Exit 1 with nothing on either stream is `ps` selecting no process:
      // the pid is gone. Anything else is a `ps` that did not answer.
      if (r.status === 1 && out === "" && r.stderr.trim() === "") return null;
      throw new ProcUnreadable(`cannot read the start time of pid ${pid}: ps exited ${r.status}: ${r.stderr.trim()}`);
    },
  };
}

// `args` is argv joined by single spaces, so an argument that itself holds a
// space splits here; the omp match only reads argv[0] and argv[1], and a path
// with a space in it misses the match rather than mismatching.
function parsePs(text) {
  const parents = new Map();
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)(.*)$/.exec(line);
    if (m) parents.set(Number(m[1]), { ppid: Number(m[2]), argv: m[3].trim().split(/\s+/) });
  }
  return parents;
}

// The caller's ancestors, nearest first, from its parent up to the first pid
// the source cannot place.
export function ancestry(source, start = process.ppid) {
  const chain = [];
  const seen = new Set();
  for (let pid = start; pid > 0 && !seen.has(pid);) {
    seen.add(pid);
    const e = source.parentOf(pid);
    if (e === null) break;
    chain.push({ pid, argv: e.argv });
    pid = e.ppid;
  }
  return chain;
}

// omp runs as `bun …/omp`, so its process name is `bun` and only its first
// argument names it; an installed binary would be argv[0]. The file name must
// be exactly `omp`.
const isOmp = (argv) => argv.slice(0, 2).some((a) => basename(a) === "omp");

// The record this run writes: the nearest omp ancestor and its start time, or
// null when the chain holds none. Nearest, because two omp sessions can be
// live in one checkout and one can be the other's ancestor.
export function controllerOf(source, chain) {
  const omp = chain.find((e) => isOmp(e.argv));
  if (!omp) return null;
  const lstart = source.startTime(omp.pid);
  return lstart === null ? null : { pid: omp.pid, lstart };
}

// What a recorded controller is now, judged against the caller's chain:
//   none      no record
//   dead      isDead() says so, or the pid's start time is not the recorded
//             one — a reused pid, which the record must outlast for days
//             where the ledger lock tolerates it for seconds
//   ancestor  the record names one of the caller's own ancestors
//   alive     any other live controller
export function judgeController(record, source, chain) {
  if (!record) return "none";
  if (isDead(record.pid)) return "dead";
  if (source.startTime(record.pid) !== record.lstart) return "dead";
  if (chain.some((e) => e.pid === record.pid)) return "ancestor";
  return "alive";
}

// judgeController() for a reader that only names a record: the process
// source and the caller's own chain read here, once. Throws ProcUnreadable.
export function judgeRecord(record) {
  const source = processSource();
  return judgeController(record, source, ancestry(source));
}
