import assert from "node:assert/strict";

// Lift a plain top-level `function name(signature) { ... }` declaration out of
// `workflows/review-pr.js`'s source text and evaluate it standalone.
//
// review-pr.js runs a top-level `await pipeline(...)` and cannot be imported —
// `workflows/` scripts run inside the Workflow sandbox, which forbids the
// filesystem/Node.js APIs an `import` would need to resolve, and a failed
// import bricks the fleet's default review path
// (docs/specs/2026-08-06-review-pr-specialist-read-rules-design.md:277). This
// convention — copying the source text rather than importing it — is what this
// repo's test headers call text-lift pinning. Scripts under
// skills/fleet/scripts/ may import each other freely; only the workflow file
// itself may not be imported, which is why this module is an ordinary import
// for its callers even though its own reason for existing is that some other
// file cannot be.
//
// Known ceiling, load-bearing: `.match` (non-global) returns the FIRST
// declaration in `code`, but JS function-declaration hoisting means the LAST
// one wins at runtime. A duplicate `function name(...)` pasted in AFTER the
// real declaration is invisible to every lift built on this helper — it
// returns the dead first copy, not the function review-pr.js actually runs at
// call time. Measured 2026-08-17 (PR #536, feigi/claude-config): the suite
// stayed green with the duplicate placed after the real declaration, and went
// red with it placed before (the harmless order, since the real declaration
// still wins at runtime either way). This function does not guard against
// that on its own. The guard is a single "declared exactly once at top level"
// test in review-pr-reads.test.mjs that scans review-pr.js's stripped source,
// so a lift whose `code` is that same text is covered wherever its caller
// lives, and a lift from any other source text is covered by nothing. That
// guard is deliberately kept OUT of this module: an assertion thrown here at call time would abort
// whichever test file imported it before any of that file's OTHER tests get a
// chance to register, turning a named failure into an opaque file-level error
// instead.
//
// `code` is a parameter, not a module-level constant: some callers lift from
// raw SOURCE, others from CODE = stripComments(SOURCE) (see strip-comments.mjs
// for why a commented-out declaration needs stripping first so a pin cannot be
// satisfied by dead code). Passing it in keeps that choice with the caller
// instead of this module silently picking one.
export function lift(code, name, signature) {
  const re = new RegExp(
    `^function ${RegExp.escape(name)}\\(${RegExp.escape(signature)}\\) \\{[\\s\\S]*?^\\}$`,
    "m",
  );
  const m = code.match(re);
  assert.ok(m, `review-pr.js no longer declares ${name}(${signature}) at top level — update this test`);
  return new Function(`${m[0]}\nreturn ${name};`)();
}
