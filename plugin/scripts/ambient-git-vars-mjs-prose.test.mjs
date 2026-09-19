// #1599. ambient-git-vars-prose.test.mjs's own header says why it cannot see
// this file's subject: its scan is `readdirSync(DIR).filter(n =>
// n.endsWith(".sh"))` and its detector is the literal shell line `unset
// GIT_DIR GIT_WORK_TREE` — neither exists in a `.mjs` script, where there is
// no shell to `unset` in and a caller scrubs by building the CHILD's env
// instead. This file is the census #1020 asked to be re-derived, re-derived
// for the language the original could not see.
//
// Two design questions the ticket posed, and the answer each got:
//
//   Detector shape. A source scan for "a spawn whose options carry a
//   scrubbed env" has no single-line anchor the way `unset GIT_DIR
//   GIT_WORK_TREE` is one in shell — env objects are built in as many shapes
//   as there are call sites (compare `ledger.mjs`'s pre-existing inline
//   `delete gitEnv.GIT_DIR` against `repo-root.mjs`'s three separate spawns,
//   each merging its own extra keys). `git-env.mjs`'s `gitEnv()` helper turns
//   the detector back into a one-name grep — does a file's git-invoking
//   primitive route its env through `gitEnv(`? — the same job `unset GIT_DIR
//   GIT_WORK_TREE` does for shell. See git-env.mjs's own header for the rest
//   of that reasoning, including why the two pre-existing inline sites below
//   are not retroactively migrated to call it.
//
//   Per-site ruling. Six files were uncensused; measuring each (not copying
//   one script's reason across the set — #1020's own PR found a prescribed
//   shared reason false at one of five sites) found something #1020 did not:
//   every one of them is exposed on AT LEAST one of the two variables, most
//   on both, and one half being inert is the exception here, not the rule
//   `ambient-git-vars-prose.test.mjs`'s own three `.sh` cases show. Nothing
//   below is EXEMPT — the two-way split that file's `COVERED`/`EXEMPT`
//   pair encodes has no membership on the EXEMPT side yet in this file, so
//   that dict is not declared here at all; a future `.mjs` file measured
//   inert on both variables is what would first populate it, with its own
//   measurement, the same discipline `EXEMPT` enforces below the `COVERED`
//   list in that file.
//
// What this file does NOT pin: per-site behaviour, or that EVERY git-naming
// line in a COVERED file individually reaches `gitEnv(`. That lives in each
// file's own test file, behaviourally — ledger.test.mjs, pr-overlap.test.mjs,
// repo-root.test.mjs, ci-state.test.mjs, staleness.test.mjs — where a mutation
// that deletes any ONE of a multi-site file's scrub calls (repo-root.mjs
// carries three separate ones) reds exactly the fixture built for that site
// and leaves its siblings green; that per-site isolation is what a source
// count here cannot tell apart from a file that merely happens to mention
// `gitEnv(` once for an unrelated reason. What IS pinned here, as source, is
// the same reason `ambient-git-vars-prose.test.mjs` pins its own detector as
// source: the exact number of `gitEnv(` call expressions a file's own git
// calls need is a fact about that file, derived once below by reading it
// (see COVERED_MJS's own comments) and it cannot silently drop without this
// file noticing — a deleted call changes the count.
//
// Also pinned: the two pre-existing inline scrub sites — `fleet-state.mjs`'s
// `statePath()` and `ledger.mjs`'s tracker-query probe — the "two-name-only
// exemption list" the second design question above answers with. Neither is
// migrated to call `gitEnv()`: `fleet-state.mjs` is explicitly out of #1599's
// scope (already fixed and covered, by PR #1598) and `ledger.mjs`'s
// tracker-query scrub is likewise already measured and covered
// (`ledger.test.mjs`, "an inherited GIT_DIR or GH_REPO cannot retarget the
// query…") — touching either to satisfy this file's own detector would be
// churn with no behavioural change. `MJS_LEGACY_INLINE` records both by name
// with the measurement that already settled each, so a reader does not have
// to re-derive why they are not `gitEnv(` call sites.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { stripComments } from "./strip-comments.mjs";

