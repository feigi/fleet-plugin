// review-core.mjs — the review body for PR review.
//
// This file holds every host-independent declaration PR review needs: the
// JSON schemas, `usableDiff`, `readRules`, `resolveTestCmd`,
// `decodeArgs`, `selectDimensions`, `resolveDimensions`, `snapshotMissing`,
// `installReason`/`installFinding`, `suiteVerdictOf`/`unrunCrashed`,
// `sharedRunNote`, `copyRule`,
// `verdictFor`, `resumeFor`, and `runReview(host, args)` — the orchestration
// function itself.
//
// review-eval.mjs imports this file directly, a RELATIVE specifier: both
// ship together under the same Install root, so the Resolver is only needed
// ONCE, to find review-eval.mjs itself — never resolve this file's own path
// through the Resolver a second time; that would be two doors where
// CONTEXT.md's Resolver entry says there is exactly one.
//
// `runReview(host, args)` takes an injected `host` object (`agent`, `phase`,
// `log`, and optionally `pipeline`/`parallel`) rather than reading them as
// ambient globals: eval's `agent()` returns a HANDLE, not data, so
// review-eval.mjs's `ompAgent` wrapper adapts it to the synchronous,
// data-returning shape this file reads throughout (see review-eval.mjs's own
// header for that contract, and for why a crashed/rejected dispatch maps to
// `null`, which every guard here — `if (snap) {...}`, `unrunCrashed`,
// `verdictFor` — is written against).
//
// Three imports. arg.mjs's isDigits(): this file is an ordinary
// module, so it consumes the repo's digits rule directly rather than
// declaring its own copy. node:path's `posix`, to normalise a
// scratch path before `runnerScratchRefusal` reads its last component, and
// its `isAbsolute`, to refuse a scratch that is not an absolute path.
// fleet-dir.mjs's scratchRoot(), scratchRootRefusal() and FleetDirUnresolvable.
// scratchRoot() and FleetDirUnresolvable serve the one caller that passes no
// `scratch` at all — a standalone review with no dispatcher — which takes the
// fleet's own scratch root for this repository; scratchRootRefusal() vets every
// scratch, given or defaulted, against landing in a work tree that does not
// ignore it.
//
// `.mjs`, not `.js`: this file was once `review-core.js`, and
// nothing that ships declares a `type`, so Node below 20.19.0/22.7.0 —
// inside the declared consumer floor — read it as CommonJS and
// review-eval.mjs's import of it failed. A suite sweep keeps a
// shipped `.mjs` from importing a relative module under any other extension.

import { isAbsolute, posix } from "node:path";
import { isDigits } from "./arg.mjs";
import { FleetDirUnresolvable, scratchRoot, scratchRootRefusal } from "./fleet-dir.mjs";

// --- Schemas ----------------------------------------------------------
export const FINDINGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["dimension", "scope_searched", "findings"],
  properties: {
    dimension: { type: "string" },
    scope_searched: {
      type: "string",
      description:
        "The exact commands/paths this pass covered. Required so a negative claim is bounded: a grep that found nothing looks identical to a grep never run.",
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
    inconclusive: {
      type: "boolean",
      description:
        "True only when your own check could produce neither a valid red nor a valid green: you abstain, and `reason` names the runs. Left out of the tally, never counted as a crash.",
    },
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
    // `pathVerified` says the tree is THERE; this says the tree is
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
    // The Recipe's `uncovered` as derive-testcmd.sh printed it: the CI test
    // steps the Test entrypoint leaves out, one line of JSON, `[]` for none.
    // `uncoveredError` carries the reader's refusal instead when it could not
    // be read, so an unread list never reads as an empty one.
    uncovered: { type: "string" },
    uncoveredError: { type: "string" },
    // The Recipe's Install step as the snapshot agent read it, and its exit
    // status in the snapshot. Optional, so an absent `installExit` is read
    // as an install that did not succeed, never as one that did:
    // `installError` carries derive-testcmd.sh's refusal when the step could
    // not be read at all.
    installCmd: { type: "string" },
    installExit: { type: "integer" },
    installError: { type: "string" },
    // What `git status --porcelain --untracked-files=all` printed in the
    // snapshot after the Install step, one entry per line, the first twenty
    // at most; `untrackedCount` is how many it printed in all. The
    // repository's own ignore rules decide it, so it is reported, never
    // excluded. `statusError` says the read itself failed, which is not an
    // empty answer.
    untracked: { type: "array", items: { type: "string" } },
    untrackedCount: { type: "integer" },
    statusError: { type: "string" },
  },
};

// What the review's one shared test run reports back. `command` and the
// log path are NOT asked for: the caller handed both out, so it already knows
// them, and an agent's echo of either could only disagree. Every count is
// optional and stays absent when the log does not state it — an absent
// `tests` is how `suiteVerdictOf` learns the run produced no counts at all
// (crash, deadline, no summary), which a typed-in 0 would misreport as a run
// that collected nothing.
export const TEST_RUN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    exitCode: { type: "integer", description: "The TEST_RUN_EXIT value the command block printed." },
    tests: { type: "integer" },
    pass: { type: "integer" },
    fail: { type: "integer" },
    expectedFail: { type: "integer", description: "Tests the runner reports as failing by design (vitest `expected fail`, pytest `xfailed`), never folded into `fail`." },
    cancelled: { type: "integer" },
    skipped: { type: "integer" },
    error: { type: "string", description: "Only when no summary was printed: what happened instead." },
    slotWaitMs: { type: "integer", description: "Milliseconds the command waited for a suite slot, copied from the `SUITE_SLOT_WAIT_MS=<n>` line it printed; absent when the log holds no such line." },
  },
};

// --- Test verdict rules -------------------------------------------------
// The one statement of what a red and a kill are. Every site that scores a
// mutant killed, or files a failing test, carries these paragraphs word for
// word — the prompts below interpolate them, and the Markdown sites (the
// `tests` and verifier agent definitions, run-team's fix-applier and finisher
// briefs) quote them — so a reword lands everywhere or reds a pin. An exit
// status is never a kill on its own: a runner can exit 1 with nothing failing,
// and a load-sensitive test can fail once in a full suite and pass on rerun.
export const VALID_RED_RULE =
  "**Valid red:** a run that completed — the command returned on its own, with no signal and no timeout, deadline or kill having fired — in which the test the claim names is reported failing. An exit ≠ 0 with no failing test is not red, and a different test failing is not red for this claim. A red in the full suite only triggers a narrowed run; it is never evidence on its own.";
export const NARROWED_RUN_RULE =
  "**Narrowed run:** the Test entrypoint with arguments appended, `<testCmd> <args>`. That appended arguments reach the Test entrypoint is all that is promised about them, so a narrowed run counts only if it reports `tests` > 0 and its output names the claimed test. If no narrowing can be proven, run the full `<testCmd>` and read the named test's own result from its output.";
export const KILL_RULE =
  "**Kill:** the mutant produced a valid red in a narrowed run, and the same narrowed command, in the same tree with the mutant reverted, ran a valid green with the named test passing — completed, exit 0, `tests` > 0, `cancelled` 0. A completed exit ≠ 0 with the named test not failing is not a kill, and no kill stands without that green run on the unmutated tree. The result is inconclusive, never a kill, when the red does not reproduce in the narrowed run, when the unmutated tree is red too, or when no usable run exists.";
export const EVIDENCE_LINE_RULE =
  "**Evidence line:** every kill and every valid red you claim carries one line in the claim's own free-text field: `red: <cmd> → exit N, fail K incl <test>; baseline: <cmd> → exit 0, <test> pass`. A failing-test finding filed off the review's shared run carries the `red:` half alone.";
const KILL_RULES = [VALID_RED_RULE, NARROWED_RUN_RULE, KILL_RULE, EVIDENCE_LINE_RULE].join("\n\n");

