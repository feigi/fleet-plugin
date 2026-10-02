// Shared `runReview(host, args)` test double, extracted from
// review-in-run-retry.test.mjs so review-path-default.test.mjs's own return-
// shape pin can drive a REAL `runReview` call instead of re-parsing
// review-core.mjs's source text for its `return {` — the retired script's
// own return literal was the ONLY thing that pin ever read;
// ADR 0014 (omp-only) leaves review-core.mjs as the one body to run.
//
// review-core.mjs's own pipeline contract, mirrored here: a null stage-1
// result never reaches stage 2, with a throw landing in the same null slot —
// the shape `defaultPipeline` (review-core.mjs) already has, restated as a
// scripted double so a caller needs no host beyond what it drives itself.
export async function pipeline(items, stage1, stage2) {
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
export const parallel = (fns) => Promise.all(fns.map((fn) => fn()));

export const ARGS = { pr: 7, branch: "feature/x", worktree: "/repo/.worktrees/7-x", scratch: "/scr", testCmd: "node --test", dimensions: ["correctness"] };
export const SNAP = {
  runRoot: "/scr/pr7/run-ab12",
  path: "/scr/pr7/run-ab12/snapshot-abc123",
  head: "abc123",
  pathVerified: true,
  repoVerified: true,
  testCmd: "node --test",
};
export const RAN = { command: "node --test", tests: 5, pass: 5, fail: 0 };
// #2315. The shared test run's agent report — the `test-run` dispatch every
// review makes once, before any specialist. Clean, so a script that is about
// something else need not answer it; one that is about it names its own.
export const SHARED = { exitCode: 0, tests: 5, pass: 5, fail: 0 };
export const review = (findings, testRun = RAN) => ({
  dimension: "correctness",
  scope_searched: "CWD-AUDIT: clean /repo",
  findings,
  test_run: testRun,
});
export const finding = (severity) => ({ severity, claim: `a ${severity} claim`, file: "a.js", line: 3, evidence: "line 3 has no else" });
export const vote = (refuted) => ({ refuted, reason: "measured. CWD-AUDIT: clean /repo" });

// A host whose `agent()` answers each dispatch label from a script, one entry
// per call in dispatch order (the last entry repeats), and counts the calls.
// An `Error` entry is thrown rather than returned. Counting happens
// synchronously on the call, so the two refuters of one pair are calls 1 and
// 2 of their label, and a re-dispatched pair is calls 3 and 4. A script with
// no `test-run` entry gets `[SHARED]` for it; every other unscripted label
// throws. `prompts` records each dispatch's prompt under its label.
export function scriptedHost(script) {
  const calls = {};
  const prompts = {};
  return {
    calls,
    prompts,
    host: {
      agent: async (prompt, opts) => {
        const n = (calls[opts.label] = (calls[opts.label] ?? 0) + 1);
        (prompts[opts.label] ??= []).push(prompt);
        const seq = script[opts.label] ?? (opts.label === "test-run" ? [SHARED] : undefined);
        if (!seq) throw new Error(`scriptedHost: unexpected dispatch ${opts.label}`);
        const answer = seq[Math.min(n, seq.length) - 1];
        if (answer instanceof Error) throw answer;
        return answer === null ? null : structuredClone(answer);
      },
      phase: () => {},
      log: () => {},
    },
  };
}
