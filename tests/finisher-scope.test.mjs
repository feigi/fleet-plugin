// Regression gate for finisher-scope.mjs, the Inert diff verdict the finisher
// reads before it decides whether to run the acceptance mutation. Zero deps:
// `node --test tests/finisher-scope.test.mjs`.
//
// Every case runs against a REAL repository: a bare origin, a clone, and a
// linked worktree on its own branch, with the PR's edits committed on that
// branch. The verdict is read through the script exactly as the finisher runs
// it. Each case holds the baseline and changes one thing, so removing a rule
// reds the case named after it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, closeSync, mkdirSync, openSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tempDir } from "./support/temp-dir.mjs";

const SCRIPT = fileURLToPath(new URL("../plugin/scripts/finisher-scope.mjs", import.meta.url));

// Cut the developer's ~/.gitconfig and any ambient GIT_DIR out of what these
// fixtures see, as finisher-audit.test.mjs does.
const ENV = {
  ...process.env,
  LC_ALL: "C",
  BASE_REF: undefined,
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_TEMPLATE_DIR: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
const write = (dir, rel, text) => {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
};

// The metrics files, the prose files and the code files the baseline holds.
// Every case edits some of these, so a modify, delete, rename and mode change
// each has a real path to act on.
const BASE = {
  "docs/glossary.md": "glossary\n",
  "docs/spec.md": "spec\n",
  "docs/research/r.md": "research\n",
  "docs/old.md": "old\n",
  "docs/mode.md": "mode\n",
  "docs/notes.txt": "notes\n",
  "docs/member-outcomes.tsv": "x\n",
  "docs/metrics/member-outcomes.tsv": "x\n",
  "docs/metrics/ticket-features.tsv": "x\n",
  "docs/metrics/tier-outcomes.tsv": "x\n",
  "docs/metrics/pricing.json": "{}\n",
  "plugin/scripts/router-table.json": "{}\n",
  "docs/agents/triage-labels.md": "labels\n",
  ".out-of-scope/x.md": "record\n",
  ".out-of-scope/gone.md": "record\n",
  "src/code.mjs": "export {};\n",
  "ci.yml": "on: push\n",
};

// The baseline fixture: a bare origin, a clone whose main holds BASE, and a
// linked worktree `wt` on branch `feat` at origin/main. `w` is the clone.
function fixture() {
  const root = realpathSync(tempDir("finisher-scope-"));
  const origin = join(root, "origin.git");
  const w = join(root, "w");
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", "--bare", origin], { env: ENV });
  execFileSync("git", ["clone", "-q", origin, w], { env: ENV, stdio: "ignore" });
  for (const [rel, text] of Object.entries(BASE)) write(w, rel, text);
  git(w, "add", "-A");
  git(w, "commit", "-q", "-m", "root");
  git(w, "branch", "-M", "main");
  git(w, "push", "-q", "-u", "origin", "main");
  const wt = join(w, ".worktrees", "feat");
  git(w, "worktree", "add", "-q", wt, "-b", "feat", "origin/main");
  return { root, origin, w, wt };
}

// Commit the PR's edits on the worktree branch and return the pin. `edit`
// receives the worktree; with no edit the commit is empty.
function pr(f, edit) {
  edit?.(f.wt);
  git(f.wt, "add", "-A");
  git(f.wt, "commit", "-q", "--allow-empty", "-m", "work");
  return git(f.wt, "rev-parse", "HEAD");
}

// Run the script as the finisher does: from the main checkout, against the
// worktree. `args` replaces the whole argv; `cwd` is where it runs (default:
// the clone).
function scope(f, pin, { args, cwd = f.w } = {}) {
  const argv = args ?? ["--worktree", f.wt, "--pin", pin];
  const r = spawnSync(process.execPath, [SCRIPT, ...argv], { cwd, env: ENV, encoding: "utf8" });
  let out = null;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    // a usage refusal prints no verdict
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, out };
}

// The verdict for a PR whose edits are `edit`.
const verdictFor = (f, edit) => scope(f, pr(f, edit));

