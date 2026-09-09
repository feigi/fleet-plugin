#!/usr/bin/env bash
# The `smoke-omp` job body (#1314, #1347), extracted so it is runnable and
# testable OUTSIDE GitHub Actions — CI's job calls this verbatim after
# installing the pinned `bun`/`omp`; local verification runs it directly
# against whatever `omp` is already on PATH (it is self-cleaning: every
# mutation it makes to config/registries is captured and restored on exit,
# so a local run never leaves the caller's real omp state altered).
#
# Registers THIS checkout as a throwaway `file://` git-subdir catalog (never
# the tracked `fleet-plugin` marketplace, and never a directory source —
# ADR 0003: a directory install re-admits every untracked/gitignored file,
# a git source checks out committed content only, the way the operator's own
# install does), installs `fleet-ctl` from it, and asserts what #1293 says
# "loaded" can actually mean, per artefact kind:
#
#   - commands: the `--no-tools` substitution test. `omp -p
#     "/fleet-ctl:<command>" --no-tools --mode json --no-session` records the
#     COMMAND BODY substituted into the first user turn; asserting that text
#     differs from the literal command name needs no successful model
#     response at all (`omp plugin features`/`doctor` cannot see a
#     marketplace-sourced plugin's commands — measured "not found" — so this
#     is the only headless signal #1293 found). A PRESENT-but-fake API key is
#     enough to get past omp's own "No models available" precheck; the
#     eventual provider call then fails on auth (measured: a real 401), well
#     AFTER the substitution this assertion reads is already recorded. No
#     real credential and no real model call is ever required or attempted
#     against a configured provider.
#   - agents & skills: PRESENCE in the installed cache directory, never a
#     dispatch. #1293's own finding: skills enumeration is a model
#     self-report (measured unreliable both directions) and `/skill:`
#     explicit invocation does not resolve in `-p` mode — so `smoke-omp`
#     asserts skills by presence and says so, explicitly, per the ticket.
#     Agents are the SAME shape here for a stronger reason: a real dispatch
#     needing `resolvedModelIdentity` off a live job record requires an
#     actual successful model call, and this job must never reach for one
#     against a non-configured provider — CI carries no API key at all. So
#     agents are ALSO asserted by presence only. This is the ticket's own
#     permitted fallback ("if a model call is unavoidable, assert presence
#     only and say so") — measured by hand, once, outside this job (see the
#     PR description), never re-verified here: with a REAL credential and
#     `enabledProviders` cleared, `task(agent: "fleet-implementer")` failed
#     preflight with `Unknown agent "fleet-implementer"`; with it restored to
#     `["claude-plugins"]`, the identical dispatch succeeded. That red/green
#     pair is what justifies baking `enabledProviders` into this job's config
#     unconditionally below, rather than re-proving it on every run.
#
# `enabledProviders: ["claude-plugins"]` (ADR 0003) is set via `omp config
# set`, not a `--config` overlay file — measured: an overlay setting the SAME
# key over an already-set global value did not take effect, while `config
# set` (which mutates the persisted config) did. Every mutation this script
# makes (config, marketplace registration, plugin install) is captured before
# it runs and restored in a trap, so a local run is non-destructive.
set -euo pipefail

PIN="18.1.15"
ACTUAL="$(omp --version | sed 's#^omp/##')"
if [ "$ACTUAL" != "$PIN" ]; then
  echo "::error::smoke-omp: pinned to $PIN, found $ACTUAL on PATH — the installer step is out of sync with this script's pin"
  exit 1
fi

# Derived, never hardcoded (#1314's own ruling, PR #1365 review finding #3):
# a rename would stale a literal, and the bare name resolves to a different
# package entirely (the fleetctl/#1319 collision, from the other direction).
PLUGIN_NAME="$(jq -r '.name' plugin/.claude-plugin/plugin.json)"
if [ -z "$PLUGIN_NAME" ] || [ "$PLUGIN_NAME" = "null" ]; then
  echo "::error::smoke-omp: could not read plugin name from plugin/.claude-plugin/plugin.json"
  exit 2
fi
RUN_ID="smoke-omp-$$-$(date +%s)"
MKT_NAME="fleet-plugin-$RUN_ID"
MKT_DIR="$(mktemp -d)"
PROBE_DIR="$(mktemp -d)"
# `ref` is a BRANCH NAME, not a SHA -- `git clone --branch` (what the
# git-subdir source type does under the hood) only resolves refs, never an
# arbitrary commit. CI sets SMOKE_OMP_REF to the PR head branch
# (github.head_ref); local runs default to the current checkout's own
# branch, which must be a real ref reachable from this repo's object
# database (true for a worktree branch even before it is pushed anywhere).
REF="${SMOKE_OMP_REF:-$(git rev-parse --abbrev-ref HEAD)}"
REPO_URL="file://$(pwd)"

# ---- capture prior state, for the exit trap ----
PRIOR_ENABLED_PROVIDERS="$(omp config get enabledProviders 2>/dev/null || echo '[]')"
cleanup() {
  omp plugin uninstall "$PLUGIN_NAME@$MKT_NAME" --scope=user >/dev/null 2>&1 || true
  omp plugin marketplace remove "$MKT_NAME" >/dev/null 2>&1 || true
  omp config set enabledProviders "$PRIOR_ENABLED_PROVIDERS" >/dev/null 2>&1 || true
  rm -rf "$MKT_DIR" "$PROBE_DIR"
}
trap cleanup EXIT

