// Regression gate for finisher-label.mjs, the finisher's labelling duty as one
// command. Zero deps: `node --test tests/finisher-label.test.mjs`.
//
// `gh` is stubbed on PATH and every invocation is appended to one call log, so
// "nothing past the failing step ran" is read off the log, not inferred from
// the exit code. The stub answers from files in its own directory, keyed by
// call: `pr-view-N.out` is the Nth `gh pr view`, and `<key>.fail` makes that
// call print its text on stderr and exit 1. A call with no file answers an
// empty success.
//
// Each case holds every input at the baseline except the one under test, so
// removing a check reds the case named after it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitEnv } from "../plugin/scripts/git-env.mjs";
import { writeExecStub } from "./support/exec-stub.mjs";
import { prUrl, ref } from "./support/queue-gh.mjs";
import { tempDir } from "./support/temp-dir.mjs";
import { seedLabelMap } from "./support/label-map-seed.mjs";

const SCRIPT = fileURLToPath(new URL("../plugin/scripts/finisher-label.mjs", import.meta.url));
const PIN = "a".repeat(40);
const OTHER = "b".repeat(40);

// The Ticketless test's read, `gh pr view <n> --json closingIssuesReferences,url`,
// is kept out of calls.log, which holds the calls the labelling steps make, and
// answered from `pr-closing.out`: a PR in the own repository closing issue #5
// unless a case says otherwise, so the baseline is a ticket PR.
const STUB = `#!/bin/sh
d="\${0%/*}"
if [ "$1 $2 $4 $5" = "pr view --json closingIssuesReferences,url" ]; then
  printf '%s\\n' "$*" >> "$d/closing.log"
  pwd >> "$d/closing-cwd.log"
  env | grep -E '^(GIT_DIR|GIT_WORK_TREE)=' >> "$d/env.log"
  if [ -f "$d/pr-closing.fail" ]; then cat "$d/pr-closing.fail" >&2; exit 1; fi
  cat "$d/pr-closing.out"
  exit 0
fi
printf '%s\\n' "$*" >> "$d/calls.log"
pwd >> "$d/cwd.log"
env | grep -E '^(GIT_DIR|GIT_WORK_TREE)=' >> "$d/env.log"
case "$1 $2" in
"pr view") key="pr-view-$(grep -c '^pr view' "$d/calls.log")" ;;
"pr comment") key=pr-comment ;;
"pr edit") if [ "$5" = patch ]; then key=pr-edit-patch; else key=pr-edit; fi ;;
"label list") key=label-list ;;
*) echo "stub gh: unexpected $*" >&2; exit 99 ;;
esac
if [ -f "$d/$key.fail" ]; then cat "$d/$key.fail" >&2; exit 1; fi
if [ -f "$d/$key.out" ]; then cat "$d/$key.out"; fi
exit 0
`;

const names = (...n) => n.map((name) => ({ name }));
const view = (labels, comments = []) => JSON.stringify({ labels: names(...labels), comments });
const record = (sha, createdAt) => ({ body: `ready-to-merge-head: ${sha}`, createdAt });

const ledgerText = (rows) => `# Fleet run ledger\n\n## Rows\n\n${rows.map((r) => `- ${r}`).join("\n")}\n\n## Dispatched\n\n\n\n## Filed\n\n\n\n## Ruled\n\n`;

