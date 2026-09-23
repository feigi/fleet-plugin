// review-core.js — the host-independent half of the PR review port (#1349,
// per #1303's ruling on #1296). Read that ruling before touching this file.
//
// WHY THIS FILE LIVES IN scripts/, NOT workflows/, AND IS NOT `import`ed BY
// workflows/review-pr.js
// ---------------------------------------------------------------------------
// #1296's research (docs/specs/2026-09-08-omp-eval-workflow-host.md, via the
// `research/omp-eval-workflow-host` branch) measured that review-pr.js
// touches exactly three host APIs beyond plain JS — `agent()`, `phase()`/
// `log()`, and the `pipeline()`/`parallel()` orchestration primitives — and
// that everything else (the two JSON schemas, `usableDiff`, `readRules`,
// `resolveTestCmd`, `decodeArgs`, `selectDimensions`, `resolveDimensions`,
// `snapshotMissing`, `unrunReason`/`unrunEntries`/`unrunCrashed`,
// `verdictFor`, `resumeFor`) is portable verbatim. That is what lives here.
//
// The obvious shape — review-pr.js `import`s this file, omp's eval shim does
// too — does not work, and it is not a preference, it is a measured fact
// review-pr.js's own comment records (beside `snapshotMissing`, citing #538):
// a Claude Code Workflow script's body compiles as a function body inside the
// harness VM, `import()` is refused for ANY specifier before the name is even
// resolved, and `require` is undefined. So review-pr.js CANNOT import this
// file, on either side of the relationship — not "this file cannot be
// imported", the reverse: review-pr.js cannot perform an import at all. It
// also means this file is not itself a Workflow — nothing ever loads it that
// way — so it lives in `scripts/` beside the other shared, plain-importable
// modules (`lift.mjs`, `strip-comments.mjs`, …), never in `workflows/`:
// `workflow-meta-first.test.mjs` discovers every file under `workflows/` and
// asserts each begins `export const meta`, the Claude Workflow contract, and
// a file that is not a workflow does not belong in a directory whose entire
// contents that guard asserts are.
//
// The choice this ticket makes, per its own instruction to pick a shape and
// document it: this file is the CANONICAL, tested source of every host-
// independent declaration. omp's shim (scripts/review-eval.mjs) `import`s it
// directly — eval's `js` backend is an ordinary Bun VM with no such
// restriction (#1296, Q6). review-pr.js keeps a text-identical COPY of every
// pure function and both schemas, because Claude's Workflow sandbox leaves no
// other option — the same "duplicate, then pin the duplicate" idiom this
// repo already uses for the `usableDiff`/`snapshotMissing` head-compare
// (review-pr-snapshot-path.test.mjs's "the head compare in usableDiff and
// snapshotMissing are the same expression"), now applied at file scope
// instead of expression scope. review-core-parity.test.mjs is the pin: it
// runs each shared declaration from BOTH copies through the same fixtures
// (review-core.js's imported normally; review-pr.js's lifted out of its
// source text, the technique every other review-pr.js test file already
// uses) and asserts identical OUTPUT — behavior parity, not text identity,
// since review-core.js deliberately drops review-pr.js's historical
// rationale comments (see this file's own "Pure functions" section header).
// The one thing ALLOWED to differ in VALUE, not merely in comment, is the
// `agentType` string on each `DEFAULT_DIMENSIONS` entry, bare here
// (`fleet-review-<key>`, already omp's native agent-lookup form) versus
// namespaced in review-pr.js (`fleet-ctl:fleet-review-<key>`, the Task
// tool's `<plugin>:<agent>` convention). Both spellings live in the same
// field name so `selectDimensions`/`resolveDimensions`/the dispatch call
// sites read identically on both sides — "the shim owns the spelling" means
// exactly this one string, nothing else.
//
// `runReview(host, args)` at the bottom is NOT a copy of anything in
// review-pr.js — it is this file's own rendering of review-pr.js's top-level
// script body as a callable function, taking an injected `host` object
// (`agent`, `phase`, `log`, and optionally `pipeline`/`parallel`) instead of
// reading them as sandbox globals. review-pr.js has no equivalent function:
// its top-level statements run once, directly, because the Workflow harness
// executes the whole file as the workflow's body. The two are kept in step
// by the SAME parity test reading `runReview`'s use of the shared pure
// functions against review-pr.js's own call sites.
//
// ONE import, added by #878: arg.mjs's isDigits(). This file is an ordinary
// module — review-eval.mjs imports it — so it consumes the repo's digits
// rule directly, where review-pr.js has to declare its own copy for the
// sandbox reason above. That copy is not a copy of anything HERE, so
// review-core-parity.test.mjs is not its pin; shared-refusal.test.mjs is,
// running review-pr.js's lifted isDigits and arg.mjs's over the same values.

import { isDigits } from "./arg.mjs";

// --- Schemas ----------------------------------------------------------
// Identical to review-pr.js's copy (`review-core-parity.test.mjs` pins it).
// See that file for the full rationale on every required/optional field —
// duplicating that rationale here would be the second copy this repo's own
// "recurring pin defect" comment warns about.
export const FINDINGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["dimension", "scope_searched", "findings", "test_run"],
  properties: {
    dimension: { type: "string" },
    scope_searched: {
      type: "string",
      description:
        "The exact commands/paths this pass covered. Required so a negative claim is bounded: a grep that found nothing looks identical to a grep never run.",
    },
    test_run: {
      type: "object",
      additionalProperties: false,
      required: ["command", "tests"],
      description:
        "The test run this pass performed. Report it even when it failed or produced nothing — `tests: 0` is how a dimension gets reported unrun, and an empty findings list cannot say it.",
      properties: {
        command: { type: "string", description: "The command as RUN, verbatim." },
        tests: { type: "integer", description: "Tests the run reported. 0 means the command produced none — a failed run, not a pass." },
        pass: { type: "integer" },
        fail: { type: "integer" },
      },
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "claim", "evidence"],
        properties: {
          severity: { enum: ["critical", "important", "suggestion"] },
          file: { type: "string" },
          line: { type: "integer" },
          claim: { type: "string", description: "One falsifiable sentence." },
          evidence: {
            type: "string",
            description:
              "What was RUN — command plus output — not what was reasoned. A claim with no command is a suggestion at best.",
          },
          suggested_fix: { type: "string" },
        },
      },
    },
  },
};

