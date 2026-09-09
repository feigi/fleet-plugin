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
// extracts each shared declaration from both files and asserts the text is
// identical modulo the one thing that is ALLOWED to differ — the `agentType`
// string on each `DEFAULT_DIMENSIONS` entry, bare here
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
  required: ["runRoot", "path", "head", "pathVerified"],
  properties: {
    runRoot: { type: "string" },
    path: { type: "string" },
    head: { type: "string" },
    pathVerified: { type: "boolean" },
    diffStats: { type: "string" },
    diffPath: { type: "string" },
    diffLines: { type: "integer" },
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
  if (snap.prHead && !snap.prHead.startsWith(snap.head) && !snap.head.startsWith(snap.prHead)) return null;
  return `${snap.runRoot}/pr.diff`;
}

export function readRules(diffPath, stats, snap) {
  const rejected = !diffPath && snap && snap.diffPath ? snap.diffPath : null;
  const skew = !!(rejected && snap.diffLines && snap.prHead);
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
            ? `A diff was captured at ${rejected} and REJECTED — ${skew ? `it describes commit ${snap.prHead}, not this snapshot` : "it is empty"}. Do not read it.`
            : "No diff file was captured."
        } ${header}
${stats.paths.map((p) => `  ${p.path} (${p.loc} changed)`).join("\n")}`
      : `No diff file and no file list were captured. Locate the files your
