// #1754. The minimum Node version this plugin's CONSUMERS need is a measured
// fact in exactly one machine-readable place — the root `package.json`'s
// `engines.node` — and this sweep is what keeps a shipped script from
// outrunning it silently.
//
// Four ways to red — the ticket's own three failure modes, plus #1763's:
//   1. a shipped node script reaches for an API above the declared floor
//      ("every shipped node script stays within the declared floor", below);
//   2. the declaration is missing or carries anything load-bearing beyond
//      the floor itself ("package.json declares the consumer floor...");
//   3. README's stated floor and package.json's declaration disagree
//      ("README's stated floor agrees with package.json's declaration");
//   4. a shipped node script imports a relative module that is not `.mjs`
//      ("every relative import in a shipped node script names a .mjs module").
//      Not an API but a LOADER behaviour: nothing that ships sets a `type`
//      field (the root package.json never reaches an installed plugin, whose
//      root is `plugin/`, and carries only `engines` anyway — check 2), so a
//      `.js` file is CommonJS to Node until syntax detection turned on by
//      default (20.19.0 on the 20 line, 22.7.0 on 22). At the declared floor
//      an `import`/`export` in one fails to load — measured for #1763 on
//      review-eval.mjs's import of the old review-core.js under 20.11.0,
//      20.18.3 and 22.6.0: "Named export 'digestOf' not found. The requested
//      module './review-core.js' is a CommonJS module". `.mjs` is ESM on
//      every Node this floor admits, and on Bun, with no manifest at all.
//      Static specifiers only: an `import()` of a COMPUTED path is invisible
//      to it, the same textual-scan limit the API table below states. A
//      TRAILING `code; // note` on the same line as a real import is closed
//      here too, quote-aware: `stripComments()`'s own known ceiling leaves
//      that text standing, which is safe for the declaration pins it was
//      built for (surviving text only ever ADDS a match there) but not for
//      this scan, where it can COIN a fake `from "<rel>"` beside a real,
//      correct import on the same line (measured: appending `// … from
//      "./old.js"` after a genuine `.mjs` import falsely reds this check).
// "Shipped node script" is `trackedNodeScripts()`'s answer (repo-root.mjs):
// every tracked `.mjs`, and every other tracked file whose first line is a
// node shebang. Until #1855 the sweep read the `.mjs` half alone, so the three
// extensionless entrypoints that run under the consumer's own node exactly as
// the `.mjs` files do — `fleet-run` (the Resolver, copied to
// `~/.fleet/bin/fleet-run`), `fleet-bootstrap`, `fleet-provenance` — could
// reach above the floor unseen (measured: `Object.groupBy(` appended to
// `fleet-run` left this suite green). They are CommonJS, so every table entry
// below that is matched at a module site matches its `require(…)` form too.
// `plugin/workflows/*.js` stays out: ESM a harness runs and plain node never
// loads, so no node floor applies to it.
// Non-vacuity is asserted explicitly, same discipline every other sweep in
// this directory uses (see repo-root.mjs's own header, `check-tracked.sh`):
// an empty shipped-file list is a broken glob, not "nothing to check" — and
// so, for each half of it, is an empty half.
//
// THE DETECTION MECHANISM, and its limits, stated plainly because this is
// the hardest call in the ticket:
//
// `API_FLOORS` below is a CURATED table — API name, a regex signature, and
// the Node release that first shipped it (each verified against a Node
// release note or blog post at authoring time, cited inline). There is no
// general, load-bearing "what Node version does this syntax need" oracle
// available without a new dependency, and the design guidance forbids one
// (the root manifest "introduces no publish path and no dependency graph").
// This is therefore a KNOWN-API scan, not a semantic analyzer: it catches
// exactly the APIs enumerated below, reached for in exactly the textual
// shape each pattern matches, and nothing else. A shipped file reaching for
// some OTHER version-gated API not yet in this table is a false negative —
// the same class of gap `printf-die-sweep.test.mjs`'s own header names for
// its `\c`-escape fixtures, and the remedy is the same: extend the table the
// day a real one is measured, not attempt to enumerate every Node API ever
// added up front.
//
// Scanned through `stripComments()` (not raw source), reusing the shared
// stripper the rest of this suite already trusts for exactly this class of
// false positive: a comment that merely NAMES an API — this very file's own
// header does, repeatedly — must not raise the floor a mutant would need to
// actually regress. `.at(`, `Object.groupBy(` etc. below are still
// heuristic textual matches, not parsed call sites: a local method that
// happens to share a name (a custom `.with(`, most plausibly) would
// false-positive. Accepted, not fixed here, for the same reason the false
// negative above is accepted — a real parser is out of scope for this
// ticket's root-manifest constraint, and every regex below is anchored
// tightly enough that no shipped file trips it today (see the "stays within
// the declared floor" test).
//
// KNOWN LIMIT shared with every `*-sweep.test.mjs` sibling in this
// directory: needs an ambient `.git` to ask what ships. Absent one, the
// integration tests below DECLINE with a reason rather than running; the
// unit tests further down (pure functions, no repo needed) still run and
// still police the mechanism itself.
//
// Zero deps: `node --test plugin/scripts/node-floor-sweep.test.mjs`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot, skipWithoutRepo, trackedNodeScripts } from "./repo-root.mjs";
import { stripComments } from "./strip-comments.mjs";

