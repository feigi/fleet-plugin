// Regression gate for staleness.mjs, the phase-0 probe that decides whether a
// shortlisted ticket is still live. Zero deps:
// `node --test skills/fleet/scripts/staleness.test.mjs`.
//
// A script that reasons about git history can only be tested against real git
// history, so every case below builds a throwaway bare origin plus a clone in
// a temp dir and runs the script for real — the same fixture idiom as
// `prove-merge.test.mjs`.
//
// THE LOAD-BEARING CASES ARE THE ONES THAT MUST STILL OFFER. A wrong `fixed`
// silently retires real supply, which is the harm #238's evidence criterion
// exists to prevent, and it is invisible: the ticket simply stops being
// shortlisted and nobody is told. So `never at this path answers unknown`,
// `untracked in origin/main answers unknown`, and `a fix that is only local
// answers live` each pin a case the probe must NOT report as fixed. The last
// of those is the one a probe written against the working tree passes anyway.
// The same rule governs the cases added since: an empty tracked file, a
// pathspec with more than one answer, and a `fixed` whose citation has to name
// the commit that was pushed rather than one sitting in a local branch.
//
// `git unavailable answers unknown, never fixed` guards the exit code from the
// other end: Node exits 1 on an uncaught throw and 1 is `fixed` here, so any
// failure that escapes must not land there. staleness.mjs's outer catch is the
// backstop for the throws no CLI input can reach today — the reachable ones
// each have their own guard, and this case exercises the git-is-not-there
// branch of that set.
//
// THE CEILING: this pins the verdict each input earns and the evidence the
// `fixed` verdict carries. It does not pin the `why` wording, which is prose
// for a reader and is meant to be rewritable.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./staleness.mjs", import.meta.url));

// Pin identity and cut the developer's ~/.gitconfig out of the fixture, so a
// local `pull.rebase`, hook or template cannot change what these repos look
// like. The GIT_* redirects would point the fixtures out of their own temp
// dirs; the fleet harness is exactly the caller that has them set.
const ENV = {
  ...process.env,
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
  LANG: "C",
  LC_ALL: "C",
};

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();

/** Write `body` to `rel`, commit it, and return the commit sha. */
function commitFile(w, rel, body, msg) {
  writeFileSync(join(w, rel), body);
  git(w, "add", rel);
  git(w, "commit", "-q", "-m", msg);
  return git(w, "rev-parse", "HEAD");
}

/** Bare origin + working clone whose `main` is pushed. Returns the clone dir. */
function repo(t) {
  const root = mkdtempSync(join(tmpdir(), "staleness-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  const w = join(root, "w");
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", "--bare", origin], { env: ENV });
  execFileSync("git", ["clone", "-q", origin, w], { env: ENV });
  commitFile(w, "src.mjs", "const keep = 1;\n", "root");
  git(w, "branch", "-M", "main");
  git(w, "push", "-q", "-u", "origin", "main");
  return w;
}

const push = (w) => git(w, "push", "-q", "origin", "main");

// process.execPath, not "node": one case runs with an empty PATH, and a bare
// "node" there is not found — the runner would die before the script does and
// the case would pass for the wrong reason.
function probe(cwd, args, env = ENV) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, env, encoding: "utf8" });
  return { code: r.status, json: r.stdout.trim() ? JSON.parse(r.stdout) : null, stderr: r.stderr };
}

test("a --present string the tree carries is fixed, and names the commit that added it", (t) => {
  const w = repo(t);
  const sha = commitFile(w, "src.mjs", "const keep = 1;\nfunction decodeArgs() {}\n", "add the guard");
  push(w);

  const r = probe(w, ["--path", "src.mjs", "--present", "decodeArgs"]);
  assert.equal(r.code, 1, `expected fixed (exit 1), got ${r.code}: ${r.stderr}`);
  assert.equal(r.json.verdict, "fixed");
  assert.equal(r.json.commit, sha, "the payload must name the commit a close would cite");
  assert.equal(r.json.subject, "add the guard", "the subject is what tells the reader the commit is about this");
});

