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
// The finisher branch below also matches member names run-team does NOT fix.
// `finisher-pr-<n>` is the canonical spelling and the only one the naming list
// authorises; `finish-<n>`, `finish-pr-<n>` and `finisher-<n>` are spellings
// earlier runs actually dispatched. Matching those is deliberate compatibility
// with that history, NOT drift to be cleaned up: drop one and a member named
// that way books as "other" whenever its description does not happen to say
// "finish pr" too, moving the headline for runs already recorded.
// member-outcomes.mjs matches the same four names, and its comment carries the
// measurement (#326).
export function classifyRole(meta) {
  const type = String(meta?.agentType ?? "");
  const desc = String(meta?.description ?? "");
  const hay = `${type} ${desc}`.toLowerCase();

  // Not fleet work at all — the memory system. Before everything else so it can
  // never land in review spend.
  if (/memory-proxy|memory-housekeeper/.test(type)) return "memory";

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
  if (Number(meta?.spawnDepth ?? 0) >= 1) return "specialist";

  if (/^impl-|implement ticket/.test(hay)) return "implementer";
  // Both per-PR member names book as review spend: `fix-pr-<n>` is the default
  // path's applier, `review-pr-<n>` the hand-dispatch fallback's reviewer. Miss
  // one and its cache writes fall through to "other", moving the review-side
  // headline — the one number anyone acts on — by several points.
  if (/review pr|review-pr-|fix pr|fix-pr-/.test(hay)) return "reviewer";
  if (/^finish-|finish pr|finisher/.test(hay)) return "finisher";
  if (/merge wave|merge-bot/.test(hay)) return "merge-bot";
  return "other";
}

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
