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
//
// Scope is this repo's code files, every directory holding one of MARKER's
// extensions. Markdown prose (skills/, commands/, agents/) stays out of reach:
// it has no comment marker to stitch blocks from, so covering it means scanning
// whole files — a different gate. #769 swept it by grep instead.

const DIR = fileURLToPath(new URL(".", import.meta.url));
const SELF = basename(fileURLToPath(import.meta.url));
// The CI helpers and the workflow sources carry the same prose and the same
// rot. Scoping to one directory is what let #769's sites sit outside the
// previous gate's reach, so DIRS names every directory holding a scannable
// file — pinned by name in the walk test below, not left to this list.
const DIRS = [
  DIR,
  fileURLToPath(new URL("../.github/scripts/", import.meta.url)),
  fileURLToPath(new URL("../workflows/", import.meta.url)),
];

const COUNT = "(?:one|two|three|four|five|six|seven|eight|nine|ten|a\\s+few|several|\\d+)";
// The bare form takes no numeral, so it needs its own arm. Narrower direction
// set on purpose: "the-line-up" is not English, and widening it buys nothing
// while risking prose that never pointed at a line.
const BARE = "(?:above|below|before|after)";
// The counted arm carries BARE's directions too, or the gate reads a direction
// as line-relative only while the count is absent — "N-lines-before" would walk
// through the arm built to catch counted distances. Union, not a second list,
// so the two arms cannot drift apart again. Safe only because COUNT pins a
// numeral immediately before "lines": bare temporal "before"/"after" prose,
// which is everywhere, never reaches this arm.
const WHERE = `(?:${BARE}|up|down|later|earlier|further\\s+(?:up|down))`;
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

// Returns the files it actually opened, not just a count, so the walk test
// below can pin coverage against the walk itself.
function sweep(dirs, skipSelf = true) {
  const hits = [];
  const files = [];
  for (const dir of dirs) {
    for (const f of readdirSync(dir)) {
      if (skipSelf && f === SELF) continue;
      const marker = MARKER[extname(f)];
      if (!marker) continue;
      files.push(f);
      for (const b of hitsIn(readFileSync(join(dir, f), "utf8"), marker)) {
        const m = b.text.match(IDIOM);
        hits.push(`${f}:${b.line}  …${b.text.slice(Math.max(0, m.index - 45), m.index + m[0].length + 15)}…`);
      }
    }
  }
  return { hits, files };
}

test("no comment locates a construct by a line distance", () => {
  const { hits, files } = sweep(DIRS);
  // Without this the whole gate passes vacuously the day the walk reads nothing.
  assert.ok(files.length > 50, `swept only ${files.length} files — the walk is not reaching these directories`);
  assert.deepEqual(hits, [], `line-distance comment(s) reintroduced — name the construct, drop the distance:\n${hits.join("\n")}`);
});

// The walk must reach every directory holding a scannable file, not just this
// one. Asserted against what sweep OPENED, by name: re-deriving the listing
// here would pin DIRS and MARKER while a sweep that skipped a whole directory
// stayed green — measured, dropping .github/scripts/ moves the count 136 → 134,
// far above the vacuity floor above. By name, not by count, so landing another
// file in any of these directories does not red the gate.
test("the walk reaches the CI helpers and the workflow sources too", () => {
  const { files } = sweep(DIRS);
  for (const f of ["rerun-rebase-check.sh", "review-pr.js"]) {
    assert.ok(files.includes(f), `not swept: ${f} — the walk opened ${files.length} files`);
  }
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
    // The counted arm's own before/after: caught by WHERE's union with BARE,
    // and the reason that union exists rather than two hand-kept lists.
    "counted before/after": [`# it broke ${["two", "lines", "before"].join(" ")} this guard`, "#"],
  };
  for (const [name, [src, marker]] of Object.entries(red)) {
    assert.equal(hitsIn(src, marker).length, 1, `missed the bare form: ${name}`);
  }
});

// Each case carries its own marker, like the red table above. Asserting a
// `#` source under the `//` marker cannot fail: no marker means no comment
// block, so the assertion holds whatever the pattern does — six of twelve here
// were unfalsifiable that way. The URL case is the one that genuinely needs
// `//`: it is the only guard on the leading `\s` in commentBlocks' trail regex.
test("the widened gate still refuses to fire on the out-of-class forms", () => {
  const green = {
    "a count with no direction": ["# it sits two lines from here", "#"],
    "a count over named units": ["# the two cases above disagree", "#"],
    "an ordinal over output data": ["# the first line of stdout is the header", "#"],
    "a size, not a position": ["# the same ~40 lines were copy-pasted", "#"],
    "a // inside a URL": [`curl https://ex.test/x ${D}`, "//"],
    "a bare direction word with no line": ["# the guard above already fired", "#"],
    // Temporal before/after, the prose the counted arm's widening had to stay
    // clear of: a direction word with no count and no line is not a position.
    "a temporal direction word": ["# it ran before the fetch landed", "#"],
  };
  for (const [name, [src, marker]] of Object.entries(green)) {
    assert.deepEqual(hitsIn(src, marker), [], `false positive: ${name}`);
  }
});
