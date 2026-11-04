// The Fit's tree (ticket-router.mjs's fitTree): the split gate's verdicts turned into the table `route` walks, over
// fixture corpora of ruled Pulls (tests/support/gate-corpus.mjs) and over this repository's own record.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AttributionError, parseFeatures } from "../plugin/scripts/pull-attribution.mjs";
import { parseTsv as parseMemberTsv } from "../plugin/scripts/member-outcomes.mjs";
import { parseTierOutcomes } from "../plugin/scripts/tier-outcomes.mjs";
import { fitTree, rowFor, stratumOf, validateTable } from "../plugin/scripts/ticket-router.mjs";
import { DAY_ONE_TABLE } from "./support/day-one-router-table.mjs";
import { corpus, flip, guardAt, parsed } from "./support/gate-corpus.mjs";

const fit = (specs, { previous = null, guard = guardAt(), prior = DAY_ONE_TABLE, rows = corpus(specs) } = {}) =>
  fitTree({ prior, ...parsed(rows), guard, previous });
// The features row a ticket would write: the inputs it holds as strings, `brief_chars` blank when its issue was not read.
const ticket = (over = {}) => ({ brief_chars: "100", criteria: "", paths: "", comments: "0", age_days: "0", test_paths: "0", xrefs: "0", kind: "bug", parent: "", dirs: "", ...over });

test("the first pass of a split is only kept: the tree stays the one node, and the gate records what it will be read for", () => {
  const { table, gate } = fit(flip());
  assert.deepEqual(table.splits, {});
  assert.deepEqual(table.rows.cost, { "*": "slow-high" });
  assert.deepEqual([gate.scored, gate.left_out, gate.passed], [160, 0, ["criteria"]]);
  assert.deepEqual(gate.best.cuts, [{ input: "criteria", cut: 0 }]);
  assert.deepEqual([gate.best.gain, gate.best.passes_null, gate.best.passes_bound, gate.best.exceeded], [2, true, true, 0]);
  assert.ok(gate.best.lower_bound > 1.5, `${gate.best.lower_bound}`);
});

test("a split that passed at the last Fit and passes now stands: two groups, each with its own cost and speed row", () => {
  const first = fit(flip());
  // The next Fit's records hold more Pulls: one over the same records would be no look (below).
  const { table, gate } = fit(flip({ n: 41 }), { previous: first.gate });
  assert.deepEqual(table.splits, { "*": { input: "criteria", cut: 0 } });
  assert.equal(validateTable(table) instanceof Error, false, "route reads it through validateTable");
  // The low side takes task-high at $4 against $10; the high side leaves it at $14, and the root at $9 does not beat 0.75 x $10.
  assert.deepEqual(table.rows.cost, { "*": "slow-high", "criteria>0": "slow-high", "criteria<=0": "task-high" });
  assert.deepEqual(Object.keys(table.rows.speed).sort(), ["*", "criteria<=0", "criteria>0"]);
  assert.deepEqual(Object.keys(table.estimates).sort(), ["*", "criteria<=0", "criteria>0"]);
  assert.deepEqual(gate.passed, ["criteria"], "kept for the next Fit, which a standing split must pass again");
});

test("a Fit over the records the last one searched is no look: a first pass does not stand on it, and a split that stands stays", () => {
  const rows = corpus(flip());
  const first = fit(null, { rows });
  const again = fit(null, { rows, previous: first.gate });
  assert.equal(again.gate.records, first.gate.records, "the same Cells and Pulls searched");
  assert.deepEqual([again.table.splits, again.gate.passed, again.gate.stands], [{}, ["criteria"], []], "one pass looked at twice is still one pass");
  const grown = corpus(flip({ n: 41 }));
  const second = fit(null, { rows: grown, previous: again.gate });
  assert.notEqual(second.gate.records, first.gate.records);
  assert.deepEqual([second.table.splits, second.gate.stands], [{ "*": { input: "criteria", cut: 0 } }, ["criteria"]], "a pass over other records is the second look");
  const repeat = fit(null, { rows: grown, previous: second.gate });
  assert.deepEqual([repeat.table.splits, repeat.gate.passed, repeat.gate.stands], [second.table.splits, ["criteria"], ["criteria"]], "looking again at what a split stood on does not merge it back");
});