// --- Dimension catalog --------------------------------------------------
// No dimension carries a `model`/`effort` field —
// dispatch tier lives ONLY in each fleet-owned agent definition's own
// frontmatter. `agentType` is a bare frontmatter `name:` (omp's native
// `agent()` lookup is an exact match on one).
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
    prompt: `whether tests DISCRIMINATE, in whichever of two modes the diff puts you in. **The diff touches or adds a test file:** for each such test, apply the mutation it should catch and confirm a kill, revert, then apply one it should NOT catch and confirm the named test stays green. Vary the syntactic form — a guard catching \`// whole-line\` may let \`code; // trailing\` through. **The diff changes source and touches no test file:** hunt coverage gaps instead. For each piece of behaviour the diff adds or changes in source, apply a mutation to that changed source, run \`<testCmd>\`, and report changed behaviour that no existing test kills: a mutant that survives, with a valid green on the unmutated tree, is a finding. \`<testCmd>\` is the \`command\` your Tests paragraph names, run only in your own copy of the snapshot. A kill is scored by these rules and nothing else:

${KILL_RULES}

An inconclusive result is no evidence either way: file no finding above \`suggestion\` on it, and name the gap — both runs — in \`scope_searched\`.`,
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

// The omp `fleet-review-runner` agent definition's `spawns:`
// frontmatter must allow exactly the agent types dispatched below (the
// snapshot agent, the shared test run's agent, every
// DEFAULT_DIMENSIONS entry, and the verifier) — omp denies every spawn by
// default, and the runner declared no `spawns` at all until this fix.
// Exporting the three literal-only types (snapshot/test-run/verifier have no
// DEFAULT_DIMENSIONS entry of their own) plus the derived full set lets
// a test pin the frontmatter against what this file
// actually dispatches, instead of a hand-copied list that can drift.
export const SNAPSHOT_AGENT_TYPE = "fleet-review-snapshot";
export const TEST_RUN_AGENT_TYPE = "fleet-review-test-run";
export const VERIFIER_AGENT_TYPE = "fleet-review-verifier";
export const SPAWNED_AGENT_TYPES = [
  SNAPSHOT_AGENT_TYPE,
  TEST_RUN_AGENT_TYPE,
  ...DEFAULT_DIMENSIONS.map((d) => d.agentType),
  VERIFIER_AGENT_TYPE,
];

// `single-file` is `files === 1`, `small` is `loc < 30` (diff-stats.mjs's
// computeStats owns both thresholds).
export const SIZE_TIER_PROFILES = new Set(["single-file", "small"]);
// The refuter-budget floor: `correctness`/`silent-failure` miss silently and
// permanently; `comments` sits beside them because a comment-only edit to a
// code file classifies as `src`, never `docs`, and would otherwise get no
// comment review at all.
// Keyed on recoverability of a MISS, never on tier — `verifiersFor` takes a
// severity and nothing else.
export const SIZE_TIER_DIMS = new Set(["correctness", "silent-failure", "comments"]);

// The refuter budget per severity, derived once per run from the caller's
// own `A.verifiers`/`A.verifiersBySeverity` overrides (or the defaults) and
// bound to a `(severity) => count` closure — the suite imports this directly
// rather than re-deriving it from a lifted copy.
export function verifiersFor(A) {
  const verifiers = A.verifiers || 2;
  const by = A.verifiersBySeverity || { critical: verifiers, important: verifiers, suggestion: 0 };
  return (sev) => by[sev] ?? verifiers;
}

// --- Pure functions -------------------------------------------------------
// Every function below was ported byte-identical (function body) from this
// repo's pre-cutover review workflow script's own declaration, before that
// file was retired — see this repo's git history for the full
// historical rationale on each; it is not repeated here to avoid a second
// copy of PROSE disconnecting the way this repo's own "recurring pin defect"
// comment warns a second copy of CODE does.

export function usableDiff(snap) {
  if (!snap.diffPath) return null;
  if (!snap.diffLines) return null;
  // No head check here: the snap must already be admitted by `snapshotMissing`, which owns it.
  return `${snap.runRoot}/pr.diff`;
}

export function readRules(diffPath, stats, snap) {
  let change;
  if (diffPath) {
    change = `The PR's whole diff is at ${diffPath}. Read it FIRST, bounded — it is the
change you are reviewing, and the snapshot around it is context.`;
  } else if (stats && stats.paths && stats.paths.length) {
    const rejected = snap && snap.diffPath ? snap.diffPath : null;
    const header = stats.truncated
      ? `The PR touched at least these files — GitHub capped the list at ${stats.paths.length} of
${stats.truncated}, so there are more it does not name:`
      : `The PR touched exactly these files and no others:`;
    change = `${
      rejected
        ? `A diff was captured at ${rejected} and REJECTED — ${
            snap.diffLines === 0
              ? "it is empty"
              : "its line count was never reported, so nothing measured whether it holds the PR's whole change or nothing at all"
          }. Do not read it.`
        : "No diff file was captured."
    } ${header}
${stats.paths.map((p) => `  ${p.path} (${p.loc} changed)`).join("\n")}`;
  } else {
    change = `No diff file and no file list were captured. Locate the files your
dimension covers by searching the snapshot ('grep -rn', 'ls -R'), then read
them under the bounding rule below: 'wc -l' first.`;
  }

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

// The step a missing Test entrypoint is derived by, named in the refusal so the
// caller — a controller or a reviewer — knows what to run rather than what went
// wrong. derive-testcmd.sh's refusals about the cache name the same
// step; its exit-3 refusals name an environment fault instead, which the caller
// fixes rather than deriving. This one covers the case where the snapshot agent
// reported no reason at all.
const DERIVATION_STEP =
  "run the Recipe derivation step (run-team phase 0, before the first claim) to derive, prove and write the Recipe cache";

export function resolveTestCmd(explicit, snap) {
  if (explicit) return explicit;
  if (snap && snap.testCmd) return snap.testCmd;
  throw new Error(
    `review-pr: no test command for this repository — ${(snap && snap.testCmdError) || `the snapshot agent read no Recipe cache; ${DERIVATION_STEP}`}. Pass args.testCmd to override.`,
  );
}

// The review's one run goes through the suite-slot wrapper, by the Resolver,
// so it counts against the host-wide bound on concurrent full runs. The
// command is one word to the wrapper — it hands the string to `sh -c` itself —
// so it is single-quoted here, each embedded `'` closed, escaped and reopened.
function slotted(cmd) {
  return `~/.fleet/bin/fleet-run suite-slot.mjs '${cmd.replaceAll("'", "'\\''")}'`;
}

// The status suite-slot.mjs exits with when its wait for a slot expired.
const NO_SLOT_EXIT = 75;

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
  // `tests` has two jobs (see its prompt): discriminate the tests a diff touches,
  // or — when the diff has source but no test — find changed behaviour no
  // existing test kills. Only the second survives `hasTests === false`, and only
  // above the size tier: a production-profile diff with source keeps it. The
  // `!== false` on `hasSrc` keeps a blob that lost the field from narrowing.
  const keepsCoverageGap = stats.profile === "production" && stats.hasSrc !== false;
  if (stats.hasTests === false && !keepsCoverageGap) dims = dims.filter((d) => d.key !== "tests");
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

// The "Specialists" section of `commands/review-and-fix.md`
// documents `args.dimensions` as accepting "keys or dimension objects" — but
// until now only objects worked: a key array passed straight through and
// every dereference below (`d.key`, `d.prompt`, `d.agentType` — three) came
// back `undefined`, with no throw and no warning. Resolve strings
// against the workflow's own catalog, and check every object has the three
// fields it REQUIRES AND that each of those is a string — presence alone let
// a non-string field reach the specialist dispatch machinery downstream
// instead of failing at this validated boundary. `model` is no longer a
// fourth optional field: an override entry that still sends one is
// refused outright, loudly, rather than silently accepted and ignored — see
// the check below.
// Anything unresolvable stops the run and names what was not recognised — a
// misconfigured review is worse than no review, because its findings look like
// findings.
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
    return `the tree at ${snap.path} is at ${snap.head}, and the PR's head is at ${snap.refHead} — refusing to review a commit that is not the PR`;
  return null;
}

// What a suite run inside the snapshot is evidence ABOUT, in one
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
//
// What the snapshot reads untracked after the Install step rides on the end
// as one line: the repository's own ignore rules left it, so it is a fact
// about the repository, and the review names it rather than hiding it. The
// line is interpolated into every specialist and refuter prompt and the
// payload, so it carries the first `LISTED_UNTRACKED` entries and a count of
// the rest — a PR that drops its dependency directory from `.gitignore` would
// otherwise put one entry per installed file in each of them; the whole
// status is in the run root's `status.txt`. A status the block could not read
// is said so, never left to read as an empty one.
const LISTED_UNTRACKED = 20;