function git(cwd, ...args) {
  const r = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8", env: gitEnv() });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

// A rig for one case: a fresh stub directory and a repository the script runs
// in (`repo`), holding the run ledger (`rows` are its rows), the Label map
// (`roles` merged over the identity map; null for no map) and an
// `origin/main` to take a pin's merge base against. `outs` and `fails` are
// keyed by the stub's call keys. The baseline is a ticket PR with one release
// label and a read-back that carries the label. `commit(files)` makes a commit
// holding `files` (path → text) on top of origin/main and answers its SHA,
// the pin of a case about the diff.
function rig({ outs = {}, fails = {}, closes = [5], rows = [], roles = {} } = {}) {
  const dir = tempDir("finisher-label-");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeExecStub(join(bin, "gh"), STUB);
  const repo = join(dir, "repo");
  mkdirSync(join(repo, ".fleet"), { recursive: true });
  git(repo, "init", "-q");
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(join(repo, ".fleet", "ledger.md"), ledgerText(rows));
  if (roles !== null) seedLabelMap(repo, { roles });
  const all = {
    "pr-closing": JSON.stringify({ closingIssuesReferences: closes.map((n) => ref(n)), url: prUrl(42) }),
    "pr-view-1": view(["patch", "bug"]),
    "pr-view-2": view(["patch", "bug", "ready-to-merge"]),
    "label-list": JSON.stringify(names("patch", "minor", "major", "bug")),
    ...outs,
  };
  for (const [k, v] of Object.entries(all)) writeFileSync(join(bin, `${k}.out`), v);
  for (const [k, v] of Object.entries(fails)) writeFileSync(join(bin, `${k}.fail`), v);
  const log = (name) => (existsSync(join(bin, name)) ? readFileSync(join(bin, name), "utf8") : "");
  const lines = (name) => log(name).trim().split("\n").filter(Boolean);
  const calls = () => lines("calls.log");
  const closing = () => lines("closing.log");
  const commit = (files) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), text);
      git(repo, "add", path);
    }
    git(repo, "commit", "-q", "-m", "the PR");
    return git(repo, "rev-parse", "HEAD");
  };
  // Without its own `--repo` a run is in the rig's repository, so no case reads a real run's ledger.
  const run = (args = ["--pr", "42", "--pin", PIN], { env = {}, cwd } = {}) => {
    const full = args.includes("--repo") ? args : [...args, "--repo", repo];
    const r = spawnSync(process.execPath, [SCRIPT, ...full], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env },
      ...(cwd === undefined ? {} : { cwd }),
    });
    let out = null;
    try {
      out = JSON.parse(r.stdout);
    } catch {
      // a refusal before any gh call prints no receipt
    }
    return { status: r.status, stderr: r.stderr, out };
  };
  return { dir, repo, calls, closing, commit, log, run };
}

const VIEW = "pr view 42 --json labels,comments";
const BACK = "pr view 42 --json labels";
const COMMENT = `pr comment 42 --body ready-to-merge-head: ${PIN}`;
const EDIT = "pr edit 42 --add-label ready-to-merge";
const LIST = "label list --json name --limit 1000";
const PATCH = "pr edit 42 --add-label patch";
const CLOSING = "pr view 42 --json closingIssuesReferences,url";

test("exit 0: one release label, the head recorded, the label added and read back", () => {
  const t = rig();
  const r = t.run();
  assert.equal(r.status, 0, r.stderr);
  // The order is the contract: record before label, read-back last.
  assert.deepEqual(t.calls(), [VIEW, COMMENT, EDIT, BACK]);
  assert.deepEqual(t.closing(), [CLOSING], "the Ticketless test read comes first, and once");
  assert.deepEqual(r.out, {
    pr: 42,
    pin: PIN,
    ticketless: false,
    releaseLabels: ["patch"],
    patchAdded: false,
    inert: null,
    commented: true,
    added: true,
    readBack: ["patch", "bug", "ready-to-merge"],
    exit: 0,
    firstRead: ["patch", "bug"],
  });
});

// --- the Label map -----------------------------------------------------------
// With the identity map a head record built from the mapped string is the
// same bytes as the fixed prefix, so only a remapped map tells the two apart.

const QUEUE_OK = { "ready-to-merge": "queue-ok" };

test("a remapped ready-to-merge: the label write and the read-back use the mapped string, and the head record keeps its fixed prefix", () => {
  const t = rig({ roles: QUEUE_OK, outs: { "pr-view-2": view(["patch", "bug", "queue-ok"]) } });
  const r = t.run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(t.calls(), [VIEW, `pr comment 42 --body ready-to-merge-head: ${PIN}`, "pr edit 42 --add-label queue-ok", BACK]);
  assert.deepEqual(r.out.readBack, ["patch", "bug", "queue-ok"]);
});

