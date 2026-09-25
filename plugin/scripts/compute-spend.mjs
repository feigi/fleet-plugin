// Pure spend-model builder. No I/O and no clock read — board.mjs reads the
// session's subagent transcripts and calls computeSpend(); every classification
// and rollup lives here and is exercised by compute-spend.test.mjs (`node --test`).
//
// WHY cache_creation is the headline and cache_read is not: a fleet run reads
// its cache an order of magnitude more than it writes it (one measured run:
// 345M read vs 30M written), but cache reads bill at a fraction of writes. Rank
// on cache_read and every run looks identical and every role looks equally
// expensive. cache_creation is what actually tracks spend, so it is the sort key
// and the percentage base; the rest is carried for context, never for ranking.

// A fleet agent's role is not recorded anywhere as a field — it has to be
// recovered from how the controller named the work. Depth first: anything the
// controller did not spawn directly is a specialist, whatever it calls itself.
// Then description patterns, which are controller-authored and stable because
// run-team fixes them (`impl-<n>`, `fix-pr-<n>`, `review-pr-<n>`,
// `finisher-pr-<n>`, `merge-bot-<n>`).
//
// TWO IDENTITY SIGNALS, NEVER ONE (#1505). `agentDefinition` is the agent
// DEFINITION the dispatch recorded — `memory-housekeeper`, `fleet-implementer`,
// `fleet-review-verifier` — and `""` when it recorded none. `memberName` is
// what the member was CALLED (`impl-387`, `brain-housekeeping`), `""` for an
// unnamed dispatch. They used to arrive as ONE `agentType` parameter,
// documented as "the DISPATCH's identity for the member", which the two
// harness readers satisfied with different kinds of value — omp's the
// definition, Claude's the name — so every rule below silently read whichever
// its own harness happened to supply, and no rule could state which it meant.
// That ambiguity is what booked a memory-system member dispatched as
// `memory-housekeeper` but NAMED `brain-housekeeping` into the specialist
// bucket, moving its session's review-spend headline by 22 points (#1505).
// Each rule now names the signal it actually means and both readers fill both
// parameters from the same kind of value, so the asymmetry cannot come back by
// one reader being taught something the other was not.
//
// The finisher branch below also matches member names run-team does NOT fix.
// `finisher-pr-<n>` is the canonical spelling and the only one the naming list
// authorises; `finish-<n>`, `finish-pr-<n>` and `finisher-<n>` are spellings
// earlier runs actually dispatched. Matching those is deliberate compatibility
// with that history, NOT drift to be cleaned up: drop one and a member named
// that way books as "other" whenever its description does not happen to say
// "finish pr" too, moving the headline for runs already recorded.
// member-record.mjs matches the same four names, and its comment carries the
// measurement (#326).
export function classifyRole(signals) {
  const def = String(signals?.agentDefinition ?? "");
  const name = String(signals?.memberName ?? "");
  const desc = String(signals?.description ?? "");

  // Not fleet work at all — the memory system. Before everything else so it can
  // never land in review spend.
  //
  // Reads the member's IDENTITY — the recorded definition and the name — and
  // never `hay`. The definition is the authoritative half and the whole of
  // #1505: a dispatch that recorded `memory-housekeeper` books memory whatever
  // it called the member, so the eleven rows that shared one definition across
  // three buckets collapse to one. The NAME stays a signal beside it because a
  // missing definition is a real category here rather than a hole — an untyped
  // dispatch records none at all, which is every Claude member before
  // 2026-08-28 — and the memory members named `memory-proxy-session-review-2-3`
  // have nothing else to be classified on; drop it and they fall to "other",
  // which is the same defect wearing the other shoe. `desc` is excluded on
  // purpose: every memory-adjacent fleet member's own prompt says
  // "memory-proxy" somewhere, so blending the prose would book them all memory.
  if (/memory-proxy|memory-housekeeper/.test(`${def} ${name}`)) return "memory";

  // `spawnDepth` does NOT mean "review specialist". Only NAMED team members are
  // depth 0; every UNNAMED agent the controller dispatches directly — the phase-0
  // sizing pass, for one — is depth 1, exactly like a reviewer's fan-out.
  // Classifying on depth alone swept the sizing agents into "specialist" and
  // moved the review headline 83% → 87%, which is the one number anyone acts on.
  // So recognise the controller's own unnamed dispatches by name FIRST. Anchored,
  // so a specialist that merely mentions sizing is not swallowed.
  if (/^size (candidate|ticket)/.test(desc.toLowerCase())) return "sizing";

  // Everything else at depth ≥ 1 is a reviewer's fan-out. This must stay AHEAD of
  // the member patterns below: specialists are named things like "Review PR 539
  // correctness", which would otherwise book half the fan-out as reviewer spend.
  if (Number(signals?.spawnDepth ?? 0) >= 1) return "specialist";

  // Then the agent DEFINITION a dispatch named, for the members whose role the
  // two signals above cannot reach. omp is where that happens: its review path
  // runs `review-eval.mjs` inside the CONTROLLER's own session rather than as a
  // nested Workflow, so its fan-out arrives at depth 0 — measured 2026-09-16 on
  // the live corpus, 466 of 477 `fleet-review-*` rows — and falls straight
  // through to the description patterns below, which is precisely the
  // "Review PR 539 correctness" misread the depth check above exists to
  // prevent. Before this branch one definition, `fleet-review-verifier`, was
  // split across four buckets on nothing but prompt wording: 211 other, 172
  // reviewer, 20 finisher, 2 merge-bot (#1486).
  //
  // Matched against `def` ALONE — never the member's name, and never the `hay`
  // blend the patterns below use. A fleet member's own dispatch prompt says what
  // it is, so these names occur in description prose constantly, and a member
  // that merely mentions a definition was not dispatched as one. `(^|:)`
  // tolerates the `fleet-ctl:`-prefixed spelling a dispatch may write where the
  // sidecar records the bare name — the same allowance member-outcomes.tsv's own
  // deliberate-pair query is written with.
  //
  // The review side is a PREFIX and the implementer side is EXACT, deliberately:
  // the fan-out's dimensions are an open set that `review-pr.js` sizes per PR, so
  // a dimension added tomorrow must not silently fall back to prose, while the
  // implementer definitions are closed at two by the alternate-tier pairing that
  // depends on exactly those two names existing.
  //
  // One definition under that prefix is NOT fan-out: `fleet-review-runner`
  // (#1802) is the member that HOLDS an omp review — dispatched as
  // `review-pr-<n>`, the reviewer the name branch below would book — so it is
  // matched EXACTLY, ahead of the prefix. Its own fan-out arrives at depth ≥ 1
  // and is booked "specialist" by the depth check above.
  if (/(^|:)fleet-review-runner$/.test(def)) return "reviewer";
  if (/(^|:)fleet-review-/.test(def)) return "specialist";
  if (/(^|:)fleet-implementer(-alt)?$/.test(def)) return "implementer";

  // The dispatch NAME is checked alone, in this same fixed order, before the
  // prose blend below ever runs (#1506). Both readers now hand a canonical
  // omp/run-team name (`impl-<n>`, `fix-pr-<n>`, `finisher-<n>`, `finish-<n>`,
  // `review-pr-<n>`, `merge-bot-<n>`) straight through as `memberName`, and
  // that name is a MORE PRECISE signal than the member's own free-text
  // description — concatenating them into one `hay` before matching let a
  // description's prose out-rank the name whenever the fixed branch order
  // happened to check an earlier pattern the prose satisfied first. Measured
  // live: `finisher-1380` described as "Fix PR 1380 review findings." matched
  // the reviewer branch on "review" in the prose before the finisher branch
  // ever saw the name that actually says what the member is; `merge-bot-12`
  // described with "...review findings" misread the same way as finisher.
  // Matching the name alone first, and only falling through to the blend when
  // the name resolves nothing, restores the name's priority without
  // disturbing the description-only fallback the tests above still need.
  const byName = roleFromNamePatterns(name.toLowerCase());
  if (byName) return byName;

  const hay = `${name} ${desc}`.toLowerCase();
  return roleFromNamePatterns(hay) ?? "other";
}

