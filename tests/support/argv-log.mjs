// An argv-preserving call record for a `#!/bin/sh` stub.
//
// A stub that logs `"$*"` flattens its argv into one line, so an argument with
// a space in it reads the same whether the caller quoted it or let it
// word-split. This record keeps each call's argv whole: the argument count on
// a line, then one argument per line.
//
// Deliberately not a `.test.mjs`, so `node --test` never loads it as a suite.

import { readFileSync } from "node:fs";

/**
 * The shell statement that appends the current call's argv to `path`. `path`
 * is interpolated as written, so it must hold no `"`, `$` or backquote.
 */
export const recordArgv = (path) => `{ printf '%s\\n' "$#"; for a do printf '%s\\n' "$a"; done; } >> "${path}"`;

/** Every call recordArgv() appended to `path`, each one its argv array. */
export function argvRecords(path) {
  const lines = readFileSync(path, "utf8").split("\n");
  const calls = [];
  for (let i = 0; i < lines.length - 1; ) {
    const count = Number(lines[i]);
    calls.push(lines.slice(i + 1, i + 1 + count));
    i += 1 + count;
  }
  return calls;
}