// MUST STILL OFFER. A pin ticket whose assertion has not landed under this
// spelling stays live — including the case where an equivalent rewording did
// land, which reads the same way here and is a reason to offer, not to close.
test("a --present string the tree lacks is live", (t) => {
  const w = repo(t);
  const r = probe(w, ["--path", "src.mjs", "--present", "decodeArgs"]);
  assert.equal(r.code, 0, `expected live (exit 0), got ${r.code}: ${r.stderr}`);
  assert.equal(r.json.verdict, "live");
  assert.equal(r.json.found, false);
});

test("a --gone string the tree still carries is live", (t) => {
  const w = repo(t);
  commitFile(w, "src.mjs", "const keep = 1;\nconst wrong = 2;\n", "the defect");
  push(w);

  const r = probe(w, ["--path", "src.mjs", "--gone", "const wrong = 2;"]);
  assert.equal(r.code, 0, `expected live (exit 0), got ${r.code}: ${r.stderr}`);
  assert.equal(r.json.verdict, "live");
  assert.equal(r.json.found, true);
});

test("a --gone string a commit removed is fixed, and names the commit that removed it", (t) => {
  const w = repo(t);
  commitFile(w, "src.mjs", "const keep = 1;\nconst wrong = 2;\n", "the defect");
  const sha = commitFile(w, "src.mjs", "const keep = 1;\nconst right = 3;\n", "fix it in passing");
  push(w);

  const r = probe(w, ["--path", "src.mjs", "--gone", "const wrong = 2;"]);
  assert.equal(r.code, 1, `expected fixed (exit 1), got ${r.code}: ${r.stderr}`);
  assert.equal(r.json.verdict, "fixed");
  assert.equal(r.json.commit, sha);
  assert.equal(r.json.subject, "fix it in passing");
});

// MUST STILL OFFER, and this is the positive control. Absent from the current
// file is the same output whether the fix landed or the probe was pointed at a
// spelling this file never used — so absent-AND-never-here is unknown, never
// fixed. Without this the probe closes a live ticket on a typo.
test("a --gone string that was never at this path answers unknown, never fixed", (t) => {
  const w = repo(t);
  const r = probe(w, ["--path", "src.mjs", "--gone", "a spelling this file never had"]);
  assert.equal(r.code, 2, `expected could-not-check (exit 2), got ${r.code}: ${r.stderr}`);
  assert.equal(r.json.verdict, "unknown");
  assert.equal(r.json.found, false);
});

// MUST STILL OFFER. The generated-artifact case: the file is right there on
// disk and untracked in origin/main, which is what `.agent-test.sh` looks like
// in any checkout `./agent-test` has run in. Reading the on-disk copy would
// measure whatever the last run emitted; reading the absence as a clean tree would close the
// ticket. Neither: unknown.
test("a path untracked in origin/main answers unknown even though the file is on disk", (t) => {
  const w = repo(t);
  writeFileSync(join(w, "generated"), "const wrong = 2;\n");
  assert.ok(existsSync(join(w, "generated")), "the fixture must put the decoy on disk");

  const r = probe(w, ["--path", "generated", "--gone", "const wrong = 2;"]);
  assert.equal(r.code, 2, `expected could-not-check (exit 2), got ${r.code}: ${r.stderr}`);
  assert.equal(r.json.verdict, "unknown");
  assert.equal(r.json.tracked, false, "the payload must say the path is untracked, not that the string is gone");
});

