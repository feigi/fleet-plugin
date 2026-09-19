import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRole, computeSpend, attributeTools, mergeTools } from "./compute-spend.mjs";

const agent = (o) => ({ label: "x", role: "other", cacheWrite: 0, output: 0, cacheRead: 0, maxCtx: 0, ...o });

const call = (id, name, cacheWrite = 0) => ({ kind: "assistant", cacheWrite, tools: [{ id, name }] });
const result = (...rs) => ({ kind: "result", results: rs.map(([id, chars]) => ({ id, chars })) });

test("a tool result's cost is the NEXT assistant turn's cache write, not its own turn's", () => {
  // The turn that CALLS a tool has not seen the result yet, so charging it there
  // would credit the cost to whatever the agent happened to do beforehand.
  const tools = attributeTools([
    call("t1", "Bash", 100),
    result(["t1", 500]),
    { kind: "assistant", cacheWrite: 900, tools: [] },
  ]);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].tool, "Bash");
  assert.equal(tools[0].cacheWrite, 900);
  assert.equal(tools[0].resultChars, 500);
  assert.equal(tools[0].calls, 1);
});

test("a multi-result turn splits proportionally by result size", () => {
  const tools = attributeTools([
    { kind: "assistant", cacheWrite: 0, tools: [{ id: "a", name: "Read" }, { id: "b", name: "Grep" }] },
    result(["a", 750], ["b", 250]),
    { kind: "assistant", cacheWrite: 1000, tools: [] },
  ]);
  const by = Object.fromEntries(tools.map((t) => [t.tool, t.cacheWrite]));
  assert.equal(by.Read, 750);
  assert.equal(by.Grep, 250);
});

test("CONSECUTIVE result turns accumulate — that, not the multi-block turn, is the real shape", () => {
  // Regression. Parallel tool calls do NOT arrive as one user turn carrying two
  // tool_result blocks: across 45,062 real result-bearing turns, none carried
  // two. They arrive as N single-result turns in a row (4,087 occurrences).
  // Replacing `pending` per result turn dropped every batch but the last —
  // 9.1% of all attributions — and made the proportional split above dead code.
  const tools = attributeTools([
    { kind: "assistant", cacheWrite: 0, tools: [{ id: "a", name: "Read" }, { id: "b", name: "Grep" }] },
    result(["a", 750]),
    result(["b", 250]),
    { kind: "assistant", cacheWrite: 1000, tools: [] },
  ]);
  const by = Object.fromEntries(tools.map((t) => [t.tool, t.cacheWrite]));
  assert.equal(by.Read, 750);
  assert.equal(by.Grep, 250);
});

test("an all-empty result batch still splits evenly rather than vanishing", () => {
  // A tool that returns nothing still costs a turn to process; dropping it would
  // silently under-report the cheap-but-chatty tools.
  const tools = attributeTools([
    { kind: "assistant", cacheWrite: 0, tools: [{ id: "a", name: "Read" }, { id: "b", name: "Grep" }] },
    result(["a", 0], ["b", 0]),
    { kind: "assistant", cacheWrite: 400, tools: [] },
  ]);
  const by = Object.fromEntries(tools.map((t) => [t.tool, t.cacheWrite]));
  assert.equal(by.Read, 200);
  assert.equal(by.Grep, 200);
});

test("a result whose tool_use id was never seen is counted as unknown, not dropped", () => {
  const tools = attributeTools([result(["orphan", 100]), { kind: "assistant", cacheWrite: 50, tools: [] }]);
  assert.equal(tools[0].tool, "unknown");
  assert.equal(tools[0].cacheWrite, 50);
});

test("a trailing result with no following assistant turn costs nothing but is still counted", () => {
  // Truncated transcripts are normal — an agent killed mid-turn. The call and the
  // bytes are real; the cache write never happened, so attributing one would invent spend.
  const tools = attributeTools([call("t1", "Bash", 0), result(["t1", 900])]);
  assert.equal(tools[0].calls, 1);
  assert.equal(tools[0].resultChars, 900);
  assert.equal(tools[0].cacheWrite, 0);
});

test("mergeTools sums across agents and recomputes shares over the merged total", () => {
  const merged = mergeTools([
    [{ tool: "Bash", calls: 2, resultChars: 100, cacheWrite: 300, pct: 100 }],
    [{ tool: "Bash", calls: 1, resultChars: 50, cacheWrite: 100, pct: 50 },
     { tool: "Read", calls: 4, resultChars: 20, cacheWrite: 100, pct: 50 }],
  ]);
  const by = Object.fromEntries(merged.map((t) => [t.tool, t]));
  assert.equal(by.Bash.calls, 3);
  assert.equal(by.Bash.cacheWrite, 400);
  assert.equal(by.Bash.resultChars, 150);
  assert.equal(by.Read.pct, 20);
  assert.equal(merged[0].tool, "Bash"); // sorted by spend
});

