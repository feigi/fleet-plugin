// The day-one router table — the starting table (burn-in, every row the Baseline
// Cell, the one-node tree: no split) — as frozen literals.
//
// The shipped plugin/scripts/router-table.json is SHIPPED_TABLE: it names no
// Cell, since the Cells it holds are the run's starting set and Baseline Cell,
// filled in wherever the starting table is read (ticket-router.mjs's
// startingTableOf). DAY_ONE_TABLE is that table filled in for the default
// Baseline Cell, `slow-high`: the table a repository that names no Baseline
// Cell begins from. No re-fit PR moves either: they change only by an ordinary
// change. "route: the shipped table names no Cell, and filled in for a Baseline
// Cell it is the starting table" in ticket-router.test.mjs holds the shipped
// file equal to SHIPPED_TABLE and its filled form equal to DAY_ONE_TABLE, and
// "route: the checked-in table is valid"
// there checks what every shipped table must satisfy. Tests that need the
// table's contents read DAY_ONE_TABLE.

import { cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./temp-dir.mjs";

const deepFreeze = (x) => {
  if (x !== null && typeof x === "object") for (const v of Object.values(x)) deepFreeze(v);
  return Object.freeze(x);
};

export const SHIPPED_TABLE = deepFreeze({
  window_start: null,
  n_rows: 0,
  cells: null,
  burn_in: true,
  splits: {},
  rows: { cost: { "*": null }, speed: { "*": null } },
  classifier: { b: null, tau: null },
  estimates: {},
  reasons: {
    cost: { "*": { cell: null, reason: "unjudged", cells: {}, pairs: [] } },
    speed: { "*": { cell: null, reason: "unjudged", cells: {}, pairs: [] } },
  },
  guard: { tripped: [], n: {} },
});

export const DAY_ONE_TABLE = deepFreeze({
  window_start: null,
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
 * directory, with the shipped table installed as its router-table.json — a
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
    writeFileSync(join(root, "plugin", "scripts", "router-table.json"), `${JSON.stringify(SHIPPED_TABLE, null, 2)}\n`);
    copy = join(root, "plugin", "scripts");
  }
  return copy;
}
