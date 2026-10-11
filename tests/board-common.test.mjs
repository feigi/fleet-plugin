// execRead() — the asynchronous child read every board.mjs gather and tick goes
// through — has to keep doing the one thing execFileSync did without being
// asked: re-emit the child's captured stderr onto its own, on the arm where the
// child succeeded and on the one where it failed. Driven in a child process,
// because the subject is what reaches THIS process's stderr, which a test
// cannot capture from inside itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tempDir } from "./support/temp-dir.mjs";
import { writeExecStub } from "./support/exec-stub.mjs";

const COMMON_URL = pathToFileURL(new URL("../plugin/scripts/board-common.mjs", import.meta.url).pathname).href;

function readThroughExecRead(stubBody) {
  const bin = tempDir("board-common-bin-");
  writeExecStub(join(bin, "gh"), stubBody);
  const driver = `import { execRead } from ${JSON.stringify(COMMON_URL)};
    process.stdout.write(JSON.stringify(await execRead("gh", [])));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", driver], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(r.status, 0, r.stderr);
  return { stderr: r.stderr, record: JSON.parse(r.stdout) };
}

test("execRead re-emits the stderr of a child that succeeded", () => {
  const { stderr, record } = readThroughExecRead("#!/bin/sh\necho child-stderr-marker >&2\necho out\nexit 0\n");
  assert.equal(stderr, "child-stderr-marker\n");
  assert.deepEqual(record, { stdout: "out\n", error: null, status: 0, code: null, signal: null });
});

test("execRead re-emits the stderr of a child that failed, and reports its exit code in `status`", () => {
  const { stderr, record } = readThroughExecRead("#!/bin/sh\necho child-stderr-marker >&2\nexit 3\n");
  assert.equal(stderr, "child-stderr-marker\n");
  assert.equal(record.status, 3);
  assert.equal(record.code, null);
  assert.equal(record.signal, null);
});
