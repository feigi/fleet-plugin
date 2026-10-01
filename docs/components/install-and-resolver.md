# Install & Resolver

## What it is for

How an edit to this repo actually reaches a running fleet. The harness
copies a plugin out of its source tree at install time and serves the
copy, never the checkout — so every fleet script has to be found
through an install, never a source path.

## How it works
1. **Call by name.** Every prose callsite names a script, never a path:
   `~/.fleet/bin/fleet-run <script> [args...]`.
2. **Resolve.** [`fleet-run`](../../plugin/scripts/fleet-run) — the
   **Resolver** — takes the realpath of omp's extension package entry
   `~/.omp/plugins/node_modules/@feigi/fleet-ctl`, the one path every install
   kind places, and execs the named script from its `scripts/`
   (`.mjs` via `node`, `.sh` via `sh`), passing argv and cwd through
   untouched.
3. **Bootstrap once.** The Resolver ships *inside* the plugin, so it
   can't resolve itself the first time.
   [`fleet-bootstrap`](../../plugin/scripts/fleet-bootstrap) places one
   copy at `~/.fleet/bin/fleet-run` — the one artefact this repo owns
   outside the plugin, since nothing survives between an agent's tool
   calls. Idempotent and self-limiting: it only overwrites the placed
   copy when its own directory resolves to omp's Install root,
   refusing on a stray checkout run unless `--from-checkout` explicitly
   takes ADR 0003's one-time exception.
4. **Prove provenance.** A **provenance check** hashes the placed
   Resolver copy against the installed one and refuses on drift, naming
   the **Install root** — the directory omp actually loaded the plugin
   from, never a path any script may write to — with its install
   `kind` and a NOTICE when that root is a linked checkout, since then
   every answer came from the dev tree.

## Opinionated choices

- **Installation is the only path an edit takes to reach a harness.**
  No plugin-root environment variable exists for a prose callsite to
  use, and nothing survives between tool calls to bootstrap a resolver
  per-session, so a deliberate, operator-run install/update step is the
  only mechanism left
  ([ADR 0003](../adr/0003-dual-harness-dev-loop-install-is-the-only-path.md)).
- **Code comes from the Install root; data comes from the working
  directory** — one invariant applied to every script.
- **omp is now the only harness this repo targets**
  ([ADR 0014](../adr/0014-omp-is-the-only-harness.md)) and the install
  is its **native extension package**
  ([ADR 0021](../adr/0021-omp-native-install-route-replaces-the-marketplace.md))
  — the Claude-marketplace route a bare-name collision shaped
  ([ADR 0006](../adr/0006-rename-to-fleet-ctl.md)) discards each agent's
  declared model tier by upstream design, so the plugin ships to npm
  instead, where the tier lands as declared.