// MUST STILL OFFER. `origin/main`, never the working tree — a fix committed
// locally and not pushed is not in the tree the fleet dispatches against, and a
// probe that read the checkout would retire the ticket on work nobody else can
// see.
test("a --gone fix that is only local, never pushed, is still live", (t) => {
  const w = repo(t);
  commitFile(w, "src.mjs", "const keep = 1;\nconst wrong = 2;\n", "the defect");
  push(w);
  commitFile(w, "src.mjs", "const keep = 1;\nconst right = 3;\n", "local fix, unpushed");

  const r = probe(w, ["--path", "src.mjs", "--gone", "const wrong = 2;"]);
  assert.equal(r.code, 0, `expected live (exit 0), got ${r.code}: ${r.stderr}`);
  assert.equal(r.json.verdict, "live");
  assert.equal(r.json.found, true, "the string must be read out of origin/main, where it is still present");
});

// The verdict here is `fixed` and it is the RIGHT verdict — what this pins is
// the evidence. The `-S` walk starts at origin/main so the commit it names is
// one everybody can see; walked from HEAD it answers `fixed` just as
// confidently and cites work that was never pushed, which is a close written
// against a commit nobody else has. The case above keeps a local fix from
// retiring the ticket; this one keeps a local commit out of the citation when
// the fix is real.
test("the commit a fixed verdict cites comes from origin/main, never a local one", (t) => {
  const w = repo(t);
  commitFile(w, "src.mjs", "const keep = 1;\nconst wrong = 2;\n", "the defect");
  push(w);
  const sha = commitFile(w, "src.mjs", "const keep = 1;\nconst right = 3;\n", "fix it upstream");
  push(w);
  // Both of these change the needle's count at this path and both are newer
  // than the pushed fix, so a walk over HEAD names one of them instead.
  commitFile(w, "src.mjs", "const keep = 1;\nconst wrong = 2;\n", "local: reintroduce, unpushed");
  commitFile(w, "src.mjs", "const keep = 1;\nconst right = 3;\n", "local: remove again, unpushed");

  const r = probe(w, ["--path", "src.mjs", "--gone", "const wrong = 2;"]);
  assert.equal(r.code, 1, `expected fixed (exit 1), got ${r.code}: ${r.stderr}`);
  assert.equal(r.json.commit, sha, "the citation must be the pushed fix, not the unpushed local commit");
  assert.equal(r.json.subject, "fix it upstream");
});

// MUST STILL OFFER. An empty file answers every search the same way, so
// without this the commit that emptied it gets cited as the fix — and the
// subject of a commit that wiped a file says nothing about the ticket.
test("an empty tracked file answers unknown, never fixed", (t) => {
  const w = repo(t);
  commitFile(w, "src.mjs", "const keep = 1;\nconst wrong = 2;\n", "the defect");
  push(w);
  commitFile(w, "src.mjs", "", "chore: reset generated file (unrelated)");
  push(w);

  const r = probe(w, ["--path", "src.mjs", "--gone", "const wrong = 2;"]);
  assert.equal(r.code, 2, `expected could-not-check (exit 2), got ${r.code}: ${r.stderr}`);
  assert.equal(r.json.verdict, "unknown");
  assert.equal(r.json.bytes, 0, "the payload must say the search had no bytes to look at");
});

// MUST STILL OFFER. A pathspec with more than one answer is not an answer:
// without the guard the probe reads whichever entry git listed first and
// reports on a file nobody asked about — here the clean one, while the defect
// sits live in its neighbour.
test("a pathspec resolving to more than one entry answers unknown", (t) => {
  const w = repo(t);
  commitFile(w, "zzz.mjs", "const wrong = 2;\n", "the defect, in the second file");
  push(w);

  const r = probe(w, ["--path", ".", "--gone", "const wrong = 2;"]);
  assert.equal(r.code, 2, `expected could-not-check (exit 2), got ${r.code}: ${r.stderr}`);
  assert.equal(r.json.verdict, "unknown");
});

