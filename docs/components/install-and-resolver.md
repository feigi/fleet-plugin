# Install & Resolver

## What it is for

How an edit to this repo actually reaches a running fleet. The harness
copies a plugin out of its source tree at install time and serves the
copy, never the checkout — so every fleet script has to be found through
an install, never through a source path, and the two tools that make
that possible are the Resolver and its one-time bootstrap.

## How it works

Every prose callsite names a script, never a path: `~/.fleet/bin/fleet-run
<script> [args...]`. [`fleet-run`](../../plugin/scripts/fleet-run) — the
**Resolver** — reads omp's own registry
(`~/.omp/plugins/installed_plugins.json`) for the
`fleet-ctl@fleet-plugin` entry's `installPath`, and execs the named
script from there (`.mjs` via `node`, `.sh` via `sh`, anything else by
its own shebang), passing the caller's argv and cwd through untouched. It
ships *inside* the plugin, so it can't resolve itself the first time;
[`fleet-bootstrap`](../../plugin/scripts/fleet-bootstrap) places one copy
of it at `~/.fleet/bin/fleet-run` — the single artefact this repo owns
outside the plugin, because no per-session mechanism can carry a resolved
path (nothing survives between an agent's tool calls). Bootstrap is
idempotent (re-running reports "unchanged" once the placed copy matches)
and self-limiting: it only overwrites the placed copy when its *own*
directory resolves to a registry-recorded install path, refusing on a
stray checkout run unless `--from-checkout` explicitly takes ADR 0003's
one-time exception. A **provenance check** hashes the placed Resolver
copy against the installed one and refuses on drift, naming the
**Install root** — the directory omp actually loaded the plugin from, as
recorded in its own registry — never a path any script may write to.

## Opinionated choices

Installation is the only path an edit takes to reach a harness — no
plugin-root environment variable exists for a prose callsite to use, and
nothing survives between tool calls to bootstrap a resolver per-session,
so a deliberate, operator-run install/update step is the only mechanism
left ([ADR 0003](../adr/0003-dual-harness-dev-loop-install-is-the-only-path.md)).
Code comes from the Install root; data comes from the working directory —
one invariant applied to every script, so `instruments.sh` and its
siblings are CWD-derived with an explicit `--repo` override rather than
"measure the tree this file happened to ship from." omp is now the only
harness this repo targets
([ADR 0014](../adr/0014-omp-is-the-only-harness.md)) — the qualified
marketplace id `fleet-ctl@fleet-plugin` (not the bare `fleet-ctl`) is what
makes an install unambiguous, chosen after a bare-name collision with an
unrelated package was measured resolving silently wrong
([ADR 0006](../adr/0006-rename-to-fleet-ctl.md)).
