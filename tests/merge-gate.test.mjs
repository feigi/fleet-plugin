// Regression gate for merge-gate.mjs (#1800), the merge bot's pre-merge
// conjunction — spec docs/specs/2026-09-24-slot-based-fleet-loop-design.md
// § 5, whose exit-vocabulary table every row below is named after.
//
// Zero deps: `node --test tests/merge-gate.test.mjs`.
//
// `gh` is stubbed on PATH. ci-state.mjs, instruments.sh and main-gain.mjs are
// resolved beside merge-gate.mjs itself (its SCRIPT_DIR), so each fixture runs
// a COPY of the gate out of a stub scripts directory holding stub siblings —
// the pattern fleet-tick.test.mjs uses for candidates.mjs — with every module
// the gate imports copied alongside. All four stubs append to one call log,
// which is how the "ci-state runs on every call, with --declare-no-ci" and
// "read-only" assertions are made. The cwd is a real `git init`-ed repository,
// because the gate derives instruments.sh's `--repo` from `git rev-parse
// --git-common-dir`.
//
// Each row gets a case that proves it blocks ON ITS OWN, the discipline
// drop-merged-label.test.mjs states: every input except the one under test is
// held at the mergeable baseline, so deleting a check fails the case named
// after it, not merely some case somewhere.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, chmodSync, symlinkSync, unlinkSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../plugin/scripts/merge-gate.mjs", import.meta.url));
// Every non-builtin module the copied gate imports. An unlisted one is a
// module-not-found at startup — Node's exit 1, which is this gate's
// "blocked". Add a row whenever merge-gate.mjs gains an import.
const SIBLING_MODULES = ["arg.mjs", "git-env.mjs"].map((m) => [m, fileURLToPath(new URL(`../plugin/scripts/${m}`, import.meta.url))]);

const PRE = "a".repeat(40);
const POST = "b".repeat(40);
const THIRD = "c".repeat(40);
const DIGEST = "d".repeat(64);

const PR_VIEW = { labels: [{ name: "patch" }, { name: "ready-to-merge" }], reviewDecision: "APPROVED", headRefOid: PRE, body: "" };

// Shaped like ci-state.mjs's own payload (its `payload` literal, plus
// `jobs`/`missing` outside --quiet), green at exit 0.
const CI_GREEN = {
  pr: 42,
  branch: "fix/42",
  prHead: PRE,
  runId: 7,
  attempt: 1,
  runHeadSha: PRE,
  status: "completed",
  conclusion: "success",
  behind: 0,
  verdict: "green",
  reasons: [],
  jobs: [{ name: "check", status: "completed", conclusion: "success" }],
  missing: [],
};
const ci = (patch) => JSON.stringify({ ...CI_GREEN, ...patch });

const CI_STATE_STUB = `import { appendFileSync, readFileSync } from "node:fs";
appendFileSync(process.env.CALL_LOG, "ci-state.mjs " + process.argv.slice(2).join(" ") + "\\n");
process.stderr.write(process.env.CI_STDERR ?? "");
process.stdout.write(readFileSync(process.env.CI_STDOUT_FILE));
process.exitCode = Number(process.env.CI_EXIT);
`;

const INSTRUMENTS_STUB = `printf 'instruments.sh %s\\n' "$*" >> "$CALL_LOG"
[ -z "$INSTR_STDOUT" ] || printf '%s\\n' "$INSTR_STDOUT"
exit "$INSTR_EXIT"
`;

// main-gain.mjs, resolved beside the gate like the other two. It logs its
// argv and cwd, keeps the stdin it was handed, and answers MG_STDOUT at
// MG_EXIT — by default a clean payload about the head it was asked for.
// MG_PAD leading spaces, which a JSON parse ignores, stand in for a payload
// too large for spawnSync's default buffer without passing it through the env.
const MAIN_GAIN_STUB = `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
appendFileSync(process.env.CALL_LOG, "main-gain.mjs " + argv.join(" ") + " (cwd " + process.cwd() + ")\\n");
writeFileSync(process.env.MG_STDIN_FILE, readFileSync(0));
const head = argv[argv.indexOf("--head") + 1];
process.stdout.write(" ".repeat(Number(process.env.MG_PAD ?? 0)) + (process.env.MG_STDOUT ?? JSON.stringify({ head, base: "origin/main", since: null, hits: [], acknowledged: [], unchecked: [], reason: null })) + "\\n");
process.exitCode = Number(process.env.MG_EXIT);
`;

const GH_STUB = `#!/bin/sh
printf 'gh %s\\n' "$*" >> "$CALL_LOG"
case "$1 $2" in
  "pr view") cat "$PR_VIEW_FILE"; exit "$PR_VIEW_EXIT" ;;
  *) echo "gh: unstubbed call: $*" >&2; exit 1 ;;
esac
`;