test("depth beats description for review-shaped names — fan-out is not reviewer spend", () => {
  // The fan-out names grandchildren things like "Review PR 539 correctness".
  // Matching description first would book half the specialist spend as reviewer
  // spend and destroy the only number that matters.
  assert.equal(classifyRole({ spawnDepth: 1, description: "Review PR 539 correctness" }), "specialist");
  assert.equal(classifyRole({ spawnDepth: 2, description: "Implement ticket 540" }), "specialist");
});

test("the controller's own UNNAMED dispatches are depth 1 too — sizing is not fan-out", () => {
  // Regression: only NAMED members are depth 0. The phase-0 sizing agents are
  // dispatched straight from the controller but unnamed, so they arrive at
  // depth 1 looking exactly like a specialist. Classifying on depth alone put
  // all five in "specialist" and moved the review headline from 83% to 87%.
  assert.equal(classifyRole({ spawnDepth: 1, description: "Size candidate batch A" }), "sizing");
  assert.equal(classifyRole({ spawnDepth: 1, description: "Size ticket 531" }), "sizing");
});

test("the sizing pattern is anchored, so a specialist that mentions sizing stays a specialist", () => {
  assert.equal(classifyRole({ spawnDepth: 1, description: "Review PR 539 — check batch sizing logic" }), "specialist");
});

test("the memory exclusion reads the recorded DEFINITION, so any member name books memory", () => {
  // #1505. The exclusion used to test the one `agentType` parameter, which the
  // Claude reader filled with the member's NAME — so the same dispatch
  // (`memory-housekeeper`) booked three different roles depending on what it
  // was called: `memory-housekeeper` memory, `housekeeper` other,
  // `brain-housekeeping` specialist. Measured on the corpus that last one alone
  // moved its session's review-spend headline 40.70% -> 62.37%.
  // "brain-housekeeping" is the historical incident (#1505) and the only name
  // of the four originally listed here that a mutation pass found load-bearing:
  // it is the one whose NAME does not itself contain "memory-housekeeper", so
  // it is the one that would slip to "specialist" if the exclusion ever read
  // the member's NAME instead of its recorded DEFINITION.
  assert.equal(
    classifyRole({ agentDefinition: "memory-housekeeper", memberName: "brain-housekeeping", spawnDepth: 1, description: "Housekeep the brain" }),
    "memory",
  );
  // Depth 1 above is the load-bearing half: the specialist rule is what caught
  // `brain-housekeeping`, so this stays red if the exclusion moves below it.
  assert.equal(classifyRole({ agentDefinition: "memory-proxy", memberName: "review-eval", spawnDepth: 2 }), "memory");
});

test("an untyped dispatch that recorded no definition still classifies by its NAME", () => {
  // #1505's other half. A dispatch before typed agents existed records no
  // definition at all — a closed category, not a hole — so the name is the only
  // memory signal those members have. Measured over the sidecars on disk: three
  // live members rest on this, and dropping it would put `memory-housekeeper`
  // (named for its own definition, at depth 1) in the SPECIALIST bucket, which
  // is the very defect #1505 reports.
  assert.equal(classifyRole({ agentDefinition: "", memberName: "memory-proxy-session-review-2-3" }), "memory");
  assert.equal(classifyRole({ agentDefinition: "", memberName: "memory-housekeeper", spawnDepth: 1 }), "memory");
  // ...and it is still not a guess: a name carrying no memory agent falls
  // through to the ordinary signals rather than being read as memory-adjacent.
  assert.equal(classifyRole({ agentDefinition: "", memberName: "impl-1505", description: "Implement ticket 1505" }), "implementer");
});

test("a memory agent named only in the dispatch PROSE does not book memory", () => {
  // The false-positive half, and the reason `desc` is excluded from the
  // exclusion's input: every memory-adjacent fleet member's own prompt names
  // the memory agents, so blending prose would book the lot of them memory and
  // quietly drain the buckets anyone reads.
  assert.equal(classifyRole({ description: "Relay the finding to memory-proxy, then finish PR 563" }), "finisher");
  assert.equal(classifyRole({ memberName: "fix-pr-1505", description: "Fix PR 1505 — memory-housekeeper writes the wrong scope" }), "reviewer");
  assert.equal(classifyRole({ description: "Ask memory-housekeeper about it", spawnDepth: 1 }), "specialist");
});

