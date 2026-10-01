// exec-stub.mjs: every stub is a link to one shared trampoline, and the body
// lives in a file beside it. What a fixture relies on is that a stub still
// behaves as its body would as a script of its own, and that one stub's body
// never leaks into another's through the shared inode.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeExecStub } from "./exec-stub.mjs";

function bins(t, n) {
  return Array.from({ length: n }, () => {
    // A space in the path: the trampoline locates the body from `$0`, and an
    // unquoted expansion of it would split here.
    const d = mkdtempSync(join(tmpdir(), "exec stub-"));
    t.after(() => rmSync(d, { recursive: true, force: true }));
    return d;
  });
}

test("a sh stub found on PATH sees its own path, its argv, its stdin, and exits with its own status", (t) => {
  const [bin] = bins(t, 1);
  writeExecStub(join(bin, "gh"), `#!/bin/sh\nprintf '%s|' "$0" "$#" "$@"\nread -r line; printf '%s' "$line"\nexit 7\n`);
  const r = spawnSync("gh", ["a b", "", "c"], {
    input: "from stdin\n", encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(r.status, 7, r.stderr);
  assert.equal(r.stdout, `${join(bin, "gh")}|3|a b||c|from stdin`);
});

test("rewriting one stub changes that stub alone, never another written from the same process", (t) => {
  const [a, b] = bins(t, 2);
  writeExecStub(join(a, "tool"), "#!/bin/sh\necho a1\n");
  writeExecStub(join(b, "tool"), "#!/bin/sh\necho b1\n");
  writeExecStub(join(a, "tool"), "#!/bin/sh\necho a2\n");
  assert.equal(spawnSync(join(a, "tool"), { encoding: "utf8" }).stdout, "a2\n");
  assert.equal(spawnSync(join(b, "tool"), { encoding: "utf8" }).stdout, "b1\n");
});

test("a body for another interpreter runs under that interpreter, argv intact", (t) => {
  const [bin] = bins(t, 1);
  writeExecStub(join(bin, "gh"), "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\nprocess.exit(3);\n");
  const r = spawnSync(join(bin, "gh"), ["x y", "z"], { encoding: "utf8" });
  assert.equal(r.status, 3, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), ["x y", "z"]);
});

test("a body with no #! line is refused, since that line is what picks the interpreter", (t) => {
  const [bin] = bins(t, 1);
  assert.throws(() => writeExecStub(join(bin, "gh"), "exit 0\n"), /no #! line/);
});