export const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["refuted", "reason"],
  properties: {
    refuted: { type: "boolean" },
    reason: { type: "string" },
    counter_evidence: { type: "string", description: "Command + output, if any." },
  },
};

export const SNAPSHOT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["runRoot", "path", "head", "pathVerified", "repoVerified"],
  properties: {
    runRoot: { type: "string" },
    path: { type: "string" },
    head: { type: "string" },
    pathVerified: { type: "boolean" },
    // #1056. `pathVerified` says the tree is THERE; this says the tree is
    // MEASURABLE — that the snapshot is a git repository holding the reviewed
    // commit's tree. Required for `pathVerified`'s reason: an omitted boolean
    // must not read as a verified environment, because the whole defect was a
    // measurement nothing in the payload said was taken somewhere else.
    repoVerified: { type: "boolean" },
    // Only when `repoVerified` is false: whichever SNAPSHOT_* line the block
    // printed instead of SNAPSHOT_TREE_MATCH. Optional, because a verified
    // snapshot has nothing to say here.
    repoError: { type: "string" },
    diffStats: { type: "string" },
    diffPath: { type: "string" },
    diffLines: { type: "integer" },
    refHead: { type: "string" },
    prHead: { type: "string" },
    testCmd: { type: "string" },
    testCmdError: { type: "string" },
  },
};

// --- Dimension catalog --------------------------------------------------
// See review-pr.js's own copy of this comment for the full tier rationale
// (#1349, per #1303's gap 3): no dimension carries a `model`/`effort` field —
// dispatch tier lives ONLY in each fleet-owned agent definition's own
// frontmatter. `agentType` is bare here (omp's native `agent()` lookup is an
// exact match on a frontmatter `name:`); review-pr.js's copy namespaces the
// same field `fleet-ctl:fleet-review-<key>` for the Claude Task tool. That one
// string is the ONLY difference between the two arrays.
export const DEFAULT_DIMENSIONS = [
  {
    key: "correctness",
    agentType: "fleet-review-correctness",
    prompt: "logic errors, missed cases, scope creep beyond the ticket",
  },
  {
    key: "silent-failure",
    agentType: "fleet-review-silent-failure",
    prompt:
      "swallowed errors, fallbacks that hide faults, catch blocks that mislabel what failed, and any NEW dereference the diff moved inside an existing try",
  },
  {
    key: "tests",
    agentType: "fleet-review-tests",
    prompt:
      "whether each test DISCRIMINATES: apply the mutation it should catch, confirm that test goes red, revert, then apply one it should NOT catch and confirm green. Vary the syntactic form — a guard catching `// whole-line` may let `code; // trailing` through",
  },
  {
    key: "comments",
    agentType: "fleet-review-comments",
    prompt:
      "every added factual assertion checked against the tree, INCLUDING comments in files this diff does not touch but whose claims it falsifies (test-name references, 'N of 3' counts, tracking-issue pointers)",
  },
  {
    key: "types",
    agentType: "fleet-review-types",
    prompt: "invariants expressed vs merely documented; casts that erase conformance",
  },
  {
    key: "simplify",
    agentType: "fleet-review-simplify",
    prompt:
      "simplification opportunities — dead branches, redundant state, needless indirection. REPORT ONLY, read-only: a finding's claim is what to simplify, suggested_fix is the simpler form, severity 'suggestion'. Never edit a file. A simplification that changes observable behavior is a defect, not a suggestion",
  },
];

// Unchanged from review-pr.js: `single-file` is `files === 1`, `small` is
// `loc < 30` (diff-stats.mjs's computeStats owns both thresholds).
export const SIZE_TIER_PROFILES = new Set(["single-file", "small"]);
// The refuter-budget floor: `correctness`/`silent-failure` miss silently and
// permanently; `comments` sits beside them for a different reason (#218).
// Keyed on recoverability of a MISS, never on tier — `verifiersFor` takes a
// severity and nothing else.
export const SIZE_TIER_DIMS = new Set(["correctness", "silent-failure", "comments"]);

// --- Pure functions -------------------------------------------------------
// Every function below is byte-identical (function body) to review-pr.js's
// own declaration — review-core-parity.test.mjs pins it. See review-pr.js
// for the full historical rationale on each; it is not repeated here to
// avoid a second copy of PROSE disconnecting the way this repo's own
// "recurring pin defect" comment warns a second copy of CODE does.

export function usableDiff(snap) {
  if (!snap.diffPath) return null;
  if (!snap.diffLines) return null;
  if (snap.refHead && !snap.refHead.startsWith(snap.head) && !snap.head.startsWith(snap.refHead)) return null;
  return `${snap.runRoot}/pr.diff`;
}

export function readRules(diffPath, stats, snap) {
  const rejected = !diffPath && snap && snap.diffPath ? snap.diffPath : null;
  const skew = !!(rejected && snap.diffLines && snap.refHead);
  const listed = stats && stats.paths ? stats.paths.length : 0;
  const header =
    stats && stats.truncated
      ? `The PR touched at least these files — GitHub capped the list at ${listed} of
${stats.truncated}, so there are more it does not name:`
      : skew
        ? `The PR touched these files as of its own head, which is NOT this snapshot's
commit — treat the list as approximate:`
        : `The PR touched exactly these files and no others:`;

  const change = diffPath
    ? `The PR's whole diff is at ${diffPath}. Read it FIRST, bounded — it is the
change you are reviewing, and the snapshot around it is context.`
    : stats && stats.paths && stats.paths.length
      ? `${
          rejected
            ? `A diff was captured at ${rejected} and REJECTED — ${
                skew
                  ? `it describes the PR's branch at ${snap.refHead}, not this snapshot`
                  : snap.diffLines === 0
                    ? "it is empty"
                    : "its line count was never reported, so nothing measured whether it holds the PR's whole change or nothing at all"
              }. Do not read it.`
            : "No diff file was captured."
        } ${header}
${stats.paths.map((p) => `  ${p.path} (${p.loc} changed)`).join("\n")}`
      : `No diff file and no file list were captured. Locate the files your
dimension covers by searching the snapshot ('grep -rn', 'ls -R'), then read
them under the bounding rule below: 'wc -l' first.`;

  return `${change}

The snapshot IS the source of truth: 'git archive HEAD', byte-identical to
'git show HEAD:<path>' — verified when it was cut. No agent can contaminate it
and no git command settles what the PR contains any better. A finding that
disagrees with the snapshot is a probe artifact.

BOUND EVERY READ: an offset and a limit, or '| sed -n A,Bp'. Take a file whole
only after 'wc -l' says it is small — a count, not a feeling. An unbounded read
is never a one-off cost: it rides your prefix for every remaining turn,
re-billed as cache-read each time. Measured over one run, 88 unpiped whole-file
reads carried 434 KB.`;
}

