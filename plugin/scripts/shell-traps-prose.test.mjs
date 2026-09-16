// #854. `run-team/SKILL.md`'s **Shell traps** section is the single seat for the
// zsh family, and the one thing a pin here has to stop is the rule being written
// BACKWARDS. The ticket was filed naming `for x in $(…)` as the hazard — that is
// the form that works — and a member acted on the uncorrected version and
// reported a working bounded poll as broken. A string-matching pin cannot tell
// the two directions apart: both spellings contain the same words.
//
// So this file RUNS them. It lifts the forms the document calls hazardous and
// safe and executes each under zsh, asserting the document's own claim about
// iteration counts. Invert the section and the test reddens because zsh
// disagrees with it, not because a string moved. Same discipline as
// watcher-degraded-block.test.mjs, one document over.
//
// It also runs `run-merge-bot.md`'s **Then stay armed** monitor, lifted from the
// fence rather than copied, because that block carried a live instance of this
// exact defect until this ticket.
//
// THE CEILING: zsh only. Every assertion here is skipped when no zsh is on
// PATH, which is the honest scope — the traps are zsh-vs-bash differences and
// there is nothing to measure without the shell they bite in. The bash/sh
// columns of the document's table are asserted only where those shells exist
// too. And this measures loop mechanics: nothing here contacts GitHub, and the
// monitor's `gh` is a stub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SKILLS = join(import.meta.dirname, "..", "skills");
const SKILL = readFileSync(join(SKILLS, "run-team", "SKILL.md"), "utf8");
const MERGE_BOT = readFileSync(join(import.meta.dirname, "..", "commands", "run-merge-bot.md"), "utf8");

const DIR = mkdtempSync(join(tmpdir(), "shell-traps-"));
const BIN = join(DIR, "bin");
mkdirSync(BIN);

const stub = (name, body) => {
  const p = join(BIN, name);
  writeFileSync(p, body);
  chmodSync(p, 0o755);
};

