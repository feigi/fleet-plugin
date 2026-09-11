// #161. Gate for the CI checks that run a checker over `git ls-files '<glob>'`.
//
// `git ls-files '*.mjs' | xargs -r node --check` exits 0 on an empty match, and
// every checker in that job prints nothing on success — so a run that checked 23
// files and a run that checked 0 were byte-identical in the log. That last part
// is an observation from outside this repo — GitHub Actions runner log
// 30629390698, zero bytes between `##[endgroup]` and the next `##[group]` — and
// no copy of that log is in this tree, so nothing here can settle it. `pipefail`
// cannot see it either: the left-hand side SUCCEEDS, it just succeeds with
// nothing. One directory rename and a step is vacuously green forever. `shopt -s
// failglob`, which PR #157 used for the Tests step, does not apply — the glob is
// quoted and expanded by `git ls-files`, not by the shell.
//
// Two halves, because a guard that only ever sees valid input pins neither:
//   - REFUSE: an empty match is exit 1 and the checker never runs.
//   - ACCEPT: a populated tree still runs the checker on every file and exits 0,
//     and a failing checker still fails the step. All five globs in ci.yml match
//     files today (mjs 57, js 2, json 2, sh 13, py 7 at 6815db6), so the guard
//     is not firing on the real tree — these two cases are what says so.
//
// The behavioural cases pin the script. The source assertions at the bottom pin
// that ci.yml actually ROUTES through it: without them a step reverted to bare
// `xargs -r` leaves this whole file green while the defect is back. They pin
// the routing AND the status — a step is free to route through the guard and
// then discard the exit code it just asked for, which checks exactly as much
// as not routing at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { between, phrase } from "./prose-pin.mjs";

const SCRIPT = fileURLToPath(new URL("../../.github/scripts/check-tracked.sh", import.meta.url));
const CI_YML = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));

// Cut the developer's ~/.gitconfig out of the fixtures, and stop a GIT_* export
// in the ambient environment from pointing them out of their own temp dir.
const ENV = {
  ...process.env,
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

/** Throwaway repo with `files` tracked (name -> contents). Returns its path. */
function repo(t, files) {
  const dir = mkdtempSync(join(tmpdir(), "ci-vacuous-green-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", dir], { env: ENV });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  execFileSync("git", ["add", "-A"], { cwd: dir, env: ENV });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: dir, env: ENV });
  return dir;
}

const check = (cwd, ...args) =>
  spawnSync(SCRIPT, args, { cwd, env: ENV, encoding: "utf8" });

test("empty match: exit 1, says so, and the checker never runs", (t) => {
  const dir = repo(t, { "readme.md": "no scripts here\n" });

  const r = check(dir, "*.mjs", "-n1", "sh", "-c", "echo CHECKER-RAN", "sh");

  assert.equal(r.status, 1);
  const out = r.stdout + r.stderr;
  assert.match(out, /::error::/, "an empty match must be loud in the runner log");
  assert.match(out, /\*\.mjs/, "the message must name the glob that matched nothing");
  // The point of the whole ticket: the old form exited 0 having run nothing.
  assert.doesNotMatch(out, /CHECKER-RAN/, "nothing may be checked on an empty match");
});

test("populated match: runs the checker on every file, prints the count, exits 0", (t) => {
  const dir = repo(t, { "a.mjs": "1\n", "b.mjs": "2\n", "c.txt": "3\n" });

  const r = check(dir, "*.mjs", "-n1", "sh", "-c", 'echo "saw $1"', "sh");

  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /checking 2 file\(s\)/, "the count must be visible in the log");
  assert.match(r.stdout, /saw a\.mjs/);
  assert.match(r.stdout, /saw b\.mjs/);
  assert.doesNotMatch(r.stdout, /c\.txt/, "the glob must still select");
});

test("no checker given: refuses instead of echoing the files it never checked", (t) => {
  const dir = repo(t, { "a.mjs": "1\n" });

  const r = check(dir, "*.mjs");

  assert.notEqual(r.status, 0, "a glob with no checker verifies nothing and must not pass");
  // `xargs` handed no command runs its default, `echo`, so the filenames scroll
  // past in the log looking like a check that ran.
  assert.doesNotMatch(r.stdout, /a\.mjs/, "xargs' default echo must not stand in for the checker");
});

test("no arguments at all: an ::error:: line, not a raw bash diagnostic", (t) => {
  const dir = repo(t, { "a.mjs": "1\n" });

  const r = check(dir);

  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /::error::/, "every refusal has to reach the runner log as an annotation");
});

