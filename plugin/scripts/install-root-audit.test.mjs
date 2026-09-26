// The audit guard for the install-only dev loop (#1335, ADR 0003 point 4).
// Two invariants, independent of each other:
//
//   (a) no script under `plugin/scripts/` derives the repo it OPERATES ON
//       from its own location — the pattern the OLD `instruments.sh` had
//       (#1337) and ADR 0003's own text names: a `git -C`/`git rev-parse`
//       call rooted at `dirname "$0"` (sh) or
//       `import.meta.dirname`/`__dirname` (js).
//   (b) no prose under `plugin/skills/ plugin/commands/ plugin/agents/
//       plugin/workflows/` contains a literal source path, harness cache
//       path, or registry filename — the exact defect that produced the 35
//       `~/dev/fleet-plugin/…` callsites ADR 0003 documents and #1336
//       rewrote through the Resolver, draining this to zero.
//
// Both detectors are exported as plain functions over source TEXT precisely
// so they can be mutation-tested against fixture strings below, independent
// of what happens to be checked into the tree right now — the sweep tests
// further down are what points them at this repo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot, skipWithoutRepo, trackedPaths } from "./repo-root.mjs";
import { stripComments } from "./strip-comments.mjs";

const DIR = fileURLToPath(new URL(".", import.meta.url));
const ROOT = repoRoot(DIR);
const SKIP_WITHOUT_REPO = skipWithoutRepo(ROOT, "the install-root audit (#1335)");

// ==================== Rule (a): own-location repo derivation ====================