function mktemp(t, prefix) {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

// One `gh` stub for the whole file, on every fixture's PATH. macOS scans a
// newly created executable inode on its first direct exec (~1-2s, measured in
// #2249), so a fresh stub per gate() call cost the file one scan per case. The
// stub is stateless — CALL_LOG, PR_VIEW_FILE and PR_VIEW_EXIT come from each
// call's env — so sharing it changes nothing a case asserts; everything else
// stays per call.
const BIN = realpathSync(mkdtempSync(join(tmpdir(), "merge-gate-bin-")));
after(() => rmSync(BIN, { recursive: true, force: true }));
writeFileSync(join(BIN, "gh"), GH_STUB, { mode: 0o755 });

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: cleanEnv() });
  assert.equal(r.status, 0, `fixture: git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

// The runner's own ambient GIT_DIR/GIT_WORK_TREE must not reach a fixture;
// the one case that wants one sets it explicitly.
function cleanEnv() {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  return env;
}

/**
 * Runs a copy of the gate against stubbed readings. Every option defaults to
 * the mergeable baseline, so a case names only the one reading it changes.
 */
function gate(
  t,
  {
    argv = ["--pr", "42", "--pre", PRE],
    prView = JSON.stringify(PR_VIEW),
    prViewExit = 0,
    ciOut = JSON.stringify(CI_GREEN),
    ciExit = 0,
    ciStderr = "",
    mgOut = null,
    mgExit = 0,
    instrOut = DIGEST,
    instrExit = 0,
    cwd = null,
    env = {},
    realInstruments = false,
    instrPre = null,
  } = {},
) {
  const root = mktemp(t, "merge-gate-");
  const scripts = join(root, "scripts");
  mkdirSync(scripts);
  const script = join(scripts, "merge-gate.mjs");
  writeFileSync(script, readFileSync(SCRIPT));
  for (const [name, path] of SIBLING_MODULES) writeFileSync(join(scripts, name), readFileSync(path));
  writeFileSync(join(scripts, "ci-state.mjs"), CI_STATE_STUB);
  writeFileSync(join(scripts, "main-gain.mjs"), MAIN_GAIN_STUB);
  // The cross-workspace cases run the REAL instruments.sh beside the copied
  // gate — the two-tree contract lives in that script, and a stub can only
  // echo a verdict, never produce one. The stub stays the default: every
  // other case here holds the instruments leg at mergeable and varies one
  // input.
  writeFileSync(
    join(scripts, "instruments.sh"),
    realInstruments
      ? readFileSync(fileURLToPath(new URL("../plugin/scripts/instruments.sh", import.meta.url)))
      : INSTRUMENTS_STUB,
  );
  const log = join(root, "calls.log");
  writeFileSync(log, "");
  writeFileSync(join(root, "pr-view.json"), prView);
  writeFileSync(join(root, "ci.out"), ciOut);
  writeFileSync(join(root, "mg.stdin"), "");

  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q");
  // A hook for the real-instruments cases: run before the gate, with the
  // fixture's workspace repo and scripts dir in hand — this is where a
  // baseline gets pinned over a tree the workspace does not carry.
  if (instrPre) instrPre({ repo, scripts, root });

  const res = spawnSync(process.execPath, [script, ...argv], {
    cwd: cwd ?? repo,
    encoding: "utf8",
    env: {
      ...cleanEnv(),
      PATH: `${BIN}:${process.env.PATH}`,
      CALL_LOG: log,
      PR_VIEW_FILE: join(root, "pr-view.json"),
      PR_VIEW_EXIT: String(prViewExit),
      CI_STDOUT_FILE: join(root, "ci.out"),
      CI_EXIT: String(ciExit),
      CI_STDERR: ciStderr,
      INSTR_STDOUT: instrOut,
      INSTR_EXIT: String(instrExit),
      MG_STDIN_FILE: join(root, "mg.stdin"),
      MG_EXIT: String(mgExit),
      ...(mgOut === null ? {} : { MG_STDOUT: mgOut }),
      ...env,
    },
  });
  return {
    code: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
    json: res.stdout.trim() ? JSON.parse(res.stdout) : null,
    calls: readFileSync(log, "utf8").split("\n").filter(Boolean),
    mgStdin: readFileSync(join(root, "mg.stdin"), "utf8"),
    root,
    repo,
  };
}

const CI_CALL = "ci-state.mjs --pr 42 --declare-no-ci";

// Exit code, verdict, reason — and ci-state called exactly once, with
// --declare-no-ci, which the AC requires on every call whatever the verdict.
function assertRow(r, code, verdict, reason) {
  assert.equal(r.code, code, `exit ${r.code}, expected ${code}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.equal(r.json.verdict, verdict);
  assert.equal(r.json.reason, reason);
  assert.deepEqual(r.calls.filter((c) => c.startsWith("ci-state.mjs")), [CI_CALL], "ci-state must run once per call, with --declare-no-ci");
}

// --- exit 0 ----------------------------------------------------------------

const MG_CLEAN = { head: PRE, base: "origin/main", since: null, hits: [], acknowledged: [], unchecked: [], reason: null };

test("every check holds → 0 mergeable, one JSON line with every field, four read-only calls in spec order", (t) => {
  const r = gate(t);
  assertRow(r, 0, "mergeable", null);
  assert.equal(r.stdout.split("\n").length, 2, "stdout must be exactly one line");
  assert.deepEqual(r.json, {
    pr: 42,
    verdict: "mergeable",
    reason: null,
    head: PRE,
    pre: PRE,
    post: null,
    rebaseCarry: null,
    behind: 0,
    instruments: DIGEST,
    mainGain: MG_CLEAN,
    ci: CI_GREEN,
  });
  // The whole call log: nothing merges, labels or rebases, and the four
  // reads run in the order the spec names — main-gain against the head gh
  // read, in the main checkout.
  assert.deepEqual(r.calls, [
    `instruments.sh --repo ${r.repo}`,
    "gh pr view 42 --json labels,reviewDecision,headRefOid,body",
    `main-gain.mjs --head ${PRE} --body-file - (cwd ${r.repo})`,
    CI_CALL,
  ]);
});

test("the rebased path: head and ci-state both on --post → 0", (t) => {
  const r = gate(t, {
    argv: ["--pr", "42", "--pre", PRE, "--post", POST],
    prView: JSON.stringify({ ...PR_VIEW, headRefOid: POST }),
    ciOut: ci({ prHead: POST, runHeadSha: POST }),
  });
  assertRow(r, 0, "mergeable", null);
  assert.equal(r.json.post, POST);
  assert.equal(r.json.head, POST);
});

test("the no-rebase path: --post equal to --pre → 0", (t) => {
  const r = gate(t, { argv: ["--pr", "42", "--pre", PRE, "--post", PRE] });
  assertRow(r, 0, "mergeable", null);
});

test("no-ci verdict with the label present → 0, the arm that cleared visible in ci.verdict", (t) => {
  const r = gate(t, {
    ciOut: JSON.stringify({
      pr: 42,
      branch: "fix/42",
      prHead: PRE,
      runId: null,
      attempt: null,
      runHeadSha: null,
      status: null,
      conclusion: null,
      behind: 0,
      verdict: "no-ci",
      reasons: ["no workflows configured under .github/workflows/ — --declare-no-ci passed, gating on the caller's verified suite run instead"],
    }),
  });
  assertRow(r, 0, "mergeable", null);
  assert.equal(r.json.ci.verdict, "no-ci");
});

test("ci-state's stderr noise never reaches the parse, and is passed through", (t) => {
  const noise = '$ gh run view 7\n{"verdict":"not-green"}\nci-state: verdict=green\n';
  const r = gate(t, { ciStderr: noise });
  assertRow(r, 0, "mergeable", null);
  assert.ok(r.stderr.includes(noise), "the child's diagnostics must reach the gate's stderr");
});

// --- exit 1: blocked ---------------------------------------------------------

test("ready-to-merge absent → 1 label-pulled", (t) => {
  const r = gate(t, { prView: JSON.stringify({ ...PR_VIEW, labels: [{ name: "patch" }] }) });
  assertRow(r, 1, "blocked", "label-pulled");
});

test("reviewDecision CHANGES_REQUESTED → 1 changes-requested", (t) => {
  const r = gate(t, { prView: JSON.stringify({ ...PR_VIEW, reviewDecision: "CHANGES_REQUESTED" }) });
  assertRow(r, 1, "blocked", "changes-requested");
});

// The two gh-read cases hold ci-state's own head read on --pre, so the gh
// read's check is the only one that can block them; the ci-state read's check
// has its own case below.
test("headRefOid outside {pre, post} → 1 head-moved-after-label", (t) => {
  const r = gate(t, {
    argv: ["--pr", "42", "--pre", PRE, "--post", POST],
    prView: JSON.stringify({ ...PR_VIEW, headRefOid: THIRD }),
  });
  assertRow(r, 1, "blocked", "head-moved-after-label");
  assert.equal(r.json.head, THIRD);
});

test("--post omitted: a head that moved off --pre is not excused by any other SHA → 1 head-moved-after-label", (t) => {
  const r = gate(t, { prView: JSON.stringify({ ...PR_VIEW, headRefOid: POST }) });
  assertRow(r, 1, "blocked", "head-moved-after-label");
});

