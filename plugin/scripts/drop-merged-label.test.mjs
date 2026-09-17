// Regression gate for drop-merged-label.sh, the merge-triggered third step in
// the claim lifecycle (#170) — neither CONTEXT.md's Release (a claim that
// never became a PR) nor its Reap (branches and worktrees): claim-ticket.sh
// adds the label, release-ticket.sh drops it on a bail, this drops it on a
// merge.
//
// Zero deps: `node --test plugin/scripts/drop-merged-label.test.mjs`.
// No git repo needed — the script never touches git, only `gh`, so `gh` is the
// only thing stubbed, on PATH.
//
// Each precondition gets a case that proves it blocks ON ITS OWN, same
// discipline as release-ticket.test.mjs: deleting a check must fail the case
// named after it, not merely turn the suite red somewhere.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./drop-merged-label.sh", import.meta.url));

/**
 * A `gh` stub on PATH answering the four calls this script makes, tuned per
 * test through env vars. Returns a call log and an env() builder, same shape
 * as release-ticket.test.mjs's fixture.
 */
function stub(t) {
  const root = mktemp(t);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const log = join(root, "gh.log");
  writeFileSync(log, "");
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
case "$1 $2" in
  "pr view")
    pr=\$3
    case "$*" in
      *"--json state --jq .state")
        [ "\${PR_STATE_FAIL:-0}" = 0 ] || { echo "gh: simulated failure" >&2; exit 1; }
        echo "\${PR_STATE:-MERGED}"
        ;;
      *"--json closingIssuesReferences --jq"*)
        [ "\${CLOSES_FAIL:-0}" = 0 ] || { echo "gh: simulated failure" >&2; exit 1; }
        [ -z "\${CLOSES:-}" ] || printf '%s\\n' \${CLOSES}
        ;;
      *) echo "gh: unstubbed pr view call: $*" >&2; exit 1 ;;
    esac
    ;;
  "issue view")
    n=\$3
    case ",\${ISSUE_VIEW_FAIL:-}," in *",\$n,"*) echo "gh: simulated failure" >&2; exit 1;; esac
    eval "labels=\\\${LABELS_\$n:-}"
    [ -z "\$labels" ] || printf '%s\\n' \$labels
    ;;
  "issue edit")
    n=\$3
    case ",\${EDIT_FAIL:-}," in *",\$n,"*) echo "gh: simulated failure" >&2; exit 1;; esac
    ;;
  *) echo "gh: unstubbed call: $*" >&2; exit 1 ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  return {
    log,
    calls: () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean),
    env: (extra = {}) => ({ ...process.env, PATH: `${bin}:${process.env.PATH}`, ...extra }),
  };
}

