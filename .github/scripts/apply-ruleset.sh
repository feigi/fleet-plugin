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
# live gate still what we agreed?", which is a question that recurs. `--check`
# is that question asked by something that cannot answer the follow-up: it
# compares and reports, never writes, and is what an unattended caller runs
# when it is about to depend on the gate but holds no mandate to change it
# (#1710).
set -euo pipefail

NAME=apply-ruleset
die() { printf '%s: %s\n' "$NAME" "$1" >&2; exit 2; }

# `--check` reports and writes nothing. Three exit statuses, and the third is
# the reason the flag exists rather than a `diff` an operator assembles by
# hand: 0 the live gate matches the spec, 3 it does not — including the gate
# having been deleted or renamed since the spec was written — 2 the question
# could not be answered at all: no spec, no `gh`, a listing or read that
# failed outright.
# GitHub lets any caller with read access GET a ruleset (200), but silently
# omits `bypass_actors` from the body unless the caller holds repository
# admin. That omission is a missing credential, not drift, so it is caught
# before the comparison and reported as 2 — never compared as `null` against
# the spec's `[]`, which would misreport a permissions gap as drift.
CHECK=
SPEC=
end_opts=
for arg in "$@"; do
  if [ -n "$end_opts" ]; then
    [ -z "$SPEC" ] || die "more than one spec path given: $SPEC and $arg"; SPEC=$arg
    continue
  fi
  case $arg in
    --) end_opts=1 ;;
    --check) CHECK=1 ;;
    -*) die "unknown option $arg — the only option is --check" ;;
    *) [ -z "$SPEC" ] || die "more than one spec path given: $SPEC and $arg"; SPEC=$arg ;;
  esac
done
SPEC=${SPEC:-.github/rulesets/main.json}
[ -f "$SPEC" ] || die "no ruleset spec at $SPEC"
command -v gh >/dev/null 2>&1 || die "gh is not on PATH"
command -v jq >/dev/null 2>&1 || die "jq is not on PATH"

RULESET_NAME=$(jq -r '.name // empty' "$SPEC") \
  || die "$SPEC is not valid JSON — see error above"
[ -n "$RULESET_NAME" ] || die "$SPEC has no .name — cannot resolve the ruleset to write"

REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner) \
  || die "gh repo view failed — see error above"

# Resolved by NAME, never a hard-coded id: a ruleset deleted and recreated keeps
# its name and gets a fresh id, and a hard-coded id would then write nothing
# while reporting success. Three things the listing makes easy to get wrong:
# it is paged (30 per page, so a repo past that would report the ruleset
# missing rather than listing it); it carries the org/enterprise rulesets this
# repo inherits alongside its own, which share the name space and cannot be
# written through this endpoint — hence `source_type == "Repository"`; and the
# name reaches jq as data (`--arg`), never spliced into the filter text, so a
# quote in it cannot turn a lookup into a syntax error reported as a gh failure.
RULESETS=$(gh api --paginate "repos/$REPO/rulesets") \
  || die "cannot list rulesets for $REPO — see error above"
ID=$(printf '%s' "$RULESETS" | jq -r --arg n "$RULESET_NAME" \
  '.[] | select(.name == $n and .source_type == "Repository") | .id') \
  || die "could not read the ruleset listing for $REPO — see error above"
if [ -z "$ID" ]; then
  if [ -n "$CHECK" ]; then
    printf '%s: %s has no repository-level ruleset named %s — the gate is gone:\n' "$NAME" "$REPO" "$RULESET_NAME" >&2
    printf '%s: drift — re-run without --check, as a repository admin, to reconcile\n' "$NAME" >&2
    exit 3
  fi
  die "$REPO has no repository-level ruleset named '$RULESET_NAME'"
fi
# Command substitution strips the trailing newline, so N ids carry N-1 of them.
case $ID in
  *$'\n'*) die "$REPO has more than one ruleset named '$RULESET_NAME' — resolve by hand" ;;
esac

# The comparable projection. BOTH sides go through it, so key order, the order
# the server happens to return `rules` in, and the server-only fields (id,
# timestamps, _links, source, ruleset_source) cannot produce a false mismatch —
# nor mask a real one, since every writable field is kept and each rule still
# has to match its counterpart of the same type. `sort_by` only where `.rules`
# is an array: a spec missing the key stays distinguishable from one with none.
norm() {
  jq -S '{name, target, enforcement, bypass_actors, conditions,
          rules: (.rules | if type == "array" then sort_by(.type) else . end)}' "$@"
}

# `diff` exits 0 (identical, unreached here — callers only reach this after a
# mismatch) or 1 (differ) in the ordinary case; anything higher is `diff`
# itself failing (a process-substitution pipe error, an out-of-descriptors
# runner), which `|| true` would otherwise make indistinguishable from an
# ordinary reported difference.
show_diff() {
  if diff <(printf '%s\n' "$1") <(printf '%s\n' "$2") >&2; then
    rc=0
  else
    rc=$?
  fi
  [ "$rc" -le 1 ] || die "diff itself failed comparing $SPEC's projection to the live ruleset (exit $rc) — see error above"
}

want=$(norm "$SPEC") || die "$SPEC is not a ruleset this script can compare — see error above"
live=$(gh api "repos/$REPO/rulesets/$ID") \
  || die "cannot read $REPO ruleset $ID — see error above"
if [ -n "$CHECK" ] && ! printf '%s' "$live" | jq -e 'has("bypass_actors")' >/dev/null; then
  die "cannot see bypass_actors on $REPO ruleset $ID without repository admin — re-run as an admin to check for real drift"
fi
live=$(printf '%s' "$live" | norm) \
  || die "$REPO ruleset $ID did not read back as JSON — see error above"

if [ "$want" = "$live" ]; then
  printf '%s: %s ruleset %s already matches %s — nothing to apply\n' "$NAME" "$REPO" "$ID" "$SPEC"
  exit 0
fi

if [ -n "$CHECK" ]; then
  # Drift is a normal steady state between reconciliations, not a corruption:
  # a merged change to the spec IS the gate diverging until someone with admin
  # runs this script without --check. So the diff goes out in full — a caller
  # that only learns "they differ" has to re-derive the one thing it needs,
  # which is whether the live gate is weaker than the agreed one or merely
  # older.
  printf '%s: %s ruleset %s does NOT match %s:\n' "$NAME" "$REPO" "$ID" "$SPEC" >&2
  show_diff "$want" "$live"
  printf '%s: drift — re-run without --check, as a repository admin, to reconcile\n' "$NAME" >&2
  exit 3
fi

printf '%s: applying %s to %s ruleset %s\n' "$NAME" "$SPEC" "$REPO" "$ID" >&2
gh api -X PUT "repos/$REPO/rulesets/$ID" --input "$SPEC" >/dev/null \
  || die "PUT failed — see error above"

# The whole point of the script. A PUT that returns 200 having silently dropped
# a field is indistinguishable from success until someone merges through the gap.
after=$(gh api "repos/$REPO/rulesets/$ID") \
  || die "the PUT was accepted but $REPO ruleset $ID could not be re-read — the live gate is UNVERIFIED"
after=$(printf '%s' "$after" | norm) \
  || die "the PUT was accepted but $REPO ruleset $ID did not read back as JSON — the live gate is UNVERIFIED"
if [ "$after" != "$want" ]; then
  printf '%s: the live ruleset still differs from %s after the write:\n' "$NAME" "$SPEC" >&2
  show_diff "$want" "$after"
  die "refusing to report success"
fi

printf '%s: applied and verified — %s ruleset %s matches %s\n' "$NAME" "$REPO" "$ID" "$SPEC"