// Whole-line `#` comments only — same ceiling as `stripComments.mjs` for js,
// and enough to keep instruments.sh's own PROSE description of the pattern
// it used to have (a comment, wrapped across two lines) from tripping this.
function stripShComments(src) {
  return src.split("\n").map((l) => (/^\s*#/.test(l) ? "" : l)).join("\n");
}

// `git -C "$(dirname "$0")"`, inlined — the exact shape instruments.sh's own
// comment names as the pre-#1337 contract — PLUS the parent-directory
// spellings a production script one level below the repo root (every script
// lives directly under `scripts/`) would naturally reach for: a trailing
// `/..`, `dirname` applied twice, or a symlink-resolved `cd "$(dirname
// "$0")" && pwd`. Measured (#1355 review) that the un-widened rule let all
// three straight through against fixtures built from this file's own
// exports.
const SH_SELFLOC = String.raw`(?:\$\(\s*cd\s+"?\$\(\s*dirname\s+"?\$0"?\s*\)"?\s*&&\s*pwd\s*\)`
  + String.raw`|\$\(\s*dirname\s+"?\$\(\s*dirname\s+"?\$0"?\s*\)"?\s*\)`
  + String.raw`|\$\(\s*dirname\s+"?\$0"?\s*\))(?:/\.\.)?`;
const SH_GIT_C_INLINE = new RegExp(String.raw`git\s+-C\s+"?${SH_SELFLOC}`);
// A variable assigned EXACTLY one of the SH_SELFLOC shapes — bare (plus an
// optional trailing `/..`), nothing else appended. This is what
// distinguishes it from sibling-library sourcing
// (`json_lib="$(dirname "$0")/json.sh"`), which always appends a filename
// and therefore never matches this end-of-line anchor.
const SH_BARE_DIRNAME_ASSIGN = new RegExp(String.raw`^\s*(\w+)="?${SH_SELFLOC}"?\s*$`);

/** A description of the self-location violation in a POSIX-sh source, or `null`. */
export function shSelfLocationViolation(src) {
  const code = stripShComments(src);
  if (SH_GIT_C_INLINE.test(code)) return 'git -C anchored directly at "$(dirname "$0")" (or a parent/canonicalized spelling of it)';
  for (const line of code.split("\n")) {
    const m = SH_BARE_DIRNAME_ASSIGN.exec(line);
    if (!m) continue;
    const v = m[1];
    if (new RegExp(`git\\s+-C\\s+"?\\$\\{?${v}\\}?"?`).test(code)) {
      return `git -C "$${v}" where ${v} := an own-location expression (bare — no sibling filename appended)`;
    }
  }
  return null;
}

const JS_SELFLOC = String.raw`(?:import\.meta\.dirname`
  + String.raw`|dirname\(\s*fileURLToPath\(\s*import\.meta\.url\s*\)\s*\)`
  + String.raw`|fileURLToPath\(\s*new URL\(\s*["']\.["'],\s*import\.meta\.url\s*\)\s*\)`
  + String.raw`|__dirname)`;
// The parent-directory spelling — `join(SELFLOC, "..")` / `resolve(SELFLOC,
// "..")` — reaches the repo root from a script one level below it, exactly
// as naturally as the sh side's trailing `/..`. Measured (#1355 review) to
// escape the un-widened rule.
const JS_SELFLOC_MAYBE_PARENT = String.raw`(?:(?:join|resolve)\(\s*${JS_SELFLOC}\s*,\s*["'][.\/]+["']\s*\)|${JS_SELFLOC})`;
const JS_BARE_SELFLOC_ASSIGN = new RegExp(
  String.raw`(?:const|let|var)\s+(\w+)\s*=\s*${JS_SELFLOC_MAYBE_PARENT}\s*;`,
  "g",
);

// A git invocation "anchored" at `target` (either the raw self-location
// pattern or an escaped variable name), in either of the two shapes node
// code roots a git call at a directory: the spawn/exec `cwd` option, or
// git's own `-C <dir>` argv element. Bounded windows, not a whole-file
// proximity scan — a whole-file scan is what produced a false positive
// against this repo's own sibling-sourcing shape during development (an
// UNRELATED `git -C "$root"` call landing within a wide window of an
// UNRELATED `dirname "$0"` sibling-sourcing line); these windows stay
// inside one call expression's own text. `(?!\w)` rather than `\b` after
// `target`: `\b` requires a word/non-word transition and silently fails to
// match when `target` is a compound expression ending in `)` followed by
// more punctuation (`join(import.meta.dirname, "..")` inlined directly as
// `cwd:`'s value) — measured (#1355 review) to let that exact shape through.
function jsAnchoredAtTarget(code, target) {
  const cwdForm = new RegExp(
    String.raw`\bgit\b[\s\S]{0,150}?(rev-parse|--show-toplevel|"-C")[\s\S]{0,250}?cwd\s*:\s*${target}(?!\w)`
    + `|`
    + String.raw`cwd\s*:\s*${target}(?!\w)[\s\S]{0,250}?\bgit\b[\s\S]{0,150}?(rev-parse|--show-toplevel|"-C")`,
  );
  const argvCForm = new RegExp(String.raw`\bgit\b[\s\S]{0,80}?\[[\s\S]{0,80}?["'\`]-C["'\`]\s*,\s*${target}(?!\w)`);
  return cwdForm.test(code) || argvCForm.test(code);
}

/** A description of the self-location violation in a js/mjs source, or `null`. */
export function jsSelfLocationViolation(src) {
  const code = stripComments(src);
  if (jsAnchoredAtTarget(code, JS_SELFLOC_MAYBE_PARENT)) {
    return "a git rev-parse/-C call anchored (cwd: or -C) at this script's own location (or its parent)";
  }
  JS_BARE_SELFLOC_ASSIGN.lastIndex = 0;
  let m;
  while ((m = JS_BARE_SELFLOC_ASSIGN.exec(code))) {
    const v = m[1];
    if (jsAnchoredAtTarget(code, v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))) {
      return `a git rev-parse/-C call anchored (cwd: or -C) at ${v}, an own-location variable`;
    }
  }
  return null;
}

// sh by extension or `#!/bin/sh`; js by `.mjs` extension (excluding tests,
// filtered by the caller) or a node shebang for the three extensionless
// Resolver scripts; anything else (board.html) is not a script this rule
// has an opinion about.
function classifyScript(rel, content) {
  if (rel.endsWith(".sh")) return "sh";
  if (rel.endsWith(".mjs")) return "js";
  const firstLine = content.slice(0, content.indexOf("\n") === -1 ? undefined : content.indexOf("\n"));
  if (/^#!.*\bsh\b/.test(firstLine)) return "sh";
  if (/^#!.*\bnode\b/.test(firstLine)) return "js";
  return null;
}

test(
  "no tracked production script under plugin/scripts/ derives the repo it operates on from its own location",
  { skip: SKIP_WITHOUT_REPO },
  () => {
    const files = trackedPaths(ROOT, ["plugin/scripts/*"]).filter((f) => !f.endsWith(".test.mjs"));
    assert.ok(files.length > 0, "the instrument set must not be empty");
    const violations = [];
    for (const rel of files) {
      const content = readFileSync(join(ROOT, rel), "utf8");
      const kind = classifyScript(rel, content);
      if (kind === null) continue;
      const v = kind === "sh" ? shSelfLocationViolation(content) : jsSelfLocationViolation(content);
      if (v) violations.push(`${rel}: ${v}`);
    }
    assert.deepEqual(
      violations,
      [],
      "This rule polices deriving a REPO ROOT from own location — a git rev-parse/-C call anchored at "
      + "dirname \"$0\" / import.meta.dirname — not every own-location read. It does not flag, and needs no "
      + "explicit exemption for: sibling-library sourcing (json_lib=\"$(dirname \"$0\")/json.sh\" and its "
      + "net.sh/worktree.sh equivalents) or board.mjs's SCRIPT_DIR-relative board.html asset path, because "
      + "neither ever calls git — they name a co-located FILE, never a repo boundary. fleet-run's own "
      + "directory is likewise never fed to git (see that file's header comment). scripts/repo-root.mjs's "
      + "repoRoot(cwd) takes an explicit cwd parameter rather than deriving one, so it never appears here "
      + "either — #1339's own fix to trackedShellScripts is untouched by this rule.",
    );
  },
);

// ---- Mutation tests: rule (a) must fail on the introduced pattern and pass without it, both directions ----

test("shSelfLocationViolation: flags git -C inlined directly at dirname \"$0\"", () => {
  assert.match(
    shSelfLocationViolation('#!/bin/sh\ngit -C "$(dirname "$0")" rev-parse --show-toplevel\n'),
    /git -C anchored directly/,
  );
});

test("shSelfLocationViolation: flags a captured bare dirname \"$0\" variable later used with git -C", () => {
  const src = '#!/bin/sh\nroot="$(dirname "$0")"\ngit -C "$root" rev-parse --show-toplevel\n';
  assert.match(shSelfLocationViolation(src), /root/);
});

test("shSelfLocationViolation: does not flag sibling-library sourcing plus an unrelated git -C call", () => {
  const src = '#!/bin/sh\n'
    + 'json_lib="$(dirname "$0")/json.sh"\n'
    + '[ -r "$json_lib" ] || die "cannot read $json_lib"\n'
    + '. "$json_lib"\n'
    + 'git -C "$root" status\n';
  assert.equal(shSelfLocationViolation(src), null);
});

test("shSelfLocationViolation: does not flag a root passed in explicitly", () => {
  assert.equal(shSelfLocationViolation('#!/bin/sh\nroot="$1"\ngit -C "$root" rev-parse --show-toplevel\n'), null);
});

test("shSelfLocationViolation: a comment merely describing the old pattern does not flag", () => {
  const src = '#!/bin/sh\n'
    + '# the OLD own-location contract (`git -C "$(dirname\n'
    + '# "$0")" ...`) resolved the wrong tree\n'
    + 'root="$1"\n'
    + 'git -C "$root" rev-parse --show-toplevel\n';
  assert.equal(shSelfLocationViolation(src), null);
});
test("shSelfLocationViolation: flags the trailing /.. parent-directory spelling", () => {
  const src = '#!/bin/sh\nroot="$(dirname "$0")/.."\ngit -C "$root" status\n';
  assert.match(shSelfLocationViolation(src), /root/);
});

test("shSelfLocationViolation: flags the symlink-resolved cd \"$(dirname \"$0\")\" && pwd spelling", () => {
  const src = '#!/bin/sh\nroot="$(cd "$(dirname "$0")" && pwd)"\ngit -C "$root" status\n';
  assert.match(shSelfLocationViolation(src), /root/);
});

test("shSelfLocationViolation: flags the nested dirname \"$(dirname \"$0\")\" parent spelling", () => {
  const src = '#!/bin/sh\nroot="$(dirname "$(dirname "$0")")"\ngit -C "$root" status\n';
  assert.match(shSelfLocationViolation(src), /root/);
});


test("jsSelfLocationViolation: flags git rev-parse with cwd anchored at import.meta.dirname", () => {
  const src = 'execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: import.meta.dirname });';
  assert.match(jsSelfLocationViolation(src), /own location/);
});

test("jsSelfLocationViolation: flags a captured own-directory variable used as git's -C argument", () => {
  const src = 'const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));\n'
    + 'spawnSync("git", ["-C", SCRIPT_DIR, "rev-parse", "HEAD"]);\n';
  assert.match(jsSelfLocationViolation(src), /SCRIPT_DIR/);
});
test("jsSelfLocationViolation: flags the join(SELFLOC, \"..\") parent-directory spelling, captured", () => {
  const src = 'const ROOT = join(import.meta.dirname, "..");\n'
    + 'execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: ROOT });\n';
  assert.match(jsSelfLocationViolation(src), /ROOT/);
});

test("jsSelfLocationViolation: flags join(SELFLOC, \"..\") inlined directly with no variable", () => {
  const src = 'execFileSync("git", ["rev-parse"], { cwd: join(import.meta.dirname, "..") });';
  assert.match(jsSelfLocationViolation(src), /own location/);
});

test("jsSelfLocationViolation: flags resolve(__dirname, \"..\") used as git's -C argument", () => {
  const src = 'const ROOT = resolve(__dirname, "..");\nexecFileSync("git", ["-C", ROOT, "status"]);\n';
  assert.match(jsSelfLocationViolation(src), /ROOT/);
});

test("jsSelfLocationViolation: does not flag SCRIPT_DIR's own \"..\" used only for an unrelated asset path", () => {
  const src = 'const ASSET = join(SCRIPT_DIR, "..", "assets", "logo.png");\nreadFileSync(ASSET);\n';
  assert.equal(jsSelfLocationViolation(src), null);
});


test("jsSelfLocationViolation: does not flag SCRIPT_DIR used only for a co-located asset path", () => {
  const src = 'const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));\n'
    + 'copyFileSync(join(SCRIPT_DIR, "board.html"), join(stateDir, "board.html"));\n';
  assert.equal(jsSelfLocationViolation(src), null);
});

test("jsSelfLocationViolation: does not flag SCRIPT_DIR used only to spawn a sibling script", () => {
  const src = 'const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));\n'
    + 'spawnSync(process.execPath, [join(SCRIPT_DIR, "candidates.mjs")], { encoding: "utf8" });\n';
  assert.equal(jsSelfLocationViolation(src), null);
});

test("jsSelfLocationViolation: does not flag repoRoot's own explicit cwd parameter", () => {
  const src = 'export function repoRoot(cwd) {\n'
    + '  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });\n'
    + '  return r.stdout.trim();\n'
    + '}\n';
  assert.equal(jsSelfLocationViolation(src), null);
});

// ==================== Rule (b): literal source/harness/registry paths in prose ====================

// The five literal tokens ADR 0003/CONTEXT.md's Resolver entry forbid in a
// prose callsite: an absolute source-checkout path, an absolute macOS home
// path, either harness's cache path, or the registry filename itself.
const LITERAL_PATTERNS = [
  { name: "home-dev-checkout", re: /~\/dev\// },
  { name: "absolute-Users-path", re: /\/Users\// },
  { name: "claude-plugin-cache", re: /~\/\.claude\/plugins\/cache/ },
  { name: "omp-plugin-cache", re: /~\/\.omp\/plugins\/cache/ },
  { name: "registry-filename", re: /installed_plugins\.json/ },
];

// #1336 rewrote all 35 `~/dev/fleet-plugin/…` callsites ADR 0003 documented
// (script AND cross-doc references alike) through the Resolver, so no
// allowlist exists any more — a `~/dev/` match anywhere in this prose is a
// plain violation, full stop.

/**
 * Every literal-pattern match in one source text, each `{ pattern, index }`.
 */
export function literalPathMatches(text) {
  const violations = [];
  for (const { name, re } of LITERAL_PATTERNS) {
    const g = new RegExp(re.source, "g");
    let m;
    while ((m = g.exec(text))) {
      violations.push({ pattern: name, index: m.index });
    }
  }
  return { violations };
}

test(
  "no prose under plugin/skills/ plugin/commands/ plugin/agents/ plugin/workflows/ contains a literal "
  + "source/harness/registry path",
  { skip: SKIP_WITHOUT_REPO },
  () => {
    const files = trackedPaths(ROOT, ["plugin/skills/*", "plugin/commands/*", "plugin/agents/*", "plugin/workflows/*"]);
    assert.ok(files.length > 0, "the prose set must not be empty");
    const violations = [];
    for (const rel of files) {
      const text = readFileSync(join(ROOT, rel), "utf8");
      const r = literalPathMatches(text);
      for (const v of r.violations) {
        const line = text.slice(0, v.index).split("\n").length;
        violations.push(`${rel}:${line} (${v.pattern})`);
      }
    }
    assert.deepEqual(
      violations,
      [],
      "a literal source path, harness cache path, or registry filename in prose is exactly the split-brain "
      + "defect ADR 0003 exists to close — route it through fleet-run instead",
    );
  },
);

// ---- Mutation tests: rule (b) must fail on the introduced literal and pass without it, both directions ----

test("literalPathMatches: flags a literal absolute /Users/ path", () => {
  const r = literalPathMatches("see the log under /Users/anyone/whatever for details");
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].pattern, "absolute-Users-path");
});

test("literalPathMatches: an unrelated sentence with no literal path is clean", () => {
  const r = literalPathMatches("run it via `fleet-run arg.mjs` from anywhere");
  assert.deepEqual(r.violations, []);
});

test("literalPathMatches: flags the Claude plugin cache path literally", () => {
  const r = literalPathMatches("the cache lives at ~/.claude/plugins/cache/fleet-plugin/fleet-ctl/0.1.1");
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].pattern, "claude-plugin-cache");
});

test("literalPathMatches: flags the omp plugin cache path literally", () => {
  const r = literalPathMatches("or ~/.omp/plugins/cache/plugins/fleet-plugin___fleet-ctl___0.1.1 on omp");
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].pattern, "omp-plugin-cache");
});

test("literalPathMatches: flags the registry filename literally", () => {
  const r = literalPathMatches("read it back out of installed_plugins.json yourself");
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].pattern, "registry-filename");
});

test("literalPathMatches: a ~/dev/fleet-plugin/ callsite is a plain violation, not allowlisted", () => {
  const r = literalPathMatches("Read `~/dev/fleet-plugin/scripts/instruments.sh` and run it.");
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].pattern, "home-dev-checkout");
});

test("literalPathMatches: a bare ~/dev/ NOT naming fleet-plugin is still a violation", () => {
  const r = literalPathMatches("clone it into ~/dev/some-other-repo first");
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].pattern, "home-dev-checkout");
});