// path -> class, for every path the verdict names. A path it names with
// `class: null` is one it could not place.
const classes = (out) => Object.fromEntries(out.paths.map((p) => [p.path, p.class]));

// path -> why, the reason the verdict gives for each path.
const whys = (out) => Object.fromEntries(out.paths.map((p) => [p.path, p.why]));

// --- exit 0: the inert rows --------------------------------------------------

test("exit 0: plain markdown in a glossary, a spec and a research record is inert, every path prose", () => {
  const f = fixture();
  const r = verdictFor(f, (wt) => {
    write(wt, "docs/glossary.md", "glossary, edited\n");
    write(wt, "docs/spec.md", "spec, edited\n");
    write(wt, "docs/research/r.md", "research, edited\n");
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.verdict, "inert");
  assert.deepEqual(classes(r.out), {
    "docs/glossary.md": "prose",
    "docs/spec.md": "prose",
    "docs/research/r.md": "prose",
  });
});

test("exit 0: the three METRICS files alone are inert, every path data", () => {
  const f = fixture();
  const r = verdictFor(f, (wt) => {
    write(wt, "docs/metrics/member-outcomes.tsv", "y\n");
    write(wt, "docs/metrics/ticket-features.tsv", "y\n");
    write(wt, "docs/metrics/tier-outcomes.tsv", "y\n");
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(classes(r.out), {
    "docs/metrics/member-outcomes.tsv": "data",
    "docs/metrics/ticket-features.tsv": "data",
    "docs/metrics/tier-outcomes.tsv": "data",
  });
});

test("exit 0: the METRICS files plus a plain markdown file is inert", () => {
  const f = fixture();
  const r = verdictFor(f, (wt) => {
    write(wt, "docs/metrics/tier-outcomes.tsv", "y\n");
    write(wt, "docs/glossary.md", "edited\n");
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(classes(r.out)["docs/glossary.md"], "prose");
  assert.equal(classes(r.out)["docs/metrics/tier-outcomes.tsv"], "data");
});

test("exit 0: a markdown file in a directory whose name only contains a prompt-surface word is prose", () => {
  const f = fixture();
  const r = verdictFor(f, (wt) => write(wt, "docs/skills-notes/x.md", "x\n"));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(classes(r.out)["docs/skills-notes/x.md"], "prose");
});

test("exit 0: the verdict is computed at the pin — a head that moved past it does not change it", () => {
  const f = fixture();
  const pin = pr(f, (wt) => write(wt, "docs/glossary.md", "edited\n"));
  pr(f, (wt) => write(wt, "src/code.mjs", "export const moved = 1;\n"));
  const r = scope(f, pin);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.pin, pin);
});

// --- exit 1: metrics that carry something else --------------------------------

test("exit 1: a METRICS file plus pricing.json is not inert, and pricing.json is named", () => {
  const f = fixture();
  const r = verdictFor(f, (wt) => {
    write(wt, "docs/metrics/tier-outcomes.tsv", "y\n");
    write(wt, "docs/metrics/pricing.json", "{\"x\":1}\n");
  });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(classes(r.out)["docs/metrics/pricing.json"], null);
  assert.match(r.out.paths.find((p) => p.path === "docs/metrics/pricing.json").why, /not prose or data/);
});

test("exit 1: a METRICS file plus router-table.json is not inert", () => {
  const f = fixture();
  const r = verdictFor(f, (wt) => {
    write(wt, "docs/metrics/tier-outcomes.tsv", "y\n");
    write(wt, "plugin/scripts/router-table.json", "{\"x\":1}\n");
  });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(classes(r.out)["plugin/scripts/router-table.json"], null);
});

test("exit 1: a metrics-looking file that is not one of the three METRICS paths is not data", () => {
  const f = fixture();
  const r = verdictFor(f, (wt) => write(wt, "docs/metrics/Tier-outcomes-2.tsv", "y\n"));
  assert.equal(r.status, 1, r.stderr);
  assert.equal(classes(r.out)["docs/metrics/Tier-outcomes-2.tsv"], null);
});

// --- exit 1: the prompt surface -----------------------------------------------

test("exit 1: a markdown file under a skills, agents or commands directory is the prompt surface", () => {
  for (const rel of [
    ".omp/skills/x/SKILL.md",
    "docs/agents/domain.md",
    "commands/run.md",
    "plugin/skills/x/SKILL.md",
    "plugin/agents/x.md",
    "plugin/commands/x.md",
  ]) {
    const f = fixture();
    const r = verdictFor(f, (wt) => write(wt, rel, "# edited\n"));
    assert.equal(r.status, 1, `${rel}: ${r.stderr}`);
    assert.equal(classes(r.out)[rel], null, rel);
  }
});

test("exit 0: a markdown file under a plugin directory is prose", () => {
  for (const rel of ["plugin/README.md", "docs/plugin/x.md"]) {
    const f = fixture();
    const r = verdictFor(f, (wt) => write(wt, rel, "# edited\n"));
    assert.equal(r.status, 0, `${rel}: ${r.stderr}`);
    assert.equal(classes(r.out)[rel], "prose", rel);
  }
});

test("exit 1: AGENTS.md, CLAUDE.md and GEMINI.md are the prompt surface at the root and nested", () => {
  for (const rel of ["AGENTS.md", "CLAUDE.md", "GEMINI.md", "docs/nested/AGENTS.md", "docs/CLAUDE.md", "docs/GEMINI.md"]) {
    const f = fixture();
    const r = verdictFor(f, (wt) => write(wt, rel, "# edited\n"));
    assert.equal(r.status, 1, `${rel}: ${r.stderr}`);
    assert.equal(classes(r.out)[rel], null, rel);
  }
});

test("exit 1: a markdown file under any dot-directory is the prompt surface", () => {
  for (const rel of [
    ".omp/rules/r.md",
    ".omp/RULES.md",
    ".omp/SYSTEM.md",
    ".omp/APPEND_SYSTEM.md",
    ".claude/CLAUDE.local.md",
    ".cursor/rules/x.md",
    ".github/copilot-instructions.md",
    "docs/.notes/x.md",
  ]) {
    const f = fixture();
    const r = verdictFor(f, (wt) => write(wt, rel, "# edited\n"));
    assert.equal(r.status, 1, `${rel}: ${r.stderr}`);
    const dir = rel.split("/").find((s) => s.startsWith("."));
    assert.deepEqual(r.out.paths.map((p) => [p.path, p.class, p.why]), [[rel, null, `prompt surface: directory ${dir}`]], rel);
  }
});

// --- the root .out-of-scope/ records ------------------------------------------

test("exit 0: adding, editing and deleting records directly in the root .out-of-scope/ is inert, every path prose", () => {
  const f = fixture();
  const r = verdictFor(f, (wt) => {
    write(wt, ".out-of-scope/new.md", "# New\n");
    write(wt, ".out-of-scope/also-new.markdown", "# Also new\n");
    write(wt, ".out-of-scope/x.md", "record, edited\n");
    rmSync(join(wt, ".out-of-scope/gone.md"));
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out.paths.map((p) => [p.path, p.status, p.class]).sort(), [
    [".out-of-scope/also-new.markdown", "A", "prose"],
    [".out-of-scope/gone.md", "D", "prose"],
    [".out-of-scope/new.md", "A", "prose"],
    [".out-of-scope/x.md", "M", "prose"],
  ]);
});

test("exit 1: a record path at any other depth, of any other file type or under a name that only starts with .out-of-scope is not prose, and is named", () => {
  for (const [rel, why] of [
    [".out-of-scope/AGENTS.md", "prompt surface: AGENTS.md"],
    [".out-of-scope/sub/x.md", "prompt surface: directory .out-of-scope"],
    ["docs/.out-of-scope/x.md", "prompt surface: directory .out-of-scope"],
    [".out-of-scope/x.txt", "docs, but not .md or .markdown"],
    [".out-of-scope-x/a.md", "prompt surface: directory .out-of-scope-x"],
    [".out-of-scopes/a.md", "prompt surface: directory .out-of-scopes"],
    [".out-of-scope.d/a.md", "prompt surface: directory .out-of-scope.d"],
  ]) {
    const f = fixture();
    const r = verdictFor(f, (wt) => write(wt, rel, "# edited\n"));
    assert.equal(r.status, 1, `${rel}: ${r.stderr}`);
    assert.deepEqual(r.out.paths.map((p) => [p.path, p.class, p.why]), [[rel, null, why]], rel);
  }
});

// Staged through the index, not written to disk: on a case-insensitive
// filesystem a write to `.Out-Of-Scope/` lands in the fixture's existing
// `.out-of-scope/` and git records it under that spelling.
test("exit 1: a record directory spelled in another case is not prose, and is named", () => {
  const f = fixture();
  const rel = ".Out-Of-Scope/x.md";
  const blob = git(f.wt, "rev-parse", "HEAD:.out-of-scope/x.md");
  git(f.wt, "update-index", "--add", "--cacheinfo", `100644,${blob},${rel}`);
  git(f.wt, "commit", "-q", "-m", "work");
  const r = scope(f, git(f.wt, "rev-parse", "HEAD"));
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(r.out.paths.map((p) => [p.path, p.class, p.why]), [[rel, null, "prompt surface: directory .Out-Of-Scope"]]);
});

test("exit 1: a record renamed into a dot-directory is not inert, the old side prose and the new side named", () => {
  const f = fixture();
  const r = verdictFor(f, (wt) => {
    mkdirSync(join(wt, ".omp"), { recursive: true });
    git(wt, "mv", ".out-of-scope/x.md", ".omp/x.md");
  });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(classes(r.out)[".out-of-scope/x.md"], "prose");
  assert.equal(classes(r.out)[".omp/x.md"], null);
  assert.equal(whys(r.out)[".omp/x.md"], "prompt surface: directory .omp");
});

test("exit 1: a deleted record beside an edit to docs/agents/triage-labels.md is not inert, the agents file the one path with no class", () => {
  const f = fixture();
  const r = verdictFor(f, (wt) => {
    rmSync(join(wt, ".out-of-scope/gone.md"));
    write(wt, "docs/agents/triage-labels.md", "labels, edited\n");
  });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(classes(r.out)[".out-of-scope/gone.md"], "prose");
  assert.deepEqual(r.out.paths.filter((p) => p.class === null).map((p) => p.path), ["docs/agents/triage-labels.md"]);
});

// --- exit 1: the file types that carry behavior -------------------------------

test("exit 1: one markdown file plus one .mjs, .yml or .json file is not inert", () => {
  for (const rel of ["src/new.mjs", "ci2.yml", "package2.json"]) {
    const f = fixture();
    const r = verdictFor(f, (wt) => {
      write(wt, "docs/glossary.md", "edited\n");
      write(wt, rel, "{}\n");
    });
    assert.equal(r.status, 1, `${rel}: ${r.stderr}`);
    assert.equal(classes(r.out)["docs/glossary.md"], "prose", "the markdown is still named prose");
    assert.equal(classes(r.out)[rel], null, rel);
  }
});

test("exit 1: a .txt, .rst or .mdx file is not prose here, though classify calls it docs", () => {
  for (const rel of ["docs/plain.txt", "docs/page.rst", "docs/page.mdx"]) {
    const f = fixture();
    const r = verdictFor(f, (wt) => write(wt, rel, "edited\n"));
    assert.equal(r.status, 1, `${rel}: ${r.stderr}`);
    assert.equal(classes(r.out)[rel], null, rel);
  }
});

test("exit 1: a markdown file under a test directory is not prose", () => {
  const f = fixture();
  const r = verdictFor(f, (wt) => write(wt, "tests/fixtures/readme.md", "edited\n"));
  assert.equal(r.status, 1, r.stderr);
  assert.equal(classes(r.out)["tests/fixtures/readme.md"], null);
});

// --- exit 1: a code change hidden in a prose path -----------------------------

test("exit 1: a markdown path turned into a symlink is not inert", () => {
  const f = fixture();
  const r = verdictFor(f, (wt) => symlinkSync("../src/code.mjs", join(wt, "docs/link.md")));
  assert.equal(r.status, 1, r.stderr);
  assert.equal(classes(r.out)["docs/link.md"], null);
  assert.equal(whys(r.out)["docs/link.md"], "symlink");
});

test("exit 1: a metrics file turned into a symlink is not inert", () => {
  const f = fixture();
  const r = verdictFor(f, (wt) => {
    rmSync(join(wt, "docs/metrics/tier-outcomes.tsv"));
    symlinkSync("../../src/code.mjs", join(wt, "docs/metrics/tier-outcomes.tsv"));
  });
  assert.equal(r.status, 1, r.stderr);
});

test("exit 1: a markdown file whose executable bit changes is not inert", () => {
  const f = fixture();
  const r = verdictFor(f, (wt) => chmodSync(join(wt, "docs/mode.md"), 0o755));
  assert.equal(r.status, 1, r.stderr);
  assert.equal(classes(r.out)["docs/mode.md"], null);
  assert.equal(whys(r.out)["docs/mode.md"], "executable bit");
});

test("exit 1: a markdown file replaced in place by a symlink is a type change, not inert", () => {
  const f = fixture();
  const r = verdictFor(f, (wt) => {
    rmSync(join(wt, "docs/mode.md"));
    symlinkSync("../src/code.mjs", join(wt, "docs/mode.md"));
  });
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(r.out.paths.map((p) => [p.path, p.status, p.class, p.why]), [["docs/mode.md", "T", null, "type change"]]);
});

test("exit 0: an uppercase .MD file is still prose", () => {
  const f = fixture();
  const r = verdictFor(f, (wt) => write(wt, "docs/Notes.MD", "edited\n"));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(classes(r.out)["docs/Notes.MD"], "prose");
});

test("exit 1: a prompt-surface directory in another case is still the prompt surface", () => {
  const f = fixture();
  const r = verdictFor(f, (wt) => write(wt, "Skills/x.md", "edited\n"));
  assert.equal(r.status, 1, r.stderr);
  assert.equal(classes(r.out)["Skills/x.md"], null);
});

test("exit 1: a submodule entry sitting at a markdown path is not inert", () => {
  const f = fixture();
  const sha = git(f.wt, "rev-parse", "HEAD");
  git(f.wt, "update-index", "--add", "--cacheinfo", `160000,${sha},docs/sub.md`);
  git(f.wt, "commit", "-q", "-m", "gitlink");
  const r = scope(f, git(f.wt, "rev-parse", "HEAD"));
  assert.equal(r.status, 1, r.stderr);
  assert.equal(classes(r.out)["docs/sub.md"], null);
  assert.equal(whys(r.out)["docs/sub.md"], "submodule");
});

test("exit 1: an empty diff is not inert", () => {
  const f = fixture();
  const r = verdictFor(f, undefined);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.out.verdict, "not-inert");
  assert.deepEqual(r.out.paths, []);
});

// --- renames: both sides are classified ---------------------------------------

test("exit 1: a rename whose new path is in the prompt surface is not inert, both sides named", () => {
  const f = fixture();
  const r = verdictFor(f, (wt) => {
    mkdirSync(join(wt, "plugin/agents"), { recursive: true });
    git(wt, "mv", "docs/old.md", "plugin/agents/new.md");
  });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(classes(r.out)["docs/old.md"], "prose", "the deleted old side is prose");
  assert.equal(classes(r.out)["plugin/agents/new.md"], null, "the added new side is not");
});

test("exit 1: a rename from markdown to a code file is not inert", () => {
  const f = fixture();
  const r = verdictFor(f, (wt) => git(wt, "mv", "docs/old.md", "src/new.mjs"));
  assert.equal(r.status, 1, r.stderr);
  assert.equal(classes(r.out)["src/new.mjs"], null);
});

test("exit 0: a rename between two prose paths is inert, both sides classified", () => {
  const f = fixture();
  const r = verdictFor(f, (wt) => git(wt, "mv", "docs/old.md", "docs/new.md"));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(classes(r.out)["docs/old.md"], "prose");
  assert.equal(classes(r.out)["docs/new.md"], "prose");
});

// --- exit 2: a diff that cannot be read ---------------------------------------

test("exit 2: a full-length pin that names no commit cannot be read", () => {
  const f = fixture();
  const r = scope(f, "0123456789abcdef0123456789abcdef01234567");
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.out.verdict, "unknown");
  assert.equal(r.out.reason, "pin names no commit");
});

test("exit 2: a pin that is not a full 40-hex SHA is refused as usage", () => {
  const f = fixture();
  const r = scope(f, pr(f, undefined).slice(0, 7));
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /finisher-scope: /);
});

test("exit 2: no origin/main to take the merge base against", () => {
  const f = fixture();
  const pin = pr(f, (wt) => write(wt, "docs/glossary.md", "edited\n"));
  git(f.w, "update-ref", "-d", "refs/remotes/origin/main");
  const r = scope(f, pin);
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.out.verdict, "unknown");
  assert.equal(r.out.reason, "no origin/main to take the merge base against");
});

// A worktree git cannot read at all is not a missing origin/main: git's own
// reason is the one reported, still on the could-not-look exit.
test("exit 2: a worktree that is no repository reports git's reason, not a missing origin/main", () => {
  const f = fixture();
  const plain = join(f.root, "plain");
  mkdirSync(plain);
  const r = scope(f, "0".repeat(40), { args: ["--worktree", plain, "--pin", "0".repeat(40)], cwd: plain });
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.out.verdict, "unknown");
  assert.match(r.out.reason, /^could not read origin\/main: git rev-parse exited 128: /);
});

