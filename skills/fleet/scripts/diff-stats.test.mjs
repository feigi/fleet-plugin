// Regression gate for the diff-sizing classifier and profile ladder that scale a
// review's fan-out. Zero deps: `node --test skills/fleet/scripts/diff-stats.test.mjs`.
// Locks the load-bearing behaviours a "simplification" could silently break —
// especially that code under docs/ or .github/ keeps `src`, and that a mixed
// docs+src PR is NOT docsOnly (so it keeps the fuller review).

import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, computeStats } from "./diff-stats.mjs";

test("classifier priority: test > code-ext > docs/config-dir", () => {
  // src is the residue
  assert.equal(classify("src/a.ts"), "src");
  assert.equal(classify("workflows/review-pr.js"), "src");
  // test wins even though a .test.ts is also a .ts
  assert.equal(classify("a.test.ts"), "test");
  assert.equal(classify("pkg/__tests__/a.ts"), "test");
  // prose
  assert.equal(classify("README.md"), "docs");
  assert.equal(classify("docs/guide.md"), "docs");
  // config by extension / location / naming convention
  assert.equal(classify(".github/workflows/ci.yml"), "config");
  assert.equal(classify("package.json"), "config");
  assert.equal(classify("vite.config.ts"), "config");
  assert.equal(classify(".eslintrc"), "config");
  // M1: a code file stays `src` even under docs/ or .github/, so the src-gated
  // dimensions (types, silent-failure, simplify) are not silently dropped on it.
  assert.equal(classify("docs/examples/deploy.ts"), "src");
  assert.equal(classify(".github/scripts/action.mjs"), "src");
  assert.equal(classify("packages/x/docs/gen.mjs"), "src");
});

test("computeStats: profile ladder", () => {
  assert.equal(computeStats([]).profile, "empty");
  assert.equal(computeStats([{ path: "a.md", additions: 3, deletions: 1 }]).profile, "docs");
  assert.equal(computeStats([{ path: "a.test.ts", additions: 5, deletions: 0 }]).profile, "tests-only");
  assert.equal(computeStats([{ path: "a.ts", additions: 1, deletions: 0 }]).profile, "single-file");
  assert.equal(
    computeStats([
      { path: "a.ts", additions: 2, deletions: 0 },
      { path: "b.ts", additions: 2, deletions: 0 },
    ]).profile,
    "small",
  );
  assert.equal(
    computeStats([
      { path: "a.ts", additions: 20, deletions: 0 },
      { path: "b.ts", additions: 20, deletions: 0 },
    ]).profile,
    "production",
  );
});

test("computeStats: docsOnly is strict — docs+src keeps the fuller review", () => {
  const docs = computeStats([{ path: "a.md", additions: 3, deletions: 1 }]);
  assert.equal(docs.docsOnly, true);
  assert.equal(docs.hasSrc, false);
  assert.equal(docs.loc, 4);

  const mixed = computeStats([
    { path: "a.md", additions: 2, deletions: 0 },
    { path: "b.ts", additions: 2, deletions: 0 },
  ]);
  assert.equal(mixed.docsOnly, false, "docs+src must not be docsOnly");
  assert.equal(mixed.hasSrc, true);

  // docs + a CI workflow is also not docsOnly (config present)
  const docsPlusCi = computeStats([
    { path: "a.md", additions: 2, deletions: 0 },
    { path: ".github/workflows/ci.yml", additions: 1, deletions: 0 },
  ]);
  assert.equal(docsPlusCi.docsOnly, false);
  assert.equal(docsPlusCi.hasConfig, true);
});

test("computeStats: the four routing booleans are pinned together on a production PR", () => {
  // review-pr.js selectDimensions routes on exactly hasSrc/hasTests/hasConfig/
  // docsOnly. Assert all four at once so any single one flipping is caught here,
  // not only transitively via the profile-ladder test.
  const prod = computeStats([
    { path: "src/a.ts", additions: 5, deletions: 0 },
    { path: "a.test.ts", additions: 5, deletions: 0 },
    { path: "package.json", additions: 1, deletions: 0 },
  ]);
  assert.deepEqual(
    { hasSrc: prod.hasSrc, hasTests: prod.hasTests, hasConfig: prod.hasConfig, docsOnly: prod.docsOnly },
    { hasSrc: true, hasTests: true, hasConfig: true, docsOnly: false },
  );
});

test("classify: extensionless files fall to src (fail-open residue)", () => {
  // The residue default keeps the src-gated dimensions (types/silent-failure/
  // simplify) running on unknown files — the safe direction. Pin it so a future
  // "tidy the residue" edit can't silently reroute unknowns to docs/config.
  assert.equal(classify("Dockerfile"), "src");
  assert.equal(classify("Makefile"), "src");
  assert.equal(classify("bin/deploy"), "src");
  assert.equal(classify("foo.config.mjs"), "config"); // config-by-name still wins
});

test("computeStats: loc tolerates a file missing additions/deletions", () => {
  assert.equal(computeStats([{ path: "a.ts" }]).loc, 0);
  assert.equal(computeStats([{ path: "a.ts", additions: 3 }]).loc, 3);
});
