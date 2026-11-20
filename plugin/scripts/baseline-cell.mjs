// The Baseline Cell setting: the Cell a repository names as the one the router
// starts from, the cost guard compares every other Cell with and the quality
// floor reads. Phase 0 works it out once per run (phase0.mjs) and records it in
// the receipt as `baselineCell`; every other reader takes the receipt's, else
// the value saved here, else DEFAULT_BASELINE_CELL (phase0-receipt.mjs).
//
// The saved value is `.fleet/baseline-cell.json`, `{ "cell": "<cell>" }`: a valid
// `--baseline-cell` argument is saved and binds every later run until a run
// names another. A value is valid when it is a Cell (CELL) that has an
// implementer definition.
//
// Zero deps: node builtins and sibling modules only.

import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CELL, CELL_DEF, DEFAULT_BASELINE_CELL } from "./ledger-grammar.mjs";

/** The saved value's file name, in the run's `.fleet/`. */
export const BASELINE_FILE = "baseline-cell.json";

// The implementer definitions the install ships: the directory the Cells a Baseline Cell may name are read from.
const SHIPPED_AGENTS = join(dirname(fileURLToPath(import.meta.url)), "..", "agents");

/**
 * The Cells an implementer definition exists for in `agents`: `{ cells, why }`, `cells` a Set and `why` null, or,
 * when the directory cannot be listed, `cells` empty and `why` saying so, so that no value is blamed for it.
 */
export function definedCells(agents = SHIPPED_AGENTS) {
  try {
    return { cells: new Set(readdirSync(agents).map((file) => file.replace(/\.agent\.md$/, "")).filter((name) => CELL_DEF.test(name)).map((name) => name.slice("fleet-implementer-".length))), why: null };
  } catch (e) {
    return { cells: new Set(), why: `${agents} cannot be listed (${e.code ?? e.message})` };
  }
}

/** Whether `value` is a valid Baseline Cell: a Cell with an implementer definition in `defined` (definedCells's `cells`). */
export const isBaselineCell = (value, defined) => typeof value === "string" && CELL.test(value) && defined.has(value);

/**
 * The value saved in `fleetDir`'s `baseline-cell.json`: `{ state: "none" }` for no file, `{ state: "ok", cell }` for
 * a valid Baseline Cell, or `{ state: "invalid", why }` for a file that cannot be read or parsed, holds no string
 * `cell`, or names a Cell that is no valid Baseline Cell.
 */
export function readSavedBaseline(fleetDir, defined = definedCells().cells) {
  const file = join(fleetDir, BASELINE_FILE);
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    return e.code === "ENOENT" ? { state: "none" } : { state: "invalid", why: `${file} cannot be read (${e.code ?? e.message})` };
  }
  let saved;
  try { saved = JSON.parse(text); } catch { return { state: "invalid", why: `${file} is not JSON` }; }
  const cell = saved !== null && typeof saved === "object" ? saved.cell : undefined;
  if (typeof cell !== "string") return { state: "invalid", why: `${file} holds no string \`cell\`` };
  if (!isBaselineCell(cell, defined)) return { state: "invalid", why: `${file} names ${JSON.stringify(cell)}, which is not a Cell with an implementer definition` };
  return { state: "ok", cell };
}

/** Saves `cell` as the Baseline Cell of every later run, through a temp file and a rename. */
export function saveBaseline(fleetDir, cell) {
  const file = join(fleetDir, BASELINE_FILE);
  mkdirSync(fleetDir, { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify({ cell }, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

/**
 * The Baseline Cell a run starts with and where it came from, once, off the argument, the saved value and what the
 * install runs. Never refuses and never asks. `arg` is `--baseline-cell`'s value or null; `saved` is
 * readSavedBaseline's answer; `defined` is definedCells's `cells`; `substitute(cell)` is the Cell the install runs in its
 * place (ticket-router.mjs's defaultCellOf over the install read), `cell` itself where it runs it.
 *
 * A valid argument is the configured Cell and is to be saved (`save`); an invalid one is a notice, is not saved, and
 * the run goes on to the saved value, else DEFAULT_BASELINE_CELL; an invalid saved value is a notice and the run uses
 * DEFAULT_BASELINE_CELL, the file left as it is. A configured Cell the install cannot run is resolved to the nearest
 * level it can, and a notice names both; the saved value stays as configured.
 * @returns {{ cell: string, source: string, save: string|null, notices: string[] }}
 */
export function resolveBaselineCell({ arg, saved, defined, substitute }) {
  const notices = [];
  let configured = null;
  let source = null;
  let save = null;
  if (arg !== null) {
    if (isBaselineCell(arg, defined)) {
      configured = arg;
      source = "--baseline-cell";
      save = arg;
    } else {
      notices.push(`--baseline-cell ${JSON.stringify(arg)} is not a Cell with an implementer definition: ignored, and not saved`);
    }
  }
  if (configured === null) {
    if (saved.state === "ok") {
      configured = saved.cell;
      source = "the saved value";
    } else {
      if (saved.state === "invalid") notices.push(`the saved Baseline Cell is invalid (${saved.why}): this run uses ${DEFAULT_BASELINE_CELL}, and the file is left as it is`);
      configured = DEFAULT_BASELINE_CELL;
      source = "the default";
    }
  }
  const cell = substitute(configured);
  if (cell !== configured) {
    notices.push(`the install does not run ${configured}: this run's Baseline Cell is ${cell}, the nearest level it runs (${configured} stays as configured)`);
    source = `the substitute for ${configured}, from ${source}`;
  }
  return { cell, source, save, notices };
}