test("ci-state's own head read outside {pre, post} → 1 head-moved-after-label, even with gh's read on --pre", (t) => {
  // A push between the gate's gh pr view and ci-state's own head read: its
  // CI would be judged while the label's audit belongs to the tree before it.
  const r = gate(t, { ciOut: ci({ prHead: THIRD, runHeadSha: THIRD }) });
  assertRow(r, 1, "blocked", "head-moved-after-label");
});

// --- rebase-carry: real git fixtures -------------------------------------------
// A head outside {pre, post} passes the head row only when its net change
// against its own merge base with origin/main is the labelled head's. Each
// fixture is a real repository the gate runs IN — the proof reads the main
// checkout, which the gate derives from the cwd — with origin/main a plain
// ref. `main` starts at M0; the labelled head PRE_HEAD forks there and edits
// `line10` of f.txt and the bytes of bin.dat; M1 inserts a line at the top of
// the same file (outside the hunk's context window, so every hunk header's
// line numbers move) and adds main.txt. A clean carry is PRE_HEAD's edit
// replayed onto M1, and every refused class below is that carry with one
// thing changed.
const LINES = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
const BIN_X = Buffer.from([0, 1, 2, 0x58, 0x58, 0x58, 0x58]);
const BIN_Y = Buffer.from([0, 1, 2, 0x59, 0x59, 0x59, 0x59]);

// The line of f.txt reading `from` becomes `to`; null deletes it.
function swapLine(repo, from, to) {
  const lines = readFileSync(join(repo, "f.txt"), "utf8").split("\n");
  const i = lines.indexOf(from);
  assert.notEqual(i, -1, `fixture: no line ${from} in f.txt`);
  if (to === null) lines.splice(i, 1);
  else lines[i] = to;
  writeFileSync(join(repo, "f.txt"), lines.join("\n"));
}

const prEdit = (repo) => {
  swapLine(repo, "line10", "line10 changed");
  writeFileSync(join(repo, "bin.dat"), BIN_X);
};

// An empty repository and `at(base, edit)`: a commit on `base` (detached)
// after `edit`; null commits onto the empty main.
function fixtureRepo(t, prefix) {
  const repo = mktemp(t, prefix);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "fixture");
  git(repo, "config", "user.email", "fixture@example.invalid");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "config", "core.fileMode", "true");
  const at = (base, edit) => {
    if (base !== null) git(repo, "checkout", "-q", "--detach", base);
    edit(repo);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "fixture");
    return git(repo, "rev-parse", "HEAD").trim();
  };
  const main = (sha) => git(repo, "update-ref", "refs/remotes/origin/main", sha);
  return { repo, at, main };
}

function carryRepo(t) {
  const { repo, at, main } = fixtureRepo(t, "merge-gate-carry-");
  const m0 = at(null, (r) => {
    writeFileSync(join(r, "f.txt"), `${LINES.join("\n")}\n`);
    writeFileSync(join(r, "bin.dat"), Buffer.from([0, 1, 2, 0x41, 0x41, 0x41, 0x41]));
    writeFileSync(join(r, "run.sh"), "#!/bin/sh\n");
    symlinkSync("f.txt", join(r, "link"));
  });
  const preHead = at(m0, prEdit);
  const m1 = at(m0, (r) => {
    swapLine(r, "line1", "line0 main\nline1");
    writeFileSync(join(r, "main.txt"), "main\n");
  });
  main(m1);
  // PRE_HEAD's edit replayed onto `base`, then `extra` on top of it.
  const carry = (extra = () => {}, base = m1) =>
    at(base, (r) => {
      prEdit(r);
      extra(r);
    });
  return { repo, at, main, m1, preHead, carry };
}

// The gate run in the fixture repository, with gh and ci-state both on `head`
// unless a case says otherwise.
function carryGate(t, fx, head, opts = {}) {
  return gate(t, {
    cwd: fx.repo,
    argv: ["--pr", "42", "--pre", fx.preHead],
    prView: JSON.stringify({ ...PR_VIEW, headRefOid: head }),
    ciOut: ci({ prHead: head, runHeadSha: head }),
    ...opts,
  });
}

test("a conflict-free rebase onto a newer main → 0 mergeable, the carry named with both heads", (t) => {
  const fx = carryRepo(t);
  const carried = fx.carry();
  const refs = git(fx.repo, "for-each-ref");
  const status = git(fx.repo, "status", "--porcelain");
  const r = carryGate(t, fx, carried);
  assertRow(r, 0, "mergeable", null);
  assert.deepEqual(r.json.rebaseCarry, { labelled: fx.preHead, accepted: carried });
  assert.equal(r.json.head, carried);
  assert.equal(r.json.pre, fx.preHead);
  // Read-only: no ref and no index or worktree entry moved.
  assert.equal(git(fx.repo, "for-each-ref"), refs);
  assert.equal(git(fx.repo, "status", "--porcelain"), status);
});

test("a head equal to pre runs no proof and records no carry", (t) => {
  const fx = carryRepo(t);
  const r = carryGate(t, fx, fx.preHead);
  assertRow(r, 0, "mergeable", null);
  assert.equal(r.json.rebaseCarry, null);
});

test("every head whose net change differs from the labelled head's stays 1 head-moved-after-label", (t) => {
  const fx = carryRepo(t);
  const cases = [
    ["one changed line", () => fx.carry((r) => swapLine(r, "line10 changed", "line10 changed!"))],
    ["one added line", () => fx.carry((r) => swapLine(r, "line15", "line15\nadded"))],
    ["one removed line", () => fx.carry((r) => swapLine(r, "line15", null))],
    // `git patch-id` drops whitespace; this proof must not.
    ["a whitespace-only difference", () => fx.carry((r) => swapLine(r, "line10 changed", "  line10 changed"))],
    ["a binary file's content", () => fx.carry((r) => writeFileSync(join(r, "bin.dat"), BIN_Y))],
    ["a file-mode-only change", () => fx.carry((r) => chmodSync(join(r, "run.sh"), 0o755))],
    ["a mode change on the file the PR already edits", () => fx.carry((r) => chmodSync(join(r, "f.txt"), 0o755))],
    ["a new file", () => fx.carry((r) => writeFileSync(join(r, "new.txt"), "new\n"))],
    [
      "a retargeted symlink",
      () =>
        fx.carry((r) => {
          unlinkSync(join(r, "link"));
          symlinkSync("main.txt", join(r, "link"));
        }),
    ],
    ["an extra content-changing commit on the carry", () => fx.at(fx.carry(), (r) => writeFileSync(join(r, "main.txt"), "main\nmore\n"))],
    ["a descendant of pre with an unrelated commit", () => fx.at(fx.preHead, (r) => writeFileSync(join(r, "unrelated.txt"), "x\n"))],
  ];
  for (const [name, make] of cases) {
    const r = carryGate(t, fx, make());
    assert.equal(r.code, 1, `${name}: ${r.stdout}${r.stderr}`);
    assert.equal(r.json.reason, "head-moved-after-label", name);
    assert.equal(r.json.rebaseCarry, null, name);
  }
});

