// A corpus of ruled Pulls for the split gate's Fit tests: each Pull a ticket-features row with the inputs its ticket held and
// the probability its Cell was assigned with, the admissible implementer row that booked its spend, and the verdict that
// merged it. `corpus` makes the three row lists as metrics-refresh's fixtures write them; `parsed` reads them back as the
// Fit reads the files.
import { COLUMNS as MEMBER_COLUMNS, formatTsv, parseTsv as parseMemberTsv } from "../../plugin/scripts/member-outcomes.mjs";
import { COLUMNS as TIER_COLUMNS, formatRow, parseTierOutcomes } from "../../plugin/scripts/tier-outcomes.mjs";
import { FEATURE_COLUMNS, parseFeatures } from "../../plugin/scripts/pull-attribution.mjs";
import { WINDOW_START } from "../../plugin/scripts/pr-cost.mjs";

/** The day every Pull is dated, the window's first. */
export const DAY = WINDOW_START;
export const SESSION = "2026-10-03T10-00-00-000Z_01a00000-0000-7000-8000-000000000000";
const MODEL_OF = { slow: "claude-opus-5", task: "claude-sonnet-5", smol: "claude-haiku-4-5" };

/**
 * The rows of `specs`, one Pull each: `{ cell, usd, held, prob, merged, failed, ticket, date }`. `usd` is what its
 * implementer cost; `held` amends the features row (the inputs, as strings); `prob` is its `assignment_prob`, "1/2" unless
 * given; a Pull that did not merge ends hollow with no verdict; `failed` makes the verdict a false claim.
 */
export function corpus(specs) {
  const rows = { features: [], members: [], tiers: [] };
  specs.forEach((s, i) => {
    const ticket = String(s.ticket ?? 1000 + i);
    const agent = `impl-${ticket}`;
    const [role, level] = s.cell.split("-");
    const date = s.date ?? DAY;
    const merged = s.merged ?? true;
    const pr = String(Number(ticket) + 5000);
    rows.features.push({
      run_date: date, session: SESSION, agent, ticket, policy_cell: "slow-high", chosen_cell: s.cell, exploration_draw: "",
      sizing_src: "rule", sizing_pre: "", router_usd: "", brief_chars: "100", criteria: "1", comments: "0", age_days: "0",
      paths: "0", test_paths: "0", xrefs: "0", kind: "enhancement", assignment_prob: s.prob ?? "1/2", ...s.held,
    });
    rows.members.push({
      session: SESSION, run_date: date, role: "implementer", member: agent, model: MODEL_OF[role], effort: level, ticket, pr: merged ? pr : "",
      tokensCacheCreate: 0, tokensOut: 0, wallS: 0, turns: 1, agent, harness: "omp", subagentType: `fleet-implementer-${s.cell}`,
      tokensIn: 0, tokensCacheRead: 0, tokensCacheWrite1h: 0, cost: s.usd, ending: merged ? "pr" : "hollow", dispatchModel: MODEL_OF[role], workS: 60,
    });
    if (merged) {
      rows.tiers.push({
        run_date: date, class: "", tier: "", closed_own_ticket: "yes", minted_false_claim: s.failed ? "yes" : "no", note: "n",
        sizing: "light", profile: "small", loc: "10", files: "1", ticket, pr,
      });
    }
  });
  return rows;
}

export const featuresTsv = (rows, cols = FEATURE_COLUMNS) => [cols.join("\t"), ...rows.map((r) => cols.map((c) => r[c] ?? "").join("\t"))].join("\n") + "\n";
export const membersTsv = (rows) => `# ${MEMBER_COLUMNS.join("\t")}\n${rows.length ? formatTsv(rows) : ""}`;
export const tiersTsv = (rows) => `# ${TIER_COLUMNS.join("\t")}\n${rows.map((r) => `${formatRow(r)}\n`).join("")}`;

/** `rows` read as the Fit reads the three files: `{ features, members, verdicts }`, ready for fitTree. */
export const parsed = (rows) => ({
  features: parseFeatures(featuresTsv(rows.features)),
  members: parseMemberTsv(membersTsv(rows.members)),
  verdicts: parseTierOutcomes(tiersTsv(rows.tiers)),
});

/**
 * `n` Pulls of each of slow-high and task-high on each of two sides of `input`, whose values are `sides`; each Cell's $
 * on each side as `[slow, task]`. With the defaults task-high is $4 against $10 on the low side and $14 against $10 on the
 * high side: pooled it is $9, so the one-Cell choice is task-high and the high side would do better on slow-high.
 */
export function flip({ input = "criteria", sides = ["0", "5"], low = [10, 4], high = [10, 14], n = 40, prob = "1/2", held = {} } = {}) {
  const specs = [];
  for (const [side, [slow, task]] of [[sides[0], low], [sides[1], high]]) {
    for (let i = 0; i < n; i++) {
      specs.push({ cell: "slow-high", usd: slow, held: { ...held, [input]: side }, prob });
      specs.push({ cell: "task-high", usd: task, held: { ...held, [input]: side }, prob });
    }
  }
  return specs;
}

/** What the Fit takes of the guard: every starting Cell at `n` merged PRs, nothing tripped. */
export const guardAt = (n = 40, over = {}) => ({ tripped: [], n: { "slow-high": n, "task-high": n, "smol-high": n }, window_start: null, ...over });