test("a remapped ready-to-merge: a read-back carrying only the role's own name is exit 4", () => {
  const t = rig({ roles: QUEUE_OK, outs: { "pr-view-2": view(["patch", "bug", "ready-to-merge"]) } });
  const r = t.run();
  assert.equal(r.status, 4, r.stderr);
  assert.match(r.stderr, /the read-back does not carry queue-ok/);
});

test("a remapped ready-to-merge: the idempotence check reads the mapped label beside a fixed-prefix record", () => {
  const recorded = [record(PIN, "2026-01-02T00:00:00Z")];
  const done = rig({ roles: QUEUE_OK, outs: { "pr-view-1": view(["patch", "queue-ok"], recorded), "pr-view-2": view(["patch", "queue-ok"]) } });
  const r = done.run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(done.calls(), [VIEW, BACK], "the mapped label and this pin's record are already there: nothing is written");
  // The role's own name is not the mapped label: the label is still written.
  const literal = rig({ roles: QUEUE_OK, outs: { "pr-view-1": view(["patch", "ready-to-merge"], recorded), "pr-view-2": view(["patch", "ready-to-merge", "queue-ok"]) } });
  assert.equal(literal.run().status, 0);
  assert.deepEqual(literal.calls(), [VIEW, "pr edit 42 --add-label queue-ok", BACK]);
});

test("exit 2: no Label map stops the script before any gh call, the receipt naming the step and ensure", () => {
  const t = rig({ roles: null });
  const r = t.run();
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.out.step, "label-map");
  assert.match(r.out.error, /label-map\.mjs ensure/);
  assert.match(r.stderr, /label-map\.mjs ensure/);
  assert.deepEqual(t.calls(), []);
  assert.deepEqual(t.closing(), [], "not even the Ticketless test's read runs");
});

// --- a Ticketless PR ---------------------------------------------------------

const INERT = { "docs/note.md": "a note\n" };
const NOT_INERT = { "plugin/scripts/x.mjs": "export {};\n" };
const ticketless = (over = {}) => rig({ closes: [], ...over });
const headRecord = (pin) => `pr comment 42 --body ready-to-merge-head: ${pin}`;

