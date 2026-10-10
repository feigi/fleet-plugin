// Which PR a ledger row is about, read by every reader that keys state to it
// (#2888): the tick's fold, `ledger.mjs`'s PR-bound row lookup and settle
// fold, tier-outcomes' reviewed-PR check, and the cockpit's card. A row
// carrying an `impl-` token is its settled `impl-<N>=PR#<M>` token's PR — a
// prose `PR#` mention never decides it, wherever it sits; a row with no
// `impl-` token keeps its first `PR#` mention, else its key.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rowPr, rowNums } from "../plugin/scripts/ledger-grammar.mjs";
import { parseRow } from "../plugin/scripts/compute-board.mjs";
import { unrecordedReviewedPrs } from "../plugin/scripts/tier-outcomes.mjs";

const LEDGER = fileURLToPath(new URL("../plugin/scripts/ledger.mjs", import.meta.url));

// `own`: the grammar's answer, the row's own PR or null. `keyed`: the PR the
// tick, tier-outcomes and `ledger.mjs` fall back to the row key for. `board`:
// the cockpit card's PR — on an impl row the latest attempt's settled PR,
// never the key.
const FIXTURES = [
  // A prose mention before the settled token must not capture the row...
  { row: "#480 correction: PR#481 was wrong · impl-480=PR#470 · review=wf:a", own: 470, keyed: 470, board: 470 },
  // ...nor one after it.
  { row: "#480 impl-480=PR#470 · review=wf:a · note: the PR#481 guards", own: 470, keyed: 470, board: 470 },
  // A live implementer names no PR of its own: the row is its ticket's.
  { row: "#480 impl-480 · supersedes PR#481", own: null, keyed: 480, board: null },
  // A replacement attempt that opened a second PR is not refused, and each
  // reader resolves it as it did before: the first settled token, the card
  // its latest attempt.
  { row: "#480 impl-480=PR#470 · impl-480-b=PR#471", own: 470, keyed: 470, board: 471 },
  // Rows with no impl token: first mention, else the key.
  { row: "#40 PR#44", own: 44, keyed: 44, board: 44 },
  { row: "#1237 -> PR#1237 · review=member:review-pr-1237", own: 1237, keyed: 1237, board: 1237 },
  { row: "#350 review=wf:x", own: null, keyed: 350, board: 350 },
];

function ledger(t) {
  const dir = mkdtempSync(join(tmpdir(), "row-pr-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const env = { ...process.env, PATH: bin };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  const file = join(dir, "ledger.md");
  return (...args) => {
    const r = spawnSync(process.execPath, [LEDGER, "--file", file, ...args], { encoding: "utf8", env, cwd: dir });
    assert.equal(r.status, 0, `${args.join(" ")}: got exit ${r.status}\n${r.stderr}`);
    return JSON.parse(r.stdout);
  };
}

for (const { row, own, keyed, board } of FIXTURES) {
  test(`every reader names one PR for: ${row}`, (t) => {
    assert.equal(rowPr(row), own, "ledger-grammar rowPr");
    assert.deepEqual(rowNums(row), { keyNum: Number(row.split(" ")[0].slice(1)), pr: keyed }, "ledger-grammar rowNums");
    assert.deepEqual(unrecordedReviewedPrs({ rows: [`${row} reviewed=abc1234:0/0/0:run-abc1234r`] }, []), [keyed], "tier-outcomes");
    assert.equal(parseRow(row).pr, board, "compute-board parseRow");
    // `ledger.mjs dispatch <pr> fix-pr-<pr>` lands on the row the tick folds
    // that PR's state from: this row when it is the PR's, else a row keyed
    // by the PR's own number.
    const cli = ledger(t);
    const key = row.split(" ")[0];
    cli("row", key, row.slice(key.length + 1));
    assert.equal(cli("dispatch", String(keyed), `fix-pr-${keyed}`).ticket, key, "ledger.mjs memberRowIndex");
    for (const other of [481, 471].filter((n) => n !== own && row.includes(`PR#${n}`))) {
      assert.deepEqual(cli("dispatch", String(other), `fix-pr-${other}`), {
        member: `fix-pr-${other}`, agent: null, ticket: `#${other}`, line: `#${other} fix-pr-${other}`, created: true, total: 2,
      }, `PR#${other} is not this row's PR`);
    }
  });
}

// The settle fold's "row already named a PR" guard reads the same
// definition: a live implementer's row whose prose mentions another PR named
// none, so settling it folds the PR's own fallback row in.
test("settle folds the PR's fallback row onto a live implementer's row whose prose mentions another PR", (t) => {
  const cli = ledger(t);
  cli("row", "480", "impl-480 · supersedes PR#481");
  cli("dispatch", "470", "fix-pr-470");
  assert.equal(cli("settle", "impl-480", "PR#470").line, "#480 impl-480=PR#470 · supersedes PR#481 · fix-pr-470");
  assert.deepEqual(cli("read").rows, ["#480 impl-480=PR#470 · supersedes PR#481 · fix-pr-470"]);
});
