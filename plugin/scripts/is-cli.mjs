// The "was this module run as the CLI?" guard every fleet script ends with:
//
//   if (isCLI(import.meta.url)) main();
//
// Compared by realpath, never as strings. `import.meta.url` is the module's
// resolved file; `argv[1]` is whatever path the caller typed. Reached through
// a symlinked path (on macOS `/tmp` is one) or a relative one, the two differ
// as strings, main() is skipped, and the process exits 0 with no output —
// indistinguishable from a run that had nothing to say, and for a gate that is
// the code that means ok. Resolving both sides makes the answer independent of
// how node was invoked.
//
// A path that cannot be resolved (`node -`, a REPL, a module loaded by a
// wrapper that gave argv[1] no file) is not a CLI run: false, not a throw —
// the module may be nothing but imported.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function isCLI(metaUrl, argv1 = process.argv[1]) {
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}
