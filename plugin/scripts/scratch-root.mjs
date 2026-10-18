#!/usr/bin/env node
// The fleet's scratch root for this repository, printed as an absolute path.
//
// scratch-root.mjs
//
// `~/.fleet/scratch/<repo-key>/`, computed by fleet-dir.mjs's scratchRoot() —
// the same path from the main checkout and from any linked worktree, a
// different one for each workspace — a second clone, a bare repository, a
// submodule — even where folder names collide. Nothing is
// written to `.fleet/` or anywhere else to record it: the controller (and any
// standalone entry point with no dispatcher) runs this again and gets the same
// answer. The controller writes the printed path, absolute, into the prompt of
// every member it dispatches; a member never runs this to build a root of its
// own.
//
// The root is created (`mkdir -p`) once it passes the refusal below.
//
// Exit 0: the path on stdout, nothing else. Exit 1: the root would sit inside
// a git work tree that does not ignore it — the reason, naming the work tree,
// on stderr, and nothing created. Exit 2: usage, no repository to key on, or the
// root could not be created (a filesystem fault, not a refusal).

import { mkdirSync } from "node:fs";
import { makeDie } from "./arg.mjs";
import { FleetDirUnresolvable, scratchRoot, scratchRootRefusal } from "./fleet-dir.mjs";
import { isCLI } from "./is-cli.mjs";

const NAME = "scratch-root";

function main() {
  const die = makeDie(NAME);
  if (process.argv.length > 2) die(`takes no arguments, got: ${process.argv.slice(2).join(" ")}`);
  let root;
  try {
    root = scratchRoot();
  } catch (e) {
    if (!(e instanceof FleetDirUnresolvable)) throw e;
    die(e.message);
  }
  const refusal = scratchRootRefusal(root);
  if (refusal !== null) {
    process.stderr.write(`${NAME}: ${refusal}\n`);
    process.exitCode = 1;
    return;
  }
  try {
    mkdirSync(root, { recursive: true });
  } catch (e) {
    die(`could not create ${root}: ${e.message}`);
  }
  process.stdout.write(`${root}\n`);
}

if (isCLI(import.meta.url)) main();