export function environmentNote(snap) {
  const untracked = snap && Array.isArray(snap.untracked) ? snap.untracked.filter((l) => typeof l === "string" && l.trim()) : [];
  const total = Math.max(untracked.length, snap && Number.isInteger(snap.untrackedCount) ? snap.untrackedCount : 0);
  const shown = untracked.slice(0, LISTED_UNTRACKED);
  const more = total - shown.length;
  let note = repoNote(snap);
  if (snap && typeof snap.statusError === "string" && snap.statusError.trim())
    note += `\nAfter the Install step the snapshot's status could not be read (${snap.statusError.trim()}), so what it left untracked is not known.`;
  if (shown.length)
    note += `\nAfter the Install step the snapshot reads untracked under the repository's own ignore rules: ${shown.join(", ")}${more > 0 ? `, and ${more} more (the whole status is in ${snap.runRoot ?? "the run root"}/status.txt)` : ""}.`;
  note += uncoveredNote(snap);
  return note;
}

// The CI test steps the Recipe's Test entrypoint leaves out, as the snapshot
// agent read them through the cache's one reader, ride on the end as one line
// naming each step and why: a green run here says nothing about them, and no
// specialist runs them. An empty list adds nothing. A list the agent could
// not read, or reported in another shape, is said so — never left to read as
// an empty one.
const oneLine = (s) => s.replace(/\s+/g, " ").trim();
function uncoveredNote(snap) {
  let list = null;
  if (snap && typeof snap.uncovered === "string") {
    try {
      list = JSON.parse(snap.uncovered);
    } catch {
      list = null;
    }
  }
  if (Array.isArray(list) && list.every((u) => u && typeof u.step === "string" && typeof u.reason === "string")) {
    if (!list.length) return "";
    return `\nThe Recipe's Test entrypoint does not run these merge-gating CI test steps, and nothing in this review ran them: ${list.map((u) => `${oneLine(u.step)} (${oneLine(u.reason)})`).join("; ")}.`;
  }
  const why =
    (snap && typeof snap.uncoveredError === "string" && snap.uncoveredError.trim() && oneLine(snap.uncoveredError)) ||
    (snap && typeof snap.uncovered === "string" ? `it reported ${JSON.stringify(oneLine(snap.uncovered))}, not a list of steps` : "the snapshot agent reported nothing for it");
  return `\nWhich merge-gating CI test steps the Recipe's Test entrypoint leaves out could not be read (${why}), so a passing run here is not known to cover them.`;
}

function repoNote(snap) {
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

// The Install step's verdict on the snapshot: null when it ran there and
// exited 0, otherwise why no test of this review can run in it. An absent
// `installExit` is never a success — the step was unreadable (`installError`
// says why) or the snapshot agent dropped the line — because a snapshot
// nothing was installed into measures its own missing dependencies, not the
// tree.
export function installReason(snap) {
  if (snap && snap.installExit === 0) return null;
  if (snap && Number.isInteger(snap.installExit))
    return `the Install step${snap.installCmd ? ` \`${snap.installCmd}\`` : ""} exited ${snap.installExit} in the snapshot (log ${snap.runRoot}/install.log) — nothing it installs is there, so the shared test run was skipped`;
  const why = (snap && typeof snap.installError === "string" && snap.installError.trim()) || "the snapshot agent reported no exit status for it";
  return `the Install step did not run in the snapshot — ${why} — so the shared test run was skipped`;
}

// The one finding an Install step that exits non-zero in the snapshot files
// on the PR, when the snapshot is the reviewed tree. It is the review's own
// measurement, an exit status, not a specialist's claim, so it carries no
// refuter vote — and it claims only what was measured: which tree the step
// ran on and how it exited. Why it exited is not known here, and the same
// status can come from the PR (a script it deleted exits 127) or from the host
// (a kill, a timeout), so the claim says the cause is not established rather
// than naming the PR's defect. The Recipe cache, proven on the base, stays as
// it is. A snapshot that is NOT the reviewed tree (`repoVerified` not true)
// files nothing: an exit there is a fact about a different tree, which
// `environmentNote` already says. An Install step that could not be READ files
// nothing either: that is the Recipe's state, not the PR's.
export function installFinding(snap) {
  if (!snap || snap.repoVerified !== true || !Number.isInteger(snap.installExit) || snap.installExit === 0) return null;
  const cmd = snap.installCmd ? `\`${snap.installCmd}\`` : "the Recipe's Install step";
  return {
    severity: "critical",
    claim: `The Install step exited ${snap.installExit} on this PR's tree: ${cmd}, run from the root of a snapshot of ${snap.head}, so no test of this review ran. The review did not establish why it exited — the PR's tree or this host.`,
    evidence: `The review ran ${cmd} once from the root of ${snap.path} and it exited ${snap.installExit}; its output is in ${snap.runRoot}/install.log.`,
    dimension: "install",
    verdict: "survived",
    votes: [],
    refutersDispatched: 0,
    refutersInconclusive: 0,
  };
}

// Every run-quality verdict below reads the review's ONE shared test
// run — `{command, logPath, exitCode?, tests?, pass?, fail?, expectedFail?,
// cancelled?, skipped?, error?}`, `command`/`logPath` the caller's own and the
// rest the test-run agent's report, or `{command, logPath, unprovisioned}`
// when `installReason` skipped the run — never a specialist's own run: no
// specialist runs the full suite any more, so a verdict on one would judge a
// copy of this.
// `run` null is a caller holding no run at all — runReview always hands one
// over, a null or thrown test-run dispatch arriving as `{error}` — and `tests`
// absent is a run that returned without a count. Both are "no counts", and
// neither is ever a pass. Counts alone are not a pass either: the exit status
// is the command's own verdict, so a run that reports none, or exits non-zero
// with nothing failing or cancelled to account for it, is unusable — a
// coverage gate, a crash after the summary, or an agent that dropped the
// TEST_RUN_EXIT line would otherwise read as green.
function testRunReason(run) {
  if (!run) return "the review's shared test run returned nothing — no counts exist, so no dimension's tests ran";
  if (run.unprovisioned) return run.unprovisioned;
  // The wrapper's wait cap expired: it launched nothing, so there are no
  // counts to judge and the exit status is the wrapper's, not the suite's. A
  // run that printed counts and happened to exit 75 is the suite's own answer
  // and judged below like any other.
  if (run.exitCode === NO_SLOT_EXIT && typeof run.tests !== "number") {
    const waited = /no slot after (\d+)s/.exec(run.error ?? "")?.[1];
    return `no suite slot within ${waited === undefined ? "the wait cap" : `${waited} s`} — the host is at its suite bound; not a test failure`;
  }
  const cmd = run.command || "the test command";
  if (typeof run.tests !== "number")
    return `\`${cmd}\` produced no counts — the shared test run crashed, hit its deadline, or printed no summary${run.error ? ` (${run.error})` : ""} — a failed run, not a pass`;
  if (!run.tests) return `\`${cmd}\` produced 0 tests — a failed run, not a pass`;
  // An expected fail ran: the runner executed it and it failed as declared.
  const executed = run.pass + (run.fail ?? 0) + (run.expectedFail ?? 0);
  if (run.pass === 0 && executed === 0) return `\`${cmd}\` passed nothing and failed nothing — every test skipped, not a pass`;
  if (typeof run.pass === "number" && executed * 2 < run.tests)
    return `\`${cmd}\` passed ${run.pass} and failed ${run.fail ?? 0} of the ${run.tests} tests it collected — most of what it collected never ran`;
  if (typeof run.exitCode !== "number")
    return `\`${cmd}\` reported counts but no exit status — nothing shows the command succeeded, so its counts are not a pass`;
  if (run.exitCode !== 0 && !failingOf(run))
    return `\`${cmd}\` exited ${run.exitCode} but reported no failing or cancelled tests — its counts do not account for the failure, so they are not a pass`;
  return null;
}

// A cancelled test is a failure the runner counts apart from `fail` — node's
// runner exits 1 on one with `fail 0` — so both are the review's to report.
function failingOf(run) {
  return (run.fail || 0) + (run.cancelled || 0);
}

function failingDesc(run) {
  return run.cancelled ? `${run.fail || 0} failing and ${run.cancelled} cancelled tests` : `${run.fail} failing tests`;
}

// The review's single judgement on its shared test run: `{usable, reason}`,
// `reason` null when the run is usable. It reads the run alone — never a
// specialist's findings, and never whether a dimension reviewed: a usable run
// is not a green one (failing tests are the owner dimension's to file), and an
// unusable one says nothing about what the specialists read.
export function suiteVerdictOf(run) {
  const reason = testRunReason(run);
  return { usable: reason === null, reason };
}

