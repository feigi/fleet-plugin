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
import { makeDie, makeArg, makeSweep, makeStray } from "./arg.mjs";

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
//
// `changedFiles` is the PR's UNCAPPED file count, and it is a second argument
// because `files` is capped: `gh pr view --json files` pages at 100 and exits 0
// with no warning (measured on microsoft/vscode#329568 — `files` 100 against
// `changedFiles` 124). Every fact below is then computed off a short list with
// nothing in the blob contradicting it: `loc` under-counts, `docsOnly` can flip
// because the src files fell off the end, and `paths` is what `review-pr.js`
// puts in front of a specialist under "and no others". `truncated` is set ONLY
// when the two counts disagree, so it is absent on every normal PR and the
// caller can treat its presence as "this list is short by construction".
export function computeStats(files, changedFiles) {
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

  const stats = { files: files.length, loc, kinds, docsOnly, hasSrc, hasTests, hasConfig, profile, paths };
  if (Number.isInteger(changedFiles) && changedFiles > files.length) stats.truncated = changedFiles;
  return stats;
}

// --- CLI (runs only when executed directly, never on import) ---------------

// die()/arg() shared with the other fleet scripts — see arg.mjs for the
// fail-open (#61/#169) and pipe-safety (#176/#328) rationale. `--pr` is the
// only flag read here, and the `if (!pr) die(...)` below already caught a
// trailing `--pr` on its own — `undefined` is falsy — so this file was never
// a silent-widening site the way ci-state.mjs's was; the shared arg() just
// makes the refusal explicit and immediate, naming the flag.
const die = makeDie(NAME);
const arg = makeArg(die);
const sweep = makeSweep(die);
const stray = makeStray(die);

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
    // Names the cause, never the child's stderr — execFileSync forwarded it
    // already (no `stdio` above), so interpolating it emits every byte twice:
    // measured 7,700 B becoming 15,454 B, into review-pr.js's snapshot agent,
    // which is markdown read by a model. `e.message` is the same string, not a
    // fallback — Node builds it as `Command failed: <cmd>\n<stderr>`. Three
    // disjoint shapes: Node-aborted (ENOENT/ENOBUFS), signal, exit (#176).
    die(
      `${cmd} failed: ${e.code ?? (e.signal ? `killed by ${e.signal}` : `exit ${e.status}`)}`,
    );
  }
}

function main() {
  const pr = arg("pr");
  if (!pr) die("usage: diff-stats.mjs --pr <number>");
  // #365, weaker here for the same reason as pr-overlap.mjs: `--pr` is
  // required, so a misspelled `--prr 5` already fell through to the usage die
  // above. What was silently ignored at exit 0 is a stray riding along with a
  // good `--pr` (`--pr 5 --base main`), and that is what this closes.
  //
  // Inside main(), never at module scope: computeStats() is imported by
  // diff-stats.test.mjs and select-dimensions.test.mjs, and a module-scope
  // sweep would read the IMPORTER's argv. (review-pr runs this script as a
  // CLI subprocess with its own argv, so it is not one of those importers.)
  // Below the guard above, so `--pr --json` keeps #169's "--pr needs a value".
  sweep(["pr"]);
  // #463: sweep() only refuses a `--`-prefixed token; a bare or single-dash
  // one (`--pr 42 basee`) rode along in silence the same way. This file
  // takes no positional, so any leftover token is a stray.
  stray(["pr"]);

  // Parsed through a guard, not bare. gh can exit 0 with a non-JSON body — a
  // proxy's HTML error page is the measured case — and an uncaught SyntaxError
  // exits 1, a code this script does not define (die is 2, success 0). Same
  // fail-closed rule as run() above: a broken response is not an empty diff.
  // `changedFiles` rides the same query for free and is the only thing that
  // reveals the 100-file cap on `files` — see computeStats.
  const raw = run("gh", ["pr", "view", String(pr), "--json", "files,changedFiles"]);
  let info;
  try {
    info = JSON.parse(raw);
  } catch {
    die(`gh pr view ${pr} returned no JSON — ${raw.trim().slice(0, 120)}`);
  }
  // Same fail-closed rule as run() above, and the one place it was missing: `||
  // []` turned a malformed response into a fully-formed `profile: "empty"`
  // measurement, exit 0, indistinguishable on stdout from a real empty PR. That
  // is the lie the comment in run() warns about, manufactured at the
  // `computeStats` call this guard protects.
  if (!info) die("gh returned no body");
  if (!Array.isArray(info.files)) die("gh returned no files array");
  const stats = computeStats(info.files, info.changedFiles);

  console.error(
    `    ${NAME}: pr=${pr} files=${stats.files} loc=${stats.loc} ` +
      `docs=${stats.kinds.docs} test=${stats.kinds.test} config=${stats.kinds.config} src=${stats.kinds.src} → ${stats.profile}` +
      (stats.truncated ? ` (TRUNCATED: gh listed ${stats.files} of ${stats.truncated} files)` : ""),
  );

  console.log(JSON.stringify({ pr: Number(pr), ...stats }));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
