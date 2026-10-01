#!/usr/bin/env bash
# The `install-and-smoke` job body (#1294 hand-off §2, #1339, #1347 —
# reworked per PR #1365's review; ADR 0021 moved it off the marketplace
# install). The ORIGINAL design here ran the whole `*.test.mjs` suite from
# an installed copy's `scripts/` directory; that cannot pass. A plugin
# payload carries `plugin/` alone, and roughly 30 test files read repo-root
# paths a plugin-only payload never has (`.github/workflows/*.yml`,
# `docs/adr/*`, `docs/specs/*`) — measured running the old script verbatim:
# 1964 tests, 70 failures, eight files dying at module evaluation on a bare
# ENOENT before a single one of their tests could run.
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
#   1. Installs the plugin the way the native route installs it —
#      `omp plugin link plugin/` against a scratch HOME (ADR 0021 retired
#      the throwaway `file://` git-subdir dev catalog this step used; the
#      link route is also the route that honors each agent's declared
#      tier, which smoke-omp.sh asserts separately).
#   2. Places the Resolver (`fleet-bootstrap --from-checkout`) and runs
#      `fleet-provenance` — the Install root, its kind, and the Resolver's
#      own drift check all come from ONE already-built instrument rather
#      than reimplemented here; this script only requires the printed kind
#      to be `linked-checkout`, the shape step 1 installed. The
#      `enabledProviders` precondition retired with the marketplace route
#      (ADR 0021), so no scratch config is needed to make this pass
#      anymore — proving the point.
#   3. For every script NAME a `~/.fleet/bin/fleet-run <script>` prose
#      callsite names — grepped fresh from `plugin/skills`,
#      `plugin/commands`, `plugin/scripts`, never a hardcoded list that can go stale —
#      resolves it via `fleet-run --path <script>` and asserts the resolved
#      path exists as a real file inside the install root.
#   4. Execs `fleet-run arg.mjs` once and requires exit 0 — one real
#      execution through the Resolver, not just a path resolution.
#
# No test suite runs from an install anywhere in this script.
set -euo pipefail

BUN_PIN="1.4.0"
OMP_PIN="18.4.4"

ACTUAL_BUN="$(bun --version)"
ACTUAL_OMP="$(omp --version | sed 's#^omp/##')"
for pair in "bun:$BUN_PIN:$ACTUAL_BUN" "omp:$OMP_PIN:$ACTUAL_OMP"; do
  IFS=':' read -r name want got <<<"$pair"
  if [ "$want" != "$got" ]; then
    echo "::error::install-and-smoke: $name pinned to $want, found $got on PATH"
    exit 1
  fi
done

# Derived, never hardcoded (#1314's own ruling, review finding #3): the
# package name is the node_modules dir the Resolver keys on (ADR 0021) —
# deriving it from the manifest is what keeps that key aligned with what
# this script actually installs, without duplicating the constant here.
PLUGIN_NAME="$(jq -r '.name' plugin/package.json)"
if [ -z "$PLUGIN_NAME" ] || [ "$PLUGIN_NAME" = "null" ]; then
  echo "::error::install-and-smoke: could not read the plugin name from plugin/package.json"
  exit 2
fi

REPO_ROOT="$(pwd)"
# HOME nested inside the checkout for the same reason smoke-omp.sh's sibling
# design note gives: every mutation (registries, the placed Resolver) is
# then scoped to a scratch tree this script owns and deletes, never the
# caller's real state.
SCRATCH_HOME="$REPO_ROOT/.install-and-smoke-home"

rm -rf "$SCRATCH_HOME"
mkdir -p "$SCRATCH_HOME"

cleanup() {
  HOME="$SCRATCH_HOME" omp plugin uninstall "$PLUGIN_NAME" >/dev/null 2>&1 || true
  rm -rf "$SCRATCH_HOME"
}
trap cleanup EXIT

fail=0