// The four name-driven branches, shared by both the name-alone pass above and
// the description-inclusive fallback: same patterns, same fixed order
// (implementer -> reviewer -> finisher -> merge-bot), just a different
// haystack. Returns `null`, never "other", so the caller can fall through to
// the next haystack instead of committing to "other" the moment the name
// alone resolves nothing.
function roleFromNamePatterns(hay) {
  if (/^impl-|implement ticket/.test(hay)) return "implementer";
  // Both per-PR member names book as review spend: `fix-pr-<n>` is the default
  // path's applier, `review-pr-<n>` the hand-dispatch fallback's reviewer. Miss
  // one and its cache writes fall through to "other", moving the review-side
  // headline — the one number anyone acts on — by several points.
  //
  // `resolve-pr-<n>` joins the same bucket (#1250): it is a controller
  // dispatch against an ALREADY-OPEN PR, not new ticket work — measured
  // meta.json descriptions "Resolve conflict on PR 1232" and "Rebase and
  // resolve conflicts for PR #1310", the same rebase/conflict-resolver shape
  // `run-team/SKILL.md` calls "a rebase-resolver" sent into an open PR's
  // worktree. It carries no ticket, no dispatch counter and no new-work verb —
  // only a PR number — so it is remediation on that PR's path to merge,
  // exactly the category `fix-pr-<n>`'s applier already occupies here. It is
  // NOT `merge-bot`: that bucket's number is a per-run dispatch counter, never
  // a PR, and merge-bot drains a pass's PRs rather than resolving one directly.
  //
  // Only the NAME form `resolve-pr-` joins the alternation, deliberately
  // narrower than the `review pr`/`fix pr` prose forms beside it: the two
  // real meta.json descriptions above ("Resolve conflict on PR 1232",
  // "Rebase and resolve conflicts for PR #1310") never contain the bare
  // words "resolve pr" adjacently, so a `resolve pr` prose alternative would
  // be untested reach rather than a measured pattern — and "resolve" is
  // common enough in unrelated prose (a finisher applying reviewer
  // "resolve"-shaped findings against "pr" work) that adding it ahead of the
  // finisher/merge-bot checks below risked hijacking their classification on
  // words alone, with no real row to justify it.
  if (/review pr|review-pr-|fix pr|fix-pr-|resolve-pr-/.test(hay)) return "reviewer";
  if (/^finish-|finish pr|finisher/.test(hay)) return "finisher";
  if (/merge-bot/.test(hay)) return "merge-bot";
  return null;
}

