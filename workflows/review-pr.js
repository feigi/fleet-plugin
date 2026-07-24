export const meta = {
  name: "review-pr",
  description:
    "Fan specialists over one PR from a single immutable snapshot, adversarially verify every finding, return ruling-ready data",
  whenToUse:
    "Called per-PR by /fleet:run-team, or standalone when a PR needs a multi-specialist review whose findings must not be lost in delivery",
  phases: [
    { title: "Snapshot", detail: "cut one immutable copy every specialist reads" },
    { title: "Review", detail: "one specialist per dimension, structured findings" },
    { title: "Verify", detail: "adversarial refute pass, per finding, in parallel" },
  ],
};

// ---------------------------------------------------------------------------
// Why this exists.
//
// The failure this replaces is DELIVERY, not analysis. A reviewer's specialists
// are grandchildren: they cannot be named, so they are unaddressable, and their
// reports surface to the controller rather than to the member that dispatched
// them. In one fleet run, five specialists on one PR and four on another all
// completed and not one report reached its reviewer. The reviewer then either
// duplicated the work or applied rulings summarising reports it had never seen.
//
// Here, agent() returns INTO THIS SCRIPT. There is no delivery path to lose, and
// `schema` makes the return validated data rather than prose to be re-parsed.
// ---------------------------------------------------------------------------

const FINDINGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["dimension", "findings"],
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

const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["refuted", "reason"],
  properties: {
    refuted: { type: "boolean" },
    reason: { type: "string" },
    counter_evidence: { type: "string", description: "Command + output, if any." },
  },
};

const DEFAULT_DIMENSIONS = [
  {
    key: "correctness",
    agentType: "pr-review-toolkit:code-reviewer",
    prompt: "logic errors, missed cases, scope creep beyond the ticket",
  },
  {
    key: "silent-failure",
    agentType: "pr-review-toolkit:silent-failure-hunter",
    prompt:
      "swallowed errors, fallbacks that hide faults, catch blocks that mislabel what failed, and any NEW dereference the diff moved inside an existing try",
  },
  {
    key: "tests",
    agentType: "pr-review-toolkit:pr-test-analyzer",
    prompt:
      "whether each test DISCRIMINATES: apply the mutation it should catch, confirm that test goes red, revert, then apply one it should NOT catch and confirm green. Vary the syntactic form — a guard catching `// whole-line` may let `code; // trailing` through",
  },
  {
    key: "comments",
    agentType: "pr-review-toolkit:comment-analyzer",
    prompt:
      "every added factual assertion checked against the tree, INCLUDING comments in files this diff does not touch but whose claims it falsifies (test-name references, 'N of 3' counts, tracking-issue pointers)",
  },
  {
    key: "types",
    agentType: "pr-review-toolkit:type-design-analyzer",
    prompt: "invariants expressed vs merely documented; casts that erase conformance",
  },
  {
    key: "simplify",
    agentType: "pr-review-toolkit:code-simplifier",
    prompt:
      "simplification opportunities — dead branches, redundant state, needless indirection. REPORT ONLY, read-only: a finding's claim is what to simplify, suggested_fix is the simpler form, severity 'suggestion'. Never edit a file. A simplification that changes observable behavior is a defect, not a suggestion",
  },
];

const pr = args && args.pr;
const branch = args && args.branch;
const worktree = args && args.worktree;
const testCmd = (args && args.testCmd) || "./agent-test";
const scratch = args && args.scratch;
const explicitDimensions = args && args.dimensions; // caller override; else derived from the diff below
const verifiers = (args && args.verifiers) || 2;
const snapshotModel = (args && args.snapshotModel) || "haiku";
const verifierEffort = (args && args.verifierEffort) || "low";

// Verification budget follows apply-probability. A critical/important finding
// gets applied, so a plausible-but-wrong one is expensive: 2 adversarial
// refuters each. A `suggestion` is deferred by review-and-fix, never
// auto-applied — paying the most expensive check on the lowest-stakes finding
// is pure waste, so 0 by default. Override with args.verifiersBySeverity.
const verifiersBySeverity = (args && args.verifiersBySeverity) || {
  critical: verifiers,
  important: verifiers,
  suggestion: 0,
};
const verifiersFor = (sev) => verifiersBySeverity[sev] ?? verifiers;

if (!pr || !worktree) throw new Error("review-pr: args.pr and args.worktree are required");

