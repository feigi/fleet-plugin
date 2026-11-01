// run-team/SKILL.md's wake table against `fleet-event.mjs`: one row per kind,
// each row's command the kind and nothing else, and the sentences that used to
// explain a wake's writes under the table now in the script's header comment.
//
// The kinds are read out of the script's own usage line, so a kind added to
// the script without a row fails here. The moved sentences are this test's own
// fixture: each is the text of a bullet or row that moved out of the skill, so
// the header must carry it and the skill must not.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./support/temp-dir.mjs";
import { EVENT_HEADER } from "./support/fleet-event-header.mjs";

const PLUGIN = fileURLToPath(new URL("../plugin/", import.meta.url));
const SCRIPT = join(PLUGIN, "scripts", "fleet-event.mjs");
const SKILL = readFileSync(join(PLUGIN, "skills", "run-team", "SKILL.md"), "utf8");

const squash = (s) => s.replace(/\s+/g, " ").trim();
const SKILL_FLAT = squash(SKILL);

const env = { ...process.env };
delete env.FORCE_COLOR;
const usage = spawnSync(process.execPath, [SCRIPT], { cwd: tempDir("fleet-event-table-"), encoding: "utf8", env }).stderr;
const KINDS = usage.split("kinds: ")[1].trim().split(", ").map((k) => k.split(" ")[0]);

// The rows of the table whose header is `| Wake | Command |`, as cell arrays.
function wakeTable() {
  const lines = SKILL.split("\n");
  const at = lines.indexOf("| Wake | Command |");
  assert.notEqual(at, -1, "the table's header row");
  assert.equal(lines[at + 1], "|---|---|");
  const rows = [];
  for (let i = at + 2; lines[i]?.startsWith("|"); i++) rows.push(lines[i].slice(1, -1).split("|").map((c) => c.trim()));
  return rows;
}

test("the usage line lists every kind, so the table is checked against the script", () => {
  assert.deepEqual(KINDS, ["impl-report", "fix-report", "finisher-report", "merge-bot-report", "review-result", "review-failed", "ci", "label", "conflict", "heartbeat", "drain", "undrain", "member-died"]);
});

test("the wake table has two columns and exactly one row per fleet-event.mjs kind", () => {
  const rows = wakeTable();
  for (const cells of rows) assert.equal(cells.length, 2, `two columns: ${cells.join(" | ")}`);
  const named = rows.map(([, command]) => /^`fleet-event\.mjs ([a-z-]+)(?: [^`]+)?`$/.exec(command)?.[1]);
  assert.ok(named.every((k) => k !== undefined), `every second cell is one fleet-event.mjs command and nothing else: ${rows.map((r) => r[1]).join(" ; ")}`);
  assert.deepEqual([...named].sort(), [...KINDS].sort());
});

// Text that moved out of the skill. Each must be in the header comment and
// gone from the skill.
const MOVED = [
  "`ledger.mjs settle <member> --from-report`, which runs `verify-sha.sh` and reads the PR itself.",
  "Dropping `in-progress` is the load-bearing half: phase 1 applied it and `candidates.mjs` excludes it, so leaving it makes the ticket invisible to the controller's scans and the maintainer's. It does not loop; it disappears.",
  "`reap.sh` declines a claim that never became a PR, so the release of a bailed claim is `release-ticket.sh`'s.",
  "A settle that refuses on `ready-to-merge` — missing from the PR or from the read-back — is the case the tick's `DISPATCH finisher PR#<M>` catches next: settle it `ledger.mjs settle finisher-pr-<M>=labelled` as reported, and `ledger.mjs filed <N> \"<subject>\"` for each `unrecorded` entry.",
  "The reap and the reclaim run once for every merge bot settled `done`, always, even when the pass merged nothing, and again on the next tick after an `APPLY FAILED` line, and on every tick while this run has no controller record to remember the pass by.",
  "The bot may also have written `conflict-hold:#<pr>` onto a held PR's own row earlier in the same pass, before reporting: a token the bot wrote in that pass, never one `reap.sh` writes.",
  "The result file is `<scratch>/pr<pr>/<run>/review.json`, `<run>` the review's own `run-XXXXXXXX` run root.",
  "`token` appends the key to the PR's row and keeps every token already on it, where `row` would replace the whole line.",
  "That key cannot be reconstructed once the head is superseded, so a controller holding only the colour cannot later tell an edge it has already spent from one that never fired.",
  "`token` appends the hold and keeps every token the row already carries, where `row` would replace the whole line.",
  "`closeout.mjs begin` drains (`ledger.mjs drain`), then releases every claim that never became a PR and settles each `impl-<N>=released`. Nothing else in the loop fires for those claims.",
];

for (const sentence of MOVED) {
  test(`moved text is in fleet-event.mjs's header and out of the skill: ${sentence.slice(0, 60)}…`, () => {
    assert.ok(EVENT_HEADER.includes(squash(sentence)), "in the header comment");
    assert.ok(!SKILL_FLAT.includes(squash(sentence)), "not in SKILL.md");
  });
}

// Judgement the skill keeps: the finisher gate's outbox test, never dispatch
// while a reply is owed, the no-op pair, the no-ci case.
for (const kept of [
  "**The outbox is the last test, not the only one, and it stands wherever a fix-applier exists**",
  "so never dispatch off it while you do",
  "**This bullet and the one above are a pair, and on a clean PR this one carries the whole route to a finisher**",
  "**`ci-state.mjs --pr <N>` reads `verdict: \"no-ci\"`**",
]) {
  test(`SKILL.md keeps the judgement: ${kept.slice(0, 60)}…`, () => {
    assert.ok(SKILL_FLAT.includes(squash(kept)));
  });
}

test("SKILL.md states that every wake is one fleet-event.mjs call ending in the tick", () => {
  assert.ok(SKILL_FLAT.includes("every wake is one `fleet-event.mjs` call, which ends in the tick"));
  assert.ok(!SKILL_FLAT.includes("Every wake ends in the tick"));
});

test("the one row for the heartbeat kind is the alarm's, and no other row names that command", () => {
  const rows = wakeTable().filter(([, command]) => command === "`fleet-event.mjs heartbeat`");
  assert.equal(rows.length, 1, "exactly one row for fleet-event.mjs heartbeat");
  assert.equal(rows[0][0], "Alarm (a [fleet-alarm] turn)");
  assert.ok(!wakeTable().some(([wake]) => /^Heartbeat$/.test(wake)), "the old Heartbeat row is gone");
});

test("SKILL.md names the line a marked beat prints, and the old interval line is gone", () => {
  assert.ok(SKILL_FLAT.includes("`… beat marked, alarm due in <N>s (quiet=<n>) → end your turn`"));
  assert.ok(!SKILL_FLAT.includes("interval elapsed"));
});