# ---- install on omp: the native link route (ADR 0021) ----
if ! HOME="$SCRATCH_HOME" omp plugin link "$REPO_ROOT/plugin" >/dev/null; then
  echo "::error::install-and-smoke: omp plugin link plugin/ failed"
  exit 1
fi

# ---- place the Resolver, then run the Provenance check ----
HOME="$SCRATCH_HOME" node plugin/scripts/fleet-bootstrap --from-checkout
echo "== fleet-provenance =="
prov_rc=0
provenance="$(HOME="$SCRATCH_HOME" node plugin/scripts/fleet-provenance)" || prov_rc=$?
printf '%s\n' "$provenance"
if [ "$prov_rc" -ne 0 ]; then
  echo "::error::install-and-smoke: fleet-provenance failed (exit $prov_rc) — see output above"
  fail=1
fi
# This script installs by link, so the Provenance check must classify the
# root as one (ADR 0021) — a misclassification still exits 0, so only the
# printed kind line can catch it.
if ! grep -qxF 'fleet-provenance: kind: linked-checkout' <<<"$provenance"; then
  echo "::error::install-and-smoke: fleet-provenance did not report 'kind: linked-checkout' for the linked checkout"
  fail=1
fi

# ---- every ~/.fleet/bin/fleet-run <script> callsite resolves ----
# Extracted fresh, never hardcoded: a prose edit that adds or renames a
# callsite is covered on arrival, and a stale list here could not go
# unnoticed the way a hardcoded one could.
# The grep runs outside any pipeline so `set -euo pipefail` cannot abort the
# script on its status before the checks below name the cause: rc 1 is "no
# match" and lands in the empty-set check, rc 2+ is grep itself failing.
grep_rc=0
# shellcheck disable=SC2088 # literal grep PATTERN text, not a path to expand
CALLSITES="$(grep -rhoE '~/\.fleet/bin/fleet-run[[:space:]]+[A-Za-z][A-Za-z0-9_.-]*\.(mjs|sh)' \
  plugin/skills plugin/commands plugin/scripts)" || grep_rc=$?
if [ "$grep_rc" -gt 1 ]; then
  echo "::error::install-and-smoke: the callsite grep itself failed (rc $grep_rc) — its stderr is above"
  fail=1
fi
SCRIPT_NAMES=""
if [ -n "$CALLSITES" ]; then
  SCRIPT_NAMES="$(sed -E 's#^~/\.fleet/bin/fleet-run[[:space:]]+##' <<<"$CALLSITES" | sort -u)"
fi
if [ -z "$SCRIPT_NAMES" ]; then
  echo "::error::install-and-smoke: no fleet-run callsites found — the grep itself broke, not the callsites"
  fail=1
fi

RESOLVER="$SCRATCH_HOME/.fleet/bin/fleet-run"
RESOLVE_ERR="$SCRATCH_HOME/resolve.err"
echo "== resolving every fleet-run callsite target =="
count=0
while IFS= read -r script; do
  [ -n "$script" ] || continue
  if resolved="$(HOME="$SCRATCH_HOME" node "$RESOLVER" --path "$script" 2>"$RESOLVE_ERR")"; then
    if [ -f "$resolved" ]; then
      count=$((count + 1))
    else
      echo "::error::install-and-smoke: $script resolved to a non-file: $resolved"
      fail=1
    fi
  else
    echo "::error::install-and-smoke: $script did not resolve through the Resolver: $(cat "$RESOLVE_ERR")"
    fail=1
  fi
done <<<"$SCRIPT_NAMES"
echo "install-and-smoke: $count callsite target(s) resolved to real files"

# ---- one real execution through the Resolver ----
if ! HOME="$SCRATCH_HOME" node "$RESOLVER" arg.mjs; then
  echo "::error::install-and-smoke: fleet-run arg.mjs exited non-zero through the Resolver"
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "install-and-smoke: FAILED"
  exit 1
fi

echo "install-and-smoke: provenance clean, every fleet-run callsite target resolved, arg.mjs ran clean"