const DIR = fileURLToPath(new URL(".", import.meta.url));
const read = (f) => readFileSync(join(DIR, f), "utf8");

/**
 * A git-invoking primitive in `.mjs` source: `spawnSync`/`execFileSync`
 * called with the literal string `"git"`, or a same-shaped wrapper
 * (`tryRun("git", …)`, `run("git", …)`) called the identical way — the
 * spelling every one of this directory's git callers actually uses, measured
 * against the whole directory (see this file's own final test). Comments are
 * stripped first (`stripComments`), the same instrument
 * `ambient-git-vars-prose.test.mjs`'s own `codeLines` is for its shell
 * detector, so a call site named only in a paragraph cannot satisfy this.
 *
 * Deliberately NOT anchored to `spawnSync`/`execFileSync` by name: a file
 * whose git calls all route through a locally-defined wrapper (`staleness.mjs`'s
 * `git(args)`, called as `git(["rev-parse", …])`) never spells `"git"` as an
 * argument at its OWN call sites — only once, where the wrapper is defined.
 * The broader match still finds that file, through the definition line, which
 * is all file-level discovery needs.
 */
const GIT_CALL_MJS = /\b\w+\(\s*(?:"git"|'git')/;

const codeLines = (src) =>
  stripComments(src).split("\n").map((l, i) => ({ n: i + 1, l })).filter(({ l }) => l.trim() !== "");

const usesGit = (src) => codeLines(src).some(({ l }) => GIT_CALL_MJS.test(l));

// The files whose git-invoking primitive(s) route their env through
// `gitEnv()` — this ticket's fix. Each value is the exact number of
// `gitEnv(` call EXPRESSIONS the file's own code carries today, derived once
// by reading it rather than guessed, and written out rather than computed
// from the git-call count above: the two numbers disagree on purpose in the
// two files with a wrapper indirection (ci-state.mjs's `tryRun`,
// staleness.mjs's `git`), where several named call sites share ONE spawn
// primitive and therefore one scrub.
const COVERED_MJS = {
  // Three separate `spawnSync`/`execFileSync` calls, no shared wrapper —
  // `isTrackedBy()`, `repoRoot()`, `trackedShellScripts()` — each with its
  // own `gitEnv(…)` call. Measured per site in repo-root.test.mjs: GIT_DIR
  // and GIT_WORK_TREE are each exposed on at least one of the three, and
  // `isTrackedBy`'s absolute pathspec is exposed on BOTH — no half here is
  // inert the uniform way `ambient-git-vars-prose.test.mjs`'s `inflight.sh`/
  // `derive-testcmd.sh` are.
  "repo-root.mjs": 3,
  // ONE spawn primitive (`tryRun`), reused for both this file's named git
  // call sites (`workflowsPath()`'s rev-parse, the behind-count block's
  // `remote get-url origin`) and for every `gh` call in the file — scrubbing
  // once at the primitive protects both, and is harmless for `gh`, which
  // reads neither name.
  "ci-state.mjs": 1,
  // ONE spawn primitive (`git(args)`), reused for all four of this file's
  // named git call sites (`rev-parse --show-toplevel`, then three `-C root`
  // calls) — same shape as ci-state.mjs's `tryRun`, one scrub for the whole
  // set.
  "staleness.mjs": 1,
  // ONE spawn primitive, `trackedBasenameCounts()`'s own `git ls-files -z`.
  "pr-overlap.mjs": 1,
  // ONE of `ledger.mjs`'s TWO git-invoking primitives — `defaultLedgerPath()`,
  // #1599's own measured hazard (an ambient GIT_DIR relocated the run's
  // ledger into another repository, silently, at exit 0). The file's OTHER
  // primitive, the tracker-query probe, is `MJS_LEGACY_INLINE` below, not a
  // second `gitEnv(` call — it predates the helper and is already covered on
  // its own terms.
  "ledger.mjs": 1,
};

// The two-name-only exemption list #1599's second design question answers
// with: sites that scrub GIT_DIR/GIT_WORK_TREE without calling `gitEnv()`,
// because each already carries its own measurement and its own behavioural
// fixture, predating this helper, and retrofitting either to satisfy this
// file's detector would be churn with no behavioural change.
const MJS_LEGACY_INLINE = {
  "fleet-state.mjs":
    "statePath() — `{ ...process.env }` then two `delete`s, inline. Fixed and covered by PR #1598 " +
    "(fleet-heartbeat.test.mjs); out of #1599's scope by the ticket's own words.",
  "ledger.mjs":
    "the tracker-query probe inside runCheck() — `const gitEnv = { ...process.env, GH_REPO: \"\" }` then two " +
    "`delete`s, inline (predates and shares a name with, but does not call, this directory's `gitEnv()` helper). " +
    "Measured and covered in ledger.test.mjs, \"an inherited GIT_DIR or GH_REPO cannot retarget the query…\".",
};

for (const [f, count] of Object.entries(COVERED_MJS)) {
  test(`${f} routes its git call(s) through gitEnv(), ${count} call site(s)`, () => {
    const src = read(f);
    assert.ok(usesGit(src),
      `${f} appears to invoke no git at all, so this assertion would hold vacuously — either the file stopped using git (move it out of COVERED_MJS) or GIT_CALL_MJS no longer recognises the spelling it uses`);
    const actual = (stripComments(src).match(/gitEnv\(/g) ?? []).length;
    assert.equal(actual, count,
      `${f} carries ${actual} \`gitEnv(\` call(s), expected ${count}. A lower count means a scrub was deleted from one of this ` +
      "file's git-invoking primitives — see this file's own header comment for which call sites exist and why each needs one. " +
      "A higher count is a call site COVERED_MJS does not know about yet; update the count here once its own behavioural fixture exists.");
  });
}

for (const [f, reason] of Object.entries(MJS_LEGACY_INLINE)) {
  test(`${f}'s legacy inline scrub is recorded with its own measurement`, () => {
    assert.ok(usesGit(read(f)), `${f} is recorded in MJS_LEGACY_INLINE but no longer invokes git — delete the entry`);
    assert.ok(reason.length > 40, `${f}'s MJS_LEGACY_INLINE entry must carry the measurement that settled it, not a placeholder`);
  });
}

// The census, and the reason it is a test rather than a paragraph — the same
// reason `ambient-git-vars-prose.test.mjs`'s own closing test gives: a new
// `.mjs` script that shells out to git now has to make a decision — call
// `gitEnv()` and add it to COVERED_MJS with its own behavioural fixture, or
// record why not — instead of inheriting the exposure by default.
test("every .mjs script that invokes git either routes through gitEnv() or is recorded on the legacy-inline list", () => {
  const scripts = readdirSync(DIR).filter((n) => n.endsWith(".mjs") && !n.endsWith(".test.mjs")).sort();
  assert.ok(scripts.length > 0, "fixture: no .mjs files found, so this scan would pass over nothing");

  const gitUsers = scripts.filter((f) => usesGit(read(f)));
  const accounted = new Set([...Object.keys(COVERED_MJS), ...Object.keys(MJS_LEGACY_INLINE)]);
  const unaccounted = gitUsers.filter((f) => !accounted.has(f));

  assert.deepEqual(unaccounted, [],
    "a .mjs file invokes git and is neither in COVERED_MJS nor MJS_LEGACY_INLINE: route its call(s) through " +
    "git-env.mjs's gitEnv(), add it to COVERED_MJS with the number of gitEnv( call sites and a behavioural fixture " +
    "in its own test file per call site (measured, not copied from another file's reason) — or, if an ambient " +
    "GIT_DIR/GIT_WORK_TREE measurably cannot make every one of its git calls answer wrongly, record it with that " +
    "measurement instead. Do not simply widen either list.");

  // Every COVERED_MJS/MJS_LEGACY_INLINE entry must really be a git-invoking
  // .mjs file in this directory, or a rename/removal would leave its entry
  // pinning a file the scan above no longer sees.
  for (const f of accounted) {
    assert.ok(scripts.includes(f), `${f} is recorded above but is not a .mjs file in this directory`);
  }
});
