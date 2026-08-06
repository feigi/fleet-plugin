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
// duplicated the work or ruled dimensions uncovered whose reports did exist.
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

// `model` is optional and deliberately absent on three entries. Absent means
// INHERIT, which is not one behaviour: pr-review-toolkit pins `code-reviewer`
// (correctness) and `code-simplifier` (simplify) to `model: opus` in frontmatter,
// while the other four are `model: inherit`. So omitting it keeps a vendor pin
// for two dimensions and follows the session model for one. That frontmatter is
// vendored third-party — editing it is clobbered on the next plugin update, so
// this is the only durable lever.
//
// The rule: downgrade only dimensions whose findings face refuters. A refute
// pass kills false POSITIVES; a cheaper finder's real cost is false NEGATIVES,
// which nothing downstream catches. `simplify` gets 0 refuters by policy, so it
// is not downgraded — its cost is addressed by the size tier instead.
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
    model: "sonnet",
    prompt:
      "whether each test DISCRIMINATES: apply the mutation it should catch, confirm that test goes red, revert, then apply one it should NOT catch and confirm green. Vary the syntactic form — a guard catching `// whole-line` may let `code; // trailing` through",
  },
  {
    key: "comments",
    agentType: "pr-review-toolkit:comment-analyzer",
    model: "sonnet",
    prompt:
      "every added factual assertion checked against the tree, INCLUDING comments in files this diff does not touch but whose claims it falsifies (test-name references, 'N of 3' counts, tracking-issue pointers)",
  },
  {
    key: "types",
    agentType: "pr-review-toolkit:type-design-analyzer",
    model: "sonnet",
    prompt: "invariants expressed vs merely documented; casts that erase conformance",
  },
  {
    key: "simplify",
    agentType: "pr-review-toolkit:code-simplifier",
    prompt:
      "simplification opportunities — dead branches, redundant state, needless indirection. REPORT ONLY, read-only: a finding's claim is what to simplify, suggested_fix is the simpler form, severity 'suggestion'. Never edit a file. A simplification that changes observable behavior is a defect, not a suggestion",
  },
];

// `args` can arrive as a JSON STRING rather than an object. Observed twice on
// this script: every read below returns undefined, and the failure surfaces as
// the required-args throw at the bottom of this block with `duration_ms: 3` and
// `agent_count: 0` — which reads as a bad invocation rather than a serialization
// bug, so it gets re-tried verbatim. Decode first; an object passes through
// untouched. Now that the fleet's default review path is this workflow
// (run-team/SKILL.md's Reviewers section), an undecoded call is a PR nobody
// reviews.
function decodeArgs(a) {
  if (typeof a !== "string") return a || {};
  try {
    return JSON.parse(a);
  } catch (e) {
    throw new Error(`review-pr: args arrived as a string this could not parse (${e.message})`);
  }
}
const A = decodeArgs(args);

const pr = A.pr;
const branch = A.branch;
const worktree = A.worktree;
// The default has to exist in the SNAPSHOT, which is where specialists are told
// to run it — not in the worktree. The snapshot is cut with `git archive HEAD`
// (below), which carries tracked files only, and `agent-test` is written into
// the worktree by `claim-ticket.sh:110` and added to `.git/info/exclude` at :166
// — untracked by construction, so it is never in the archive. `./agent-test` as
// the default therefore handed every specialist `No such file or directory`,
// and they reasoned from source instead of measuring. These paths are tracked.
const testCmd = A.testCmd || "node --test skills/fleet/scripts/*.test.mjs";
// Defaulted, and defaulted PER PR. Undefined it is not caught by the required-
// args guard below, so `mkdir -p undefined/snapshot` succeeds and every agent
// writes to `undefined/<key>/` relative to whatever cwd it picked — and every
// CONCURRENT workflow writes to the same one, which is the sibling-clobbering
// this snapshot design exists to prevent.
const scratch = A.scratch || `/tmp/review-pr-${pr}`;
const explicitDimensions = A.dimensions; // caller override; else derived from the diff below
const verifiers = A.verifiers || 2;
const snapshotModel = A.snapshotModel || "haiku";
const verifierEffort = A.verifierEffort || "low";
// Applies to ALL six dimensions when set — that is what an override is for.
// Unset, each dimension falls back to its own optional `model`, and `undefined`
// inherits. UNVERIFIED, confirm on the first run: whether opts.model beats
// agentType frontmatter in workflow agent(). It does for the Agent tool. Only
// correctness and simplify have a pin to lose, and neither is sent a model here,
// so a wrong answer costs nothing — but read the dispatched model off the
// subagent JSONL once and record it.
const specialistModel = A.specialistModel || null;