test("a rebase over a main edit inside the hunk's context, or a conflict resolved, stays 1 head-moved-after-label", (t) => {
  // The conservative false negative: a changed context line is a changed
  // net change, even where the rebase applied cleanly.
  const nearby = carryRepo(t);
  const m2 = nearby.at(nearby.m1, (r) => swapLine(r, "line8", "line8 main"));
  nearby.main(m2);
  const drift = carryGate(t, nearby, nearby.carry(undefined, m2));
  assertRow(drift, 1, "blocked", "head-moved-after-label");

  // main rewrote the very line the PR edits; the resolution keeps the PR's
  // text, so the removed line is main's and no longer the original.
  const conflict = carryRepo(t);
  const m2c = conflict.at(conflict.m1, (r) => swapLine(r, "line10", "line10 main"));
  conflict.main(m2c);
  const resolution = conflict.at(m2c, (r) => {
    swapLine(r, "line10 main", "line10 changed");
    writeFileSync(join(r, "bin.dat"), BIN_X);
  });
  const resolved = carryGate(t, conflict, resolution);
  assertRow(resolved, 1, "blocked", "head-moved-after-label");

  // The binary analogue, and the one the patch text alone cannot see: main
  // rewrote the head of a binary file whose tail the PR replaced. `--binary`
  // encodes a large file as a delta against the other side, and both deltas
  // — forward and reverse — read "copy the first 4097 bytes, insert the
  // tail", identical for both heads although no blob on either side is. The
  // blob ids in the block's `index` line are what tell them apart.
  const bytes = (seed, n) => {
    let x = seed;
    return Buffer.from(Array.from({ length: n }, () => ((x = (x * 1103515245 + 12345) >>> 0) >>> 16) & 0xff));
  };
  const [p, p2, q, s] = [bytes(1, 4096), bytes(2, 4096), bytes(3, 64), bytes(4, 64)];
  const binary = carryRepo(t);
  const big = (head, tail) => (r) => writeFileSync(join(r, "big.bin"), Buffer.concat([Buffer.from([0]), head, tail]));
  const mb = binary.at(binary.m1, big(p, q));
  const labelled = binary.at(mb, big(p, s));
  const mb2 = binary.at(mb, big(p2, q));
  binary.main(mb2);
  const kept = carryGate(t, binary, binary.at(mb2, big(p2, s)), { argv: ["--pr", "42", "--pre", labelled] });
  assertRow(kept, 1, "blocked", "head-moved-after-label");
});

// An edit made somewhere else in the file is not the labelled head's change,
// though every added, removed and context line reads the same once the hunk
// headers' line numbers and function context are dropped. Two functions have
// identical bodies, and the labelled head edits one; the moved head edits the
// other. `top` is what main prepends to the file meanwhile — empty leaves the
// file's blob untouched on main, so a real rebase would keep the hunk's place.
function relocationRepo(t, top) {
  const { repo, at, main } = fixtureRepo(t, "merge-gate-reloc-");
  const body = (name, ret) => `int ${name}(void) {\n  int a = 1;\n  int b = 2;\n  int c = 3;\n  ${ret}\n  int d = 4;\n  int e = 5;\n  int f = 6;\n}\n`;
  const file = (head, admin, guest) => (r) => writeFileSync(join(r, "auth.c"), `${head}${body("allow_admin", admin)}\n${body("allow_guest", guest)}`);
  const CHECK = "return CHECK;";
  const m0 = at(null, file("", CHECK, CHECK));
  const preHead = at(m0, file("", "return 0;", CHECK));
  const m1 = at(m0, (r) => {
    file(top, CHECK, CHECK)(r);
    writeFileSync(join(r, "main.txt"), "main\n");
  });
  main(m1);
  return {
    repo,
    preHead,
    carried: at(m1, file(top, "return 0;", CHECK)),
    relocated: at(m1, file(top, CHECK, "return 0;")),
  };
}

test("the labelled edit made at a different place in the file is no carry → 1 head-moved-after-label", (t) => {
  for (const [name, top] of [
    ["main left the file alone", ""],
    ["main prepended a line to the file", "/* main */\n"],
  ]) {
    const fx = relocationRepo(t, top);
    // Control: the same edit where it was made is a carry.
    const control = carryGate(t, fx, fx.carried);
    assertRow(control, 0, "mergeable", null);
    assert.deepEqual(control.json.rebaseCarry, { labelled: fx.preHead, accepted: fx.carried }, name);
    const r = carryGate(t, fx, fx.relocated);
    assertRow(r, 1, "blocked", "head-moved-after-label");
    assert.equal(r.json.rebaseCarry, null, name);
  }
});

test("a rename is compared as the deletion and addition it is → 1 head-moved-after-label", (t) => {
  // The labelled head renames r.txt; main appends to it, and the moved head
  // renames the result. Both are a 100% rename of the same two paths, so with
  // rename detection on the patch text is the same, and only the lines each
  // deletion removes tell them apart. The merge reproduces the moved tree
  // either way, so this refusal is the text proof's alone.
  const rename = (mainEdit) => {
    const { repo, at, main } = fixtureRepo(t, "merge-gate-rename-");
    const m0 = at(null, (r) => writeFileSync(join(r, "r.txt"), "alpha\nbeta\n"));
    const preHead = at(m0, (r) => git(r, "mv", "r.txt", "s.txt"));
    const m1 = at(m0, mainEdit);
    main(m1);
    return { repo, preHead, moved: at(m1, (r) => git(r, "mv", "r.txt", "s.txt")) };
  };
  // Control: main left r.txt alone, so the same rename is a carry.
  const control = rename((r) => writeFileSync(join(r, "main.txt"), "main\n"));
  assertRow(carryGate(t, control, control.moved), 0, "mergeable", null);
  const edited = rename((r) => writeFileSync(join(r, "r.txt"), "alpha\nbeta\ngamma\n"));
  const r = carryGate(t, edited, edited.moved);
  assertRow(r, 1, "blocked", "head-moved-after-label");
  assert.equal(r.json.rebaseCarry, null);
});

test("a head with no net change is no carry, even of another head with none → 1 head-moved-after-label", (t) => {
  const fx = carryRepo(t);
  const empty = (msg) => {
    git(fx.repo, "checkout", "-q", "--detach", fx.m1);
    git(fx.repo, "commit", "-q", "--allow-empty", "-m", msg);
    return git(fx.repo, "rev-parse", "HEAD").trim();
  };
  const preHead = empty("labelled");
  const moved = empty("moved");
  const r = carryGate(t, { ...fx, preHead }, moved);
  assertRow(r, 1, "blocked", "head-moved-after-label");
  assert.equal(r.json.rebaseCarry, null);
});