export function resolveTestCmd(explicit, snap) {
  if (explicit) return explicit;
  if (snap && snap.testCmd) return snap.testCmd;
  throw new Error(
    `review-pr: no test command for this repository — ${(snap && snap.testCmdError) || "the snapshot agent did not derive one"}. Pass args.testCmd to override.`,
  );
}

export function decodeArgs(a) {
  if (typeof a !== "string") return a || {};
  try {
    return JSON.parse(a);
  } catch (e) {
    throw new Error(`review-pr: args arrived as a string this could not parse (${e.message})`);
  }
}

export function selectDimensions(all, stats) {
  if (!stats || !stats.profile || stats.profile === "empty") return all;
  if (stats.truncated) return all;
  if (stats.docsOnly === true) {
    const docsOnlyDims = all.filter((d) => d.key === "correctness" || d.key === "comments");
    if (!docsOnlyDims.length) throw new Error("review-pr: selectDimensions produced an empty dimension set");
    return docsOnlyDims;
  }
  let dims = all;
  if (stats.hasTests === false) dims = dims.filter((d) => d.key !== "tests");
  if (stats.hasSrc === false) {
    const keepsSilentFailure =
      SIZE_TIER_PROFILES.has(stats.profile) ||
      (stats.profile === "tests-only" && stats.hasConfig === true) ||
      (stats.profile === "production" && stats.hasTests === false && stats.hasConfig === true);
    dims = dims.filter(
      (d) => d.key !== "types" && d.key !== "simplify" && (d.key !== "silent-failure" || keepsSilentFailure),
    );
  }
  if (SIZE_TIER_PROFILES.has(stats.profile))
    dims = dims.filter((d) => SIZE_TIER_DIMS.has(d.key) || (d.key === "tests" && stats.hasTests === true));
  if (!dims.length) throw new Error("review-pr: selectDimensions produced an empty dimension set");
  return dims;
}

export function resolveDimensions(override, all) {
  if (override == null) return null;
  if (!Array.isArray(override))
    throw new Error("review-pr: args.dimensions must be an array of keys or dimension objects");
  const REQUIRED = ["key", "prompt", "agentType"];
  const kind = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
  const normalized = override.map((entry, i) => {
    if (typeof entry === "string") {
      const found = all.find((d) => d.key === entry);
      if (!found) throw new Error(`review-pr: args.dimensions[${i}] named an unknown key "${entry}"`);
      return found;
    }
    if (kind(entry) !== "object")
      throw new Error(
        `review-pr: args.dimensions[${i}] must be a key string or a dimension object, got ${kind(entry)}`,
      );
    const missing = REQUIRED.filter((f) => !entry[f]);
    if (missing.length)
      throw new Error(`review-pr: args.dimensions[${i}] is missing required field(s): ${missing.join(", ")}`);
    const wrongType = REQUIRED.find((f) => typeof entry[f] !== "string");
    if (wrongType)
      throw new Error(
        `review-pr: args.dimensions[${i}] field "${wrongType}" must be a string, got ${kind(entry[wrongType])}`,
      );
    if (entry.model !== undefined)
      throw new Error(
        `review-pr: args.dimensions[${i}] field "model" is no longer supported — dispatch tier lives in the fleet-owned agent definition's own frontmatter, never per call`,
      );
    return entry;
  });
  const byKey = new Map();
  for (const [i, d] of normalized.entries()) {
    const held = byKey.get(d.key);
    if (held && (held.prompt !== d.prompt || held.agentType !== d.agentType))
      throw new Error(`review-pr: args.dimensions[${i}] repeats key "${d.key}" with different fields`);
    if (!held) byKey.set(d.key, d);
  }
  const resolved = [...byKey.values()];
  if (!resolved.length) throw new Error("review-pr: args.dimensions resolved to no dimensions");
  return resolved;
}

export function snapshotMissing(snap, runRootPrefix) {
  if (!snap) return "the snapshot agent returned nothing (it died, or it exhausted its structured-output retries) — no tree to review";
  if (!snap.path) return "the snapshot agent's report gives no `path` — no tree to review";
  if (!snap.head) return "the snapshot agent's report gives no `head` — refusing to review a tree whose commit is unknown";
  if (!snap.runRoot) return "the snapshot agent's report gives no `runRoot` — nothing says the tree belongs to THIS run";
  if (!snap.runRoot.startsWith(runRootPrefix))
    return `the snapshot agent reported a run root of ${snap.runRoot}, which is not under ${runRootPrefix} — refusing a tree this run did not provision`;
  if (!snap.path.startsWith(`${snap.runRoot}/snapshot-`))
    return `the snapshot at ${snap.path} is not under this run's own root ${snap.runRoot} — refusing a tree that may belong to another run`;
  if (snap.path.includes("/../") || snap.path.endsWith("/.."))
    return `the snapshot at ${snap.path} climbs out of ${snap.runRoot} with a \`..\` segment — the prefix says nothing about where it resolves`;
  if (snap.pathVerified !== true)
    return `the snapshot at ${snap.path} was not verified to exist — refusing to hand a possibly-missing tree to every specialist`;
  if (snap.refHead && !snap.refHead.startsWith(snap.head) && !snap.head.startsWith(snap.refHead))
    return `the tree at ${snap.path} is at ${snap.head}, and the PR's branch ref is at ${snap.refHead} — refusing to review a commit that is not the PR`;
  return null;
}