test("Ticketless PR with no release label in a repo that defines them: patch is added before the count, an inert diff is labelled ready-to-merge, exit 0", () => {
  const t = ticketless({ outs: { "pr-view-1": view(["bug"]), "pr-view-2": view(["bug", "patch", "ready-to-merge"]) } });
  const pin = t.commit(INERT);
  const r = t.run(["--pr", "42", "--pin", pin]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(t.calls(), [VIEW, LIST, PATCH, headRecord(pin), EDIT, BACK]);
  assert.equal(r.out.ticketless, true);
  assert.equal(r.out.patchAdded, true);
  assert.deepEqual(r.out.releaseLabels, ["patch"]);
  assert.equal(r.out.inert.verdict, "inert");
  assert.equal(r.out.added, true);
  assert.equal(r.out.exit, 0);
});

test("Ticketless PR that already carries a release label gets no patch, and its inert diff is labelled", () => {
  const t = ticketless({ outs: { "pr-view-1": view(["minor"]), "pr-view-2": view(["minor", "ready-to-merge"]) } });
  const pin = t.commit(INERT);
  const r = t.run(["--pr", "42", "--pin", pin]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(t.calls(), [VIEW, headRecord(pin), EDIT, BACK]);
  assert.equal(r.out.patchAdded, false);
  assert.deepEqual(r.out.releaseLabels, ["minor"]);
});

test("Ticketless PR in a repo that defines no release label: no patch is added and the count is skipped", () => {
  const t = ticketless({
    outs: { "pr-view-1": view(["bug"]), "pr-view-2": view(["bug", "ready-to-merge"]), "label-list": JSON.stringify(names("bug", "ready-to-merge")) },
  });
  const pin = t.commit(INERT);
  const r = t.run(["--pr", "42", "--pin", pin]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.releaseLabels, "undefined-in-repo");
  assert.equal(r.out.patchAdded, false);
  assert.ok(!t.calls().includes(PATCH));
});

test("exit 5: a Ticketless PR whose diff is not inert gets the head record and no ready-to-merge", () => {
  const t = ticketless({ outs: { "pr-view-1": view(["bug"]) } });
  const pin = t.commit(NOT_INERT);
  const r = t.run(["--pr", "42", "--pin", pin]);
  assert.equal(r.status, 5, r.stderr);
  assert.deepEqual(t.calls(), [VIEW, LIST, PATCH, headRecord(pin)]);
  assert.equal(r.out.exit, 5);
  assert.equal(r.out.inert.verdict, "not-inert");
  assert.equal(r.out.commented, true);
  assert.equal(r.out.added, false);
  assert.equal(r.out.readBack, null);
  assert.match(r.stderr, /Ticketless PR and its diff is not inert/);
});

test("exit 5: a Ticketless PR whose inert verdict could not look is held for the maintainer the same way", () => {
  const t = ticketless();
  // The pin names no commit in the repository: the verdict is `unknown`.
  const r = t.run(["--pr", "42", "--pin", OTHER]);
  assert.equal(r.status, 5, r.stderr);
  assert.equal(r.out.inert.verdict, "unknown");
  assert.equal(r.out.inert.exit, 2);
  assert.equal(r.out.added, false);
  assert.ok(!t.calls().includes(EDIT), t.calls().join("\n"));
  assert.match(r.stderr, /its diff could not be read/);
});

test("exit 5: the head record is posted unless the newest one already names the pin", () => {
  const other = ticketless({ outs: { "pr-view-1": view(["patch"], [record(OTHER, "2026-01-02T00:00:00Z")]) } });
  const a = other.run(["--pr", "42", "--pin", other.commit(NOT_INERT)]);
  assert.equal(a.status, 5, a.stderr);
  assert.equal(a.out.commented, true, "a record for another head is not a record for this one");

  const same = ticketless({ outs: { "pr-view-1": view(["patch"]) } });
  const pin = same.commit(NOT_INERT);
  writeFileSync(join(same.dir, "bin", "pr-view-1.out"), view(["patch"], [record(pin, "2026-01-02T00:00:00Z")]));
  const b = same.run(["--pr", "42", "--pin", pin]);
  assert.equal(b.status, 5, b.stderr);
  assert.equal(b.out.commented, false);
  assert.deepEqual(same.calls(), [VIEW]);
});

test("exit 3: a Ticketless PR with several release labels is refused and nothing is written", () => {
  const t = ticketless({ outs: { "pr-view-1": view(["patch", "major"]) } });
  const r = t.run(["--pr", "42", "--pin", t.commit(INERT)]);
  assert.equal(r.status, 3, r.stderr);
  assert.deepEqual(t.calls(), [VIEW]);
  assert.deepEqual(r.out.releaseLabels, ["patch", "major"]);
  assert.equal(r.out.patchAdded, false);
  assert.equal(r.out.commented, false);
});

test("exit 2: a label list that fills the limit stops a Ticketless PR before any write", () => {
  const t = ticketless({ outs: { "pr-view-1": view(["bug"]), "label-list": JSON.stringify(names(...Array.from({ length: 1000 }, (_, i) => `label-${i}`))) } });
  const r = t.run(["--pr", "42", "--pin", t.commit(INERT)]);
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.out.step, "list-labels");
  assert.deepEqual(t.calls(), [VIEW, LIST]);
});

test("exit 2: a failed patch write is reported at its own step and nothing later runs", () => {
  const t = ticketless({ outs: { "pr-view-1": view(["bug"]) }, fails: { "pr-edit-patch": "no rights\n" } });
  const r = t.run(["--pr", "42", "--pin", t.commit(INERT)]);
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.out.step, "add-patch");
  assert.equal(r.out.error, "no rights");
  assert.deepEqual(t.calls(), [VIEW, LIST, PATCH]);
});

