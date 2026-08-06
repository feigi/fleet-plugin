#!/usr/bin/env node
// Size a PR's diff and classify its files, so a review can scale its fan-out to
// the change instead of running the full specialist set on an 8-line docs edit.
//
// The fleet docs already SAY "two or three specialists for annotation-only or
// single-file, the full set for production code" — in two places — but nothing
// computes the diff, so the default is the full set every time. This turns that
// judgement into one deterministic call. `review-pr.js` reads the booleans;
// a human reads `profile`.
//
// Facts only. It does NOT decide which dimensions to run — that policy lives in
// the caller, next to the dimension list it owns. `docsOnly`/`hasTests`/`hasSrc`
// are chosen so the caller's selection is a clean expression over them.
//
// `classify` and `computeStats` are pure and exported so the classifier is
// unit-tested (diff-stats.test.mjs) without a live `gh`; the CLI runs only when
// this file is executed directly.

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const NAME = "diff-stats";

// Classification is by path — the cheapest signal that separates "prose" from
// "code" — and priority-ordered because a test file is also a .ts file: test
// wins over src, docs and config are named explicitly, src is the residue.
export const isTest = (p) => /(\.|_)(test|spec)\.[cm]?[jt]sx?$/i.test(p) || /(^|\/)(__tests__|tests?|e2e|__mocks__)\//i.test(p);
export const isDocs = (p) => /\.(md|mdx|markdown|txt|rst|adoc)$/i.test(p) || /(^|\/)docs?\//i.test(p) || /(^|\/)(README|CHANGELOG|LICENSE|CONTRIBUTING)(\.|$)/i.test(p);
export const isConfig = (p) =>
  /\.(ya?ml|toml|ini|cfg|conf|json|json5|lock|env)$/i.test(p) ||
  /(^|\/)\.github\//i.test(p) ||
  /\.config\.[cm]?[jt]s$/i.test(p) ||
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|\.[a-z]+rc)$/i.test(p);

// A runnable-code extension (.js/.cjs/.mjs/.ts/.tsx/.jsx/…), and the naming
// convention that marks a code file as config regardless of where it sits.
const isCodeExt = (p) => /\.[cm]?[jt]sx?$/i.test(p);
const isConfigName = (p) => /\.config\.[cm]?[jt]sx?$/i.test(p);

export function classify(p) {
  if (isTest(p)) return "test";
  // A code file is `src` even under docs/ or .github/. Path-based docs/config
  // rules must not swallow executable code — a docs-site generator or a
  // composite-action script — or the src-gated dimensions (types, silent-failure,
  // simplify) silently never run on real code. Exception: `*.config.{js,ts,…}` is
  // config by naming convention.
  if (isCodeExt(p) && !isConfigName(p)) return "src";
  if (isDocs(p)) return "docs";
  if (isConfig(p)) return "config";
  return "src";
}

// Turn the `gh --json files` array (per-file additions/deletions) into the facts
// the caller selects dimensions from. Pure: no I/O, so it is directly testable.
// `docsOnly` is deliberately strict — purely docs, no src/test/config — so a docs
// PR that also nudges a CI workflow keeps its fuller review. `hasSrc`/`hasTests`
// let the caller drop the `tests`/`types`/`silent-failure`/`simplify` dimensions
// when there is nothing for them.
export function computeStats(files) {
  const kinds = { docs: 0, test: 0, config: 0, src: 0 };
  let loc = 0;
  const paths = [];
  for (const f of files) {
    const kind = classify(f.path);
    kinds[kind] += 1;
    const fileLoc = (f.additions || 0) + (f.deletions || 0);
    loc += fileLoc;
    paths.push({ path: f.path, kind, loc: fileLoc });
  }

  const hasSrc = kinds.src > 0;
  const hasTests = kinds.test > 0;
  const hasConfig = kinds.config > 0;
  const docsOnly = files.length > 0 && !hasSrc && !hasTests && !hasConfig;

  let profile;
  if (files.length === 0) profile = "empty";
  else if (docsOnly) profile = "docs";
  else if (!hasSrc && hasTests) profile = "tests-only";
  else if (files.length === 1) profile = "single-file";
  else if (loc < 30) profile = "small";
  else profile = "production";

  return { files: files.length, loc, kinds, docsOnly, hasSrc, hasTests, hasConfig, profile, paths };
}

// --- CLI (runs only when executed directly, never on import) ---------------

function die(msg) {
  console.error(`${NAME}: ${msg}`);
  process.exit(2);
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
}

function run(cmd, args) {
  console.error(`$ ${cmd} ${args.join(" ")}`);
  try {
    return execFileSync(cmd, args, { encoding: "utf8" });
  } catch (e) {
    // Fail closed. A broken query must not read as "empty diff". The harm is not
    // a trim — computeStats([]) yields profile "empty", which review-pr.js
    // WIDENS to the full set. It is that a real production PR would be sized
    // from a lie, and the widen only looks safe until the next caller reads
    // these facts for something else.
    die(`${cmd} failed: ${String(e.stderr || e.message).trim()}`);
  }
}

function main() {
  const pr = arg("pr");
  if (!pr) die("usage: diff-stats.mjs --pr <number>");

  const info = JSON.parse(run("gh", ["pr", "view", String(pr), "--json", "files"]));
  // Same fail-closed rule as run() above, and the one place it was missing: `||
  // []` turned a malformed response into a fully-formed `profile: "empty"`
  // measurement, exit 0, indistinguishable on stdout from a real empty PR. That
  // is the lie the comment in run() warns about, manufactured one line later.
  if (!Array.isArray(info.files)) die("gh returned no files array");
  const stats = computeStats(info.files);

  console.error(
    `    ${NAME}: pr=${pr} files=${stats.files} loc=${stats.loc} ` +
      `docs=${stats.kinds.docs} test=${stats.kinds.test} config=${stats.kinds.config} src=${stats.kinds.src} → ${stats.profile}`,
  );

  console.log(JSON.stringify({ pr: Number(pr), ...stats }));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
