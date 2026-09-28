# 0015 — A consumer repo's Recipe is derived by agent reasoning and cached; fleet-ctl maintains no technology table

**Status:** Accepted. Ruled 2026-09-28 by the maintainer while reviewing
`docs/requirements.md` (PR #2112), against the measurement below.

## Context

The fleet works on a *consumer* repository it does not own. Two commands about
that repository are load-bearing for every claim and every review: how to
materialise its dependencies in a fresh worktree (the **Install step**) and how
to run its suite (the **Test entrypoint**). Today both are inferred by shell
code that knows exactly one ecosystem:

- `plugin/scripts/derive-testcmd.sh:141-194` emits `npm test --` when
  `package.json` declares `scripts.test`, else `node --test` when a tracked file
  matches `\.(test|spec)\.[cm]?[jt]sx?$`, else refuses.
- `plugin/scripts/claim-ticket.sh:226-271` maps `package-lock.json` /
  `pnpm-lock.yaml` / `yarn.lock` to `npm ci` / `pnpm i --frozen-lockfile` /
  `yarn --immutable`, accepts "no lockfile" only when `package.json` declares
  zero dependencies, and refuses otherwise.
- `claim-ticket.sh:527-1196` emits a runner, `agent-test`, whose ~600-line body
  is a `node --test` argument shim (`node_modules` exclusion, node's dash-path
  quirk, directory expansion).
- `plugin/scripts/diff-stats.mjs:26-36` sizes a review fan-out by classifying
  paths, with "runnable code" defined as `\.[cm]?[jt]sx?$`.

Measured 2026-09-28: a Maven repo (`pom.xml` + `src/test/java/x/FooTest.java`)
is refused at `derive-testcmd.sh` with `refusing to emit a command that would
pass vacuously`, so `claim-ticket.sh:301-302` dies before a worktree or label
exists and `review-pr.js:393-397` throws on every PR. Adding a one-line
`package.json` `{"scripts":{"test":"mvn -q test"}}` makes it pass — the check is
"is there a `scripts.test`", not "is this Node" — but that path needs `npm` on
the machine, is untested, and is documented nowhere. No ADR ever ruled "Node
only"; the shape is an accident of the first consumer.

The refusal policy the shell encodes (#142: refuse rather than guess, because a
runner that passes vacuously reads as a green suite) is sound. The *mechanism*
— a table of ecosystems the plugin recognises — is what does not scale: every
technology added is one more detection arm to keep correct, and each arm
guesses a command that can still pass vacuously (`go test ./...` with no tests
exits 0).

## Decision

1. **The fleet supports consumer repositories of any technology.** A repo the
   fleet cannot run is a defect against the fleet, not a limitation of it.
2. **fleet-ctl maintains no table of supported technologies.** No detection
   arm, no lockfile-to-install map, no test-file regex, no runnable-code
   extension list. The Node arms in `derive-testcmd.sh` and `claim-ticket.sh`
   leave with this ruling; they are not kept as a "fast path".
3. **A consumer repo's Recipe — its Install step and Test entrypoint — is derived
   by agent reasoning over the repository**, under runbook instructions, the way
   a new engineer would read a README, a build file and a CI workflow. The agent
   is the only component allowed to guess.
4. **The vacuity guard moves from "refuse to guess" to "prove the run".** A
   derived Test entrypoint is not usable until it has been executed once and
   shown to run real tests — a non-zero test count, or a deliberate failing
   mutation that turns it red. `tests 0` is already a failed run in the runbook
   (`plugin/skills/run-team/SKILL.md:2171`); this makes that the *only* guard.
   An Install step is not usable until it has been run once in a fresh worktree
   and left every tracked file unchanged — the generalisation of today's
   three-filename lockfile-mutation check (`claim-ticket.sh:435`).
5. **The Recipe is cached as fleet state, not committed as a consumer-facing
   format.** It lives under `.fleet/`, written by the agent that derived and
   proved it, carrying the commit it was derived at and the proof. Scripts read
   the cache; a missing cache is a refusal naming the derivation step, never an
   inference. The cache is invalidated when the Recipe fails to *run* (command
   not found, install dirties the tree), never when tests merely fail — a red
   suite is a finding, not a stale Recipe. A committed declaration file was
   considered and rejected: it is a format the plugin would have to maintain
   and consumers would have to learn, which is the maintenance point 2 refuses.

## Consequences

- `derive-testcmd.sh` shrinks to a cache reader. `claim-ticket.sh` loses its
  lockfile arms and dependency count; `agent-test` becomes a thin exec of the
  Test entrypoint. The `node --test` argument shim is this repository's own
  convenience and leaves the plugin for a repo-local runner (the boundary
  #2089 already draws for run conventions).
- The review snapshot (`review-pr.js` / `review-core.mjs`) reads the same cache;
  `resolveTestCmd` keeps its refusal but the message names the derivation
  step.
- `diff-stats.mjs` sizing must classify without an extension whitelist:
  tests, docs and config by generic patterns, everything else is source.
- Prose that assumes `npm ci`, `node_modules`, or `.test.mjs` naming in
  `plugin/skills/run-team/SKILL.md`, `plugin/commands/review-and-fix.md`,
  `docs/requirements.md` §2.3 and the README is now wrong and is corrected
  with the code.
- A Node repository with `scripts.test` and a lockfile gets exactly the same
  treatment as a Maven one: the agent derives `npm ci` / `npm test` and proves
  them. Zero-config convenience for Node is not a goal; correctness across
  technologies is.
- The one thing the plugin still requires of a consumer's *toolchain* is that
  the derived commands exist on the machine running the fleet. That is the
  operator's precondition, stated in `docs/requirements.md`, not a detection
  the plugin performs.
