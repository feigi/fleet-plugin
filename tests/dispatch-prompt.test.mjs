// Regression gate for dispatch-prompt.mjs, the renderer that turns a role's
// template into the brief a member is dispatched with.
//
// Zero deps: `node --test tests/dispatch-prompt.test.mjs`.
//
// Each case runs a COPY of the script out of a fixture install — a scripts/
// directory holding the script, every module it imports, and a stub
// instruments.sh, beside a skills/run-team/briefs/ directory copied from the
// repository — because the script resolves its templates and its instrument
// check relative to itself. The cwd is a real `git init`-ed repository, since
// the script derives the main checkout and the fleet directory from git. The
// stub records its argv and answers with whatever exit the case sets, which
// is how "refuses on every non-zero outcome" and "ran before anything else"
// are asserted without a pinned baseline. One case runs the real
// instruments.sh to show the pin covers the new script and the templates.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CASES, GOLDEN_DIR, PLUGIN, argvOf, briefFixtureName, cleanEnv, flagsOf, installRenderer, label } from "./support/render-brief.mjs";

const TMP = realpathSync(mkdtempSync(join(tmpdir(), "dispatch-prompt-")));
after(() => rmSync(TMP, { recursive: true, force: true }));

let counter = 0;
const fresh = (label) => {
  const d = join(TMP, `${label}-${counter++}`);
  mkdirSync(d, { recursive: true });
  return d;
};

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: cleanEnv() });
  assert.equal(r.status, 0, `fixture: git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function install(label, { edit } = {}) {
  return installRenderer(fresh(`install-${label}`), { edit });
}

const MAIN = install("main");
const REPO = fresh("repo");
git(REPO, "init", "-q");

function render(argv, { inst = MAIN, cwd = REPO, env = {} } = {}) {
  const log = join(fresh("log"), "calls.log");
  writeFileSync(log, "");
  const r = spawnSync(process.execPath, [inst.script, ...argv], {
    cwd,
    encoding: "utf8",
    env: { ...cleanEnv(), CALL_LOG: log, ...env },
  });
  assert.equal(r.signal, null, `the renderer was killed by ${r.signal}`);
  return { status: r.status, out: r.stdout, err: r.stderr, calls: readFileSync(log, "utf8").split("\n").filter(Boolean) };
}

const sha256 = (s) => createHash("sha256").update(s).digest("hex");


for (const c of CASES) {
  test(`${label(c)} renders with exactly these arguments, each reaching the brief`, () => {
    const r = render(argvOf(c));
    assert.equal(r.status, 0, r.err);
    assert.equal(r.err, "");
    for (const [k, v] of Object.entries(c.args)) assert.ok(r.out.includes(v), `--${k} ${v} never reached the brief`);
    // Nothing declared is left behind, and a brief is never empty.
    assert.ok(r.out.trim().length > 0);
    assert.ok(r.out.endsWith("\n"));
  });

  for (const k of Object.keys(c.args)) {
    test(`${label(c)} omitting --${k} exits 2 naming it and prints nothing`, () => {
      const { [k]: _omitted, ...rest } = c.args;
      const r = render(argvOf({ ...c, args: rest }));
      assert.equal(r.status, 2);
      assert.equal(r.out, "");
      assert.ok(r.err.includes(`missing required argument: --${k}\n`), `stderr did not name --${k}: ${r.err}`);
    });
  }
}

test("a flag the selected kind never uses is refused, not silently carried", () => {
  const review = CASES.find((c) => c.role === "fix-applier" && c.kind === "review");
  const r = render([...argvOf(review), "--mismatched-record", "/abs/x.json"]);
  assert.equal(r.status, 2);
  assert.equal(r.out, "");
  assert.ok(r.err.includes("--mismatched-record is not an argument of fix-applier review"), r.err);
});

test("an unknown flag exits 2 naming it, before the instrument check", () => {
  const r = render([...argvOf(CASES[0]), "--bogus-flag", "x"], { env: { INSTR_EXIT: "1" } });
  assert.equal(r.status, 2);
  assert.equal(r.out, "");
  assert.ok(r.err.includes("unknown flag --bogus-flag"), r.err);
  assert.deepEqual(r.calls, []);
});

test("--kind on a role with no kinds is an unknown flag", () => {
  const r = render([...argvOf(CASES.find((c) => c.role === "merge-bot")), "--kind", "fresh"]);
  assert.equal(r.status, 2);
  assert.ok(r.err.includes("unknown flag --kind"), r.err);
});

test("a role with kinds requires one, and refuses a kind it does not have", () => {
  const fin = CASES.find((c) => c.role === "finisher");
  const none = render(["render", "finisher", ...flagsOf(fin.args)]);
  assert.equal(none.status, 2);
  assert.ok(none.err.includes("--kind is required for finisher"), none.err);
  const bad = render(["render", "finisher", "--kind", "conflict", ...flagsOf(fin.args)]);
  assert.equal(bad.status, 2);
  assert.ok(bad.err.includes("--kind conflict is not a kind of finisher"), bad.err);
});

test("an unknown role and a missing role exit 2", () => {
  const unknown = render(["render", "tier-check"]);
  assert.equal(unknown.status, 2);
  assert.ok(unknown.err.includes("unknown role tier-check"), unknown.err);
  const none = render(["render"]);
  assert.equal(none.status, 2);
  assert.ok(none.err.includes("usage:"), none.err);
});

// --- paths -----------------------------------------------------------------

test("a relative path argument exits 2 for every role that takes one", () => {
  for (const c of CASES) {
    for (const k of Object.keys(c.args)) {
      if (!["worktree", "scratch", "repo", "mismatched-record"].includes(k)) continue;
      const r = render(argvOf({ ...c, args: { ...c.args, [k]: "relative/dir" } }));
      assert.equal(r.status, 2, `${label(c)} --${k} relative`);
      assert.equal(r.out, "");
      assert.ok(r.err.includes(`--${k} must be an absolute path`), `${label(c)} --${k}: ${r.err}`);
    }
  }
});

test("a review-runner --scratch ending in pr<digits> exits 2, with or without a trailing slash", () => {
  const rr = CASES.find((c) => c.role === "review-runner");
  for (const scratch of ["/abs/scratch-root/pr123", "/abs/scratch-root/pr123/", "/abs/scratch-root/pr123/."]) {
    const r = render(argvOf({ ...rr, args: { ...rr.args, scratch } }));
    assert.equal(r.status, 2, scratch);
    assert.equal(r.out, "");
    assert.ok(r.err.includes("already ends in a pr<N> directory"), r.err);
  }
});

test("only the review-runner refuses a pr<digits> scratch: another role's partition is its own", () => {
  const bot = CASES.find((c) => c.role === "merge-bot");
  assert.equal(render(argvOf({ ...bot, args: { ...bot.args, scratch: "/abs/scratch-root/pr123" } })).status, 0);
  const rr = CASES.find((c) => c.role === "review-runner");
  assert.equal(render(argvOf({ ...rr, args: { ...rr.args, scratch: "/abs/scratch-root/pr" } })).status, 0);
  assert.equal(render(argvOf({ ...rr, args: { ...rr.args, scratch: "/abs/pr123/scratch-root" } })).status, 0);
});

// --- the template contract ---------------------------------------------------

test("a template carrying an undeclared <foo> exits 2 naming <foo>, printing nothing", () => {
  const fin = CASES.find((c) => c.role === "recipe-deriver");
  const inst = install("undeclared", {
    edit: (briefs) => writeFileSync(join(briefs, "recipe-deriver.md"), `${readFileSync(join(briefs, "recipe-deriver.md"), "utf8")}and <foo> too\n`),
  });
  const r = render(argvOf(fin), { inst });
  assert.equal(r.status, 2);
  assert.equal(r.out, "");
  assert.ok(r.err.includes("<foo>"), r.err);
  // The control: the same render against the unedited install is fine.
  assert.equal(render(argvOf(fin)).status, 0);
});

test("an undeclared placeholder in a section the kind does not select is not this kind's defect", () => {
  const conflict = CASES.find((c) => c.role === "fix-applier" && c.kind === "conflict");
  const inst = install("other-kind", {
    edit: (briefs) => writeFileSync(join(briefs, "fix-applier.md"), `${readFileSync(join(briefs, "fix-applier.md"), "utf8")}## kind: dispositions-retry\n<foo>\n`),
  });
  assert.equal(render(argvOf(conflict), { inst }).status, 0);
  const retry = CASES.find((c) => c.role === "fix-applier" && c.kind === "dispositions-retry");
  const r = render(argvOf(retry), { inst });
  assert.equal(r.status, 2);
  assert.ok(r.err.includes("<foo>"), r.err);
});