dimension covers by searching the snapshot ('grep -rn', 'ls -R' — git does not
run in it), then read them under the bounding rule below: 'wc -l' first.`;

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
      SIZE_TIER_PROFILES.has(stats.profile) || (stats.profile === "tests-only" && stats.hasConfig === true);
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
  if (!snap.pathVerified)
    return `the snapshot at ${snap.path} was not verified to exist — refusing to hand a possibly-missing tree to every specialist`;
  if (snap.prHead && !snap.prHead.startsWith(snap.head) && !snap.head.startsWith(snap.prHead))
    return `the tree at ${snap.path} is at ${snap.head}, and the PR's head is ${snap.prHead} — refusing to review a commit that is not the PR`;
  return null;
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

  const explicitDimensions = resolveDimensions(A.dimensions, DEFAULT_DIMENSIONS);

  phase("Snapshot");
  const snap = await agent(
    `In ${worktree}, cut an immutable review snapshot, then size the PR's diff.

    [ -n "${scratch}" ] || { echo SNAPSHOT_SCRATCH_UNSET; exit 1; }
    mkdir -p "${runRootParent}" || { echo SNAPSHOT_RUNROOT_FAILED; exit 1; }
    RUN=$(mktemp -d "${runRootPrefix}XXXXXXXX") || { echo SNAPSHOT_RUNROOT_FAILED; exit 1; }
    echo SNAPSHOT_RUN_ROOT="$RUN"
    SHA=$(git -C ${worktree} rev-parse --short HEAD) || { echo SNAPSHOT_REVPARSE_FAILED; exit 1; }
    SNAP="$RUN/snapshot-$SHA"
    echo SNAPSHOT_DEST="$SNAP"
    mkdir -p "$SNAP"
    git -C ${worktree} archive HEAD | tar -x -C "$SNAP"
    [ -n "$(ls -A "$SNAP")" ] && echo SNAPSHOT_NONEMPTY || echo SNAPSHOT_EMPTY
    if [ -n "$SNAP" ] && [ -d ${worktree}/node_modules ]; then ln -s ${worktree}/node_modules "$SNAP/node_modules"; fi

Report \`pathVerified\` = true ONLY if the 'ls -A' line printed SNAPSHOT_NONEMPTY,
run in that order — BEFORE the symlink, never after. Verify it:
'git -C ${worktree} rev-parse HEAD' and confirm a couple of the diff's files are
byte-identical between the snapshot and 'git show HEAD:<path>'. Do not modify
${worktree}.

Then capture the PR's diff for the specialists, plus the two facts the caller
needs to judge whether it is usable:

    gh pr diff ${pr} > "$RUN"/pr.diff
    gh pr view ${pr} --json headRefOid -q .headRefOid
    wc -l < "$RUN"/pr.diff

Report \`diffPath\` = the SNAPSHOT_RUN_ROOT value with '/pr.diff' appended, ONLY
if 'gh pr diff' exited 0. Report \`prHead\` = the headRefOid and \`diffLines\` =
the wc -l count. Do not judge whether the diff is usable, and do not withhold
one field because another failed: report what you got and let the caller
decide.

Then derive this repository's own test command:

    ~/.fleet/bin/fleet-run derive-testcmd.sh ${worktree} HEAD

Report \`testCmd\` = its stdout ONLY if it exited 0. If it exited non-zero,
report \`testCmdError\` = its stderr and omit \`testCmd\`.

Then size the diff:

    ~/.fleet/bin/fleet-run diff-stats.mjs --pr ${pr}

Report \`runRoot\` = the SNAPSHOT_RUN_ROOT value and \`path\` = the SNAPSHOT_DEST
value, both copied verbatim — do not reconstruct either. Report the HEAD sha,
and — in \`diffStats\` — the SINGLE-LINE JSON object diff-stats.mjs prints to
STDOUT, copied verbatim. Only runRoot, path, head and pathVerified are ever
required — diffStats, diffPath, diffLines and prHead are each omitted
independently when their command failed.`,
    { label: "snapshot", phase: "Snapshot", agentType: "fleet-review-snapshot", schema: SNAPSHOT_SCHEMA },
  );

  if (snap) {
    if (typeof snap.head === "string") snap.head = snap.head.trim().toLowerCase();
    if (typeof snap.prHead === "string") snap.prHead = snap.prHead.trim().toLowerCase();
  }

  const missingReason = snapshotMissing(snap, runRootPrefix);
  if (missingReason) throw new Error(`review-pr: ${missingReason}`);

  log(`snapshot ${snap.head} at ${snap.path} — PR head ${snap.prHead ?? "(absent): head check SKIPPED"}`);

  const testCmd = resolveTestCmd(A.testCmd, snap);
  log(`testCmd ${A.testCmd ? "(caller override)" : "(derived)"} ${testCmd}`);

  const usable = usableDiff(snap);
  log(
    usable
      ? `diff ${usable} (${snap.diffLines} lines)`
      : `no diff — diffPath=${snap.diffPath ?? "(absent)"} diffLines=${snap.diffLines ?? "(absent)"} prHead=${snap.prHead ?? "(absent)"} head=${snap.head} — specialists get the fallback read rules`,
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

${readRules(usableDiff(snap), stats, snap)}

Tests: from the snapshot's root, run exactly this — copy it verbatim:
  ${testCmd}
Do not substitute a command of your own. Whatever you run, report it in
\`test_run\` — the command verbatim and the counts you saw — even when it
failed or produced nothing. 'tests 0' is a FAILED run, not a pass.
Scratch files go in ${snap.runRoot}/${d.key}/ and nowhere else.

Report only what you RAN. A claim you reasoned to but did not execute belongs
in 'suggestion', not 'critical'. State your search scope for every negative
claim.`,
        { label: `review:${d.key}`, phase: "Review", agentType: d.agentType, schema: FINDINGS_SCHEMA },
      ),

    (review, d) => {
      dimensionsUnrun.push(...unrunEntries(review, d.key));
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

${readRules(usableDiff(snap), stats, snap)}

Lens ${i + 1}: ${i === 0 ? "is the claim true of the code as merged?" : "is it already handled elsewhere, or does the evidence prove something weaker than the claim?"}
Scratch: ${snap.runRoot}/verify-${d.key}/f${fi + 1}-l${i + 1}/`,
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
    dimensionsRun: dimensions.map((d) => d.key),
    dimensionsUnrun,
    survived: survived.sort(bySeverity),
    refuted,
    unverified: unverified.sort(bySeverity),
    resume,
  };
}
