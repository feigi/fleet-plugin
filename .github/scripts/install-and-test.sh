#!/usr/bin/env bash
# The `install-and-test` job body (#1294 hand-off §2, #1339, #1347).
#
# Ruled on #1294 as: source unit tests plus ONE install-and-smoke job, so the
# invariant the install-only dev loop introduces — scripts resolving from the
# Install root while their target repo is elsewhere — is actually exercised.
# Unit tests run from the checkout alone never touch it: every script's own
# `import.meta.dirname`-relative require just resolves inside the checkout,
# which is indistinguishable from resolving inside an install. This job
# installs the plugin for REAL on both harnesses and runs the suite FROM the
# installed copy's `scripts/` directory, so `node --test` itself is loading
# modules from a directory that is NOT the checkout.
#
# DESIGN DECISION (the ticket asks this be stated, not just made): HOME is
# deliberately pointed at a scratch directory INSIDE this checkout for the
# install step, so the installed plugin cache ends up NESTED inside this
# repo's own `.git` — an ambient git working tree that is real, but does not
# TRACK the installed copy's files (a generated cache directory is never
# committed). That is precisely the shape #1339 fixed: `repo-root.mjs`'s
# `repoRoot()` walk, invoked from deep inside the installed copy, finds this
# checkout's `.git` and must refuse it (THROW, naming the untracked path)
# rather than silently answering about the wrong repository. This is
# deliberate, not incidental: a vanilla CI runner's real $HOME is NOT nested
# under the checkout by default, so a plain `node --test` run from an
# ordinary install would just find NO ambient repository at all and SKIP
# those tests cleanly — never exercising #1339's actual fix. Nesting HOME
# reproduces the exact wrong-root shape on every run, in every environment,
# rather than leaving it to incidental runner layout.
#
# CHOICE STATED: "run the suite from the installed copy with the sweep
# suites that need the repo skipped explicitly" — not "run from the checkout
# with FLEET_INSTALL_ROOT pointed at the install". The second option does
# not exist in this codebase: `fleet-run` (the Resolver) reads the harness's
# OWN registry for the Install root and has no environment-variable
# override to redirect that lookup (only `FLEET_HARNESS`, which picks
# BETWEEN Claude/omp registries, never overrides the resolved path itself).
# Inventing that plumbing is a new capability this ticket did not ask for;
# the first option needs no new code, only an explicit exclusion list here.
#
# THE EXCLUSION, why it is safe: six test files call `repoRoot(DIR)` at
# MODULE SCOPE (`repo-root.mjs`, `install-root-audit.test.mjs`,
# `muted-git-guard-sweep.test.mjs`, `unattended-git-sweep.test.mjs`,
# `worktree-listing-sweep.test.mjs`, `git-status-untracked-mode-sweep.test.mjs`).
# Post-#1339, that call THROWS in exactly the nested-HOME shape this script
# builds — which fails the ENTIRE file's module evaluation, not just the
# git-dependent test inside it (`{skip: SKIP_WITHOUT_REPO}` only protects a
# test whose module already loaded). That is the correct, LOUD behaviour
# #1339 fixed toward — a real defect if it happened silently — but it means
# these six files cannot usefully run against an install whose ambient git
# is a stand-in foreign repository; their own coverage of `repoRoot`'s
# identity contract runs in the ordinary `check` job, against the real
# checkout, where they load and pass normally. Excluding them here is
# stated, not silent, and this script's own demonstration (see the PR
# description this job's ticket produced) shows the pre-#1339 code
# FALSELY PASSING the identical fixture shape, so the exclusion is not
# papering over a hole this job would otherwise have caught by accident.
set -euo pipefail

BUN_PIN="1.4.0"
OMP_PIN="18.1.15"
CLAUDE_PIN="2.1.265"

ACTUAL_BUN="$(bun --version)"
ACTUAL_OMP="$(omp --version | sed 's#^omp/##')"
ACTUAL_CLAUDE="$(claude --version | awk '{print $1}')"
for pair in "bun:$BUN_PIN:$ACTUAL_BUN" "omp:$OMP_PIN:$ACTUAL_OMP" "claude:$CLAUDE_PIN:$ACTUAL_CLAUDE"; do
  IFS=':' read -r name want got <<<"$pair"
  if [ "$want" != "$got" ]; then
    echo "::error::install-and-test: $name pinned to $want, found $got on PATH"
    exit 1
  fi
done

EXCLUDED_FILES=(
  "repo-root.test.mjs"
  "install-root-audit.test.mjs"
  "muted-git-guard-sweep.test.mjs"
  "unattended-git-sweep.test.mjs"
  "worktree-listing-sweep.test.mjs"
  "git-status-untracked-mode-sweep.test.mjs"
)