test("a template with no text for the selected kind exits 2 instead of printing a blank brief", () => {
  const inst = install("empty", {
    edit: (briefs) => writeFileSync(join(briefs, "recipe-deriver.md"), "---\n---\n"),
  });
  const bare = render(["render", "recipe-deriver"], { inst });
  assert.equal(bare.status, 2);
  assert.equal(bare.out, "");
  assert.ok(bare.err.includes("template recipe-deriver.md carries no text for the role"), bare.err);
  const kinds = install("empty-kind", {
    edit: (briefs) => writeFileSync(join(briefs, "finisher.md"), "---\n---\n## kind: fresh\n## kind: repair\nwords\n"),
  });
  const empty = render(["render", "finisher", "--kind", "fresh"], { inst: kinds });
  assert.equal(empty.status, 2);
  assert.equal(empty.out, "");
  assert.ok(empty.err.includes("template finisher.md carries no text for kind fresh"), empty.err);
  const filled = render(["render", "finisher", "--kind", "repair"], { inst: kinds });
  assert.equal(filled.status, 0, filled.err);
  assert.equal(filled.out, "words\n");
});

test("a template that declares a placeholder it never carries is refused", () => {
  const rd = CASES.find((c) => c.role === "recipe-deriver");
  const inst = install("dead-arg", {
    edit: (briefs) => {
      const p = join(briefs, "recipe-deriver.md");
      writeFileSync(p, readFileSync(p, "utf8").replace("---\n", "---\narg ghost never carried\n"));
    },
  });
  const r = render(argvOf(rd), { inst });
  assert.equal(r.status, 2);
  assert.ok(r.err.includes("<never carried>"), r.err);
});

