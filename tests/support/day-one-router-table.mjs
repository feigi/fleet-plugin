// The day-one router table — plugin/scripts/router-table.json as it was before
// any fit (stage 1, burn-in, every row slow-high) — as a frozen literal.
//
// Tests that need the table's contents read this, never the shipped file: a
// re-fit PR moves the shipped table, and a test pinned to it would fail that
// PR for a reason the fit does not own. What every shipped table must satisfy
// is checked by "route: the checked-in table is valid" in
// ticket-router.test.mjs. That the shipped table can be reproduced is CI's
// `Router table check`.
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
  stage: 1,
  cells: ["slow-high", "task-high", "smol-high"],
  burn_in: true,
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
 * A copy of plugin/scripts and plugin/package.json under a temp directory, with
 * the day-one table installed as its router-table.json — a scripts directory
 * whose installed table does not move when a re-fit changes the shipped one.
 * Made once per process, removed when it exits; `scripts` is the directory a
 * script run from it reads its table beside, `root` its `plugin` directory's parent.
 * @returns {{ root: string, scripts: string }}
 */
export function dayOneScripts() {
  if (copy === null) {
    const plugin = fileURLToPath(new URL("../../plugin/", import.meta.url));
    const root = tempDir("day-one-scripts-");
    cpSync(join(plugin, "scripts"), join(root, "plugin", "scripts"), { recursive: true });
    cpSync(join(plugin, "package.json"), join(root, "plugin", "package.json"));
    writeFileSync(join(root, "plugin", "scripts", "router-table.json"), `${JSON.stringify(DAY_ONE_TABLE, null, 2)}\n`);
    copy = { root, scripts: join(root, "plugin", "scripts") };
  }
  return copy;
}
