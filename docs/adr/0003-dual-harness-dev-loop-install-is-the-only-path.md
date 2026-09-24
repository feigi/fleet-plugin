# 0003 — Installation is the only path: the dual-harness dev loop

**Status:** Accepted. Ruled 2026-09-09 on #1294, against the measurements below. Amended by ADR 0012: point 9's `eval.workpool.freshAgents` precondition is retired with the omp workpool; points 1–8 stand.

## Context

Both harnesses **copy** a plugin out of its source tree at install time and
serve the copy. Neither serves the checkout. Measured 2026-09-08/09 on Claude
Code 2.1.265 and omp 18.1.14, this repo:

- **Claude Code**, directory source: copy at
  `~/.claude/plugins/cache/fleet-plugin/fleet/<version>/`, 5.5M. Excludes
  `.git`, `.worktrees/`, `.claude/`; **includes** gitignored `.fleet/` (1.7M of
  live ledger/board state) and `.agent-brain/` (576K). The rule is not
  gitignore.
- **omp**, directory source: byte-for-byte whole-tree copy, 49M, `.git` and the
  live nested worktrees included. No exclusion mechanism exists in either
  harness — no `.claudeignore`, no `files` field, no flag, nothing in either
  doc set.
- `claude plugin update` compares the **version string** only: same string →
  `already at the latest version`, rc=0, nothing copied. The cache accumulates
  (`0.1.0/` and `0.1.1/` sit side by side; a bump never replaces).
- `omp plugin upgrade <name>@<marketplace>` reinstalls **unconditionally**;
  only the bulk form compares versions. The two harnesses disagree.
- A running session sees no source edit, on either harness. omp's
  `/reload-plugins` fires successfully and changes nothing for an injected
  root. A session started after the edit sees it.

Three further facts decided the shape of the remedy:

- **No plugin-root variable exists for any prose caller, on either harness.**
  `printenv | grep -i PLUGIN` from a skill-issued Bash call is empty on both,
  reproduced across versions and for agent-issued calls. Anthropic documents
  `${CLAUDE_PLUGIN_ROOT}` substitution for `hooks.json` and `.mcp.json` only
  (`anthropics/claude-code#9354`, closed). omp has no such variable under any
  name. A Claude **hook** does receive it — and it resolves to the **source
  checkout**, not the install, for exactly this repo's `"source": "./"` shape
  (`anthropics/claude-code#38699`, closed at 2.1.94 and locked, reproducing at
  2.1.265; refiled with both findings as
  `anthropics/claude-code#93057`).
- **A git-source install checks out committed content only.** Untracked and
  gitignored files are absent on both harnesses. This is the exclusion
  mechanism neither harness offers as a feature.
- **Nothing survives between Bash-tool calls.** A shell function defined in
  one call is `command not found` in the next, on both harnesses; on omp
  `export` and `cd` do not persist either. A dispatched subagent inherits
  nothing. Only files on disk persist.

Against that, 35 prose callsites invoked scripts by absolute **source** path
(`~/dev/fleet-plugin/scripts/…`) — 19 in `skills/run-team/SKILL.md`, the rest
across `skills/next-ticket`, `commands/review-and-fix`, `commands/run-merge-bot`
and `workflows/review-pr.js`. That convention was itself a measured
conclusion: the installed path is version-stamped, so nothing outside the
plugin can name it stably, therefore point external callers at source. The
result was **split-brain** — prose from the frozen copy, scripts from live
source, so a skipped install runs new scripts under old instructions.

## Decision

**Installation is the only path by which a repo edit reaches a harness.** The
step is manual and deliberate; the operator runs harness-native commands.

1. **Source shape.** The marketplace entry is a **branch-pinned git source**
   with **no `version` field anywhere**. Claude Code then keys updates off the
   branch tip's commit SHA — a new commit *is* a version change, so no bump
   ritual exists and the no-op trap is unreachable. omp records the constant
   `0.0.0` and re-fetches in place on every `plugin upgrade`. Committed content
   only, so the 29M of runtime directories cannot enter an install.
