# Correction tickets ship new wrong claims

Why ticket meant to correct fact tends to ship fresh wrong one, and why check belongs on implementer as much as reviewer. Evidence here.

Nothing below measures a **model tier**. The four-for-four ran at one tier and this file records no comparison, so it cannot support a claim that either tier is better or worse.

## The four-for-four finding

Four for four in one run — misattributed package, list at inverted polarity, commit body citing wrong line, banner refuting currently-true fact.

## The mechanism is the ticket's framing, not implementer sloppiness

Fix text **paraphrases the issue body's framing** instead of being checked clause-by-clause against tree, so wrong premise in ticket becomes wrong claim in repo. Two of four came verbatim from their issue's wording, and that issue still wrong on two counts — so every ticket split from same source inherits them.

## Second mechanism: minted, not inherited — scope creep in the prose

Second run, on **`CoCo/agent-brain`** — GHE-hosted (`bmw.ghe.com`), not github.com, so none of it can be settled from this repo; the numbers, ordinals and test vocabulary describing it are theirs, not ours. Its fix PR shipped **two** fresh false claims, neither traceable to the issue. Issue asked for **one clause**; PR wrote **five lines**. Both errors entered in that expansion — so comparing fix text against the issue clause cannot catch them, there being no clause to compare against.

Both were **positional references**: "the *closing* `report-file verification` block" (4th of 5) and "the *second* assertion is the one with teeth" (3rd). Positional refs are one of the four classes in the four-for-four finding, and they re-rot the moment anyone inserts ahead of them.

Ordinals also **fake their own verification**: the wrong ordinal named an assertion earlier than the real one, and **a failing assertion aborts the rest of its test** (true of `node --test` + `assert.*` here, not only of their runner) — so the obvious mutation (setting the workflow step under test to `if: ${{ always() }}`) reds the named assertion and never reaches the true one, appearing to confirm the wrong claim. One mutation cannot discriminate an ordinal: measured here, `always()` reds the named assertion, and only the narrower `always() && steps.mutate.outcome == 'success'` reds the true one.

Two rules for the implementer, both cheap: **write no prose the ticket did not ask for** — added prose is where minted claims enter — and **never write a positional reference** (`the closing/second/last X`); name what the thing *is*, not where it sits.

## The clause-by-clause duty

Put check on **implementer**, not only reviewer: every factual claim the diff restates must have settling command run against tree first. Issue body is lead, never citation. Tell reviewers same, and to read each corrected sentence literally, asking whether every clause true under that reading — nobody hunts this unprompted, because diff "obviously" improves accuracy.

## Citing evidence from another repo's run

A bare `#N` copied from another repo's run reads as **this** repo's N — to a human and to an agent alike. Ambiguity is the whole defect; no hyperlink need be involved. Cite by host of the source:

- **github.com** → `owner/repo#N`. `gh pr view N --repo owner/repo` settles it.
- **Any other host** (GHE, GitLab, internal) → prose naming host and repo, plus explicit *cannot be settled from this repo*. Qualified form is inert there: `gh api repos/<owner>/<repo>` returns 404 for a repo that lives only on a GHE host, so `owner/repo#N` would point at nothing.
- **This repo's own issues and PRs stay bare `#N`.** Convention covers foreign evidence only; qualifying local reference is noise.

Disclaimer must reach every foreign token it covers — numbers, ordinals, file names, test vocabulary — and must say unverifiable, because the clause-by-clause duty demands settling command and none exists to run. Where lesson itself is host-neutral, name behaviour generically instead of scoping it foreign: foreign-scoped lesson invites reader to discard one that does apply here.

## Every implementer body carries the claim discipline

**Every implementer body carries the claim discipline, because tickets that
restate facts ship new wrong claims** — inherited from the ticket, and minted
in prose nobody asked for. It was measured on tickets that would have been
judged routine too: an unasked-for comment asserting a silent-failure mode
that does not exist, a false comparative plus positional references replacing
a name-based one, and two present-tense counts already false when they were
written.
Nothing before dispatch can see the diff, so the discipline goes to every
implementer. A pushed commit body cannot be edited, so its claims are settled
at write time.

## A settling command over literal text uses `grep -F`

**A settling command over literal text uses `grep -F`, and its zero counts only
after the same command finds a line known to match.** Prose fragments and
code snippets routinely carry `\`, `.`, `*`, `[` or `$`, and without `-F` those
are read as a pattern rather than as the text itself, so the command answers
for a different string from the one the claim names — and a wrong zero is the
benign-looking answer. Measured once: `grep -c 'settled by:\s+x'` answers
0 against a file holding that exact line, and `grep -cF` answers 1. A zero or
an absence counts only after the same command, with the same flags, finds a
line known to match: a command that cannot find a match settles nothing, and
under `Verified:` its zero reads as a checked absence.

## The settling command for "which files read X" is never a literal-path grep

**The settling command for "which files read X" must never be a literal-path
grep.** Replace the file with `MUTATED` in a throwaway copy, run the suite, and read off
which suites red: that answers which ones **depend on its contents**, which is
the question a coverage claim actually needs, and it returns a different set
from any spelling of the grep.

The path is assembled in more than one spelling here, one of them behind
a local `read` helper, so a grep for the path string answers with the files that
merely *name* it — comments included — and misses the files that build it.