// The same 5 run-team-fixed dispatch-name prefixes the branches above match,
// as a bare regex-alternation SOURCE STRING (not a compiled RegExp) — so
// member-record.mjs's OMP_CANONICAL_STEM_RE can build its own `-`-suffixed,
// anchored pattern from this one list instead of independently retyping it.
// The two encode the same run-team naming convention and must not drift
// apart the way two hand-copied lists eventually do. `finish(?:er)?`
// collapses the `finisher`/`finish` pair into the shape
// `roleFromNamePatterns`'s own bare-word check already uses.
export const CANONICAL_MEMBER_NAME_PREFIXES = "impl|fix-pr|finish(?:er)?|review-pr|merge-bot";

// Seeds the rollup buckets and breaks ties in the report, which is otherwise
// sorted by spend — so this is not the order the UI shows. Review roles lead so
// that at equal spend they still read first.
export const ROLE_ORDER = [
  "specialist", "reviewer", "implementer", "merge-bot", "sizing", "memory", "finisher", "other",
];

const empty = () => ({ agents: 0, cacheWrite: 0, output: 0, cacheRead: 0, maxCtx: 0 });

export function computeSpend({ agents = [], topN = 8 } = {}) {
  const byRole = new Map(ROLE_ORDER.map((r) => [r, empty()]));
  const totals = empty();

  for (const a of agents) {
    const role = a.role ?? "other";
    const b = byRole.get(role) ?? byRole.set(role, empty()).get(role);
    for (const k of ["cacheWrite", "output", "cacheRead"]) {
      b[k] += a[k] ?? 0;
      totals[k] += a[k] ?? 0;
    }
    b.agents++;
    totals.agents++;
    b.maxCtx = Math.max(b.maxCtx, a.maxCtx ?? 0);
    totals.maxCtx = Math.max(totals.maxCtx, a.maxCtx ?? 0);
  }

  // Percentages are of cache_creation only. A zero-total run must not produce
  // NaN in the UI — an empty board is a normal state at run start.
  const share = (n) => (totals.cacheWrite > 0 ? (n / totals.cacheWrite) * 100 : 0);

  // Report every bucket that collected something, not just the known ones. The
  // accumulator above happily creates a bucket for a role outside ROLE_ORDER,
  // but mapping over ROLE_ORDER dropped it from the table while its tokens
  // stayed in `totals` — so the percentage column silently stopped summing to
  // 100 and the run looked cheaper than it was. Latent while classifyRole only
  // emits known roles; it fails by under-reporting the moment one is added to
  // the classifier and not to this array.
  const roles = [...byRole.entries()]
    .filter(([, b]) => b.agents > 0)
    .map(([role, b]) => ({ role, ...b, pct: share(b.cacheWrite) }))
    .sort((a, b) => b.cacheWrite - a.cacheWrite);

  const top = [...agents]
    .sort((a, b) => (b.cacheWrite ?? 0) - (a.cacheWrite ?? 0))
    .slice(0, topN)
    .map((a) => ({
      label: a.label ?? "?", role: a.role ?? "other",
      cacheWrite: a.cacheWrite ?? 0, maxCtx: a.maxCtx ?? 0, pct: share(a.cacheWrite ?? 0),
    }));

  // The single number worth surfacing: review side is specialists + reviewers.
  // Two independent runs measured 84% and 83%, so a large deviation is a signal
  // that this run's shape changed, not that the metric is noisy.
  const reviewPct = share(
    (byRole.get("specialist")?.cacheWrite ?? 0) + (byRole.get("reviewer")?.cacheWrite ?? 0),
  );

  return { totals, roles, top, reviewPct };
}