2. **Pre-merge iteration** installs from an **untracked dev catalog outside the
   repo**, pinning a local branch of the working checkout. A `file://` git
   source needs no remote and installs an unpushed branch — measured. The
   tracked catalog never changes for a dev iteration.
3. **Only installed scripts run.** No prose callsite names a source path, a
   harness path, or a registry lookup. Every callsite calls the **resolver**,
   which reads the harness's own registry for `fleet@fleet-plugin`'s
   `installPath` and execs from there — the key is `fleet-ctl@fleet-plugin`
   since #1348 (ADR 0006).
4. **The resolver is the one bootstrap exception.** It ships inside the plugin
   and is placed once, by hand, at a path this repo owns
   (`~/.fleet/bin/fleet-run`) — it cannot resolve itself, and no per-session
   mechanism can carry it, because no shell state persists. The **provenance
   check** hashes the placed copy against the installed one and refuses on
   drift.
5. **Code from the install root, data from the working directory.** One
   invariant for every script. `instruments.sh` loses its "measure the tree
   this file came from" contract and becomes CWD-derived with an explicit
   `--repo` override.
6. **Version record.** `patch`/`minor`/`major` on every PR, hard-failing on
   zero or two; a post-merge workflow computes the next version from tags and
   cuts a tag plus a Release with generated notes; the tree is never written.
   Seeded at `v0.1.1`. Installs reference none of it — tags are the
   human-facing record, not an install input.
7. **The payload re-nests under `plugin/`**, so the marketplace source is a
   subtree rather than the repository root.
8. **`enabledProviders: ["claude-plugins"]` is a hard precondition on omp**, not
   a preference: plugin **agents** are invisible without it, for both install
   origins, because `discoverAgents` applies an undocumented
   `isUserSourceEnabled` gate with no exemption for omp's own registry
   (reported as `can1357/oh-my-pi#11362`). The provenance check asserts it and
   names the remedy; nothing writes the operator's global config silently.