// Scale the fan-out to the diff. The fleet docs prescribe this ("two or three
// for annotation-only or single-file; the full set for production") but nothing
// computed it, so the full set ran on every PR. Facts come from diff-stats.mjs
// via the snapshot agent; unknown → full set, the safe direction. A caller
// passing args.dimensions overrides entirely.
function selectDimensions(all, stats) {
  // Unknown, unparseable, or empty diff → the full set, the safe direction. An
  // empty `files` array is NOT a signal to trim: `gh` can report no files for a
  // real PR (async diff computation, a transient hiccup), and treating that as
  // "nothing to review" would silently drop three dimensions on production code.
  // Only an affirmatively-reported profile over real files narrows the fan-out.
  if (!stats || !stats.profile || stats.profile === "empty") return all;
  // Strict `=== true`, matching the `hasSrc`/`hasTests` guards below: only an
  // affirmative boolean trims. A corrupt-but-parseable blob with a truthy
  // non-boolean docsOnly must not be the one value that narrows coverage.
  if (stats.docsOnly === true) {
    // Prose/correction PRs: the failure mode is wrong CLAIMS, not logic or
    // types — four correction tickets each shipped a fresh wrong claim. Keep
    // correctness (scope) + comments (every asserted fact vs the tree); drop
    // tests/types/silent-failure/simplify, which have nothing to run, type-check,
    // or simplify.
    const docsDims = all.filter((d) => d.key === "correctness" || d.key === "comments");
    return docsDims.length ? docsDims : all;
  }
  let dims = all;
  if (stats.hasTests === false) dims = dims.filter((d) => d.key !== "tests");
  // No source → nothing to type-check, hunt for swallowed errors in, or simplify.
  if (stats.hasSrc === false)
    dims = dims.filter((d) => d.key !== "types" && d.key !== "silent-failure" && d.key !== "simplify");
  return dims.length ? dims : all;
}

// --- Snapshot -------------------------------------------------------------
// One immutable copy, cut once, read by every specialist. A snapshot cannot
// change under a reader, which kills three distinct collision classes at once:
// mutation probes contaminating concurrent readers, the reviewer editing the
// worktree mid-review, and sibling specialists racing each other. No
// coordination between agents is required, which is why it beats any rule.
phase("Snapshot");
const snap = await agent(
  `In ${worktree}, cut an immutable review snapshot, then size the PR's diff.

    mkdir -p ${scratch}/snapshot
    git -C ${worktree} archive HEAD | tar -x -C ${scratch}/snapshot

Verify it: 'git -C ${worktree} rev-parse HEAD' and confirm a couple of the
diff's files are byte-identical between the snapshot and 'git show HEAD:<path>'.

Then size the diff:

    ~/.claude/skills/fleet/scripts/diff-stats.mjs --pr ${pr}

Report the snapshot's absolute path, the HEAD sha, and — in \`diffStats\` — the
SINGLE-LINE JSON object diff-stats.mjs prints to STDOUT, copied verbatim as one
string (do not re-key it, do not infer its fields). If diff-stats.mjs errors,
omit diffStats entirely (path and head are the only required fields). Do not
modify ${worktree}.`,
  { label: "snapshot", phase: "Snapshot", model: snapshotModel, schema: {
      type: "object",
      additionalProperties: false,
      required: ["path", "head"],
      properties: {
        path: { type: "string" },
        head: { type: "string" },
        // The verbatim single-line JSON from diff-stats.mjs stdout. Parsed by the
        // caller: routing the deterministic classifier's output through the agent
        // as one opaque blob — not six re-typed booleans — means a mangled copy
        // fails JSON.parse and widens to the full set, instead of silently
        // flipping one field and trimming real coverage.
        diffStats: { type: "string" },
      },
    } },
);

log(`snapshot ${snap.head} at ${snap.path}`);

// Parse the diff-stats blob the snapshot agent carried back. A parse failure —
// diff-stats errored, or the agent mangled the copy — leaves stats null, and
// selectDimensions widens to the full set. The classifier stays deterministic
// end to end; the agent only transported an opaque string.
let stats = null;
if (snap.diffStats) {
  try {
    stats = JSON.parse(snap.diffStats);
  } catch (e) {
    log(`diff-stats unparseable (${e.message}) — full set`);
  }
}
const dimensions = explicitDimensions || selectDimensions(DEFAULT_DIMENSIONS, stats);
log(
  `dimensions ${dimensions.length}/${DEFAULT_DIMENSIONS.length} [${dimensions.map((d) => d.key).join(", ")}]` +
    (stats && stats.profile ? ` — profile=${stats.profile}` : " — profile unknown, full set"),
);