// #1056. What a suite run inside the snapshot is evidence ABOUT, in one
// paragraph every specialist prompt and the returned payload both carry.
//
// `repoVerified` false is deliberately NOT a refusal (`snapshotMissing` says
// nothing about it): the tree is still reviewable, and refusing would trade a
// wrong test count for no coverage at all — the expensive half of this defect,
// measured twice as a dimension withdrawing itself over a suite it could not
// attribute. What the review cannot do is present the count as a validation
// while nothing says the measurement happened somewhere else, so the fact
// travels with the payload instead.
//
// The verified branch states the synthetic history too, because making the
// snapshot a repository is what makes a git command answer there AT ALL: one
// commit, no ancestry, no remotes, so `git log`/`git diff` now return
// plausible output about the snapshot in place of the `fatal:` that used to
// stop that question being asked.
export function environmentNote(snap) {
  if (snap && snap.repoVerified === true)
    return `Test environment: the snapshot is a git repository whose single commit holds
the reviewed tree — its tree hash was compared against the commit under review
when the snapshot was cut. A suite run here collects and runs what a checkout at
that commit does, so a failing or skipped test is a fact about the tree, not
about this copy of it. Its history is that one synthetic commit: 'git log',
'git diff' and every ancestry question answer about the snapshot and never about
the PR.`;
  const cause = snap && snap.repoError;
  if (cause && cause.startsWith("SNAPSHOT_TREE_MISMATCH"))
    return `Test environment UNVERIFIED — ${cause}.
The init succeeded: the snapshot IS a git repository, but its tree is not the
commit under review — 'git init' committed the extraction, and the commit's
tree does not match. A suite run here still executes against a real checkout,
so its counts are real measurements, but of a DIFFERENT tree than the one
under review: a failure in it says nothing about the reviewed commit.`;
  return `Test environment UNVERIFIED — ${cause || "the snapshot agent did not report a verified repository"}.
A 'git archive' extraction is not a git repository, and every test that needs
one skips or fails there for that reason alone, so a suite run here is NOT a
validation of the tree: its counts are snapshot-measured, and a failure in it
cannot be told apart from a regression.`;
}

export function unrunReason(review) {
  if (!review) return "the reviewer returned nothing — spend limit, timeout, or terminal error";
  const run = review.test_run;
  if (!run) return "the reviewer reported no test run at all";
  const cmd = run.command || "the test command";
  if (!run.tests) return `\`${cmd}\` produced 0 tests — a failed run, not a pass`;
  if (run.pass === 0 && !run.fail) return `\`${cmd}\` passed nothing and failed nothing — every test skipped, not a pass`;
  const executed = run.pass + (run.fail ?? 0);
  if (typeof run.pass === "number" && executed * 2 < run.tests)
    return `\`${cmd}\` passed ${run.pass} and failed ${run.fail ?? 0} of the ${run.tests} tests it collected — most of what it collected never ran`;
  if (run.fail > 0 && !review.findings?.length)
    return `\`${cmd}\` reported ${run.fail} failing tests and the reviewer filed no findings about them`;
  return null;
}

export function unrunEntries(review, dimension) {
  const why = unrunReason(review);
  return why ? [{ dimension, reason: why }] : [];
}

export function unrunCrashed(reviewed, dimensions) {
  return reviewed.flatMap((r, i) => (r ? [] : unrunEntries(null, dimensions[i]?.key ?? `slot ${i}`)));
}

// #1433 gap: the CWD-AUDIT line the Review dispatch below asks a specialist
// to fold into `scope_searched` is a convention, not schema — FINDINGS_SCHEMA
// accepts any string there, so a specialist that satisfies the schema while
// never emitting the line, or misspelling it, produces a fully valid,
// undetected payload, and one that DOES emit `CWD-AUDIT: dirty <path>` has
// nothing downstream that reads for it either. This is the runtime backstop
// for both halves: it extracts the line the prompt's own wording requires
// (`CWD-AUDIT: clean|dirty|unrepo <path> …`), and reports the line's absence
// exactly as loudly as its presence, so `runReview` can fold the result into
// the payload below instead of the fact dead-ending inside a field nothing
// reads.
const CWD_AUDIT_LINE = /CWD-AUDIT:\s*(clean|dirty|unrepo)\b.*/;

export function cwdAuditFrom(text) {
  const m = typeof text === "string" ? text.match(CWD_AUDIT_LINE) : null;
  return m ? { state: m[1], line: m[0].trim() } : { state: "missing", line: null };
}

export function verdictFor(dispatched, votes) {
  const live = votes.filter(Boolean);
  const refuted = live.filter((v) => v.refuted).length;
  let verdict;
  if (live.length === 0) verdict = "unverified";
  else verdict = refuted * 2 >= live.length ? "refuted" : "survived";
  return { verdict, votes: live, refutersDispatched: dispatched };
}

// The one function that is NOT byte-identical to review-pr.js's copy, and
// deliberately so — Gap 1's ruling (re-run, no cache) is a HARNESS fact, not
// a portable one. `harness` selects which half of the ruling applies:
// "claude" reproduces review-pr.js's own hardcoded message so the two stay
// substantively in sync (review-core-parity.test.mjs pins that they agree on
// every word except the resume verb itself); "omp" reports re-run, because
// nothing in eval/task memoizes a subagent dispatch by run id across
// separate tool invocations (#1349 gap 1; #1296 Q5#1).
export function resumeFor(unverified, harness) {
  const crashed = unverified.filter((f) => f.refutersDispatched > 0);
  if (!crashed.length) return { crashed, resume: null };
  const claim =
    "Findings in `unverified` with `refutersDispatched` above zero and no surviving vote had every refuter die — nothing looked at them. Resume before deferring them: ";
  const verb =
    harness === "claude"
      ? "relaunch with `Workflow({scriptPath, resumeFromRunId})`, passing the runId this run's tool result reports. The unchanged prefix of agent() calls replays from cache and only the calls that died run live."
      : "re-run the review. omp's eval has no cached-replay mechanism (ADR 0004/0005, #1349 gap 1) — every agent() dispatch on a fresh run is a live call, so the whole review runs again rather than only the crashed legs.";
  return { crashed, resume: claim + verb };
}