test("a checker that fails still fails the step", (t) => {
  const dir = repo(t, { "a.mjs": "1\n" });

  const r = check(dir, "*.mjs", "-n1", "false");

  assert.notEqual(r.status, 0, "the guard must not swallow the real check's status");
});

test("a path holding a space reaches the checker as one argument", (t) => {
  const dir = repo(t, { "a b.mjs": "1\n" });

  const r = check(dir, "*.mjs", "-n1", "sh", "-c", 'printf "[%s]\\n" "$1"', "sh");

  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /\[a b\.mjs\]/, "NUL-delimited, not word-split");
});

// --- ci.yml routes through the guard -----------------------------------------
// Flattened, so a re-indent or a line break inside the step cannot red this;
// only the command actually changing can. Same convention as the *-prose tests.
const flat = (s) => s.replace(/\s+/g, " ");

test("every ls-files check in ci.yml goes through check-tracked.sh", () => {
  const ci = flat(readFileSync(CI_YML, "utf8"));

  // No "*.py": skills/caveman-compress was the only tracked Python and left
  // with the 2026-09-08 config split, taking its ci.yml step with it.
  for (const glob of ["*.mjs", "*.json", "*.sh"]) {
    // ok(), not match(): a failed match dumps the whole flattened workflow into
    // the log and buries the one line saying which check lost its guard.
    assert.ok(phrase(`check-tracked.sh '${glob}'`).test(ci), `the ${glob} check no longer routes through check-tracked.sh`);
  }
  assert.ok(!/xargs\s+-r\b/.test(ci), "`xargs -r` is back — that is the vacuous-green form #161 removed");
});