test("a head with more than one merge base with origin/main is no carry → 1 head-moved-after-label", (t) => {
  // Two branches merged into each other leave their descendants two merge
  // bases with a main that holds one of the merges. The head is the labelled
  // head and one empty commit, so every other part of the proof holds.
  const { repo, at, main } = fixtureRepo(t, "merge-gate-criss-");
  const root = at(null, (r) => writeFileSync(join(r, "f.txt"), `${LINES.join("\n")}\n`));
  const b1 = at(root, (r) => writeFileSync(join(r, "b1.txt"), "b1\n"));
  const b2 = at(root, (r) => writeFileSync(join(r, "b2.txt"), "b2\n"));
  const cross = (into, from) => {
    git(repo, "checkout", "-q", "--detach", into);
    git(repo, "merge", "-q", "--no-ff", "-m", "cross", from);
    return git(repo, "rev-parse", "HEAD").trim();
  };
  const c1 = cross(b1, b2);
  const c2 = cross(b2, b1);
  main(c1);
  assert.equal(git(repo, "merge-base", "--all", c1, c2).trim().split("\n").length, 2, "fixture: two merge bases");
  const preHead = at(c2, (r) => swapLine(r, "line10", "line10 changed"));
  git(repo, "commit", "-q", "--allow-empty", "-m", "moved");
  const moved = git(repo, "rev-parse", "HEAD").trim();
  const r = carryGate(t, { repo, preHead }, moved);
  assertRow(r, 1, "blocked", "head-moved-after-label");
  assert.equal(r.json.rebaseCarry, null);
});

test("a context line differing from the labelled head's only in its bytes is no carry → 1 head-moved-after-label", (t) => {
  // Main rewrites the last line of g.txt, which the PR's hunk carries as a
  // context line, separated from the edit itself by unchanged lines, so the merge is clean and
  // the moved head's tree is exactly the labelled change on main's base — only
  // the context line differs. Each case is a difference one decoding or one
  // filtered line class would erase.
  const context = (last, mainLast) => {
    const { repo, at, main } = fixtureRepo(t, "merge-gate-ctx-");
    const g = (line17, end) => (r) =>
      writeFileSync(
        join(r, "g.txt"),
        Buffer.concat([Buffer.from([...LINES.slice(0, 16).map((l) => `g${l}`), line17, "g18", "g19", ""].join("\n")), end]),
      );
    const m0 = at(null, g("g17", last));
    const preHead = at(m0, g("g17 changed", last));
    const m1 = at(m0, (r) => {
      g("g17", mainLast)(r);
      writeFileSync(join(r, "main.txt"), "main\n");
    });
    main(m1);
    return { repo, preHead, moved: at(m1, g("g17 changed", mainLast)) };
  };
  const cases = [
    ["a missing newline at the end of the file", Buffer.from("z"), Buffer.from("z\n")],
    // Two different invalid UTF-8 bytes both decode to U+FFFD under utf8.
    ["two different invalid UTF-8 bytes", Buffer.from([0x80, 0x0a]), Buffer.from([0x81, 0x0a])],
  ];
  for (const [name, last, mainLast] of cases) {
    // Control: main's change leaves line 20 as it was, so the head is a carry.
    const control = context(last, last);
    assertRow(carryGate(t, control, control.moved), 0, "mergeable", null);
    const fx = context(last, mainLast);
    const r = carryGate(t, fx, fx.moved);
    assertRow(r, 1, "blocked", "head-moved-after-label");
    assert.equal(r.json.rebaseCarry, null, name);
  }
});

test("a proof that cannot complete is no carry → 1 head-moved-after-label, never mergeable", (t) => {
  const fx = carryRepo(t);
  const carried = fx.carry();
  // The labelled head's object is not in the main checkout.
  const missingPre = carryGate(t, fx, carried, { argv: ["--pr", "42", "--pre", "e".repeat(40)] });
  assertRow(missingPre, 1, "blocked", "head-moved-after-label");
  assert.equal(missingPre.json.rebaseCarry, null);
  // origin/main does not resolve, so neither head has a merge base.
  git(fx.repo, "update-ref", "-d", "refs/remotes/origin/main");
  const noMain = carryGate(t, fx, carried);
  assertRow(noMain, 1, "blocked", "head-moved-after-label");
  assert.equal(noMain.json.rebaseCarry, null);
});

test("a carried head is still decided by every other row, in the same order", (t) => {
  const fx = carryRepo(t);
  const carried = fx.carry();
  const onCarried = { prHead: carried, runHeadSha: carried };
  const prView = (patch) => JSON.stringify({ ...PR_VIEW, headRefOid: carried, ...patch });
  const rows = [
    ["label-pulled", { prView: prView({ labels: [{ name: "patch" }] }) }],
    ["changes-requested", { prView: prView({ reviewDecision: "CHANGES_REQUESTED" }) }],
    ["main-gain-removed:tests/gate.test.mjs", { mgOut: mg({ head: carried, hits: [HIT] }), mgExit: 1 }],
    ["ci:job check failed", { ciOut: ci({ ...onCarried, verdict: "not-green", reasons: ["job check failed"] }), ciExit: 1 }],
    ["ci:no CI run", { ciOut: ci({ ...onCarried, runId: null, runHeadSha: null, verdict: "not-green", reasons: ["no CI run"] }), ciExit: 1 }],
    ["behind:3", { ciOut: ci({ ...onCarried, behind: 3 }) }],
  ];
  for (const [reason, opts] of rows) {
    const r = carryGate(t, fx, carried, opts);
    assertRow(r, 1, "blocked", reason);
  }
  // Row order: main-gain-removed still wins over ci: and behind:.
  const both = carryGate(t, fx, carried, {
    mgOut: mg({ head: carried, hits: [HIT] }),
    mgExit: 1,
    ciOut: ci({ ...onCarried, verdict: "not-green", reasons: ["job check failed"], behind: 3 }),
    ciExit: 1,
  });
  assertRow(both, 1, "blocked", "main-gain-removed:tests/gate.test.mjs");
});

// The carry proof's own git calls go through gitEnv(): an ambient GIT_DIR
// naming a repository where the carry WOULD prove must not answer for the
// main checkout, where it does not (origin/main is gone there).
test("an ambient GIT_DIR cannot answer the carry proof for another repository", (t) => {
  const fx = carryRepo(t);
  const carried = fx.carry();
  const other = mktemp(t, "merge-gate-carry-other-");
  cpSync(join(fx.repo, ".git"), join(other, ".git"), { recursive: true });
  git(fx.repo, "update-ref", "-d", "refs/remotes/origin/main");
  // Control: asked directly, the other repository proves the carry.
  const control = carryGate(t, { ...fx, repo: other }, carried);
  assertRow(control, 0, "mergeable", null);
  const r = carryGate(t, fx, carried, { env: { GIT_DIR: join(other, ".git") } });
  assertRow(r, 1, "blocked", "head-moved-after-label");
  assert.equal(r.json.rebaseCarry, null);
});

test("a third head at ci-state's read stays 1 head-moved-after-label, even when gh's head was a proven carry", (t) => {
  const fx = carryRepo(t);
  const carried = fx.carry();
  const third = fx.carry((r) => writeFileSync(join(r, "new.txt"), "new\n"));
  const r = carryGate(t, fx, carried, { ciOut: ci({ prHead: third, runHeadSha: third }) });
  assertRow(r, 1, "blocked", "head-moved-after-label");
  assert.deepEqual(r.json.rebaseCarry, { labelled: fx.preHead, accepted: carried });
});

