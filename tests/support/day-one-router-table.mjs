// The day-one router table — the starting table (burn-in, every row slow-high,
// the one-node tree: no split) — as a frozen literal.
//
// The shipped plugin/scripts/router-table.json is this table, and no re-fit
// PR moves it: it changes only by an ordinary change. "route: the shipped
// table is the starting table" in ticket-router.test.mjs holds the two equal,
// and "route: the checked-in table is valid" there checks what every shipped
// table must satisfy. Tests that need the table's contents read this literal.
//
// Where the code under test reads the installed table from a scripts
// directory, `dayOneScripts()` is a copy of plugin/scripts holding this table.

import { cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./temp-dir.mjs";

const deepFreeze = (x) => {
  if (x !== null && typeof x === "object") for (const v of Object.values(x)) deepFreeze(v);
  return Object.freeze(x);
};

export const DAY_ONE_TABLE = deepFreeze({
  window_start: null,
  fitted_commit: null,
  n_rows: 0,
  cells: ["slow-high", "task-high", "smol-high"],
  burn_in: true,
  splits: {},
  rows: { cost: { "*": "slow-high" }, speed: { "*": "slow-high" } },
  classifier: { b: null, tau: null },
  estimates: {},
  reasons: {
    cost: { "*": { cell: "slow-high", reason: "unjudged", cells: {}, pairs: [] } },
    speed: { "*": { cell: "slow-high", reason: "unjudged", cells: {}, pairs: [] } },
  },
  guard: { tripped: [], n: {} },
});

let copy = null;

/**
 * A copy of plugin/scripts, plugin/agents and plugin/package.json under a temp
 * directory, with the day-one table installed as its router-table.json — a
 * scripts directory whose installed table is this literal whatever the shipped
 * one holds, and which reads the shipped definitions from `../agents`.
 * Made once per process, removed when it exits.
 * @returns {string} the scripts directory, which a script run from it reads its table beside
 */
export function dayOneScripts() {
  if (copy === null) {
    const plugin = fileURLToPath(new URL("../../plugin/", import.meta.url));
    const root = tempDir("day-one-scripts-");
    cpSync(join(plugin, "scripts"), join(root, "plugin", "scripts"), { recursive: true });
    cpSync(join(plugin, "agents"), join(root, "plugin", "agents"), { recursive: true });
    cpSync(join(plugin, "package.json"), join(root, "plugin", "package.json"));
    writeFileSync(join(root, "plugin", "scripts", "router-table.json"), `${JSON.stringify(DAY_ONE_TABLE, null, 2)}\n`);
    copy = join(root, "plugin", "scripts");
  }
  return copy;
}