test("depth-0 fleet roles come off the controller's naming convention", () => {
  assert.equal(classifyRole({ spawnDepth: 0, description: "Implement ticket 556" }), "implementer");
  assert.equal(classifyRole({ spawnDepth: 0, description: "Review PR 564" }), "reviewer");
  assert.equal(classifyRole({ spawnDepth: 0, description: "Finish PR 563" }), "finisher");
  assert.equal(classifyRole({ spawnDepth: 0, description: "Merge wave 7 — final" }), "merge-bot");

  assert.equal(classifyRole({ spawnDepth: 0, description: "something else entirely" }), "other");
});

test("the NAME wins over an earlier-checked prose keyword — the fixed branch order must not let description hijack a name-resolved role (#1506)", () => {
  // Blending `${memberName} ${description}` into one haystack before running
  // classifyRole's fixed-order branches (implementer -> reviewer -> finisher
  // -> merge-bot) let a member's own free-text description satisfy an
  // EARLIER branch than the one its canonical NAME would hit, hijacking the
  // classification. Measured live: `finisher-1380` described as "Fix PR 1380
  // review findings." matched the reviewer branch on "review" in the prose
  // before the finisher branch ever saw the name; `merge-bot-12` described
  // with "...review findings" misread the same way as finisher. The name
  // must be checked alone, ahead of the blend.
  assert.equal(
    classifyRole({ memberName: "finisher-1380", description: "Fix PR 1380 review findings." }),
    "finisher",
  );
  assert.equal(
    classifyRole({ memberName: "merge-bot-12", description: "Finish PR 1420, apply the review findings" }),
    "merge-bot",
  );
  // Control: a member with NO canonical name still falls through to the
  // prose blend exactly as before — this fix only reorders, it does not
  // remove the description-only fallback.
  assert.equal(classifyRole({ description: "Fix PR 1380 review findings." }), "reviewer");
});

test("finish-<n> member names classify as finisher — a historical spelling that must stay classifiable", () => {
  // `finisher-pr-<n>` is the canonical finisher name (#326); `finish-<n>` is a
  // spelling earlier runs actually dispatched and recorded runs still have to
  // classify. The match has to come off the member NAME, not the literal words
  // "finish pr" or "finisher": the description deliberately does NOT start with
  // `finish-`, so an implementation keying on `description` alone fails here.
  assert.equal(classifyRole({ memberName: "finish-436", description: "Apply reviewer findings for PR 436" }), "finisher");
  // ...and the `^` has to be a real anchor: `finish-` mid-string is not a
  // finisher. Without this, dropping the anchor leaves the case above green.
  assert.equal(classifyRole({ spawnDepth: 0, description: "Rework the finish-label docs" }), "other");
  // A two-ticket finisher was dispatched as `finish-<n>-<m>`, so the pattern has
  // to match on the prefix rather than on a `finish-<digits>` shape. Its
  // description carries no finisher word either, for the same reason as above.
  assert.equal(classifyRole({ spawnDepth: 0, memberName: "finish-424-425", description: "Apply reviewer findings for PR 424 and 425" }), "finisher");
});

test("missing meta never throws — a transcript with no sibling .meta.json still counts", () => {
  assert.equal(classifyRole(undefined), "other");
  assert.equal(classifyRole({}), "other");
});

test("implementers classify off the member NAME, which is where `impl-` actually appears", () => {
  // `^impl-` is anchored against `${memberName} ${description}`, so it only ever
  // fires via the name. Pin that coupling — the description alone never matches.
  // It is the NAME and not the definition on purpose: `impl-332` is what the
  // controller called the member, never an agent definition that exists (#1505).
  assert.equal(classifyRole({ spawnDepth: 0, memberName: "impl-332", description: "whatever" }), "implementer");
  assert.equal(classifyRole({ spawnDepth: 0, agentDefinition: "impl-332", description: "whatever" }), "other");
});