test("ci-state exit 1 (in progress, no conclusion) → 1 ci:<first reason>, runId and status carried for the wait", (t) => {
  const reasons = ["run status is in_progress, not completed", "job check is in_progress, not success"];
  const r = gate(t, {
    ciOut: ci({ status: "in_progress", conclusion: null, verdict: "not-green", reasons }),
    ciExit: 1,
  });
  assertRow(r, 1, "blocked", `ci:${reasons[0]}`);
  assert.equal(r.json.ci.status, "in_progress");
  assert.equal(r.json.ci.runId, 7);
});

test("green with behind 3 → 1 behind:3", (t) => {
  const r = gate(t, { ciOut: ci({ behind: 3 }) });
  assertRow(r, 1, "blocked", "behind:3");
  assert.equal(r.json.behind, 3);
});

// --- exit 2: could not evaluate -----------------------------------------------

test("ci-state rate-limited payload → 2 rate-limited", (t) => {
  const r = gate(t, {
    ciOut: JSON.stringify({ pr: 42, verdict: "rate-limited", reasons: ["gh run list was refused by the GitHub API rate limit — no CI state was read."] }),
    ciExit: 2,
  });
  assertRow(r, 2, "unknown", "rate-limited");
  assert.equal(r.json.ci.verdict, "rate-limited");
  assert.equal(r.json.behind, null);
});

test("ci-state {} payload → 2 ci-unreadable", (t) => {
  const r = gate(t, { ciOut: "{}\n", ciExit: 2 });
  assertRow(r, 2, "unknown", "ci-unreadable");
});

test("ci-state zero-byte payload → 2 ci-unreadable", (t) => {
  const r = gate(t, { ciOut: "", ciExit: 2 });
  assertRow(r, 2, "unknown", "ci-unreadable");
  assert.equal(r.json.ci, null);
});

test("ci-state unparseable payload → 2 ci-unreadable", (t) => {
  const r = gate(t, { ciOut: '{"pr":42,"verdict":"gre', ciExit: 2 });
  assertRow(r, 2, "unknown", "ci-unreadable");
  assert.equal(r.json.ci, null);
});

test("an exit code its payload does not back → 2 ci-unreadable, never a verdict", (t) => {
  // Exit 0 with nothing to gate on is the vacuous pass; exit 1 with no
  // payload is Node's own crash code, not ci-state's not-green; and a code
  // contradicting the verdict it printed has answered nothing.
  const shapes = [
    ["exit 0, {}", "{}\n", 0],
    ["exit 0, zero bytes", "", 0],
    ["exit 1, zero bytes (a crashed ci-state)", "", 1],
    ["exit 0, not-green verdict", ci({ verdict: "not-green", reasons: ["run status is queued, not completed"] }), 0],
    ["exit 1, green verdict", ci({}), 1],
    ["exit 0, green verdict with no behind field", JSON.stringify({ ...CI_GREEN, behind: undefined }), 0],
    ["exit 0, green verdict with no prHead", JSON.stringify({ ...CI_GREEN, prHead: undefined }), 0],
  ];
  for (const [what, ciOut, ciExit] of shapes) {
    const r = gate(t, { ciOut, ciExit });
    assert.equal(r.code, 2, `${what}: exit ${r.code}\n${r.stdout}`);
    assert.equal(r.json.reason, "ci-unreadable", what);
  }
});

test("green with behind null → 2 behind-unknown", (t) => {
  const r = gate(t, { ciOut: ci({ behind: null }) });
  assertRow(r, 2, "unknown", "behind-unknown");
});

// An unusable payload that ALSO happens to carry a `behind: null` field must
// still read as ci-unreadable, not behind-unknown: readCi()'s `validated` is
// null whenever `usable` is false, so decide() cannot fall through to a
// `behind` read on an unvalidated shape no matter which check runs first.
test("an unusable payload that also carries behind:null → 2 ci-unreadable, never behind-unknown", (t) => {
  const r = gate(t, { ciOut: ci({ verdict: "not-green", reasons: ["queued"], behind: null }), ciExit: 0 });
  assertRow(r, 2, "unknown", "ci-unreadable");
});

test("instruments.sh exit 1 → 2 instrument-set-changed, the digest it printed carried", (t) => {
  const changed = "e".repeat(64);
  const r = gate(t, { instrOut: changed, instrExit: 1 });
  assertRow(r, 2, "unknown", "instrument-set-changed");
  assert.equal(r.json.instruments, changed);
});

test("instruments.sh exit 2 → 2 instruments-unanswerable", (t) => {
  const r = gate(t, { instrOut: "", instrExit: 2 });
  assertRow(r, 2, "unknown", "instruments-unanswerable");
  assert.equal(r.json.instruments, null);
});

test("instruments.sh exit 0 that printed no digest → 2 instruments-unanswerable", (t) => {
  const r = gate(t, { instrOut: "", instrExit: 0 });
  assertRow(r, 2, "unknown", "instruments-unanswerable");
});

test("no git checkout to name the instrument set from → 2 instruments-unanswerable, instruments.sh never run", (t) => {
  const outside = mktemp(t, "merge-gate-nogit-");
  const r = gate(t, { cwd: outside, env: { GIT_CEILING_DIRECTORIES: outside } });
  assertRow(r, 2, "unknown", "instruments-unanswerable");
  assert.equal(r.calls.filter((c) => c.startsWith("instruments.sh")).length, 0);
});

test("gh pr view exits non-zero → 2 pr-unreadable", (t) => {
  const r = gate(t, { prView: "", prViewExit: 1 });
  assertRow(r, 2, "unknown", "pr-unreadable");
  assert.equal(r.json.head, null);
});

test("gh pr view misparses → 2 pr-unreadable", (t) => {
  const shapes = [
    ["non-JSON body at exit 0", "<html>502 Bad Gateway</html>"],
    ["labels missing", JSON.stringify({ reviewDecision: "APPROVED", headRefOid: PRE })],
    ["headRefOid empty", JSON.stringify({ ...PR_VIEW, headRefOid: "" })],
    ["reviewDecision missing", JSON.stringify({ labels: PR_VIEW.labels, headRefOid: PRE, body: "" })],
    ["body missing", JSON.stringify({ labels: PR_VIEW.labels, reviewDecision: "APPROVED", headRefOid: PRE })],
    ["body null", JSON.stringify({ ...PR_VIEW, body: null })],
  ];
  for (const [what, prView] of shapes) {
    const r = gate(t, { prView });
    assert.equal(r.code, 2, `${what}: exit ${r.code}\n${r.stdout}`);
    assert.equal(r.json.reason, "pr-unreadable", what);
  }
});

