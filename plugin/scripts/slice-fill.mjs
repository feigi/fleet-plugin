#!/usr/bin/env node
// Fills the `parent` column of a ticket-features corpus from each ticket's
// issue body, so the Router's fit reads every Slice as a Slice.
//
//   slice-fill.mjs [--features <tsv>]
//
// `--features` is the corpus, `docs/metrics/ticket-features.tsv` under the cwd
// when omitted; `gh` reads the issues of the repository the cwd is in. A
// corpus whose header lacks `parent` gains it, blank on every row. Then every
// row whose ticket is a Slice (ticket-router.mjs's sliceParent, off the
// issue's current body) gets its parent's number, and nothing else changes: a
// row whose ticket is no Slice keeps its `parent` as it is, and a run over a
// filled corpus writes nothing. So it is safe to run again, and it is what
// sets `parent` on rows a run drained from a plugin that wrote no `parent`.
//
// Prints one line naming how many rows it set. Exit 0 when every ticket's
// issue was read; 1 when some could not be — their rows are left as they
// were, each named on stderr, and the rest are written; 2 on a usage error, a
// corpus that does not parse, or a corpus that cannot be written, which
// writes nothing.

import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { makeDie, defineFlags } from "./arg.mjs";
import { ghAliasedRead } from "./gh-aliased-read.mjs";
import { isCLI } from "./is-cli.mjs";
import { parseFeatures } from "./pull-attribution.mjs";
import { sliceParent } from "./ticket-router.mjs";

const NAME = "slice-fill";
const DEFAULT_FEATURES = "docs/metrics/ticket-features.tsv";
const GH_TIMEOUT_MS = 120_000;

/**
 * `text`, a ticket-features corpus, with `parent` set on every row whose
 * ticket `parents` maps to a parent number: `parents` maps a ticket (as a
 * string) to its parent's number, or to "" for a ticket that is no Slice. A
 * ticket it leaves out keeps its rows as they are. A header without `parent`
 * gains it, blank on every row. Comment lines, row order and every other cell
 * are kept byte for byte. Throws on a corpus parseFeatures refuses.
 * @returns {{ text: string, set: number, widened: boolean }}
 */
export function fillParent(text, parents) {
  parseFeatures(text);
  const lines = String(text).split("\n");
  let ticketAt = -1;
  let at = -1;
  let set = 0;
  let widened = false;
  const out = lines.map((l) => {
    if (!l.trim() || l.startsWith("#")) return l;
    if (at === -1) {
      const header = l.split("\t");
      ticketAt = header.indexOf("ticket");
      at = header.indexOf("parent");
      if (at !== -1) return l;
      widened = true;
      at = header.length;
      return `${l}\tparent`;
    }
    const cells = l.split("\t");
    if (widened) cells.push("");
    const parent = parents.get(cells[ticketAt]) ?? "";
    if (parent !== "" && cells[at] !== parent) {
      cells[at] = parent;
      set += 1;
    }
    return cells.join("\t");
  });
  return { text: out.join("\n"), set, widened };
}

function main() {
  const die = makeDie(NAME);
  const F = defineFlags(die, { flags: { features: "value" } });
  F.sweep();
  F.stray();
  const file = resolve(F.arg("features") ?? DEFAULT_FEATURES);
  let text;
  let tickets;
  try {
    text = readFileSync(file, "utf8");
    tickets = [...new Set(parseFeatures(text).map((r) => Number(r.ticket)))];
  } catch (e) {
    die(`${file}: ${e.message}`);
  }
  const parents = new Map();
  let missed = 0;
  for (const [n, got] of ghAliasedRead(tickets, { field: "issue", selection: "{body}", timeoutMs: GH_TIMEOUT_MS })) {
    if (typeof got.node?.body === "string") {
      parents.set(String(n), sliceParent(got.node.body));
      continue;
    }
    missed += 1;
    process.stderr.write(`${NAME}: issue #${n} ${got.notFound ? "not found" : `unreadable (${got.unreachable ?? "no body"})`} — its rows are left as they were\n`);
  }
  const filled = fillParent(text, parents);
  if (filled.text !== text) {
    try {
      writeFileSync(`${file}.tmp`, filled.text);
      renameSync(`${file}.tmp`, file);
    } catch (e) {
      // A .tmp the rename left behind goes too; one that cannot be removed is
      // overwritten by the next run, and the die message names the failure.
      try { rmSync(`${file}.tmp`, { force: true }); } catch {}
      die(`${file}: cannot write: ${e.message}`);
    }
  }
  const slices = [...parents.values()].filter((p) => p !== "").length;
  process.stdout.write(`${NAME}: ${file}: parent set on ${filled.set} row${filled.set === 1 ? "" : "s"}${filled.widened ? ", parent column added" : ""}; ${slices} of ${parents.size} ticket${parents.size === 1 ? "" : "s"} read are Slices\n`);
  if (missed > 0) process.exitCode = 1;
}

if (isCLI(import.meta.url)) main();