mkdir -p "$MKT_DIR/.claude-plugin"
cat > "$MKT_DIR/.claude-plugin/marketplace.json" <<EOF
{
  "\$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "$MKT_NAME",
  "description": "smoke-omp throwaway catalog (#1347) — never the tracked fleet-plugin marketplace",
  "owner": { "name": "ci" },
  "plugins": [
    {
      "name": "$PLUGIN_NAME",
      "source": {
        "source": "git-subdir",
        "url": "$REPO_URL",
        "path": "plugin",
        "ref": "$REF"
      },
      "description": "smoke-omp throwaway install",
      "category": "productivity"
    }
  ]
}
EOF

omp config set enabledProviders '["claude-plugins"]' >/dev/null
omp plugin marketplace add "$MKT_DIR" --scope=user >/dev/null
omp plugin install "$PLUGIN_NAME@$MKT_NAME" --scope=user --force >/dev/null

fail=0

# Bounded on the EVENT it actually wants, not a fixed-window race against a
# live provider turn. Review finding (PR #1365): the original design
# (`run_with_timeout 20 omp ...`, parsed only after the whole run finished
# or was killed) was measured to hit its own 20s SIGTERM on every run,
# because a present-but-fake API key is enough for omp to actually START a
# real provider turn (`turn_start` -> assistant `message_start` with
# `"api":"anthropic-messages"`) before it 401s — so the assertion depended
# on the USER-turn `message_start` line being fully flushed at the exact
# kill instant, a coin-flip on runner speed for a blocking job. This reads
# the JSON stream LINE BY LINE through a real pipe (so `omp`'s own PID is
# held, not a process-substitution subshell's) and kills `omp` the INSTANT
# the first user `message_start` line parses — typically well under a
# second — with a generous 15s safety bound only for the case that line
# never appears at all (a harness output-shape change, not the ordinary
# path). An outbound request to the configured provider IS attempted here
# and does 401 on the fake key; this script never waits for or reads that
# response.
PROBE_FIFO="$(mktemp -u)"
mkfifo "$PROBE_FIFO"
(
  cd "$PROBE_DIR" \
    && ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-sk-ant-omp-smoke-dummy-not-real}" \
       omp -p "/$PLUGIN_NAME:run-merge-bot" --no-tools --mode json --no-session > "$PROBE_FIFO" 2>&1
) &
OMP_PID=$!
SUBSTITUTED=""
DEADLINE=$(( $(date +%s) + 15 ))
while IFS= read -r line; do
  TYPE="$(printf '%s' "$line" | jq -r '.type // empty' 2>/dev/null || true)"
  ROLE="$(printf '%s' "$line" | jq -r '.message.role // empty' 2>/dev/null || true)"
  if [ "$TYPE" = "message_start" ] && [ "$ROLE" = "user" ]; then
    SUBSTITUTED="$(printf '%s' "$line" | jq -r '.message.content[0].text // empty' 2>/dev/null || true)"
    break
  fi
  [ "$(date +%s)" -ge "$DEADLINE" ] && break
done < "$PROBE_FIFO"
kill "$OMP_PID" 2>/dev/null || true
wait "$OMP_PID" 2>/dev/null || true
rm -f "$PROBE_FIFO"

if [ -z "$SUBSTITUTED" ] || [ "$SUBSTITUTED" = "/$PLUGIN_NAME:run-merge-bot" ]; then
  echo "::error::smoke-omp: commands: /$PLUGIN_NAME:run-merge-bot did not substitute its body into the first user turn"
  fail=1
else
  echo "smoke-omp: commands OK — /$PLUGIN_NAME:run-merge-bot substituted $(printf '%s' "$SUBSTITUTED" | wc -c | tr -d ' ') bytes into the first user turn"
fi

# ---- agents & skills: presence in the installed copy ----
INSTALL_PATH="$(omp plugin list --json | jq -r --arg id "$PLUGIN_NAME@$MKT_NAME" '.marketplace[] | select(.id==$id) | .entries[0].installPath')"
if [ -z "$INSTALL_PATH" ] || [ "$INSTALL_PATH" = "null" ] || [ ! -d "$INSTALL_PATH" ]; then
  echo "::error::smoke-omp: $PLUGIN_NAME@$MKT_NAME has no installPath in omp plugin list, or it does not exist on disk"
  fail=1
else
  AGENT_COUNT=0
  for f in "$INSTALL_PATH"/agents/*.md; do
    [ -f "$f" ] && AGENT_COUNT=$((AGENT_COUNT + 1))
  done
  if [ "$AGENT_COUNT" -eq 0 ]; then
    echo "::error::smoke-omp: agents: no *.md files present under $INSTALL_PATH/agents (presence-only check — see this script's header)"
    fail=1
  else
    echo "smoke-omp: agents OK (presence only, no dispatch) — $AGENT_COUNT agent file(s) present under $INSTALL_PATH/agents"
  fi

  SKILL_COUNT=0
  for f in "$INSTALL_PATH"/skills/*/SKILL.md; do
    [ -f "$f" ] && SKILL_COUNT=$((SKILL_COUNT + 1))
  done
  if [ "$SKILL_COUNT" -eq 0 ]; then
    echo "::error::smoke-omp: skills: no SKILL.md files present under $INSTALL_PATH/skills (presence-only check, per #1293)"
    fail=1
  else
    echo "smoke-omp: skills OK (presence only, per #1293) — $SKILL_COUNT SKILL.md file(s) present under $INSTALL_PATH/skills"
  fi
fi

if [ "$fail" -ne 0 ]; then
  echo "::error::smoke-omp: one or more assertions failed — see above"
  exit 1
fi

echo "smoke-omp: commands substituted, agents present, skills present — all against the throwaway dev catalog install"
