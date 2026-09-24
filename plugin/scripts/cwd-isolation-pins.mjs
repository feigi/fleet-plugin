import { phrase } from "./prose-pin.mjs";

// The inherited-cwd rule's pinned spans (#1433, #1673), spelled once.
// review-core-cwd-isolation.test.mjs pins the rule into the omp harness's
// prompts (scripts/review-core.js); review-pr-cwd-isolation.test.mjs pins the
// Claude harness's copy (workflows/review-pr.js) word-for-word against the
// omp one. Both files assert the same spans, so each span lives here and
// neither file carries a transcription of it: a second copy of prose
// disconnects from the first the way review-core-parity.test.mjs's header
// says a second copy of code already does in this repo.
//
// Three spans are TEXT, not RegExps, because at least one caller pins each of
// them with the sentence that leads into it, passing `${leadIn} ${SPAN}`
// through phrase(). phrase() trims and joins every whitespace run as `\s+`, so
// the lead-in and the span stay one contiguous pin — never two assertions,
// never a free-text `.{0,N}` gap a spliced exception could fit into. The rest
// carry no lead-in anywhere and are exported ready to match.

// Part 1, the inherited cwd named as a tree not to write to. The three
// clauses have to arrive together or the rule is not the rule: "carries no
// working directory of its own" alone is a fact with no instruction; naming
// the controller's checkout alone reads as context; and "a relative path lands
// THERE" is the only clause that says what to do differently.
export const SPECIALIST_CWD =
  "this dispatch carries no working directory of its own, so you begin wherever the controller's own review cell is standing — its checkout, the tree it reads instruments.sh, ci-state.mjs and every gate decision out of. A relative path in any command lands THERE, not in the snapshot and not in your scratch dir.";
export const REFUTER_CWD =
  "this dispatch carries no working directory of its own, so you begin wherever the controller's own review cell is standing — its checkout, the tree it reads every gate decision out of — and a relative path in any command lands THERE.";

// Part 2, `pwd` first and the inherited directory a no-run zone. Both halves
// in one span: `pwd` with no consequence attached is a print statement, and "a
// no-run zone" naming no directory is unenforceable — the recorded failure is
// an agent that BELIEVED it was somewhere else, which only a printed path
// settles.
export const PWD_FIRST = phrase("Run `pwd` as your FIRST command and keep the path it prints; that directory is a no-run zone from then on");

// Part 3, the positive self-check. The audit command and the report contract
// are separate spans because they fail separately: a bare `--porcelain` is a
// silently WRONG audit (a `status.showUntrackedFiles=no` config makes it print
// nothing on a tree holding new files, which reads as clean), while a missing
// report contract is an audit nobody can read.
export const AUDIT_COMMAND =
  "`git -C <that path> status --porcelain -uall` — the explicit untracked mode, never bare `--porcelain`, which a `status.showUntrackedFiles=no` config silences into a false clean.";

// The report contract. The field name is a capture group so a caller EXTRACTS
// it from the rendered prompt rather than transcribing it, and checks it
// against the schema that must carry it. Gaps are `\s+`, never literal spaces
// — this prose is hard-wrapped at ~78 columns, so every one of them may be a
// newline (measured: a literal-space version of this regex matched nothing).
// The two prompts phrase this two different ways ("Report the result in" /
// "Report it in") — one alternation between them, not two independent
// optionals, which would also admit the dead combination neither prompt
// writes ("Report the result it in").
export const REPORT_FIELD = /Report\s+(?:the\s+result|it)\s+in\s+`(\w+)`\s+as\s+one\s+line\s+beginning\s+`CWD-AUDIT:`/;

// Every state the audit line can take, and the clause that demands it on a
// clean run. A state a prompt cannot spell is a state it will not report, and
// an audit reported only when it finds something is indistinguishable from one
// never run.
export const AUDIT_STATES = ["clean", "dirty", "unrepo"];
export const auditLine = (state) => phrase(`\`CWD-AUDIT: ${state} <path>`);
export const EVERY_RUN = phrase("every run, clean or not");

// One marker, spelled once, or a controller grepping a review's payload for it
// finds half the reports — matched as a code span, since a reader cannot tell
// a bare literal from the prose around it.
export const CWD_AUDIT_MARKER = /`CWD-AUDIT:`/;
