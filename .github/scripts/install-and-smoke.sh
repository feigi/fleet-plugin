#!/usr/bin/env bash
# The `install-and-smoke` job body (#1294 hand-off §2, #1339, #1347 —
# reworked per PR #1365's review). The ORIGINAL design here ran the whole
# `*.test.mjs` suite from an installed copy's `scripts/` directory; that
# cannot pass. A git-subdir install carries `plugin/` alone, and roughly 30
# test files read repo-root paths a plugin-only payload never has
# (`.github/workflows/*.yml`, `docs/adr/*`, `docs/specs/*`) — measured
# running the old script verbatim: 1964 tests, 70 failures, eight files
# dying at module evaluation on a bare ENOENT before a single one of their
# tests could run.
#
# The actual ruling (#1294, "Q16c"): "source unit tests plus ONE
# install-and-smoke job, so the invariant the install-only dev loop
# introduces — scripts resolving from the Install root while their target
# repo is elsewhere — is actually exercised." The invariant under test is
# RESOLUTION (does a script name in prose actually resolve to a real file
# inside the install omp picked), never full suite coverage from inside an
# install — source unit tests already cover the suite, from the checkout,
# where every repo-root path they read is real. This script:
#
#   1. Installs the plugin on omp from a throwaway `file://` git-subdir dev
#      catalog of this checkout (never the tracked marketplace, never a
#      directory source — ADR 0003: a directory install re-admits every
#      untracked/gitignored file; a git source checks out committed content
#      only, the way the operator's own install does).
#   2. Places the Resolver (`fleet-bootstrap --from-checkout`) and runs
#      `fleet-provenance` — the Install root, the Resolver's own drift
#      check, and the `enabledProviders` precondition all come from ONE
#      already-built instrument rather than reimplemented here.
#   3. For every script NAME a `~/.fleet/bin/fleet-run <script>` prose
#      callsite names — grepped fresh from `plugin/skills`,
#      `plugin/commands`, never a hardcoded list that can go stale —
#      resolves it via `fleet-run --path <script>` and asserts the resolved
#      path exists as a real file inside the install root.
#   4. Execs `fleet-run arg.mjs` once and requires exit 0 — one real
#      execution through the Resolver, not just a path resolution.
#
# No test suite runs from an install anywhere in this script.
set -euo pipefail

BUN_PIN="1.4.0"
OMP_PIN="18.1.15"

ACTUAL_BUN="$(bun --version)"
ACTUAL_OMP="$(omp --version | sed 's#^omp/##')"
for pair in "bun:$BUN_PIN:$ACTUAL_BUN" "omp:$OMP_PIN:$ACTUAL_OMP"; do
  IFS=':' read -r name want got <<<"$pair"
  if [ "$want" != "$got" ]; then
    echo "::error::install-and-smoke: $name pinned to $want, found $got on PATH"
    exit 1
  fi
done

# Derived, never hardcoded (#1314's own ruling, review finding #3): a rename
# would stale a literal, and the bare name resolves to a different package
# entirely (the fleetctl/#1319 collision, from the other direction).
# `fleet-provenance`/`fleet-bootstrap` key their registry reads on the
# literal "fleet-ctl@fleet-plugin" — deriving these two names from the
# tracked manifests is what keeps that key aligned with what this script
# actually installs, without duplicating the constant here.
PLUGIN_NAME="$(jq -r '.name' plugin/.claude-plugin/plugin.json)"
MARKETPLACE_NAME="$(jq -r '.name' .omp-plugin/marketplace.json)"
if [ -z "$PLUGIN_NAME" ] || [ "$PLUGIN_NAME" = "null" ] || [ -z "$MARKETPLACE_NAME" ] || [ "$MARKETPLACE_NAME" = "null" ]; then
  echo "::error::install-and-smoke: could not read plugin/marketplace name from the tracked manifests"
  exit 2
fi
PLUGIN_ID="$PLUGIN_NAME@$MARKETPLACE_NAME"

REPO_ROOT="$(pwd)"
REF="${INSTALL_AND_SMOKE_REF:-$(git rev-parse --abbrev-ref HEAD)}"
# HOME nested inside the checkout for the same reason smoke-omp.sh's sibling
# design note gives: every mutation (config, registries, the placed
# Resolver) is then scoped to a scratch tree this script owns and restores,
# never the caller's real state.
SCRATCH_HOME="$REPO_ROOT/.install-and-smoke-home"
MKT_DIR="$(mktemp -d)"

