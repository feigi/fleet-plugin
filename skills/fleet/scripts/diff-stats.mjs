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

import { execFileSync } from "node:child_process";

const NAME = "diff-stats";

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
    // Fail closed. A broken query must not read as "empty diff" — that would
    // silently trim a real production PR down to two specialists.
    die(`${cmd} failed: ${String(e.stderr || e.message).trim()}`);
  }
}

const pr = arg("pr");
if (!pr) die("usage: diff-stats.mjs --pr <number>");

// `--json files` carries per-file additions/deletions, so loc needs no patch
// fetch. Classification is by path — the cheapest signal that separates "prose"
// from "code" — and priority-ordered because a test file is also a .ts file:
// test wins over src, docs and config are named explicitly, src is the residue.
const info = JSON.parse(run("gh", ["pr", "view", String(pr), "--json", "files"]));
const files = info.files || [];

const isTest = (p) => /(\.|_)(test|spec)\.[cm]?[jt]sx?$/i.test(p) || /(^|\/)(__tests__|tests?|e2e|__mocks__)\//i.test(p);
const isDocs = (p) => /\.(md|mdx|markdown|txt|rst|adoc)$/i.test(p) || /(^|\/)docs?\//i.test(p) || /(^|\/)(README|CHANGELOG|LICENSE|CONTRIBUTING)(\.|$)/i.test(p);
const isConfig = (p) =>
  /\.(ya?ml|toml|ini|cfg|conf|json|json5|lock|env)$/i.test(p) ||
  /(^|\/)\.github\//i.test(p) ||
  /\.config\.[cm]?[jt]s$/i.test(p) ||
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|\.[a-z]+rc)$/i.test(p);

function classify(p) {
  if (isTest(p)) return "test";
  if (isDocs(p)) return "docs";
  if (isConfig(p)) return "config";
  return "src";
}

const kinds = { docs: 0, test: 0, config: 0, src: 0 };
let loc = 0;
const paths = [];
for (const f of files) {
  const kind = classify(f.path);
  kinds[kind] += 1;
  loc += (f.additions || 0) + (f.deletions || 0);
  paths.push({ path: f.path, kind, loc: (f.additions || 0) + (f.deletions || 0) });
}

// Booleans the caller selects dimensions from. `docsOnly` is deliberately
// strict — purely docs, no src/test/config — so a docs PR that also nudges a CI
// workflow keeps its fuller review. `hasSrc`/`hasTests` let the caller drop the
// `tests`/`types`/`silent-failure` dimensions when there is nothing for them.
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

console.error(
  `    ${NAME}: pr=${pr} files=${files.length} loc=${loc} ` +
    `docs=${kinds.docs} test=${kinds.test} config=${kinds.config} src=${kinds.src} → ${profile}`,
);

console.log(
  JSON.stringify({ pr: Number(pr), files: files.length, loc, kinds, docsOnly, hasSrc, hasTests, hasConfig, profile, paths }),
);