test("the omp review fan-out classifies off its agent DEFINITION — depth cannot reach it there", () => {
  // The depth check above books Claude's fan-out, whose specialists are the
  // reviewer's grandchildren. omp has no such nesting: its review path runs
  // `review-eval.mjs` inside the CONTROLLER's own session, so every fan-out
  // member arrives at depth 0 and falls through to the description patterns —
  // which is the exact "Review PR 539 correctness" misread the depth check
  // exists to prevent. Measured 2026-09-16 over the live corpus: 466 of 477
  // `fleet-review-*` rows sit at depth 0, and one definition
  // (`fleet-review-verifier`) split across four buckets — 211 other, 172
  // reviewer, 20 finisher, 2 merge-bot — on nothing but prompt wording.
  assert.equal(classifyRole({ spawnDepth: 0, agentDefinition: "fleet-review-verifier", description: "Refute finding unv1 on PR 1353" }), "specialist");
  assert.equal(classifyRole({ spawnDepth: 0, agentDefinition: "fleet-review-correctness", description: "Review PR 1353 correctness" }), "specialist");
  assert.equal(classifyRole({ spawnDepth: 0, agentDefinition: "fleet-review-snapshot", description: "Cut the snapshot for PR 1353" }), "specialist");
  // A dispatch may write the `fleet-ctl:`-prefixed spelling (run-team's Phase 2
  // does) even though every sidecar on disk records the bare name — the same
  // tolerance member-outcomes.tsv's own pair query is written with.
  assert.equal(classifyRole({ spawnDepth: 0, agentDefinition: "fleet-ctl:fleet-review-tests", description: "whatever" }), "specialist");
  // And the definition is the ONLY thing these two branches read: a member
  // merely NAMED after a review definition was not dispatched as one (#1505).
  assert.equal(classifyRole({ spawnDepth: 0, memberName: "fleet-review-verifier", description: "whatever" }), "other");
  // The bare-name case above cannot catch a blend regression: an empty `def`
  // puts a SPACE, not a `:`, in front of a bare member name, so `(^|:)` fails
  // either way and the assertion passes whether the branch reads `def` alone
  // or the `${def} ${name}` blend. The `fleet-ctl:`-prefixed spelling above
  // is what discriminates when used as the NAME instead of the DEFINITION:
  // blending puts its own `:` in front of `fleet-review-`, so a branch that
  // reads the blend wrongly matches and returns "specialist" here, while the
  // real `def`-only branch still returns "other" (measured: reverting to the
  // blend keeps the rest of this suite green).
  assert.equal(classifyRole({ spawnDepth: 0, memberName: "fleet-ctl:fleet-review-tests", description: "whatever" }), "other");
});

test("a definition name in the dispatch PROSE is not a dispatch — the fleet branches read `def` alone", () => {
  // The false-positive half. Every fleet member's own prompt says what it is, so
  // these names appear in description text constantly; matching the
  // `${memberName} ${description}` blend would book a finisher that merely
  // mentions the review fan-out as one of its specialists.
  //
  // The cases below are written in the `fleet-ctl:`-PREFIXED spelling on
  // purpose. A prose mention in the bare spelling cannot reach either pattern
  // anyway — `hay` starts with a space when `memberName` is blank, so neither
  // `^` nor `:` sits in front of it — which means a bare-name test passes even
  // against a `hay`-matching implementation and proves nothing. The prefixed
  // spelling is the one every dispatch instruction in run-team's own prose is
  // written in, so it is both the realistic prose shape and the one that
  // discriminates.
  assert.equal(classifyRole({ spawnDepth: 0, description: "Relay the report to fleet-ctl:fleet-review-verifier" }), "other");
  assert.equal(classifyRole({ spawnDepth: 0, description: "Dispatch every implementer as fleet-ctl:fleet-implementer" }), "other");
  // And the control that must stay GREEN: prose-only input still classifies by
  // its prose, so this narrowing did not cost the description patterns anything.
  assert.equal(classifyRole({ spawnDepth: 0, description: "Apply fleet-review-verifier findings, then finish PR 563" }), "finisher");
});