// --- Review → Verify ------------------------------------------------------
// pipeline(), not parallel(): a dimension's findings start verifying the moment
// that dimension finishes, rather than waiting for the slowest reviewer. There
// is no cross-dimension dependency, so a barrier here would be pure latency.
const reviewed = await pipeline(
  dimensions,
  (d) =>
    agent(
      `Review PR #${pr} (branch ${branch}) for: ${d.prompt}

READ ONLY FROM THE SNAPSHOT: ${snap.path} (HEAD ${snap.head}).
Never read or write ${worktree} — other agents are using it.
Run any mutation or probe work inside your own copy of the snapshot.
Tests: use '${testCmd}' from the snapshot; never a bare test command, whose
default config tears down a shared container mid-run for every sibling.
Scratch files go in ${scratch}/${d.key}/ and nowhere else.

Report only what you RAN. A claim you reasoned to but did not execute belongs in
'suggestion', not 'critical'. State your search scope for every negative claim.`,
      { label: `review:${d.key}`, phase: "Review", agentType: d.agentType, schema: FINDINGS_SCHEMA },
    ),

  // Adversarial verification. Each finding faces N independent refuters biased
  // toward refusal, because a plausible-but-wrong finding costs more than a
  // missed one: it gets applied. Majority-refuted kills it.
  (review, d) =>
    parallel(
      (review && review.findings ? review.findings : []).map((f) => () => {
        const n = verifiersFor(f.severity);
        // 0 verifiers → unverified, NOT dropped. A deferred suggestion still
        // reaches the controller; it just skips an adversarial pass its
        // apply-probability does not warrant.
        if (n === 0) return Promise.resolve({ ...f, dimension: d.key, verdict: "unverified", votes: [] });
        return parallel(
          Array.from({ length: n }, (_, i) => () =>
            agent(
              `Try to REFUTE this finding from PR #${pr}. Default to refuted=true if uncertain.

  claim:    ${f.claim}
  where:    ${f.file || "?"}:${f.line || "?"}
  evidence: ${f.evidence}

Verify against the snapshot ${snap.path} by RUNNING something — compile it, run
the test, apply the mutation. Do not reason your way to agreement.
Lens ${i + 1}: ${i === 0 ? "is the claim true of the code as merged?" : "is it already handled elsewhere, or does the evidence prove something weaker than the claim?"}
Scratch: ${scratch}/verify-${d.key}/`,
              { label: `verify:${d.key}`, phase: "Verify", effort: verifierEffort, schema: VERDICT_SCHEMA },
            ),
          ),
        ).then((votes) => {
          const live = votes.filter(Boolean);
          const refuted = live.filter((v) => v.refuted).length;
          // Every refuter crashed (spend limit, timeout, terminal error): the
          // finding was NOT verified, so it is `unverified`, not `survived`. It is
          // still returned — surfaced, never dropped — but a consumer keying on
          // "survived" must not read a verification that never ran as one passed.
          let verdict;
          if (live.length === 0) verdict = "unverified";
          else verdict = refuted * 2 >= live.length ? "refuted" : "survived";
          return { ...f, dimension: d.key, verdict, votes: live };
        });
      }),
    ),
);

const all = reviewed.flat().filter(Boolean);
const survived = all.filter((f) => f.verdict === "survived");
const refuted = all.filter((f) => f.verdict === "refuted");
const unverified = all.filter((f) => f.verdict === "unverified");

log(`${survived.length} survived, ${refuted.length} refuted, ${unverified.length} unverified, of ${all.length}`);

const rank = { critical: 0, important: 1, suggestion: 2 };
const bySeverity = (a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3);

// Refuted findings are RETURNED, not dropped. A refutation is itself a claim,
// and the controller has reversed a refutation on new evidence before.
// `unverified` are findings the adversarial pass did not settle — a suggestion
// that skipped it by policy, or one whose refuters all crashed — surfaced
// separately so the caller never mistakes "not checked" for "survived".
// `dimensionsRun` names what actually ran: a trimmed fan-out must say so, never
// read as full coverage.
return {
  pr,
  head: snap.head,
  snapshot: snap.path,
  dimensionsRun: dimensions.map((d) => d.key),
  survived: survived.sort(bySeverity),
  refuted,
  unverified: unverified.sort(bySeverity),
};
