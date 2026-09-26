// #1856, ruled on #1821 (map #1768). The map's standing rule is that the word
// "wave" is gone: the fleet loop has no waves (ADR 0012), and a word that
// survives in a comment, a notice or a fixture name keeps teaching the unit
// that was retired. #1821 measured 58 lines in 37 files still carrying it after
// the prose tree was clean, and the sweep that emptied that list is only as
// durable as whatever notices the next one. This file is what notices.
//
// SCOPE is every tracked file except the records, which are kept as written:
// `docs/adr/`, `docs/specs/`, `docs/research/` and `docs/metrics/`, matched as
// path PREFIXES from the repo root, so a lookalike directory elsewhere
// (`docs/adrs/`, `plugin/docs/adr/`) is live text and swept. New ADRs and
// dated specs land under those prefixes, so writing history stays free.
//
// EXEMPTIONS are exactly two, and nothing else is one: `CONTEXT.md` lines that
// START with `_Avoid_:` (the glossary names the word in order to retire it),
// and this file, which has to spell the word to look for it. Neither widens
// to its neighbours — an `_Avoid_:` line in any other file, an indented one,
// or a CONTEXT.md body line is still a hit.
//
// The PATTERN is #1821's, case-insensitive: `\bwav(e|es|ed|ing)\b`. The
// boundaries are what keep `microwave`, `wavelength` and `waveform` out; the
// suffix list is what keeps `waves`, `waved` and `waving` in. A tracked file
// NAME is matched too, because every path that cites such a file repeats the
// word; it is reported without a line number.
//
// `git ls-files`, never a directory walk, for the reason
// scripts-path-citation-sweep.test.mjs states: an untracked scratch file must
// never become a false positive. `-z` and a scrubbed env for the reasons
// repo-root.mjs's `trackedFiles` states: git C-quotes an unusual path in its
// default form, and an ambient GIT_DIR silently answers for another
// repository.
//
// KNOWN LIMIT, same as those siblings: needs an ambient `.git` to ask what is
// tracked. Absent one the tree sweep DECLINES with a reason; the scanner's own
// tests below still run.
//
// Zero deps: `node --test plugin/scripts/no-wave.test.mjs`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitEnv } from "./git-env.mjs";
import { repoRoot, skipWithoutRepo } from "./repo-root.mjs";

const DIR = fileURLToPath(new URL(".", import.meta.url));
const ROOT = repoRoot(DIR);
const SKIP_WITHOUT_REPO = skipWithoutRepo(ROOT, "the no-wave sweep over the tracked tree");

const WAVE = /\bwav(?:e|es|ed|ing)\b/i;
const RECORDS = ["docs/adr/", "docs/specs/", "docs/research/", "docs/metrics/"];
// Hardcoded rather than derived: if this file moves, the exemption goes stale
// and the sweep reds on this file's own spelling of the word — loudly, and in
// the direction that gets it fixed.
const SELF = "plugin/scripts/no-wave.test.mjs";
const GLOSSARY = "CONTEXT.md";
const AVOID = "_Avoid_:";

/**
 * Every hit in one tracked file, as `path:line: text` (or `path: file name`
 * for the name itself). Empty for a record or for this file.
 */
function waveHits(path, text) {
  if (path === SELF || RECORDS.some((prefix) => path.startsWith(prefix))) return [];
  const hits = [];
  if (WAVE.test(path)) hits.push(`${path}: file name`);
  text.split("\n").forEach((line, i) => {
    if (!WAVE.test(line)) return;
    if (path === GLOSSARY && line.startsWith(AVOID)) return;
    hits.push(`${path}:${i + 1}: ${line.trim()}`);
  });
  return hits;
}

test("scanner: every word form, in any case, is a hit named by file:line", () => {
  const text = ["clean line", "Wave one", "a per-wave rate", "two waves", "waved it on", "waving", "merge-bot-<WAVE#>"].join("\n");
  assert.deepEqual(waveHits("plugin/x.md", text), [
    "plugin/x.md:2: Wave one",
    "plugin/x.md:3: a per-wave rate",
    "plugin/x.md:4: two waves",
    "plugin/x.md:5: waved it on",
    "plugin/x.md:6: waving",
    "plugin/x.md:7: merge-bot-<WAVE#>",
  ]);
});