function mktemp(t) {
  const root = mkdtempSync(join(tmpdir(), "drop-merged-label-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function run(pr, { apply = false, env = {} } = {}) {
  const argv = apply ? [String(pr), "--apply"] : [String(pr)];
  const res = spawnSync("sh", [SCRIPT, ...argv], { env, encoding: "utf8" });
  return {
    code: res.status,
    json: res.stdout.trim() ? JSON.parse(res.stdout) : null,
    stderr: res.stderr,
  };
}

test("usage: rejects a non-numeric PR", (t) => {
  const s = stub(t);
  const { code, stderr } = run("abc", { env: s.env() });
  assert.equal(code, 2);
  assert.match(stderr, /pr must be a number/);
  assert.deepEqual(s.calls(), [], "must refuse before calling gh at all");
});

test("usage: rejects a zero-padded PR number", (t) => {
  // The same defect #121 names for `"issue":%s`, in this script's `"pr":%s`
  // slot: all-digits is not a JSON number, so `007` cleared the guard and the
  // payload emitted `{"pr":007,…}` — unparseable at exit 0. Refused before gh
  // is reached, like every other usage error here. Two widths, because one does
  // not pin the guard: `0?*` narrowed to `0??*` still refuses `007` and
  // re-admits `01`, which is the same bug back.
  const s = stub(t);
  for (const padded of ["007", "01"]) {
    const { code, stderr } = run(padded, { env: s.env() });
    assert.equal(code, 2, padded);
    assert.match(stderr, /pr must be a number/);
  }
  assert.deepEqual(s.calls(), [], "must refuse before calling gh at all");
});

test("usage: a bare 0 clears the numeric guard", (t) => {
  // `0?*`, not `0*`: #121 lists `sh inflight.sh 0 -> parses` among its PASSING
  // cases, beside `42`. A bare `0` is a valid RFC 8259 number and `$((0))` is
  // `0`, so neither hazard the guard exists to close applies to it. Widening
  // the arm would refuse a value the ticket's own worked example shows working.
  const s = stub(t);
  const { code, stderr } = run("0", { env: s.env() });
  assert.doesNotMatch(stderr, /pr must be a number/);
  assert.equal(code, 0, "0 clears the guard and runs to completion");
});

test("usage: rejects an unknown second argument", (t) => {
  const s = stub(t);
  const { code, stderr } = run(9, { apply: false, env: s.env() });
  const res = spawnSync("sh", [SCRIPT, "9", "--wat"], { env: s.env(), encoding: "utf8" });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /unknown argument/);
});

test("a PR whose state query fails halts before anything else", (t) => {
  const s = stub(t);
  const { code, stderr } = run(9, { env: s.env({ PR_STATE_FAIL: "1" }) });
  assert.equal(code, 2);
  assert.match(stderr, /cannot tell whether it merged/);
});

test("a PR that is not merged is refused, not silently skipped", (t) => {
  const s = stub(t);
  const { code, stderr } = run(9, { env: s.env({ PR_STATE: "CLOSED" }) });
  assert.equal(code, 2);
  assert.match(stderr, /not merged \(state=CLOSED\)/);
  // Never reaches the closingIssuesReferences call — a closed-not-merged PR
  // is nothing this script may touch, so nothing past state should ever run.
  assert.ok(!s.calls().some((c) => c.includes("closingIssuesReferences")));
});

test("closingIssuesReferences query failing after a confirmed merge still halts", (t) => {
  const s = stub(t);
  const { code, stderr } = run(9, { env: s.env({ CLOSES_FAIL: "1" }) });
  assert.equal(code, 2);
  assert.match(stderr, /cannot read which issues it closes/);
});

test("a merged PR that closes nothing is a clean no-op", (t) => {
  const s = stub(t);
  const { code, json } = run(9, { apply: true, env: s.env({ CLOSES: "" }) });
  assert.equal(code, 0);
  assert.deepEqual(json, { pr: 9, merged: true, issues: [], applied: true, failed: [] });
});

test("dry run reports what it would drop and touches nothing", (t) => {
  const s = stub(t);
  const { code, json } = run(9, { apply: false, env: s.env({ CLOSES: "41", LABELS_41: "in-progress ready-for-agent" }) });
  assert.equal(code, 0);
  assert.deepEqual(json.issues, [{ issue: 41, hadLabel: true, removed: false }]);
  assert.ok(!s.calls().some((c) => c.startsWith("issue edit")), "dry run must never call issue edit");
});

test("--apply drops in-progress from a merged PR's closed issue", (t) => {
  const s = stub(t);
  const { code, json } = run(9, { apply: true, env: s.env({ CLOSES: "41", LABELS_41: "in-progress ready-for-agent" }) });
  assert.equal(code, 0);
  assert.deepEqual(json.issues, [{ issue: 41, hadLabel: true, removed: true }]);
  assert.ok(s.calls().includes("issue edit 41 --remove-label in-progress"));
});

test("an issue that already lost the label is reported clear, not re-edited", (t) => {
  const s = stub(t);
  const { code, json } = run(9, { apply: true, env: s.env({ CLOSES: "41", LABELS_41: "ready-for-agent" }) });
  assert.equal(code, 0);
  assert.deepEqual(json.issues, [{ issue: 41, hadLabel: false, removed: false }]);
  assert.ok(!s.calls().some((c) => c.startsWith("issue edit")));
});

test("a failed label read is reported, never swallowed", (t) => {
  const s = stub(t);
  const { code, json } = run(9, {
    apply: true,
    env: s.env({ CLOSES: "41", ISSUE_VIEW_FAIL: "41" }),
  });
  assert.equal(code, 1);
  assert.deepEqual(json.failed, [41]);
});

// #1543. Same defect class PR #1519 fixed in reap.sh's grep_probe: `grep -q`
// has THREE outcomes and the bare `if … grep -qx …; then had=true; else
// had=false; fi` this script used to run had room for only two — rc 0
// matched, rc 1 none did, rc 2+ the scan itself broke — so grep's OWN failure
// used to fold into `had=false`, reading exactly like the "already clear"
// case two tests up and letting a merged ticket keep the label with nothing
// reported.
function grepScanFailShim(t) {
  const bin = mkdtempSync(join(tmpdir(), "drop-merged-label-grep-shim-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(join(bin, "grep"), `#!/bin/sh\necho "grep: illegal byte sequence" >&2\nexit 2\n`, { mode: 0o755 });
  return bin;
}

test("a grep scan failure over an issue's labels is reported failed, never read as already clear", (t) => {
  const s = stub(t);
  const bin = grepScanFailShim(t);
  const base = s.env({ CLOSES: "41", LABELS_41: "in-progress" });
  const { code, json } = run(9, { apply: true, env: { ...base, PATH: `${bin}:${base.PATH}` } });
  assert.equal(code, 1, "a swallowed scan failure would read as success (exit 0)");
  assert.deepEqual(json.issues, [{ issue: 41, hadLabel: null, removed: false }],
    "hadLabel must be null (unknown), not false — false is the reading a completed, genuinely-empty scan earns");
  assert.deepEqual(json.failed, [41]);
  assert.ok(!s.calls().some((c) => c.startsWith("issue edit")),
    "an unscanned label must not be removed on a guess either");
});

test("a failed removal is reported loudly, not swallowed — the acceptance criterion", (t) => {
  const s = stub(t);
  const { code, json, stderr } = run(9, {
    apply: true,
    env: s.env({ CLOSES: "41", LABELS_41: "in-progress", EDIT_FAIL: "41" }),
  });
  assert.equal(code, 1, "a swallowed failure would read as success (exit 0)");
  assert.deepEqual(json.issues, [{ issue: 41, hadLabel: true, removed: false }]);
  assert.deepEqual(json.failed, [41]);
  assert.match(stderr, /FAILED to drop in-progress/);
});

test("one failure among several issues does not stop the rest from being processed", (t) => {
  const s = stub(t);
  const { code, json } = run(9, {
    apply: true,
    env: s.env({
      CLOSES: "41\n42",
      LABELS_41: "in-progress",
      LABELS_42: "in-progress",
      EDIT_FAIL: "41",
    }),
  });
  assert.equal(code, 1);
  assert.deepEqual(json.issues, [
    { issue: 41, hadLabel: true, removed: false },
    { issue: 42, hadLabel: true, removed: true },
  ]);
  assert.deepEqual(json.failed, [41]);
});

// The acceptance criterion is "reopening a previously-merged ticket makes it a
// candidate again" — verified against the real consumer, not against this
// file's idea of one. candidates.mjs excludes on the literal string
// `-label:in-progress`; this proves this script issues the exact `gh issue
// edit --remove-label in-progress` call that clears the one flag that clause
// keys on, so a reopened issue this script has touched no longer matches it.
test("the label this script drops is the exact one candidates.mjs excludes on", (t) => {
  const candidates = readFileSync(
    fileURLToPath(new URL("./candidates.mjs", import.meta.url)),
    "utf8",
  );
  assert.match(candidates, /-label:in-progress/, "candidates.mjs moved its exclusion — update this test");

  const s = stub(t);
  const { code } = run(9, { apply: true, env: s.env({ CLOSES: "41", LABELS_41: "in-progress" }) });
  assert.equal(code, 0);
  assert.ok(s.calls().includes("issue edit 41 --remove-label in-progress"));
});
