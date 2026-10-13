// A claim written into a commit body or a PR body needs its settling command
// re-run at the commit that ships it, written inline beside it, because a
// pushed body cannot be edited and none of the diff-scoped rules reach it. The
// rule itself and the literal-text `-F` rule live in the claim-discipline block
// every implementer agent body carries; run-team's SKILL.md keeps the rationale
// paragraph and the two settling-command paragraphs that follow it. This file
// pins both homes. The same block's anti-count rule is pinned in
// `fix-applier-correction-rules-prose.test.mjs`, as one ordered span.
//
// Measured against `origin/main` before this file existed: no test read the
// words `commit body` in `run-team/SKILL.md` at all, so the whole rule could be
// deleted with the suite green.
//
// SHAPE. The SKILL.md slice runs from the rationale paragraph to the