test("a template declaring a flag the renderer reserves is refused, naming the flag", () => {
  const rd = CASES.find((c) => c.role === "recipe-deriver");
  const declare = (label, flag) =>
    install(label, {
      edit: (briefs) => {
        const p = join(briefs, "recipe-deriver.md");
        writeFileSync(p, readFileSync(p, "utf8").replace("---\n", `---\narg ${flag} carried ${flag}\n`) + `and <carried ${flag}> too\n`);
      },
    });
  for (const flag of ["member", "json", "kind"]) {
    const r = render(argvOf(rd), { inst: declare(`reserved-${flag}`, flag) });
    assert.equal(r.status, 2, `--${flag}: ${r.err}`);
    assert.equal(r.out, "");
    assert.ok(r.err.includes(`declares the reserved flag --${flag}`), r.err);
  }
  // The control: the same edit under a flag no one reserves renders, once the flag is passed.
  const ok = render([...argvOf(rd), "--ghost", "value"], { inst: declare("reserved-control", "ghost") });
  assert.equal(ok.status, 0, ok.err);
  assert.ok(ok.out.includes("and value too"), ok.out);
});

test("a value spelling a declared placeholder exits 2 naming it; any other angle text is carried", () => {
  const fix = CASES.find((c) => c.role === "fix-applier" && c.kind === "review");
  const spelled = render(argvOf({ ...fix, args: { ...fix.args, branch: "<branch>" } }));
  assert.equal(spelled.status, 2);
  assert.equal(spelled.out, "");
  assert.ok(spelled.err.includes("<branch>"), spelled.err);
  const crossed = render(argvOf({ ...fix, args: { ...fix.args, testCmd: "<scratch>" } }));
  assert.equal(crossed.status, 2);
  assert.ok(crossed.err.includes("<scratch>"), crossed.err);
  const other = render(argvOf({ ...fix, args: { ...fix.args, testCmd: "run < in.txt > out.txt <word>" } }));
  assert.equal(other.status, 0, other.err);
  assert.ok(other.out.includes("run < in.txt > out.txt <word>"));
});

test("a value is inserted verbatim, whatever replacement syntax it holds", () => {
  const fix = CASES.find((c) => c.role === "fix-applier" && c.kind === "conflict");
  const r = render(argvOf({ ...fix, args: { ...fix.args, testCmd: "echo $& $1 $$ $`" } }));
  assert.equal(r.status, 0, r.err);
  assert.ok(r.out.includes("and `echo $& $1 $$ $`` from the worktree before you push"), r.out);
});

// --- the golden briefs -----------------------------------------------------

// Each rendered brief, of every role, is compared byte for byte with a golden
// file the test owns, rendered from the CASES arguments in support/render-brief.mjs.
// What a member's agent body carries is pinned beside this, in
// member-bodies-split.test.mjs and dispatch-block-golden-prose.test.mjs; a
// brief that regained a line the body owns, or lost a per-dispatch line, is red
// here.

for (const c of CASES) {
  test(`render ${label(c)} prints its golden brief, placeholders filled`, () => {
    const r = render(argvOf(c));
    assert.equal(r.status, 0, r.err);
    assert.equal(r.out, readFileSync(join(GOLDEN_DIR, briefFixtureName(c)), "utf8"));
  });
}