test("the .js step refuses an empty match too", () => {
  // Strip `#` comments before matching, same as the gojq pin below: a
  // commented-out `echo "::error::..."` / `exit 1` still CONTAINS the literal
  // this looks for, so against the raw file a disabled refusal and a live one
  // read identically. Both comment forms, since killing only whole-line ones
  // leaves the trailing form as the same hole.
  const ci = flat(
    readFileSync(CI_YML, "utf8")
      .split("\n")
      .map((l) => l.replace(/(^|\s)#.*$/, ""))
      .join("\n"),
  );

  // Not an xargs step — a `for` loop over `git ls-files '*.js'`, which iterates
  // zero times and exits 0 on an empty match. Same defect, different shape, so
  // it carries its own guard rather than routing through the script.
  // The `exit 1` is the half that refuses: an `::error::` annotation does not
  // fail a step by itself, so pinning the message alone would pin a step that
  // prints the complaint and goes green anyway.
  assert.ok(
    phrase('no tracked file matches *.js — this check verified nothing" exit 1').test(ci),
    "the .js loop lost its empty-match refusal",
  );
});

test("a routed check's own exit status still reaches the job", () => {
  const src = readFileSync(CI_YML, "utf8");
  const routed = src
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("run:") && l.includes("check-tracked.sh"));

  // 3 original (*.mjs / *.js loop is hand-rolled, not check-tracked.sh /
  // *.json / *.sh) + 3 for #1347's allow-list checker (agents/skills/
  // commands), one single-line `run:` step each so each stays visible to
  // this collector — a multi-line `run: |` block hides every invocation
  // inside it from a line-anchored `run:` filter, which is exactly what an
  // earlier draft of #1347 did before this test's own review caught it.
  assert.equal(routed.length, 6, "expected six ci.yml steps to route through check-tracked.sh");
  for (const line of routed) {
    // Unflattened and anchored at both ends, unlike the assertions above, because
    // what this one pins is what is NOT on the line: ` || true`, `; true`, `&& :`
    // and a trailing pipe all leave every substring those match in place and hand
    // the job exit 0 whatever the guard decided. The `+` also requires a checker
    // to follow the glob, which is the same contract the script now enforces.
    // The glob itself is `'[^']*\*[^']*'` rather than the original bare
    // `'\*\.\w+'` — #1347's allow-list checks glob a directory path plus an
    // extension (`'plugin/agents/*.md'`), not just a bare extension pattern
    // (`'*.json'`), and both shapes carry the same no-swallow contract.
    assert.match(
      line,
      /^run: \.github\/scripts\/check-tracked\.sh '[^']*\*[^']*'(?: [\w./-]+)+$/,
      `this routed check no longer fails the step on its own status: ${line}`,
    );
  }
  // The same swallow, one level up: a step marked continue-on-error reports its
  // failure and the job passes regardless.
  assert.ok(!/continue-on-error:\s*true/.test(src), "a step that cannot fail the job cannot check anything either");
});

// The `#`-comment-stripped read both gojq pins below share. A commented-out
// line still CONTAINS the literal an assertion looks for, so against the raw
// file a live command and a dead one read identically — and commenting out the
// wiring is exactly the mutation that hands the engine gates back their skip.
// Both comment forms, because killing only whole-line ones leaves the trailing
// form as the same hole. One definition rather than a copy per pin: a local
// copy of a pin's own bound is how the second pin ships without it, which is
// the call `prose-pin.mjs` makes about `paragraph` for the same reason.
const ciWithoutComments = () =>
  readFileSync(CI_YML, "utf8")
    .split("\n")
    .map((l) => l.replace(/(^|\s)#.*$/, ""))
    .join("\n");

// --- the Tests step provisions the engine its gates need -----------------------
// #337. A different shape of the same vacuous green, and the reason this pin
// lives here rather than beside the gate it protects: candidates.test.mjs gates
// its engine-parity tests on a resolvable gojq binary, and a gate that resolves
// none SKIPS — which node counts as a test and reports under a `fail 0` summary.
// So the wiring below can be deleted with the whole suite still green, and only
// the `skipped` count moves. That is what this test refuses.
//
// It pins the wiring — all three legs of it, the install command, the GOBIN
// that decides where the install deposits the binary, and the GOJQ_BIN the
// gates read — but not that a binary really lands at the path those two imply,
// which is go's placement behaviour and runs nowhere in this suite: a GOJQ_BIN
// naming a binary the install did not produce is already loud, since
// findGojq() throws on a GOJQ_BIN that is not gojq rather than falling back to
// a skip.
test("ci.yml provisions gojq for the engine gates, at a pinned version", () => {
  const ciRaw = ciWithoutComments();
  const ci = flat(ciRaw);

  assert.ok(
    phrase("go install github.com/itchyny/gojq/cmd/gojq@v0.12.19").test(ci),
    "the Install gojq step no longer installs the gojq the engine gates resolve — they are back to skipping",
  );
  // `@latest` installs a gojq that satisfies the gate while changing what the
  // gate measures, with no commit here to say so.
  assert.ok(!/gojq[^\s]*@latest/.test(ci), "the gojq install is floating again — pin the version");
  // The leg between the other two: `go install` deposits its output where GOBIN
  // says, so dropping this env leaves the binary in $(go env GOPATH)/bin and
  // GOJQ_BIN pointing at nothing. That does red the job — but it reds it saying
  // `GOJQ_BIN=… is not gojq`, naming the variable that is still correct. This
  // assertion exists to name the one that went missing.
  //
  // Scoped to the Install-gojq step's own slice, not the whole flattened file:
  // an unscoped phrase() match is a substring test, so GOBIN moved verbatim
  // into the Tests step's env block would still satisfy it. And the phrase is
  // followed by a negative lookahead for a non-whitespace character, so a
  // value with an extra path segment tacked on (`.../gojq/bin`, which still
  // starts with the pinned value) cannot slide through as a prefix match —
  // `go install` would drop the binary somewhere GOJQ_BIN does not point at.
  const installStep = flat(between(ciRaw, "- name: Install gojq", "- name: Tests", "ci.yml Install gojq step"));
  assert.ok(
    new RegExp(phrase("GOBIN: ${{ runner.temp }}/gojq").source + String.raw`(?!\S)`).test(installStep),
    "the Install gojq step lost its GOBIN, or GOBIN no longer points at exactly ${{ runner.temp }}/gojq — restore it, whatever the job's own failure says about GOJQ_BIN",
  );
  assert.ok(
    phrase("GOJQ_BIN: ${{ runner.temp }}/gojq/gojq").test(ci),
    "the Tests step no longer names the binary, so a failed provision skips quietly instead of failing the job",
  );
});

// --- the version ci.yml installs is the version the instructions name -------
// #956. The pinned gojq version is written in five tracked places and exactly
// one of them runs: ci.yml's install step. The pin above lifts it verbatim,
// and three local-reproduction instructions under `candidates.*` restate it —
// the SKIP_WITHOUT_GOJQ message a developer reads when the engine gates
// decline to run, plus two comments quoting the same `go install` line.
// Nothing asserted they agree. A bump to ci.yml reds the pin above, so THAT
// copy gets updated; the instructions do not red, and a developer following
// them installs an engine CI does not run while the gate reports green. That
// is the drift #947's pin exists to refuse, one step removed — a floating
// engine changes what the gate MEASURES with no commit saying so.
//
// Direction is the whole design. ci.yml is the source of truth because it is
// the only site with an effect, so the version is READ from it — a literal
// here would be a fifth copy, and it would agree with itself while every
// instruction went stale. The pin above keeps its verbatim lift deliberately:
// that assertion says "a bump is a deliberate edit in this repo", which an
// assertion derived from the file it reads cannot say. Two different claims
// about one literal, and this one needs the other to stay hardcoded.
//
// `candidates.*` are read RAW — the opposite of the ci.yml read above —
// because two of the three instructions ARE comments. That is the form a
// local reproduction takes, and stripping them would leave this test reading
// nothing. The escape that forces the strip above does not exist here: that
// pin proves a command is LIVE, where this one proves every occurrence
// AGREES, and commenting one out cannot buy a false green because the
// occurrence still has to name the same version.
const CANDIDATES = fileURLToPath(new URL("./candidates.mjs", import.meta.url));
const CANDIDATES_TEST = fileURLToPath(new URL("./candidates.test.mjs", import.meta.url));

// Every `go install …/gojq@<version>` ref in `src`, in order. A fresh regex per
// call, never a shared `/g` literal: `lastIndex` persists on those between
// call sites, and a pin whose result depends on which site ran first is not a
// pin. The capture stops at the first character a version cannot contain, so
// the backtick closing a comment's code span is not swallowed into it — `\S+`
// there would compare a trailing "`)" against ci.yml's bare version and red on
// a clean tree. The `v` is required: `@latest` then matches nothing and is
// reported as an absent ref, which is louder than capturing "latest" and
// letting it agree with another "latest" somewhere else.
const installRefs = (src) => [...src.matchAll(/gojq\/cmd\/gojq@(v[\w.+-]+)/g)].map((m) => m[1]);

test("candidates.*'s gojq install instructions name the version ci.yml installs", () => {
  // Guarded, and inside the test body rather than at module scope. An
  // unguarded `.match(…)[0]` throws where it stands on a ci.yml this suite only
  // READS, and at module scope that throw takes every test in this file with
  // it — a zero-behaviour reformat must cost one red assertion, not a whole
  // file. candidates.test.mjs already carries two module-scope collapse paths,
  // which is the reason not to author a third anywhere in this area.
  const pinned = installRefs(ciWithoutComments());
  assert.equal(
    pinned.length,
    1,
    `.github/workflows/ci.yml must name exactly one pinned gojq install ref for the instructions to agree with — found ${pinned.length}: ${pinned.join(", ") || "none, so the Install gojq step is gone, commented out, or floating on @latest"}`,
  );
  const want = pinned[0];

  for (const [name, path] of [
    ["plugin/scripts/candidates.mjs", CANDIDATES],
    ["plugin/scripts/candidates.test.mjs", CANDIDATES_TEST],
  ]) {
    for (const got of installRefs(readFileSync(path, "utf8"))) {
      assert.equal(
        got,
        want,
        `${name} tells a developer to install gojq ${got}, but .github/workflows/ci.yml installs ${want} — unskipping the engine gates locally would measure a different engine than CI runs; bump both or neither`,
      );
    }
  }

  // The loop pins agreement, not presence, so alone it is satisfied by a
  // `candidates.*` with every instruction deleted. This is the one instruction
  // that may not go missing: it is live code, it is what a developer actually
  // reads when the gates skip, and it is the site #956 names. Sliced to its own
  // declaration rather than matched file-wide, so neither comment can stand in
  // for it. Presence is deliberately NOT asserted for those two — whether
  // `candidates.mjs`'s comment should carry a version at all is an open
  // question on #956, and a presence pin here would settle it by force.
  const skip = between(
    readFileSync(CANDIDATES_TEST, "utf8"),
    "const SKIP_WITHOUT_GOJQ",
    "\n",
    "plugin/scripts/candidates.test.mjs",
  );
  assert.ok(
    installRefs(skip).includes(want),
    `plugin/scripts/candidates.test.mjs's SKIP_WITHOUT_GOJQ message no longer tells a developer to install gojq ${want}, the version .github/workflows/ci.yml installs — the skip message now names no version at all, or names it in a form this assertion cannot read`,
  );
});