test("a cut that moved with the percentiles between two Fits is the same split: the count stands on the input, and the tree takes the new cut", () => {
  // `paths` 1 .. N, one Pull each, task-high $4 up to the median and $14 above it, slow-high $10: the best cut is the median's.
  const ramp = (size) => Array.from({ length: size }, (_, i) => ({ cell: i % 2 ? "slow-high" : "task-high", usd: i % 2 ? 10 : i + 1 <= size / 2 ? 4 : 14, held: { paths: String(i + 1) } }));
  const first = fit(ramp(200));
  assert.deepEqual([first.gate.best.cuts, first.gate.passed, first.table.splits], [[{ input: "paths", cut: 100 }], ["paths"], {}]);
  const second = fit(ramp(240), { previous: first.gate });
  assert.deepEqual(second.table.splits, { "*": { input: "paths", cut: 120 } }, "the cut moved from 100 to 120 and the count did not start again");
  // Another input at the second Fit would have: criteria 1 .. N in place of paths.
  const other = fit(ramp(240).map((s) => ({ ...s, held: { criteria: s.held.paths } })), { previous: first.gate });
  assert.deepEqual([other.table.splits, other.gate.passed], [{}, ["criteria"]]);
});

test("a pass on other inputs than the last Fit's does not stand, and its own count starts", () => {
  const { table, gate } = fit(flip(), { previous: { passed: ["paths"] } });
  assert.deepEqual(table.splits, {});
  assert.deepEqual(gate.passed, ["criteria"]);
  // One input is not the pair that holds it.
  assert.deepEqual(fit(flip(), { previous: { passed: ["criteria+paths"] } }).table.splits, {});
});

test("a standing split merges back at the first Fit it fails: no tree, nothing kept", () => {
  const flat = flip({ low: [10, 7], high: [10, 7] });
  const { table, gate } = fit(flat, { previous: { passed: ["criteria"] } });
  assert.deepEqual(table.splits, {}, "the tree the last Fit held is not carried");
  assert.deepEqual(table.rows.cost, { "*": "task-high" });
  assert.equal(gate.best, null);
  assert.deepEqual(gate.passed, []);
  // Passing the null alone is a failure as well: eight of the high side's task-high Pulls were drawn at 1 in 200, and
  // their $0.50 above or below their mean, weighed by 200, swamp the bound.
  const nth = {};
  const rare = flip().map((s) => {
    const k = `${s.cell}/${s.held.criteria}`;
    nth[k] = (nth[k] ?? -1) + 1;
    return { ...s, usd: s.usd + (nth[k] % 2 === 0 ? 0.5 : -0.5), prob: k === "task-high/5" && nth[k] < 8 ? "1/200" : s.prob };
  });
  const half = fit(rare, { previous: { passed: ["criteria"] } });
  assert.deepEqual([half.gate.best.passes_null, half.gate.best.passes_bound], [true, false]);
  assert.deepEqual([half.table.splits, half.gate.passed], [{}, []]);
});

test("a gate record that is not a list of keys is no previous pass", () => {
  for (const previous of [undefined, null, {}, { passed: "criteria" }, { passed: [1, null] }, { passed: [{ key: "criteria" }] }]) {
    assert.deepEqual(fit(flip(), { previous }).table.splits, {}, JSON.stringify(previous));
  }
});

test("a Pull that records no assignment probability is left out and counted, never read as certain", () => {
  // A record written before the column: the whole corpus is left out, so there is nothing to search.
  const none = fit(flip({ prob: "" }), { previous: { passed: ["criteria"] } });
  assert.deepEqual([none.gate.scored, none.gate.left_out, none.gate.best, none.gate.passed], [0, 160, null, []]);
  assert.deepEqual(none.table.splits, {});
  assert.equal(none.table.n_rows, 160, "they are still the fit's Pulls: the rows judge them");
  // Half the Pulls, the low side's: the scored ones have no flip.
  const half = flip().map((s) => (s.held.criteria === "0" ? { ...s, prob: "" } : s));
  const some = fit(half);
  assert.deepEqual([some.gate.scored, some.gate.left_out, some.gate.best], [80, 80, null]);
});