test("the fleet implementer definitions classify as implementer, independent of the `^impl-` name pattern", () => {
  // `agentDefinition`-based classification (`fleet-implementer(-alt)`) is
  // checked BEFORE the `^impl-` name/description pattern below it, so it must
  // not depend on a Claude-shaped member name to fire — this pin exercises
  // classifyRole directly, on `agentDefinition` alone, so it stays green
  // whatever either reader hands `memberName`.
  //
  // Historically this was the ONLY implementer signal an omp member had:
  // before #1486, `agentDefinition` did not reach classifyRole from omp at
  // all, and before #1506, `memberName` did not either — readOmpMember left
  // it unset on the theory that the AgentId is a generated CamelCase word
  // pair naming nothing. #1506 closed that: a canonically-named omp member
  // (`impl-<n>`) now reaches `^impl-` too, through `memberName`, exactly like
  // this branch already reaches it through `agentDefinition`. Measured
  // 2026-09-16 before #1486's branch: 90 omp fleet-implementer/-alt rows
  // split 73 other, 7 merge-bot, 5 finisher, 5 reviewer, none of them
  // implementer, while the same definition booked implementer on all 109
  // Claude rows.
  assert.equal(classifyRole({ spawnDepth: 0, agentDefinition: "fleet-implementer", description: "Ticket #1486. Worktree: .worktrees/1486-classify" }), "implementer");
  assert.equal(classifyRole({ spawnDepth: 0, agentDefinition: "fleet-implementer-alt", description: "Ticket #1486. Worktree: .worktrees/1486-classify" }), "implementer");
  assert.equal(classifyRole({ spawnDepth: 0, agentDefinition: "fleet-ctl:fleet-implementer-alt", description: "whatever" }), "implementer");
  // EXACT, unlike the review prefix above: the alternate-tier pairing is closed
  // at these two names, so a third `fleet-implementer-`-prefixed definition is a
  // deliberate addition and not something to classify in advance.
  assert.equal(classifyRole({ spawnDepth: 0, agentDefinition: "fleet-implementer-probe", description: "whatever" }), "other");
});

test("depth still outranks the definition — a fleet member's own fan-out is not another implementer", () => {
  // Ordering pin. Both new branches sit BEHIND the depth check, so a child an
  // implementer dispatched is the specialist it structurally is rather than
  // inheriting its parent's definition. Move either branch above the depth
  // check and this goes red.
  assert.equal(classifyRole({ spawnDepth: 1, agentDefinition: "fleet-implementer", description: "whatever" }), "specialist");
  // And memory still outranks both, which is the rule that keeps memory-system
  // work out of review spend.
  assert.equal(classifyRole({ spawnDepth: 0, agentDefinition: "memory-proxy", description: "Review PR 1353 correctness" }), "memory");
});

test("a role outside ROLE_ORDER is still reported, so percentages sum to 100", () => {
  // Regression: roles were built by mapping over ROLE_ORDER, so an unknown role
  // vanished from the table while its tokens stayed in totals — the column
  // silently stopped summing to 100 and the run read as cheaper than it was.
  const { roles, totals } = computeSpend({
    agents: [agent({ role: "weird", cacheWrite: 500 }), agent({ role: "reviewer", cacheWrite: 500 })],
  });
  assert.equal(totals.cacheWrite, 1000);
  assert.deepEqual(roles.map((r) => r.role).sort(), ["reviewer", "weird"]);
  assert.equal(roles.reduce((n, r) => n + r.pct, 0), 100);
});

test("percentages are of cache_creation, not of raw tokens", () => {
  // cacheRead is deliberately lopsided here: if it leaked into the ranking or
  // the percentage base, the implementer would outrank the reviewer.
  const { roles, totals } = computeSpend({
    agents: [
      agent({ role: "reviewer", cacheWrite: 300, cacheRead: 10 }),
      agent({ role: "implementer", cacheWrite: 100, cacheRead: 9_000_000 }),
    ],
  });
  assert.equal(roles[0].role, "reviewer");
  assert.equal(roles[0].pct, 75);
  assert.equal(roles[1].pct, 25);
  assert.equal(totals.cacheRead, 9_000_010);
});

test("reviewPct sums specialists and reviewers", () => {
  const { reviewPct } = computeSpend({
    agents: [
      agent({ role: "specialist", cacheWrite: 470 }),
      agent({ role: "reviewer", cacheWrite: 360 }),
      agent({ role: "implementer", cacheWrite: 170 }),
    ],
  });
  assert.equal(Math.round(reviewPct), 83);
});

test("an empty run produces zeroes, not NaN", () => {
  const s = computeSpend({ agents: [] });
  assert.equal(s.totals.cacheWrite, 0);
  assert.deepEqual(s.roles, []);
  assert.deepEqual(s.top, []);
  assert.equal(s.reviewPct, 0);
});

test("maxCtx is a max, never a sum", () => {
  const { roles, totals } = computeSpend({
    agents: [agent({ role: "reviewer", maxCtx: 324_000 }), agent({ role: "reviewer", maxCtx: 120_000 })],
  });
  assert.equal(roles[0].maxCtx, 324_000);
  assert.equal(totals.maxCtx, 324_000);
});

test("top is ranked by cache_creation and honours topN", () => {
  const { top } = computeSpend({
    agents: [
      agent({ label: "a", cacheWrite: 10 }),
      agent({ label: "b", cacheWrite: 30 }),
      agent({ label: "c", cacheWrite: 20 }),
    ],
    topN: 2,
  });
  assert.deepEqual(top.map((t) => t.label), ["b", "c"]);
});
