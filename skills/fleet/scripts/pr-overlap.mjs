#!/usr/bin/env node
// Report file/module/directory overlap between two PRs.
//
// This computes the three signals of run-merge-bot.md's hold rule. It REPORTS
// them and never reaches a verdict: "a fired signal is not a verdict — disprove
// it" is judgement, and a script that ruled would recreate the blind-obey
// failure the rule exists to prevent.
//
// Exit 0 for every verdict, `none` included. Exit 2 when the answer is unknown —
// bad usage, or a query failed.

import { execFileSync } from "node:child_process";
import { writeSync } from "node:fs";
import { basename, dirname } from "node:path";

const NAME = "pr-overlap";

// writeSync, not console.error: stderr on a pipe is async and the exit below
// discards what is still queued, so a large forwarded child stderr swallows
// this line — the refusal is queued last and dropped first (#176). The leading
// newline is load-bearing: writeSync goes straight to the fd while the stream
// is still draining, so without it this text lands mid-line inside the child's
// output and stops matching every line-anchored reader.
function die(msg) {
  writeSync(2, `\n${NAME}: ${msg}\n`);
  process.exit(2);
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
}

const a = arg("a");
const b = arg("b");
if (!a || !b) die("usage: pr-overlap.mjs --a <pr> --b <pr>");

function changedFiles(pr) {
  console.error(`$ gh pr diff ${pr} --name-only`);
  let out;
  try {
    out = execFileSync("gh", ["pr", "diff", String(pr), "--name-only"], {
      encoding: "utf8",
    });
  } catch (e) {
    // Names the cause, never gh's stderr — execFileSync forwarded it already
    // (no `stdio` above), so interpolating it emits every byte twice, and this
    // is the biggest payload of the fleet scripts. `e.message` is the same
    // string, not a fallback: Node builds it as `Command failed:\n<stderr>`.
    // Three disjoint shapes — Node-aborted (ENOENT/ENOBUFS), signal, exit (#176).
    die(
      `gh pr diff ${pr} failed: ${
        e.code ?? (e.signal ? `killed by ${e.signal}` : `exit ${e.status}`)
      }`,
    );
  }
  const files = out.split("\n").map((s) => s.trim()).filter(Boolean);
  // Fail closed: a PR with no changed files is not a legitimate "no overlap"
  // answer, it is a query that did not work. Silence must never read as data.
  if (files.length === 0) die(`PR ${pr} reported zero changed files — refusing to answer`);
  for (const f of files) console.error(`    ${f}`);
  return files;
}

const filesA = changedFiles(a);
const filesB = changedFiles(b);

const intersect = (xs, ys) => {
  const set = new Set(ys);
  return [...new Set(xs)].filter((v) => set.has(v)).sort();
};

// A repo mid-migration has src/…/foo.test.ts in one PR and
// tests/unit/…/foo.test.ts in the other: same module, zero shared paths. That
// migration case is what this signal exists for, and it is a TypeScript-module
// notion — so only files whose extension is actually stripped participate.
//
// Matching on bare basenames instead produces confident nonsense: two PRs each
// touching their own README.md, or their own hooks.json, reported as sharing a
// "module". Measured in the proving ground: README.md ×8, SKILL.md ×6,
// mcp-snippet.json ×9, hooks.json ×5 across unrelated directories. Returning
// null for those drops them from the signal entirely rather than caveating them.
const moduleOf = (f) => {
  const b = basename(f);
  if (b.endsWith(".test.ts")) return b.slice(0, -".test.ts".length);
  if (b.endsWith(".ts")) return b.slice(0, -".ts".length);
  return null;
};
const modulesOf = (fs) => fs.map(moduleOf).filter((m) => m !== null);

// Repo root is excluded: every top-level file shares it, so it fires on PRs
// with nothing whatsoever in common.
const dirsOf = (fs) => fs.map(dirname).filter((d) => d !== ".");

const files = intersect(filesA, filesB);
const modules = intersect(modulesOf(filesA), modulesOf(filesB));
const dirs = intersect(dirsOf(filesA), dirsOf(filesB));

const signal = files.length ? "files" : modules.length ? "modules" : dirs.length ? "dirs" : "none";

console.error(`\n${NAME}: signal=${signal} files=${files.length} modules=${modules.length} dirs=${dirs.length}`);
if (signal === "dirs") {
  console.error(
    `${NAME}: directory-only hit — weak evidence. A bare top-level directory\n` +
      `  (docs, tests, src) fires on PRs with different subjects. Read the files.`,
  );
}
if (signal === "modules") {
  // The hold rule this mechanises calls a module match a verdict, on a par with
  // a shared file. It is not one: `types.ts` ×13 and `index.ts` ×10 live in
  // unrelated subtrees of the proving ground, so two PRs can share a "module"
  // name and nothing else. Say so, because the caller's rule will not.
  console.error(
    `${NAME}: module-only hit — confirm before treating as a verdict. Common\n` +
      `  TypeScript basenames (types.ts, index.ts) recur across unrelated\n` +
      `  subtrees, so a shared name is not yet a shared module: ${modules.join(", ")}`,
  );
}

console.log(JSON.stringify({ a: Number(a), b: Number(b), files, modules, dirs, signal }));