export const CRASHED_REASON = "the reviewer returned nothing — spend limit, timeout, or terminal error";

export function unrunCrashed(reviewed, dimensions) {
  return reviewed.flatMap((r, i) => (r ? [] : [{ dimension: dimensions[i]?.key ?? `slot ${i}`, reason: CRASHED_REASON }]));
}

function countsOf(run) {
  return ["tests", "pass", "fail", "expectedFail", "cancelled", "skipped"]
    .filter((k) => typeof run[k] === "number")
    .map((k) => `${k} ${run[k]}`)
    .join(", ");
}

// How a specialist or refuter makes "your own copy of the snapshot", in
// every prompt that sends one to work there. Tracked files only, then the
// Install step in the copy: what an install writes can record absolute paths
// back into the tree it ran in, so a copy that shares the snapshot's
// installed output imports the snapshot's source, and a mutation made in the
// copy never runs.
export function copyRule(snap) {
  const step = snap && snap.installCmd
    ? `the Install step, \`${snap.installCmd}\`,`
    : "the Install step (this review read none, so a copy has nothing installed and a suite run in it does not measure the tree)";
  return `Make your own copy of the snapshot from its tracked files only —
\`git -C ${snap && snap.path} archive HEAD | tar -x -C <copy>\`, or a \`git clone\`
of the snapshot repository — then make it a repository with \`git init\`,
\`git add -A -f\` and a commit (a clone already is one), then run
${step} from the copy's root before you measure anything in it.
Never \`cp -R\` the snapshot, and never symlink or clone its ignored paths: an
install can record absolute paths back into the tree it ran in, so a copy
sharing the snapshot's installed output runs the snapshot's source, and a
mutation in the copy never runs.`;
}

// The Tests paragraph of every specialist prompt: the shared run's
// command, counts, exit status and log path, in place of the instruction to
// run the full suite that each specialist used to follow — one review was up
// to six full sweeps of one immutable snapshot. `owner` is the one dimension
// told to file the finding about failing tests, so the others are told not
// to duplicate it rather than left to race each other to it. A run the
// Install step skipped has no counts and no log to describe, so it gets a
// paragraph of its own.
export function sharedRunNote(run, owner, key) {
  if (run.unprovisioned)
    return `Tests: this review did NOT run its test command: ${run.unprovisioned}.
The review reports its suite verdict not usable for it — do not run the full
command yourself to replace it, and file nothing about the install: the review
reports it itself.
  command: ${run.command}`;
  const lines = [
    `Tests: this review ran its test command ONCE, from the snapshot's root, before
dispatching you. Do NOT run that full command yourself — every dimension reads
this one run. Targeted probes and mutations in your own copy of the snapshot are
still yours to run, and so is the full command in your own copy of the snapshot,
against your own mutant or to reproduce a failure, when no narrowed run can be proven.
  command: ${run.command}
  counts:  ${countsOf(run) || "none — the run produced no counts"}
  exit:    ${run.exitCode ?? "(not reported)"}
  log:     ${run.logPath}
Read the log for anything the counts do not say.`,
  ];
  const why = testRunReason(run);
  if (why)
    lines.push(`This run is NOT usable: ${why}. The review reports its suite verdict not
usable for it — do not run the full command yourself to replace it.`);
  else if (failingOf(run) > 0)
    lines.push(
      key === owner
        ? `It has ${failingDesc(run)}, and filing them is YOUR job in this review:
file at least one finding about them, naming each failing test from the log. A
failing test is filed off this run only on a valid red: rerun it first in a
narrowed run in your own copy of the snapshot, where \`<testCmd>\` is the
command above, and when that run does not show it failing, file no finding
above \`suggestion\` on it and name both runs. A failure you cannot separate
from the environment is still filed — say so in the finding, so it is
reproduced in the worktree before anyone acts on it. A red is read by these
rules and nothing else:

${VALID_RED_RULE}

${NARROWED_RUN_RULE}

${EVIDENCE_LINE_RULE}`
        : `It has ${failingDesc(run)}, and the ${owner} dimension files the finding
about them. Do not file a duplicate — cite a failure as evidence only where it
bears on your own lens.`,
    );
  return lines.join("\n");
}

// The CWD-AUDIT line the Review dispatch below asks a specialist
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

// An abstaining vote (`inconclusive: true`) is left out of the tally exactly
// as a crashed (`null`) one is, so a run that could not decide never breaks a
// tie toward `refuted`. It stays in `votes`, since its `reason` names the runs
// the fix-applier cites, and `refutersInconclusive` counts it — the one field
// that tells an all-abstained finding from an all-crashed one.
export function verdictFor(dispatched, votes) {
  const live = votes.filter(Boolean);
  const decided = live.filter((v) => v.inconclusive !== true);
  const refuted = decided.filter((v) => v.refuted).length;
  let verdict;
  if (decided.length === 0) verdict = "unverified";
  else verdict = refuted * 2 >= decided.length ? "refuted" : "survived";
  return { verdict, votes: live, refutersDispatched: dispatched, refutersInconclusive: live.length - decided.length };
}

// One in-run re-dispatch for a crashed dispatch, before the result is
// assembled — the specialist call and the refuter PAIR are the two units it
// wraps. `crashed(value)` says whether a settled first attempt counts as a
// crash; a THROWN first attempt is handed to it as `null`, because a
// rejection is a crash too (omp's `agent()` can reject before its handle
// exists). A crashed first attempt is dispatched exactly once more and that
// second answer is final, thrown or not, so the caller's existing crash
// handling still sees it.
export function retryCrashed(dispatch, crashed) {
  const again = (first) => (crashed(first) ? dispatch() : first);
  return Promise.resolve()
    .then(() => dispatch())
    .then(again, () => again(null));
}

// omp has no cached-replay mechanism: a fresh
// review re-dispatches every agent() live rather than only the crashed
// legs, and the one re-dispatch this run gets was already spent in-run
// — a crashed finding is reported and deferred, never resumed. Crashed
// means a `null` refuter: an `unverified` finding whose dispatched refuters
// all abstained is no crash, and stays out of this bucket.
export function resumeFor(unverified) {
  const crashed = unverified.filter((f) => f.refutersDispatched > (f.refutersInconclusive ?? 0));
  if (!crashed.length) return { crashed, resume: null };
  const claim =
    "Findings in `unverified` with `refutersDispatched` above `refutersInconclusive` lost a refuter to a crash — a pair whose every vote died was re-dispatched once in-run and died again — and no refuter that ran decided them. ";
  const verb =
    "Defer them as crashed — reported, not acted on: omp's eval has no cached-replay mechanism, so a fresh review re-dispatches every agent() live rather than only the crashed legs, and the in-run retry was this review's one re-dispatch. Re-run nothing for them.";
  return { crashed, resume: claim + verb };
}

// The digest: every field a controller acts on, and nothing bulky.
// The result object LEADS with exactly these keys, in this order
// (`runReview`'s return below) — historically so the pre-cutover harness's
// ~8 KB inline `<result>` cut landed in the finding arrays, never in the
// digest; before this, `resume` was the last key and fell past the cut on a
// large review.
// omp's result goes to a file and the controller reads only named fields
// out of it with `jq` (review-and-fix.md § The review result file), so
// nothing here truncates on key order today — the order is kept for the
// same reason a struct's fields stay ordered: a reader scanning top-down
// meets the fields that matter first.
// `snapshot`, `survived`, `refuted` and `unverified` follow it.
export const DIGEST_KEYS = ["pr", "head", "resume", "testEnvironment", "suiteVerdict", "dimensionsRun", "dimensionsUnrun", "cwdAudit", "counts"];

export function digestOf(result) {
  return Object.fromEntries(DIGEST_KEYS.map((k) => [k, result[k]]));
}

// The digits refusal review-eval.mjs's `runReviewToFile` runs before
// its first attempt, so a dispatch mistake is refused once instead of being
// retried and re-launched under the next runner name. It lives here, not
// there, because review-eval.mjs is a library and arg.mjs's `scripts/*.mjs`
// importers are its CLI roster, each one probed to refuse a stray flag; this
// module already consumes the digits rule on the review path. Null when `pr`
// is a PR number.
export function runnerPrRefusal(pr) {
  return isDigits(pr) ? null : `args.pr must be a PR number, got ${JSON.stringify(pr)}`;
}