// Verification budget follows WHERE a finding gets checked, not how much it
// matters. A critical/important finding is applied off this pass alone — nothing
// downstream re-checks it — so a plausible-but-wrong one is expensive: 2
// adversarial refuters each.
//
// A `suggestion` gets 0 here because its check MOVED, not because it is never
// applied. review-and-fix splits suggestions by scope: out-of-scope ones are
// filed, and each in-scope one gets exactly one refuter from the fix-applier
// before it is applied. Paying for refuters here would price every suggestion
// FOUND; paying there prices only the ones actually APPLIED, which is the
// smaller set and the reason this stays 0.
// Override with args.verifiersBySeverity — but it routes suggestions AROUND the
// scope split rather than into it. One arriving `survived` matches the
// fix-applier's "apply survived" rule before it ever reaches the scope check, so
// an out-of-scope suggestion gets applied; `refuted` ones are not handed over at
// all. Give that band a budget only if you also want it applied unscoped.
const verifiersBySeverity = A.verifiersBySeverity || {
  critical: verifiers,
  important: verifiers,
  suggestion: 0,
};
const verifiersFor = (sev) => verifiersBySeverity[sev] ?? verifiers;

if (!pr || !worktree) throw new Error("review-pr: args.pr and args.worktree are required");

// Thresholds are NOT redefined here. `single-file` is `files === 1` and `small`
// is `loc < 30`, both already named once in diff-stats.mjs's computeStats — this
// reads the profile it already computed rather than re-deriving a size.
const SIZE_TIER_PROFILES = new Set(["single-file", "small"]);
// A trimmed diff still gets the two dimensions whose misses are silent and
// permanent. Of the four dropped, `tests`/`comments`/`types` findings face
// refuters downstream; `simplify` faces none, and this tier is where its cost is
// paid instead. `single-file` is `files === 1` at ANY size, so this trims a
// one-file rewrite too — not only a short diff.
const SIZE_TIER_DIMS = new Set(["correctness", "silent-failure"]);

