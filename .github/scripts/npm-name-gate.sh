#!/usr/bin/env bash
# The `npm-name-gate` job body (#1347's second comment). Reads the plugin
# `name` from `plugin/.claude-plugin/plugin.json` and fails if
# `https://registry.npmjs.org/<name>` returns anything but 404.
#
# Why this exists, verbatim from the ticket: #1319's ruling rejected a
# registry gate as a false-negative trap, then the rename was bitten by
# exactly the case it guards against — `fleetctl` was picked unverified and
# turned out to be a real npm package; `omp plugin install fleetctl`
# installed IT with rc=0, not this repo's plugin. The gate is cheap and the
# name is now `fleet-ctl` (measured 404 at authoring time).
#
# THE FALSE-NEGATIVE CAVEAT, stated where every reader of this job's output
# sees it: a 404 today proves nothing about tomorrow. A name free right now
# can be taken by someone else on npm at any later date — this gate would
# stay green regardless, because it only re-checks on the commit that
# changes `name`, and even a scheduled re-run only catches the case where WE
# pick a name someone else already holds, never the case where our EXISTING
# name gets squatted after the fact. That is the exact scope #1319 accepted:
# this catches "we picked a taken name", nothing broader, and is not a
# defence against squatting.
set -euo pipefail

MANIFEST="plugin/.claude-plugin/plugin.json"
if [ ! -f "$MANIFEST" ]; then
  echo "::error::npm-name-gate: $MANIFEST not found"
  exit 2
fi

NAME="$(jq -r '.name // empty' "$MANIFEST")"
if [ -z "$NAME" ]; then
  echo "::error::npm-name-gate: $MANIFEST has no \"name\" field"
  exit 2
fi

STATUS="$(curl -s -o /dev/null -w '%{http_code}' "https://registry.npmjs.org/$NAME")"

echo "npm-name-gate: https://registry.npmjs.org/$NAME -> $STATUS"
echo "CAVEAT: a 404 today is not a guarantee for tomorrow — this gate catches the case where WE pick a name npm already holds; it cannot catch that name being taken by someone else AFTER this check passes. Re-verify at rename time, not just once."

if [ "$STATUS" != "404" ]; then
  echo "::error::npm-name-gate: \"$NAME\" is not free on npm (registry.npmjs.org returned $STATUS, want 404) — this plugin name collides with a real npm package, the exact #1319/fleetctl case this gate exists to catch"
  exit 1
fi

echo "npm-name-gate: \"$NAME\" is free on npm (404) — no collision"
