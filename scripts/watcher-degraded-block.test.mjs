// #784. The degraded-watcher snippet in `run-team/SKILL.md` is prescriptive
// shell a controller copies verbatim, and it has now shipped a defect that its
// OWN surrounding prose already ruled out — twice. So this pin RUNS the block
// rather than matching strings in it: it lifts the fenced snippet out of the
// document, stubs `gh`, `ci-state.mjs` and `sleep` on PATH, and asserts the
// three behaviours the prose promises.
//
// THE CEILING: the stubs cover only the two probes the block makes, and `sleep`
// is counted rather than taken, so this measures the block's control flow and
// nothing about real GitHub, real timing, or the "your normal handling of $st"
// line the block leaves as a placeholder. It also assumes the block stays a
// `while :; do` tick loop — that string is how the harness caps the run, and a
// rewrite to another loop form must update this test rather than the document.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The stubs shell out to jq, and so does the block under test. Without it every
// gate would fail identically and the suite would go green on a block that
// never ran — the vacuous pass this file exists to prevent.
try {
  execFileSync("jq", ["--version"], { stdio: "ignore" });
} catch {
  throw new Error("jq is required to exercise the watcher block; install it before running this suite");
}

const SKILL = readFileSync(join(import.meta.dirname, "..", "skills", "run-team", "SKILL.md"), "utf8");

// Anchored on what the block CONTAINS, never on its ordinal: a fence inserted
// ahead of it would re-rot an index. Exactly one block may say WATCHER DEGRADED.
const blocks = [...SKILL.matchAll(/```sh\n([\s\S]*?)```/g)]
  .map((m) => m[1])
  .filter((b) => b.includes("WATCHER DEGRADED"));
assert.equal(blocks.length, 1, `expected exactly one sh block emitting WATCHER DEGRADED, found ${blocks.length} — update this test`);
const BLOCK = blocks[0];

const DIR = mkdtempSync(join(tmpdir(), "watcher-block-"));
const BIN = join(DIR, "bin");
mkdirSync(BIN);

const stub = (name, body) => {
  const p = join(BIN, name);
  writeFileSync(p, body);
  chmodSync(p, 0o755);
};

stub("gh", `#!/bin/sh
case "$2" in
  list) for p in $PRS; do echo "$p"; done ;;
  *) echo "\${RL-5000}" ;;
esac
`);

// SEQ names a file of one mode per line, consumed one per invocation, so a
// scenario can change what the probe returns between ticks. MODE is the fixed
// alternative.
stub("ci-state.mjs", `#!/bin/sh
pr=$2
if [ -n "$SEQ" ]; then
  n=$(cat "$SEQ.n" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$SEQ.n"
  mode=$(sed -n "\${n}p" "$SEQ")
else
  mode=$MODE
fi
case "$mode" in
  empty) exit 1 ;;
  garbage) echo '<html>429</html>'; exit 1 ;;
  ratelimited) printf '{"pr":%s,"verdict":"rate-limited","reasons":["refused"]}\\n' "$pr"; exit 1 ;;
  blind42) [ "$pr" = 42 ] && exit 1; printf '{"pr":%s,"verdict":"not-green"}\\n' "$pr"; exit 1 ;;
  *) printf '{"pr":%s,"verdict":"not-green"}\\n' "$pr"; exit 1 ;;
esac
`);

// Counted, never taken — the block's pacing is the thing under test and a real
// 120s sleep would make the suite unrunnable.
stub("sleep", `#!/bin/sh
echo "SLEEP $1"
`);

const TICK_LOOP = "while :; do";
assert.ok(BLOCK.includes(TICK_LOOP), `the block no longer opens with '${TICK_LOOP}'; the harness caps the run on that line — update this test`);

function run(env, ticks) {
  const harness = BLOCK
    .replace("~/dev/fleet-plugin/scripts/ci-state.mjs", "ci-state.mjs")
    .replace(TICK_LOOP, `tick=0\nwhile tick=$((tick+1)); [ "$tick" -le ${ticks} ]; do`);
  const path = join(DIR, "harness.sh");
  writeFileSync(path, harness);
  return execFileSync("sh", [path], {
    encoding: "utf8",
    env: { ...process.env, ...env, PATH: `${BIN}:${process.env.PATH}` },
  });
}

const count = (out, needle) => out.split("\n").filter((l) => l.includes(needle)).length;