// --- Orchestration ----------------------------------------------------
// review-pr.js's own top-level script body, as a callable function. `host`
// supplies `agent(prompt, opts)` (must resolve to PARSED DATA — a rejection
// or an unresolvable dispatch must resolve to `null`, matching Claude's
// "agent() returns null on exhaustion" contract that every guard below is
// written against), `phase(title)`, `log(message)`, and OPTIONALLY
// `pipeline`/`parallel` (see defaultPipeline/defaultParallel below for the
// omp shim's implementation of both, built from #1296 Q3's analysis).
function defaultParallel(fns) {
  return Promise.all(fns.map((fn) => fn()));
}

// Per-item independence, INCLUDING the null short-circuit review-pr.js's own
// comment on `unrunCrashed` describes ("the harness runs `if (result ===
// null) break` before handing a dimension to the next stage"): a stage-1
// throw or a stage-1 falsy result must land in the SAME null slot a stage-2
// throw would, so `unrunCrashed`'s index-aligned read of the pipeline result
// sees one uniform shape for every crash cause (#1296 Q3).
async function defaultPipeline(items, stage1, stage2) {
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

export async function runReview(host, args) {
  const { agent, phase, log } = host;
  const pipeline = host.pipeline ?? defaultPipeline;
  const parallel = host.parallel ?? defaultParallel;
  // Always "omp" in practice: review-eval.mjs's own harness:"omp" call is the
  // only caller (its header comment), and this code cannot run at all unless
  // the omp registry resolved review-eval.mjs's own path in the first place
  // (fleet-run's Resolver, `fleet-run --path review-eval.mjs`) — so the
  // FLEET_HARNESS=${harness} prefix below can never name an absent registry.
  // A future second omp-side caller passing a different harness value would
  // need this reasoning re-checked, not assumed.
  const harness = host.harness ?? "omp";

  const A = decodeArgs(args);
  const pr = A.pr;
  const branch = A.branch;
  const worktree = A.worktree;
  const scratch = A.scratch || `/tmp/review-pr-${pr}`;
  const runRootParent = `${scratch}/pr${pr}`;
  const runRootPrefix = `${runRootParent}/run-`;
  const verifiers = A.verifiers || 2;
  const verifiersBySeverity = A.verifiersBySeverity || { critical: verifiers, important: verifiers, suggestion: 0 };
  const verifiersFor = (sev) => verifiersBySeverity[sev] ?? verifiers;

  if (!pr || !worktree) throw new Error("review-pr: args.pr and args.worktree are required");

  // #878. The truthiness check above is what made the CLI fail-open REACHABLE:
  // `pr` is interpolated into `gh pr diff ${pr}`, `gh pr view ${pr}` and
  // `diff-stats.mjs --pr ${pr}` in the snapshot prompt below, and a branch name
  // passes all three — `gh` resolves a non-numeric ref as a BRANCH, so the
  // snapshot is a real diff belonging to whatever PR that branch heads while
  // every return value here still reports the string that was passed. It is
  // also a PATH component by then (`scratch`, `runRootParent` above), so a
  // value like `../x` names a run root outside the scratch tree.
  //
  // REFUSED, never coerced. `Number(pr)` would make a bad value the string
  // "NaN" at every one of those interpolation sites — a plausible-looking
  // scratch directory and a `gh pr view NaN` — which is the same fail-open one
  // level up. Here rather than downstream for the reason stated beside
  // `explicitDimensions` below: validating late buys a snapshot agent and a
  // directory on disk before a one-character mistake can be refused.
  //
  // isDigits() coerces, so a caller passing the NUMBER 42 (the fleet's own
  // shape) and one passing "42" both pass, and `null`/`undefined` answer false
  // — which is why this sits BELOW the required-args throw and never merged
  // into it: an absent `pr` is owed "required", not a complaint about digits.
  if (!isDigits(pr)) throw new Error(`review-pr: args.pr must be a PR number, got ${JSON.stringify(pr)}`);

  const explicitDimensions = resolveDimensions(A.dimensions, DEFAULT_DIMENSIONS);

  phase("Snapshot");
  const snap = await agent(
    `In ${worktree}, cut an immutable review snapshot, then size the PR's diff.

    unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_TEMPLATE_DIR
    [ -n "${scratch}" ] || { echo SNAPSHOT_SCRATCH_UNSET; exit 1; }
    mkdir -p "${runRootParent}" || { echo SNAPSHOT_RUNROOT_FAILED; exit 1; }
    RUN=$(mktemp -d "${runRootPrefix}XXXXXXXX") || { echo SNAPSHOT_RUNROOT_FAILED; exit 1; }
    echo SNAPSHOT_RUN_ROOT="$RUN"
    find "${runRootParent}" -maxdepth 1 -type d -name 'run-*' -mtime +7 -exec rm -rf {} + || echo SNAPSHOT_PRUNE_FAILED
    SHA=$(git -C ${worktree} rev-parse --short HEAD) || { echo SNAPSHOT_REVPARSE_FAILED; exit 1; }
    SNAP="$RUN/snapshot-$SHA"
    echo SNAPSHOT_DEST="$SNAP"
    mkdir -p "$SNAP"
    git -C ${worktree} archive HEAD | tar -x -C "$SNAP"
    [ -n "$(ls -A "$SNAP")" ] && echo SNAPSHOT_NONEMPTY || echo SNAPSHOT_EMPTY
    ( cd "$SNAP" && git init -q && git add -A -f && git -c user.name=fleet -c user.email=fleet@invalid commit -q --no-verify -m "review snapshot of $SHA" ) || echo SNAPSHOT_INIT_FAILED
    SNAPTREE=$(git -C "$SNAP" rev-parse 'HEAD^{tree}' 2>/dev/null); SRCTREE=$(git -C ${worktree} rev-parse 'HEAD^{tree}')
    { [ -d "$SNAP/.git" ] && [ -n "$SNAPTREE" ] && [ "$SNAPTREE" = "$SRCTREE" ]; } && echo SNAPSHOT_TREE_MATCH || echo SNAPSHOT_TREE_MISMATCH="snapshot $SNAPTREE vs commit $SRCTREE"
    [ -d "$SNAP/.git" ] && printf 'node_modules\\n' >> "$SNAP/.git/info/exclude"
    if [ -n "$SNAP" ] && [ -d ${worktree}/node_modules ]; then ln -s ${worktree}/node_modules "$SNAP/node_modules"; fi

Report \`pathVerified\` = true ONLY if the 'ls -A' line printed SNAPSHOT_NONEMPTY,
run in that order — BEFORE the 'git init' and BEFORE the symlink, never after
either. Both create an entry of their own, so a probe below them prints
SNAPSHOT_NONEMPTY on a 'git archive' that extracted nothing at all.

Report \`repoVerified\` = true ONLY if the last line above printed
SNAPSHOT_TREE_MATCH; otherwise report it false and put the line it printed
instead — SNAPSHOT_INIT_FAILED, or the whole SNAPSHOT_TREE_MISMATCH= value with
both hashes — in \`repoError\`. The init is what makes the snapshot MEASURABLE:
specialists run this repository's own suite in there, and a suite with tests
that need a working tree reports fewer passes and more failures in a bare
extraction than in a checkout at the same commit, with nothing in the payload
saying the measurement happened somewhere else (#1056). The tree-hash compare is
the verification: two commits whose trees hash the same hold byte-identical
content, so a match settles that the snapshot IS the reviewed tree — a stronger
check than reading a few files, and the reason the commit comes BEFORE the
node_modules symlink, which would otherwise enter the index and change the hash.

Report \`head\` = the full sha 'git -C ${worktree} rev-parse HEAD' prints — the
destination path carries only the short form. The byte-identity spot check this
step used to ask for is superseded by the tree-hash compare above, which settles
every file in the tree rather than a couple of them. Do not modify ${worktree}.

Every path in the block above is absolute or \`-C\`-anchored on purpose: this
dispatch carries no working directory of its own either, so you start in the
controller's own checkout, and a relative path — a \`tar -x\` with no \`-C\`, a
bare \`git\` — reads or writes THERE (#1433). Add nothing relative to it, and
chain a \`cd\` into "$RUN" or "$SNAP" for anything you run beyond it.

Then capture the PR's diff for the specialists, plus the three facts the caller
needs to judge whether it is usable:

    gh pr diff ${pr} > "$RUN"/pr.diff
    branch=$(gh pr view ${pr} --json headRefName -q .headRefName)
    ref=$(git -C ${worktree} ls-remote origin "refs/heads/$branch" | cut -f1)
    [ -n "$ref" ] || ref=$(git -C ${worktree} ls-remote origin "refs/pull/${pr}/head" | cut -f1)
    echo "$ref"
    gh pr view ${pr} --json headRefOid -q .headRefOid
    wc -l < "$RUN"/pr.diff

Report \`diffPath\` = the SNAPSHOT_RUN_ROOT value with '/pr.diff' appended, ONLY
if 'gh pr diff' exited 0. Report \`refHead\` = the sha the 'echo "$ref"' line
printed, \`prHead\` = the headRefOid and \`diffLines\` = the wc -l count. The
branch ref is read FIRST and 'refs/pull/${pr}/head' — the base repo's own copy
of the PR head — ONLY when that first read came back empty, so a PR whose
branch ref resolves never reaches the second read and its operand is the same
branch ref it has always been. The fallback is what covers a fork PR, whose
branch lives on the contributor's remote and so never resolves on 'origin'.
Omit \`refHead\` when BOTH reads failed or printed nothing: an empty read is
neither a match nor a mismatch. Do not judge whether the diff is usable, and do
not withhold one field because another failed: report what you got and let the
caller decide.

Then derive this repository's own test command — FLEET_HARNESS is set
explicitly because this machine carries both harnesses' registries for this
plugin, which makes fleet-run's own ambiguity detection refuse without it
(measured 2026-09-11, PR #1409's first review pass: derive-testcmd.sh died
with "both registries carry ... refusing to guess" and the review reported
testCmdError instead of a usable testCmd):

    FLEET_HARNESS=${harness} ~/.fleet/bin/fleet-run derive-testcmd.sh ${worktree} HEAD

Report \`testCmd\` = its stdout ONLY if it exited 0. If it exited non-zero,
report \`testCmdError\` = its stderr and omit \`testCmd\`.

Then size the diff:

    FLEET_HARNESS=${harness} ~/.fleet/bin/fleet-run diff-stats.mjs --pr ${pr}

Report \`runRoot\` = the SNAPSHOT_RUN_ROOT value and \`path\` = the SNAPSHOT_DEST
value, both copied verbatim — do not reconstruct either. Report the HEAD sha,
and — in \`diffStats\` — the SINGLE-LINE JSON object diff-stats.mjs prints to
STDOUT, copied verbatim. Only runRoot, path, head, pathVerified and repoVerified
are ever required — diffStats, diffPath, diffLines, refHead and prHead are each
omitted independently when their command failed, and repoError only accompanies
a false repoVerified.`,
    { label: "snapshot", phase: "Snapshot", agentType: "fleet-review-snapshot", schema: SNAPSHOT_SCHEMA },
  );

  if (snap) {
    if (typeof snap.head === "string") snap.head = snap.head.trim().toLowerCase();
    if (typeof snap.refHead === "string") snap.refHead = snap.refHead.trim().toLowerCase();
    if (typeof snap.prHead === "string") snap.prHead = snap.prHead.trim().toLowerCase();
  }

  const missingReason = snapshotMissing(snap, runRootPrefix);
  if (missingReason) throw new Error(`review-pr: ${missingReason}`);

  log(`snapshot ${snap.head} at ${snap.path} — branch ref ${snap.refHead || "(absent): head check SKIPPED"} — PR head ${snap.prHead ?? "(absent)"}`);
  log(environmentNote(snap));

  const testCmd = resolveTestCmd(A.testCmd, snap);
  log(`testCmd ${A.testCmd ? "(caller override)" : "(derived)"} ${testCmd}`);

  const usable = usableDiff(snap);
  log(
    usable
      ? `diff ${usable} (${snap.diffLines} lines)`
      : `no diff — diffPath=${snap.diffPath ?? "(absent)"} diffLines=${snap.diffLines ?? "(absent)"} refHead=${snap.refHead ?? "(absent)"} prHead=${snap.prHead ?? "(absent)"} head=${snap.head} — specialists get the fallback read rules`,
  );

  let stats = null;
  if (snap.diffStats) {
    try {
      stats = JSON.parse(snap.diffStats);
    } catch {
      stats = null;
    }
  }
  const dimensions = explicitDimensions || selectDimensions(DEFAULT_DIMENSIONS, stats);
  log(
    `dimensions ${dimensions.length}/${DEFAULT_DIMENSIONS.length} [${dimensions.map((d) => d.key).join(", ")}]` +
      (stats && stats.profile ? ` — profile=${stats.profile}` : " — profile unknown, full set") +
      (stats && SIZE_TIER_PROFILES.has(stats.profile) && !explicitDimensions ? " — size tier" : ""),
  );
  log(`agents dispatched ${dimensions.map((d) => `${d.key}=${d.agentType}`).join(" ")}`);

  const dimensionsUnrun = [];
  // #1433. Per-dimension record of the specialist's own CWD-AUDIT line (see
  // `cwdAuditFrom` above) — `{dimension, state, line}`, `state` one of
  // "clean"/"dirty"/"unrepo"/"missing". Populated for every dispatched
  // review that returned at all (a crashed dispatch has nothing to audit,
  // and is already named in `dimensionsUnrun` via `unrunCrashed` below), so
  // a dirty checkout, or an omitted audit, reaches the payload instead of
  // dead-ending inside `scope_searched`.
  const cwdAudit = [];

  // #1433. Both prompts below carry the inherited-cwd rule, and it is stated in
  // each rather than shared: review-eval.mjs's own header holds the measurement
  // and the reason this is prompt prose at all (no dispatch primitive on either
  // harness takes a per-call cwd), and #496's brief rules the shared-source
  // route out for exactly these blocks. Three parts, in this order, because the
  // last two are inert without the first: the cwd the specialist starts in is
  // NAMED as a tree it must not write to, `pwd` fixes which directory that is,
  // and the `CWD-AUDIT:` line is what makes a clean run say so — an audit
  // reported only when dirty is indistinguishable from one never run, the same
  // reading `unrunReason` applies to a `test_run` that reports nothing.
  //
  // The Claude-harness twin of these two dispatches — review-pr.js's own
  // hardcoded Review/Verify `agent()` calls, not importable from here per
  // this file's own header rationale — now carries the same three parts
  // word-for-word (#1673). Its refuter states the cwd clause as its own
  // sentence rather than as this one's trailing "and your shell does not
  // start there" clause, because review-pr-refuter-scratch.test.mjs pins
  // that prompt's scratch-ban run as one unbroken clause and a splice into
  // it reds there; every load-bearing word is the same. Both copies are
  // pinned against each other by review-pr-cwd-isolation.test.mjs, so an
  // edit here that skips review-pr.js reds rather than drifting silently.
  phase("Review");
  const reviewed = await pipeline(
    dimensions,
    (d) =>
      agent(
        `Review PR #${pr} (branch ${branch}) for: ${d.prompt}

READ ONLY FROM THE SNAPSHOT: ${snap.path} (HEAD ${snap.head}) — plus the diff
file named below, if one is given.
Never read or write ${worktree} — other agents are using it.
Run any mutation or probe work inside your own copy of the snapshot.

Your shell starts in NEITHER of those directories, and what it does start in is
a tree you must not write to: this dispatch carries no working directory of its
own, so you begin wherever the controller's own review cell is standing — its
checkout, the tree it reads instruments.sh, ci-state.mjs and every gate decision
out of. A relative path in any command lands THERE, not in the snapshot and not
in your scratch dir. Run \`pwd\` as your FIRST command and keep the path it
prints; that directory is a no-run zone from then on, and every command after it
chains its own \`cd\` into the snapshot or into your scratch dir, both named
above as absolute paths.

${readRules(usableDiff(snap), stats, snap)}

Tests: from the snapshot's root, run exactly this — copy it verbatim:
  ${testCmd}
Do not substitute a command of your own. Whatever you run, report it in
\`test_run\` — the command verbatim and the counts you saw — even when it
failed or produced nothing. 'tests 0' is a FAILED run, not a pass.

${environmentNote(snap)}

A failure you cannot separate from the environment is neither a finding nor a
reason to file nothing — say which it is, beside the counts, in \`test_run\`.
Scratch files go in ${snap.runRoot}/${d.key}/ and nowhere else. Chain the
directory change into the command, \`cd "$D" && git …\`, never
\`cd "$D"; git …\`, so a failed \`cd\` cannot leave a \`git\` command running in the
checkout — and bracket a fixture's own git with \`git rev-parse --show-toplevel\`:
before \`git init\` it must NOT resolve to the repository, and a fresh scratch
dir's \`fatal: not a git repository\` (exit 128) is the pass, not a failure;
before any \`git commit\` it must resolve to your scratch path — compare
resolved forms (\`realpath\`), since \`--show-toplevel\` can report
\`/private/tmp/…\` for a \`/tmp\` scratch dir on macOS.

Report only what you RAN. A claim you reasoned to but did not execute belongs
in 'suggestion', not 'critical'. State your search scope for every negative
claim.

Then audit the directory that first \`pwd\` printed, before you return:
\`git -C <that path> status --porcelain -uall\` — the explicit untracked mode,
never bare \`--porcelain\`, which a \`status.showUntrackedFiles=no\` config
silences into a false clean. Report the result in \`scope_searched\` as one line
beginning \`CWD-AUDIT:\` — \`CWD-AUDIT: clean <path>\` when it printed nothing,
\`CWD-AUDIT: dirty <path> — <what it printed>\` when it printed anything,
\`CWD-AUDIT: unrepo <path>\` when git answered \`fatal: not a git repository\` —
every run, clean or not: a clean tree is the result this check exists to
produce, and an omitted line reads exactly like a check never run. Three PRs
reviewed from one cell left four files modified in that checkout with nothing in
any payload saying so (#1433), so a path you cannot account for is still yours
to name.`,
        { label: `review:${d.key}`, phase: "Review", agentType: d.agentType, schema: FINDINGS_SCHEMA },
      ),

    (review, d) => {
      dimensionsUnrun.push(...unrunEntries(review, d.key));
      cwdAudit.push({ dimension: d.key, ...cwdAuditFrom(review && review.scope_searched) });
      phase("Verify");
      return parallel(
        (review && review.findings ? review.findings : []).map((f, fi) => () => {
          const n = verifiersFor(f.severity);
          if (n === 0) return Promise.resolve({ ...f, dimension: d.key, ...verdictFor(0, []) });
          return parallel(
            Array.from({ length: n }, (_, i) => () =>
              agent(
                `Try to REFUTE this finding from PR #${pr}. Default to refuted=true if uncertain.

  claim:    ${f.claim}
  where:    ${f.file || "?"}:${f.line || "?"}
  evidence: ${f.evidence}

Verify against the snapshot ${snap.path} by RUNNING something — compile it, run
the test, apply the mutation. Do not reason your way to agreement.

Chain the directory change into the command, \`cd "$D" && git …\`, never
\`cd "$D"; git …\`, so a failed \`cd\` cannot leave a \`git\` command running in the
checkout — and bracket a fixture's own git with \`git rev-parse --show-toplevel\`:
before \`git init\` it must NOT resolve to the repository, and a fresh scratch
dir's \`fatal: not a git repository\` (exit 128) is the pass, not a failure;
before any \`git commit\` it must resolve to your scratch path — compare
resolved forms (\`realpath\`), since \`--show-toplevel\` can report
\`/private/tmp/…\` for a \`/tmp\` scratch dir on macOS.

A failure injection with no positive control has produced NO result, never a
negative one. Before you read an injected fault — an env var, an argv word, a
mutant — as having had no effect, prove the injection reached the child: one run
whose output differs with it present versus absent, or the child echoing the
injected value back. Uncontrolled, the cell is unrun — say so in your verdict
instead of reporting a no-effect result. Build such an invocation as an array
expanded braced and quoted — \`cfg=(SETB=1 BADJ=1); env "\${cfg[@]}" sh
./probe.sh\` — or inline the assignments literally — \`env SETB=1 BADJ=1 sh
./probe.sh\`; NEVER from an unquoted scalar — \`cfg="SETB=1 BADJ=1"; env $cfg sh
./probe.sh\` — which under zsh passes ONE argument, sets a variable literally
named \`SETB\` to \`1 BADJ=1\`, never sets \`BADJ\` at all, and still exits 0.
\`env $cfg[@]\` is not the portable spelling either: measured, bash
word-splits it into \`SETB=1\` and \`BADJ=1[@]\`, so the injection variable
is set to a corrupted value, while zsh behaves exactly as with the bare
\`$cfg\` — \`BADJ\` never set, exit 0.

${readRules(usableDiff(snap), stats, snap)}

${environmentNote(snap)}

Lens ${i + 1}: ${i === 0 ? "is the claim true of the code as merged?" : "is it already handled elsewhere, or does the evidence prove something weaker than the claim?"}
Scratch: ${snap.runRoot}/verify-${d.key}/f${fi + 1}-l${i + 1}/
Everything you write — mutants, fixtures, scratch repos — goes there and nowhere
else, and your shell does not start there: this dispatch carries no working
directory of its own, so you begin wherever the controller's own review cell is
standing — its checkout, the tree it reads every gate decision out of — and a
relative path in any command lands THERE. Run \`pwd\` as your FIRST command and
keep the path it prints; that directory is a no-run zone from then on, and the
snapshot and your scratch dir are both named above as absolute paths.
Then audit that directory before you return: \`git -C <that path> status
--porcelain -uall\` — the explicit untracked mode, never bare \`--porcelain\`,
which a \`status.showUntrackedFiles=no\` config silences into a false clean.
Report it in \`reason\` as one line beginning \`CWD-AUDIT:\` —
\`CWD-AUDIT: clean <path>\` when it printed nothing, \`CWD-AUDIT: dirty <path> —
<what it printed>\` when it printed anything, \`CWD-AUDIT: unrepo <path>\` when
git answered \`fatal: not a git repository\` — every run, clean or not: an
omitted line reads exactly like a check never run, and applying a mutation is
how three reviews from one cell left four files modified in that checkout
(#1433).`,
                { label: `verify:${d.key}`, phase: "Verify", agentType: "fleet-review-verifier", schema: VERDICT_SCHEMA },
              ),
            ),
          ).then((votes) => ({ ...f, dimension: d.key, ...verdictFor(n, votes) }));
        }),
      );
    },
  );

  dimensionsUnrun.push(...unrunCrashed(reviewed, dimensions));

  const all = reviewed.flat().filter(Boolean);
  const survived = all.filter((f) => f.verdict === "survived");
  const refuted = all.filter((f) => f.verdict === "refuted");
  const unverified = all.filter((f) => f.verdict === "unverified");

  const { crashed, resume } = resumeFor(unverified, harness);

  log(
    `${survived.length} survived, ${refuted.length} refuted, ${unverified.length} unverified ` +
      `(${crashed.length} of those by crashed refuters), of ${all.length}`,
  );

  const rank = { critical: 0, important: 1, suggestion: 2 };
  const bySeverity = (a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3);

  return {
    pr,
    head: snap.head,
    snapshot: snap.path,
    // #1056. Always present, in both regimes: a reader of this payload can
    // never be left unable to tell an environment artifact from a regression,
    // and that costs nothing when there is nothing wrong to report.
    testEnvironment: environmentNote(snap),
    dimensionsRun: dimensions.map((d) => d.key),
    dimensionsUnrun,
    // #1433. `cwdAuditFrom`'s per-dimension read of the specialist's own
    // CWD-AUDIT line — the fact a dirty or unrepo'd inherited checkout is
    // otherwise reported into `scope_searched` and read by nothing.
    cwdAudit,
    survived: survived.sort(bySeverity),
    refuted,
    unverified: unverified.sort(bySeverity),
    resume,
  };
}