test("exit 2: a Ticketless test that could not look stops the script before any labelling call", () => {
  const t = rig({ fails: { "pr-closing": "gh: HTTP 502\n" } });
  const r = t.run();
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.out.step, "ticketless");
  assert.match(r.out.error, /gh: HTTP 502/);
  assert.equal(r.out.ticketless, null);
  assert.deepEqual(t.calls(), []);

  // A ledger that cannot be read is the same: never "no token". A ledger path
  // that is a directory is one `ledger.mjs read` cannot answer for.
  const noLedger = rig();
  rmSync(join(noLedger.repo, ".fleet", "ledger.md"));
  mkdirSync(join(noLedger.repo, ".fleet", "ledger.md"));
  const b = noLedger.run();
  assert.equal(b.status, 2, b.stderr);
  assert.equal(b.out.step, "ticketless");
  assert.match(b.out.error, /could not read the ledger/);
  assert.deepEqual(noLedger.calls(), []);
});

test("a PR that closes nothing but that a settled impl token names is a ticket PR: zero release labels is still exit 3", () => {
  const t = rig({ closes: [], rows: ["#12 impl-12=PR#42 → PR#42"], outs: { "pr-view-1": view(["bug"]) } });
  const r = t.run(["--pr", "42", "--pin", t.commit(INERT)]);
  assert.equal(r.status, 3, r.stderr);
  assert.equal(r.out.ticketless, false);
  assert.deepEqual(t.calls(), [VIEW, LIST]);
});

test("a ticket PR is never held on its diff: a non-inert diff is labelled as ever, and its verdict never runs", () => {
  const t = rig();
  const r = t.run(["--pr", "42", "--pin", t.commit(NOT_INERT)]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.ticketless, false);
  assert.equal(r.out.inert, null);
  assert.equal(r.out.added, true);
});

test("exit 0: a pin in capitals is recorded in the lowercase the merge bot reads", () => {
  const t = rig();
  const r = t.run(["--pr", "42", "--pin", PIN.toUpperCase()]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(t.calls().includes(COMMENT), t.calls().join("\n"));
  assert.equal(r.out.pin, PIN);
});

test("exit 0: other labels beside the one release label do not trip the count", () => {
  const t = rig({ outs: { "pr-view-1": view(["bug", "minor", "needs-docs", "ready-for-agent"]) } });
  const r = t.run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out.releaseLabels, ["minor"]);
});

test("exit 3: a PR with no release label is refused and nothing is written", () => {
  const t = rig({ outs: { "pr-view-1": view(["bug"]) } });
  const r = t.run();
  assert.equal(r.status, 3, r.stderr);
  assert.deepEqual(t.calls(), [VIEW, LIST]);
  assert.deepEqual(r.out.releaseLabels, []);
  assert.deepEqual(r.out.firstRead, ["bug"]);
  assert.equal(r.out.commented, false);
  assert.equal(r.out.added, false);
  assert.equal(r.out.readBack, null);
  assert.equal(r.out.exit, 3);
});

test("exit 3: a PR with two release labels is refused, names both, and posts no comment", () => {
  const t = rig({ outs: { "pr-view-1": view(["patch", "major", "bug"]) } });
  const r = t.run();
  assert.equal(r.status, 3, r.stderr);
  assert.deepEqual(t.calls(), [VIEW]);
  assert.deepEqual(r.out.releaseLabels, ["patch", "major"]);
  assert.equal(r.out.commented, false);
  assert.equal(r.out.added, false);
});

test("exit 3: a repo that defines only some of the release labels still gates on a PR with none", () => {
  const t = rig({ outs: { "pr-view-1": view(["bug"]), "label-list": JSON.stringify(names("patch", "bug")) } });
  const r = t.run();
  assert.equal(r.status, 3, r.stderr);
  assert.deepEqual(t.calls(), [VIEW, LIST]);
});

test("a repo whose label list defines none of the release labels skips the count", () => {
  const t = rig({
    outs: {
      "pr-view-1": view(["bug"]),
      "pr-view-2": view(["bug", "ready-to-merge"]),
      "label-list": JSON.stringify(names("bug", "ready-to-merge")),
    },
  });
  const r = t.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.releaseLabels, "undefined-in-repo");
  assert.deepEqual(t.calls(), [VIEW, LIST, COMMENT, EDIT, BACK]);
});

