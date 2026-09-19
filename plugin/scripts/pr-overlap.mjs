#!/usr/bin/env node
// Report file/module/directory/prose-citation overlap between two PRs.
//
// This computes the four signals of run-merge-bot.md's hold rule. It REPORTS
// them and never reaches a verdict: "a fired signal is not a verdict — disprove
// it" is judgement, and a script that ruled would recreate the blind-obey
// failure the rule exists to prevent.
//
// Exit 0 for every verdict, `none` included. Exit 2 when the answer is unknown —
// bad usage, or a query failed. The fourth signal is the one exception to that
// last clause and says so in its own field: a `prose` scan that could not run
// degrades to `proseUnrun` rather than taking the other three down with it.

import { execFileSync } from "node:child_process";
import { gitEnv } from "./git-env.mjs";
import { basename, dirname, extname } from "node:path";
import { makeDie, makeNumArg, makeSweep, makeStray } from "./arg.mjs";

const NAME = "pr-overlap";

// die()/numArg() shared with the other fleet scripts — see arg.mjs for the
// fail-open (#61/#169/#878) and pipe-safety (#176/#328) rationale. `--a`/`--b`
// given trailing already died via the usage guard below — `undefined` is
// falsy — so this file was never a silent-widening site on its own. But `--a`
// given `--b` as its "value" (`pr-overlap.mjs --a --b 5`) was NOT caught that
// way: `a` becomes the string "--b", passes the falsy check, and only failed
// later as a confusing `gh pr diff --b` error — the shared arg() rejects it
// here, by name, instead.
//
// numArg() rather than arg() because the falsy check missed the other half
// too, and this file is why #878 could not be swept by grepping for
// `arg("pr")`: the same fail-open arrives here under `--a`/`--b`. Measured on
// the pre-fix tree, `--a abc --b def` printed `{"a":null,"b":null,…}` at exit
// 0 carrying a real `signal: "files"` verdict — `gh pr diff` resolves a
// non-numeric ref as a BRANCH, so the overlap underneath was genuine and
// about two PRs nobody named.
const die = makeDie(NAME);
const numArg = makeNumArg(die);
const sweep = makeSweep(die);
const stray = makeStray(die);

// `=== null`, not `!a || !b`: numArg() returns a NUMBER, so `--a 0` — a value
// the caller did give — would otherwise draw the usage line, where gh answers
// it truthfully as no such PR. The usage line stays this file's own and names
// both flags at once, which is exactly why numArg() refuses only the
// MALFORMED half: an absent `--a` has no per-flag wording to give here.
const a = numArg("a");
const b = numArg("b");
if (a === null || b === null) die("usage: pr-overlap.mjs --a <pr> --b <pr>");
// #365, and here it is the WEAKER half of the fix: both flags are required,
// so a misspelling of either (`--aa 5 --b 6`) already fell through to the
// usage die above — refused, just never named. What was NOT refused is a
// stray alongside two good values (`--a 5 --b 6 --quiet`), silently ignored
// at exit 0. The sweep closes that and upgrades the first case's message from
// a usage dump to the offending token. Below the usage guard so the usage
// text still wins where it is the better answer; above the first gh call.
sweep(["a", "b"]);
// #463: sweep() above only refuses a `--`-prefixed token; a bare or
// single-dash one (`--a 5 --b 6 stray`) rode along in silence the same way.
// This file takes no positional, so any leftover token is a stray.
stray(["a", "b"]);

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

// #705: the three signals above compare paths, modules and directories. They
// are structurally blind to a coupling that lives in PROSE — one file naming
// another. The measured case is `docs/metrics/tier-outcomes.tsv`: it is
// append-only, so every fleet run produces a PR touching it, and the
// paragraph that reads it lives in `run-team/SKILL.md`. A PR appending rows
// and a PR rewriting that paragraph edit the same logical section from two
// different files — run-merge-bot.md's own soft signal — and this script
// answered `signal=none` on exactly that pair (#703 vs #704). The clearest
// output the tool has was the one that missed it, which is the dangerous
// direction: `none` licenses a merge.
//
// Derived from the two diffs rather than declared in a `data file → its prose
// consumers` table, because the table was already stale before it could be
// written. #705 recorded ONE consumer of `tier-outcomes` (measured at
// `e540e16`); at `ffa9026` there are eleven — `member-record.mjs`, four
// `*-prose.test.mjs` guards, three specs and run-team's own SKILL.md. A map
// seeded from that ticket would have shipped wrong on day one, which is
// exactly the rot the ticket predicted of it.