const DIR = fileURLToPath(new URL(".", import.meta.url));
const ROOT = repoRoot(DIR);
const SKIP_WITHOUT_REPO = skipWithoutRepo(ROOT, "the node-floor sweep");
const NODE_SCRIPTS = ROOT === null ? [] : trackedNodeScripts(ROOT);

// A named binding taken from builtin `mod` at its MODULE SITE, in either module
// system: ESM's `import { name } from "mod"`, or the CommonJS twin the
// extensionless entrypoints write (#1855), `const { name } = require("mod")`.
function moduleSiteBinding(name, mod) {
  return new RegExp(
    `import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*["']${mod}["']`
    + `|\\b(?:const|let|var)\\s*\\{[^{}]*\\b${name}\\b[^{}]*\\}\\s*=\\s*require\\(\\s*["']${mod}["']\\s*\\)`,
  );
}

// name: what a failure message calls it. pattern: non-global regex over
// COMMENT-STRIPPED source. since: "MAJOR.MINOR.PATCH", the first Node
// release that shipped it (stable, unflagged), each verified at authoring
// time — see the header for which release note.
const API_FLOORS = [
  // Node v16.6.0 blog/changelog: "introduces the new Array.prototype.at
  // method". Heuristic: any `.at(` call — see header's accepted false-
  // positive note.
  { name: "Array.prototype.at()", pattern: /\.at\(/, since: "16.6.0" },
  // Node v16.9.0 blog/changelog: "Object.hasOwn is a static alias for
  // Object.prototype.hasOwnProperty.call".
  { name: "Object.hasOwn()", pattern: /\bObject\.hasOwn\(/, since: "16.9.0" },
  // Node v17.0.0 added the global structuredClone().
  { name: "structuredClone()", pattern: /\bstructuredClone\(/, since: "17.0.0" },
  // node/#46718: "util,doc: mark parseArgs() as stable", landed in Node
  // v20.0.0 (SEMVER-MAJOR). Matched at the import or require site, not the
  // bare word, so a comment discussing the sibling module (arg.mjs does, at
  // length) cannot trip it even unstripped.
  { name: "util.parseArgs()", pattern: moduleSiteBinding("parseArgs", "node:util"), since: "20.0.0" },
  // ES2023 array copy methods — Node 20+ per release notes; Node 18/19 ship
  // only findLast/findLastIndex from the same proposal.
  { name: "Array.prototype.toSorted()", pattern: /\.toSorted\(/, since: "20.0.0" },
  { name: "Array.prototype.toReversed()", pattern: /\.toReversed\(/, since: "20.0.0" },
  { name: "Array.prototype.toSpliced()", pattern: /\.toSpliced\(/, since: "20.0.0" },
  { name: "Array.prototype.with()", pattern: /\.with\(/, since: "20.0.0" },
  // node/#48740 (SEMVER-MINOR), Node v20.11.0: "esm: add import.meta.dirname
  // and import.meta.filename".
  {
    name: "import.meta.dirname / import.meta.filename",
    pattern: /\bimport\.meta\.(dirname|filename)\b/,
    since: "20.11.0",
  },
  // util.styleText — introduced Node v20.12.0, stable Node v21.7.0/v22.13.0.
  // Using the introduction version as the floor: it exists and is usable
  // (with an experimental warning) from 20.12.0, and this table's job is
  // "what version must a consumer run", not "warning-free". Matched at the
  // import or require site, same discipline as util.parseArgs() above: 20.12.0
  // sits ABOVE this table's other unanchored bare-call patterns' `since`
  // values, so a same-named local (a custom `styleText`) is the one heuristic
  // entry that's actually live today, not merely theoretical — anchoring it is
  // not optional.
  { name: "util.styleText()", pattern: moduleSiteBinding("styleText", "node:util"), since: "20.12.0" },
  // Node v21.0.0 shipped Object.groupBy/Map.groupBy (array grouping).
  { name: "Object.groupBy()", pattern: /\bObject\.groupBy\(/, since: "21.0.0" },
  { name: "Map.groupBy()", pattern: /\bMap\.groupBy\(/, since: "21.0.0" },
  // Promise.withResolvers — behind a flag in Node 21.7.0, enabled by default
  // Node 22.0.0+.
  { name: "Promise.withResolvers()", pattern: /\bPromise\.withResolvers\(/, since: "22.0.0" },
  // Array.fromAsync — Node 22.0.0+.
  { name: "Array.fromAsync()", pattern: /\bArray\.fromAsync\(/, since: "22.0.0" },
  // node:sqlite — introduced Node v22.5.0 behind --experimental-sqlite;
  // unflagged (still experimental) in Node v22.13.0 (nodejs/node#55890).
  // "since" is the unflagged version, same rule this table's header states
  // and Promise.withResolvers() above already follows: a shipped `import
  // ... from "node:sqlite"`, or `require("node:sqlite")`, on 22.5.0-22.12.x
  // still needs the flag and would throw ERR_UNKNOWN_BUILTIN_MODULE without it.
  {
    name: "node:sqlite",
    pattern: /from\s*["']node:sqlite["']|\brequire\(\s*["']node:sqlite["']\s*\)/,
    since: "22.13.0",
  },
];

/** "MAJOR.MINOR.PATCH" -> [major, minor, patch], or throws. */
function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v));
  if (!m) throw new Error(`not a MAJOR.MINOR.PATCH version: ${JSON.stringify(v)}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** <0 if a<b, 0 if equal, >0 if a>b — both [major, minor, patch]. */
function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * The declared floor, from `package.json`'s own text. Refuses anything the
 * file carries beyond exactly `{"engines":{"node":">=X.Y.Z"}}` — the
 * "nothing load-bearing beyond the floor itself" acceptance criterion,
 * enforced here rather than left to a reviewer's eye.
 */
function parseDeclaredFloor(pkgJsonText) {
  let pkg;
  try {
    pkg = JSON.parse(pkgJsonText);
  } catch (e) {
    throw new Error(`package.json is not valid JSON: ${e.message}`);
  }
  const topKeys = Object.keys(pkg);
  if (topKeys.length !== 1 || topKeys[0] !== "engines") {
    throw new Error(
      `package.json must carry nothing load-bearing beyond "engines" — found keys: ${JSON.stringify(topKeys)}`,
    );
  }
  const engineKeys = Object.keys(pkg.engines ?? {});
  if (engineKeys.length !== 1 || engineKeys[0] !== "node") {
    throw new Error(
      `package.json's "engines" must carry nothing beyond "node" — found keys: ${JSON.stringify(engineKeys)}`,
    );
  }
  const raw = pkg.engines.node;
  const m = typeof raw === "string" ? /^>=(\d+\.\d+\.\d+)$/.exec(raw) : null;
  if (!m) {
    throw new Error(
      `package.json's engines.node must read exactly ">=MAJOR.MINOR.PATCH", got ${JSON.stringify(raw)}`,
    );
  }
  return { raw, version: parseVersion(m[1]) };
}

/**
 * The floor README's `## Installation` section states, read the same way a
 * human does: the first `>=MAJOR.MINOR.PATCH` token in that section.
 */
function parseReadmeFloor(readmeText) {
  const section = /## Installation\n([\s\S]*?)(?=\n## )/.exec(readmeText);
  if (!section) throw new Error("README has no \"## Installation\" section to read a floor from");
  const m = />=(\d+\.\d+\.\d+)(?:[-+][0-9A-Za-z.-]*)?/.exec(section[1]);
  if (!m) throw new Error("README's \"## Installation\" section states no \">=MAJOR.MINOR.PATCH\" floor");
  return { raw: m[0], version: parseVersion(m[1]) };
}

/** Every `API_FLOORS` entry a comment-stripped source reaches above `floorVersion`. */
function scanFileViolations(source, floorVersion) {
  const stripped = stripComments(source);
  const hits = [];
  for (const api of API_FLOORS) {
    if (api.pattern.test(stripped) && compareVersions(parseVersion(api.since), floorVersion) > 0) {
      hits.push({ name: api.name, since: api.since });
    }
  }
  return hits;
}

// A static `import … from "<rel>"`, a bare side-effect `import "<rel>"`, or an
// `import("<rel>")` with a literal specifier, where <rel> starts `./`/`../`.
// Bare and `node:` specifiers never match: only a relative path names a file
// whose extension decides how the loader parses it.
const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'`])(\.{1,2}\/[^"'`$]*)\1/g;

// Quote-aware so a literal `//` inside a specifier or string is left alone;
// this only needs to find the FIRST unquoted `//` to truncate the rest of
// the line, never a full tokenizer.
function stripTrailingLineComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") {
      quote = c;
    } else if (c === "/" && line[i + 1] === "/") {
      return line.slice(0, i);
    }
  }
  return line;
}

/** Every relative import specifier in a comment-stripped source that does not name a `.mjs` file. */
function nonMjsRelativeImports(source) {
  const hits = [];
  const stripped = stripComments(source).split("\n").map(stripTrailingLineComment).join("\n");
  for (const m of stripped.matchAll(RELATIVE_IMPORT)) {
    if (!m[2].endsWith(".mjs")) hits.push(m[2]);
  }
  return hits;
}

// Both halves, not their sum: the `.mjs` half alone is dozens of files, so a
// shebang probe that silently lost every extensionless entrypoint (#1855's
// own gap) would leave a total count comfortably non-empty.
test("the sweep sees the scripts it is supposed to police — .mjs modules and node-shebang entrypoints both", { skip: SKIP_WITHOUT_REPO }, () => {
  assert.ok(
    NODE_SCRIPTS.some((f) => f.endsWith(".mjs")),
    `trackedNodeScripts(ROOT) returned zero shipped .mjs files — this is a broken glob/git call, and every check below would pass vacuously over them`,
  );
  assert.ok(
    NODE_SCRIPTS.some((f) => !f.endsWith(".mjs")),
    "trackedNodeScripts(ROOT) returned no node-shebang entrypoint — fleet-run, fleet-bootstrap and fleet-provenance are three, "
    + "so this is a broken shebang probe, and every check below would pass vacuously over them (#1855)",
  );
});

test("package.json declares the consumer floor, and nothing else load-bearing", { skip: SKIP_WITHOUT_REPO }, () => {
  let text;
  try {
    text = readFileSync(join(ROOT, "package.json"), "utf8");
  } catch (e) {
    assert.fail(
      e.code === "ENOENT"
        ? "no package.json at the repo root — the consumer floor must be declared there (#1754)"
        : `could not read package.json at the repo root: ${e.message}`,
    );
  }
  const declared = parseDeclaredFloor(text);
  assert.match(declared.raw, /^>=\d+\.\d+\.\d+$/);
});

test("README's stated floor agrees with package.json's declaration", { skip: SKIP_WITHOUT_REPO }, () => {
  const declared = parseDeclaredFloor(readFileSync(join(ROOT, "package.json"), "utf8"));
  const stated = parseReadmeFloor(readFileSync(join(ROOT, "README.md"), "utf8"));
  // Compares the exact matched text, not just the numeric triple: a
  // pre-release/build qualifier one side carries and the other doesn't is a
  // real disagreement `.version`'s numeric coercion would otherwise erase.
  assert.equal(
    stated.raw,
    declared.raw,
    `README's Installation section states ${stated.raw} but package.json declares ${declared.raw} — `
    + "correcting one without the other is exactly the drift this check exists to make impossible",
  );
});

test("every shipped node script stays within the declared floor", { skip: SKIP_WITHOUT_REPO }, () => {
  const declared = parseDeclaredFloor(readFileSync(join(ROOT, "package.json"), "utf8"));
  const violations = [];
  for (const rel of NODE_SCRIPTS) {
    const source = readFileSync(join(ROOT, rel), "utf8");
    for (const hit of scanFileViolations(source, declared.version)) {
      violations.push(`${rel}: uses ${hit.name} (Node >=${hit.since}) above the declared floor (${declared.raw})`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    `shipped file(s) reach above the declared consumer floor — rewrite the call, or raise engines.node in package.json (and README to match):\n${violations.join("\n")}`,
  );
});

test("every relative import in a shipped node script names a .mjs module", { skip: SKIP_WITHOUT_REPO }, () => {
  const violations = [];
  for (const rel of NODE_SCRIPTS) {
    for (const spec of nonMjsRelativeImports(readFileSync(join(ROOT, rel), "utf8"))) {
      violations.push(`${rel}: imports ${spec}`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    "shipped file(s) import a relative module that is not .mjs — nothing that ships declares a \"type\", so Node "
    + "below 20.19.0/22.7.0 (inside the declared floor) loads it as CommonJS and its import/export fails (#1763); "
    + `rename it to .mjs:\n${violations.join("\n")}`,
  );
});

// ---------------------------------------------------------------------------
// The mechanism itself, unit-tested with no repo needed. Two directions
// pinned on the scanner, because a suite that only feeds valid input pins
// neither (same discipline printf-die-sweep.test.mjs's header states).
// ---------------------------------------------------------------------------

test("scanFileViolations reds a shipped file reaching above the floor", () => {
  const src = 'import { parseArgs } from "node:util";\nconst last = () => import.meta.dirname;\n';
  const names = scanFileViolations(src, parseVersion("16.0.0")).map((h) => h.name);
  assert.ok(names.includes("util.parseArgs()"), `expected util.parseArgs() flagged, got: ${names.join(", ")}`);
  assert.ok(
    names.includes("import.meta.dirname / import.meta.filename"),
    `expected import.meta.dirname flagged, got: ${names.join(", ")}`,
  );
});

test("scanFileViolations stays green once the declared floor covers the same source", () => {
  const src = 'import { parseArgs } from "node:util";\nconst last = () => import.meta.dirname;\n';
  assert.deepEqual(scanFileViolations(src, parseVersion("20.11.0")), []);
});

test("scanFileViolations ignores an API merely NAMED in a comment", () => {
  const src = "// import.meta.dirname is discussed in the sibling module\nconst x = 1;\n";
  assert.deepEqual(scanFileViolations(src, parseVersion("16.0.0")), []);
});

test("scanFileViolations matches util.styleText() only at the import site, not a same-named local", () => {
  const collision = 'function styleText(label) { return `[${label}]`; }\nexport const styled = styleText("x");\n';
  assert.deepEqual(scanFileViolations(collision, parseVersion("16.0.0")), []);
  const real = 'import { styleText } from "node:util";\nconsole.log(styleText("red", "x"));\n';
  const names = scanFileViolations(real, parseVersion("16.0.0")).map((h) => h.name);
  assert.ok(names.includes("util.styleText()"), `expected util.styleText() flagged, got: ${names.join(", ")}`);
});

// #1855: the extensionless entrypoints this sweep reads are CommonJS, so each
// entry matched at a MODULE SITE needs its `require` form as well — an
// `import … from` shape can never match a file with no `import` in it.
test("scanFileViolations reds the CommonJS require site of every module-site API", () => {
  const src = 'const { parseArgs } = require("node:util");\n'
    + 'const { inspect, styleText: paint } = require("node:util");\n'
    + 'const { DatabaseSync } = require("node:sqlite");\n';
  const names = scanFileViolations(src, parseVersion("16.0.0")).map((h) => h.name).sort();
  assert.deepEqual(names, ["node:sqlite", "util.parseArgs()", "util.styleText()"]);
});

test("scanFileViolations passes a CommonJS require of node:util taking neither API, beside same-named locals", () => {
  const src = 'const { inspect } = require("node:util");\n'
    + "function styleText(label) { return `[${label}]`; }\n"
    + "const parseArgs = (argv) => argv.slice(2);\n"
    + "module.exports = { styled: styleText(inspect(parseArgs(process.argv))) };\n";
  assert.deepEqual(scanFileViolations(src, parseVersion("16.0.0")), []);
});

test("parseDeclaredFloor refuses a missing engines.node declaration", () => {
  assert.throws(() => parseDeclaredFloor("{}"), /engines/);
});

test("parseDeclaredFloor refuses anything load-bearing beyond the floor", () => {
  assert.throws(
    () => parseDeclaredFloor('{"engines":{"node":">=20.11.0"},"dependencies":{}}'),
    /nothing load-bearing beyond "engines"/,
  );
  assert.throws(
    () => parseDeclaredFloor('{"engines":{"node":">=20.11.0","npm":">=10"}}'),
    /nothing beyond "node"/,
  );
});

test("parseDeclaredFloor refuses a syntactically malformed but present engines.node", () => {
  assert.throws(
    () => parseDeclaredFloor('{"engines":{"node":"20.11.0"}}'),
    /must read exactly ">=MAJOR\.MINOR\.PATCH"/,
  );
  assert.throws(
    () => parseDeclaredFloor('{"engines":{"node":">=20.11"}}'),
    /must read exactly ">=MAJOR\.MINOR\.PATCH"/,
  );
});

test("parseDeclaredFloor refuses a non-string engines.node", () => {
  assert.throws(
    () => parseDeclaredFloor('{"engines":{"node":[">=20.11.0"]}}'),
    /must read exactly ">=MAJOR\.MINOR\.PATCH"/,
  );
});

test("parseReadmeFloor and parseDeclaredFloor disagreement is caught", () => {
  const declared = parseDeclaredFloor('{"engines":{"node":">=20.11.0"}}');
  const stated = parseReadmeFloor("## Installation\n\nNeeds Node >=20.10.0.\n\n## Next\n");
  assert.notDeepEqual(stated.version, declared.version);
});

test("parseReadmeFloor and parseDeclaredFloor disagreement on a pre-release qualifier is caught", () => {
  const declared = parseDeclaredFloor('{"engines":{"node":">=20.11.0"}}');
  const stated = parseReadmeFloor("## Installation\n\nNeeds Node >=20.11.0-rc.1.\n\n## Next\n");
  assert.notEqual(stated.raw, declared.raw);
});

test("parseReadmeFloor refuses a README with no \"## Installation\" section", () => {
  assert.throws(
    () => parseReadmeFloor("# Some README\n\nNo installation section here.\n\n## Next\n"),
    /no "## Installation" section/,
  );
});

test("parseReadmeFloor refuses an Installation section stating no floor", () => {
  assert.throws(
    () => parseReadmeFloor("## Installation\n\nJust run it.\n\n## Next\n"),
    /states no ">=MAJOR\.MINOR\.PATCH"/,
  );
});

test("nonMjsRelativeImports reds every import form that names a relative non-.mjs module", () => {
  const src = [
    'import { digestOf } from "./review-core.js";',
    "import './side-effect.js';",
    'const m = await import("../lib/dyn.js");',
    "const t = await import(`./tpl.js`);",
    'export { x } from "./re-export.cjs";',
  ].join("\n");
  assert.deepEqual(nonMjsRelativeImports(src), [
    "./review-core.js", "./side-effect.js", "../lib/dyn.js", "./tpl.js", "./re-export.cjs",
  ]);
});

test("nonMjsRelativeImports accepts .mjs siblings, builtins, and a .js merely named in a comment or string", () => {
  const src = [
    'import { isDigits } from "./arg.mjs";',
    'import { readFileSync } from "node:fs";',
    'const m = await import("../lib/deep.mjs");',
    '// import { digestOf } from "./review-core.js";  (the pre-#1763 spelling)',
    'const file = join(DIR, "./review-core.js");',
    "const dyn = await import(path);",
  ].join("\n");
  assert.deepEqual(nonMjsRelativeImports(src), []);
});

test("nonMjsRelativeImports does not coin a false hit from a trailing comment beside a real import", () => {
  const src = [
    'import { isDigits } from "./arg.mjs"; // note: this used to import from "./old-name.js"',
    'const url = "https://example.com/old-name.js"; // a literal "//" inside a string is not a comment start',
  ].join("\n");
  assert.deepEqual(nonMjsRelativeImports(src), []);
});
