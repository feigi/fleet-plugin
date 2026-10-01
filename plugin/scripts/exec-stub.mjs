// Executable stubs for test fixtures, at one new executable inode per process.
//
// macOS holds the FIRST direct exec of every newly created executable inode
// for a system scan: 1.2-1.9s measured on an idle machine, and unbounded under
// load. A second exec of the same inode costs ~0.01s, and so does exec'ing a
// HARD LINK to an already-scanned inode (~0.03s), while a `cp` of one is a new
// inode and pays the scan again (1.35s). A fixture that writes a fresh `gh` or
// `git` stub per case therefore pays that scan once per case.
//
// So every stub this module writes is a hard link to ONE trampoline, written
// and exec'd once per process, and the stub's own body goes in a plain,
// non-executable file beside it that the trampoline reads. Reading a file is
// not an exec, so a body may differ in every case, interpolate per-case paths,
// or be rewritten mid-case, for free. Per-case state stays per case because
// the body file lives in the caller's own directory.
//
// The trampoline locates the body from `$0`, which for a PATH lookup is the
// absolute path of the link that was found: `<dir>/<name>` reads
// `<dir>/.<name>.stub`. A `#!/bin/sh` body is SOURCED, so it runs in the same
// shell with the same `$0` (the stub's own path) and `"$@"` it would have had
// as a script of its own, and its `exit`/`exec` end the stub as before. Any
// other interpreter line (`#!/usr/bin/env node`) is exec'd with the body file
// as its script, the way the kernel would have run it.
//
// Not a fit, and left to a plain write, wherever the executable ITSELF is
// under test: its mode bits, its freshness, a rewrite through an existing
// link, or a script that reads the executable's content rather than running
// it. `chmod` or `writeFileSync` on a stub path would reach the shared inode,
// which is why the trampoline is 0o555: an accidental write into it fails
// EACCES instead of silently rewriting every stub in the process.
//
// Deliberately not a `.test.mjs`, so `node --test` never loads it as a suite.

import { spawnSync } from "node:child_process";
import { linkSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

// `__stub`/`__stub_l` rather than short names: a sourced body shares this
// shell's variables, and one that tests `$s` or `$l` must not find them set.
const TRAMPOLINE = `#!/bin/sh
__stub="\${0%/*}/.\${0##*/}.stub"
IFS= read -r __stub_l < "$__stub"
case $__stub_l in
'#!/bin/sh') unset __stub_l; . "$__stub" ;;
*) exec \${__stub_l#??} "$__stub" "$@" ;;
esac
`;

// Written and exec'd at import, so the scan is paid before any case starts and
// never against a case's own timeout. Removed at exit rather than in a
// node:test `after()`: an import has no test to hang a hook on, and one hung on
// whichever test first wrote a stub would pull the inode out from under the
// rest of the file. Unbounded on purpose: a first exec killed before the scan
// finishes leaves it unpaid.
const trampoline = (() => {
  const dir = mkdtempSync(join(tmpdir(), "exec-stub-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "trampoline");
  writeFileSync(path, TRAMPOLINE, { mode: 0o555 });
  writeFileSync(join(dir, ".warm.stub"), "#!/bin/sh\nexit 0\n");
  linkSync(path, join(dir, "warm"));
  const warm = spawnSync(join(dir, "warm"));
  if (warm.status !== 0) throw new Error(`exec-stub: trampoline warm-up failed: ${warm.error ?? warm.stderr}`);
  return path;
})();

/**
 * Make `path` an executable that behaves as `body` would as a script of its own.
 *
 * Replaces whatever is at `path`. Calling it again on the same path swaps the
 * body and leaves the shared inode untouched. `body` must start with a `#!`
 * line, since that line is what selects how the trampoline runs it.
 */
export function writeExecStub(path, body) {
  if (!body.startsWith("#!")) throw new Error(`exec-stub: body for ${path} has no #! line`);
  writeFileSync(join(dirname(path), `.${basename(path)}.stub`), body);
  rmSync(path, { force: true });
  linkSync(trampoline, path);
}
