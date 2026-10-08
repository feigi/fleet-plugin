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
// repo-root.test.mjs, staleness.test.mjs — where a mutation
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
// Also pinned: the pre-existing inline scrub site — `ledger.mjs`'s
// tracker-query probe — the "two-name-only exemption list" the second design
// question above answers with. It is not migrated to call `gitEnv()`: it is
// already measured and covered (`ledger.test.mjs`, "an inherited GIT_DIR or
// GH_REPO cannot retarget the query…") — touching it to satisfy this file's
// own detector would be churn with no behavioural change. `MJS_LEGACY_INLINE`
// records it by name with the measurement that already settled it, so a
// reader does not have to re-derive why it is not a `gitEnv(` call site.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { stripComments } from "./support/strip-comments.mjs";

const DIR = fileURLToPath(new URL("../plugin/scripts", import.meta.url));
const read = (f) => readFileSync(join(DIR, f), "utf8");

/**
 * A git-invoking primitive in `.mjs` source: `spawnSync`/`execFileSync`
 * called with the literal string `"git"`, or a same-shaped wrapper
 * (`tryRun("git", …)`, `run("git", …)`) called the identical way — the
 * spelling every one of plugin/scripts/'s git callers actually uses, measured
 * against all of plugin/scripts/ (see this file's own final test). Comments are
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

// Joined back into one string before testing, not tested one physical line
// at a time: a git-invoking call formatted across physical lines (mirrors
// ledger.mjs's own tracker-query `execFileSync("gh", [...], {...})` shape,
// its first argument and its options object each on their own line) never
// puts `(` and `"git"` on the same physical line, so a per-line test never
// sees it (measured, #1599 review) — `GIT_CALL_MJS`'s `\s*` already matches
// a newline; testing the whole joined string is what lets it use that.
const codeLines = (src) => stripComments(src).split("\n").filter((l) => l.trim() !== "");

const usesGit = (src) => GIT_CALL_MJS.test(codeLines(src).join("\n"));

/**
 * Drop a trailing `//` comment from one line. Quote-aware: `stripComments()`
 * only blanks a comment that is its own whole line (its own documented
 * ceiling) and leaves `code; // note` untouched, so prose merely NAMING
 * `gitEnv(` in a trailing comment would otherwise inflate the call count
 * below — measured (#1599 review): deleting a real `gitEnv()` scrub call
 * while leaving a trailing comment elsewhere in the file that mentions
 * `gitEnv(` left the count below unchanged, silently. A `//` inside a
 * string literal (a URL) is not a comment start and must not truncate real
 * code at it.
 */
function stripTrailingSlashComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === "'" || c === '"' || c === "`") {
      quote = c;
    } else if (c === "/" && line[i + 1] === "/") {
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * The number of real `gitEnv(` call EXPRESSIONS a file's own code carries —
 * comments dropped at both granularities `stripComments()` covers
 * (whole-line, block) and the one it does not (a trailing `// note`), so a
 * comment that merely names `gitEnv(` cannot mask a deleted scrub call
 * sitting elsewhere in the same file.
 */
const countGitEnvCalls = (src) =>
  (codeLines(src).map(stripTrailingSlashComment).join("\n").match(/gitEnv\(/g) ?? []).length;

// The files whose git-invoking primitive(s) route their env through
// `gitEnv()` — this ticket's fix. Each value is the exact number of
// `gitEnv(` call EXPRESSIONS the file's own code carries today, derived once
// by reading it rather than guessed, and written out rather than computed
// from the git-call count above: the two numbers disagree on purpose in
// staleness.mjs, whose `git` wrapper is ONE spawn primitive several named
// call sites share, and therefore one scrub.
const COVERED_MJS = {
  // Three separate `spawnSync`/`execFileSync` calls, no shared wrapper —
  // `isTrackedBy()`, `repoRoot()`, `trackedFiles()` (behind all three of
  // `trackedPaths()`, `trackedShellScripts()` and `trackedNodeScripts()`) —
  // each with its own `gitEnv(…)` call. Measured per site in
  // repo-root.test.mjs: GIT_DIR and GIT_WORK_TREE are each exposed on at
  // least one of the three, and `isTrackedBy`'s absolute pathspec is exposed
  // on BOTH — no half here is inert the uniform way
  // `ambient-git-vars-prose.test.mjs`'s `inflight.sh`/`derive-testcmd.sh` are.
  "repo-root.mjs": 3,
  // ONE spawn primitive (`git(args)`), reused for all four of this file's
  // named git call sites (`rev-parse --show-toplevel`, then three `-C root`
  // calls) — one scrub for the whole set.
  "staleness.mjs": 1,
  // ONE spawn primitive, `trackedBasenameCounts()`'s own `git ls-files -z`.
  "pr-overlap.mjs": 1,
  // ONE git-invoking primitive, `fleetFile()`'s `rev-parse --git-common-dir`
  // — the probe behind every `.fleet/`-rooted file a run keeps: the ledger,
  // the heartbeat's state, the shortlist, the cost guard and the cockpit's
  // state directory. An ambient GIT_DIR answers it for a DIFFERENT
  // repository, which would put the run's file in that repository's
  // workspace, silently, at exit 0. Measured in fleet-dir.test.mjs, "an
  // ambient GIT_DIR naming another repository does not move the answer".
  "fleet-dir.mjs": 1,
  // ONE git-invoking primitive, `readInstruments()`'s `rev-parse
  // --git-common-dir`, which names the checkout instruments.sh is sent to
  // audit. An ambient GIT_DIR answers it for a DIFFERENT repository, so the
  // gate would certify that tree's instrument set, at exit 0. Measured in
  // merge-gate.test.mjs, "an ambient GIT_DIR cannot move the audited
  // instrument set into another repository". Its other children (gh,
  // `node ci-state.mjs`, `sh instruments.sh`) name no git.
  "merge-gate.mjs": 1,
  // ONE spawn primitive, `git(args, cwd)`, behind both of the file's git calls
  // — `resolveMainRoot()`'s `rev-parse --git-common-dir` and `checkIgnored()`'s
  // `check-ignore` (#1411). An ambient GIT_DIR would answer the first for
  // another repository, so the guard would compare a member's write against
  // the wrong checkout and let a main-checkout write through. Measured in
  // member-write-guard.test.mjs, "an ambient GIT_DIR naming another repository
  // does not change the answer".
  "member-write-guard.mjs": 1,
  // ONE spawn primitive, `git(what, args, cwd, env)`, behind both of the
  // file's git calls — `resolveMainCheckout()`'s `rev-parse --git-common-dir`
  // and `snapshot()`'s `status --porcelain -uall` (#2210). An ambient GIT_DIR
  // would answer both for another repository, so the tick would compare —
  // and `--record` would baseline — the wrong tree. Measured in
  // main-checkout.test.mjs, "an ambient GIT_DIR naming another repository
  // does not change the answer (#1599)".
  "main-checkout.mjs": 1,
  // ONE spawn primitive, `git(repo, args, what)`, behind every one of the
  // file's git calls — the merge-base against `origin/main`, the diffs the
  // touched lines come from, and `rev-parse --show-toplevel` (#2342). An
  // ambient GIT_DIR would answer each of them for another repository and
  // judge the record against that repository's diff. Measured in
  // dispositions-check.test.mjs, "an ambient GIT_DIR naming another
  // repository does not change the answer". A second
  // `gitEnv(` call scrubs the `gh issue view` child that reads back where each
  // deferral was filed: gh resolves its repository from the cwd's git
  // remotes, so an ambient GIT_DIR would read another repository's tracker.
  // Measured in dispositions-check.test.mjs, "gh is run from the repository
  // with no ambient GIT_DIR".
  "dispositions-check.mjs": 2,
  // ONE scrubbed env, built once and handed to every child — the `git(args,
  // cwd)` primitive behind the common-dir, origin/main, worktree, status and
  // diff calls, AND the one `sh -c` runner of the Install step, the Test
  // entrypoint and the mutation. An ambient GIT_DIR would answer the first for
  // another repository and run the Recipe against that repository's tree while
  // the cache landed here. Measured in recipe-prove.test.mjs, "an ambient
  // GIT_DIR naming another repository does not change the answer" (the git
  // primitive) and "the Install step and the Test entrypoint run against their
  // own worktree whatever GIT_DIR the caller exports" (the `sh -c` runner). The
  // cache reader child gets the same env but unsets both itself, so no
  // fixture can tell its env apart.
  "recipe-prove.mjs": 1,
  // ONE spawn primitive, `git(args, ok)`, behind every git call the main-gain
  // check makes — the head and base reads, the PR's own author dates, the
  // merge-tree, both diffs and the blame. An ambient GIT_DIR would answer all
  // of them for another repository, which need not hold the head at all, and
  // the hit the fixture plants would go unnamed. Measured in
  // main-gain.test.mjs, "an ambient GIT_DIR naming another repository cannot
  // move the check there".
  "main-gain.mjs": 1,
};

// The two-name-only exemption list #1599's second design question answers
// with: sites that scrub GIT_DIR/GIT_WORK_TREE without calling `gitEnv()`,
// because each already carries its own measurement and its own behavioural
// fixture, predating this helper, and retrofitting either to satisfy this
// file's detector would be churn with no behavioural change.
const MJS_LEGACY_INLINE = {
  "ledger.mjs":
    "the tracker-query probe inside runCheck() — `const queryEnv = { ...process.env, GH_REPO: \"\" }` then two " +
    "`delete`s, inline (predates the `gitEnv()` helper in plugin/scripts/; renamed from `gitEnv` to `queryEnv` so the " +
    "local no longer shadows the module-level import). " +
    "Measured and covered in ledger.test.mjs, \"an inherited GIT_DIR or GH_REPO cannot retarget the query…\".",
};

for (const [f, count] of Object.entries(COVERED_MJS)) {
  test(`${f} routes its git call(s) through gitEnv(), ${count} call site(s)`, () => {
    const src = read(f);
    assert.ok(usesGit(src),
      `${f} appears to invoke no git at all, so this assertion would hold vacuously — either the file stopped using git (move it out of COVERED_MJS) or GIT_CALL_MJS no longer recognises the spelling it uses`);
    const actual = countGitEnvCalls(src);
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

// The unaccounted computation the closing census test below needs, factored
// out so a regression fixture can drive it with a synthetic `scripts`/`read`
// pair instead of writing a throwaway file into the real plugin/scripts/.
const unaccountedGitUsers = (scripts, readSrc, accounted) =>
  scripts.filter((f) => usesGit(readSrc(f))).filter((f) => !accounted.has(f));

// The census, and the reason it is a test rather than a paragraph — the same
// reason `ambient-git-vars-prose.test.mjs`'s own closing test gives: a new
// `.mjs` script that shells out to git now has to make a decision — call
// `gitEnv()` and add it to COVERED_MJS with its own behavioural fixture, or
// record why not — instead of inheriting the exposure by default.
test("every .mjs script that invokes git either routes through gitEnv() or is recorded on the legacy-inline list", () => {
  const scripts = readdirSync(DIR).filter((n) => n.endsWith(".mjs")).sort();
  assert.ok(scripts.length > 0, "fixture: no .mjs files found, so this scan would pass over nothing");

  const accounted = new Set([...Object.keys(COVERED_MJS), ...Object.keys(MJS_LEGACY_INLINE)]);
  const unaccounted = unaccountedGitUsers(scripts, read, accounted);

  assert.deepEqual(unaccounted, [],
    "a .mjs file invokes git and is neither in COVERED_MJS nor MJS_LEGACY_INLINE: route its call(s) through " +
    "git-env.mjs's gitEnv(), add it to COVERED_MJS with the number of gitEnv( call sites and a behavioural fixture " +
    "in its own test file per call site (measured, not copied from another file's reason) — or, if an ambient " +
    "GIT_DIR/GIT_WORK_TREE measurably cannot make every one of its git calls answer wrongly, record it with that " +
    "measurement instead. Do not simply widen either list.");

  // Every COVERED_MJS/MJS_LEGACY_INLINE entry must really be a git-invoking
  // .mjs file in plugin/scripts/, or a rename/removal would leave its entry
  // pinning a file the scan above no longer sees.
  for (const f of accounted) {
    assert.ok(scripts.includes(f), `${f} is recorded above but is not a .mjs file in plugin/scripts/`);
  }
});

// Regression (#1599 review, finding 1): the count above must not be fooled
// by a comment that merely NAMES `gitEnv(` — measured live, deleting a real
// scrub call from repo-root.mjs while leaving a trailing `// gitEnv(x)...`
// comment elsewhere in the file left the whole census suite green.
test("a trailing comment naming gitEnv( cannot mask a deleted scrub call", () => {
  const withCall = 'import { gitEnv } from "./git-env.mjs";\n' +
    'import { spawnSync } from "node:child_process";\n' +
    "\n" +
    "export function probe() {\n" +
    '  return spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", env: gitEnv() });\n' +
    "}\n";
  const scrubDeleted = 'import { spawnSync } from "node:child_process";\n' +
    "\n" +
    "export function probe() {\n" +
    '  return spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }); // gitEnv(x) trailing comment, should not count\n' +
    "}\n";
  assert.equal(countGitEnvCalls(withCall), 1,
    "a real gitEnv() call must be counted once");
  assert.equal(countGitEnvCalls(scrubDeleted), 0,
    "deleting a real gitEnv() scrub call must drop the count to 0 even when a trailing comment elsewhere in the " +
    "file still mentions gitEnv( — the count must not be fooled by prose naming the function");
});

// Regression (#1599 review, finding 2): the git-call detector must not go
// blind on a call formatted across physical lines — measured live, a new
// script with a multi-line git spawn and no gitEnv()/legacy-inline entry
// passed the census (8/8) when it should have failed it.
test("a new .mjs file with a MULTI-LINE git-spawning call and no gitEnv()/legacy-inline entry fails the census", () => {
  // Mirrors ledger.mjs's own tracker-query `execFileSync("gh", [...], {...})`
  // shape: the callee's first argument and its options object each sit on
  // their own physical line, so `(` and `"git"` never share one.
  const multiLineGitCall = 'import { execFileSync } from "node:child_process";\n' +
    "\n" +
    "export function probe(root) {\n" +
    "  return execFileSync(\n" +
    '    "git",\n' +
    '    ["rev-parse", "--show-toplevel"],\n' +
    '    { cwd: root, encoding: "utf8" },\n' +
    "  );\n" +
    "}\n";

  assert.ok(usesGit(multiLineGitCall),
    "a git call split across physical lines must still be detected");

  const scripts = ["repo-root.mjs", "new-uncensused.mjs"];
  const sources = { "repo-root.mjs": read("repo-root.mjs"), "new-uncensused.mjs": multiLineGitCall };
  const accounted = new Set([...Object.keys(COVERED_MJS), ...Object.keys(MJS_LEGACY_INLINE)]);
  const unaccounted = unaccountedGitUsers(scripts, (f) => sources[f], accounted);

  assert.deepEqual(unaccounted, ["new-uncensused.mjs"],
    "a new .mjs file with a multi-line git-spawning call and no gitEnv()/legacy-inline entry must fail the " +
    "census, not pass over it invisibly");
});