test("exit 0: an uppercase-hex pin is accepted and reported lowercased", () => {
  const f = fixture();
  const pin = pr(f, (wt) => write(wt, "docs/glossary.md", "edited\n"));
  const r = scope(f, pin.toUpperCase());
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.verdict, "inert");
  assert.equal(r.out.pin, pin);
});

test("exit 2: an ambiguous merge base — two criss-cross merge bases — cannot be read", () => {
  const root = realpathSync(tempDir("finisher-scope-cc-"));
  const cc = join(root, "cc");
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", cc], { env: ENV });
  write(cc, "r.txt", "r\n");
  git(cc, "add", "-A");
  git(cc, "commit", "-q", "-m", "R");
  git(cc, "checkout", "-q", "-b", "a");
  write(cc, "a.txt", "a\n");
  git(cc, "add", "-A");
  git(cc, "commit", "-q", "-m", "A1");
  const a1 = git(cc, "rev-parse", "HEAD");
  git(cc, "checkout", "-q", "-b", "b", "main");
  write(cc, "b.txt", "b\n");
  git(cc, "add", "-A");
  git(cc, "commit", "-q", "-m", "B1");
  const b1 = git(cc, "rev-parse", "HEAD");
  git(cc, "checkout", "-q", "a");
  git(cc, "merge", "-q", "--no-edit", b1);
  const a2 = git(cc, "rev-parse", "HEAD");
  git(cc, "checkout", "-q", "b");
  git(cc, "merge", "-q", "--no-edit", a1);
  const b2 = git(cc, "rev-parse", "HEAD");
  git(cc, "update-ref", "refs/remotes/origin/main", a2);
  assert.equal(git(cc, "merge-base", "--all", a2, b2).split("\n").length, 2, "fixture: two merge bases");
  const r = scope({ w: cc, wt: cc }, b2);
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.out.verdict, "unknown");
});

