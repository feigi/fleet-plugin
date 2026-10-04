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
// `<dir>/.stub-<name>`. That name ends in the stub's own name, so the body file
// has whatever extension the stub itself had (none, for `gh` or `node`): node
// picks a loader by extension, and a suffix of our own would make it refuse a
// `#!/usr/bin/env node` body under an `--import` preload or a `"type":
// "module"` package, where the extensionless script it replaced still runs.
//
// A `#!/bin/sh` body, exactly that line, is SOURCED, so it runs in the same
// shell with the same `$0` (the stub's own path) and `"$@"` it would have had
// as a script of its own, and its `exit`/`exec` end the stub as before. It
// also sees `__stub`, the body file's path, which the `.` that sources it
// needs. Any other interpreter line (`#!/usr/bin/env node`, `#!/bin/sh -e`,
// `#!/bin/bash`) is exec'd with the body file as its script, the way the
// kernel would have run the stub, with one difference: that body's own path —
// `$0`, `process.argv[1]` — is the body file, not the stub. Its arguments,
// stdin and exit status are the stub's.
//
// Not a fit, and left to a plain write, wherever the executable ITSELF is
// under test: its mode bits, its freshness, a rewrite through an existing
// link, or a script that reads the executable's content rather than running
// it. Nor reached through a symlink from another directory: `$0` is then the
// symlink, and no body file sits beside it. `chmod` or `writeFileSync` on a
// stub path would reach the shared inode, which is why the trampoline is
// 0o555: an accidental write into it fails EACCES instead of silently
// rewriting every stub in the process — for any user but root, whose writes
// mode bits do not stop.
//
// Deliberately not a `.test.mjs`, so `node --test` never loads it as a suite.

import { spawnSync } from "node:child_process";
import { linkSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tempDir } from "./temp-dir.mjs";

// `__stub`/`__stub_l` rather than short names: a sourced body shares this
// shell's variables, and one that tests `$s` or `$l` must not find them set.
const TRAMPOLINE = `#!/bin/sh
__stub="\${0%/*}/.stub-\${0##*/}"
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
  const dir = tempDir("exec-stub-");
  const path = join(dir, "trampoline");
  writeFileSync(path, TRAMPOLINE, { mode: 0o555 });
  writeFileSync(join(dir, ".stub-trampoline"), "#!/bin/sh\nexit 0\n");
  const warm = spawnSync(path);
  if (warm.status !== 0) throw new Error(`exec-stub: trampoline warm-up failed: ${warm.error ?? warm.stderr}`);
  return path;
})();

/**
 * Make `path` an executable that runs `body` as a script of its own would,
 * with the `$0` difference the header describes for a body that is not
 * `#!/bin/sh`.
 *
 * Replaces whatever is at `path`. Calling it again on the same path swaps the
 * body and leaves the shared inode untouched. `body` must start with a `#!`
 * line, since that line is what selects how the trampoline runs it.
 */
export function writeExecStub(path, body) {
  if (!body.startsWith("#!")) throw new Error(`exec-stub: body for ${path} has no #! line`);
  writeFileSync(join(dirname(path), `.stub-${basename(path)}`), body);
  rmSync(path, { force: true });
  linkSync(trampoline, path);
}