test("render finisher repair is the fresh brief plus a repair section", () => {
  const fresh_ = CASES.find((x) => x.role === "finisher" && x.kind === "fresh");
  const repair = CASES.find((x) => x.role === "finisher" && x.kind === "repair");
  const base = render(argvOf({ ...fresh_, args: repair.args, kind: "fresh" })).out;
  const out = render(argvOf(repair)).out;
  assert.ok(out.startsWith(base), "the repair brief no longer begins with the fresh brief");
  assert.ok(out.length > base.length);
});

// --- output ----------------------------------------------------------------

test("--json prints the payload instead of the brief, its sha256 the hash of the brief", () => {
  for (const c of CASES) {
    const brief = render(argvOf(c)).out;
    const r = render([...argvOf(c), "--json"]);
    assert.equal(r.status, 0, r.err);
    const payload = JSON.parse(r.out);
    assert.deepEqual(Object.keys(payload), ["role", "kind", "args", "sha256"]);
    assert.equal(payload.role, c.role);
    assert.equal(payload.kind, c.kind);
    assert.deepEqual(payload.args, c.args);
    assert.equal(payload.sha256, sha256(brief), label(c));
  }
});

test("--member writes the .md and .json under the fleet directory, the json sha256 the hash of the .md file", () => {
  const c = CASES.find((x) => x.role === "finisher" && x.kind === "fresh");
  const repo = fresh("repo-member");
  git(repo, "init", "-q");
  const r = render([...argvOf(c), "--member", "impl-412"], { cwd: repo });
  assert.equal(r.status, 0, r.err);
  const md = join(repo, ".fleet", "briefs", "impl-412.md");
  const js = join(repo, ".fleet", "briefs", "impl-412.json");
  assert.deepEqual(readdirSync(join(repo, ".fleet", "briefs")).sort(), ["impl-412.json", "impl-412.md"]);
  assert.equal(readFileSync(md, "utf8"), r.out);
  const record = JSON.parse(readFileSync(js, "utf8"));
  assert.deepEqual(Object.keys(record), ["role", "kind", "args", "sha256", "path"]);
  assert.equal(record.path, md);
  assert.equal(record.sha256, sha256(readFileSync(md)));
  const withJson = render([...argvOf(c), "--member", "impl-412", "--json"], { cwd: repo });
  assert.deepEqual(JSON.parse(withJson.out), { role: record.role, kind: record.kind, args: record.args, sha256: record.sha256 });
});

test("--member resolves the fleet directory of the main checkout from a linked worktree", () => {
  const c = CASES.find((x) => x.role === "merge-bot");
  const repo = fresh("repo-linked");
  git(repo, "init", "-q");
  git(repo, "-c", "user.name=f", "-c", "user.email=f@example.invalid", "commit", "-q", "--allow-empty", "-m", "base");
  const linked = join(fresh("linked"), "wt");
  git(repo, "worktree", "add", "-q", "--detach", linked);
  const r = render([...argvOf(c), "--member", "merge-bot-17"], { cwd: linked });
  assert.equal(r.status, 0, r.err);
  assert.ok(existsSync(join(repo, ".fleet", "briefs", "merge-bot-17.md")));
  assert.ok(!existsSync(join(linked, ".fleet")));
});

test("a --member name that is not a plain name exits 2 and writes nothing", () => {
  const c = CASES.find((x) => x.role === "merge-bot");
  for (const member of ["../escape", "a/b", ".hidden", "-x"]) {
    const repo = fresh("repo-badname");
    git(repo, "init", "-q");
    const r = render([...argvOf(c), "--member", member], { cwd: repo });
    assert.equal(r.status, 2, member);
    assert.equal(r.out, "");
    assert.ok(!existsSync(join(repo, ".fleet")), `${member} created a .fleet directory`);
  }
});

test("a failed --member write exits 2 with the brief nowhere on stdout", () => {
  const c = CASES.find((x) => x.role === "merge-bot");
  const repo = fresh("repo-unwritable");
  git(repo, "init", "-q");
  writeFileSync(join(repo, ".fleet"), "a file where the directory goes");
  const r = render([...argvOf(c), "--member", "impl-412"], { cwd: repo });
  assert.equal(r.status, 2);
  assert.equal(r.out, "");
  assert.ok(r.err.includes("cannot write --member impl-412's files"), r.err);
});

// --- the instrument check ---------------------------------------------------

