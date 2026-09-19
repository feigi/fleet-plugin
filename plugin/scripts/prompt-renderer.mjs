import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between } from "./prose-pin.mjs";
import { stripComments } from "./strip-comments.mjs";

// #1552. The extract-then-compile idiom — read a workflow's source, strip its
// comments so a block-commented call cannot render as live text, find a
// template literal's start/end anchors via prose-pin.mjs's `between()`, trim
// its wrapping backticks, and compile it with `new Function` — existed
// verbatim in three test files (review-pr-specialist-scratch.test.mjs,
// review-pr-refuter-scratch.test.mjs, injection-control-prose.test.mjs), each
// around a different anchor pair. Only the extraction MACHINERY moves here;
// the prompt RULE PROSE itself stays inline in review-pr.js/review-core.js
// per #496's brief against a shared source for the rules themselves.
const REPO = join(import.meta.dirname, "..");

// `file` is relative to the plugin root (e.g. "workflows/review-pr.js").
// Extraction runs against the comment-stripped text, not the raw source: a
// block-commented `agent(...)` call still contains the whole template, so
// extracting from raw source would render dead text and report every
// criterion satisfied — the vacuity class strip-comments.mjs exists for.
export function workflowCode(file) {
  return stripComments(readFileSync(join(REPO, file), "utf8"));
}

// Extracts the template literal between `start` and `end` out of `file` (via
// prose-pin.mjs's `between()`, which owns the bounded-slice extraction and
// both failure messages), trims the wrapping backticks, and compiles the
// result into a renderer bound to `scope`'s free names. Compiling is half the
// assertion: an unescaped `${` in the prescribed array expansion either
// throws here or silently interpolates away the very spelling the rule
// exists to teach.
export function promptRenderer({ file, start, end, scope, what }) {
  const slice = between(workflowCode(file), start, end, what);
  return new Function(...scope, "return `" + slice.slice(1, slice.lastIndexOf("`")) + "`");
}