// --- the script never writes to the audited worktree ----------------------------

test("exit 0 leaves an untracked file and the worktree's status exactly as they were", () => {
  const f = fixture();
  const pin = pr(f, (wt) => write(wt, "docs/glossary.md", "edited\n"));
  write(f.wt, "docs/untracked.md", "left alone\n");
  const before = git(f.wt, "status", "--porcelain");
  const r = scope(f, pin);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(f.wt, "status", "--porcelain"), before);
});

// --- the output contract -------------------------------------------------------

test("the verdict is one JSON line naming pin, base and each path with its class", () => {
  const f = fixture();
  const pin = pr(f, (wt) => write(wt, "docs/glossary.md", "edited\n"));
  const r = scope(f, pin);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim().split("\n").length, 1, "the verdict is one line");
  assert.equal(r.out.pin, pin);
  assert.equal(r.out.base, git(f.w, "merge-base", "origin/main", pin));
  assert.deepEqual(r.out.paths, [
    { path: "docs/glossary.md", status: "M", class: "prose", why: "plain markdown outside the prompt surface" },
  ]);
});

test("a usage error is a refusal on stderr with no verdict, exit 2", () => {
  const f = fixture();
  const r = scope(f, "", { args: ["--worktree", "relative/path", "--pin", "x"] });
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /^\nfinisher-scope: /);
});

