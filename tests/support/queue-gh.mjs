// A `gh` stub for `ledger.mjs dispatch merge-bot`, which records the open
// `ready-to-merge` queue gh lists on the bot's `## Dispatched` entry: `gh pr
// list` answers `prs` as that queue, and any other gh call fails loudly. Shell
// builtins only, so it runs under a PATH holding nothing else.
//
// Deliberately not a `.test.mjs`, so `node --test` never loads it as a suite.

import { join } from "node:path";
import { writeExecStub } from "./exec-stub.mjs";

/** Writes `<bin>/gh` answering `gh pr list` with the PR numbers `prs`. */
export function writeQueueGh(bin, prs = []) {
  writeExecStub(join(bin, "gh"), `#!/bin/sh
[ "$1 $2" = "pr list" ] || { printf 'gh stub: unexpected gh %s\\n' "$*" >&2; exit 64; }
printf '%s\\n' '${JSON.stringify(prs.map((number) => ({ number })))}'
`);
}