const fill = (n, ...tail) => names(...Array.from({ length: n - tail.length }, (_, i) => `label-${i}`), ...tail);

test("exit 2: a label list that fills the limit cannot prove the release labels undefined", () => {
  const t = rig({ outs: { "pr-view-1": view(["bug"]), "label-list": JSON.stringify(fill(1000)) } });
  const r = t.run();
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.out.step, "list-labels");
  assert.deepEqual(t.calls(), [VIEW, LIST]);
  assert.equal(r.out.commented, false);
  assert.equal(r.out.added, false);
});

test("a list one short of the limit with no release label still skips the count", () => {
  const t = rig({
    outs: { "pr-view-1": view(["bug"]), "pr-view-2": view(["bug", "ready-to-merge"]), "label-list": JSON.stringify(fill(999)) },
  });
  const r = t.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.releaseLabels, "undefined-in-repo");
});

test("exit 3: a list one short of the limit that defines a release label still gates", () => {
  const t = rig({ outs: { "pr-view-1": view(["bug"]), "label-list": JSON.stringify(fill(999, "patch")) } });
  const r = t.run();
  assert.equal(r.status, 3, r.stderr);
});

test("exit 4: a read-back without the label fails even though gh pr edit returned 0", () => {
  const t = rig({ outs: { "pr-view-2": view(["patch", "bug"]) } });
  const r = t.run();
  assert.equal(r.status, 4, r.stderr);
  // Every write ran and succeeded; only the read-back says otherwise.
  assert.deepEqual(t.calls(), [VIEW, COMMENT, EDIT, BACK]);
  assert.equal(r.out.exit, 4);
  assert.equal(r.out.added, true);
  assert.deepEqual(r.out.firstRead, ["patch", "bug"]);
  assert.deepEqual(r.out.readBack, ["patch", "bug"]);
});

// Exit 2, once per gh call: the step that failed is the last call in the log.
const STEPS = [
  { key: "pr-view-1", step: "read-labels", calls: [VIEW], baseline: {} },
  { key: "label-list", step: "list-labels", calls: [VIEW, LIST], baseline: { "pr-view-1": view(["bug"]) } },
  { key: "pr-comment", step: "comment", calls: [VIEW, COMMENT], baseline: {} },
  { key: "pr-edit", step: "add-label", calls: [VIEW, COMMENT, EDIT], baseline: {} },
  { key: "pr-view-2", step: "read-back", calls: [VIEW, COMMENT, EDIT, BACK], baseline: {} },
];
for (const { key, step, calls, baseline } of STEPS) {
  test(`exit 2: a gh failure at ${step} carries its stderr and no later step runs`, () => {
    const t = rig({ outs: baseline, fails: { [key]: `boom at ${step}\n` } });
    const r = t.run();
    assert.equal(r.status, 2, r.stderr);
    assert.deepEqual(t.calls(), calls);
    assert.equal(r.out.exit, 2);
    assert.equal(r.out.step, step);
    assert.equal(r.out.error, `boom at ${step}`);
    assert.match(r.stderr, new RegExp(`boom at ${step}`));
  });
}

test("exit 2: a failed comment leaves the label unwritten and the receipt says so", () => {
  const t = rig({ fails: { "pr-comment": "nope" } });
  const r = t.run();
  assert.equal(r.status, 2);
  assert.equal(r.out.commented, false);
  assert.equal(r.out.added, false);
  assert.equal(r.out.readBack, null);
});

test("exit 2: a failed label write after the comment reports the comment as posted", () => {
  const t = rig({ fails: { "pr-edit": "nope" } });
  const r = t.run();
  assert.equal(r.status, 2);
  assert.equal(r.out.commented, true);
  assert.equal(r.out.added, false);
});

test("exit 2: gh printing something other than the labels is a failure, not a pass", () => {
  const t = rig({ outs: { "pr-view-1": "not json" } });
  const r = t.run();
  assert.equal(r.status, 2, r.stderr);
  assert.deepEqual(t.calls(), [VIEW]);
});

