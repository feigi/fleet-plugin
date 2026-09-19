// Regression gate for staleness.mjs, the phase-0 probe that decides whether a
// shortlisted ticket is still live. Zero deps:
// `node --test plugin/scripts/staleness.test.mjs`.
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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./strip-comments.mjs";

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

// #1599: git()'s single spawn primitive — every git call in this file routes
// through it — passed no env at all before this fix, and #1020's own census
// could not see it — its scan is `.sh`-only. Measured directly: an ambient
// GIT_DIR or GIT_WORK_TREE (a git hook, `rebase --exec`, `bisect run`)
// corrupts this file's answer in its own distinct way, silently.
test("rev-parse: an inherited GIT_WORK_TREE must not substitute a foreign repo root, turning a fixed ticket unknown", (t) => {
  const w = repo(t);
  const sha = commitFile(w, "src.mjs", "const keep = 1;\nfunction decodeArgs() {}\n", "add the guard");
  push(w);
  const other = mkdtempSync(join(tmpdir(), "staleness-other-"));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", other], { env: ENV });

  // Unscrubbed, `git rev-parse --show-toplevel` answers with the AMBIENT
  // GIT_WORK_TREE outright, regardless of the real cwd (`w`) — so `root`
  // becomes `other`, every pathspec below resolves against a directory that
  // does not track `src.mjs` at all, and a ticket that IS fixed reports as
  // untracked/unknown instead.
  const r = probe(w, ["--path", "src.mjs", "--present", "decodeArgs"], { ...ENV, GIT_WORK_TREE: other });
  assert.equal(r.code, 1, `expected fixed (exit 1), got ${r.code}: ${r.stderr}`);
  assert.equal(r.json.verdict, "fixed");
  assert.equal(r.json.commit, sha);
});