test("only CHANGES_REQUESTED blocks: reviewDecision \"\" (no review required), null and REVIEW_REQUIRED → 0", (t) => {
  for (const reviewDecision of ["", null, "REVIEW_REQUIRED"]) {
    const r = gate(t, { prView: JSON.stringify({ ...PR_VIEW, reviewDecision }) });
    assert.equal(r.code, 0, `${JSON.stringify(reviewDecision)}: ${r.stdout}`);
  }
});

// --- main-gain -------------------------------------------------------------------

const HIT = {
  path: "tests/gate.test.mjs",
  key: "#7",
  landed: "f".repeat(40),
  lines: [{ line: 12, text: "test('kept', () => {});" }],
  ack: "main-gain-removal: tests/gate.test.mjs #7 - <why>",
};
const mg = (patch) => JSON.stringify({ ...MG_CLEAN, ...patch });

test("main-gain exit 1 → 1 main-gain-removed:<first path>, the hit list echoed in mainGain", (t) => {
  const payload = mg({ hits: [HIT, { ...HIT, path: "second.txt" }], reason: "main-gain-removed:tests/gate.test.mjs" });
  const r = gate(t, { mgOut: payload, mgExit: 1 });
  assertRow(r, 1, "blocked", "main-gain-removed:tests/gate.test.mjs");
  assert.deepEqual(r.json.mainGain, JSON.parse(payload));
});

test("main-gain-removed wins over ci: and behind:, and loses to head-moved-after-label", (t) => {
  const hit = { mgOut: mg({ hits: [HIT] }), mgExit: 1 };
  const notGreen = gate(t, { ...hit, ciOut: ci({ verdict: "not-green", reasons: ["job check failed"], behind: 3 }), ciExit: 1 });
  assertRow(notGreen, 1, "blocked", "main-gain-removed:tests/gate.test.mjs");
  const behind = gate(t, { ...hit, ciOut: ci({ behind: 3 }) });
  assertRow(behind, 1, "blocked", "main-gain-removed:tests/gate.test.mjs");
  const moved = gate(t, { mgOut: mg({ head: THIRD, hits: [HIT] }), mgExit: 1, prView: JSON.stringify({ ...PR_VIEW, headRefOid: THIRD }) });
  assertRow(moved, 1, "blocked", "head-moved-after-label");
  const ciMoved = gate(t, { ...hit, ciOut: ci({ prHead: THIRD, runHeadSha: THIRD }) });
  assertRow(ciMoved, 1, "blocked", "head-moved-after-label");
});

test("main-gain exit 0 with acknowledged removals → 0 mergeable, the acknowledgements echoed in mainGain", (t) => {
  const payload = mg({ acknowledged: [{ ...HIT, reason: "superseded by the new suite" }], unchecked: ["logo.png"] });
  const r = gate(t, { mgOut: payload });
  assertRow(r, 0, "mergeable", null);
  assert.deepEqual(r.json.mainGain, JSON.parse(payload));
});

test("the PR body gh read reaches main-gain on stdin", (t) => {
  const body = "Drops the block.\r\n\r\nmain-gain-removal: tests/gate.test.mjs #7 - superseded\r\n";
  const r = gate(t, { prView: JSON.stringify({ ...PR_VIEW, body }) });
  assertRow(r, 0, "mergeable", null);
  assert.equal(r.mgStdin, body);
});

test("main-gain exit 2 → 2 main-gain-unanswerable, its own reason echoed", (t) => {
  const payload = mg({ reason: "head-unreadable" });
  const r = gate(t, { mgOut: payload, mgExit: 2 });
  assertRow(r, 2, "unknown", "main-gain-unanswerable");
  assert.deepEqual(r.json.mainGain, JSON.parse(payload));
});

test("a main-gain payload past spawnSync's 1 MiB default still decides → 1 main-gain-removed, never main-gain-unanswerable", (t) => {
  const r = gate(t, { mgOut: mg({ hits: [HIT], reason: "main-gain-removed:tests/gate.test.mjs" }), mgExit: 1, env: { MG_PAD: String(2 << 20) } });
  assertRow(r, 1, "blocked", "main-gain-removed:tests/gate.test.mjs");
  assert.deepEqual(r.json.mainGain.hits, [HIT]);
});

test("a main-gain payload its exit code does not back → 2 main-gain-unanswerable, never a verdict", (t) => {
  const shapes = [
    ["exit 0, zero bytes", "", 0],
    ["exit 0, not JSON", "{\"head\":", 0],
    ["exit 0 with a hit", mg({ hits: [HIT] }), 0],
    ["exit 1 with no hit", mg({}), 1],
    ["exit 1, a hit with no path", mg({ hits: [{ ...HIT, path: "" }] }), 1],
    ["exit 0, about another head", mg({ head: POST }), 0],
    ["exit 0, hits missing", JSON.stringify({ ...MG_CLEAN, hits: undefined }), 0],
    ["exit 0, unchecked missing", JSON.stringify({ ...MG_CLEAN, unchecked: undefined }), 0],
  ];
  for (const [what, mgOut, mgExit] of shapes) {
    const r = gate(t, { mgOut, mgExit });
    assert.equal(r.code, 2, `${what}: exit ${r.code}\n${r.stdout}`);
    assert.equal(r.json.reason, "main-gain-unanswerable", what);
  }
});

test("main-gain-unanswerable sits with the unknown rows: a blocked row still wins over it", (t) => {
  const r = gate(t, { mgOut: "", mgExit: 2, ciOut: ci({ behind: 2 }) });
  assertRow(r, 1, "blocked", "behind:2");
});

test("a gh read with no head or body never runs main-gain → 2 pr-unreadable", (t) => {
  const r = gate(t, { prView: JSON.stringify({ labels: PR_VIEW.labels, reviewDecision: "APPROVED", headRefOid: PRE }) });
  assertRow(r, 2, "unknown", "pr-unreadable");
  assert.deepEqual(r.calls.filter((c) => c.startsWith("main-gain.mjs")), []);
  assert.equal(r.json.mainGain, null);
});

// --- precedence ----------------------------------------------------------------

test("the first failing row is the reason, and the JSON still carries every reading", (t) => {
  const notGreen = ci({ status: "in_progress", verdict: "not-green", reasons: ["run status is in_progress, not completed"] });
  const r = gate(t, {
    prView: JSON.stringify({ ...PR_VIEW, labels: [] }),
    ciOut: notGreen,
    ciExit: 1,
    instrOut: "e".repeat(64),
    instrExit: 1,
  });
  assertRow(r, 1, "blocked", "label-pulled");
  assert.equal(r.json.instruments, "e".repeat(64));
  assert.deepEqual(r.json.ci, JSON.parse(notGreen));
  assert.equal(r.json.head, PRE);
});

// --- --repo: the main checkout, whatever the cwd or the environment says ------

