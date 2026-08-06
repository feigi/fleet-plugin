import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// `workflows/review-pr.js` runs a top-level `await pipeline(...)`, so importing
// it executes the workflow. Both functions under test are lifted out of the
// SOURCE TEXT instead — the same technique as `select-dimensions.test.mjs:23-40`
// and `review-pr-testcmd.test.mjs:23-33`, and for the same reason: extraction to
// a module would need `import` to resolve inside the Workflow sandbox ("no
// filesystem or Node.js API access"), which nothing in `workflows/` does, and a
// failed import bricks the fleet's DEFAULT review path.
const REPO = join(import.meta.dirname, "..", "..", "..");
const SOURCE = readFileSync(join(REPO, "workflows", "review-pr.js"), "utf8");

// Each declaration is a top-level `function` whose body contains no line
// starting at column 0 with `}`, so the non-greedy match ends on its own
// closing brace.
function lift(name, signature) {
  const re = new RegExp(`^function ${name}\\(${signature}\\) \\{[\\s\\S]*?^\\}$`, "m");
  const m = SOURCE.match(re);
  assert.ok(m, `review-pr.js no longer declares ${name}(${signature}) at top level — update this test`);
  return new Function(`${m[0]}\nreturn ${name};`)();
}

const usableDiff = lift("usableDiff", "snap");

// A diff that is empty, or that describes a commit other than the snapshot's,
// is worse than no diff: the specialist reads it as authoritative.
test("usableDiff rejects a diff that would lie about the snapshot", () => {
  assert.equal(usableDiff({ head: "aaa" }), null, "no diffPath");
  assert.equal(
    usableDiff({ head: "aaa", diffLines: 40 }),
    null,
    "diffPath absent but diffLines truthy — isolates the diffPath guard from the diffLines guard",
  );
  assert.equal(
    usableDiff({ head: "aaa", diffPath: "/s/pr.diff", diffLines: 0 }),
    null,
    "0-byte diff — `gh pr diff` exits 1 and still leaves the file",
  );
  assert.equal(
    usableDiff({ head: "aaa", diffPath: "/s/pr.diff", diffLines: 40, prHead: "bbb" }),
    null,
    "prHead present and unequal — the diff describes another commit",
  );
});

// The inversion this guard is most likely to get wrong. `gh pr view` can fail
// while `gh pr diff` succeeded; dropping a good diff over a MISSING cross-check
// lets absent input narrow coverage — the `=== true` convention at
// review-pr.js:255-257, inverted.
test("usableDiff accepts when prHead is absent or matching", () => {
  assert.equal(
    usableDiff({ head: "aaa", diffPath: "/s/pr.diff", diffLines: 40 }),
    "/s/pr.diff",
    "missing prHead must not suppress an otherwise good diff",
  );
  assert.equal(
    usableDiff({ head: "aaa", diffPath: "/s/pr.diff", diffLines: 40, prHead: "aaa" }),
    "/s/pr.diff",
  );
});
