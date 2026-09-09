// #784. The degraded-watcher snippet in `run-team/SKILL.md` is prescriptive
// shell a controller copies verbatim, and it has now shipped a defect that its
// OWN surrounding prose already ruled out — three times. So this pin RUNS the
// block rather than matching strings in it: it lifts the fenced snippet out of
// the document, stubs `gh`, `ci-state.mjs` and `sleep` on PATH, and drives it
// through the states the prose promises: every probe latched at the level its
// cause lives at, each latch one-shot in both directions, one sleep per tick
// whatever went wrong, an ordinary not-green left alone, and the per-PR loop
// splitting per PR under zsh as well as sh.
//
// THE CEILING: the stubs cover only the three probes the block makes, and
// `sleep` is counted rather than taken, so this measures the block's control
// flow and nothing about real GitHub, real timing, or the "your normal handling
// of $st" line the block leaves as a placeholder. It also assumes the block
// stays a `while :; do` tick loop — that string is how the harness caps the run,
// and a rewrite to another loop form must update this test rather than the
// document.
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

// Every *SEQ variable names a file of one value per line, consumed one per
// invocation, so a scenario can change what a probe returns between ticks. The
// matching fixed variable is the alternative. `gh` needs this for RL too: a
// latch is one-shot only if it stays quiet across a SUSTAINED outage and speaks
// once on recovery, and neither is observable from a single static budget.
stub("gh", `#!/bin/sh
next() {
  if [ -n "$1" ]; then
    n=$(cat "$1.n" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$1.n"
    sed -n "\${n}p" "$1"
  else
    printf '%s\\n' "$2"
  fi
}
case "$2" in
  list)
    if [ "$(next "$LISTSEQ" "\${LISTMODE-ok}")" = err ]; then exit 1; fi
    for p in $PRS; do echo "$p"; done ;;
  *) next "$RLSEQ" "\${RL-5000}" ;;
esac
`);

