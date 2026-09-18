#!/usr/bin/env bash
# Applies `.github/rulesets/main.json` to this repo's default-branch ruleset,
# then re-reads it and refuses unless the live object matches what was asked
# for.
#
# Why a file and an applier rather than the settings UI (ADR 0007): the ruleset
# is the only part of this repo's merge gate that lives OUTSIDE the tree, so a
# change to it leaves no diff, no reviewer, and no history a reader can consult.
# Twice while #164 was being settled a UI edit was believed saved and had not
# been — the giveaway both times was the ruleset's `updated_at` not moving, which
# nobody would think to check. The spec file makes the intended state
# reviewable; the readback below makes the applied state provable.
#
# Idempotent on purpose: re-running it is the cheapest way to answer "is the
# live gate still what we agreed?", which is a question that recurs.
set -euo pipefail

NAME=apply-ruleset
die() { printf '%s: %s\n' "$NAME" "$1" >&2; exit 2; }

SPEC=${1:-.github/rulesets/main.json}
[ -f "$SPEC" ] || die "no ruleset spec at $SPEC"
command -v gh >/dev/null 2>&1 || die "gh is not on PATH"
command -v jq >/dev/null 2>&1 || die "jq is not on PATH"

RULESET_NAME=$(jq -r '.name // empty' "$SPEC")
[ -n "$RULESET_NAME" ] || die "$SPEC has no .name — cannot resolve the ruleset to write"

REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner) \
  || die "cannot resolve the current repository — run this inside the checkout"

# Resolved by NAME, never a hard-coded id: a ruleset deleted and recreated keeps
# its name and gets a fresh id, and a hard-coded id would then write nothing
# while reporting success.
ID=$(gh api "repos/$REPO/rulesets" --jq ".[] | select(.name == \"$RULESET_NAME\") | .id") \
  || die "cannot list rulesets for $REPO — this needs repo-admin scope"
[ -n "$ID" ] || die "$REPO has no ruleset named '$RULESET_NAME'"
case $(printf '%s\n' "$ID" | wc -l | tr -d ' ') in
  1) ;;
  *) die "$REPO has more than one ruleset named '$RULESET_NAME' — resolve by hand" ;;
esac

# The comparable projection. BOTH sides go through it, so key order and the
# server-only fields (id, timestamps, _links, source, ruleset_source) cannot
# produce a false mismatch — nor mask a real one, since every writable field is
# kept.
norm() { jq -S '{name, target, enforcement, bypass_actors, conditions, rules}' "$@"; }

want=$(norm "$SPEC")
live=$(gh api "repos/$REPO/rulesets/$ID" | norm)

if [ "$want" = "$live" ]; then
  printf '%s: %s ruleset %s already matches %s — nothing to apply\n' "$NAME" "$REPO" "$ID" "$SPEC"
  exit 0
fi

printf '%s: applying %s to %s ruleset %s\n' "$NAME" "$SPEC" "$REPO" "$ID" >&2
gh api -X PUT "repos/$REPO/rulesets/$ID" --input "$SPEC" >/dev/null \
  || die "PUT failed — this needs repo-admin scope"

# The whole point of the script. A PUT that returns 200 having silently dropped
# a field is indistinguishable from success until someone merges through the gap.
after=$(gh api "repos/$REPO/rulesets/$ID" | norm)
if [ "$after" != "$want" ]; then
  printf '%s: the live ruleset still differs from %s after the write:\n' "$NAME" "$SPEC" >&2
  diff <(printf '%s\n' "$want") <(printf '%s\n' "$after") >&2 || true
  die "refusing to report success"
fi

printf '%s: applied and verified — %s ruleset %s matches %s\n' "$NAME" "$REPO" "$ID" "$SPEC"