test("ls-tree/log -S: an inherited GIT_DIR must not substitute a foreign repository's origin/main for this repository's own", (t) => {
  const w = repo(t);
  const sha = commitFile(w, "src.mjs", "const keep = 1;\nfunction decodeArgs() {}\n", "add the guard");
  push(w);
  const other = mkdtempSync(join(tmpdir(), "staleness-other-"));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", other], { env: ENV });

  // `w` IS the toplevel already (no subdirectory involved), so GIT_DIR alone
  // leaves the rev-parse call above unaffected (measured) and this isolates
  // the SECOND-through-FOURTH calls: `-C root ls-tree/cat-file/log -S`.
  // Unscrubbed, GIT_DIR still outranks the explicit `-C root` — measured,
  // `ls-tree origin/main` under this ambient GIT_DIR reads the OTHER
  // (unrelated, ref-less) repository's object database instead and fails to
  // resolve `origin/main` at all, which downgrades a fixed ticket to
  // could-not-check rather than citing its real commit.
  const r = probe(w, ["--path", "src.mjs", "--present", "decodeArgs"], { ...ENV, GIT_DIR: join(other, ".git") });
  assert.equal(r.code, 1, `expected fixed (exit 1), got ${r.code}: ${r.stderr}`);
  assert.equal(r.json.verdict, "fixed");
  assert.equal(r.json.commit, sha, "the citation must come from THIS repository's origin/main, never the ambient one's");
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

// ── #889: verdict()'s writeSync must consume its own return value ────────
//
// A single writeSync call can short-write on a non-blocking pipe: it returns
// the count it actually wrote and throws nothing at all, so a `try`/`catch`
// wrapped around one call never fires and the verdict payload is silently
// truncated with no diagnostic — the same class ci-state.mjs's emit() had
// before #885. Unlike ci-state.mjs, staleness.mjs never initialises its own
// stream on fd 1 (nothing here calls console.log/process.stdout), so fd 1
// only goes non-blocking if a parent process hands it that way; the
// hardening still matters for that caller shape, which is why it is pinned
// here rather than dropped as unreachable. Racing a reader into that
// non-blocking state is what the NOT-PINNED comment above verdict() already
// refuses to do for the pipe-closed case, so this is a deterministic
// source-shape pin instead, the same technique candidates.test.mjs uses for
// arg.mjs's die() (search that file for "Each fragment anchored at a line
// start" for the anchoring rationale this pin reuses verbatim).
//
// A body that still calls writeSync once and discards the count — `try {
// writeSync(1, ...) } catch { die(...) }` — satisfies a pin that stops at
// `try {`, so this one requires the loop that resumes from writeSync's own
// return value, mirroring ci-state.mjs's emit() (#885). #889 also capped the
// retry (see below), which is why `retries` now sits between the try and the
// buffer it counts against.
test("verdict()'s writeSync consumes its own return value in a loop, not just a bare call", () => {
  assert.match(
    stripComments(readFileSync(SCRIPT, "utf8")),
    /^\s*try \{\s*^\s*let retries = 0;\s*^\s*let buf = Buffer\.from\(`[^`]*`\);\s*^\s*while \(buf\.length\) \{\s*^\s*try \{\s*^\s*buf = buf\.subarray\(writeSync\(1, buf\)\);/m,
  );
});

// verdict()'s EAGAIN retry loop had the same #889 gap as die()'s: no cap, so
// a stdout reader that stays open but never drains left writeSync throwing
// EAGAIN forever and the "a failed write is a could-not-check" downgrade this
// function's own comment promises — the whole reason it writeSyncs instead of
// console.log — never ran. MAX_EAGAIN_RETRIES bounds it: past the cap the
// loop re-throws, the outer catch calls die(), and the process still exits 2
// with the could-not-check refusal on stderr.
//
// Reproduced with a real non-blocking pipe, not a mock: fcntl sets O_NONBLOCK
// on the write end before the child ever touches it, so the OS — not a stub
// — is what throws EAGAIN. The read end is held open but never read, which is
// the case this pins: closing it instead would make every write EPIPE, a
// different (already-handled) failure this loop's cap is not needed for.
test("verdict() falls through to the could-not-check downgrade within a bound when stdout is a saturated pipe whose reader never drains — #889's retry cap", (t) => {
  if (spawnSync("python3", ["-c", ""]).status !== 0) return t.skip("needs python3");
  const w = repo(t);

  const harness = [
    "import fcntl, os, subprocess, sys, time",
    "r, w = os.pipe()",
    "fcntl.fcntl(w, fcntl.F_SETFL, fcntl.fcntl(w, fcntl.F_GETFL) | os.O_NONBLOCK)",
    "try:",
    "    while True:",
    "        os.write(w, b'x' * 65536)",
    "except BlockingIOError:",
    "    pass",
    "start = time.time()",
    "proc = subprocess.Popen(sys.argv[1:], stdout=w, stderr=subprocess.PIPE)",
    "os.close(w)",
    "try:",
    "    _, err = proc.communicate(timeout=5)",
    "except subprocess.TimeoutExpired:",
    "    proc.kill()",
    "    proc.wait()",
    "    print('TIMEOUT')",
    "    sys.exit(1)",
    "print(f'EXIT={proc.returncode} ELAPSED={time.time() - start:.3f}')",
    "sys.stderr.write(err.decode())",
  ].join("\n");

  const r = spawnSync(
    "python3",
    ["-c", harness, process.execPath, SCRIPT, "--path", "src.mjs", "--gone", "a spelling this file never had"],
    { cwd: w, env: ENV, encoding: "utf8" },
  );
  assert.match(
    r.stdout,
    /^EXIT=2 ELAPSED=\d/m,
    `verdict() must exit 2 within the bound against a permanently saturated stdout pipe; got stdout=${r.stdout} stderr=${r.stderr}`,
  );
  assert.match(
    r.stderr,
    /the verdict could not be written to stdout . could not check/,
    `verdict() must still deliver the could-not-check refusal on stderr once the retry cap is hit; got: ${r.stderr}`,
  );
});

// One pipe buffer, the cliff this test's fixture has to stay above.
// ci-state.test.mjs measured the same number for the same reason and holds
// its own copy; this suite's helpers have no shared home for it, so it is
// named here rather than left a bare literal in an assertion.
const PIPE_BUFFER_BYTES = 65536;

// The other side of this fixture's window, and the one that only bites off
// this machine. The needle reaches the script as a single argv item, and
// Linux caps ONE argv item at MAX_ARG_STRLEN — 32 pages, so 131072 bytes on
// a 4 KiB-page kernel, which is what CI runs on. Past it execve refuses the
// whole spawn with E2BIG. darwin caps only the total (~1 MiB ARG_MAX) and has
// no per-argument cap at all, which is why a needle sized against this
// machine alone passes here and reds on CI. `git log -S` takes the same
// needle as its own argv item, so the cap binds the grandchild too.
//
// Same name and number as ledger.test.mjs's own constant, which carries the
// measurement: that file hit this exact wall and records that the refusal is
// not a truncation — spawnSync comes back with a null status, reading like
// the very defect its tests exist to catch. It stays under the cap by
// splitting its payload across several argv elements; that is not available
// here, because `--gone` takes the needle as one value, so this fixture sizes
// the single element instead.
const ARG_STRLEN_MAX = 131_072;

// The probe that reveals how much fd 1 will take in ONE call, asked large
// enough that the answer is the ceiling rather than the request: past any
// pipe capacity a kernel hands an unprivileged process (Linux's
// fs.pipe-max-size defaults to 1 MiB and caps what F_SETPIPE_SZ grants) and
// an order of magnitude past the largest single transfer this repo has
// measured on a draining reader. A platform that takes even this whole has a
// ceiling far above anything an argv item could reach, which the disposition
// below treats the same as a blocking fd — neither is reachable by resizing.
const CEILING_PROBE_BYTES = 2 * 1024 * 1024;

// ── #1548: verdict()'s writeSync loop delivers the FULL payload, EXECUTED ─
//
// The retry-cap test above only proves the loop gives up in time against a
// pipe that never drains at all; it says nothing about what a loop that DOES
// keep draining actually delivers, and #889's source-shape pin above has the
// same gap arg.mjs's die() pin does: a mutant that collapses the while loop
// to one bare `writeSync(1, buf)` still satisfies a pin anchored on the try
// block's shape, and a short write from that single call would silently
// truncate the verdict with nothing here to catch it.
//
// Unlike die()'s companion test, staleness.mjs never touches
// console.log/process.stdout itself (the comment above the source-shape pin
// says so), so fd 1 stays blocking and this loop is never exercised by
// running the real CLI script as-is — a blocking write to a full pipe just
// blocks until spawnSync's reader drains it, never short-writing. A copy of
// staleness.mjs is run instead through a one-line wrapper that forces the
// same O_NONBLOCK state die()'s test forces on fd 2: `console.log("")`
// lazily initialises Node's stream object for fd 1, and that initialisation
// is what puts a pipe fd into O_NONBLOCK (ci-state.mjs's own vlog relies on
// exactly this for fd 2). Once fd 1 is non-blocking, a payload past one pipe
// buffer (PIPE_BUFFER_BYTES above) SHORT-WRITES rather than blocking — a
// `--gone` needle is echoed verbatim into the JSON payload's own `needle`
// field, so sizing the needle past one buffer forces that payload over the
// cliff without needing a git history fixture to make it that large. The
// needle therefore has to sit in a WINDOW, not merely be big: past
// PIPE_BUFFER_BYTES so the write short-writes, and under
// ARG_STRLEN_MAX so execve accepts it. Both ends are asserted below,
// because overshooting the upper end does not fail as a short-write bug —
// the spawn never happens at all.
//
// Neither the fixture's size nor what fd 1 does with a large write shows up
// in the delivered bytes, so neither is assumed. The size is asserted
// outright. The write behaviour is MEASURED and reported by the wrapper,
// because the premise "a payload past one pipe buffer short-writes" is FALSE
// on Linux and only holds on darwin.
//
// What a single non-blocking write to a pipe transfers is not the pipe's
// capacity. spawnSync's reader drains concurrently, and Linux's pipe_write
// keeps filling slots as the reader frees them, returning only once it finds
// the pipe full — so the ceiling is a RACE against the reader, not a
// constant. Measured on this repo's CI runner: 146176 bytes in one call.
// board-cli.test.mjs's own 100-run ubuntu measurement independently reports
// the same 146176 for one console.error write, and a RANGE of 146239-182783
// for the looped build — the spread is the race. darwin instead returns at
// one buffer and short-writes reliably, which is why this reads as portable
// from here and is not.
//
// That ceiling being variable is survivable. That it exceeds ARG_STRLEN_MAX
// is not: the payload is grown through the needle, the needle is ONE argv
// item, and an item past that cap cannot be spawned at all. So on that
// runner NO needle size both outgrows a single write and survives execve —
// the two constraints have no overlap, and picking a bigger number cannot
// fix it. The disposition at the end of the test therefore turns on whether
// a usable size EXISTS rather than on which mechanism is in play:
//
//   - first write SHORT            -> the loop resumed for real; the delivery
//                                     assertions are the kill for a
//                                     collapsed loop
//   - ceiling below ARG_STRLEN_MAX -> a larger needle WOULD short-write and
//                                     this fixture is simply too small: RED,
//                                     naming the size that would work
//   - ceiling at or above it       -> no admissible needle can reach the
//                                     loop here, so this is recorded as the
//                                     coverage hole it is rather than
//                                     asserted (#1578)
//
// The middle case is the one worth keeping hard: it is the only one a fixture
// edit can fix, so it is the only one where a red tells anyone to do
// something. Asserting the last case is what reddened CI three times against
// a correct build. A silent version of it is how #1548 came to exist, so it
// is reported, not dropped.
//
// The needle is real to git, not just a value verdict()'s own writeSync
// sees: an unmatched pathspec-scale string is still walked by `git log -S`,
// so this exercises the "gone" not-found path, not a stub — and THAT is
// asserted rather than merely documented, because the walk-found-nothing
// branch and the `git log -S`-failed branch both answer `unknown` at this
// exit code with the needle echoed back. Only the walk-found-nothing answer
// carries `found` and `bytes`; staleness.mjs's failed-walk downgrade passes
// no extra fields at all. `bytes` is the size of the blob origin/main holds
// at the asked-for path, derived from the fixture's own origin below rather
// than written as a literal, so changing what repo() commits cannot leave
// the number behind.
//
// The verdict's own prose (`why`) is not pinned here — this file's header
// already says why not — so the delivery assertion is round-trip fidelity
// instead: a truncated write lands mid `needle`, which is not valid JSON at
// all (measured: reverting the loop makes `JSON.parse` throw on the payload
// this test's fixture produces).
test("verdict() resumes from a genuine short write and delivers the full payload, not just the first pipe buffer", (t) => {
  const w = repo(t);
  const scriptDir = mkdtempSync(join(tmpdir(), "staleness-short-"));
  // repo(t) reaps its own tree; this dir holds the script copies and the
  // wrapper, and had nothing reaping it.
  t.after(() => rmSync(scriptDir, { recursive: true, force: true }));
  writeFileSync(join(scriptDir, "arg.mjs"), readFileSync(fileURLToPath(new URL("./arg.mjs", import.meta.url))));
  writeFileSync(join(scriptDir, "git-env.mjs"), readFileSync(fileURLToPath(new URL("./git-env.mjs", import.meta.url))));
  writeFileSync(join(scriptDir, "staleness.mjs"), readFileSync(SCRIPT));
  const needle = "y".repeat(120_000);
  const firstWrite = join(scriptDir, "first-write.json");
  writeFileSync(join(scriptDir, "run.mjs"), [
    'import { writeFileSync, writeSync } from "node:fs";',
    '// Lazily touching fd 1 through console.log builds the stream object, and',
    '// on darwin that is what puts the pipe fd in O_NONBLOCK. Measured on this',
    "// repo's Linux CI across two runs, it does NOT do so for fd 1 there,",
    '// while the same move on fd 2 in die() companion fixture does. So the',
    '// flag is FORCED here rather than inferred from the side effect: libuv',
    '// exposes it on the stream handle, and a Node that stops exposing it',
    '// leaves the probes below to report the truth instead of guessing.',
    'console.log("");',
    "let forcedNonBlocking = null;",
    "try {",
    "  process.stdout._handle.setBlocking(false);",
    "  forcedNonBlocking = true;",
    "} catch {",
    "  forcedNonBlocking = false;",
    "}",
    '// Measure the resulting state before staleness.mjs runs instead of',
    '// trusting it: with fd 1 non-blocking this comes back SHORT, and with fd',
    '// 1 blocking it takes every byte in this one call. EAGAIN is recorded as',
    '// 0 — a blocking fd never raises it. The unwritten remainder is',
    '// deliberately never retried, so stdout is the newline console.log',
    "// printed, exactly the recorded counts below, then verdict()'s payload.",
    `const filler = Buffer.alloc(${needle.length}, 0x70);`,
    "let firstWriteBytes;",
    "try {",
    "  firstWriteBytes = writeSync(1, filler);",
    "} catch (e) {",
    '  firstWriteBytes = e.code === "EAGAIN" ? 0 : -1;',
    "}",
    "// One call taking the whole payload has two very different causes, and",
    "// the payload alone cannot tell them apart: a BLOCKING fd, or a pipe",
    "// roomier than the payload. One more write, past any capacity a kernel",
    "// grants unprivileged, separates them — a non-blocking pipe cannot",
    "// swallow it, a blocking fd takes it all. Left unrun when the first",
    "// write already short-wrote, so a platform that behaves pays nothing.",
    "let ceilingProbeBytes = null;",
    "if (firstWriteBytes >= filler.length) {",
    `  const wide = Buffer.alloc(${CEILING_PROBE_BYTES}, 0x71);`,
    "  try {",
    "    ceilingProbeBytes = writeSync(1, wide);",
    "  } catch (e) {",
    '    ceilingProbeBytes = e.code === "EAGAIN" ? 0 : -1;',
    "  }",
    "}",
    `writeFileSync(${JSON.stringify(firstWrite)}, JSON.stringify({ payloadBytes: filler.length, firstWriteBytes, ceilingProbeBytes, forcedNonBlocking }));`,
    'await import("./staleness.mjs");',
    "",
  ].join("\n"));

  const r = spawnSync(process.execPath, [join(scriptDir, "run.mjs"), "--path", "src.mjs", "--gone", needle], {
    cwd: w,
    env: ENV,
    encoding: null,
    maxBuffer: 8 * 1024 * 1024,
  });
  // Before anything reads the captured streams: a spawn execve refused
  // returns no `output` at all, so `r.stdout`/`r.stderr` are undefined and a
  // diagnostic that formats them throws a TypeError over the top of the real
  // cause. Measured — an over-long argv gives `error.code` E2BIG with
  // `status` null, and `r.stderr.toString()` on that result throws
  // "Cannot read properties of undefined".
  assert.equal(
    r.error,
    undefined,
    `the fixture never ran — spawnSync refused it (${r.error?.code}); an argv item past ARG_STRLEN_MAX is the way this test earns that`,
  );
  assert.equal(r.status, 2, `expected the unknown verdict's exit code: stderr=${r.stderr.toString()}`);
  // Both ends of the needle's window, guarded on the needle the fixture sends
  // rather than on the bytes that arrived: a truncated payload is itself about
  // one buffer long, so a guard over the captured stdout would fire on a real
  // defect and blame the fixture for it.
  assert.ok(
    needle.length > PIPE_BUFFER_BYTES,
    `fixture no longer outgrows the pipe buffer (${needle.length}-byte needle), so this test would pass without proving anything`,
  );
  assert.ok(
    needle.length < ARG_STRLEN_MAX,
    `a ${needle.length}-byte needle is too long to survive execve as one argv item on a 4 KiB-page Linux kernel, so this fixture would refuse to spawn on CI while passing here`,
  );
  const { payloadBytes, firstWriteBytes, ceilingProbeBytes, forcedNonBlocking } = JSON.parse(
    readFileSync(firstWrite, "utf8"),
  );
  assert.ok(
    firstWriteBytes >= 0,
    `the fixture's own probe write to fd 1 failed before verdict() ever ran (it returned ${firstWriteBytes})`,
  );
  // Everything the probes put on the pipe precedes the payload, and every
  // count is reported by the fixture rather than assumed here.
  const beforePayload = 1 + firstWriteBytes + (ceilingProbeBytes > 0 ? ceilingProbeBytes : 0);
  // console.log("") contributed the leading byte, then whatever probe bytes
  // landed; the JSON payload follows all of it.
  assert.equal(r.stdout[0], 10, "console.log(\"\")'s own newline is missing from the front of stdout");
  let payload;
  assert.doesNotThrow(
    () => (payload = JSON.parse(r.stdout.subarray(beforePayload).toString("utf8"))),
    `verdict()'s payload is not valid JSON — a short write landed mid-needle: ${r.stdout.length} bytes captured`,
  );
  assert.equal(payload.verdict, "unknown");
  assert.equal(
    payload.needle.length,
    needle.length,
    `needle arrived truncated: got ${payload.needle.length} bytes, sent ${needle.length}`,
  );
  assert.equal(payload.needle, needle);
  // The walk ran and came back empty, rather than the `git log -S` call
  // failing into the same verdict: only the empty-walk answer carries these.
  assert.equal(
    payload.found,
    false,
    "the --gone needle must be absent from the current file for this to be the not-found path",
  );
  assert.equal(
    payload.bytes,
    Number(git(w, "cat-file", "-s", "origin/main:src.mjs")),
    "`bytes` must be the size of the blob origin/main holds at the asked-for path — the failed-walk downgrade carries no `bytes` at all",
  );
  // Last, because it decides how much the assertions above actually proved.
  // A short first write means the retry loop really resumed, so they are a
  // kill for the collapsed-loop mutant. One call taking the whole payload
  // means they are not, and the only question that then matters is whether
  // any ADMISSIBLE needle would have done better — a red nobody can act on
  // is worse than a recorded measurement.
  if (firstWriteBytes < payloadBytes) return;
  // The largest single transfer this platform was seen to make. The probe is
  // what reveals it once the payload-sized write failed to.
  const writeCeiling = Math.max(firstWriteBytes, ceilingProbeBytes > 0 ? ceilingProbeBytes : 0);
  // A needle has to outgrow that ceiling to short-write AND stay under
  // ARG_STRLEN_MAX to be spawnable at all. Where the ceiling leaves room, a
  // bigger needle is a real fix and this fixture is genuinely too small, so
  // this stays hard and names the size that would work.
  assert.ok(
    writeCeiling >= ARG_STRLEN_MAX,
    `fd 1 took all ${payloadBytes} bytes at once but stops at ${writeCeiling} for a ${CEILING_PROBE_BYTES}-byte ask, so a needle over ${writeCeiling} would short-write and still spawn (the cap is ${ARG_STRLEN_MAX}) — this fixture is too small, raise the needle`,
  );
  // The remaining case, and the one no fixture edit reaches: the ceiling is
  // at or above the largest needle execve will accept, so the two constraints
  // have no overlap here. Recorded with the numbers rather than asserted,
  // because this is a real coverage hole and a silent one is how #1548 came
  // to exist. #1578 tracks closing it, and this message is the evidence that
  // ticket asks a reader to collect from a CI run.
  t.diagnostic(
    `verdict()'s retry loop was NOT exercised (#1578): fd 1 took all ${payloadBytes} bytes in one call and stops only at ${writeCeiling}, which is at or past the ${ARG_STRLEN_MAX}-byte argv cap, so no needle can both outgrow one write and be spawned here. ${
      ceilingProbeBytes >= CEILING_PROBE_BYTES
        ? "The fd is blocking — it took the whole probe."
        : "The fd is non-blocking; the ceiling is the drain race against spawnSync's reader, not a pipe capacity."
    } Forcing the flag ${forcedNonBlocking ? "was available" : "was not available"}. The delivery assertions above still hold, but on this platform they do not discriminate a collapsed loop. darwin short-writes this same fixture, and die()'s companion fixture short-writes on fd 2 on both.`,
  );
});
