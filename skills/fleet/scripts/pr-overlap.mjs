#!/usr/bin/env node
// Report file/module/directory overlap between two PRs.
//
// This computes the three signals of run-merge-bot.md's hold rule. It REPORTS
// them and never reaches a verdict: "a fired signal is not a verdict — disprove
// it" is judgement, and a script that ruled would recreate the blind-obey
// failure the rule exists to prevent.
//
// Exit 0 for every verdict, `none` included. Exit 2 only when a query failed and
// the answer is therefore unknown.

import { execFileSync } from "node:child_process";
import { basename, dirname } from "node:path";

const NAME = "pr-overlap";

function die(msg) {
  console.error(`${NAME}: ${msg}`);
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
    die(`gh pr diff ${pr} failed: ${String(e.stderr || e.message).trim()}`);
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
// tests/unit/…/foo.test.ts in the other: same module, zero shared paths.
const moduleOf = (f) => basename(f).replace(/\.test\.ts$/, "").replace(/\.ts$/, "");

// Repo root is excluded: every top-level file shares it, so it fires on PRs
// with nothing whatsoever in common.
const dirsOf = (fs) => fs.map(dirname).filter((d) => d !== ".");

const files = intersect(filesA, filesB);
const modules = intersect(filesA.map(moduleOf), filesB.map(moduleOf));
const dirs = intersect(dirsOf(filesA), dirsOf(filesB));

const signal = files.length ? "files" : modules.length ? "modules" : dirs.length ? "dirs" : "none";

console.error(`\n${NAME}: signal=${signal} files=${files.length} modules=${modules.length} dirs=${dirs.length}`);
if (signal === "dirs") {
  console.error(
    `${NAME}: directory-only hit — weak evidence. A bare top-level directory\n` +
      `  (docs, tests, src) fires on PRs with different subjects. Read the files.`,
  );
}

console.log(JSON.stringify({ a: Number(a), b: Number(b), files, modules, dirs, signal }, null, 2));
