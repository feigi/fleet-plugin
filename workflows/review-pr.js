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
];

const pr = args && args.pr;
const branch = args && args.branch;
const worktree = args && args.worktree;
const testCmd = (args && args.testCmd) || "./agent-test";
const scratch = args && args.scratch;
const dimensions = (args && args.dimensions) || DEFAULT_DIMENSIONS;
const verifiers = (args && args.verifiers) || 2;

if (!pr || !worktree) throw new Error("review-pr: args.pr and args.worktree are required");

// --- Snapshot -------------------------------------------------------------
// One immutable copy, cut once, read by every specialist. A snapshot cannot
// change under a reader, which kills three distinct collision classes at once:
// mutation probes contaminating concurrent readers, the reviewer editing the
// worktree mid-review, and sibling specialists racing each other. No
// coordination between agents is required, which is why it beats any rule.
phase("Snapshot");
const snap = await agent(
  `In ${worktree}, cut an immutable review snapshot and report ONLY its absolute path.

    mkdir -p ${scratch}/snapshot
    git -C ${worktree} archive HEAD | tar -x -C ${scratch}/snapshot

Then verify it: 'git -C ${worktree} rev-parse HEAD' and confirm a couple of the
diff's files are byte-identical between the snapshot and 'git show HEAD:<path>'.
Report the path and the HEAD sha. Do not modify ${worktree}.`,
  { label: "snapshot", phase: "Snapshot", schema: {
      type: "object",
      additionalProperties: false,
      required: ["path", "head"],
      properties: { path: { type: "string" }, head: { type: "string" } },
    } },
);

log(`snapshot ${snap.head} at ${snap.path}`);

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
      (review && review.findings ? review.findings : []).map((f) => () =>
        parallel(
          Array.from({ length: verifiers }, (_, i) => () =>
            agent(
              `Try to REFUTE this finding from PR #${pr}. Default to refuted=true if uncertain.

  claim:    ${f.claim}
  where:    ${f.file || "?"}:${f.line || "?"}
  evidence: ${f.evidence}

Verify against the snapshot ${snap.path} by RUNNING something — compile it, run
the test, apply the mutation. Do not reason your way to agreement.
Lens ${i + 1}: ${i === 0 ? "is the claim true of the code as merged?" : "is it already handled elsewhere, or does the evidence prove something weaker than the claim?"}
Scratch: ${scratch}/verify-${d.key}/`,
              { label: `verify:${d.key}`, phase: "Verify", schema: VERDICT_SCHEMA },
            ),
          ),
        ).then((votes) => {
          const live = votes.filter(Boolean);
          const refuted = live.filter((v) => v.refuted).length;
          return {
            ...f,
            dimension: d.key,
            verdict: refuted * 2 >= live.length && live.length > 0 ? "refuted" : "survived",
            votes: live,
          };
        }),
      ),
    ),
);

const all = reviewed.flat().filter(Boolean);
const survived = all.filter((f) => f.verdict === "survived");
const refuted = all.filter((f) => f.verdict === "refuted");

log(`${survived.length} survived, ${refuted.length} refuted, of ${all.length}`);

// Refuted findings are RETURNED, not dropped. A refutation is itself a claim,
// and the controller has reversed a refutation on new evidence before.
return {
  pr,
  head: snap.head,
  snapshot: snap.path,
  survived: survived.sort((a, b) => {
    const rank = { critical: 0, important: 1, suggestion: 2 };
    return (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3);
  }),
  refuted,
};
