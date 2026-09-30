# 0020 — Member write boundary is enforced by a shipped omp extension

**Status:** Accepted. Ruled 2026-09-29 on #1411 by the maintainer, from a
grilling session. Implemented in `plugin/scripts/member-write-guard.mjs`,
loaded through `plugin/package.json#omp.extensions`. (ADR 0021: the load
itself is measured fail-open on both install routes — `omp plugin doctor`
never imports an extension module — which is why §7's silent-failure finding
stands under the native route too.)

## Context

The `task` tool has no per-dispatch working directory. A fleet member
inherits the controller's session cwd, which is the main checkout, not the
worktree it was claimed. `write`, `edit` and `ast_edit` resolve a relative
path against that cwd, so a member that writes `plugin/scripts/foo.mjs` edits
the tree the controller and every other member read their instruments from.
The agent bodies and `run-team` prompts said so at length. Members kept doing
it: #1727 recorded four occurrences in one run, none caught by any fleet
mechanism.

Three routes were weighed.

1. **Harness isolation** (`isolated: true`, `isolation: worktree`). Refuted by
   #1315 on omp: an isolated member works in `~/.omp/wt/<hash>`, ignores the
   claimed worktree, and on completion patch-applies its changes into the
   session cwd, which is the controller's main checkout. That moves the spill
   rather than stopping it. ADR 0005's forbidden `isolation` key stays
   forbidden. The Claude-side option is moot, since omp is the only harness
   (ADR 0014).
2. **A per-dispatch `cwd` field.** It does not exist in omp, and has been
   requested upstream as can1357/oh-my-pi#13754. Even once it lands, an
   absolute path into the main checkout bypasses it.
3. **A `tool_call` extension.** Chosen. Measured 2026-09-29 on omp 18.4.3 in
   a sandbox repo:
   - `ctx.agent` is `{kind:"sub", id:"impl-9999", name:"fleet-implementer",
     depth:1, parentId:"Main"}`. `id` is the task item's `name`, and `name`
     is the agent definition's name.
   - `ctx.cwd` is the repo root. `event.input.path` arrives raw, so the
     handler resolves it against `ctx.cwd` itself.
   - Returning `{block: true, reason}` stops the call, and the member sees
     the reason as the tool's error.

## Decision

1. **The plugin ships `member-write-guard` as an omp extension.** It refuses
   a call and never rewrites one. The reason names the resolved path and tells
   the member to re-issue it with an absolute path under its worktree,
   `.worktrees/<n>-<slug>/`.
2. **Who is guarded.** A subagent whose `ctx.agent.name` starts with
   `fleet-`, or a subagent whose `ctx.agent.parentId` matches
   `^(impl|fix-pr|review-pr|finisher-pr)-\d+(-[a-z])?$`: a fleet member's
   child, which carries a generic definition name. Nothing else is guarded,
   and a top-level session never is. The extension loads in every omp session
   on the box, so unrelated subagents in other repos must stay unaffected.
3. **Path-writer rule, for everyone in 2.** A `write`, `edit` or `ast_edit`
   target is resolved with `path.resolve(ctx.cwd, p)`. The call is refused
   when that path lies inside the main checkout and `git check-ignore` says it
   is not ignored. `.worktrees/`, `.fleet/` and `.agent-brain/` are ignored in
   a fleet repo, so worktrees, run state and agent-brain's `memory-proxy`
   cache stay writable. For `edit` the targets are the section headers, omp's
   derived `path`/`paths`, any `MV` destination, and apply_patch-mode file
   headers.
