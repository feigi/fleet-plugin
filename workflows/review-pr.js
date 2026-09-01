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
  // `scope_searched` and `test_run` are required because their ABSENCE is the
  // defect. A field documented "Required" while missing from this array is
  // enforced by nothing, and a specialist that skips it validates clean —
  // reproducing the exact failure the description exists to prevent (#139).
  //
  // Requiring a field is ENFORCED, never best-effort passthrough: a schema forces
  // the subagent to call a StructuredOutput tool, validation happens at the
  // tool-call layer, and a mismatch is retried. Measured 2026-08-17 over
  // `~/.claude/projects/-Users-chris--claude/*/subagents/workflows`: 85
  // transcripts carried `Output does not match required schema`, 184 rejection
  // events in all, every one recovered by retry.
  //
  // RE-COUNTING THIS IS A TRAP, and it caught a reviewer of this very comment.
  // Both strings are quoted verbatim right here, so every transcript that READS
  // this file becomes a match: a naive grep counts its own readers and reports
  // drift that is the observer. Excluding the reading session returns 85/184
  // exactly. For the exhaustion string, match a DIGIT — `after [0-9]+ attempts` —
  // because the `<n>` placeholder appears nowhere but this comment.
  //
  // The retry is BOUNDED, so this is not a zero-risk claim. Exhaustion emits
  // `Failed to provide valid structured output after <n> attempts` and `agent()`
  // then returns null. Real occurrences, counted that way: zero. So this branch is
  // reasoned about rather than observed — and it is `unrunCrashed` that reports
  // that null as unrun, NOT `unrunReason`'s falsy branch: `pipeline()` short-
  // circuits, so a null review never reaches the verify stage to be classified
  // there at all.
  //
  // What a required field must NOT do is demand something a specialist cannot
  // honestly answer — see `test_run`'s own `required` below.
  required: ["dimension", "scope_searched", "findings", "test_run"],
  properties: {
    dimension: { type: "string" },
    scope_searched: {
      type: "string",
      description:
        "The exact commands/paths this pass covered. Required so a negative claim is bounded: a grep that found nothing looks identical to a grep never run.",
    },
    // Where the `'tests 0'` reading rule in the specialist prompt LANDS. The
    // rule shipped without one: a specialist that obeyed it emitted an empty
    // findings list, byte-identical to a clean pass, and the dimension's key
    // stayed in `dimensionsRun` regardless (#137).
    //
    // `command` and `tests` are required and `pass`/`fail` are not, and the
    // split is deliberate. The first two are what bounds the negative claim —
    // a count with no command names nothing a reader can act on. The second
    // two are not always separable from a runner's output, and an
    // unanswerable required field is answered with a guess: a fabricated
    // count is worse than an absent one, because it reads as measurement.
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
// The rule: downgrade a dimension only when a MISS by the cheaper finder is
// RECOVERABLE. Refuters do not separate these six: nothing keys a refuter
// budget off a dimension, because `verifiersFor` takes a severity and nothing
// else. `silent-failure` findings at critical/important therefore draw the same
// refuters `tests` findings do. What separates them is what a miss costs.
// A weak `tests`/`comments`/`types` pass leaves something a later run or a
// reader still catches; a refute pass kills false POSITIVES and never false
// NEGATIVES, so recoverability is the whole of the argument. `correctness` and
// `silent-failure` miss silently and permanently — the same pair, for the same
// reason, that `SIZE_TIER_DIMS` keeps. `simplify` is omitted for the vendored-
// pin reason above instead; it does draw 0 refuters, but VIA SEVERITY — its
// prompt directs every finding to `suggestion`, which is budgeted 0 — and the
// size tier is where its cost is paid.
//
// So the omissions have two causes, and a new dimension needs both asked: is a
// miss recoverable, and does its agent carry a frontmatter pin worth keeping?
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

// The snapshot agent reports three raw values and no judgement. This is the
// judgement, in deterministic code, for the same reason `diffStats` is
// transported as an opaque string (see the `diffStats` schema comment below) and
// parsed by the caller (where it runs `JSON.parse(snap.diffStats)`): an agent
// asked to decide can decide wrong and report a path anyway.
//
// Every clause is a MEASURED failure, not a hypothetical. `gh pr diff 999999`
// exits 1 and still leaves a 0-byte file, which a specialist reads as "this PR
// changed nothing" — the silent green of `tests 0`. And local HEAD can differ
// from the PR's headRefOid (ac110b5 vs 482e523, observed), which hands a
// specialist a diff describing a tree it is not reading.
//
// The head compare is prefix-tolerant in BOTH directions. `prHead` is 40 chars
// from `gh`, but `head` is relayed by an agent asked for "the HEAD sha" — an
// abbreviated but matching sha would compare unequal under `!==` and drop a
// perfectly good diff.
//
// A MISSING prHead is deliberately not disqualifying: `gh pr view` can fail
// while `gh pr diff` succeeded, and dropping a good diff over an absent
// cross-check would let missing input narrow coverage — the inversion the
// `=== true` guards in `selectDimensions` exist to prevent. `diffLines` is the
// deliberate EXCEPTION: absent and 0 are treated alike, because the count is not
// a cross-check but the only measurement that rules out the 0-byte file above.
// Without it, "usable" would be a guess.
function usableDiff(snap) {
  if (!snap.diffPath) return null;
  if (!snap.diffLines) return null;
  if (snap.prHead && !snap.prHead.startsWith(snap.head) && !snap.head.startsWith(snap.prHead)) return null;
  return snap.diffPath;
}

// The read rules every agent in this workflow obeys — specialist and refuter
// alike. One function, two call sites: the Workflow sandbox forbids `import`, so
// this is as close to single-source as this file gets, and
// `review-pr-reads.test.mjs` pins both INTERPOLATIONS rather than the prose.
// Text lifted into a second copy disconnects in one token; that is this repo's
// recurring pin defect.
//
// The read-rule paragraph of the "Specialists" section of
// `skills/fleet/commands/review-and-fix.md` ("`git show <sha>:<path>` is the
// source of truth" … "Then bound the read") owns the prose rationale, for the
// hand-dispatch path. This is the operational form for the workflow path, where
// the premise differs: there is no live worktree to be contaminated BY, because
// the snapshot IS the object store already materialized (the snapshot agent's
// prompt verifies the byte-identity when it cuts the archive). So only the
// BOUNDING half of that rule ports here; the source-of-truth half is true by
// construction and only needs stating, so a specialist stops hunting for a git
// command to settle what the snapshot already settles.
//
// The specialists are pr-review-toolkit agents whose stated default is to read
// `git diff` (code-reviewer.md:21). The snapshot is `git archive HEAD | tar -x`
// and therefore NOT a git repo, so that default fails and the only fallback is
// reading files whole. Handing them the change is the fix; the bounding rule
// alone would only treat the symptom.
//
// The third argument is the raw snapshot report, and it is here for one reason:
// `readRules(diffPath, stats)` structurally cannot know WHY a diff was dropped,
// and both fallback branches lie without that. See `rejected`/`skew` below.
function readRules(diffPath, stats, snap) {
  // A REJECTED diff file still EXISTS. The capture is a shell redirect —
  // `gh pr diff ${pr} > ${scratch}/pr.diff` — so the path is there in every run,
  // inside the scratch dir this same prompt points the specialist at for its own
  // work. On head skew it is also non-empty and authoritative-looking. "No diff
  // file was captured" sent a specialist hunting for a file it can find and must
  // not read; name it and name why instead.
  const rejected = !diffPath && snap && snap.diffPath ? snap.diffPath : null;
  // Head skew is what makes the FILE LIST untrustworthy too: `stats.paths` comes
  // from `gh pr view <pr> --json files`, which describes the PR's head — the
  // exact commit `usableDiff` just rejected the diff for describing. Dropping
  // the diff for the wrong tree and then serving that tree's file list stamped
  // "and no others" is the same error with the evidence removed.
  //
  // #532 narrowed this to a pure-function property: `snapshotMissing` now
  // REFUSES a snapshot whose head is not the PR head, and it runs before
  // anything reaches here, so `skew` cannot be true in this workflow's own
  // path — a rejection with `diffPath` and `diffLines` both present is exactly
  // the head mismatch that already threw. It stays because `readRules` is a
  // pure prompt builder that is pinned as one, not because the branch still
  // fires: deleting it would remove behaviour the tests measure to buy nothing.
  // Re-derive that before relying on either reading — it is true only while the
  // refusal above stays unconditional.
  const skew = !!(rejected && snap.diffLines && snap.prHead);
  // Three headers, one list. `exactly ... and no others` is a CLOSURE claim, and
  // it is only true when the list is both complete and about this tree.
  // `stats.truncated` is set by diff-stats.mjs where the cap is visible: `gh pr
  // view --json files` stops at 100 and exits 0 (measured: 100 listed against
  // `changedFiles` 124), so nothing downstream can tell short from complete.
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

// An explicit caller override always wins. Otherwise the command must be
// DERIVED from the repo under review — this workflow is global config and
// `worktree` is a caller-supplied argument, so a hardcoded default is either
// wrong for a foreign repo or vacuous, a glob matching nothing that exits 0
// reporting `tests 0` (#142). The snapshot agent performs the derivation (see
// its prompt) by running derive-testcmd.sh — the SAME inference
// claim-ticket.sh uses, refusal included, reused rather than reinvented here.
//
// A derivation this workflow cannot read — the script refused, or the agent
// never reported `testCmd` — is treated as no derivation: refuse the review
// outright, never fall back to a guess. `snap.testCmdError` names why when
// the script itself refused; its absence means the agent never ran or never
// reported, which is worth saying too.
function resolveTestCmd(explicit, snap) {
  if (explicit) return explicit;
  if (snap && snap.testCmd) return snap.testCmd;
  throw new Error(
    `review-pr: no test command for this repository — ${(snap && snap.testCmdError) || "the snapshot agent did not derive one"}. Pass args.testCmd to override.`,
  );
}

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
// testCmd is NOT defaulted here — see resolveTestCmd, called once the
// snapshot agent has derived it. This workflow is global config and
// `worktree` is a caller-supplied argument, so any fixed string here is
// either wrong (a foreign repo has no such path) or vacuous (a glob matching
// nothing exits 0 reporting `tests 0` — a silent green). The previous default
// was exactly that everywhere but this repo (#142).
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
// permanent — the same pair, for the same reason, that the model rule above
// `DEFAULT_DIMENSIONS` declines to downgrade. Four are dropped: `tests`,
// `comments`, `types`, `simplify`. NOT because those four alone face refuters
// (#221) — `verifiersFor` takes a severity and nothing else, so the two kept
// here draw exactly the refuters the dropped ones do. A miss in the first three
// is RECOVERABLE: a later run or a reader still catches it. `simplify` is the
// only one of the four the model rule leaves un-downgraded — its `opus` pin is
// vendored — so this tier is where its cost is paid instead. Two of the four,
// `comments` and `tests`, are carved back in below when the diff's own substance
// is theirs; `types` and `simplify` never are. `single-file` is `files === 1` at
// ANY size, so this trims a one-file rewrite too — not only a short diff.
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
  // A capped file list is a MEASUREMENT that is short, not a small PR. `gh pr
  // view --json files` stops at 100 and exits 0, so `loc` under-counts and
  // `docsOnly` can be true only because the src files fell off the end — either
  // one trims dimensions off a production diff. Widen, the safe direction, same
  // as an unparseable blob above.
  if (stats.truncated) return all;
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
  // No source → nothing to type-check or simplify. `silent-failure` was dropped
  // here too until #236, and the SIZE TIER'S FLOOR OUTRANKS THAT (`SIZE_TIER_DIMS`
  // below): this guard runs first, so on a `single-file`/`small` diff it was
  // removing silent-failure before the tier could re-admit it, and the floor
  // `run-team/SKILL.md` documents did not exist for any non-src diff. Measured:
  // PR #226 changed one `.github/workflows/ci.yml` and reviewed CI's own gating
  // logic with `dimensionsRun: ["correctness"]`. A CI-workflow or shell diff is
  // exactly where a swallowed error hides, so the floor wins THERE and the guard
  // still drops silent-failure everywhere else — a 50-loc MULTI-FILE config-only
  // PR profiles `production`, never reaches the tier, and keeps the old behaviour.
  // The floor is the size TIER's, so `tests-only` OUTRANKS it: computeStats
  // assigns that profile ahead of `single-file`/`small`, so a no-src diff that
  // also touches a test file never reaches SIZE_TIER_PROFILES and still loses
  // silent-failure. Out of #236's scope — its ACs are keyed on the two size-tier
  // profiles — and filed as #739.
  if (stats.hasSrc === false)
    dims = dims.filter(
      (d) =>
        d.key !== "types" &&
        d.key !== "simplify" &&
        (d.key !== "silent-failure" || SIZE_TIER_PROFILES.has(stats.profile)),
    );
  // COMPOSES with the guards above rather than replacing them — it filters `dims`,
  // not `all`. Since #236 that composition no longer changes any OUTCOME: every
  // dimension the guards above can remove is one this filter would not have kept
  // anyway (`tests` only when `hasTests === false`, which is the carve-out's own
  // negation; `types`/`simplify` are not in `SIZE_TIER_DIMS`; `comments` and
  // `correctness` are never removed above). `silent-failure` on a no-src diff was
  // the single case where the two forms differed, and it is now deliberately the
  // floor. Kept as a filter regardless: it is the form that stays correct without
  // re-proving that equivalence every time a guard is added above.
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

// The "Specialists" section of `skills/fleet/commands/review-and-fix.md`
// documents `args.dimensions` as accepting "keys or dimension objects" — but
// until now only objects worked: a key array passed straight through and every
// dereference below (`d.key`, `d.prompt`, `d.agentType`) came back `undefined`,
// with no throw and no warning (#113). Resolve strings against the workflow's
// own catalog, and check every object for the three fields the fan-out actually
// dereferences. Anything unresolvable stops the run and names what was not
// recognised — a misconfigured review is worse than no review, because its
// findings look like findings.
function resolveDimensions(override, all) {
  // `== null` is exact where `!override` was not: only an ABSENT override
  // falls through to the size tier. `!override` also swallowed `""`, `0` and
  // `false`, silently trading a caller's pinned set for the heuristic one —
  // measured on a `single-file` diff, `dimensions: ""` against a pin of
  // ["correctness","comments","types"] ran [correctness, silent-failure]
  // instead. Anything else non-array now reaches the throw below.
  if (override == null) return null;
  if (!Array.isArray(override))
    throw new Error("review-pr: args.dimensions must be an array of keys or dimension objects");
  const REQUIRED = ["key", "prompt", "agentType"];
  const resolved = override.map((entry) => {
    if (typeof entry === "string") {
      const found = all.find((d) => d.key === entry);
      if (!found) throw new Error(`review-pr: args.dimensions named an unknown key "${entry}"`);
      return found;
    }
    const missing = REQUIRED.filter((f) => !entry?.[f]);
    if (missing.length)
      throw new Error(`review-pr: args.dimensions object is missing required field(s): ${missing.join(", ")}`);
    return entry;
  });
  // An override resolving to nothing (an empty array) is an error, not a
  // silent no-op — `[] || selectDimensions(...)` would otherwise pass `[]`
  // through unnoticed, since an empty array is truthy.
  if (!resolved.length) throw new Error("review-pr: args.dimensions resolved to no dimensions");
  return resolved;
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

    [ -n "${scratch}" ] || { echo SNAPSHOT_SCRATCH_UNSET; exit 1; }
    rm -rf ${scratch}/snapshot
    mkdir -p ${scratch}/snapshot
    git -C ${worktree} archive HEAD | tar -x -C ${scratch}/snapshot
    [ -n "$(ls -A ${scratch}/snapshot)" ] && echo SNAPSHOT_NONEMPTY || echo SNAPSHOT_EMPTY
    if [ -d ${worktree}/node_modules ]; then ln -s ${worktree}/node_modules ${scratch}/snapshot/node_modules; fi

The guard before the wipe is not decoration: this block is EXECUTED by an
agent's shell, not evaluated by this script, so 'scratch' being non-empty at
interpolation time is a fact about today's caller, not about the text that runs.
Empty, the line reads 'rm -rf /snapshot'. Testing the emitted "${scratch}"
catches that in the shell that runs it. Note a suffix check would NOT: the
'/snapshot' is appended literally here, so it is always present — including on
'rm -rf /snapshot'. Ceiling: the worst reachable target is '/snapshot' (empty
and '/' both land there), so this bounds the blast radius rather than validating
the path in general.

The wipe is not optional. 'mkdir -p' never empties and 'tar -x' MERGES into
whatever is already there, so a reused ${scratch} hands every specialist the
previous run's files. Measured across two PRs sharing one scratch: the snapshot
held files that exist on neither branch nor on main. A merged tree is non-empty
for REAL, so SNAPSHOT_NONEMPTY passes it and \`pathVerified\` then certifies a
tree that is partly some other commit — the exact state it exists to reject.
Every other scratch user is namespaced ('<scratch>/pr<N>/<finding>/'); the
snapshot alone sat at a bare path, which is why it was the one that merged.

The symlink is not optional. 'git archive' carries TRACKED files only, so the
snapshot has no node_modules — and the command derived below is 'npm test --'
for any repo whose scripts.test runs a binary from there, which exits 127 in
the very tree specialists are told to run it in. Skip it and the derivation is
validated where the command never runs (#142). No node_modules in the worktree,
no symlink, nothing to report — that repo does not need one.

Report \`pathVerified\` = true ONLY if the 'ls -A' line printed SNAPSHOT_NONEMPTY.
Run it in the order above — BEFORE the symlink, never after. The symlink alone
makes the directory non-empty, so a check placed below it prints
SNAPSHOT_NONEMPTY on a totally failed 'git archive' in any repo that has
node_modules, which is every repo the symlink exists for.
A directory that exists but holds nothing is what a silently-failed
'git archive | tar -x' looks like — 'git archive' failing or 'gh' auth lapsing
leaves the pipe empty, tar extracts nothing from it, and 'mkdir -p' already made
the directory exist regardless. This is the caller's own check on the tree it is
about to hand every specialist, not your narration of one (#140).

Verify it: 'git -C ${worktree} rev-parse HEAD' and confirm a couple of the
diff's files are byte-identical between the snapshot and 'git show HEAD:<path>'.

Then capture the PR's diff for the specialists, plus the two facts the caller
needs to judge whether it is usable:

    gh pr diff ${pr} > ${scratch}/pr.diff
    gh pr view ${pr} --json headRefOid -q .headRefOid
    wc -l < ${scratch}/pr.diff

Report \`diffPath\` = ${scratch}/pr.diff ONLY if 'gh pr diff' exited 0 — note it
writes an empty file on failure, so a file existing is not success. Report
\`prHead\` = the headRefOid and \`diffLines\` = the wc -l count. Do not judge
whether the diff is usable, and do not withhold one field because another
failed: report what you got and let the caller decide.

Then derive this repository's own test command — reusing the SAME inference
claim-ticket.sh runs at claim time, refusal included, so nothing here
reinvents it:

    ~/.claude/skills/fleet/scripts/derive-testcmd.sh ${worktree} HEAD

Report \`testCmd\` = its stdout ONLY if it exited 0. If it exited non-zero,
report \`testCmdError\` = its stderr and omit \`testCmd\` — never invent a
command of your own when it refuses.

Then size the diff:

    ~/.claude/skills/fleet/scripts/diff-stats.mjs --pr ${pr}

Report the snapshot's absolute path, the HEAD sha, and — in \`diffStats\` — the
SINGLE-LINE JSON object diff-stats.mjs prints to STDOUT, copied verbatim as one
string (do not re-key it, do not infer its fields). If diff-stats.mjs errors,
omit diffStats entirely. Only path, head and pathVerified are ever required —
diffStats, diffPath, diffLines and prHead are each omitted independently when
their command failed. Do not modify ${worktree}.`,
  { label: "snapshot", phase: "Snapshot", model: snapshotModel, schema: {
      type: "object",
      additionalProperties: false,
      required: ["path", "head", "pathVerified"],
      properties: {
        path: { type: "string" },
        head: { type: "string" },
        // The mechanical 'ls -A' check the shell block above runs,
        // REQUIRED so it cannot be silently omitted the way the byte-identity
        // 'Verify it' step above it always could — that step is narration this
        // schema has never captured. `snapshotMissing` below is what turns a
        // false report into a refusal: the caller checks the tree exists rather
        // than trusting the agent said so (#140).
        pathVerified: { type: "boolean" },
        // The verbatim single-line JSON from diff-stats.mjs stdout. Parsed by the
        // caller: routing the deterministic classifier's output through the agent
        // as one opaque blob — not six re-typed booleans — means a mangled copy
        // fails JSON.parse and widens to the full set, instead of silently
        // flipping one field and trimming real coverage.
        diffStats: { type: "string" },
        // All three optional, and each omitted independently. `gh` reaches the
        // network and can fail — no auth, PR deleted, rate limit — and a
        // required field would abort a review that is otherwise fully runnable.
        // `usableDiff()` is what decides whether they add up to a usable diff;
        // the agent only transports them.
        diffPath: { type: "string" },
        diffLines: { type: "integer" },
        prHead: { type: "string" },
        // Derived by this agent running derive-testcmd.sh against the repo
        // under review — reusing claim-ticket.sh's own entrypoint inference
        // and its refusal, never a second copy of that logic here (#142).
        // Omitted when the script refused; testCmdError then carries why.
        // resolveTestCmd (below) is what decides whether the run can proceed;
        // this agent only transports the derivation.
        testCmd: { type: "string" },
        testCmdError: { type: "string" },
      },
    } },
);

// A dead snapshot agent returns falsy, and every read below dereferences it.
// Unguarded this is a TypeError a hundred lines from its cause; guarded it names
// the one thing the caller can act on — there is no tree, so there is no review.
// The `.filter(Boolean)` guards on the review and verify agents are the same
// rule applied where a partial result is still usable; here it is not.
//
// `pathVerified` closes a narrower gap than the two above it: `snap.path` can be
// a well-formed, present string that names nothing on disk — a failed
// 'git archive | tar -x' leaves the directory 'mkdir -p' already created, empty.
// Every specialist and verifier prompt below interpolates `snap.path` unchecked,
// so an unverified path turned "read the snapshot" into "reason from source" on
// all six dimensions instead of one (#140). `required: [..., "pathVerified"]` on
// the schema is what makes this a caller check rather than trust in the agent's
// own report — the field cannot be silently omitted, only reported false.
//
// Whether that round-trip could be dropped for a real caller-side filesystem
// check — `readdirSync(snap.path)` in place of a boolean the agent types — was
// asked as #538 and MEASURED rather than read off the documentation asserting
// it, because this repo's own assertions about the sandbox had never been
// executed. It cannot be dropped. A workflow script's body compiles as a
// function body inside the harness VM, so a static `import` is parsed as the
// dynamic call form and never reaches a module loader; `import()` is refused
// for ANY specifier, before the name is resolved, so what the harness rejects
// is the mechanism and not `node:fs` in particular; and `require` is undefined.
// Enumerating the scope turns up the ECMAScript builtins and the harness
// injections, and nothing that reaches a filesystem. Both verdicts were made
// observable before either was believed: a workflow importing nothing returned
// a computed value, and one throwing on purpose surfaced as a distinct error,
// so "it ran and worked" and "it was refused" could be told apart.
//
// So the round-trip stays, and a boolean the agent is instructed to bind to a
// mechanical probe is the strongest check reachable from here. Measured
// 2026-08-23; if the harness changes, re-measure with a throwaway workflow
// rather than re-reading this.
//
// The head compare below (#532) is the same expression `usableDiff` runs, and it
// is a SECOND COPY on purpose: the sandbox above forbids `import`, so a shared
// helper could not be lifted out of this file by the tests that pin it, and
// `lift()` evaluates one declaration standalone. The copies are pinned to each
// other in review-pr-snapshot-path.test.mjs rather than to the comparison's own
// text: that pin anchors on the `if (snap.prHead && ` guard head and captures
// whatever comparison follows, so a change made to one side and not the other
// reds, while a semantics-preserving rewrite of both stays green. Rewrite this
// comparison — but rewrite BOTH.
//
// What it adds is the CONSEQUENCE, which is the half that was missing. The
// comparison already existed, in `usableDiff`, where a mismatching `prHead`
// cost the review its diff and nothing else — so a review handed a tree that
// was not the PR ran to completion on the fallback read rules and returned
// findings about code the PR does not contain. Measured: a carried-over
// worktree re-created with `git worktree add <path> <branch>`, which checks out
// a leftover LOCAL branch and never consults the remote, sat at a pre-rebase
// commit whose subject line was byte-identical to the PR head's, with neither
// commit an ancestor of the other. Nothing downstream could have said so. The
// diff drop stays where it is: it is the narrower guard and it is still correct
// for any caller that reaches it.
//
// A MISSING `prHead` is deliberately still not disqualifying, for the reason
// `usableDiff`'s own comment gives — `gh pr view` can fail on its own — and the
// stakes here are higher, since absent input would now cancel a whole runnable
// review instead of narrowing one. Absent and mismatching are different cases.
// The prefix tolerance is load-bearing for the same reason: `head` is relayed
// by an agent asked for "the HEAD sha" and may be abbreviated, and under a raw
// `!==` an abbreviated MATCH would refuse the review outright.
function snapshotMissing(snap) {
  if (!snap || !snap.path || !snap.head) return "the snapshot agent returned no tree — nothing to review";
  if (!snap.pathVerified)
    return `the snapshot at ${snap.path} was not verified to exist — refusing to hand a possibly-missing tree to every specialist`;
  if (snap.prHead && !snap.prHead.startsWith(snap.head) && !snap.head.startsWith(snap.prHead))
    return `the tree at ${snap.path} is at ${snap.head}, and the PR's head is ${snap.prHead} — refusing to review a commit that is not the PR`;
  return null;
}

// Neither sha is normalized on the way here. `prHead` is 40 lowercase hex from
// `gh pr view --json headRefOid`; `head` is whatever an agent asked for "the
// HEAD sha" relayed, and `git rev-parse` prints a trailing newline. Under the
// refusal below an unnormalized `head` no longer costs a diff — it cancels the
// whole review, and the refusal message then names two shas that look
// identical, which reads as a wrong-commit worktree rather than the relay
// artifact it is. Measured: `head` of `"9e8ee3d\n"` against a 40-char `prHead`
// starting `9e8ee3d` refuses, and so does a leading space; a trailing newline
// survives only when `prHead` happens to be a prefix of `head`, so the
// tolerance the comment below claims is partly accidental.
//
// Normalized ONCE here rather than inside either copy of the compare: the two
// copies stay byte-identical for the pin in review-pr-snapshot-path.test.mjs,
// and `usableDiff`'s three call sites below read this same object. Case-folding
// rides along in the same pass — git emits lowercase hex, so it is belt to the
// trim's suspenders, not a case this workflow has produced. `snap` falsy is
// left to `snapshotMissing`'s own first guard, which names it.
if (snap) {
  if (typeof snap.head === "string") snap.head = snap.head.trim().toLowerCase();
  if (typeof snap.prHead === "string") snap.prHead = snap.prHead.trim().toLowerCase();
}

const missingReason = snapshotMissing(snap);
if (missingReason) throw new Error(`review-pr: ${missingReason}`);

// `prHead` is named here even when it is absent. The head compare in
// `snapshotMissing` is guarded on `snap.prHead &&`, so a failed `gh pr view`
// skips the #532 refusal — deliberately, see the comment above it — and the run
// log is then byte-identical to one where the two heads were compared and
// matched. Measured: both cases printed `snapshot <head> at <path>` and nothing
// else. The skip is the whole difference between a backstopped review and an
// unbackstopped one, so it is said rather than left to be inferred from a field
// this line never printed.
log(`snapshot ${snap.head} at ${snap.path} — PR head ${snap.prHead ?? "(absent): head check SKIPPED"}`);

// Resolved here, right after snap is known good: everything downstream (the
// specialist prompt) just interpolates `testCmd`. Throws when neither an
// override nor a derivation is available — see resolveTestCmd above for why
// that is a refusal, not a fallback.
const testCmd = resolveTestCmd(A.testCmd, snap);
log(`testCmd ${A.testCmd ? "(caller override)" : "(derived)"} ${testCmd}`);

// The diff decision, named in the run log. Without it the whole feature is
// unobservable: `usableDiff` returning null forever looks identical to a run
// that never had a diff to lose, and the two follow-ups the spec defers both
// wait on evidence from a real run — "add the line count to the prompt only if a
// run shows specialists reading pr.diff whole", and "if the head check fires,
// that is a finding about the fleet's ordering, report it". Neither is
// observable from a log that never mentions the diff.
//
// It prints the three RAW inputs rather than naming the guard that fired. A
// clause chain mirroring `usableDiff` states a measurement that was never taken:
// `!snap.diffLines` is true when the field is ABSENT, and it printed `diff is 0
// lines` — so a run where `gh pr diff` returned 500 real lines and only `wc -l`
// failed reads as an empty PR, and nobody goes looking at `wc`. That is the
// "a read that failed and a read that found nothing are indistinguishable"
// defect this whole feature exists to close, reintroduced in its own log line.
// Raw values also drop the coupling that chain had to `usableDiff`'s guard order.
//
// The two prompts below re-call `usableDiff(snap)` rather than reading this
// binding, deliberately: both call sites being the IDENTICAL expression is what
// makes the call-site pin in `review-pr-reads.test.mjs` a two-token check. The
// function is pure and the cost is a string compare.
const usable = usableDiff(snap);
log(
  usable
    ? `diff ${usable} (${snap.diffLines} lines)`
    : `no diff — diffPath=${snap.diffPath ?? "(absent)"} diffLines=${snap.diffLines ?? "(absent)"} prHead=${snap.prHead ?? "(absent)"} head=${snap.head} — specialists get the fallback read rules`,
);

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
const dimensions = resolveDimensions(explicitDimensions, DEFAULT_DIMENSIONS) || selectDimensions(DEFAULT_DIMENSIONS, stats);
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

// Why a dimension did NOT cover its ground, or null when it did.
//
// ONE shape for two causes, because a consumer sees one fact: this dimension is
// not covered. A reviewer that died (#138) and a reviewer that never ran the
// suite (#137) both returned `findings: []` — byte-identical to a clean pass —
// while the key stayed in `dimensionsRun` either way. Giving the two causes two
// shapes is how a caller ends up handling one and missing the other.
//
// This is the same reasoning the verifier path applies one level down, where
// `live.length === 0` is `unverified` rather than `survived`: a check that never
// ran must not be read as one that passed. That case was handled deliberately
// and this one was not.
//
// PURE, and kept that way on purpose: no `testCmd`, no `snap`, nothing from the
// enclosing run — as are `unrunEntries` and `unrunCrashed` below, for the same
// reason. Purity is what makes this seam executable at all: the file's top-level
// `await` leaves it unimportable, so `review-pr-unrun.test.mjs` lifts all three
// out of the source text to run them, and a free variable would throw a
// ReferenceError there on whichever branch read it. Everything OUTSIDE these
// three — whether the script actually calls them — is pinned as text and cannot
// be more than that.
//
// What it must NOT do is refuse a real run. An empty findings list is the
// expected return from a specialist that ran everything and found nothing, and a
// suite that reported failures ran — neither is unrun on its own. What #143
// widened this to is the absence of WORK, which is a different fact from the
// absence of a run: a pass that reports no passes and no failures did none.
function unrunReason(review) {
  if (!review) return "the reviewer returned nothing — spend limit, timeout, or terminal error";
  const run = review.test_run;
  if (!run) return "the reviewer reported no test run at all";
  const cmd = run.command || "the test command";
  // `!run.tests` and not `run.tests === 0`: a field the schema requires can
  // still arrive absent or null from a producer that ignored it, and that is
  // the same fact — nothing ran.
  if (!run.tests) return `\`${cmd}\` produced 0 tests — a failed run, not a pass`;
  // `pass === 0` and not `!run.pass`, because `pass` is OPTIONAL (see
  // `test_run`'s own `required`) and an absent count is not a zero one. The
  // `&& !run.fail` is what keeps this off the suite that failed everything —
  // that reports zero passes too, and it is the run that most needs reporting.
  // `skipped` is not a declared field of `test_run`, so however the harness treats
  // an undeclared one, this is the only shape an all-skipped run reaches here in.
  if (run.pass === 0 && !run.fail) return `\`${cmd}\` passed nothing and failed nothing — every test skipped, not a pass`;
  // The CONJUNCTION, never `fail > 0` alone: a failing suite ran, and reading
  // that as unrun is the over-refusal #137 removed. Zero findings is provably
  // wrong only next to failures the reviewer was looking at and wrote up none of.
  if (run.fail > 0 && !review.findings?.length)
    return `\`${cmd}\` reported ${run.fail} failing tests and the reviewer filed no findings about them`;
  // #143's remaining case — a count below the suite's own size, the partial-tree
  // one — is deliberately NOT here and cannot be: this stays pure, so the size of
  // the suite is not a fact it holds. It is a reading rule in the specialist
  // prompt instead, where the agent that ran the command can compare the two.
  return null;
}

// Zero or one entry, so both call sites can `push(...)` it with no guard of
// their own. That shape is the point: a guard at the CALL SITE is what #138
// shipped the first time, and a call site is the half no running test can see —
// `unrunEntries` is executable, its callers are only ever pinned as text.
function unrunEntries(review, dimension) {
  const why = unrunReason(review);
  return why ? [{ dimension, reason: why }] : [];
}

// The crashed reviewer, derived from the pipeline's OWN result instead of from
// inside it — and the reason #138's first attempt recorded nothing at all.
// `pipeline()` SHORT-CIRCUITS between stages: the harness runs
// `if (result === null) break` before handing a dimension to the next stage, so
// a reviewer that returned null never reaches the verify closure below, and a
// recording that lives there cannot see the one case #138 is about. Read out of
// the harness bundle, not inferred — the pre-existing `review && review.findings`
// guard one stage down is authorial belief, and mistaking it for a contract is
// what made this look handled.
//
// What the caller CAN see: one slot per dimension, in order, holding null for a
// chain that died, so `dimensions[i]` names which one at a level the short-
// circuit cannot reach. Both crash shapes land in that null — `agent()` returning
// null, and a THROW, which the harness maps to the same null slot (#527).
//
// The `?? slot ${i}` is not defensive noise. It is the only line here that runs
// AFTER every specialist and every refuter has finished, so a bare
// `dimensions[i].key` throwing on a length the harness stopped guaranteeing would
// discard a whole 20-40 minute run's findings to report a naming problem. Name
// the slot and keep the run.
function unrunCrashed(reviewed, dimensions) {
  return reviewed.flatMap((r, i) => (r ? [] : unrunEntries(null, dimensions[i]?.key ?? `slot ${i}`)));
}

// --- Review → Verify ------------------------------------------------------
// pipeline(), not parallel(): a dimension's findings start verifying the moment
// that dimension finishes, rather than waiting for the slowest reviewer. There
// is no cross-dimension dependency, so a barrier here would be pure latency.

// Populated in TWO places, because neither can see what the other sees: the
// verify stage below is the only place a dimension's raw review object is still
// in scope (#137), and `unrunCrashed` after the pipeline returns is the only
// place a dimension that never reached that stage is still visible at all
// (#138). Filled by side effect rather than returned, because `reviewed` is
// findings — flattened, envelope gone — and
// widening that return would change what every consumer of `survived` /
// `refuted` / `unverified` reads.
const dimensionsUnrun = [];

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
Do not substitute a command of your own. In a repo that has a shared test stack,
a bare runner picks up a default config whose setup can tear a sibling's
container down mid-run; a guessed glob is worse in every repo, because one
matching nothing still exits 0 reporting 'tests 0' — a green that ran nothing.
Whatever you run, report it in \`test_run\` — the command verbatim and the counts
you saw — even when it failed or produced nothing.
'tests 0' is a FAILED run, not a pass: \`tests: 0\` is how this dimension gets
reported unrun, and an empty findings list cannot say it for you. So is a run
that collected tests and did none of the work — 0 passes with no failures is
everything skipped. And a count well below what the whole tree reports means you
ran a PARTIAL copy: nothing downstream can catch that one for you, because only
your own run knows what the full tree reports. Run from the snapshot's root, and
report any of the three as unrun.
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
  (review, d) => {
    // #137's half: a reviewer that RETURNED but ran no suite. It reaches this
    // closure precisely because its stage-1 result was an object, so the short-
    // circuit `unrunCrashed` exists for never fires on it. Unguarded, and BEFORE
    // the `review && review.findings` guard below — that guard is the expression
    // which reads a dead reviewer as a clean one, and a recording tucked behind
    // it would classify every dimension except the one that failed.
    dimensionsUnrun.push(...unrunEntries(review, d.key));
    return parallel(
      // `fi` keys the refuter scratch path, and is bound for nothing else. The
      // fan-out under a dimension nests two axes — the dimension's findings
      // here, each finding's lenses within — so a path keyed on the dimension
      // alone is shared by every refuter under it, not merely by one finding's
      // lenses (#496). The fan-out index is the only per-finding key in scope:
      // a finding arrives carrying claim/file/line and no id, and this workflow
      // mints none for it either — the `unv<N>` labels a fix-applier cites are
      // the consumer's, applied to the buckets this returns.
      (review && review.findings ? review.findings : []).map((f, fi) => () => {
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

Observe that run synchronously — run the command, wait for it, read its exit
code. Never poll a log file for a completion marker: prefer ONE blocking run to
a poll loop, and treat its return as permission to look, never as the answer.
Reading a log the run has already finished writing is fine; waiting on one is
not. If you match a test reporter's own output, accepting both \`ℹ\` and \`#\` is
necessary but NOT sufficient — strip SGR escapes first as well. node's prefix
moves with the node version and with whether stdout is a TTY, and color wraps
the whole line so it begins with ESC and no prefix anchor matches at all, which
returns empty at exit 0 — indistinguishable from a hung run and from a run of
zero tests. For an uncolored baseline use \`env -u FORCE_COLOR\`; \`FORCE_COLOR=\`
empty still enables color, so it is not a control.

State your search scope AND what your pattern would have missed. A grep over one
ref does not support a claim about history; a pattern built from the token a
diff removed does not support a claim that the category is empty.

${readRules(usableDiff(snap), stats, snap)}

Lens ${i + 1}: ${i === 0 ? "is the claim true of the code as merged?" : "is it already handled elsewhere, or does the evidence prove something weaker than the claim?"}
Scratch: ${scratch}/verify-${d.key}/f${fi + 1}-l${i + 1}/
Everything you write — mutants, fixtures, scratch repos — goes there and nowhere
else. That directory is yours alone: every other refuter of this dimension, on
this finding and on the others, is given a different one, so a generic filename
cannot land on a sibling's. The checkout and any worktree are never write
targets, though \`git show\`/\`git archive\` at a pinned ref read fine anywhere.
Chain the directory change into the command, \`cd "$D" && git …\`, never
\`cd "$D"; git …\`, so a failed \`cd\` cannot leave a \`git\` command running in the
checkout — and bracket a fixture's own git with \`git rev-parse --show-toplevel\`:
before \`git init\` it must NOT resolve to the repository, and a fresh scratch
dir's \`fatal: not a git repository\` (exit 128) is the pass, not a failure;
before any \`git commit\` it must equal your scratch path.`,
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
    );
  },
);

// #138's half, and it cannot be done inside the stage above — see `unrunCrashed`.
dimensionsUnrun.push(...unrunCrashed(reviewed, dimensions));

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
// `dimensionsRun` names what was DISPATCHED after the size trim: a trimmed
// fan-out must say so, never read as full coverage. It is not a coverage claim
// on its own and never was — a specialist can be dispatched and die, or run and
// never execute the suite — so `dimensionsUnrun` names which of those keys did
// not cover their ground, and why. A key in the first and not the second is the
// only thing that means covered.
//
// The two are siblings rather than one filtered list because they answer
// different questions. Subtracting the unrun ones from `dimensionsRun` would
// make a crashed dimension indistinguishable from one the size tier never
// dispatched — this ticket set's own defect, moved one field over.
return {
  pr,
  head: snap.head,
  snapshot: snap.path,
  dimensionsRun: dimensions.map((d) => d.key),
  dimensionsUnrun,
  survived: survived.sort(bySeverity),
  refuted,
  unverified: unverified.sort(bySeverity),
};
