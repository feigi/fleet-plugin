// review-eval.mjs — the omp shim for the PR review port (#1349, per #1303's
// ruling on #1296). The controller loads THIS file (never review-core.js or
// review-pr.js directly) through the Resolver, from an `eval` cell:
//
//   const path = (await Bun.$`FLEET_HARNESS=omp ~/.fleet/bin/fleet-run --path review-eval.mjs`.text()).trim();
//   const { runReviewOnOmp } = await import(path);
//   const result = await runReviewOnOmp({ pr, branch, worktree, testCmd, scratch });
//
// This file `import`s review-core.js (a same-directory sibling, both ship
// together under the same Install root) with a RELATIVE specifier, so the
// Resolver is only needed ONCE, to find this file itself — the relationship
// between the two is an ordinary same-install sibling import, which eval's
// Bun VM permits without restriction (#1296 Q6). Never resolve
// review-core.js's own path through the Resolver a second time — that would
// be two doors where CONTEXT.md's Resolver entry says there is exactly one.
//
// No `model`/`effort` appears anywhere below (#1349 gap 3; audited by
// review-tier-audit.test.mjs). Every dispatch names a bare fleet-owned
// `agentType` from review-core.js's DEFAULT_DIMENSIONS or from
// runReview's own snapshot/verifier dispatch, unmodified — omp's `agent()`
// resolves a bare frontmatter `name:` exactly, which is already what those
// strings are.
import { runReview } from "./review-core.js";

// eval's `agent()` returns a HANDLE, not data (#1296 Q2): `agent(prompt,
// opts)` resolves near-instantly to an `AgentHandle` with `.wait()`, and only
// `.wait()` unwraps the schema-validated `structuredOutput.data`. This
// wrapper is what makes review-core.js's `await host.agent(...)` read like
// Claude's synchronous, data-returning `agent()` — the ONE piece of
// harness-specific glue `runReview` needs and cannot see.
//
// A crashed/rejected dispatch resolves to `null`, matching Claude's own
// "agent() returns null on exhaustion" contract that every guard in
// review-core.js (`if (snap) {...}`, `unrunCrashed`, `verdictFor`) is written
// against. eval's DEFAULT `schemaMode` is "permissive": an exhausted
// structured-output retry is ACCEPTED anyway, carrying `schemaOverridden:
// true` on invalid data (#1296 Q2) rather than nulling out the way Claude
// Code's exhaustion does. `schemaMode: "strict"` turns that same exhaustion
// into a thrown/rejected result instead — still not a null — so this wrapper
// treats a REJECTED `.wait()` as the crash signal (`agent()`'s only way to
// fail loudly under omp) and maps it to `null` itself; it does not attempt to
// distinguish an accepted-but-schema-overridden permissive result from a
// clean one, because review-core.js never reads a distinguishing field for
// that case either — a schema violation the host already retried three times
// and gave up correcting is not this shim's contract to relitigate.
//
// NO PER-CALL WORKING DIRECTORY HERE, AND WHY THE ISOLATION RULE LIVES IN THE
// PROMPTS INSTEAD (#1433). Three PRs reviewed back-to-back from one eval cell
// left FOUR files modified in the checkout that cell was standing in — a
// specialist's mutation-test experiment reached through a RELATIVE path, in the
// tree the controller reads instruments.sh, ci-state.mjs and every gate
// decision out of. Review specialists have no assigned worktree to fall back
// to, so the preferred fix was a scratch cwd per dispatch, passed through this
// wrapper. The harness has no such option — measured against its own contract,
// not assumed:
//
//   - eval's `agent()` takes `{ agent, label, schema, schemaMode, isolated,
//     apply, merge, tools }` and nothing else (`omp://tools/eval.md`
//     § `agent()`), and `task`'s item shape — `{ name, agent, task, effort,
//     outputSchema, schemaMode, isolated }` — carries no cwd either
//     (`omp://tools/task.md`). A non-isolated spawn "call[s] `runSubprocess(…)`
//     directly with parent cwd", so the child's directory is decided one level
//     above this file and is the controller's own.
//   - `isolated: true` is not that option under another name. It names no
//     directory, so it cannot BE the `<scratch>/pr<N>/<finding>/` the two-level
//     scratch convention asks for; it exists only where
//     `task.isolation.enabled` is on, and requesting it while isolation is
//     `none` fails PREFLIGHT — synchronously, out of the `await agent(...)`
//     below, which the `try` further down does not cover — so on any install
//     with isolation off every dimension would come back null and the review
//     would report itself wholly crashed. And it MERGES what the child changed
//     back into the parent (patch apply, or a branch cherry-pick that stashes
//     the parent repo first): a mutation-testing specialist's deliberately
//     broken tree, applied to the checkout. That is the reported defect with a
//     commit attached.
//
// So the rule lives where it can be stated at all: review-core.js's snapshot,
// specialist and refuter prompts name the inherited cwd as a no-run zone, order
// a `cd` into the run-root scratch path before any mutation, and require a
// `CWD-AUDIT:` line back. This wrapper stays a pure handle adapter. Should
// eval's `agent()` ever gain a cwd option, THIS is the one place that changes —
// thread it through `opts` here, and the prompt rules become the second belt
// rather than the only one.
async function ompAgent(prompt, opts) {
  const handle = await agent(prompt, { agent: opts.agentType, schema: opts.schema, label: opts.label });
  try {
    return await handle.wait();
  } catch {
    return null;
  }
}

// `pipeline()`/`parallel()` have no omp counterpart (#1296 Q3) — this is the
// same hand-rolled pair review-core.js exports as its own default (see
// `defaultPipeline`/`defaultParallel` there), passed through explicitly here
// rather than left to the default so a reader of THIS file, the one the
// controller actually loads, can see the omp orchestration shape without
// following an import.
function pipeline(items, stage1, stage2) {
  return Promise.all(
    items.map(async (item) => {
      let r1;
      try {
        r1 = await stage1(item);
      } catch {
        r1 = null;
      }
      if (!r1) return null;
      try {
        return await stage2(r1, item);
      } catch {
        return null;
      }
    }),
  );
}
function parallel(fns) {
  return Promise.all(fns.map((fn) => fn()));
}

// The controller's `eval` cell entry point. `phase`/`log` are eval's own
// prelude globals (`omp://tools/eval.md`) — real free variables in the
// cell's scope, exactly like `agent` above; naming them as parameters here
// would ask the controller's cell to thread through globals it already has.
export async function runReviewOnOmp(args) {
  return runReview({ agent: ompAgent, phase, log, pipeline, parallel, harness: "omp" }, args);
}