test("from a linked worktree, instruments.sh audits the main checkout (--git-common-dir), not the worktree", (t) => {
  // The run's baseline lives in the main checkout's .fleet/, which a
  // worktree does not carry: --show-toplevel there would exit 2 forever.
  const probe = gate(t);
  const main = probe.repo;
  git(main, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  const wt = join(probe.root, "wt");
  git(main, "worktree", "add", "-q", wt);
  const r = gate(t, { cwd: wt });
  assertRow(r, 0, "mergeable", null);
  assert.deepEqual(r.calls.filter((c) => c.startsWith("instruments.sh")), [`instruments.sh --repo ${main}`]);
  assert.deepEqual(r.calls.filter((c) => c.startsWith("main-gain.mjs")), [`main-gain.mjs --head ${PRE} --body-file - (cwd ${main})`]);
});

test("an ambient GIT_DIR cannot move the audited instrument set into another repository", (t) => {
  const other = mktemp(t, "merge-gate-other-");
  git(other, "init", "-q");
  const r = gate(t, { env: { GIT_DIR: join(other, ".git") } });
  assertRow(r, 0, "mergeable", null);
  assert.deepEqual(r.calls.filter((c) => c.startsWith("instruments.sh")), [`instruments.sh --repo ${r.repo}`]);
});

// --- interface ------------------------------------------------------------------

test("--declare-no-ci is not on the gate's surface: refused by name, nothing run", (t) => {
  const r = gate(t, { argv: ["--pr", "42", "--pre", PRE, "--declare-no-ci"] });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown flag --declare-no-ci/);
  assert.equal(r.stdout, "");
  assert.deepEqual(r.calls, []);
});

test("usage: --pr and --pre are both required, refused before any read", (t) => {
  for (const argv of [["--pre", PRE], ["--pr", "42"], []]) {
    const r = gate(t, { argv });
    assert.equal(r.code, 2, argv.join(" "));
    assert.match(r.stderr, /usage: merge-gate\.mjs --pr <n> --pre <sha>/);
    assert.deepEqual(r.calls, []);
  }
});

test("usage: an abbreviated SHA is refused, a full uppercase one is accepted", (t) => {
  // Abbreviated can never equal gh's full headRefOid, so accepting it would
  // skip every PR as head-moved-after-label.
  for (const argv of [["--pr", "42", "--pre", PRE.slice(0, 7)], ["--pr", "42", "--pre", PRE, "--post", "HEAD"]]) {
    const r = gate(t, { argv });
    assert.equal(r.code, 2, argv.join(" "));
    assert.match(r.stderr, /needs a full 40-character commit SHA/);
    assert.deepEqual(r.calls, []);
  }
  const upper = gate(t, { argv: ["--pr", "42", "--pre", PRE.toUpperCase()] });
  assertRow(upper, 0, "mergeable", null);
  assert.equal(upper.json.pre, PRE);
});

test("--out writes the same line, creating missing directories, whatever the verdict", (t) => {
  for (const [label, code] of [["ready-to-merge", 0], ["patch", 1]]) {
    const dir = mktemp(t, "merge-gate-out-");
    const out = join(dir, "pr42", "merge-bot-3", "ci.json");
    const r = gate(t, {
      argv: ["--pr", "42", "--pre", PRE, "--out", out],
      prView: JSON.stringify({ ...PR_VIEW, labels: [{ name: label }] }),
    });
    assert.equal(r.code, code, r.stderr);
    assert.equal(readFileSync(out, "utf8"), r.stdout);
  }
});

test("--out that cannot be written → 2, and no verdict on stdout the file does not carry", (t) => {
  const dir = mktemp(t, "merge-gate-out-");
  writeFileSync(join(dir, "file"), "");
  const r = gate(t, { argv: ["--pr", "42", "--pre", PRE, "--out", join(dir, "file", "ci.json")] });
  assert.equal(r.code, 2);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /cannot write --out/);
});

// --- #2284: the instruments root and the gh root are different checkouts ----
//
// The live incident: a fleet running in a consumer repo that does not track
// `plugin/…`. Every leg but instruments was green; instruments.sh hashed the
// workspace tree, found no tracked instrument, refused on the empty set, and
// the gate exited 2 `instruments-unanswerable` forever — labelled PRs that
// could never merge. The fix records the audited root inside the baseline at
// pin time, so the SAME `--repo <workspace>` call the gate already makes
// reads one tree's home and another tree's bytes. These cases run the REAL
// instruments.sh beside the copied gate: the contract being proven is the two
// scripts' handoff across that seam, and a stubbed child proves only the row
// table — it can echo an exit code, never derive one from two trees.

// A checkout that carries the instrument set — the plugin's own repo, or an
// install's cache — separate from every gate fixture's workspace repo.
function pluginTree(t) {
  const dir = mktemp(t, "merge-gate-plugin-");
  git(dir, "init", "-q", "-b", "main");
  mkdirSync(join(dir, "plugin", "scripts"), { recursive: true });
  writeFileSync(join(dir, "plugin", "scripts", "probe.sh"), "echo probe\n");
  git(dir, "-c", "user.email=t@example.com", "-c", "user.name=t", "add", "-A");
  git(dir, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "fixture");
  return dir;
}

// The phase-0 pin a controller runs from the plugin-less workspace: the
// baseline lands in the WORKSPACE's .fleet/, the digest covers the PLUGIN's
// tree, and the second line records which tree that was.
function pinAcrossSeam({ repo, scripts }, plugin) {
  const r = spawnSync("sh", [join(scripts, "instruments.sh"), "--pin", "--audit", plugin], {
    cwd: repo,
    encoding: "utf8",
    env: cleanEnv(),
  });
  assert.equal(r.status, 0, `fixture pin failed: ${r.stderr}`);
  return r.stdout.trim();
}

test("a plugin-less workspace reaches a verdict: the gate audits the root the baseline records, gh legs on the workspace", (t) => {
  const plugin = pluginTree(t);
  let digest = null;
  const r = gate(t, {
    realInstruments: true,
    instrPre: (ws) => {
      digest = pinAcrossSeam(ws, plugin);
    },
  });
  assertRow(r, 0, "mergeable", null);
  assert.equal(
    r.json.instruments,
    digest,
    "the JSON carries the digest of the plugin tree — the workspace has no instruments to digest",
  );
});

test("tampering the recorded plugin tree still closes the gate across the seam: 2 instrument-set-changed", (t) => {
  const plugin = pluginTree(t);
  const r = gate(t, {
    realInstruments: true,
    instrPre: (ws) => {
      pinAcrossSeam(ws, plugin);
      writeFileSync(join(plugin, "plugin", "scripts", "probe.sh"), "echo TAMPERED\n");
    },
  });
  assertRow(r, 2, "unknown", "instrument-set-changed");
});

test("a plugin-less workspace with NO pin of any kind keeps its exit 2 — the refusal that says WHICH flag to pass", (t) => {
  // The incident shape stays a refusal, never a silent pass: with no
  // baseline there is no recorded root, the instruments leg answers nothing,
  // and the gate lands on instruments-unanswerable. What changed is WHERE a
  // run discovers this: the SKILL's phase-0 pin refuses once and names the
  // empty tree, instead of dispatching finishers and merge bots into this
  // leg forever.
  const r = gate(t, { realInstruments: true });
  assertRow(r, 2, "unknown", "instruments-unanswerable");
  assert.equal(r.json.instruments, null);
});
