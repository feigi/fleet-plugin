import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Every read of the Recipe's Test entrypoint that run-team and next-ticket
// tell the controller to make judges the cache against `origin/main`, the tree
// the claim and the proof already judge it against. A bare read runs the
// vacuous-suite probe over the main checkout's own index, and that checkout
// falls behind `origin/main` mid-run: a test glob that matches only files
// merged since then reads as matching nothing, and a Recipe that holds refuses.
// The Install step reads probe no glob and stay as they are.
const PLUGIN = join(import.meta.dirname, "..", "plugin");
const SKILLS = {
  "run-team": readFileSync(join(PLUGIN, "skills/run-team/SKILL.md"), "utf8"),
  "next-ticket": readFileSync(join(PLUGIN, "skills/next-ticket/SKILL.md"), "utf8"),
};

// A Test entrypoint read, written out (`derive-testcmd.sh <repo> test`) or
// elided after a sibling read (`` `… . test` ``). Flags may precede the
// repository argument, which may be a placeholder with spaces in it
// (`<main checkout>`), a quoted path, or a `$(…)` substitution. Matched across a
// line wrap, since a read may be reflowed over two lines. The pin ends at a
// token boundary, so `--at origin/main-old` is a different ref.
const TEST_READ = /(?:derive-testcmd\.sh|`…)(?:\s+--?[\w-]+)*\s+(?:<[^>]*>|"[^"]*"|\$\([^)]*\)|\S+)\s+test\b/g;
const AT_ORIGIN_MAIN = /^\s+--at\s+origin\/main(?![\w/-]|\.\w)/;

function testReads(text) {
  return [...text.matchAll(TEST_READ)].map((m) => ({
    read: m[0].replace(/\s+/g, " "),
    atOriginMain: AT_ORIGIN_MAIN.test(text.slice(m.index + m[0].length)),
  }));
}

test("the Test entrypoint read scanner accepts a read at origin/main and ignores the Install step read", () => {
  const reads = testReads(
    "`fleet-run derive-testcmd.sh .\n  install` and `fleet-run derive-testcmd.sh . test --at origin/main`, " +
      "`derive-testcmd.sh <main checkout> test\n  --at origin/main`, `… . test --at origin/main`",
  );
  assert.deepEqual(
    reads.map((r) => r.atOriginMain),
    [true, true, true],
    "the scanner should find exactly the three Test entrypoint reads, each at origin/main",
  );
});

test("the Test entrypoint read scanner flags a read with no --at origin/main", () => {
  const reads = testReads("`derive-testcmd.sh . test` and `derive-testcmd.sh <main checkout> test --at HEAD` and `… . test`");
  assert.deepEqual(
    reads.map((r) => r.atOriginMain),
    [false, false, false],
  );
});

test("the Test entrypoint read scanner finds flagged, quoted and substituted repository arguments and holds the pin to origin/main exactly", () => {
  const reads = testReads(
    '`derive-testcmd.sh --json . test --at origin/main` `derive-testcmd.sh "<a b>" test --at origin/main` ' +
      "`derive-testcmd.sh $(git rev-parse --show-toplevel) test --at origin/main` " +
      "`derive-testcmd.sh . test --at origin/main-old` `derive-testcmd.sh . test --at origin/main.bak` " +
      "`derive-testcmd.sh . test --at origin/main`.",
  );
  assert.deepEqual(
    reads.map((r) => r.atOriginMain),
    [true, true, true, false, false, true],
    "flagged, quoted and substituted reads are found, and a ref that merely starts with origin/main is not origin/main",
  );
});

for (const [name, text] of Object.entries(SKILLS)) {
  test(`${name}: every read of the Recipe's Test entrypoint carries --at origin/main`, () => {
    const reads = testReads(text);
    assert.ok(reads.length > 0, `${name}/SKILL.md names no Test entrypoint read, so this pin checks nothing`);
    const bare = reads.filter((r) => !r.atOriginMain).map((r) => r.read);
    assert.deepEqual(bare, [], `${name}/SKILL.md reads the Test entrypoint against the main checkout's index, not origin/main`);
  });
}