// Which files can be CITED, and which can carry a citation. Two explicit
// extension lists, deliberately narrow and deliberately not a file table:
// #705's own objection to deriving this signal is "a broad net and likely
// false positives", so the net is bounded and its bounds are printed with the
// verdict. An extension on neither list does not participate at all.
//
// Data side — an artifact whose meaning lives in prose somewhere else. A
// `.ts` module's consumers are already found by `files`/`modules` above. `.md`
// is deliberately absent: a doc citing a doc is what `dirs` fires on, and
// `SKILL.md` recurs 3× in this repo's 251 tracked files (measured), so it is
// the ambiguous-basename shape `moduleOf` above already refuses to guess at.
const DATA_EXT = new Set([".tsv", ".csv", ".json", ".jsonl", ".ndjson", ".yml", ".yaml", ".toml"]);
// Text side — prose, including prose inside a code comment. That half is not
// hypothetical: run-team/SKILL.md's review section records five production
// PRs whose whole substance was a comment in a `.js`/`.mjs`/`.sh` file.
//
// Disjoint from DATA_EXT on purpose. Adding an extension to both would let a
// file match its own hunks and fire against itself; keep them apart.
const TEXT_EXT = new Set([".md", ".mjs", ".js", ".cjs", ".ts", ".tsx", ".sh", ".bash", ".zsh", ".py", ".txt", ".rst"]);
// Asserted at startup, not only in this comment: an overlapping extension
// would let a file match its own hunks and fire against itself, silently,
// on whichever PR happens to touch it.
for (const ext of DATA_EXT) {
  if (TEXT_EXT.has(ext)) throw new Error(`${NAME}: DATA_EXT and TEXT_EXT both claim ${ext}`);
}

const dataFiles = (fs) => fs.filter((f) => DATA_EXT.has(extname(f)));
const textFiles = (fs) => fs.filter((f) => TEXT_EXT.has(extname(f)));

// A bare basename is usable only when it names ONE file. This is `moduleOf`'s
// measurement one file type over — `types.ts` ×13 and `index.ts` ×10 in the
// proving ground, `README.md` ×8, `hooks.json` ×5 — and the same answer: a
// shared name is not a shared file, so drop it rather than caveat it. Counted
// off the tree instead of listed here, so a data file added tomorrow is
// covered the day it lands and there is nothing to keep up to date.
//
// `null` means the count could not be taken, which is NOT the same as "no
// ambiguity": it narrows matching to full paths and is reported.
let basenameCounts;
let trackedPaths;
let basenameCountsUnrun;
function trackedBasenameCounts() {
  if (basenameCounts !== undefined) return basenameCounts;
  console.error(`$ git ls-files -z`);
  try {
    // -z: a basename count must not be wrong about a path git would otherwise
    // quote. maxBuffer explicitly, for the reason diffOf() states below.
    //
    // GIT_DIR/GIT_WORK_TREE scrubbed (#1599, gitEnv()): measured, an ambient
    // GIT_DIR answers for a DIFFERENT repository regardless of `cwd`,
    // silently, at exit 0 — the count this guard's verdict is based on then
    // comes from whichever repository the ambient variable names, and a
    // basename genuinely unique in the caller's own tree reads as ambiguous
    // (or the reverse), dropping — or wrongly keeping — a citation's bare
    // basename token below.
    const out = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: gitEnv() });
    const counts = new Map();
    const paths = new Set();
    for (const f of out.split("\0")) {
      if (!f) continue;
      paths.add(f);
      const b = basename(f);
      counts.set(b, (counts.get(b) ?? 0) + 1);
    }
    basenameCounts = counts;
    trackedPaths = paths;
  } catch (e) {
    // Same three disjoint shapes changedFiles() and diffOf() name: a git
    // failure with no captured reason is indistinguishable from a clean scan
    // in unrunReasons, which is #705's own failure mode one level in.
    basenameCounts = null;
    trackedPaths = null;
    basenameCountsUnrun = `git ls-files failed: ${
      e.code ?? (e.signal ? `killed by ${e.signal}` : `exit ${e.status}`)
    } — basenames unusable, full paths only`;
  }
  return basenameCounts;
}

