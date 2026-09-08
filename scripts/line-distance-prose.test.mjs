import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, extname, basename } from "node:path";

// #765 swept eleven comments that located a construct by counting lines ("two-
// lines-up", "one-line-later", "a-few-lines-down"). Every one had rotted: the
// count was wrong because something had been inserted since. This gate keeps
// the class out.
//
// Comment blocks are STITCHED before matching. The eleventh site escaped four
// separate single-line enumerations because its phrase straddled a comment
// break — the count ended one line and the direction began the next, so no
// line-oriented grep could see it. Joining consecutive comment lines first is
// the whole point of this file; a per-line scan reproduces the miss.
//
// Scope is the counted form only. Bare demonstratives ("the-line-above") are
// #769's, and this directory still carries them — widening the pattern to
// include them reddens the tree today. Widen it when #769 lands. Hyphenated
// here for the same reason the counted examples above are: spelled normally,
// the widened pattern would trip on this very sentence.

const DIR = fileURLToPath(new URL(".", import.meta.url));
const SELF = basename(fileURLToPath(import.meta.url));

const COUNT = "(?:one|two|three|four|five|six|seven|eight|nine|ten|a\\s+few|several|\\d+)";
const WHERE = "(?:up|down|above|below|later|earlier|further\\s+(?:up|down))";
// Assembled from parts, never written out as a literal instance, so this file
// can scan itself without tripping — proven by the self-scan assertion below.
const IDIOM = new RegExp(`\\b${COUNT}\\s+lines?\\s+${WHERE}\\b`, "i");

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

function sweep(dir, skipSelf = true) {
  const hits = [];
  let scanned = 0;
  for (const f of readdirSync(dir)) {
    if (skipSelf && f === SELF) continue;
    const marker = MARKER[extname(f)];
    if (!marker) continue;
    scanned++;
    for (const b of commentBlocks(readFileSync(join(dir, f), "utf8"), marker)) {
      const m = b.text.match(IDIOM);
      if (m) hits.push(`${f}:${b.line}  …${b.text.slice(Math.max(0, m.index - 45), m.index + m[0].length + 15)}…`);
    }
  }
  return { hits, scanned };
}

test("no comment in scripts/ locates a construct by counting lines", () => {
  const { hits, scanned } = sweep(DIR);
  // Without this the whole gate passes vacuously the day the walk reads nothing.
  assert.ok(scanned > 50, `swept only ${scanned} files — the walk is not reaching this directory`);
  assert.deepEqual(hits, [], `line-distance comment(s) reintroduced — name the construct, drop the count:\n${hits.join("\n")}`);
});

// The pattern must be invisible to its own text, or this file's rationale above
// would have to avoid the vocabulary it exists to forbid.
test("the gate does not trip on its own source", () => {
  assert.deepEqual(sweep(DIR, false).hits, []);
});