test("an assignment probability that is no probability is refused, naming the ticket", () => {
  for (const bad of ["0", "3/2", "x", "1/0", "0.5", "1/2 "]) {
    const specs = flip();
    specs[0].prob = bad;
    assert.throws(() => fit(specs), (e) => e instanceof AttributionError && /ticket #1000: .*assignment_prob is '.*', expected blank or a probability/.test(e.message), bad);
  }
});

test("the gate reads every input it searches on every Pull it scores: a corrupt count is refused, a corrupt one on a left-out Pull is not read", () => {
  const corrupt = flip();
  corrupt[3].held = { ...corrupt[3].held, comments: "12x" };
  assert.throws(() => fit(corrupt), (e) => e instanceof AttributionError && /ticket #1003.*comments is '12x'/.test(e.message));
  corrupt[3].prob = "";
  assert.equal(fit(corrupt).gate.left_out, 1);
});

test("a Cell the guard has tripped is no choice, and its Pulls are not scored", () => {
  const { gate } = fit(flip(), { guard: guardAt(40, { tripped: ["task-high"] }) });
  assert.deepEqual([gate.scored, gate.best], [80, null], "only slow-high's Pulls: the default Cell alone has nothing to choose");
});

test("the tree reaches two inputs, each node its own row, and a ticket lacking the second input stops at the node of the first", () => {
  // Task-high is $4 on three corners of `criteria` x `paths` and $20 on the fourth; slow-high is $10 throughout.
  const corners = (each) => {
    const specs = [];
    for (const criteria of ["0", "5"]) {
      for (const paths of ["0", "5"]) {
        for (let i = 0; i < each; i++) {
          for (const [cell, usd] of [["slow-high", 10], ["task-high", criteria === "5" && paths === "5" ? 20 : 4]]) specs.push({ cell, usd, held: { criteria, paths } });
        }
      }
    }
    return specs;
  };
  const first = fit(corners(30));
  assert.deepEqual(first.gate.passed, ["criteria+paths"]);
  const { table } = fit(corners(31), { previous: first.gate });
  assert.deepEqual(table.splits, {
    "*": { input: "criteria", cut: 0 },
    "criteria>0": { input: "paths", cut: 0 },
    "criteria<=0": { input: "paths", cut: 0 },
  }, "depth two: a split at the root and one at each of its children, never a third level");
  assert.equal(validateTable(table) instanceof Error, false);
  assert.deepEqual(table.rows.cost, {
    "*": "slow-high", "criteria>0": "slow-high", "criteria<=0": "task-high",
    "criteria>0&paths>0": "slow-high", "criteria>0&paths<=0": "task-high", "criteria<=0&paths>0": "task-high", "criteria<=0&paths<=0": "task-high",
  });
  const route = (t) => rowFor(table.rows.cost, stratumOf(table, t));
  assert.equal(stratumOf(table, ticket({ criteria: "5", paths: "5" })), "criteria>0&paths>0");
  assert.equal(route(ticket({ criteria: "5", paths: "5" })), "slow-high");
  assert.equal(route(ticket({ criteria: "5", paths: "0" })), "task-high");
  // The ticket that lacks `paths` follows the row of the node its first split sent it to; one lacking `criteria` the root's.
  assert.equal(stratumOf(table, ticket({ criteria: "5", paths: "" })), "criteria>0");
  assert.equal(route(ticket({ criteria: "5", paths: "" })), table.rows.cost["criteria>0"]);
  assert.equal(stratumOf(table, ticket({ criteria: "", paths: "5" })), "*");
  assert.equal(route(ticket({ criteria: "", paths: "5" })), table.rows.cost["*"]);
  // A ticket whose issue was not read holds no input at all.
  assert.equal(stratumOf(table, ticket({ brief_chars: "", criteria: "5", paths: "5" })), "*");
});

test("`kind` is cut on its value and `parent` on its presence, and each makes a tree the validator accepts", () => {
  const onKind = corpus(flip({ input: "kind", sides: ["enhancement", "bug"] }));
  const kind = fit(null, { rows: onKind, previous: { passed: ["kind"] } });
  assert.deepEqual(kind.table.splits, { "*": { input: "kind", cut: "bug" } }, "the first value that gains the most: bug against the rest");
  assert.equal(validateTable(kind.table) instanceof Error, false);
  assert.equal(stratumOf(kind.table, ticket({ kind: "bug", criteria: "" })), "kind=bug");
  assert.equal(stratumOf(kind.table, ticket({ kind: "enhancement" })), "kind!=bug");
  assert.equal(stratumOf(kind.table, ticket({ kind: "" })), "*", "a ticket with no kind label lacks the input");
  const onParent = corpus(flip({ input: "parent", sides: ["", "3177"] }));
  const parent = fit(null, { rows: onParent, previous: { passed: ["parent"] } });
  assert.deepEqual(parent.table.splits, { "*": { input: "parent", cut: 0 } });
  assert.equal(validateTable(parent.table) instanceof Error, false);
  assert.equal(stratumOf(parent.table, ticket({ parent: "3177" })), "parent>0");
  assert.equal(stratumOf(parent.table, ticket({ parent: "" })), "parent<=0", "a Slice's parent is read where the issue was read; none is zero");
});

test("a column that does not exist in the record is no input: rows written before `dirs` have none, and `dirs` is no cut of its own", () => {
  // Half the corpus carries `dirs`, split 20/20 at 1 (so a cut at 1 holds 80/80 of them) and flipping; the other half
  // predates the column. The gate searches `dirs` on the Pulls that hold it and `criteria`, constant, not at all.
  const specs = flip({ input: "dirs", sides: ["1", "5"] });
  const old = flip({ input: "criteria", sides: ["1", "1"] }).map((s) => ({ ...s, held: { criteria: "1" } }));
  const rows = corpus([...specs, ...old.map((s) => ({ ...s, usd: 7 }))]);
  const { gate } = fit(null, { rows });
  assert.deepEqual(gate.best.cuts.map((c) => c.input), ["dirs"]);
  assert.equal(gate.scored, 320);
});

test("the same records and the same previous Fit give the same Fit", () => {
  const rows = corpus(flip());
  const previous = { passed: ["criteria"] };
  assert.deepEqual(fit(null, { rows, previous }), fit(null, { rows, previous }));
});

// ---------------------------------------------------------------------------
// this repository's record
// ---------------------------------------------------------------------------

const metrics = (name) => readFileSync(new URL(`../docs/metrics/${name}`, import.meta.url), "utf8");

test("on this repository's 268 Pulls nothing splits, and no split so much as passes once", () => {
  // The 268 Pulls the record held when the gate was measured; later rows are later Pulls. Every one was a burn-in draw
  // over the K Cells its `exploration_draw` names, so its Cell was assigned with probability 1/K — the record predates
  // the column that says so.
  const features = parseFeatures(metrics("ticket-features.tsv")).slice(0, 268).map((r) => ({ ...r, assignment_prob: `1/${r.exploration_draw.split("/")[1]}` }));
  assert.equal(features.length, 268);
  assert.equal(features.at(-1).run_date, "2026-10-30", "the last of the 268");
  assert.ok(features.every((r) => /^[1-9]\/[1-9]$/.test(r.exploration_draw)), "every row is a draw");
  const guard = { tripped: [], n: { "slow-high": 104, "task-high": 104, "smol-high": 59 }, window_start: "2026-10-03" };
  const members = parseMemberTsv(metrics("member-outcomes.tsv"));
  const verdicts = parseTierOutcomes(metrics("tier-outcomes.tsv"));
  // Even handed a previous Fit that passed on every input the search reads, nothing stands: nothing passes.
  const everything = ["brief_chars", "criteria", "comments", "age_days", "paths", "test_paths", "xrefs", "kind", "parent", "dirs"];
  const { table, gate } = fitTree({ prior: DAY_ONE_TABLE, features, members, verdicts, guard, previous: { passed: everything } });
  assert.equal(table.n_rows, 268);
  assert.deepEqual(table.splits, {}, "the fitted tree is the one-node tree");
  assert.deepEqual([gate.left_out, gate.passed], [0, []]);
  assert.ok(gate.scored > 200, `${gate.scored}`);
  assert.equal(gate.best === null || (gate.best.passes_null && gate.best.passes_bound), false, JSON.stringify(gate.best));
});