// The probe answers a question about the tree, so where it was run from must
// not change the answer. git resolves a pathspec against the process's cwd:
// unanchored, a tracked file reads as UNTRACKED from a subdirectory, and an
// absolute path — the spelling a caller that just read the file produces —
// reads as a pathspec that resolved to something else. Both are false
// statements about the tree, in the file whose whole job is not making those.
test("--path is read against the repo root, from any cwd and either spelling", (t) => {
  const w = realpathSync(repo(t));
  mkdirSync(join(w, "sub"));

  const fromSub = probe(join(w, "sub"), ["--path", "src.mjs", "--gone", "const keep = 1;"]);
  assert.equal(fromSub.code, 0, `expected live (exit 0) from a subdirectory, got ${fromSub.code}: ${fromSub.stderr}`);
  assert.equal(fromSub.json.found, true, "a tracked file must not read as untracked because of the caller's cwd");

  const absolute = probe(w, ["--path", join(w, "src.mjs"), "--gone", "const keep = 1;"]);
  assert.equal(absolute.code, 0, `expected live (exit 0) for an absolute --path, got ${absolute.code}: ${absolute.stderr}`);
  assert.equal(absolute.json.found, true, "an absolute path names the same file as its root-relative spelling");
});

// A tree read as a file greps a list of FILENAMES, and a needle absent from
// that list reads as clean.
test("a path that names a directory answers unknown", (t) => {
  const w = repo(t);
  mkdirSync(join(w, "sub"));
  commitFile(w, "sub/inner.mjs", "const wrong = 2;\n", "a file in a directory");
  push(w);

  const r = probe(w, ["--path", "sub", "--gone", "const wrong = 2;"]);
  assert.equal(r.code, 2, `expected could-not-check (exit 2), got ${r.code}: ${r.stderr}`);
  assert.equal(r.json.verdict, "unknown");
});

// The exit code from the other end: 1 means "provably fixed", and Node's own
// default for an uncaught throw is also 1. A probe that cannot run git at all
// must not land there.
test("git unavailable answers unknown, never fixed", (t) => {
  const w = repo(t);
  const r = probe(w, ["--path", "src.mjs", "--gone", "const keep = 1;"], { ...ENV, PATH: "" });
  assert.equal(r.code, 2, `expected could-not-check (exit 2), got ${r.code}: ${r.stderr}`);
  assert.equal(r.json.verdict, "unknown");
});

// Neither mode given is a question the caller did not ask. Refusing beats
// picking a direction, because the wrong direction reports the opposite
// verdict with full confidence.
test("neither --gone nor --present refuses at exit 2 with no payload", (t) => {
  const w = repo(t);
  const r = probe(w, ["--path", "src.mjs"]);
  assert.equal(r.code, 2, `expected refusal (exit 2), got ${r.code}: ${r.stderr}`);
  assert.equal(r.json, null, "a refusal must print no verdict at all");
  assert.match(r.stderr, /^\nstaleness: /m);
});

test("both --gone and --present refuses at exit 2 with no payload", (t) => {
  const w = repo(t);
  const r = probe(w, ["--path", "src.mjs", "--gone", "a", "--present", "b"]);
  assert.equal(r.code, 2, `expected refusal (exit 2), got ${r.code}: ${r.stderr}`);
  assert.equal(r.json, null);
  assert.match(r.stderr, /opposite questions/);
});

// #818: the end-of-options separator. Without it, a `--`-prefixed needle can
// never reach this script's question — arg() refuses it as a missing value,
// and #240's ticket quotes exactly that shape, `--label ready-for-agent`.
// `--gone -- '<value>'` reads the token after `--` literally, however it
// starts.
test("a --gone needle starting with -- is checked when given after the end-of-options separator", (t) => {
  const w = repo(t);
  commitFile(w, "src.mjs", "const keep = 1;\nconst flag = '--require-file';\n", "the defect");
  push(w);

  const r = probe(w, ["--path", "src.mjs", "--gone", "--", "--require-file"]);
  assert.equal(r.code, 0, `expected live (exit 0), got ${r.code}: ${r.stderr}`);
  assert.equal(r.json.verdict, "live");
  assert.equal(r.json.needle, "--require-file", "the payload must carry the literal needle, not the separator");
  assert.equal(r.json.found, true);
});