// A citation names a file, and naming a file means naming its path or at
// least its extension. Measured on the case this signal exists for: every one
// of run-team/SKILL.md's nine references to the TSV is written
// `docs/metrics/tier-outcomes.tsv` (×7) or `tier-outcomes.tsv` (×2). A bare
// stem (`tier-outcomes`) is never matched — without an extension it is a word
// rather than a reference, and that is where the false positives live.
function tokensFor(dataFile) {
  const tokens = [dataFile];
  const bn = basename(dataFile);
  if (bn === dataFile) return tokens;
  const counts = trackedBasenameCounts();
  if (counts === null) return tokens;
  // Count OTHER owners of the basename: subtract dataFile itself when the
  // pre-PR index already tracks it, so a file the PR merely modifies is not
  // counted as its own rival, and a file the PR ADDS is compared against the
  // full pre-PR set instead of getting a free pass because it isn't in it.
  const others = (counts.get(bn) ?? 0) - (trackedPaths.has(dataFile) ? 1 : 0);
  if (others === 0) tokens.push(bn);
  return tokens;
}

// The whole patch, not `--name-only`. The question is not whether the citing
// file names the data file SOMEWHERE — run-team/SKILL.md always does, in nine
// places, so a whole-file read fires on every PR that touches it at all,
// permanently. The question is whether THIS PR is editing the part that names
// it. #703 touched SKILL.md and scored zero against those tokens in its own
// diff, which is how merge-bot-9 cleared the pair by hand; grepping the diff
// is that measurement, kept and automated.
//
// Context lines count along with added and removed ones, deliberately: prose
// being rewritten NEXT TO a citation is the hazard, and merge-bot-9's own
// clearing grep counted context too.
function diffOf(pr, known) {
  console.error(`$ gh pr diff ${pr}`);
  let out;
  try {
    out = execFileSync("gh", ["pr", "diff", String(pr)], {
      encoding: "utf8",
      // A run-artifact PR appends thousands of rows and blows execFileSync's
      // 1 MiB default as ENOBUFS. This signal is ranked last and must never
      // be the reason the three above become unavailable, so the cliff is
      // raised here and a throw is reported rather than fatal.
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    // Same three disjoint shapes changedFiles() names, and named the same way.
    return {
      hunks: null,
      unrun: `gh pr diff ${pr} failed: ${
        e.code ?? (e.signal ? `killed by ${e.signal}` : `exit ${e.status}`)
      }`,
    };
  }
  const hunks = new Map();
  let unresolved = 0;
  let file = null;
  let inHunk = false;
  for (const line of out.split("\n")) {
    if (line.startsWith("diff --git ")) {
      // Resolved against the authoritative `--name-only` list rather than
      // parsed out of the header: a path containing a space splits a
      // `a/<x> b/<x>` header ambiguously, and a path git chose to quote does
      // not appear literally at all. An unresolvable header leaves `file`
      // null so its hunks are skipped, and is counted — an uncovered file
      // makes an empty result incomplete, not clean.
      file = known.find((f) => line.endsWith(` b/${f}`)) ?? null;
      if (file === null) unresolved++;
      inHunk = false;
      continue;
    }
    if (file === null) continue;
    // `@@ ... @@` is the one line that reliably marks "metadata block ends,
    // hunk body begins". Gating on that state — rather than testing each
    // line's own text for `--- `/`+++ ` — means a hunk-BODY line whose
    // content itself starts with `--` or `++` (a removed line beginning
    // with a real `--` token, or an added one beginning with `++`) is never
    // mistaken for a file header and silently dropped.
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (!/^[+\- ]/.test(line)) continue;
    const lines = hunks.get(file);
    if (lines) lines.push(line);
    else hunks.set(file, [line]);
  }
  return { hunks, unrun: unresolved ? `${pr}: ${unresolved} diff header(s) unresolved — those files were not searched` : null };
}

// One witness per (data file, citing file) pair, most specific token first, so
// a file naming the TSV by both its path and its basename reports once and
// reports the path — while a SECOND file naming it still gets its own witness.
// Stopping at the first token that matches anywhere would report only the one
// file, and it is the set of citing files the caller has to read.
const WITNESS_CAP = 120;
function proseHits(target, citer) {
  const targets = dataFiles(target.files);
  const citers = textFiles(citer.files);
  // Nothing to look for, or nothing that could carry it: a complete answer,
  // and the common case. No `gh pr diff` is spent reaching it.
  if (targets.length === 0 || citers.length === 0) return { hits: [], unrun: null };
  const { hunks, unrun } = diffOf(citer.pr, citer.files);
  if (hunks === null) return { hits: [], unrun };
  const hits = [];
  for (const data of targets) {
    const tokens = tokensFor(data);
    for (const text of citers) {
      const lines = hunks.get(text) ?? [];
      for (const token of tokens) {
        const line = lines.find((l) => l.includes(token));
        if (!line) continue;
        hits.push({
          data,
          citedBy: text,
          token,
          line: line.length > WITNESS_CAP ? `${line.slice(0, WITNESS_CAP)}…` : line,
        });
        break;
      }
    }
  }
  return { hits, unrun };
}

const files = intersect(filesA, filesB);
const modules = intersect(modulesOf(filesA), modulesOf(filesB));
const dirs = intersect(dirsOf(filesA), dirsOf(filesB));

// Both directions. Which PR holds the data and which holds the prose is not
// knowable in advance — #704 appended the rows and #703 held the paragraph,
// and the flags carry no such role.
const ab = proseHits({ pr: a, files: filesA }, { pr: b, files: filesB });
const ba = proseHits({ pr: b, files: filesB }, { pr: a, files: filesA });
const prose = [...ab.hits, ...ba.hits].sort((x, y) =>
  x.data.localeCompare(y.data) || x.citedBy.localeCompare(y.citedBy) || x.token.localeCompare(y.token)
);
// Non-null means `prose` is not a complete answer — the scan was reached and
// could not cover what an empty array would otherwise claim. Without this
// field a failed diff read prints `prose: []`, byte-identical to a clean
// scan: #705's own failure mode — the clearest output being the one that
// misses it — reintroduced one level in. Same reason run-team/SKILL.md reads
// `dimensionsUnrun` beside `dimensionsRun`: an absence of findings is not
// coverage.
const unrunReasons = [ab.unrun, ba.unrun];
if (basenameCounts === null) unrunReasons.push(basenameCountsUnrun);
const proseUnrun = unrunReasons.filter(Boolean).join("; ") || null;

// Ranked BELOW `dirs`, so it can only ever turn a `none` into something. It
// never masks or downgrades one of the three above — and the bug it answers
// is precisely a `none` that should not have been one.
const signal = files.length
  ? "files"
  : modules.length
    ? "modules"
    : dirs.length
      ? "dirs"
      : prose.length
        ? "prose"
        : "none";

console.error(
  `\n${NAME}: signal=${signal} files=${files.length} modules=${modules.length} dirs=${dirs.length} prose=${prose.length}`,
);
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
// Keyed on the count, not on `signal`, unlike the two notes above: a prose
// hit under a `dirs` verdict is stronger evidence than the verdict, and the
// ladder would hide it. The caveat carries the witness because one read
// disproves it — which is how merge-bot-9 settled #703 vs #704 by hand.
if (prose.length) {
  console.error(
    `${NAME}: prose citation — the other PR's diff names a data file this one\n` +
      `  changes. Weak evidence, like a directory hit: read the line. Searched\n` +
      `  ${[...DATA_EXT].join(" ")} as cited, ${[...TEXT_EXT].join(" ")} as citing;\n` +
      `  a bare stem with no extension is never matched.`,
  );
  for (const h of prose) console.error(`    ${h.data} cited by ${h.citedBy} as "${h.token}"\n      ${h.line}`);
}
if (proseUnrun) {
  console.error(
    `${NAME}: prose scan INCOMPLETE — ${proseUnrun}.\n` +
      `  An empty prose[] does not clear the same-section case here.`,
  );
}

console.log(JSON.stringify({ a, b, files, modules, dirs, prose, proseUnrun, signal }));