4. **Bash-cwd rule, for `fleet-implementer` and `fleet-implementer-alt`
   only.** Fix-appliers are included, since they are dispatched as
   `fleet-implementer`. A `bash` call is refused when `input.cwd ?? ctx.cwd`
   lies inside the main checkout outside `.worktrees/`. Command text is never
   parsed. The rule is withheld from three groups, which get only rule 3:
   - Review specialists and refuters are *required* to run `pwd` first from
     the inherited cwd and `cd` inside the command (`cwd-isolation-pins.mjs`).
   - The finisher runs `worktree-audit.sh`, `gh` and `git worktree add`
     without a `cwd`, and its only repo write is a detached worktree under
     `<scratch>`.
   - Children follow ad-hoc briefs.
5. **When the guard cannot decide.** If `ctx.cwd` is in no git repository,
   the call is allowed. If git fails while resolving the main checkout or
   answering `check-ignore`, the call is blocked, and the reason names the
   failure. A gitfile that points at a missing git dir is a failure, not "no
   repository".
6. **The main-checkout root** is the parent of `git rev-parse
   --git-common-dir`, via `git-env.mjs`'s `gitEnv()` and
   `workspaceDirFromGitCommonDir()`, as `fleet-tick.mjs` resolves the run's
   workspace. It is never `--show-toplevel`, which answers a worktree's own
   root from inside one, and never an unscrubbed env (#1599). Paths are
   compared after symlink resolution.
7. **Distribution.** `plugin/package.json` carries `"name": "fleet-ctl"`,
   `"version": "0.0.0"` and `"omp": {"extensions":
   ["scripts/member-write-guard.mjs"]}`. A marketplace install symlinks the
   cached plugin into the scope's `plugins/node_modules/fleet-ctl`, and the
   extension loader imports it from `package.json#omp.extensions` (omp's
   `docs/plugin-manager-installer-plumbing.md`: this is the
   `MarketplaceManager` install path, distinct from `PluginManager.install()`'s
   npm/git/link path — the one that validates a declared extension
   initialises and rolls back the install on failure). A marketplace install
   carries no such check: a load failure is instead captured per-path at
   runtime (`docs/extension-loading.md`) and does not stop other extensions
   or abort the session — the guard simply does not load, silently, which is
   part of why #2210's detection backstop exists. There is no semver, no
   catalog version, and no project-scoped `.omp/extensions/` copy. Rollout is
   `omp plugin upgrade fleet-ctl@fleet-plugin` and a session restart (README,
   Installation).

## Consequences

- **The guard and #2210 protect one set:** the main checkout's non-ignored
  paths, which is what its `git status` shows dirty. The guard prevents
  writes to that set through `write`/`edit`/`ast_edit`; #2210 detects
  whatever reaches it another way. A repo that runs the fleet must ignore
  `.worktrees/`, which `reap.sh`, `release-ticket.sh` and `worktree-audit.sh`
  already assume. Otherwise every worktree write is refused, and the reason
  says the path is not gitignored.
- **Not covered, by design:**
  - Relative reads, which read the wrong tree but write nothing.
  - `eval`, which #2210 covers.
  - A `bash` command that writes into the main checkout from an allowed cwd.
  - A session whose cwd is in no repository.
- **The child clause measured at depth 2** (omp 18.4.3, #1411's acceptance
  smoke). A `task` child spawned by a member named `impl-4243` reported
  `id: "impl-4243.Child"` and `parentId: "impl-4243"`, and the guard refused
  its relative write. A grandchild's `parentId` would be that dotted id, so it
  is not guarded. The shipped `fleet-implementer` declares no `spawns`, so omp
  disables its `task` and `eval` spawning today: the clause binds as soon as
  a member definition may spawn.
- **Fail-closed cost.** omp blocks a call whose `tool_call` handler throws or
  times out. The handler therefore returns before any I/O for every agent
  outside rule 2, and its scope check does not throw on a malformed
  `ctx.agent`.
- **Prose keeps the rule and loses the mitigation.** The agent bodies and the
  fix-applier prompt keep the absolute-path rule, the session-root fact, and
  one sentence on what a refusal means. The incident narratives and the
  by-hand detection and recovery steps are gone. The `eval` paragraph stays,
  because `eval` is unguarded.
