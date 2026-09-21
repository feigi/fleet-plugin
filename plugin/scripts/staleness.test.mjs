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

// ── #889/#1549: verdict() routes its write through arg.mjs's writeAll() ──
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
// source-shape pin instead.
//
// #1549: the LOOP is no longer here to pin. It was one of three hand-mirrored
// copies and now lives once in arg.mjs's writeAll(), whose shape and
// behaviour are pinned and EXECUTED in arg.test.mjs. This file used to carry
// a near-copy of that same regex, differing from the other two only in head
// line and fd. What is pinned here instead is what stays verdict()'s OWN —
// the three things a caller of writeAll has to get right:
//   - the write goes through writeAll on fd 1, not a re-inlined writeSync;
//   - the payload's CONSTRUCTION sits inside the try, so a circular `extra`
//     or a throwing toJSON downgrades instead of escaping verdict() uncaught;
//   - the false return is actually READ, so a lost verdict becomes
//     could-not-check rather than being reported as a delivered one.
// Measured: a mutant for each of those three reds this pin, and none of them
// reds arg.test.mjs's writeAll pins — the two files pin different halves, and
// neither alone catches both defects.
test("verdict() writes through writeAll() and downgrades on its false return, rather than re-inlining the loop", () => {
  assert.match(
    stripComments(readFileSync(SCRIPT, "utf8")),
    /^\s*let ok = false;\s*^\s*try \{\s*^\s*ok = writeAll\(1, `\$\{JSON\.stringify\(\{[^`]*\)\}\\n`\);\s*^\s*\} catch \{\s*^\s*\}\s*^\s*if \(!ok\) die\("the verdict could not be written/m,
  );
});

// verdict()'s EAGAIN retry had the same #889 gap as die()'s: no cap, so a
// stdout reader that stays open but never drains left writeSync throwing
// EAGAIN forever and the "a failed write is a could-not-check" downgrade this
// function's own comment promises — the whole reason it writeSyncs instead of
// console.log — never ran. The cap lives in writeAll() now (#1549): past
// MAX_EAGAIN_RETRIES it returns false, verdict()'s `if (!ok)` calls die(), and
// the process still exits 2 with the could-not-check refusal on stderr. This
// test is untouched by that move and still measures the whole path end to
// end, which is what makes the extraction safe rather than merely tidy.
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

// The needle reaches the script as a single argv item, and Linux caps ONE
// argv item at MAX_ARG_STRLEN — 32 pages, so 131072 bytes on a 4 KiB-page
// kernel, which is what CI runs on. Past it execve refuses the whole spawn
// with E2BIG. darwin caps only the total (~1 MiB ARG_MAX) and has no
// per-argument cap at all, which is why a needle sized against this machine
// alone passes here and reds on CI. `git log -S` takes the same needle as
// its own argv item, so the cap binds the grandchild too.
//
// Same name and number as ledger.test.mjs's own constant, which carries the
// measurement: that file hit this exact wall and records that the refusal is
// not a truncation — spawnSync comes back with a null status, reading like
// the very defect its tests exist to catch. It stays under the cap by
// splitting its payload across several argv elements; that is not available
// here, because `--gone` takes the needle as one value, so this fixture
// sizes the single element instead.
const ARG_STRLEN_MAX = 131_072;

// How much room the short-write fixture below leaves in the pipe before the
// child's first write. Small and arbitrary on purpose: what makes that write
// come back SHORT is this window, not the payload outgrowing some capacity,
// which is the whole of why the fixture no longer has to be sized against a
// ceiling it cannot reach (#1578).
const WRITE_WINDOW_BYTES = 4096;

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
// #1578: this ran under a plain spawnSync for three CI rounds and never once
// exercised the loop on Linux. Sizing the payload to outgrow one write is
// what failed there, and it failed for a reason no number fixes. What a
// single non-blocking write to a pipe transfers is not the pipe's capacity:
// spawnSync's reader drains CONCURRENTLY, and Linux's pipe_write keeps
// filling slots as the reader frees them, returning only once it finds the
// pipe full. The ceiling is a RACE against the reader, not a constant —
// measured at 146176 bytes in one call on this repo's CI runner, with
// board-cli.test.mjs's independent 100-run ubuntu measurement reporting that
// same 146176 for one console.error write and a RANGE of 146239-182783 for
// the looped build. The spread is the race. And 146176 is past
// ARG_STRLEN_MAX, so on that runner NO needle both outgrows one write and
// survives execve: the two constraints do not overlap, and picking a bigger
// number cannot fix it. Raising the needle was tried twice and reddened CI
// against a correct build both times.
//
// So this stops racing the reader and removes it instead. The pipe is filled
// to capacity up front and exactly WRITE_WINDOW_BYTES freed back, and nothing
// reads it again until that window is gone. A reader that is not draining is
// one the kernel cannot keep handing slots to, so the first write stops at
// the window and returns short BY CONSTRUCTION — on every platform, at a size
// the payload no longer has to beat. That decouples the needle from the write
// ceiling entirely, which is what leaves it free to sit far under
// ARG_STRLEN_MAX instead of straining against it.
//
// Measured both ways through this harness (darwin, pipe capacity 65536,
// window 4096): the shipped build delivers 40278 bytes of valid JSON, and
// writeAll() collapsed to one bare `writeSync(fd, buf)` delivers exactly
// 4096 — the window, and nothing after it — so the payload is truncated
// mid-needle and JSON.parse throws. That is the kill, and it no longer
// depends on which way a race fell.
//
// python3 is what supplies a reader that does not drain and a write end
// already in O_NONBLOCK: the same harness shape, and the same gate, as the
// retry-cap test above. That gate is a runtime-CAPABILITY gate, not the
// platform gate #951 removed — it does not track the platform under test, CI
// provisions python3 (ci.yml says so where it explains what the suite
// spawns), and both legs run it. #951 left a non-zero `skipped` on CI a real
// signal again, and this test keeps it one rather than becoming a new floor.
//
// fd 1 being non-blocking under this harness is NOT re-derived here: the
// retry-cap test above pins it and can only pass because of it — a blocking
// fd 1 against a permanently full pipe would hang that child until its 5s
// timeout instead of exiting 2 on the EAGAIN cap. Should a platform ever
// make fd 1 blocking, that test reds loudly rather than this one passing
// quietly on a write that blocked its way to completion in one call.
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
// all (measured: collapsing the loop makes `JSON.parse` throw on the payload
// this test's fixture produces).
test("verdict() resumes from a genuine short write and delivers the full payload, not just the first pipe buffer", (t) => {
  if (spawnSync("python3", ["-c", ""]).status !== 0) return t.skip("needs python3");
  const w = repo(t);
  const scriptDir = mkdtempSync(join(tmpdir(), "staleness-short-"));
  // repo(t) reaps its own tree; this dir holds the captured stdout, and had
  // nothing reaping it.
  t.after(() => rmSync(scriptDir, { recursive: true, force: true }));
  const captured = join(scriptDir, "stdout.bin");
  const needle = "y".repeat(40_000);

  // Reproduced with a real non-blocking pipe, not a mock: fcntl sets
  // O_NONBLOCK on the write end before the child ever touches it, so the OS —
  // not a stub — is what short-writes. The read end is held open and is NOT
  // read until the window has closed again, which is the whole mechanism:
  // FIONREAD reports the pipe's fill level without consuming a byte, so the
  // fixture can wait for the child's first write to land while still giving
  // it nowhere to put a second one.
  const harness = [
    "import array, fcntl, os, select, subprocess, sys, termios, time",
    "out_path, window = sys.argv[1], int(sys.argv[2])",
    "r, w = os.pipe()",
    "fcntl.fcntl(w, fcntl.F_SETFL, fcntl.fcntl(w, fcntl.F_GETFL) | os.O_NONBLOCK)",
    "# Fill the pipe to capacity, then free exactly `window` bytes back.",
    "pad = 0",
    "try:",
    "    while True:",
    "        pad += os.write(w, b'x' * 4096)",
    "except BlockingIOError:",
    "    pass",
    "if pad <= window:",
    "    print(f'PAD_TOO_SMALL pad={pad} window={window}')",
    "    sys.exit(1)",
    "freed = 0",
    "while freed < window:",
    "    freed += len(os.read(r, window - freed))",
    "proc = subprocess.Popen(sys.argv[3:], stdout=w, stderr=subprocess.PIPE)",
    "os.close(w)",
    "# Wait for the child's first write to close that window again WITHOUT",
    "# reading: a full pipe is that write having returned short.",
    "pending = array.array('i', [0])",
    "consumed = 0",
    "deadline = time.time() + 10",
    "while time.time() < deadline:",
    "    fcntl.ioctl(r, termios.FIONREAD, pending)",
    "    if pending[0] >= pad:",
    "        consumed = 1",
    "        break",
    "    time.sleep(0.001)",
    "# No settle sleep follows: measured, it is not load-bearing for any",
    "# assertion below (`delivered` is the whole payload; `consumed` is a 0/1",
    "# flag, not a byte count). The real bound is writeAll()'s own",
    "# MAX_EAGAIN_RETRIES (arg.mjs) — the harness may hold the pipe undrained",
    "# for at most that many milliseconds, and the FIONREAD poll above is",
    "# what spends it.",
    "chunks, err, fds = [], [], [r, proc.stderr.fileno()]",
    "hard = time.time() + 20",
    "while fds and time.time() < hard:",
    "    for fd in select.select(fds, [], [], 1)[0]:",
    "        data = os.read(fd, 1 << 16)",
    "        if not data:",
    "            fds.remove(fd)",
    "        elif fd == r:",
    "            chunks.append(data)",
    "        else:",
    "            err.append(data)",
    "if fds:",
    "    proc.kill()",
    "    print('DRAIN_TIMEOUT')",
    "    sys.exit(1)",
    "proc.wait()",
    "blob = b''.join(chunks)",
    "carry = pad - window",
    "payload = blob[carry:]",
    "with open(out_path, 'wb') as f:",
    "    f.write(payload)",
    "print(f'EXIT={proc.returncode} PAD={pad} CONSUMED={consumed} PAYLOAD={len(payload)}')",
    "sys.stderr.write(b''.join(err).decode('utf-8', 'replace'))",
  ].join("\n");

  const r = spawnSync(
    "python3",
    [
      "-c",
      harness,
      captured,
      String(WRITE_WINDOW_BYTES),
      process.execPath,
      SCRIPT,
      "--path",
      "src.mjs",
      "--gone",
      needle,
    ],
    { cwd: w, env: ENV, encoding: "utf8" },
  );
  // The harness refuses rather than hanging when its own premises fail — a
  // pipe too small to hold the window, a child that never finishes writing —
  // so its exit code is checked before any number it reported is believed.
  assert.equal(r.status, 0, `the short-write harness did not complete: stdout=${r.stdout} stderr=${r.stderr}`);
  const report = /^EXIT=(\d+) PAD=(\d+) CONSUMED=(\d+) PAYLOAD=(\d+)$/m.exec(r.stdout);
  assert.ok(report, `the harness printed no report line: stdout=${r.stdout} stderr=${r.stderr}`);
  const [, exit, pad, consumed, delivered] = report.map(Number);
  // Both ends of the needle's window. The lower end is the harness's own
  // window now, not a pipe capacity or a racing reader's ceiling — 4 KiB is
  // all the payload has to outgrow, which is what puts the upper end back
  // within comfortable reach instead of a few KiB below it.
  assert.ok(
    needle.length > WRITE_WINDOW_BYTES,
    `a ${needle.length}-byte needle no longer outgrows the ${WRITE_WINDOW_BYTES}-byte window, so the first write would not be short and this test would pass without proving anything`,
  );
  assert.ok(
    needle.length < ARG_STRLEN_MAX,
    `a ${needle.length}-byte needle is too long to survive execve as one argv item on a 4 KiB-page Linux kernel, so this fixture would refuse to spawn on CI while passing here`,
  );
  // The short write itself, measured rather than assumed: the window closed
  // again while nothing was reading, so verdict()'s first write stopped at it.
  assert.equal(
    consumed,
    1,
    `verdict()'s first write never filled the ${WRITE_WINDOW_BYTES}-byte window (pipe capacity ${pad}), so nothing short-wrote and the retry loop was never entered`,
  );
  assert.equal(exit, 2, `expected the unknown verdict's exit code: stderr=${r.stderr}`);
  // The kill. Every byte past that first window arrives only if the loop
  // resumed; a collapsed loop stops at exactly WRITE_WINDOW_BYTES.
  assert.ok(
    delivered > WRITE_WINDOW_BYTES,
    `verdict() delivered ${delivered} bytes — the ${WRITE_WINDOW_BYTES}-byte window and nothing after it — so the retry loop did not resume`,
  );
  let payload;
  assert.doesNotThrow(
    () => (payload = JSON.parse(readFileSync(captured, "utf8"))),
    `verdict()'s payload is not valid JSON — a short write landed mid-needle: ${delivered} bytes captured`,
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
});