// THE CONTROL. This is what proves #61/#169's original refusal survived
// #818: the identical needle, given bare with no separator, must still be
// refused — a flag swallowing the next flag as its own value was a real
// measured defect, and #818 only adds an opt-in past it, never weakens it.
test("the same --gone needle with NO separator is still refused at exit 2, today's message", (t) => {
  const w = repo(t);
  commitFile(w, "src.mjs", "const keep = 1;\nconst flag = '--require-file';\n", "the defect");
  push(w);

  const r = probe(w, ["--path", "src.mjs", "--gone", "--require-file"]);
  assert.equal(r.code, 2, `expected refusal (exit 2), got ${r.code}: ${r.stderr}`);
  assert.equal(r.json, null, "a refusal must print no verdict at all");
  assert.match(r.stderr, /^\nstaleness: --gone needs a value$/m);
});

// --present takes the same path through the separator opt-in as --gone;
// covered separately because a fix wiring only one of the two flags would
// pass every --gone case above.
test("a --present needle starting with -- is checked when given after the separator", (t) => {
  const w = repo(t);
  const r = probe(w, ["--path", "src.mjs", "--present", "--", "--not-here"]);
  assert.equal(r.code, 0, `expected live (exit 0), got ${r.code}: ${r.stderr}`);
  assert.equal(r.json.verdict, "live");
  assert.equal(r.json.needle, "--not-here");
  assert.equal(r.json.found, false);
});

// A needle that does NOT start with -- must answer identically whether or
// not the separator wraps it — the separator is an opt-in for one shape of
// value, not a different code path for an ordinary one.
test("an ordinary needle answers the same with or without the separator", (t) => {
  const w = repo(t);
  commitFile(w, "src.mjs", "const keep = 1;\nconst wrong = 2;\n", "the defect");
  push(w);

  const bare = probe(w, ["--path", "src.mjs", "--gone", "const wrong = 2;"]);
  const separated = probe(w, ["--path", "src.mjs", "--gone", "--", "const wrong = 2;"]);
  assert.equal(bare.code, separated.code);
  assert.deepEqual(bare.json, separated.json);
});

// The separator only counts immediately after the flag it modifies. A value
// given first with `--` trailing after it is the malformed order, not the
// opt-in spelling, and must refuse exactly like the no-separator case —
// otherwise the separator would forgive the exact invocation #61/#169
// exists to catch.
//
// The token AFTER the trailing `--` is what makes this discriminate, and it
// has to be a word the fixture carries. With nothing after the separator,
// a reader that took the LAST `--` in argv instead of the one immediately
// after the flag falls off the end of argv and dies on the same
// "needs a value" wording as the correct code — byte-identical stderr, exit
// and payload, so the case passes under the bug it names (measured). With
// `decoy` there and in the tree, that reader answers `live` at exit 0
// instead, on a needle nobody asked about.
test("a -- appearing AFTER the value, not before it, does not opt in — still refused", (t) => {
  const w = repo(t);
  commitFile(w, "src.mjs", "const keep = 1;\nconst decoy = 3;\n", "the decoy");
  push(w);

  const r = probe(w, ["--path", "src.mjs", "--gone", "--require-file", "--", "decoy"]);
  assert.equal(r.code, 2, `expected refusal (exit 2), got ${r.code}: ${r.stderr}`);
  assert.equal(r.json, null);
  assert.match(r.stderr, /--gone needs a value/);
});

// The separator with nothing after it is the same "no value" shape as
// today's bare-flag refusal, reached from the opt-in path instead.
test("-- as the very last token, with no value after it, refuses needs-a-value", (t) => {
  const w = repo(t);
  const r = probe(w, ["--path", "src.mjs", "--gone", "--"]);
  assert.equal(r.code, 2, `expected refusal (exit 2), got ${r.code}: ${r.stderr}`);
  assert.equal(r.json, null);
  assert.match(r.stderr, /--gone needs a value/);
});