rm -rf "$SCRATCH_HOME"
mkdir -p "$SCRATCH_HOME"

cleanup() {
  HOME="$SCRATCH_HOME" omp plugin uninstall "$PLUGIN_ID" --scope=user >/dev/null 2>&1 || true
  HOME="$SCRATCH_HOME" omp plugin marketplace remove "$MARKETPLACE_NAME" >/dev/null 2>&1 || true
  rm -rf "$MKT_DIR" "$SCRATCH_HOME"
}
trap cleanup EXIT

mkdir -p "$MKT_DIR/.omp-plugin"
cat > "$MKT_DIR/.omp-plugin/marketplace.json" <<EOF
{
  "name": "$MARKETPLACE_NAME",
  "description": "install-and-smoke throwaway catalog (#1347)",
  "owner": { "name": "ci" },
  "plugins": [
    {
      "name": "$PLUGIN_NAME",
      "source": {
        "source": "git-subdir",
        "url": "file://$REPO_ROOT",
        "path": "plugin",
        "ref": "$REF"
      },
      "description": "install-and-smoke throwaway install",
      "category": "productivity"
    }
  ]
}
EOF

fail=0

# ---- install on omp ----
HOME="$SCRATCH_HOME" omp config set enabledProviders '["claude-plugins"]' >/dev/null
HOME="$SCRATCH_HOME" omp plugin marketplace add "$MKT_DIR" --scope=user >/dev/null
HOME="$SCRATCH_HOME" omp plugin install "$PLUGIN_ID" --scope=user --force >/dev/null

# ---- place the Resolver, then run the Provenance check ----
HOME="$SCRATCH_HOME" node plugin/scripts/fleet-bootstrap --from-checkout
echo "== fleet-provenance =="
if ! HOME="$SCRATCH_HOME" node plugin/scripts/fleet-provenance --omp-config "$SCRATCH_HOME/.omp/agent/config.yml"; then
  echo "::error::install-and-smoke: fleet-provenance failed — see output above"
  fail=1
fi

# ---- every ~/.fleet/bin/fleet-run <script> callsite resolves ----
# Extracted fresh, never hardcoded: a prose edit that adds or renames a
# callsite is covered on arrival, and a stale list here could not go
# unnoticed the way a hardcoded one could.
# shellcheck disable=SC2088 # literal grep PATTERN text, not a path to expand
SCRIPT_NAMES="$(grep -rhoE '~/\.fleet/bin/fleet-run[[:space:]]+[A-Za-z][A-Za-z0-9_.-]*\.(mjs|sh)' \
  plugin/skills plugin/commands plugin/scripts \
  | sed -E 's#^~/\.fleet/bin/fleet-run[[:space:]]+##' \
  | sort -u)"
if [ -z "$SCRIPT_NAMES" ]; then
  echo "::error::install-and-smoke: no ~/.fleet/bin/fleet-run <script> callsites found — this check would verify nothing"
  fail=1
fi

RESOLVER="$SCRATCH_HOME/.fleet/bin/fleet-run"
echo "== resolving every fleet-run callsite target =="
count=0
while IFS= read -r script; do
  [ -z "$script" ] && continue
  count=$((count + 1))
  resolved="$(HOME="$SCRATCH_HOME" node "$RESOLVER" --path "$script" 2>&1)" || {
    echo "::error::install-and-smoke: fleet-run --path $script failed to resolve: $resolved"
    fail=1
    continue
  }
  if [ ! -f "$resolved" ]; then
    echo "::error::install-and-smoke: $script resolved to $resolved, which is not a real file"
    fail=1
  fi
done <<<"$SCRIPT_NAMES"
echo "install-and-smoke: $count callsite target(s) resolved to real files"

# ---- one real execution through the Resolver ----
if ! HOME="$SCRATCH_HOME" node "$RESOLVER" arg.mjs; then
  echo "::error::install-and-smoke: fleet-run arg.mjs did not exit 0"
  fail=1
else
  echo "install-and-smoke: fleet-run arg.mjs exited 0"
fi

if [ "$fail" -ne 0 ]; then
  echo "::error::install-and-smoke: one or more checks failed — see above"
  exit 1
fi

echo "install-and-smoke: provenance clean, every fleet-run callsite target resolved, arg.mjs ran clean"