test("a self-named rate-limited payload is an outage, not a reading", () => {
  // ci-state emits {"verdict":"rate-limited"} on stdout and exits non-zero. It
  // is parseable JSON, so a gate testing parseability alone clears the latch,
  // prints RECOVERED, and hands the outage payload downstream as CI state.
  const seq = join(DIR, "seq-ratelimited");
  writeFileSync(seq, "empty\nratelimited\n");
  const out = run({ SEQ: seq, PRS: "7" }, 2);
  assert.equal(count(out, "WATCHER DEGRADED"), 1, `expected one DEGRADED line, got:\n${out}`);
  assert.equal(
    count(out, "WATCHER RECOVERED"),
    0,
    `a rate-limited payload cleared the latch — the gate is testing parseability, not the verdict:\n${out}`,
  );
});

test("unparseable and empty payloads are outages too", () => {
  for (const MODE of ["empty", "garbage"]) {
    const out = run({ MODE, PRS: "7" }, 1);
    assert.equal(count(out, "WATCHER DEGRADED"), 1, `${MODE}: expected one DEGRADED line, got:\n${out}`);
  }
});

test("the payload latch is keyed by PR, not shared across them", () => {
  // One persistently blind PR beside one healthy PR. A shared scalar latch is
  // re-cleared by the healthy PR every tick, so the pair repeats forever — the
  // per-tick volume the latch exists to prevent, and every RECOVERED in it
  // falsely asserts the watch is alive for a PR that is still blind.
  const out = run({ MODE: "blind42", PRS: "42 43" }, 3);
  assert.equal(count(out, "WATCHER DEGRADED"), 1, `expected one DEGRADED across three ticks, got:\n${out}`);
  assert.equal(count(out, "WATCHER RECOVERED"), 0, `a healthy PR cleared another PR's latch:\n${out}`);
});

test("a blind PR recovers on its own, without touching its healthy sibling", () => {
  const seq = join(DIR, "seq-recovery");
  writeFileSync(seq, "empty\nnormal\n");
  const out = run({ SEQ: seq, PRS: "42" }, 2);
  assert.equal(count(out, "WATCHER DEGRADED"), 1, out);
  assert.equal(count(out, "WATCHER RECOVERED"), 1, `a recovered PR must say so once, got:\n${out}`);
});

test("pacing lives in one place — a budget outage does not multiply by open PRs", () => {
  // A sleep inside the per-PR pass turns 8 open PRs into 8 pauses per tick,
  // against this section's own measured 24s outage reset.
  const budget = run({ RL: "5", PRS: "1 2 3 4 5 6 7 8" }, 1);
  assert.equal(count(budget, "SLEEP"), 1, `budget outage: expected one sleep per tick regardless of PR count, got:\n${budget}`);
  assert.equal(count(budget, "WATCHER DEGRADED"), 1, budget);
  // Same property one level down: a sleep in the per-PR degraded branch
  // multiplies the same way, and the budget case above cannot see it because
  // the per-PR pass never runs under a budget outage.
  const payload = run({ MODE: "empty", PRS: "1 2 3 4 5 6 7 8" }, 1);
  assert.equal(count(payload, "SLEEP"), 1, `payload outage: expected one sleep per tick regardless of PR count, got:\n${payload}`);
});

test("a degraded payload tick still reaches the loop's own pacing", () => {
  // A degraded branch that continues the OUTER loop skips the tail sleep and
  // busy-spins probe pairs during exactly the outage it is reporting.
  const out = run({ MODE: "empty", PRS: "7" }, 3);
  assert.equal(count(out, "SLEEP"), 3, `every tick must reach the tail sleep, got:\n${out}`);
});

test("a non-numeric budget read is an outage, not a budget", () => {
  // `.resources.core.remaining` missing from the response yields `null`, and
  // `[ null -lt 200 ]` errors — silently, under the block's own 2>/dev/null.
  for (const RL of ["null", ""]) {
    const out = run({ RL, PRS: "7" }, 1);
    assert.equal(count(out, "WATCHER DEGRADED"), 1, `RL=${RL || "(empty)"} fell through to polling with no degraded line:\n${out}`);
  }
});

test("an ordinary not-green PR never trips the outage path", () => {
  const out = run({ MODE: "normal", PRS: "7" }, 3);
  assert.equal(count(out, "WATCHER"), 0, `not-green is a frequent, ordinary state that exits non-zero:\n${out}`);
});