// Per-TOOL attribution. Tokens are not billed per tool call, so this is a proxy
// and is labelled as one everywhere it surfaces: a tool result arrives in a user
// turn, and the NEXT assistant turn's cache_creation is the cost of writing that
// result into the cache. When several results land before that turn, the cost is
// split proportionally by result size, because that is what drove it.
//
// Those results arrive as CONSECUTIVE user turns, not as one turn carrying
// several blocks: across 45,062 real result-bearing turns, not one carried two
// tool_results. Parallel tool calls show up as N single-result turns in a row
// (4,087 occurrences). So `pending` must ACCUMULATE across consecutive result
// turns — replacing it dropped every batch but the last, losing 9.1% of all
// attributions, and left the proportional split below unreachable on real data.
//
// The proxy over-attributes slightly — that next turn also caches the assistant's
// own preceding output — so treat these as shares, not absolutes. `resultChars`
// is the honest raw number and needs no modelling at all; it is reported beside
// the estimate so a suspicious share can always be checked against it.
//
// `entries` is an ordered per-agent stream:
//   { kind: "assistant", cacheWrite, tools: [{ id, name }] }
//   { kind: "result", results: [{ id, chars }] }
export function attributeTools(entries = []) {
  const nameById = new Map();
  const byTool = new Map();
  const bump = (name) => {
    let t = byTool.get(name);
    if (!t) byTool.set(name, (t = { tool: name, calls: 0, resultChars: 0, cacheWrite: 0 }));
    return t;
  };

  let pending = null; // the most recent result batch, awaiting the next assistant turn

  for (const e of entries) {
    if (e.kind === "assistant") {
      // Attribute this turn's cache write to whatever results preceded it.
      if (pending && pending.length) {
        const total = pending.reduce((n, r) => n + r.chars, 0);
        for (const r of pending) {
          // An all-zero batch still gets an even split rather than being dropped —
          // a tool that returns nothing still costs a turn to process.
          const frac = total > 0 ? r.chars / total : 1 / pending.length;
          bump(r.name).cacheWrite += (e.cacheWrite ?? 0) * frac;
        }
      }
      pending = null;
      for (const t of e.tools ?? []) {
        if (!t?.id) continue;
        nameById.set(t.id, t.name ?? "unknown");
        bump(t.name ?? "unknown").calls++;
      }
    } else if (e.kind === "result") {
      const batch = (e.results ?? []).map((r) => {
        const name = nameById.get(r.id) ?? "unknown";
        bump(name).resultChars += r.chars ?? 0;
        return { name, chars: r.chars ?? 0 };
      });
      pending = pending ? pending.concat(batch) : batch;
    }
  }

  const tools = [...byTool.values()]
    .map((t) => ({ ...t, cacheWrite: Math.round(t.cacheWrite) }))
    .sort((a, b) => b.cacheWrite - a.cacheWrite);
  const totalCw = tools.reduce((n, t) => n + t.cacheWrite, 0);
  return tools.map((t) => ({ ...t, pct: totalCw > 0 ? (t.cacheWrite / totalCw) * 100 : 0 }));
}

// Merge per-agent tool tables into one run-level table.
export function mergeTools(tables = []) {
  const acc = new Map();
  for (const table of tables) {
    for (const t of table) {
      const cur = acc.get(t.tool) ?? { tool: t.tool, calls: 0, resultChars: 0, cacheWrite: 0 };
      cur.calls += t.calls;
      cur.resultChars += t.resultChars;
      cur.cacheWrite += t.cacheWrite;
      acc.set(t.tool, cur);
    }
  }
  const tools = [...acc.values()].sort((a, b) => b.cacheWrite - a.cacheWrite);
  const total = tools.reduce((n, t) => n + t.cacheWrite, 0);
  return tools.map((t) => ({ ...t, pct: total > 0 ? (t.cacheWrite / total) * 100 : 0 }));
}
