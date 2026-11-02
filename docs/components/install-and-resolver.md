# Install & Resolver

## What it is for

How an edit to this repo actually reaches a running fleet. The harness
copies a plugin out of its source tree at install time and serves the
copy, never the checkout — so every fleet script has to be found
through an install, never a source path.

## How it works
1. **Call by name, through the Package entry.** Every prose callsite
   names a script, never a path to it:
   `~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run <script> [args...]`.
   The **Package entry**, `~/.omp/plugins/node_modules/@feigi/fleet-ctl`,
   is where every install kind places the plugin, the same path for every
   version, so it is the one plugin path prose writes down — for the
   Resolver, and for a runbook read in place, such as
   `~/.omp/plugins/node_modules/@feigi/fleet-ctl/commands/run-merge-bot.md`.
2. **Resolve.** [`fleet-run`](../../plugin/scripts/fleet-run) — the
   **Resolver** — takes the realpath of the Package entry and execs the
   named script from its `scripts/` (`.mjs` via `node`, `.sh` via `sh`),
   passing argv and cwd through untouched. Prose runs the package's own
   copy, so nothing is placed outside the plugin: `omp plugin install` is
   the whole install.
3. **Prove provenance.** A **provenance check**
   ([`fleet-provenance`](../../plugin/scripts/fleet-provenance)) names the
   **Install root** — the directory omp actually loaded the plugin from,
   never a path any script may write to — with its install `kind`,
   recorded version, a digest over its `scripts/`, and a NOTICE when that
   root is a linked checkout, since then every answer comes from the dev
   tree — which is why a fleet run refuses such a root
   ([Instruments](instruments.md)). It exits 0 when the Package entry
   resolves and 2 when it does not.

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