9. **`eval.workpool.freshAgents: true` is a second hard precondition on omp**,
   and it is install-time operator work — no run ever sets it. (Added
   2026-09-22 on #1589; points 1–8 are as ruled on #1294.) #1420 refills
   implementer slots from an omp workpool, and a pool hands a queued item to a
   *worker*: at this key's schema default of `false`, omp routes the item onto
   an existing idle worker and extends that worker's transcript. That is a
   **Wake** (CONTEXT.md § Coordination) — the one thing a refill may never be,
   and silent when it happens, because nothing records that the previous
   ticket's worktree paths and claim state came with the item. It is not a pool
   argument: `workpool(agent, name, context, tools)` carries no such field, so
   there is nothing to pass at call time and nothing to scope to one pool.
   **It is session-wide**: the key governs *every* pool the session opens, not
   only the fleet's, so an operator who turns it on has changed how any other
   workpool in that session dispatches too. Two ways to set it, and only two:

   - **Global** — `omp config set eval.workpool.freshAgents true`. This is the
     global path and *only* the global path: `omp config set` and
     `omp config reset` always write the main YAML under the active agent
     directory (`~/.omp/agent/config.yml`; `omp config path` prints the
     directory), and never write an arbitrary key to a project file. This
     repo's own `.github/scripts/smoke-omp.sh` captures and restores
     `enabledProviders` around a `config set` for exactly that reason.
   - **Project-scoped** — hand-edit `<repo>/.omp/config.yml`. There is no
     command for it: omp's one supported project write is a model-role
     assignment under `modelRoleStorage: project`. Two properties bite here.
     Project settings are discovered from the **process working directory's**
     `.omp/`, and discovery never walks ancestors, so a session started inside
     `.worktrees/<claim>/` does not see the repo root's file. And the project
     layer outranks the global one, so a project `false` silently overrides a
     global `true`. (A `--config` overlay is not a third path — per-process,
     and measured in `smoke-omp.sh` failing to override an already-set global
     value for `enabledProviders`.)

   Verify by reading the **effective** value, never a file:
   `omp config get eval.workpool.freshAgents --json`, run from the directory
   the session will start in. Settings resolve through five layers — runtime
   overrides, `--config` overlays, project settings, global settings, schema
   defaults — so any one file answers a different question. Measured
   2026-09-22 on omp 18.2.6: `omp config path` printed `~/.omp/agent`, and the
   read above answered
   `{"key":"eval.workpool.freshAgents","value":false,"type":"boolean"}` on a
   machine that had never set it.

   **No run-time instruction may tell a controller to write this, or any other,
   configuration** — and none does. A fleet that ran `omp config set` to open
   its own pool would be editing the operator's machine-wide file to dispatch
   one wave, and changing every other pool in the session with it. Same
   discipline as point 8: a precondition is the operator's to set and the
   fleet's only to read.

## Rejected alternatives

- **The git tag as the version.** Measured: both harnesses resolve the version
  from `plugin.json` → catalog entry → commit SHA. With `plugin.json` at
  `9.9.9` and the tag at `v0.0.7`, both recorded `9.9.9` and named the cache
  directory after it. The tag selects a commit and is never written down.
  Worse, tag-pinning needs the catalog's `ref` edited **in the tree** per
  release plus a changed version string — a tag move alone is a silent no-op on
  both harnesses — which is exactly the in-tree write the version model
  rejects.
- **An installer that stamps a version into `plugin.json`.** Works, and makes
  the release step write the tree. Discarded once the branch-pinned source
  removed the need for a version string at all.
- **Keeping the directory source.** Re-admits every untracked and gitignored
  file, including omp shipping the entire `.git`.
- **`--plugin-dir` injected roots as the loop.** Measured working for skills
  and commands on both harnesses, and measured **not** to feed omp's task-agent
  discovery at all — reproduced against a clean synthetic plugin. A member
  verifying an `agents/` change through it gets a false pass.
- **Inlining the registry lookup at all 35 callsites.** No bootstrap and no
  drift, at the cost of a two-registry incantation read and paid for on every
  skill load, with change amplification across five files.
- **Bootstrapping the resolver once per session as a shell function.**
  Unavailable: no shell state survives between Bash-tool calls on either
  harness.
- **A self-publishing SessionStart hook.** Rests on omp running
  plugin-shipped hooks (unmeasured) and on the hook's plugin root pointing at
  the install rather than the checkout (measured **wrong** for the directory
  shape, unmeasured for git).
- **Relying on `.gitignore`.** Already in force for `.fleet/`, `.worktrees/`
  and `.agent-brain/`, and inert: both harnesses copy ignored content anyway,
  in different patterns.

## Consequences

- The operator's loop is: edit, install/update on each harness, restart the
  session. Nothing is automatic and nothing is silent.
- Installing on omp is the plugin plus two settings, not the plugin alone:
  `enabledProviders` (point 8) and `eval.workpool.freshAgents` (point 9). Both
  are session-wide and the operator's to set once, and neither is written by
  the fleet. Only `enabledProviders` is read and refused on by what the fleet
  runs — the provenance check (`plugin/scripts/fleet-provenance`) asserts it
  and refuses on drift. `eval.workpool.freshAgents` has no fleet-side runtime
  check yet: point 9's `omp config get eval.workpool.freshAgents --json` is
  for the operator to verify by hand, not something the fleet reads. CONTEXT.md
  § Install calls the pair an **Install-time precondition** — set once by the
  operator either way, enforced today only for the first.
- Provenance is answered by `installPath` plus a content digest, never by a
  version string: omp's recorded version is permanently `0.0.0`, and Claude's
  update path leaves no `.git` in the new cache directory.
- Four marketplace registrations exist, not two — production and dev catalogs
  across two harnesses.
- The fleet no longer edits its own running code. No member claims or
  implements a ticket in this repo; review and the merge bot still run, because
  they manipulate git rather than load the plugin. Operator-present sessions
  implement normally.
- One `[INFERENCE]` is carried forward as a named gap rather than a fact: omp's
  **command enumeration** for an `origin: "claude"` install. Direct
  `/fleet:<command>` invocation was measured working; enumeration was not, and
  it contradicts the source-level gate read from the shipped bundle.
- `workflows/` has no host on omp. That gap belongs to #1303 and is not
  papered over here.