const hasShell = (s) => {
  try {
    execFileSync(s, ["-c", "exit 0"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

// Runs a script and returns stdout. `env` is merged so the monitor case can
// point its stub at a per-case call counter.
const sh = (shell, script, env = {}) => {
  const p = join(DIR, "case.sh");
  writeFileSync(p, script);
  return execFileSync(shell, [p], {
    encoding: "utf8",
    env: { ...process.env, ...env, PATH: `${BIN}:${process.env.PATH}` },
  });
};

// Slice to the section, so a sentence elsewhere in a 3000-line file can never
// stand in for one here. Anchored on the heading text, never on an offset.
const section = (doc, heading) => {
  const start = doc.indexOf(`\n## ${heading}\n`);
  assert.notEqual(start, -1, `run-team/SKILL.md no longer has a '## ${heading}' section — this ticket put it there`);
  const rest = doc.slice(start + 1);
  const end = rest.indexOf("\n## ", 1);
  return end === -1 ? rest : rest.slice(0, end);
};

const TRAPS = section(SKILL, "Shell traps");

// The three-value list the section's own table is measured against.
const LIST = "849\\n850\\n852\\n";

// A literal phrase as a regex that tolerates re-wrapping: every run of
// whitespace matches any run. The CLAIM is what these tests pin; where the
// editor's line breaks fall is not, and a pin that reddens on a reflow is one
// the next reader weakens instead of reading.
const phrase = (s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"));

test("the section exists and is the only place the zsh loop family is stated", () => {
  // The mechanism sentence lives once. The two seats that consume it cite the
  // section instead of restating it — that is #854's placement ruling, and the
  // drift it prevents is a second copy going stale against the first.
  const mechanism = phrase("word-splits an unquoted command substitution's result; it does NOT split an unquoted parameter expansion");
  assert.match(TRAPS, mechanism, "the Shell traps section dropped the mechanism sentence");

  const elsewhere = SKILL.replace(TRAPS, "");
  assert.ok(
    !/zsh has no `PIPESTATUS`/.test(elsewhere),
    "a second copy of the PIPESTATUS trap is back outside Shell traps — #854 collapsed them into one seat",
  );
  assert.ok(
    !/is a READ-ONLY variable in zsh/.test(elsewhere),
    "a second copy of the read-only-`status` trap is back outside Shell traps",
  );
});

test("both consumer seats reach the section instead of restating it", () => {
  // Phase 3 writes the CI watcher's loop; the merge-bot brief is where a bot
  // gets the same traps. The ticket's ruling is that neither carries its own
  // copy, so each has to name the section.
  const watcher = SKILL.slice(SKILL.indexOf("**Guard every probe, not just the ones with a verdict field.**"));
  const watcherPara = watcher.slice(0, watcher.indexOf("\n\n**Judge `ci-state`"));
  // The citation is the section NAME, in whatever emphasis the sentence wants.
  // Pinning `**Shell traps**` exactly would fail on a bold span that opens
  // earlier in the clause, which is a rewording rather than a lost pointer.
  assert.match(
    watcherPara,
    /\bShell traps\b/,
    "phase 3's monitor paragraph no longer points at Shell traps — it either lost the pointer or grew its own copy of the mechanism",
  );

  const brief = SKILL.slice(SKILL.indexOf("**Put every gate trap in the bot's brief"));
  const briefList = brief.slice(0, brief.indexOf("\n\n", brief.indexOf("- **A `jq` exit outside 0 and 1")));
  assert.match(
    briefList,
    /\bShell traps\b/,
    "the merge bot's gate-trap list no longer points at Shell traps, so a dispatched bot never receives them",
  );
});

test("the document names the HAZARD form, and zsh agrees it collapses", () => {
  if (!hasShell("zsh")) return;
  // The row the section marks as the hazard, run for real. If the section is
  // ever reworded to call `$(…)` the hazard, the form under test here changes
  // with it and zsh returns 3 — which is what reddens this, in the one
  // direction a string match cannot see.
  assert.match(
    TRAPS,
    phrase("hazard is the **assigned-variable** form, never `$(…)`"),
    "Shell traps no longer names the assigned-variable form as the hazard — #854's whole correction is that direction",
  );
  const out = sh("zsh", `prs=$(printf '${LIST}')\ni=0; for pr in $prs; do i=$((i+1)); done; echo "$i"`);
  assert.equal(
    out.trim(),
    "1",
    "zsh no longer collapses `for pr in $prs` — the section's hazard row is now false and the rule needs re-measuring",
  );
});

test("the document names `$(…)` as SAFE, and zsh agrees it splits", () => {
  if (!hasShell("zsh")) return;
  // The half the original ticket got backwards. A reader who avoids this form
  // rewrites working loops, so the pin asserts the document still blesses it
  // AND that zsh still earns the blessing.
  assert.match(TRAPS, phrase("`$(…)` splits. Leave it alone."), "Shell traps stopped blessing the command-substitution form");
  const inline = sh("zsh", `i=0; for pr in $(printf '${LIST}'); do i=$((i+1)); done; echo "$i"`);
  assert.equal(inline.trim(), "3", "zsh no longer splits an inline command substitution — the section's safe row is now false");
  const seq = sh("zsh", `j=0; for _ in $(seq 1 60); do j=$((j+1)); done; echo "$j"`);
  assert.equal(seq.trim(), "60", "the bounded-poll row is false — `for _ in $(seq 1 60)` no longer runs 60 times");
});

test("bash and sh split BOTH forms — which is why the bug hides", () => {
  // The table's third column. Without it the section reads as a fact about
  // loops rather than about zsh, and the reason a bash-tested loop ships broken
  // goes unstated.
  for (const shell of ["sh", "bash"]) {
    if (!hasShell(shell)) continue;
    const out = execFileSync(shell, ["-c", `prs=$(printf '${LIST}'); i=0; for pr in $prs; do i=$((i+1)); done; echo "$i"`], {
      encoding: "utf8",
    });
    assert.equal(out.trim(), "3", `${shell} no longer splits a bare parameter expansion; the table's bash/sh column is wrong`);
  }
});

test("the prescribed remedy is line-exact where `$(printf …)` is not", () => {
  if (!hasShell("zsh")) return;
  // The section prescribes `while IFS= read -r` and explains that the inline
  // form splits on every whitespace character. That distinction is the reason
  // the remedy is not "use either" — so it gets measured, not asserted.
  assert.match(
    TRAPS,
    phrase("Capture-then-loop needs `while IFS= read -r` fed by a heredoc"),
    "Shell traps no longer prescribes the heredoc-fed `while IFS= read -r` remedy",
  );
  const blob = `blob=$(printf 'two words\\nsecond\\n')`;
  const viaSubst = sh("zsh", `${blob}\ni=0; for x in $(printf '%s\\n' "$blob"); do i=$((i+1)); done; echo "$i"`);
  const viaRead = sh("zsh", `${blob}\ni=0; while IFS= read -r x; do i=$((i+1)); done <<EOF\n$blob\nEOF\necho "$i"`);
  assert.equal(viaSubst.trim(), "3", "`$(printf …)` stopped splitting on the space inside a value; the section's caveat is stale");
  assert.equal(viaRead.trim(), "2", "`while IFS= read -r` stopped being line-exact; the prescribed remedy no longer holds");
});

test("an inner command without `</dev/null` eats the loop's stdin", () => {
  if (!hasShell("zsh")) return;
  // The half nothing in this repo carried before #854, and the reason it
  // matters: the failure signature is IDENTICAL to the word-split bug, so a
  // reader who fixes the loop correctly and omits this sees no change and
  // concludes the fix did not work.
  assert.match(
    TRAPS,
    phrase("`</dev/null` every command inside a `while read` loop"),
    "Shell traps dropped the `</dev/null` rule — the remedy it prescribes is unsafe without it",
  );
  const loop = (inner) => `i=0; while IFS= read -r n; do i=$((i+1)); ${inner}; done <<EOF\n849\n850\n852\nEOF\necho "$i"`;
  assert.equal(sh("zsh", loop("cat >/dev/null")).trim(), "1", "an unredirected inner reader no longer eats the loop's stdin; re-measure the rule");
  assert.equal(sh("zsh", loop("cat >/dev/null </dev/null")).trim(), "3", "`</dev/null` no longer protects the loop's stdin");
});

test("the probe-could-not-look rule is stated as its own instruction", () => {
  // #854's third ruling. It is a sentence, not a clause hanging off the loop
  // rule, because a monitor that `continue`s on an unreadable probe is blind
  // whether or not its loop iterates.
  assert.match(
    TRAPS,
    phrase("**A probe that could not look emits an event; it never `continue`s.**"),
    "Shell traps lost the probe-could-not-look instruction",
  );
  assert.match(
    TRAPS,
    /transition event, not silence/,
    "the probe rule no longer routes to phase 3's full statement, so the sentence is all a reader gets",
  );
});

// --- run-merge-bot.md's monitor, lifted from the fence and executed ----------

// Anchored on what the block contains, never on its ordinal. Exactly one fence
// in that document emits the label event.
const monitorBlocks = [...MERGE_BOT.matchAll(/```bash\n([\s\S]*?)```/g)]
  .map((m) => m[1])
  .filter((b) => b.includes("ready-to-merge label added"));
assert.equal(
  monitorBlocks.length,
  1,
  `expected exactly one bash block emitting the ready-to-merge event, found ${monitorBlocks.length} — update this test`,
);
const MONITOR = monitorBlocks[0];

const WATCH_LOOP = "while true; do";
assert.ok(MONITOR.includes(WATCH_LOOP), `the monitor no longer opens with '${WATCH_LOOP}'; the harness caps the run on that line — update this test`);

// `gh` returns 849,850 on the seed call and 849,850,852 after it: one PR whose
// label genuinely appeared after arming. `sleep` is a no-op so the cap is the
// tick count, not wall time.
stub(
  "gh",
  `#!/bin/sh
c="$CALLS/n"
n=$(cat "$c" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" >"$c"
if [ "$n" -le 1 ]; then printf '849\\n850\\n'; else printf '849\\n850\\n852\\n'; fi
`,
);
stub("sleep", "#!/bin/sh\nexit 0\n");

const runMonitor = (shell, body, ticks = 2) => {
  const calls = mkdtempSync(join(tmpdir(), "shell-traps-calls-"));
  const capped = body.replace(WATCH_LOOP, `tick=0\nwhile tick=$((tick+1)); [ "$tick" -le ${ticks} ]; do`);
  return sh(shell, capped, { CALLS: calls });
};

const events = (out) => out.split("\n").filter((l) => l.includes("ready-to-merge label added")).map((l) => l.trim());

test("the stay-armed monitor reports the ONE new PR, under zsh as well as sh", () => {
  for (const shell of ["sh", "bash", "zsh"]) {
    if (!hasShell(shell)) continue;
    const got = events(runMonitor(shell, MONITOR));
    assert.deepEqual(
      got,
      ["ready-to-merge label added: PR #852"],
      `${shell}: the monitor did not report exactly the new PR. A single event naming several numbers is the #854 collapse — the loop is iterating once over the whole list.`,
    );
  }
});

test("the monitor stays silent when no label appeared", () => {
  if (!hasShell("zsh")) return;
  // The positive control's other half: a monitor that fires on an unchanged
  // list is noise, and the seeded `seen` is what prevents it. Without this, a
  // loop that emitted an event per tick would pass the test above on tick 1.
  stub("gh", "#!/bin/sh\nprintf '849\\n850\\n'\n");
  try {
    assert.deepEqual(events(runMonitor("zsh", MONITOR, 3)), [], "the monitor re-fires on an unchanged labeled set");
  } finally {
    stub(
      "gh",
      `#!/bin/sh
c="$CALLS/n"
n=$(cat "$c" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" >"$c"
if [ "$n" -le 1 ]; then printf '849\\n850\\n'; else printf '849\\n850\\n852\\n'; fi
`,
    );
  }
});

test("the monitor does not fire on an empty labeled set", () => {
  if (!hasShell("zsh")) return;
  // The blank-line guard. A heredoc fed an empty `cur` still delivers one empty
  // line, so without `[ -n "$n" ]` the block emits `PR #` — an event naming no
  // PR, which is the same class of garbage the collapse produced.
  stub("gh", "#!/bin/sh\nexit 0\n");
  try {
    const out = runMonitor("zsh", MONITOR, 2);
    assert.deepEqual(events(out), [], `an empty labeled set produced an event:\n${out}`);
  } finally {
    stub(
      "gh",
      `#!/bin/sh
c="$CALLS/n"
n=$(cat "$c" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" >"$c"
if [ "$n" -le 1 ]; then printf '849\\n850\\n'; else printf '849\\n850\\n852\\n'; fi
`,
    );
  }
});

test("run-merge-bot.md's bounded poll is left alone — it is not an instance", () => {
  // The ticket's filer retracted the claim that step 1's poll was a second
  // instance of this bug, and a later reader "fixing" it would be acting on the
  // retracted version. Pin the form so that edit has to argue with a test.
  assert.match(
    MERGE_BOT,
    /for _ in \$\(seq 1 60\); do/,
    "step 1's bounded poll was rewritten — it is a command substitution, it splits correctly (60 iterations, measured), and #854's filer retracted the claim that it was broken",
  );
});