REPO_ROOT="$(pwd)"
REF="${INSTALL_AND_TEST_REF:-$(git rev-parse --abbrev-ref HEAD)}"
SCRATCH_HOME="$REPO_ROOT/.install-and-test-home"
MKT_DIR="$(mktemp -d)"
RUN_ID="install-and-test-$$-$(date +%s)"
MKT_NAME="fleet-plugin-$RUN_ID"

rm -rf "$SCRATCH_HOME"
mkdir -p "$SCRATCH_HOME"

cleanup() {
  HOME="$SCRATCH_HOME" omp plugin uninstall "fleet-ctl@$MKT_NAME" --scope=user >/dev/null 2>&1 || true
  HOME="$SCRATCH_HOME" omp plugin marketplace remove "$MKT_NAME" >/dev/null 2>&1 || true
  HOME="$SCRATCH_HOME" claude plugin uninstall "fleet-ctl@$MKT_NAME" >/dev/null 2>&1 || true
  HOME="$SCRATCH_HOME" claude plugin marketplace remove "$MKT_NAME" >/dev/null 2>&1 || true
  rm -rf "$MKT_DIR" "$SCRATCH_HOME"
}
trap cleanup EXIT

mkdir -p "$MKT_DIR/.claude-plugin"
cat > "$MKT_DIR/.claude-plugin/marketplace.json" <<EOF
{
  "\$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "$MKT_NAME",
  "description": "install-and-test throwaway catalog (#1347)",
  "owner": { "name": "ci" },
  "plugins": [
    {
      "name": "fleet-ctl",
      "source": {
        "source": "git-subdir",
        "url": "file://$REPO_ROOT",
        "path": "plugin",
        "ref": "$REF"
      },
      "description": "install-and-test throwaway install",
      "category": "productivity"
    }
  ]
}
EOF

fail=0

run_suite_from() {
  local harness="$1" install_path="$2"
  echo "== $harness: node --test from $install_path/scripts =="
  if [ ! -d "$install_path/scripts" ]; then
    echo "::error::install-and-test: $harness: no scripts/ under $install_path"
    fail=1
    return
  fi
  local files=()
  for f in "$install_path"/scripts/*.test.mjs; do
    local base
    base="$(basename "$f")"
    local skip=0
    for ex in "${EXCLUDED_FILES[@]}"; do
      [ "$base" = "$ex" ] && skip=1 && break
    done
    [ "$skip" -eq 0 ] && files+=("$f")
  done
  if [ "${#files[@]}" -eq 0 ]; then
    echo "::error::install-and-test: $harness: no test files matched after exclusion — this run would verify nothing"
    fail=1
    return
  fi
  echo "install-and-test: $harness: running ${#files[@]} test file(s), ${#EXCLUDED_FILES[@]} excluded (ambient-repo identity sweeps — see this script's header)"
  if ! (cd "$install_path/scripts" && node --test "${files[@]}"); then
    echo "::error::install-and-test: $harness: node --test reported failures"
    fail=1
  fi
}

# ---- omp ----
HOME="$SCRATCH_HOME" omp config set enabledProviders '["claude-plugins"]' >/dev/null
HOME="$SCRATCH_HOME" omp plugin marketplace add "$MKT_DIR" --scope=user >/dev/null
HOME="$SCRATCH_HOME" omp plugin install "fleet-ctl@$MKT_NAME" --scope=user --force >/dev/null
OMP_INSTALL_PATH="$(HOME="$SCRATCH_HOME" omp plugin list --json \
  | jq -r --arg id "fleet-ctl@$MKT_NAME" '.marketplace[] | select(.id==$id) | .entries[0].installPath')"
if [ -z "$OMP_INSTALL_PATH" ] || [ "$OMP_INSTALL_PATH" = "null" ]; then
  echo "::error::install-and-test: omp: fleet-ctl@$MKT_NAME has no installPath"
  fail=1
else
  run_suite_from "omp" "$OMP_INSTALL_PATH"
fi

# ---- claude ----
HOME="$SCRATCH_HOME" claude plugin marketplace add "$MKT_DIR" >/dev/null
HOME="$SCRATCH_HOME" claude plugin install "fleet-ctl@$MKT_NAME" >/dev/null
CLAUDE_INSTALL_PATH="$(HOME="$SCRATCH_HOME" jq -r --arg id "fleet-ctl@$MKT_NAME" \
  '.plugins[$id][0].installPath // empty' "$SCRATCH_HOME/.claude/plugins/installed_plugins.json")"
if [ -z "$CLAUDE_INSTALL_PATH" ]; then
  echo "::error::install-and-test: claude: fleet-ctl@$MKT_NAME has no installPath"
  fail=1
else
  run_suite_from "claude" "$CLAUDE_INSTALL_PATH"
fi

if [ "$fail" -ne 0 ]; then
  echo "::error::install-and-test: one or both harnesses failed — see above"
  exit 1
fi

echo "install-and-test: both harnesses' installed copies ran the suite (minus the 6 ambient-repo identity sweeps) clean"