test("an --worktree that cannot be stat'ed is a refusal with no verdict, exit 2", (t) => {
  if (process.getuid?.() === 0) return t.skip("root reads past a directory it has no permission on");
  const f = fixture();
  const locked = join(f.root, "locked");
  mkdirSync(join(locked, "wt"), { recursive: true });
  chmodSync(locked, 0o000);
  t.after(() => chmodSync(locked, 0o755));
  const r = scope(f, "", { args: ["--worktree", join(locked, "wt"), "--pin", "0".repeat(40)] });
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /^\nfinisher-scope: cannot stat .*: EACCES/);
});

// An inert diff is the case that matters: its exit 0 skips the mutation, so a
// verdict stdout refused must not leave that 0 standing.
test("a verdict that cannot be written to stdout is exit 2, never the verdict's own exit", () => {
  const f = fixture();
  const pin = pr(f, (wt) => write(wt, "docs/glossary.md", "edited\n"));
  const run = (stdout) =>
    spawnSync(process.execPath, [SCRIPT, "--worktree", f.wt, "--pin", pin], {
      cwd: f.w,
      env: ENV,
      encoding: "utf8",
      stdio: ["ignore", stdout, "pipe"],
    });
  assert.equal(run("pipe").status, 0, "control: the same diff writes and exits 0");
  const readOnly = openSync("/dev/null", "r");
  try {
    const r = run(readOnly);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /the verdict could not be written to stdout/);
  } finally {
    closeSync(readOnly);
  }
});