// `runReview` owns the review side's `pr<N>/` partition — it appends
// `/pr${pr}` to the scratch it is given — so a scratch whose last component
// is already `pr` plus digits is a caller that partitioned too, and its run
// roots would nest at `<root>/pr<N>/pr<N>/run-*`, below the snapshot prompt's
// prune, which looks only at the run-* directories directly under `pr<N>/`.
// Refused whatever the digits, never coerced: stripping the suffix would
// guess which directory the caller meant.
//
// "Last component" is the one the filesystem resolves, not the last text in
// the string: `.` segments and repeated or trailing slashes are collapsed
// first, so `/x/pr42/.` is refused like `/x/pr42`. A `..` segment is refused
// outright rather than collapsed — the kernel resolves it against a symlink's
// target and `posix.normalize` against the text, so `/x/link/..` can name a
// `pr<N>` directory the lexical answer says it does not. Shared with
// `runReviewToFile` for the reason the digits rule above is. Null when
// `scratch` is acceptable.
export function runnerScratchRefusal(scratch) {
  if (typeof scratch !== "string") return null;
  if (scratch.split("/").includes("..")) {
    return `args.scratch ${JSON.stringify(scratch)} has a ".." segment — pass the scratch root as a path without one`;
  }
  if (!/(?:^|\/)pr\d+\/*$/.test(posix.normalize(scratch))) return null;
  return `args.scratch ${JSON.stringify(scratch)} already ends in a pr<N> directory — pass the scratch root; the review creates <root>/pr<N>/ itself`;
}

// --- Orchestration ----------------------------------------------------
// `host` supplies `agent(prompt, opts)` (must resolve to PARSED DATA — a
// rejection or an unresolvable dispatch must resolve to `null`, the
// contract every guard below is written against), `phase(title)`,
// `log(message)`, and OPTIONALLY `pipeline`/`parallel` (see
// defaultPipeline/defaultParallel below for the omp shim's implementation
// of both).
function defaultParallel(fns) {
  return Promise.all(fns.map((fn) => fn()));
}

// Per-item independence, INCLUDING the null short-circuit: a stage-1 throw
// or a stage-1 falsy result must land in the SAME null slot a stage-2 throw
// would, so `unrunCrashed`'s index-aligned read of the pipeline result sees
// one uniform shape for every crash cause.
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

// A review dispatched by the controller is handed its scratch root; one run on
// its own (`/review-and-fix` with no dispatcher) resolves it the way
// scratch-root.mjs does, through the same functions, and is refused the same
// way when that root would sit inside a work tree that does not ignore it.
function standaloneScratchRoot() {
  let root;
  try {
    root = scratchRoot();
  } catch (e) {
    if (!(e instanceof FleetDirUnresolvable)) throw e;
    throw new Error(`review-pr: no args.scratch, and the scratch root could not be resolved — ${e.message}`);
  }
  const refusal = scratchRootRefusal(root);
  if (refusal !== null) throw new Error(`review-pr: no args.scratch, and ${refusal}`);
  return root;
}

export async function runReview(host, args) {
  const { agent, phase, log } = host;
  const pipeline = host.pipeline ?? defaultPipeline;
  const parallel = host.parallel ?? defaultParallel;

  const A = decodeArgs(args);
  const pr = A.pr;
  const branch = A.branch;
  const worktree = A.worktree;
  // Every dispatch label ends in `:pr${pr}`: the member id the harness derives
  // from a label is all a transcript keeps of it, and member-record.mjs's
  // parseMemberName reads the PR back out of that id to book its cost.
  const forPr = `:pr${pr}`;
  const verifiersForRun = verifiersFor(A);

  if (!pr || !worktree) throw new Error("review-pr: args.pr and args.worktree are required");

  // The truthiness check above is what made the CLI fail-open REACHABLE:
  // `pr` is interpolated into `gh pr diff ${pr}`, `gh pr view ${pr}` and
  // `diff-stats.mjs --pr ${pr}` in the snapshot prompt below, and a branch name
  // passes all three — `gh` resolves a non-numeric ref as a BRANCH, so the
  // snapshot is a real diff belonging to whatever PR that branch heads while
  // every return value here still reports the string that was passed. It is
  // also a PATH component by then (`scratch`, `runRootParent` below), so a
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

  // Resolved only now: the default spawns git, so a missing or malformed `pr`
  // is refused on its own terms before anything is resolved or spawned.
  const scratch = A.scratch === undefined ? standaloneScratchRoot() : A.scratch;
  const runRootParent = `${scratch}/pr${pr}`;
  const runRootPrefix = `${runRootParent}/run-`;

  const scratchRefusal = runnerScratchRefusal(scratch);
  if (scratchRefusal) throw new Error(`review-pr: ${scratchRefusal}`);

  // `runnerScratchRefusal` passes any non-string by contract, so a number or
  // array — or a relative path — would otherwise be interpolated into the
  // snapshot prompt's paths. Refused, never coerced: only an absent `scratch`
  // takes the default above, so a falsy one (`0`, `false`, `""`, `null`) is
  // refused here like any other value that is not an absolute path. Below the
  // suffix check so a relative `pr<N>` still hears that it is partitioned.
  if (typeof scratch !== "string" || !isAbsolute(scratch)) {
    throw new Error(`review-pr: args.scratch must be an absolute path, got ${JSON.stringify(scratch)}`);
  }

  // A given scratch is held to the same rule as the default: the controller
  // hands over the path scratch-root.mjs vetted, but nothing on this side can
  // tell that from a path inside a tracked tree, and `git add -A` there stages
  // the run root. The default was already asked in standaloneScratchRoot().
  if (A.scratch !== undefined) {
    const rootRefusal = scratchRootRefusal(scratch);
    if (rootRefusal !== null) throw new Error(`review-pr: args.scratch: ${rootRefusal}`);
  }

  const explicitDimensions = resolveDimensions(A.dimensions, DEFAULT_DIMENSIONS);

  phase("Snapshot");
  const snap = await agent(
    `In ${worktree}, cut an immutable review snapshot, then size the PR's diff.

    unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_TEMPLATE_DIR
    [ -n "${scratch}" ] || { echo SNAPSHOT_SCRATCH_UNSET; exit 1; }
    mkdir -p "${runRootParent}" || { echo SNAPSHOT_RUNROOT_FAILED; exit 1; }
    RUN=$(mktemp -d "${runRootPrefix}XXXXXXXX") || { echo SNAPSHOT_RUNROOT_FAILED; exit 1; }
    echo SNAPSHOT_RUN_ROOT="$RUN"
    ~/.fleet/bin/fleet-run reclaim-scratch.mjs --pr ${pr} --root "${scratch}" --apply | grep -qF '"failed":[]' || echo SNAPSHOT_PRUNE_FAILED
    SHA=$(git -C ${worktree} rev-parse --short HEAD) || { echo SNAPSHOT_REVPARSE_FAILED; exit 1; }
    SNAP="$RUN/snapshot-$SHA"
    echo SNAPSHOT_DEST="$SNAP"
    mkdir -p "$SNAP"
    git -C ${worktree} archive HEAD | tar -x -C "$SNAP"
    [ -n "$(ls -A "$SNAP")" ] && echo SNAPSHOT_NONEMPTY || echo SNAPSHOT_EMPTY
    ( cd "$SNAP" && git init -q && git add -A -f && git -c user.name=fleet -c user.email=fleet@invalid commit -q --no-verify -m "review snapshot of $SHA" ) || echo SNAPSHOT_INIT_FAILED
    SNAPTREE=$(git -C "$SNAP" rev-parse 'HEAD^{tree}' 2>/dev/null); SRCTREE=$(git -C ${worktree} rev-parse 'HEAD^{tree}')
    { [ -d "$SNAP/.git" ] && [ -n "$SNAPTREE" ] && [ "$SNAPTREE" = "$SRCTREE" ]; } && echo SNAPSHOT_TREE_MATCH || echo SNAPSHOT_TREE_MISMATCH="snapshot $SNAPTREE vs commit $SRCTREE"
    INSTALL=$(~/.fleet/bin/fleet-run derive-testcmd.sh ${worktree} install) && echo SNAPSHOT_INSTALL_STEP="$INSTALL" || { INSTALL=; echo SNAPSHOT_INSTALL_UNREAD; }
    [ -z "$INSTALL" ] || { ( cd "$SNAP" && sh -c "$INSTALL" ) >"$RUN/install.log" 2>&1; echo SNAPSHOT_INSTALL_EXIT=$?; }
    if [ -d "$SNAP/.git" ] && git -C "$SNAP" status --porcelain --untracked-files=all >"$RUN/status.txt"; then head -n 20 "$RUN/status.txt" | sed 's/^/SNAPSHOT_UNTRACKED=/'; echo SNAPSHOT_UNTRACKED_COUNT=$(wc -l <"$RUN/status.txt" | tr -d ' '); else echo SNAPSHOT_STATUS_FAILED; fi

The Install step can take minutes: run the block as ONE blocking foreground
command with a command deadline of 3600 seconds, never backgrounded and never
polled. The Install step takes no suite slot.

Report \`installCmd\` = the SNAPSHOT_INSTALL_STEP value and \`installExit\` = the
SNAPSHOT_INSTALL_EXIT value, both copied as printed. If the block printed
SNAPSHOT_INSTALL_UNREAD instead, omit both and report \`installError\` = what
derive-testcmd.sh printed on stderr. The Install step runs once, in the
snapshot, from its root: never rerun it, never repair a failure, and never run
it anywhere else. A non-zero exit is reported as printed, and the caller files
it as a finding on the PR.

Report \`untracked\` = every SNAPSHOT_UNTRACKED= value, copied as printed, in
order, and omit it when the block printed none; the block prints twenty at most,
so report \`untrackedCount\` = the SNAPSHOT_UNTRACKED_COUNT value, copied as
printed. If the block printed SNAPSHOT_STATUS_FAILED, report \`statusError\` =
SNAPSHOT_STATUS_FAILED: the status could not be read, which is not an empty
status. The repository's own ignore rules decide what reads untracked after the
Install step: list it, and add nothing to the snapshot's \`.git/info/exclude\` or
anywhere else to hide it.

Report \`pathVerified\` = true ONLY if the 'ls -A' line printed SNAPSHOT_NONEMPTY,
run in that order — BEFORE the 'git init', never after it. The init creates an
entry of its own, so a probe below it prints SNAPSHOT_NONEMPTY on a
'git archive' that extracted nothing at all.

Report \`repoVerified\` = true ONLY if the tree-compare line above printed
SNAPSHOT_TREE_MATCH; otherwise report it false and put the line it printed
instead — SNAPSHOT_INIT_FAILED, or the whole SNAPSHOT_TREE_MISMATCH= value with
both hashes — in \`repoError\`. The init is what makes the snapshot MEASURABLE:
the review runs this repository's own suite in there, and a suite with tests
that need a working tree reports fewer passes and more failures in a bare
extraction than in a checkout at the same commit, with nothing in the payload
saying the measurement happened somewhere else. The tree-hash compare is
the verification: two commits whose trees hash the same hold byte-identical
content, so a match settles that the snapshot IS the reviewed tree — a stronger
check than reading a few files, and the reason the commit and the compare come
BEFORE the Install step: 'git add -A -f' stages ignored files too, so whatever
the Install step writes would enter the index and change the hash.

Report \`head\` = the full sha 'git -C ${worktree} rev-parse HEAD' prints — the
destination path carries only the short form. The byte-identity spot check this
step used to ask for is superseded by the tree-hash compare above, which settles
every file in the tree rather than a couple of them. Do not modify ${worktree}.

Every path in the block above is absolute or \`-C\`-anchored on purpose: this
dispatch carries no working directory of its own either, so you start in the
controller's own checkout, and a relative path — a \`tar -x\` with no \`-C\`, a
bare \`git\` — reads or writes THERE. Add nothing relative to it, and
chain a \`cd\` into "$RUN" or "$SNAP" for anything you run beyond it.

Then capture the PR's diff for the specialists, plus the three facts the caller
needs to judge whether it is usable:

    gh pr diff ${pr} > "$RUN"/pr.diff
    crossRepo=$(gh pr view ${pr} --json isCrossRepository -q .isCrossRepository)
    branch=$(gh pr view ${pr} --json headRefName -q .headRefName)
    ref=""
    [ "$crossRepo" = "true" ] || ref=$(git -C ${worktree} ls-remote origin "refs/heads/$branch" | cut -f1)
    [ -n "$ref" ] || ref=$(git -C ${worktree} ls-remote origin "refs/pull/${pr}/head" | cut -f1)
    echo "$ref"
    gh pr view ${pr} --json headRefOid -q .headRefOid
    wc -l < "$RUN"/pr.diff

Report \`diffPath\` = the SNAPSHOT_RUN_ROOT value with '/pr.diff' appended, ONLY
if 'gh pr diff' exited 0. Report \`refHead\` = the sha the 'echo "$ref"' line
printed, \`prHead\` = the headRefOid and \`diffLines\` = the wc -l count. Which
read answers is chosen by \`isCrossRepository\`, not by whether the first read
comes back empty. A same-repo PR's branch cannot collide with anything else on
'origin', so its branch ref is read and is the operand — one network read, same
as before. A cross-repo PR (a fork) skips the branch-ref read entirely and goes
straight to 'refs/pull/${pr}/head' — the base repo's own copy of the PR head —
because a fork's branch NAME is not guaranteed unique against the base
repository, and a same-named hit on 'origin' would silently answer for the
wrong repository rather than for the fork. The fallback to
'refs/pull/${pr}/head' also still fires for a same-repo PR whose branch ref
came back empty, unchanged from before. Omit \`refHead\` when every read this
PR was entitled to came back empty or was skipped: an absent value is neither
a match nor a mismatch. Do not judge whether the diff is usable, and do not
withhold one field because another failed: report what you got and let the
caller decide.

Then read this repository's Test entrypoint out of its Recipe cache:

    ~/.fleet/bin/fleet-run derive-testcmd.sh ${worktree} test

Report \`testCmd\` = its stdout ONLY if it exited 0. If it exited non-zero,
report \`testCmdError\` = its stderr and omit \`testCmd\`. Never derive or
guess a command yourself: a refusal about the cache names the step that
derives it; an exit-3 refusal names an environment fault, and the caller fixes
that instead of deriving.

Then read, out of the same cache, the merge-gating CI test steps that Test
entrypoint leaves out:

    ~/.fleet/bin/fleet-run derive-testcmd.sh ${worktree} uncovered

Report \`uncovered\` = its stdout, one line of JSON copied verbatim, ONLY if it
exited 0. If it exited non-zero, report \`uncoveredError\` = its stderr and omit
\`uncovered\`. Run none of the steps it lists.

Then size the diff:

    ~/.fleet/bin/fleet-run diff-stats.mjs --pr ${pr}

Report \`runRoot\` = the SNAPSHOT_RUN_ROOT value and \`path\` = the SNAPSHOT_DEST
value, both copied verbatim. Each ends in a component the shell substituted —
a 'mktemp' name, and a sha — so neither is readable off this prompt: do not
reconstruct it, and do not report a path the block did not print. The caller
checks both against the run root it provisioned and refuses the review when
they disagree, so a reconstructed path costs the run rather than sending six
specialists into another run's tree. Report the HEAD sha, and — in
\`diffStats\` — the SINGLE-LINE JSON object diff-stats.mjs prints to
STDOUT, copied verbatim. Only runRoot, path, head, pathVerified and repoVerified
are ever required — diffStats, diffPath, diffLines, refHead and prHead are each
omitted independently when their command failed, repoError only accompanies
a false repoVerified, installError only replaces installCmd and installExit,
and uncoveredError only replaces uncovered.`,
    { label: `snapshot${forPr}`, phase: "Snapshot", agentType: SNAPSHOT_AGENT_TYPE, schema: SNAPSHOT_SCHEMA },
  );

  if (snap) {
    if (typeof snap.head === "string") snap.head = snap.head.trim().toLowerCase();
    if (typeof snap.refHead === "string") snap.refHead = snap.refHead.trim().toLowerCase();
    if (typeof snap.prHead === "string") snap.prHead = snap.prHead.trim().toLowerCase();
  }

  const missingReason = snapshotMissing(snap, runRootPrefix);
  if (missingReason) throw new Error(`review-pr: ${missingReason}`);

  log(`snapshot ${snap.head} at ${snap.path} — head ref ${snap.refHead || "(absent): head check SKIPPED"} — PR head ${snap.prHead ?? "(absent)"}`);
  log(environmentNote(snap));

  const testCmd = resolveTestCmd(A.testCmd, snap);
  log(`testCmd ${A.testCmd ? "(caller override)" : "(derived)"} ${testCmd}`);
  // An Install step that failed or never ran leaves a snapshot that cannot
  // measure the tree: the shared run is skipped, the suite verdict is not
  // usable through `testRunReason`, and a non-zero exit is filed as a finding.
  const notInstalled = installReason(snap);
  log(notInstalled ? `install: ${notInstalled}` : `install: ${snap.installCmd ?? "the Install step"} exited 0 in the snapshot`);

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

  // The review's ONE run of the test command, before any specialist is
  // dispatched: every dimension used to run the full suite itself, so one
  // review was up to six full sweeps of one immutable snapshot. NOT wrapped in
  // `retryCrashed`: a crashed dispatch may already have launched the command,
  // so a retry would be a second launch — the load this step removes. A null
  // or thrown answer is a run with no counts, which `suiteVerdictOf` reports as
  // not usable, never a pass.
  const logPath = `${snap.runRoot}/test-run.log`;
  phase("Test run");
  const ran = notInstalled ? null : await agent(
    `Run this repository's test command ONCE, for the review of PR #${pr}, and
report what it printed. Every review specialist reads your counts instead of
running the suite itself, so this is the review's only full run.

Your shell starts in a directory you must not write to: this dispatch carries
no working directory of its own, so you begin wherever the controller's own
review cell is standing, and a relative path in any command lands THERE. The
block below is absolute and cd-chained on purpose — run it exactly as written,
and add nothing relative to it.

Run it as ONE blocking foreground command — never backgrounded, never polled —
with a command deadline of 3600 seconds:

    { cd "${snap.path}" && ${slotted(testCmd)}; } > "${logPath}" 2>&1; echo "TEST_RUN_EXIT=$?"

Run it exactly once: not again when it fails, and not again when it hits the
deadline. A failing run is a result every specialist reads, and a second
launch is the load this step exists to remove.

The command first waits for a free suite slot — the host bounds how many full
suites run at once — and that wait is not part of the run: it can take up to
1800 seconds before the suite starts, which is why the deadline above is longer
than a run's own budget. When it gets a slot it prints a
\`SUITE_SLOT_WAIT_MS=<n>\` line to the log; report \`slotWaitMs\` = that number,
copied as printed, and omit it when the log has no such line. If no slot came
free it launched nothing: TEST_RUN_EXIT is 75 and the log holds
\`suite-slot: no slot after <n>s\`. That is not a test result — report
\`exitCode\` 75, omit every count, copy that line into \`error\`, and do not run
the command again.

Do not substitute a command of your own. In a repo that has a shared test stack,
a bare runner picks up a default config whose setup can tear a sibling's
container down mid-run; a guessed glob is worse in every repo, because one
matching nothing still exits 0 reporting 'tests 0' — a green that ran nothing.
Run it from the snapshot's root, as the block does: a run from a subdirectory
reports a count well below what the whole tree reports, which means it ran a
PARTIAL copy, and nothing downstream can catch that one, because only this run
knows what the full tree reports.

Then read the summary the runner printed at the end of the log —
\`tail -n 40 "${logPath}"\`, ignoring any color escapes — and report
\`exitCode\` = the TEST_RUN_EXIT value, and \`tests\`, \`pass\`, \`fail\`,
\`expectedFail\`, \`cancelled\`, \`skipped\` = the counts that summary states, each
copied as printed; omit any the runner does not print. A test the runner reports
as failing by design (vitest \`expected fail\`, pytest \`xfailed\`) goes in \`expectedFail\`, never in
\`fail\`. Copy the counts, never judge them: 'tests 0' is a FAILED run, not a
pass, and 0 passes with no failures is everything skipped — report both
exactly as printed, and the caller reports its suite verdict not usable for them.

If the command hit its deadline, crashed before printing a summary, or printed
no counts at all, omit every count and say what happened in \`error\`. Never
write 0 for a count the log does not state: an absent count is how the caller
learns the run produced none.`,
    { label: `test-run${forPr}`, phase: "Test run", agentType: TEST_RUN_AGENT_TYPE, schema: TEST_RUN_SCHEMA },
  ).catch((e) => ({ error: `the test-run dispatch threw: ${e?.message ?? e}` }));
  const sharedRun = notInstalled
    ? { command: testCmd, logPath, unprovisioned: notInstalled }
    : { ...(ran || { error: "the test-run agent returned nothing" }), command: testCmd, logPath };
  log(notInstalled ? `shared test run: skipped — ${notInstalled}` : `shared test run: ${countsOf(sharedRun) || "no counts"} — exit ${sharedRun.exitCode ?? "(absent)"} — log ${logPath}`);
  // Failing tests are the review's to report, not each dimension's: the first
  // selected dimension is told to file them, and every other one not to.
  const failureOwner = dimensions[0].key;

  // Per-dimension record of the specialist's own CWD-AUDIT line (see
  // `cwdAuditFrom` above) — `{dimension, state, line}`, `state` one of
  // "clean"/"dirty"/"unrepo"/"missing". Populated for every dispatched
  // review that returned at all (a crashed dispatch has nothing to audit,
  // and is already named in `dimensionsUnrun` via `unrunCrashed` below), so
  // a dirty checkout, or an omitted audit, reaches the payload instead of
  // dead-ending inside `scope_searched`.
  const cwdAudit = [];

  // Both prompts below carry the inherited-cwd rule, and it is stated in
  // each rather than shared: review-eval.mjs's own header holds the measurement
  // and the reason this is prompt prose at all (no dispatch primitive takes a
  // per-call cwd), and the shared-source route is ruled out for
  // exactly these blocks. Three parts, in this order, because the last two are
  // inert without the first: the cwd the specialist starts in is NAMED as a
  // tree it must not write to, `pwd` fixes which directory that is, and the
  // `CWD-AUDIT:` line is what makes a clean run say so — an audit reported
  // only when dirty is indistinguishable from one never run, the same reading
  // `suiteVerdictOf` applies to a shared test run that reports nothing.
  phase("Review");
  const reviewed = await pipeline(
    dimensions,
    // A crashed specialist (null or thrown) is re-dispatched once
    // before it counts as unrun. A specialist that RETURNED is never re-run
    // here — the shared run is judged once, by `suiteVerdictOf`.
    (d) =>
      retryCrashed(
        () =>
          agent(
            `Review PR #${pr} (branch ${branch}) for: ${d.prompt}

READ ONLY FROM THE SNAPSHOT: ${snap.path} (HEAD ${snap.head}) — plus the diff
file named below, if one is given.
Never read or write ${worktree} — other agents are using it.
Run any mutation or probe work inside your own copy of the snapshot.
${copyRule(snap)}

Your shell starts in NEITHER of those directories, and what it does start in is
a tree you must not write to: this dispatch carries no working directory of its
own, so you begin wherever the controller's own review cell is standing — its
checkout, the tree it reads instruments.sh, ci-state.mjs and every gate decision
out of. A relative path in any command lands THERE, not in the snapshot and not
in your scratch dir. Run \`pwd\` as your FIRST command and keep the path it
prints; that directory is a no-run zone from then on, and every command after it
chains its own \`cd\` into the snapshot or into your scratch dir, both named
in this prompt as absolute paths.

${readRules(usableDiff(snap), stats, snap)}

${sharedRunNote(sharedRun, failureOwner, d.key)}

${environmentNote(snap)}

Scratch files go in ${snap.runRoot}/${d.key}/ and nowhere else. Chain the
directory change into the command, \`cd "$D" && git …\`, never
\`cd "$D"; git …\`, so a failed \`cd\` cannot leave a \`git\` command running in the
checkout — and bracket a fixture's own git with \`git rev-parse --show-toplevel\`:
before \`git init\` it must NOT resolve to the host repository, and
\`fatal: not a git repository\` (exit 128) is the usual pass, not a failure — an
outer repository whose ignore rules cover your scratch dir is a pass too;
before any \`git commit\` it must resolve to your scratch path, which catches a
forgotten \`git init\` under any enclosing repository — compare resolved forms
(\`realpath\`), since \`--show-toplevel\` can report a symlinked parent such as
\`/tmp\` or a symlinked \`$HOME\` under its resolved name.

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
any payload saying so, so a path you cannot account for is still yours
to name.`,
            { label: `review:${d.key}${forPr}`, phase: "Review", agentType: d.agentType, schema: FINDINGS_SCHEMA },
          ),
        (review) => !review,
      ),

    (review, d) => {
      cwdAudit.push({ dimension: d.key, ...cwdAuditFrom(review && review.scope_searched) });
      phase("Verify");
      return parallel(
        (review && review.findings ? review.findings : []).map((f, fi) => () => {
          const n = verifiersForRun(f.severity);
          if (n === 0) return Promise.resolve({ ...f, dimension: d.key, ...verdictFor(0, []) });
          // A pair in which no refuter decided and at least one died (or whose
          // dispatch threw) is re-dispatched once, as a pair, before
          // `verdictFor` reads it — one deciding vote means the pair did not
          // crash and is ruled on that vote, and a pair that ALL abstained ran
          // and could not decide, so a second dispatch would only repeat it.
          return retryCrashed(
            () =>
              parallel(
                Array.from({ length: n }, (_, i) => () =>
                  agent(
                    `Try to REFUTE this finding from PR #${pr}. Default to refuted=true if uncertain in your reasoning — a run that could not decide is not that uncertainty, and the abstain rule below covers it.

  claim:    ${f.claim}
  where:    ${f.file || "?"}:${f.line || "?"}
  evidence: ${f.evidence}

Verify against the snapshot ${snap.path} by RUNNING something — compile it, run
the test, apply the mutation. Do not reason your way to agreement. Observe
that run synchronously — run the command, wait for it, read its exit code.
Never poll a log file for a completion marker: prefer ONE blocking run to a
poll loop, and treat its return as permission to look, never as the answer.
Reading a log the run has already finished writing is fine; waiting on one is
not. If you match a test reporter's own output, accepting both \`ℹ\` and \`#\`
is necessary but NOT sufficient — strip SGR escapes first as well. node's
prefix moves with the node version and with whether stdout is a TTY, and
color wraps the whole line so it begins with ESC and no prefix anchor matches
at all, which returns empty at exit 0 — indistinguishable from a hung run and
from a run of zero tests. For an uncolored baseline use \`env -u FORCE_COLOR\`;
\`FORCE_COLOR=\` empty still enables color, so it is not a control. State your
search scope AND what your pattern would have missed. A grep over one ref
does not support a claim about history; a pattern built from the token a diff
removed does not support a claim that the category is empty.

When your check scores a mutant killed or a test red, \`<testCmd>\` is
\`${testCmd}\`, run only in your own copy of the snapshot, and these rules
decide it and nothing else:

${KILL_RULES}

${copyRule(snap)}

Abstain when your own check could produce neither a valid red nor a valid
green: set \`inconclusive\` to true and name the runs in \`reason\`, each with
its evidence line. \`refuted\` is still required, and the tally ignores it on
an abstaining vote — an undecided run never defaults to refuted=true.

Chain the directory change into the command, \`cd "$D" && git …\`, never
\`cd "$D"; git …\`, so a failed \`cd\` cannot leave a \`git\` command running in the
checkout — and bracket a fixture's own git with \`git rev-parse --show-toplevel\`:
before \`git init\` it must NOT resolve to the host repository, and
\`fatal: not a git repository\` (exit 128) is the usual pass, not a failure — an
outer repository whose ignore rules cover your scratch dir is a pass too;
before any \`git commit\` it must resolve to your scratch path, which catches a
forgotten \`git init\` under any enclosing repository — compare resolved forms
(\`realpath\`), since \`--show-toplevel\` can report a symlinked parent such as
\`/tmp\` or a symlinked \`$HOME\` under its resolved name.

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
how three reviews from one cell left four files modified in that checkout.`,
                    { label: `verify:${d.key}${forPr}`, phase: "Verify", agentType: VERIFIER_AGENT_TYPE, schema: VERDICT_SCHEMA },
                  ),
                ),
              ),
            // Retry unless a refuter decided or every one abstained.
            (votes) =>
              !votes ||
              !votes.length ||
              (!votes.some((v) => v && v.inconclusive !== true) && !votes.every((v) => v && v.inconclusive === true)),
          ).then(
            (votes) => ({ ...f, dimension: d.key, ...verdictFor(n, votes) }),
            // A rejection here means retryCrashed's OWN final attempt
            // rejected — both dispatches of this finding's refuter pair
            // crashed, not just returned no votes. Left unhandled, that
            // rejection propagates into the shared `parallel()` above (a bare
            // Promise.all), which rejects the WHOLE dimension and is caught by
            // the coarser per-dimension `catch` in `pipeline()` — discarding
            // every OTHER finding in this dimension too, including ones whose
            // refuters fully succeeded. Folding it into the same shape a
            // live-but-empty vote array already produces (`verdictFor(n, [])`
            // — verdict "unverified", refutersDispatched: n) keeps this
            // finding's crash local: it still flows into `unverified`,
            // `resumeFor`'s `crashed` bucket and `counts.crashed` exactly like
            // a partial-vote crash does, instead of erasing its dimension-mates.
            () => ({ ...f, dimension: d.key, ...verdictFor(n, []) }),
          );
        }),
      );
    },
  );

  const installed = installFinding(snap);
  const all = [...(installed ? [installed] : []), ...reviewed.flat().filter(Boolean)];
  const survived = all.filter((f) => f.verdict === "survived");
  const refuted = all.filter((f) => f.verdict === "refuted");
  const unverified = all.filter((f) => f.verdict === "unverified");

  // A crashed dimension is named with its own reason. The shared run is not
  // a dimension's crash: it is judged once, as `suiteVerdict`, below.
  const dimensionsUnrun = unrunCrashed(reviewed, dimensions);
  const suiteVerdict = suiteVerdictOf(sharedRun);

  const { crashed, resume } = resumeFor(unverified);

  log(
    `${survived.length} survived, ${refuted.length} refuted, ${unverified.length} unverified ` +
      `(${crashed.length} of those by crashed refuters), of ${all.length}`,
  );

  const rank = { critical: 0, important: 1, suggestion: 2 };
  const bySeverity = (a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3);

  // Refuted findings are RETURNED, not dropped. A refutation is itself a claim,
  // and the controller has reversed a refutation on new evidence before.
  // `unverified` are findings the adversarial pass did not settle — a suggestion
  // that skipped it by policy, or one whose refuters crashed or abstained and
  // decided nothing — surfaced separately so the caller never mistakes "not
  // checked" for "survived".
  // `dimensionsRun` names what was DISPATCHED after the size trim: a trimmed
  // fan-out must say so, never read as full coverage. It is not a coverage claim
  // on its own and never was — a specialist can be dispatched and die — so
  // `dimensionsUnrun` names which of those keys returned nothing, and why. A
  // key in the first and NOT in the second returned a review — not that it is
  // covered.
  //
  // `suiteVerdict` is the review's one judgement on its shared test run, apart
  // from both: a run that executed nothing usable does not make a dimension
  // unrun, because the dimensions that returned reviewed and their findings
  // were verified as usual. `suiteVerdictOf` reads the shared run's counts and
  // quotes its command into its message; it never checks that the test-run
  // agent ran the command it was handed rather than a narrower one, so a
  // substituted runner is not classified not usable.
  //
  // `dimensionsRun` and `dimensionsUnrun` are siblings rather than one
  // filtered list because they answer different questions. Subtracting the
  // unrun ones from `dimensionsRun` would make a crashed dimension
  // indistinguishable from one the size tier never dispatched — this ticket
  // set's own defect, moved one field over.
  //
  // Digest first, in DIGEST_KEYS order, bulk last — see DIGEST_KEYS
  // above for why the order is the contract.
  return {
    pr,
    head: snap.head,
    // The recovery, next to the fields a controller reads first; null unless
    // a refuter pair crashed again after the in-run retry.
    resume,
    // Always present, in both regimes: a reader of this payload can
    // never be left unable to tell an environment artifact from a regression,
    // and that costs nothing when there is nothing wrong to report.
    testEnvironment: environmentNote(snap),
    suiteVerdict,
    dimensionsRun: dimensions.map((d) => d.key),
    dimensionsUnrun,
    // `cwdAuditFrom`'s per-dimension read of the specialist's own
    // CWD-AUDIT line — the fact a dirty or unrepo'd inherited checkout is
    // otherwise reported into `scope_searched` and read by nothing.
    cwdAudit,
    counts: { survived: survived.length, refuted: refuted.length, unverified: unverified.length, crashed: crashed.length },
    snapshot: snap.path,
    survived: survived.sort(bySeverity),
    refuted,
    unverified: unverified.sort(bySeverity),
  };
}