for (const pin of ["a".repeat(39), "a".repeat(41), "g".repeat(40), "abc1234", "main"]) {
  test(`exit 2: --pin ${pin} is not a full SHA, and no gh call is made`, () => {
    const t = rig();
    const r = t.run(["--pr", "42", "--pin", pin]);
    assert.equal(r.status, 2, r.stderr);
    assert.deepEqual(t.calls(), []);
    assert.equal(r.out.exit, 2);
    assert.match(r.out.error, /full 40-character commit SHA/);
  });
}

test("a missing flag, an unknown flag and a non-numeric --pr are refused before any gh call", () => {
  const t = rig();
  for (const args of [["--pin", PIN], ["--pr", "42"], ["--pr", "abc", "--pin", PIN], ["--pr", "42", "--pin", PIN, "--bogus"], ["--pr", "42", "--pin", PIN, "--repo"]]) {
    const r = t.run(args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.deepEqual(t.calls(), []);
  }
});

test("idempotent: a PR already labelled with this pin's record exits 0 and writes nothing", () => {
  const t = rig({
    outs: {
      "pr-view-1": view(["patch", "ready-to-merge"], [record(PIN, "2026-01-02T00:00:00Z")]),
      "pr-view-2": view(["patch", "ready-to-merge"]),
    },
  });
  const r = t.run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(t.calls(), [VIEW, BACK]);
  assert.equal(r.out.added, false);
  assert.equal(r.out.commented, false);
  assert.deepEqual(r.out.readBack, ["patch", "ready-to-merge"]);
});

test("idempotent: a record is not another comment's body quoted — only a whole-body record counts", () => {
  const t = rig({
    outs: { "pr-view-1": view(["patch", "ready-to-merge"], [{ body: `see ready-to-merge-head: ${PIN} above`, createdAt: "2026-01-02T00:00:00Z" }]) },
  });
  const r = t.run();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(t.calls().includes(COMMENT), t.calls().join("\n"));
});

test("idempotent: a record with a leading prefix only is not a record", () => {
  const t = rig({
    outs: { "pr-view-1": view(["patch", "ready-to-merge"], [{ body: `x ready-to-merge-head: ${PIN}`, createdAt: "2026-01-02T00:00:00Z" }]) },
  });
  const r = t.run();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(t.calls().includes(COMMENT), t.calls().join("\n"));
});

test("idempotent: a record with a trailing suffix only is not a record", () => {
  const t = rig({
    outs: { "pr-view-1": view(["patch", "ready-to-merge"], [{ body: `ready-to-merge-head: ${PIN} (stale)`, createdAt: "2026-01-02T00:00:00Z" }]) },
  });
  const r = t.run();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(t.calls().includes(COMMENT), t.calls().join("\n"));
});

test("idempotent: two records with the same createdAt resolve to the later one in list order", () => {
  const t = rig({
    outs: {
      "pr-view-1": view(["patch", "ready-to-merge"], [record(OTHER, "2026-01-02T00:00:00Z"), record(PIN, "2026-01-02T00:00:00Z")]),
    },
  });
  const r = t.run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(t.calls(), [VIEW, BACK]);
});

test("not idempotent: a label with no record for this pin gets the record and the label write", () => {
  const t = rig({ outs: { "pr-view-1": view(["patch", "ready-to-merge"], [record(OTHER, "2026-01-02T00:00:00Z")]) } });
  const r = t.run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(t.calls(), [VIEW, COMMENT, EDIT, BACK]);
  assert.equal(r.out.added, true);
});

test("not idempotent: the newest record decides, so an older matching one does not count", () => {
  const t = rig({
    outs: {
      "pr-view-1": view(["patch", "ready-to-merge"], [record(OTHER, "2026-01-03T00:00:00Z"), record(PIN, "2026-01-02T00:00:00Z")]),
    },
  });
  const r = t.run();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(t.calls().includes(COMMENT), t.calls().join("\n"));
});

test("a newest record naming this pin is honoured wherever it sits in the comment list", () => {
  const t = rig({
    outs: {
      "pr-view-1": view(["patch", "ready-to-merge"], [record(PIN, "2026-01-03T00:00:00Z"), record(OTHER, "2026-01-02T00:00:00Z")]),
    },
  });
  const r = t.run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(t.calls(), [VIEW, BACK]);
});

test("a record for this pin with the label still missing posts no second comment but writes the label", () => {
  const t = rig({ outs: { "pr-view-1": view(["patch"], [record(PIN, "2026-01-02T00:00:00Z")]) } });
  const r = t.run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(t.calls(), [VIEW, EDIT, BACK]);
  assert.equal(r.out.commented, false);
  assert.equal(r.out.added, true);
});

test("an already-labelled PR with no release label is still refused", () => {
  const t = rig({ outs: { "pr-view-1": view(["ready-to-merge"], [record(PIN, "2026-01-02T00:00:00Z")]) } });
  const r = t.run();
  assert.equal(r.status, 3, r.stderr);
  assert.deepEqual(t.calls(), [VIEW, LIST]);
});

test("--repo is the directory gh runs in, for the Ticketless test's read and every labelling call", () => {
  const t = rig();
  const r = t.run(["--pr", "42", "--pin", PIN, "--repo", t.repo]);
  assert.equal(r.status, 0, r.stderr);
  const cwds = [...t.log("closing-cwd.log").trim().split("\n"), ...t.log("cwd.log").trim().split("\n")];
  assert.equal(cwds.length, 5);
  for (const c of cwds) assert.equal(realpathSync(c), realpathSync(t.repo));
});

test("exit 2: a --repo that is not a directory is named as such, not blamed on gh, and no gh call is made", () => {
  const t = rig();
  const file = join(t.dir, "not-a-dir");
  writeFileSync(file, "");
  for (const repo of [join(t.dir, "missing"), file]) {
    const r = t.run(["--pr", "42", "--pin", PIN, "--repo", repo]);
    assert.equal(r.status, 2, r.stderr);
    assert.equal(r.out.step, "repo");
    assert.match(r.out.error, /--repo is not a directory/);
    assert.deepEqual(t.calls(), []);
  }
});

test("an ambient GIT_DIR or GIT_WORK_TREE does not reach gh", () => {
  const t = rig();
  const r = t.run(undefined, { env: { GIT_DIR: join(t.dir, "elsewhere"), GIT_WORK_TREE: t.dir } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(t.log("env.log"), "");
});

test("exit 2: a comment with no createdAt is a malformed read, not a record that sorts oldest", () => {
  const t = rig({
    outs: {
      "pr-view-1": view(["patch", "ready-to-merge"], [record(PIN, "2026-01-01T00:00:00Z"), { body: `ready-to-merge-head: ${OTHER}` }]),
    },
  });
  const r = t.run();
  assert.equal(r.status, 2, r.stderr);
  assert.deepEqual(t.calls(), [VIEW]);
});

test("positive control: with createdAt present the newer record for another head wins and the comment is posted", () => {
  const t = rig({
    outs: {
      "pr-view-1": view(["patch", "ready-to-merge"], [record(PIN, "2026-01-01T00:00:00Z"), record(OTHER, "2026-01-02T00:00:00Z")]),
    },
  });
  const r = t.run();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(t.calls().includes(COMMENT), t.calls().join("\n"));
});

// The Inert diff verdict takes only an absolute worktree, so a relative --repo
// is resolved against the cwd before it is handed over.
test("a relative --repo, run from another cwd, is the repository the Inert diff verdict reads", () => {
  const t = ticketless({ outs: { "pr-view-1": view(["bug"]), "pr-view-2": view(["bug", "patch", "ready-to-merge"]) } });
  const pin = t.commit(INERT);
  const r = t.run(["--pr", "42", "--pin", pin, "--repo", "repo"], { cwd: t.dir });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.ticketless, true);
  assert.equal(r.out.inert.verdict, "inert");
});