// Scale the fan-out to the diff. The fleet docs prescribe this ("two or three
// for annotation-only or single-file; the full set for production") but nothing
// computed it, so the full set ran on every PR. Facts come from diff-stats.mjs
// via the snapshot agent; unknown → full set, the safe direction. A caller
// passing args.dimensions overrides entirely.
function selectDimensions(all, stats) {
  // Unknown, unparseable, or empty diff → the full set, the safe direction. An
  // empty `files` array is NOT a signal to trim: `gh` can report no files for a
  // real PR (async diff computation, a transient hiccup), and treating that as
  // "nothing to review" would silently drop FOUR dimensions on production code:
  // an empty profile falls through to both the hasTests and hasSrc branches.
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
  // INTERSECT, never an early return: a single-file `.github/workflows/ci.yml`
  // change is profile "single-file" with hasSrc false, and returning early here
  // would hand silent-failure a YAML file — exactly what the guard above drops.
  //
  // `comments` survives the size trim whenever the diff touches a docs-CLASSIFIED
  // FILE. The docsOnly branch above keeps comment-analyzer because the failure
  // mode of prose is a wrong CLAIM — four correction tickets each shipped a fresh
  // wrong one — but `docsOnly` is strict: a single config or src file in the same
  // diff falsifies it, and the size trim then dropped `comments` outright. That
  // left the mixed prose PR — this repo's modal PR, and its most defect-prone
  // category — with zero comment coverage.
  //
  // It is a file test, NOT a prose test: `classify()` scores any code extension
  // `src` before it checks isDocs, so a comment-only edit to one `.js` file is
  // `docs: 0` and still loses comment coverage. Widening that is #218.
  //
  // `!== 0`, not `> 0`, matching the `=== true` guards above: absence must not be
  // the one value that NARROWS coverage. A blob relayed without `kinds` keeps
  // comment-analyzer rather than silently dropping it.
  //
  // `tests` gets the same carve-out on the same reasoning: when the diff's own
  // substance IS a test, mutation-discrimination is the check it most needs, and
  // a vacuous pin shipping green is this repo's recurring defect. Trimming the
  // test analyzer off a 20-loc test PR drops coverage exactly where it counts.
  if (SIZE_TIER_PROFILES.has(stats.profile))
    dims = dims.filter(
      (d) =>
        SIZE_TIER_DIMS.has(d.key) ||
        (d.key === "comments" && stats.kinds?.docs !== 0) ||
        (d.key === "tests" && stats.hasTests === true),
    );
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

// A dead snapshot agent returns falsy, and every read below dereferences it.
// Unguarded this is a TypeError a hundred lines from its cause; guarded it names
// the one thing the caller can act on — there is no tree, so there is no review.
// The `.filter(Boolean)` guards on the review and verify agents are the same
// rule applied where a partial result is still usable; here it is not.
if (!snap || !snap.path || !snap.head) {
  throw new Error("review-pr: the snapshot agent returned no tree — nothing to review");
}

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
    (stats && stats.profile ? ` — profile=${stats.profile}` : " — profile unknown, full set") +
    (stats && SIZE_TIER_PROFILES.has(stats.profile) && !explicitDimensions ? " — size tier" : ""),
);
// "sent", not "used": this reports what the dispatch passes. `frontmatter` means
// no model was sent, so the agent's own pin decides — which for `correctness` and
// `simplify` is `opus`, NOT the session model. Printing `inherit` there named the
// one behaviour the comment above DEFAULT_DIMENSIONS exists to deny.
log(
  `models sent ${dimensions.map((d) => `${d.key}=${specialistModel || d.model || "frontmatter"}`).join(" ")}`,
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
Tests: from the snapshot's root, run exactly this — copy it verbatim:
  ${testCmd}
Do not substitute a command of your own. A bare runner picks up a default config
that tears down a shared container mid-run for every sibling; a guessed glob is
worse, because one matching nothing still exits 0 reporting 'tests 0' — a green
that ran nothing. Whatever you run, 'tests 0' is a FAILED run, not a pass:
report that dimension as unrun and say the command produced no tests.
Scratch files go in ${scratch}/${d.key}/ and nowhere else.

Report only what you RAN. A claim you reasoned to but did not execute belongs in
'suggestion', not 'critical'. State your search scope for every negative claim.`,
      {
        label: `review:${d.key}`,
        phase: "Review",
        model: specialistModel || d.model,
        agentType: d.agentType,
        schema: FINDINGS_SCHEMA,
      },
    ),

  // Adversarial verification. Each finding faces N independent refuters biased
  // toward refusal, because a plausible-but-wrong finding costs more than a
  // missed one: it gets applied. Majority-refuted kills it.
  (review, d) =>
    parallel(
      (review && review.findings ? review.findings : []).map((f) => () => {
        const n = verifiersFor(f.severity);
        // 0 verifiers → unverified, NOT dropped. The suggestion still reaches
        // the controller; it just skips the adversarial pass HERE, which the
        // fix-applier runs itself for each in-scope one it means to apply.
        // `unverified` is therefore "nothing looked yet", never "not worth
        // looking at".
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
