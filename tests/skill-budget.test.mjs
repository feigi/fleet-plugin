// A byte ceiling on the controller runbook and on the two command docs every
// member dispatch carries. Each of them grew one paragraph per incident and
// nothing stopped the next paragraph; this test is the thing that does.
//
// THE MEASUREMENT, taken once and recorded here. omp 18.11.2, 2026-10-16,
// model anthropic/claude-opus-5-5 (what `modelRoles.slow` points at), run as
// `omp -p --mode json --no-session --no-tools --system-prompt x -- <prompt>`
// from a directory outside any checkout:
//   - prompt = SKILL.md (186,100 bytes) + "\n\nReply with the single word ok."
//     -> usage input 4 + cacheWrite 72,983 = 72,987 input tokens
//   - prompt = "Reply with the single word ok." alone
//     -> usage input 4 + cacheWrite 3,824 = 3,828 input tokens
//   SKILL.md alone = 72,987 - 3,828 = 69,159 tokens, so the ratio is
//   186,100 / 69,159 = 2.69 bytes per input token.
// CI has no omp, so the ceilings below are bytes; the ratio converts them.
//
// THE CEILINGS.
//   - SKILL.md: the target is 75,000 bytes (about 28k tokens at 2.69 B/token):
//     the sections the runbook keeps plus the wake-time judgement it absorbs
//     from the sections that move out. The file was 186,100 bytes when this
//     test landed, so the ceiling started at that size rounded up to the next
//     1,000. It only ever comes down, and it is held tight: the file must be
//     at most the ceiling AND less than 1,000 bytes under it. A change that
//     shrinks the file lowers the constant in the same change, so freed
//     headroom cannot be spent on new prose. The ratio is re-measured when
//     the file is compressed, not here.
//   - review-and-fix.md and run-merge-bot.md: their size when this test
//     landed (60,302 and 72,168 bytes) plus ten percent, rounded down. They
//     get no slack rule.
//   - references/*.md and briefs/*.md under run-team carry no ceiling, and
//     this test deliberately reads none of them: they are where text goes
//     when a ceiling here is hit, and the failure messages send it there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const SKILL = "plugin/skills/run-team/SKILL.md";
const MOVE = "move text to references/, do not raise the ceiling";

// [path, ceiling in bytes, whether the ceiling must also be tight].
const SLACK = 1_000;
const CEILINGS = [
  [SKILL, 187_000, true],
  ["plugin/commands/review-and-fix.md", 66_332, false],
  ["plugin/commands/run-merge-bot.md", 79_384, false],
];

const bytesOf = (rel) => readFileSync(join(ROOT, rel));

const message = (rel, ceiling, size, what, advice = MOVE) =>
  `${rel}: ${what} (ceiling ${ceiling} bytes, current size ${size} bytes) — ${advice}`;

// The over-ceiling and slack failures for one file, or null when it fits.
// Pure over the numbers so the reds and the accept half can be fed directly.
function budgetProblem(rel, ceiling, size, tight) {
  if (size > ceiling) return message(rel, ceiling, size, `${size - ceiling} bytes over`);
  if (tight && ceiling - size >= SLACK) {
    const next = Math.ceil(size / 1_000) * 1_000;
    return message(
      rel,
      ceiling,
      size,
      `${ceiling - size} bytes of slack, at most ${SLACK - 1} allowed`,
      `lower the ceiling to ${next}`,
    );
  }
  return null;
}

// The lines SKILL.md may not carry: a blockquote line (`^\s*>`), and a line
// naming a `Measured` result unless the same line points at references/ for
// it. Pure over the text so the accept half can be fed directly.
function offendingLines(text) {
  const out = [];
  text.split("\n").forEach((line, i) => {
    if (/^\s*>/.test(line)) out.push(`line ${i + 1} is a blockquote: ${line.trim()}`);
    else if (line.includes("Measured") && !line.includes("See references/"))
      out.push(`line ${i + 1} carries Measured without a See references/ pointer: ${line.trim()}`);
  });
  return out;
}

for (const [rel, ceiling, tight] of CEILINGS) {
  const rule = tight ? ` and less than ${SLACK} bytes under it` : "";
  test(`${rel} is at most ${ceiling} bytes${rule}`, () => {
    const size = bytesOf(rel).length;
    assert.equal(budgetProblem(rel, ceiling, size, tight), null);
  });
}

test("the slack rule reds a trim that leaves the ceiling, and names the ceiling to lower to", () => {
  const msg = budgetProblem(SKILL, 187_000, 185_999, true);
  assert.match(msg, /^plugin\/skills\/run-team\/SKILL\.md: 1001 bytes of slack/);
  assert.ok(msg.includes("ceiling 187000 bytes, current size 185999 bytes"), msg);
  assert.ok(msg.endsWith("lower the ceiling to 186000"), msg);
  assert.equal(budgetProblem(SKILL, 187_000, 180_100, true).endsWith("lower the ceiling to 181000"), true);
});

test("the over-ceiling rule reds padding past the ceiling, with the move-to-references message", () => {
  assert.equal(
    budgetProblem(SKILL, 187_000, 187_001, true),
    `${SKILL}: 1 bytes over (ceiling 187000 bytes, current size 187001 bytes) — ${MOVE}`,
  );
  assert.notEqual(budgetProblem("plugin/commands/review-and-fix.md", 66_332, 66_333, false), null);
});

test("the slack rule accepts what it must not refuse", () => {
  // At the ceiling, 999 under it, and a size that is itself a multiple of
  // 1,000 with the matching ceiling are all allowed; a file with no slack
  // rule may sit any distance under its ceiling.
  assert.equal(budgetProblem(SKILL, 187_000, 187_000, true), null);
  assert.equal(budgetProblem(SKILL, 187_000, 186_001, true), null);
  assert.equal(budgetProblem(SKILL, 186_000, 186_000, true), null);
  assert.equal(budgetProblem("plugin/commands/review-and-fix.md", 66_332, 1_000, false), null);
});

test(`${SKILL} carries no blockquote line and no Measured line without a See references/ pointer`, () => {
  const buf = bytesOf(SKILL);
  const ceiling = CEILINGS.find(([rel]) => rel === SKILL)[1];
  const bad = offendingLines(buf.toString("utf8"));
  assert.deepEqual(
    bad,
    [],
    message(SKILL, ceiling, buf.length, `forbidden lines:\n  ${bad.join("\n  ")}\n`),
  );
});

test("the line rule accepts what it must not refuse", () => {
  // A `>` that does not open the line, a lowercase "measured", and a
  // Measured line that carries its pointer are all allowed.
  assert.deepEqual(
    offendingLines(
      [
        "a -> b, and x > y mid-line",
        "the measured cost is in the ledger",
        "Measured once per run. See references/ledger.md.",
        "`>` quoted inside code is fine",
      ].join("\n"),
    ),
    [],
  );
});

test("the line rule refuses an indented blockquote and a bare Measured paragraph", () => {
  assert.equal(offendingLines("  > quoted incident\nMeasured: 3 of 4 runs").length, 2);
});