test("the module exports inertVerdict, callable in-process without exiting", async () => {
  const f = fixture();
  const pin = pr(f, (wt) => write(wt, "docs/glossary.md", "edited\n"));
  const mod = await import(pathToFileURL(SCRIPT).href);
  assert.equal(typeof mod.inertVerdict, "function");
  const v = mod.inertVerdict({ worktree: f.wt, pin });
  assert.equal(v.exit, 0);
  assert.equal(v.verdict, "inert");
  const upper = mod.inertVerdict({ worktree: f.wt, pin: pin.toUpperCase(), repo: null });
  assert.deepEqual([upper.verdict, upper.exit, upper.pin], ["inert", 0, pin]);
  // A pin that is not a SHA is never echoed back as one.
  const bad = mod.inertVerdict({ worktree: f.wt, pin: "NOTASHA" });
  assert.deepEqual([bad.verdict, bad.exit, bad.pin], ["unknown", 2, null]);
});

// The behavioural fixture for the one gitEnv() call site: an ambient GIT_DIR
// naming another repository must not retarget the verdict. Without the scrub,
// the pin is not in the decoy and the script exits 2.
test("an ambient GIT_DIR cannot retarget the verdict: it is read from the worktree's repository", () => {
  const f = fixture();
  const pin = pr(f, (wt) => write(wt, "docs/glossary.md", "edited\n"));
  const decoy = fixture();
  const r = spawnSync(process.execPath, [SCRIPT, "--worktree", f.wt, "--pin", pin], {
    cwd: f.w,
    env: { ...ENV, GIT_DIR: join(decoy.w, ".git"), GIT_WORK_TREE: decoy.w },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const v = JSON.parse(r.stdout);
  assert.equal(v.pin, pin);
  assert.equal(v.base, git(f.w, "merge-base", "origin/main", pin));
});