// THE CLASS #818 EXISTS FOR, at its sharpest: the quoted needle spells one of
// this script's OWN flag names. A reader that resolves `--gone` over the whole
// argv before `--present` matches the token `--gone` sitting there as
// --present's already-quoted DATA, and refuses naming a flag the caller never
// typed — measured on that shape: `staleness: --gone needs a value`, exit 2.
// The needle here is absent from the tree, so the answer this must reach is
// `live` at exit 0; anything that reads it as a control token cannot get
// there.
test("a --present needle whose literal text is the sibling flag's own name is checked, not read as that flag", (t) => {
  const w = repo(t);
  const r = probe(w, ["--path", "src.mjs", "--present", "--", "--gone"]);
  assert.equal(r.code, 0, `expected live (exit 0), got ${r.code}: ${r.stderr}`);
  assert.equal(r.json.verdict, "live");
  assert.equal(r.json.needle, "--gone", "the payload must carry the caller's needle, not the flag it spells");
  assert.equal(r.json.found, false);
});

// Same class against `--path`, which is read AFTER the separator pass for
// exactly this reason: the quoted needle spells the flag whose value the
// script needs to find the file. Both assertions are load-bearing — the
// needle has to survive as data, and `--path` has to still resolve to
// src.mjs rather than to the quoted copy of its own name (measured on the
// resolve-path-first shape: `staleness: --path needs a value`, exit 2).
test("a --gone needle spelling --path leaves the real --path resolving to its own value", (t) => {
  const w = repo(t);
  commitFile(w, "src.mjs", "const keep = 1;\nconst flag = '--path';\n", "the defect");
  push(w);

  const r = probe(w, ["--gone", "--", "--path", "--path", "src.mjs"]);
  assert.equal(r.code, 0, `expected live (exit 0), got ${r.code}: ${r.stderr}`);
  assert.equal(r.json.verdict, "live");
  assert.equal(r.json.needle, "--path");
  assert.equal(r.json.path, "src.mjs", "the second --path is the flag; the first is the needle");
  assert.equal(r.json.found, true);
});

// The both-flags refusal, reached through the separator form. The bare-form
// case above it is pinned by a raw argv scan too, so it alone cannot tell
// this guard's resolved-value reading from a `process.argv.includes("--gone")
// && process.argv.includes("--present")` one: the separator pass splices both
// flag tokens out of argv before the guard runs, so that scan finds neither
// and lets the run through — measured, exit 0 with a full-confidence `live`
// under `--gone` while `--present` is silently dropped.
test("both --gone and --present through the separator form refuses at exit 2", (t) => {
  const w = repo(t);
  const r = probe(w, ["--path", "src.mjs", "--gone", "--", "--defect", "--present", "--", "--wanted"]);
  assert.equal(r.code, 2, `expected refusal (exit 2), got ${r.code}: ${r.stderr}`);
  assert.equal(r.json, null, "a refusal must print no verdict at all");
  assert.match(r.stderr, /opposite questions/);
});

// A repeated `--gone -- <value>` must not silently answer about the LAST one.
// The separator pass consumes a name once and steps over any repeat, which
// leaves that repeat's `--` a token no flag owns — and sweep() refuses it,
// the same exit-2 wording this shape earned before the pass existed.
test("a second --gone -- <value> refuses, rather than overwriting the first", (t) => {
  const w = repo(t);
  const r = probe(w, ["--path", "src.mjs", "--gone", "--", "a", "--gone", "--", "b"]);
  assert.equal(r.code, 2, `expected refusal (exit 2), got ${r.code}: ${r.stderr}`);
  assert.equal(r.json, null);
  assert.match(r.stderr, /unknown flag --/);
});
