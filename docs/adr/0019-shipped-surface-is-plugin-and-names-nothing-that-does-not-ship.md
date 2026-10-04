# 0019 — The shipped surface is `plugin/`; it names nothing that does not ship, and tests live outside it

**Status:** Accepted. Ruled 2026-09-29 on #1938 by the maintainer, from a
grilling session; the work it orders is tracked as #2230. Amended by ADR 0021
only in mechanism: what ships `plugin/` is now the npm package's `files` list
instead of a `git-subdir` marketplace entry — the rule stands untouched.
Amended by #2232: Decision 4's list of test-only support modules was short
three — `exec-stub.mjs`, `temp-dir.mjs` and `worktree-porcelain.mjs` have no
importer outside the tests either, and moved to `tests/support/` with the six
it names.

## Context

- **Everything under `plugin/` ships.** The marketplace entry in
  `.omp-plugin/marketplace.json` is a `git-subdir` source with
  `path: plugin` and `ref: main`, so a consumer's install receives every file
  under `plugin/` — skills, agents, scripts, their comments, and the
  `*.test.mjs` files and test-only support modules that sit beside them
  today.
- **Shipped files name things a consumer cannot resolve.** This repo's issue
  and PR numbers, a foreign tracker's numbers, unshipped `docs/` paths, ADR
  numbers, and test-file names. None of them exists in a consumer's install.
  Worse than dead: an agent reading `(#1433)` in a shipped prompt may run
  `gh issue view 1433` against the **user's** repo and act on whatever
  answers.
- **#1938 was the trigger.** It reported `feigi/claude-config#903` in
  `run-merge-bot.md` as a citation of an unrelated issue. The premise was
  false — `feigi/claude-config` is this repo's former name, so the citation
  is PR #903 here and on-topic — and #1938 closed not planned. Its lesson
  stands: a stale, qualified self-citation misled a reviewer, and no shipped
  file should carry one at all.
- **Size, measured 2026-09-29:** 71 shipped files, 1643 hits — 1428 bare
  `#N`, 5 `owner/repo#N`, 8 `PR N`, 56 `ADR NNNN`, 16 `docs/` paths, 130
  test-file names — by this scan:

  ```
  git grep -nP '(?<![\w/&$-])#\d{2,5}(?![0-9a-fA-F])|\b[\w.-]+/[\w.-]+#\d+|\bPR \d{2,5}\b|\bADRs? ?\d{3,4}|\bdocs/(adr|specs|research|agents|requirements)|[\w-]+\.test\.mjs' -- plugin ':!*.test.mjs'
  ```

## Decision

1. **The shipped surface is `plugin/`, and it names nothing that does not
   ship:** this repo's issue and PR numbers in any form (`#N`, `PR #N`,
   `feigi/fleet-plugin#N`, `feigi/claude-config#N`), foreign tracker
   numbers, repo-internal `docs/` record paths (`docs/adr`, `docs/specs`,
   `docs/research`, `docs/agents`, `docs/requirements`), `ADR NNNN`, and
   `*.test.mjs` names.
2. **Scope: prose, code comments, and runtime strings** — prompt template
   literals and stderr/stdout text included. Dates and run-scoped
   measurements stay.
3. **Replacement: delete the pointer and keep the claim self-contained.**
   Provenance lives in git history. No shipped provenance index, and no move
   of rationale into `docs/` to be pointed at instead.
4. **Tests leave the shipped surface.** Every `*.test.mjs` moves to a
   top-level `tests/`, and the test-only support modules (`prose-pin.mjs`,
   `strip-comments.mjs`, `prompt-renderer.mjs`, `review-host-fixture.mjs`,
   `cwd-isolation-pins.mjs`, `slow-transport.mjs`) to `tests/support/`. The
   rule does not apply to `tests/`.
5. **`correction-tickets.md`'s cross-repo citation convention stays.** It is
   runtime guidance for writing in users' repos, not a citation of this one.
   Its examples become placeholders and its evidence sections
   self-contained.
6. **Enforcement is a whole-file gate test** over tracked `plugin/` files:
   no allowlist, no opt-out marker, CSS hex colours the only carve-out. It
   lands last, after the sweep has emptied the scan. Rejected: a ratchet
   landing first — the parallel sweep slices would all edit its one
   enforced-file list and conflict there.
7. **The rule is recorded in three places:** this ADR, a `CONTEXT.md`
   *Shipped surface* entry, and one line of repo-root `AGENTS.md` — never in
   shipped dispatch prompts, which would impose this repo's house rule on
   users' repos.

## Consequences

- **Order:** this ADR, then the test move, then ten file-disjoint sweep
  slices in parallel, then the gate. Until the gate lands, nothing enforces
  the rule and the tree does not conform to it.
- **`tests/` is exempt,** and so are `docs/`, `CONTEXT.md` and the root
  `AGENTS.md`: none of them ships, so each may cite issues, PRs and ADRs as
  it does today.
- **Provenance lives in git history.** A reader of a shipped file who wants
  the why runs `git log` / `git blame` on it; a commit message or PR body is
  where the issue number goes.
- **Tests that pin a citation into a shipped file invert under this rule.**
  A pin asserting that a shipped skill still cites an ADR, an issue or a
  test file asserts the opposite of decision 1; the sweep slice that removes
  the citation retires the pin with it.
- **Every new or edited shipped file follows decision 1 from now,** gate or
  no gate: state the claim; put the citation in the commit.
