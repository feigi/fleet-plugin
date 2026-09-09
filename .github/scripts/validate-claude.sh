#!/usr/bin/env bash
# The `validate-claude` job body (#1314, #1347), extracted to its own script
# so it is runnable and testable OUTSIDE GitHub Actions — CI's job calls this
# verbatim after installing the pinned `claude` binary; local verification
# runs it directly against whatever `claude` is already on PATH.
#
# `claude plugin validate --strict` cannot be used here — routed from
# #1347's third comment: #1336 dropped `plugin/.claude-plugin/plugin.json`'s
# `version` field per ADR 0003 (a version marker would reintroduce the
# update no-op trap `claude plugin update` compares strings on), and every
# measured Claude Code build warns on its absence. So this script runs
# `--json` (never `--strict`), fails on any manifest/content ERROR
# unconditionally, and fails on any WARNING whose message text is not
# EXACTLY the one string allow-listed in validate-claude-warning-allowlist.json
# — never a broader "warnings are fine" policy, which would silently admit a
# genuinely new warning class the day one appears. `frontmatter-check.mjs`
# (#1314's own allow-list checker) is what polices unrecognised frontmatter
# keys; this job's job is manifest/component-shape validation only, per
# #1314's own division of labour.
#
# One root invocation of `claude plugin validate` reaches only marketplace
# mode (#1314's own measurement), so the five targets below are enumerated
# EXPLICITLY rather than inferred from one call — and each is checked
# PRESENT via check-tracked.sh's own non-vacuity refusal before validate
# ever runs on it, so a target quietly deleted from disk (a renamed
# directory, a manifest moved without updating this list) fails the build
# loudly instead of validate silently reporting "no errors" about nothing.
set -euo pipefail
# Invoked from the repo root, exactly like check-tracked.sh itself (CI's
# `run:` steps default their working directory to the checkout root, and
# this script calls check-tracked.sh by that same repo-relative path) — no
# self-location: `.github/scripts/` ships outside the plugin payload and is
# never resolved through the Resolver, so this has none of
# install-root-audit.test.mjs's reasons to avoid `dirname "$0"` that
# plugin/scripts/ itself does, but there is simply no need for it here either.
#
# Pin lives HERE, not only in the CI installer step, so a mismatched
# `claude` on PATH (a stale local install, or a CI installer step that
# silently floated) is a loud refusal rather than a validate run against an
# unpinned binary whose warning wording this script has not verified.
PIN="2.1.265"
ALLOWLIST_FILE=".github/scripts/validate-claude-warning-allowlist.json"

if ! command -v claude >/dev/null 2>&1; then
  echo "::error::validate-claude: no 'claude' on PATH — install @anthropic-ai/claude-code@$PIN first"
  exit 2
fi

ACTUAL="$(claude --version | awk '{print $1}')"
if [ "$ACTUAL" != "$PIN" ]; then
  echo "::error::validate-claude: pinned to $PIN, found $ACTUAL on PATH — the installer step is out of sync with this script's pin"
  exit 1
fi

if [ ! -f "$ALLOWLIST_FILE" ]; then
  echo "::error::validate-claude: $ALLOWLIST_FILE missing — cannot run"
  exit 2
fi
ALLOWED_MESSAGE="$(jq -r '.missingVersionWarning' "$ALLOWLIST_FILE")"
if [ -z "$ALLOWED_MESSAGE" ] || [ "$ALLOWED_MESSAGE" = "null" ]; then
  echo "::error::validate-claude: $ALLOWLIST_FILE has no missingVersionWarning string — cannot run"
  exit 2
fi

fail=0

# label|tracked-glob (check-tracked.sh's presence proof)|validate target
targets=(
  "root marketplace manifest|.claude-plugin/marketplace.json|."
  "plugin manifest|plugin/.claude-plugin/plugin.json|plugin/"
  "agents (component mode)|plugin/agents/*|plugin/agents/"
  "skills (component mode)|plugin/skills/*/SKILL.md|plugin/skills/"
  "commands (component mode)|plugin/commands/*|plugin/commands/"
)

for row in "${targets[@]}"; do
  IFS='|' read -r label glob target <<<"$row"
  echo "== $label =="

  # `true` is a no-op checker — the presence proof IS check-tracked.sh's own
  # refusal on an empty match, never anything this loop computes itself.
  if ! .github/scripts/check-tracked.sh "$glob" -n1 true >/dev/null; then
    echo "::error::validate-claude: $label: enumerated target no longer exists on disk ($glob matched no tracked file)"
    fail=1
    continue
  fi

  OUT="$(claude plugin validate --json "$target" 2>&1)" || true
  if ! echo "$OUT" | jq -e . >/dev/null 2>&1; then
    echo "::error::validate-claude: $label: claude plugin validate did not print valid JSON: $OUT"
    fail=1
    continue
  fi

  ERRORS="$(echo "$OUT" | jq -c '[(.manifest.errors // []), ((.contents // [])[].errors // [])] | flatten')"
  if [ "$ERRORS" != "[]" ]; then
    echo "::error::validate-claude: $label: validate reported error(s): $ERRORS"
    fail=1
  fi

  BAD="$(echo "$OUT" | jq --arg allowed "$ALLOWED_MESSAGE" -c \
    '[(.manifest.warnings // [])[], ((.contents // [])[].warnings // [])[]] | map(.message) | map(select(. != $allowed))')"
  if [ "$BAD" != "[]" ]; then
    echo "::error::validate-claude: $label: warning(s) not on the allow-list: $BAD"
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "::error::validate-claude: one or more targets failed — see above"
  exit 1
fi

echo "validate-claude: all 5 enumerated targets clean (no errors; warnings limited to the allow-listed missing-version notice)"
