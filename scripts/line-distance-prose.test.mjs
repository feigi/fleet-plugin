import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, extname, basename } from "node:path";

// #765 swept comments that located a construct by counting lines ("two-lines-up",
// "one-line-later", "a-few-lines-down"). Every one had rotted: the count was
// wrong because something had been inserted since. #769 then swept the same
// defect spelled with no numeral at all — a bare "the-line-above" — which no
// numeral-word alternation can reach however many synonyms it lists. This gate
// keeps both out; the remedy for either is to name the construct, carrying the
// file when the construct lives in another one.
//
// Comment blocks are STITCHED before matching. One site escaped four separate
// single-line enumerations because its phrase straddled a comment break — the
// count ended one line and the direction began the next, so no line-oriented
// grep could see it. Joining consecutive comment lines first is the whole point
// of this file; a per-line scan reproduces the miss.
//
// Everything hyphenated in this header for the same reason the pattern below is
// assembled from parts: spelled normally, the gate would trip on its own
// rationale. That is asserted, not hoped for.
//
// Out of class, and deliberately unreachable by the pattern: counts over named
// units ("the-two-cases-above") count semantic units and survive reflow;
// ordinal forms ("first-line", "last-line") describe output data rather than
// pointing at source; a size ("the-same-40-lines") is not a position.

const DIR = fileURLToPath(new URL(".", import.meta.url));
const SELF = basename(fileURLToPath(import.meta.url));
// The CI helper scripts carry the same prose and the same rot. Scoping to one
// directory is what let #769's sites sit outside the previous gate's reach.
const DIRS = [DIR, fileURLToPath(new URL("../.github/scripts/", import.meta.url))];

const COUNT = "(?:one|two|three|four|five|six|seven|eight|nine|ten|a\\s+few|several|\\d+)";
const WHERE = "(?:up|down|above|below|later|earlier|further\\s+(?:up|down))";
// The bare form takes no numeral, so it needs its own arm. Narrower direction
// set on purpose: "the-line-up" is not English, and widening it buys nothing
// while risking prose that never pointed at a line.
const BARE = "(?:above|below|before|after)";
// Assembled from parts, never written out as a literal instance, so this file
// can scan itself without tripping — proven by the self-scan assertion below.
const IDIOM = new RegExp(`\\b(?:${COUNT}\\s+lines?\\s+${WHERE}|the\\s+lines?\\s+${BARE})\\b`, "i");

const MARKER = { ".sh": "#", ".mjs": "//", ".js": "//" };

function commentBlocks(src, marker) {
  const re = new RegExp(`^\\s*${marker}\\s?(.*)$`);
  // A trailing comment is its own one-line block, never stitched to the next
  // line's. Whole-line-only is the stripper bug this repo has already been
  // bitten by: a gate that kills `<marker> whole-line` is walked straight
  // through by `code; <marker> trailing`, and the idiom reads the same in both.
  // Leading whitespace is required before the marker so `$#`, `${#v}`, `#!` and
  // a `//` inside a URL are not read as comment openers.
  const trail = new RegExp(`\\s${marker}\\s?(.*)$`);
  const out = [];
  let cur = null;
  const close = () => { if (cur) out.push({ line: cur.line, text: cur.parts.join(" ") }); cur = null; };
  src.split("\n").forEach((line, i) => {
    const m = line.match(re);
    if (m) { (cur ??= { line: i + 1, parts: [] }).parts.push(m[1]); return; }
    close();
    const t = line.match(trail);
    if (t) out.push({ line: i + 1, text: t[1] });
  });
  close();
  return out;
}

function hitsIn(src, marker) {
  return commentBlocks(src, marker).filter((b) => IDIOM.test(b.text));
}

function sweep(dirs, skipSelf = true) {
  const hits = [];
  let scanned = 0;
  for (const dir of dirs) {
    for (const f of readdirSync(dir)) {
      if (skipSelf && f === SELF) continue;
      const marker = MARKER[extname(f)];
      if (!marker) continue;
      scanned++;
      for (const b of hitsIn(readFileSync(join(dir, f), "utf8"), marker)) {
        const m = b.text.match(IDIOM);
        hits.push(`${f}:${b.line}  …${b.text.slice(Math.max(0, m.index - 45), m.index + m[0].length + 15)}…`);
      }
    }
  }
  return { hits, scanned };
}

test("no comment locates a construct by a line distance", () => {
  const { hits, scanned } = sweep(DIRS);
  // Without this the whole gate passes vacuously the day the walk reads nothing.
  assert.ok(scanned > 50, `swept only ${scanned} files — the walk is not reaching these directories`);
  assert.deepEqual(hits, [], `line-distance comment(s) reintroduced — name the construct, drop the distance:\n${hits.join("\n")}`);
});

// The walk must reach the CI helpers, not just this directory. Asserted by name
// rather than by count, so landing another helper here does not red the gate.
test("the walk reaches the CI helper scripts too", () => {
  const seen = DIRS.flatMap((d) => readdirSync(d)).filter((f) => MARKER[extname(f)]);
  assert.ok(seen.includes("rerun-rebase-check.sh"), `CI helpers not swept: ${seen.join(", ")}`);
});

// The pattern must be invisible to its own text, or this file's rationale above
// would have to avoid the vocabulary it exists to forbid.
test("the gate does not trip on its own source", () => {
  assert.deepEqual(sweep(DIRS, false).hits, []);
});

// Discrimination, both directions. Built by joining tokens so no line of this
// file ever carries a live instance for the self-scan above to find.
const D = ["the", "line", "above"].join(" ");
const TAIL = ["line", "above"].join(" ");

test("the bare form reds however it is spelled", () => {
  const red = {
    "whole-line #": [`# captured ${D} — so the hazard does not apply`, "#"],
    "whole-line //": [`// captured ${D} — so the hazard does not apply`, "//"],
    "trailing #": [`x=1  # captured ${D} here`, "#"],
    "trailing //": [`const x = 1;  // captured ${D} here`, "//"],
    "wrapped across a # break": [`# captured the\n# ${TAIL} here`, "#"],
    "wrapped across a // break": [`// captured the\n// ${TAIL} here`, "//"],
    "plural": [`# ${["the", "lines", "below"].join(" ")} assert it`, "#"],
    "before/after spelling": [`# ${["the", "line", "after"].join(" ")} collided`, "#"],
  };
  for (const [name, [src, marker]] of Object.entries(red)) {
    assert.equal(hitsIn(src, marker).length, 1, `missed the bare form: ${name}`);
  }
});

test("the widened gate still refuses to fire on the out-of-class forms", () => {
  const green = {
    "a count with no direction": "# it sits two lines from here",
    "a count over named units": "# the two cases above disagree",
    "an ordinal over output data": "# the first line of stdout is the header",
    "a size, not a position": "# the same ~40 lines were copy-pasted",
    "a // inside a URL": `curl https://ex.test/x ${D}`,
    "a bare direction word with no line": "# the guard above already fired",
  };
  for (const [name, src] of Object.entries(green)) {
    assert.deepEqual(hitsIn(src, "#"), [], `false positive: ${name}`);
    assert.deepEqual(hitsIn(src, "//"), [], `false positive: ${name}`);
  }
});