test("the instrument check runs first, from the main checkout, and its exit 0 lets the render proceed", () => {
  const c = CASES.find((x) => x.role === "recipe-deriver");
  const r = render(argvOf(c));
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.calls, [`--repo ${REPO}`]);
});

test("the instrument check names the main checkout when run from a linked worktree", () => {
  const c = CASES.find((x) => x.role === "recipe-deriver");
  const repo = fresh("repo-linked-gate");
  git(repo, "init", "-q");
  git(repo, "-c", "user.name=f", "-c", "user.email=f@example.invalid", "commit", "-q", "--allow-empty", "-m", "base");
  const linked = join(fresh("linked-gate"), "wt");
  git(repo, "worktree", "add", "-q", "--detach", linked);
  const r = render(argvOf(c), { cwd: linked });
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.calls, [`--repo ${repo}`]);
});

for (const [name, env, says] of [
  ["exit 1 (the set changed)", { INSTR_EXIT: "1", INSTR_SAYS: "CHANGED-WORDS" }, "the instrument set changed"],
  ["exit 2 (could not answer)", { INSTR_EXIT: "2", INSTR_SAYS: "UNANSWERED-WORDS" }, "the check could not answer (exit 2)"],
  ["exit 3 (any other code)", { INSTR_EXIT: "3", INSTR_SAYS: "OTHER-WORDS" }, "the check could not answer (exit 3)"],
  ["a kill by signal", { INSTR_KILL: "1" }, "killed by SIGKILL"],
]) {
  test(`instruments.sh ${name} exits 2 with nothing rendered and nothing written`, () => {
    const c = CASES.find((x) => x.role === "merge-bot");
    const repo = fresh("repo-gate");
    git(repo, "init", "-q");
    const r = render([...argvOf(c), "--member", "merge-bot-17"], { cwd: repo, env });
    assert.equal(r.status, 2);
    assert.equal(r.out, "");
    assert.ok(r.err.includes(says), r.err);
    if (env.INSTR_SAYS) assert.ok(r.err.includes(env.INSTR_SAYS), "the instrument check's own words were dropped");
    assert.ok(!existsSync(join(repo, ".fleet")));
  });
}

test("the instrument check outranks an argument refusal", () => {
  const r = render(["render", "merge-bot"], { env: { INSTR_EXIT: "1" } });
  assert.equal(r.status, 2);
  assert.ok(r.err.includes("instruments.sh refused"), r.err);
  assert.ok(!r.err.includes("missing required argument"), r.err);
});

test("outside any git repository the render refuses instead of skipping the check", () => {
  const c = CASES.find((x) => x.role === "merge-bot");
  const r = render(argvOf(c), { cwd: fresh("no-repo"), env: { GIT_CEILING_DIRECTORIES: TMP } });
  assert.equal(r.status, 2);
  assert.equal(r.out, "");
  assert.ok(r.err.includes("instruments.sh not run"), r.err);
});

test("the real instruments.sh pin covers the renderer and the templates", () => {
  const repo = fresh("repo-pin");
  git(repo, "init", "-q");
  const files = ["plugin/scripts/dispatch-prompt.mjs", "plugin/skills/run-team/briefs/finisher.md"];
  // Positive control: the repository itself tracks both paths.
  const tracked = git(join(PLUGIN, ".."), "ls-files", "--", ...files).trim().split("\n");
  assert.deepEqual(tracked.sort(), [...files].sort());
  for (const f of files) {
    mkdirSync(join(repo, f, ".."), { recursive: true });
    writeFileSync(join(repo, f), "original\n");
  }
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=f", "-c", "user.email=f@example.invalid", "commit", "-q", "-m", "fixture");
  const sh = (...args) => spawnSync("sh", [join(PLUGIN, "scripts", "instruments.sh"), ...args], { cwd: repo, encoding: "utf8", env: cleanEnv() });
  assert.equal(sh("--pin").status, 0);
  assert.equal(sh().status, 0);
  for (const f of files) {
    writeFileSync(join(repo, f), "tampered\n");
    assert.equal(sh().status, 1, `${f} changed and the pin stayed silent`);
    writeFileSync(join(repo, f), "original\n");
    assert.equal(sh().status, 0);
  }
});

test("dispatch-prompt.mjs binds its flag refusal to arg.mjs's defineFlags, so the roster probes reach it", () => {
  const src = readFileSync(join(PLUGIN, "scripts", "dispatch-prompt.mjs"), "utf8");
  assert.match(src, /^import \{[^}]*\bmakeDie\b[^}]*\bdefineFlags\b[^}]*\} from "\.\/arg\.mjs";$/m);
});