test("scanner: a word that merely contains the letters is not a hit", () => {
  // The ACCEPT half. Without the boundaries the gate would refuse ordinary
  // English, and the obvious way to quiet a gate like that is to delete it.
  assert.deepEqual(waveHits("plugin/x.md", "microwave\nwavelength\nwaveform\nwavy\nwaver"), []);
});

test("scanner: the records and CONTEXT.md's _Avoid_: lines are exempt, and nothing that merely resembles them", () => {
  for (const record of ["docs/adr/0012-x.md", "docs/specs/x.md", "docs/research/x.md", "docs/metrics/x.tsv"]) {
    assert.deepEqual(waveHits(record, "no waves"), [], `${record} is a record and must be kept as written`);
  }
  assert.deepEqual(waveHits(SELF, "wave"), [], "this file has to spell the word to look for it");
  assert.deepEqual(waveHits(GLOSSARY, "_Avoid_: queue, pool, wave"), [], "the glossary retires the word by naming it");

  assert.deepEqual(waveHits("docs/adrs/x.md", "wave"), ["docs/adrs/x.md:1: wave"], "a lookalike of a record prefix is live text");
  assert.deepEqual(waveHits("plugin/docs/adr/x.md", "wave"), ["plugin/docs/adr/x.md:1: wave"], "a record prefix matches from the repo root only");
  assert.deepEqual(waveHits("docs/agents/x.md", "wave"), ["docs/agents/x.md:1: wave"], "docs/ outside the four record paths is live text");
  assert.deepEqual(waveHits(GLOSSARY, "The wave is gone."), ["CONTEXT.md:1: The wave is gone."], "a glossary body line is live text");
  assert.deepEqual(waveHits(GLOSSARY, "  _Avoid_: wave"), ["CONTEXT.md:1: _Avoid_: wave"], "only a line that STARTS with _Avoid_: is exempt");
  assert.deepEqual(waveHits("README.md", "_Avoid_: wave"), ["README.md:1: _Avoid_: wave"], "the _Avoid_: exemption is CONTEXT.md's alone");
});

test("scanner: a tracked file whose name carries the word is a hit even when its content is clean", () => {
  assert.deepEqual(waveHits("plugin/workflows/merge-wave.js", "export const meta = {};\n"), [
    "plugin/workflows/merge-wave.js: file name",
  ]);
});

/** Every tracked path, repo-relative — what the rule governs. */
function tracked(root) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", env: gitEnv() })
    .split("\0")
    .filter(Boolean);
}

const FILES = ROOT === null ? [] : tracked(ROOT);

test("the sweep sees the tree it is supposed to police", { skip: SKIP_WITHOUT_REPO }, () => {
  // A guard on the guard: a `git ls-files` that answers nothing turns the
  // sweep below into a vacuous pass over an empty list — green, and blind.
  assert.ok(
    FILES.length > 200,
    `git ls-files returned only ${FILES.length} entries — too few to be this repo's real tree, and the sweep below would pass vacuously`,
  );
  assert.ok(FILES.includes(SELF), `${SELF} is not a tracked path, so its self-exemption names nothing — update SELF`);
  assert.ok(FILES.includes(GLOSSARY), `${GLOSSARY} is not a tracked path, so the _Avoid_: exemption names nothing — update GLOSSARY`);
});

test("no tracked file outside the records carries the word", { skip: SKIP_WITHOUT_REPO }, () => {
  const hits = FILES.flatMap((path) => waveHits(path, readFileSync(join(ROOT, path), "utf8")));
  // `ok` rather than `deepEqual`: the message already lists every hit, one per
  // line, and a structural diff would print the same list a second time.
  assert.ok(
    hits.length === 0,
    `the word is retired outside docs/adr/, docs/specs/, docs/research/ and docs/metrics/ (#1821) — reword each hit:\n${hits.join("\n")}`,
  );
});