// $SEQ names a global sequence file; $SEQ.<pr>, when it exists, overrides it for
// that PR with its own file and its own counter. Without that per-PR override no
// scenario can hold two PRs in DIFFERENT states across more than one tick, which
// is the shape every multi-PR latch mutation lives in.
stub("ci-state.mjs", `#!/bin/sh
pr=$2
seq=$SEQ
[ -n "$seq" ] && [ -f "$seq.$pr" ] && seq="$seq.$pr"
if [ -n "$seq" ]; then
  n=$(cat "$seq.n" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$seq.n"
  mode=$(sed -n "\${n}p" "$seq")
else
  mode=$MODE
fi
case "$mode" in
  empty) exit 1 ;;
  garbage) echo '<html>429</html>'; exit 1 ;;
  ratelimited) printf '{"pr":%s,"verdict":"rate-limited","reasons":["refused"]}\\n' "$pr"; exit 1 ;;
  emptyobj) echo '{}'; exit 1 ;;
  nulldoc) echo 'null'; exit 1 ;;
  nullverdict) printf '{"pr":%s,"verdict":null}\\n' "$pr"; exit 1 ;;
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

function run(env, ticks, shell = "sh") {
  const harness = BLOCK
    .replace("~/.fleet/bin/fleet-run ci-state.mjs", "ci-state.mjs")
    .replace(TICK_LOOP, `tick=0\nwhile tick=$((tick+1)); [ "$tick" -le ${ticks} ]; do`);
  const path = join(DIR, "harness.sh");
  writeFileSync(path, harness);
  return execFileSync(shell, [path], {
    encoding: "utf8",
    env: { ...process.env, ...env, PATH: `${BIN}:${process.env.PATH}` },
  });
}

const hasShell = (s) => {
  try {
    execFileSync(s, ["-c", "exit 0"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const count = (out, needle) => out.split("\n").filter((l) => l.includes(needle)).length;

// The WATCHER lines in order, as "D42"/"R42" — for the multi-PR cases, where
// which PR spoke and when both matter and a bare count hides a reordering.
const events = (out) =>
  out
    .split("\n")
    .filter((l) => l.startsWith("WATCHER"))
    .map((l) => `${l.includes("DEGRADED") ? "D" : "R"}${l.match(/#(\d+)/)?.[1] ?? "*"}`);

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

test("one PR recovers without disturbing a sibling that is still blind", () => {
  // Two PRs, four ticks, blind at different times — the only shape in which the
  // per-PR latch's bookkeeping is observable at all. #4 is healthy on tick 1 and
  // blind thereafter; #42 is blind from tick 1 and readable from tick 3. Each
  // must announce itself exactly once in each direction, and #4's numbering is
  // deliberately a prefix of #42's so the `case " $blind " in *" $pr "*` space
  // anchoring is under test too.
  //
  // Three latch mutations die here and survive every other case in this file:
  // wiping `blind` wholesale on any recovery (#4 re-fires on tick 4 -> 3
  // DEGRADED), overwriting `blind="$pr"` instead of appending (neither PR stays
  // latched -> 5 DEGRADED, 0 RECOVERED), and dropping the spaces from the latch
  // test (#4 matches inside "42" and its outage is swallowed -> 1 DEGRADED).
  const seq = join(DIR, "seq-siblings");
  writeFileSync(`${seq}.4`, "normal\nempty\nempty\nempty\n");
  writeFileSync(`${seq}.42`, "empty\nempty\nnormal\nnormal\n");
  const out = run({ SEQ: seq, PRS: "4 42" }, 4);
  // The ordered sequence, not four counts: the anchoring mutant only DELAYS #4's
  // line to the tick #42's latch clears, so it lands on the same two-DEGRADED,
  // one-RECOVERED totals the real block does and is invisible to counting.
  assert.deepEqual(events(out), ["D42", "D4", "R42"], `wrong events, or in the wrong order:\n${out}`);
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
  // And once more on the healthy path, which neither case above reaches: both
  // route around the block's normal-handling line — the budget outage never
  // enters the per-PR pass, the payload outage `continue`s before it. A sleep
  // planted on that line is invisible to every other test in this file.
  const healthy = run({ MODE: "normal", PRS: "1 2 3 4 5 6 7 8" }, 1);
  assert.equal(count(healthy, "SLEEP"), 1, `healthy path: expected one sleep per tick regardless of PR count, got:\n${healthy}`);
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

test("a payload with no verdict at all is an outage, not a reading", () => {
  // `.verdict != "rate-limited"` never tests that a verdict EXISTS: {}, null and
  // an explicit null field all evaluate `null != "rate-limited"` -> true and
  // clear the gate, handing an empty or error object downstream as CI state.
  for (const MODE of ["emptyobj", "nulldoc", "nullverdict"]) {
    const out = run({ MODE, PRS: "7" }, 1);
    assert.equal(count(out, "WATCHER DEGRADED"), 1, `${MODE} cleared the gate — it tests inequality, not presence:\n${out}`);
  }
});

test("a failing `gh pr list` is an outage, not zero open PRs", () => {
  // The third probe, with the budget healthy: a non-quota failure (secondary
  // limit, 5xx, token error) never lowers .resources.core.remaining, so the
  // budget gate clears and an unguarded `for pr in $(gh pr list …)` iterates
  // zero times over the empty substitution — no error, no latch, no line. Total
  // silence per tick, which is the exact state this section exists to remove.
  const out = run({ LISTMODE: "err", PRS: "7" }, 3);
  assert.equal(count(out, "WATCHER DEGRADED"), 1, `expected one DEGRADED across three ticks, got:\n${out}`);
  assert.equal(count(out, "SLEEP"), 3, `an unreadable PR list must still reach the tail sleep, got:\n${out}`);
});

test("the open-PR list latch clears once on recovery, not once per tick", () => {
  const seq = join(DIR, "seq-list");
  writeFileSync(seq, "err\nok\nok\n");
  const out = run({ LISTSEQ: seq, MODE: "normal", PRS: "7" }, 3);
  assert.equal(count(out, "WATCHER DEGRADED"), 1, out);
  assert.equal(count(out, "WATCHER RECOVERED"), 1, `expected exactly one RECOVERED, got:\n${out}`);
});

test("the budget latch is one-shot across a sustained outage", () => {
  // Its own semantics, not the payload latch's: a budget branch that lost its
  // `[ -z "$budget_out" ]` guard spams a DEGRADED every tick during exactly the
  // outage it is reporting, and no per-PR test can see it — the per-PR pass
  // never runs while the budget is out.
  const out = run({ RL: "5", PRS: "7" }, 3);
  assert.equal(count(out, "WATCHER DEGRADED"), 1, `expected one DEGRADED across three ticks, got:\n${out}`);
});

test("the budget latch clears once on recovery, not once per tick", () => {
  // The mirror mutation: a RECOVERED branch that never resets budget_out re-fires
  // on every later tick, so the recovery line stops meaning "the watch is alive
  // again" and becomes the per-tick volume the latch exists to prevent.
  const seq = join(DIR, "seq-rl");
  writeFileSync(seq, "5\n5000\n5000\n");
  const out = run({ RLSEQ: seq, MODE: "normal", PRS: "7" }, 3);
  assert.equal(count(out, "WATCHER DEGRADED"), 1, out);
  assert.equal(count(out, "WATCHER RECOVERED"), 1, `expected exactly one RECOVERED, got:\n${out}`);
});

test("the per-PR loop splits per PR under zsh too, not once over the whole blob", () => {
  // zsh word-splits a command substitution's RESULT but not a bare parameter
  // expansion, so `for pr in $prs` runs ONE iteration there with every number
  // glued into a single value (measured) while sh and bash split it correctly.
  // A regression to the bare form is therefore invisible to every sh-only case
  // above — and the same trap applies to the blind-latch removal loop, where it
  // leaves a recovered PR latched forever.
  for (const shell of ["sh", "bash", "zsh"]) {
    if (!hasShell(shell)) continue;
    const out = run({ MODE: "empty", PRS: "42 43" }, 1, shell);
    assert.equal(count(out, "WATCHER DEGRADED"), 2, `${shell}: expected one DEGRADED per PR, got:\n${out}`);
    assert.ok(out.includes("#42") && out.includes("#43"), `${shell}: PR numbers were not split individually:\n${out}`);
  }
});

test("a recovered PR leaves the blind latch under zsh too", () => {
  for (const shell of ["sh", "bash", "zsh"]) {
    if (!hasShell(shell)) continue;
    const seq = join(DIR, `seq-blind-${shell}`);
    // One PR, blind on tick 1, readable on ticks 2 and 3.
    writeFileSync(seq, "empty\nnormal\nnormal\n");
    const out = run({ SEQ: seq, PRS: "42" }, 3, shell);
    assert.equal(count(out, "WATCHER RECOVERED"), 1, `${shell}: the PR never left the blind list, so RECOVERED repeats:\n${out}`);
  }
});
