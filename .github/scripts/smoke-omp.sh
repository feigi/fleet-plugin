#!/usr/bin/env bash
# The `smoke-omp` job body (#1314, #1347, ADR 0021), extracted so it is
# runnable and testable OUTSIDE GitHub Actions — CI's job calls this verbatim
# after installing the pinned `omp`; local verification runs it directly
# against whatever `omp` is already on PATH. Every mutation runs against a
# scratch HOME this script owns and deletes (no `omp config set` against the
# caller's real state at all), so a local run never alters it.
#
# ADR 0021 retired the throwaway `file://` git-subdir catalog this script
# used to build: the plugin now installs the way the native route installs —
# `omp plugin link plugin/` — and the link route is also the route that
# HONORS each agent's declared `model:` tier (the Claude-marketplace route
# discards it upstream, #7967), so this job can finally assert the tier and
# not just presence. What it proves, per artefact kind:
#
#   - commands: the `--no-tools` substitution test, unchanged shape (#1293):
#     `omp -p "/<name>" --no-tools --mode json --no-session` records the
#     COMMAND BODY substituted into the first user turn; asserting that text
#     differs from the literal command name needs no successful model
#     response. On the link route these are BARE names (ADR 0021 decision 3
#     retired the `fleet-ctl:` prefix with the marketplace provider). Native
#     command discovery rides the same omp-plugins provider load as the
#     plugin's skills, agents, and member-write-guard — so a substitution
#     hit also proves that provider loaded: a silent extension-load failure
#     (the ADR 0020 §7 gap `omp plugin doctor` cannot see, measured) fails
#     this check LOUD.
#   - tier: one scripted-provider dispatch (the mock below — no credential,
#     no network) of `fleet-finisher`, whose frontmatter declares
#     `model: "@smol:low"`, and the CHILD session record must show the smol
#     role's target model AND `thinkingLevel: low`. The scratch config maps
#     default to a DIFFERENT target+effort (sonnet/medium), so the #1430
#     failure shape — the alias dropped, the member falling through to the
#     parent's model — cannot pass. `thinkingLevel: high` is omp's bare
#     subagent default (measured), so only a distinct model target makes a
#     drop detectable; that distinction is why the roles below differ.
#   - agents & skills: presence in the linked tree — the same #1293
#     presence-only shape, now beside a dispatch-backed tier assertion.
#
# The tier probe needs a parent turn that SUCCEEDS (a child never spawns
# when the parent's first provider request errors — measured), which CI's
# credential-less box cannot get from a real provider. It comes from a
# scripted local anthropic-messages SSE mock (stdlib python3): turn 1
# answers tool_use(task), turn 2 tool_use(wait), then text. The parent
# prompt carries a canary token the dispatched task text does not, and the
# mock routes on it — without that discriminator the parent's own request
# (which embeds the task text) answers as the child and the task tool never
# fires (measured the failure mode first). The assertion reads only the
# child's on-disk session RECORD: model/thinking rows are flushed at spawn,
# independent of provider success (measured).
set -euo pipefail

PIN="18.4.4"
ACTUAL="$(omp --version | sed 's#^omp/##')"
if [ "$ACTUAL" != "$PIN" ]; then
  echo "::error::smoke-omp: pinned to $PIN, found $ACTUAL on PATH — the installer step is out of sync with this script's pin"
  exit 1
fi

# Derived, never hardcoded (#1314's own ruling, PR #1365 review finding #3):
# the package name on the link route is the node_modules dir and the npm
# package at once — a rename would stale a literal here and in the manifest.
PLUGIN_NAME="$(jq -r '.name' plugin/package.json)"
if [ -z "$PLUGIN_NAME" ] || [ "$PLUGIN_NAME" = "null" ]; then
  echo "::error::smoke-omp: plugin/package.json has no \"name\""
  exit 1
fi

SCRATCH="$(mktemp -d)"
SCRATCH_HOME="$SCRATCH/home"
PROBE_DIR="$SCRATCH/probe"
MOCK_LOG="$SCRATCH/mock.log"
mkdir -p "$SCRATCH_HOME/.omp/agent" "$PROBE_DIR"

# Scratch config: every role DISTINCT in target or effort — see the tier
# note in the header. Written as a file, never `omp config set`: the caller's
# real config is unreachable from here because HOME is scoped per-command.
cat > "$SCRATCH_HOME/.omp/agent/config.yml" <<'YML'
modelRoles:
  smol: anthropic/claude-haiku-4-5:low
  task: anthropic/claude-sonnet-4-5:medium
  slow: anthropic/claude-opus-4-7:high
  default: anthropic/claude-sonnet-4-5:medium
hideThinkingBlock: true
YML

cleanup() {
  [ -n "${MOCK_PID:-}" ] && kill "$MOCK_PID" 2>/dev/null || true
  HOME="$SCRATCH_HOME" omp plugin uninstall "$PLUGIN_NAME" >/dev/null 2>&1 || true
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

fail=0

# ---- install: link the checkout (ADR 0021's dev-route install) ----
if ! HOME="$SCRATCH_HOME" omp plugin link "$PWD/plugin" >/dev/null; then
  echo "::error::smoke-omp: omp plugin link plugin/ failed"
  exit 1
fi
INSTALL_PATH="$(cd "$SCRATCH_HOME/.omp/plugins/node_modules/$PLUGIN_NAME" && pwd -P)"
if [ ! -d "$INSTALL_PATH/scripts" ]; then
  echo "::error::smoke-omp: linked node_modules/$PLUGIN_NAME does not resolve to a plugin tree"
  exit 1
fi

# ---- commands: substitution probe per shipped command (bare names) ----
# The probe reads the `omp -p --no-tools --mode json --no-session` stream
# line by line through a real pipe and takes the first user `message_start`.
# 18.4.4 flushes that line only when the turn COMPLETES — measured against a
# real endpoint with a fake key: the line arrives ~54s in, after retry
# back-off, NOT "well under a second" as the 18.1.15-era note claimed. So
# the turn is ENDED FAST by routing the probe through the scripted local
# mock (below, started before any probe runs): it answers any non-canary
# request with an immediate end_turn. No outbound network is touched
# anywhere in this script. The 60s bound only covers a wedged mock.
#
# Every line the probe reads is also kept in `$SCRATCH/probe-<cmd>.log`, so a
# failure names its own cause — omp exiting (with its status and last output),
# no user turn inside the bound, or a user turn that is still the raw
# `/<cmd>` — instead of one message guessing at command discovery for all three.
probe_substitution() {
  local cmd="$1"
  local fifo="$SCRATCH/fifo-$cmd" log="$SCRATCH/probe-$cmd.log"
  mkfifo "$fifo"
  : >"$log"
  (
    cd "$PROBE_DIR" \
      && ANTHROPIC_API_KEY="sk-ant-omp-smoke-dummy-not-real" \
         ANTHROPIC_BASE_URL="http://127.0.0.1:$MOCK_PORT" \
         HOME="$SCRATCH_HOME" \
         omp -p "/$cmd" --no-tools --mode json --no-session > "$fifo" 2>&1
  ) &
  local pid=$! substituted="" deadline=$(( $(date +%s) + 60 )) line remaining text timed_out=0 read_rc omp_rc
  # The deadline bounds each read itself (`read -t`): a wedged omp that
  # prints nothing never returns a line, so a check placed after `read`
  # alone would never run and only the job timeout would end the probe.
  # A read status above 128 is that timeout; any other failure is EOF.
  while :; do
    remaining=$(( deadline - $(date +%s) ))
    if [ "$remaining" -le 0 ]; then timed_out=1; break; fi
    IFS= read -r -t "$remaining" line || {
      read_rc=$?
      if [ "$read_rc" -gt 128 ]; then timed_out=1; fi
      break
    }
    printf '%s\n' "$line" >>"$log"
    # jq's stderr is dropped because most lines are not JSON at all (omp's
    # own stderr shares the stream); the raw line is already in $log.
    text="$(printf '%s' "$line" | jq -r 'select(.type=="message_start" and .message.role=="user") | .message.content[0].text // empty' 2>/dev/null || true)"
    if [ -n "$text" ]; then substituted="$text"; break; fi
  done < "$fifo"
  if [ -z "$substituted" ] && [ "$timed_out" -eq 0 ]; then
    # EOF with no user turn: omp exited on its own — reap it for its status.
    omp_rc=0
    wait "$pid" 2>/dev/null || omp_rc=$?
  else
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  rm -f "$fifo"
  local tail_out
  tail_out="$(tail -n 5 "$log" | tr '\n' ' ' | cut -c1-600)"
  if [ -n "$substituted" ] && [ "$substituted" != "/$cmd" ]; then
    echo "smoke-omp: /$cmd substituted $(printf '%s' "$substituted" | wc -c | tr -d ' ') bytes into the first user turn"
    return 0
  elif [ -n "$substituted" ]; then
    echo "::error::smoke-omp: commands: /$cmd did not substitute its body — either command discovery or the extension provider that carries it failed to load (measured: --no-extensions keeps /<name> raw)"
  elif [ "$timed_out" -eq 1 ]; then
    echo "::error::smoke-omp: commands: /$cmd probe saw no user message_start within 60s (wedged omp or mock) — last output: ${tail_out:-(none)}"
  else
    echo "::error::smoke-omp: commands: /$cmd probe: omp exited $omp_rc before any user message_start — last output: ${tail_out:-(none)}"
  fi
  return 1
}


# ---- agents & skills: presence in the linked tree ----
AGENT_COUNT=0
for f in "$INSTALL_PATH"/agents/*.agent.md; do
  [ -f "$f" ] && AGENT_COUNT=$((AGENT_COUNT + 1))
done
if [ "$AGENT_COUNT" -eq 0 ]; then
  echo "::error::smoke-omp: agents: no *.agent.md present under $INSTALL_PATH/agents"
  fail=1
else
  echo "smoke-omp: agents OK — $AGENT_COUNT agent file(s) under $INSTALL_PATH/agents"
fi

SKILL_COUNT=0
for f in "$INSTALL_PATH"/skills/*/SKILL.md; do
  [ -f "$f" ] && SKILL_COUNT=$((SKILL_COUNT + 1))
done
if [ "$SKILL_COUNT" -eq 0 ]; then
  echo "::error::smoke-omp: skills: no SKILL.md present under $INSTALL_PATH/skills (presence-only per #1293)"
  fail=1
else
  echo "smoke-omp: skills OK (presence only, per #1293) — $SKILL_COUNT SKILL.md file(s)"
fi

# ---- scripted local mock (shared by the probes and the tier dispatch) ----
# Port picked per-run (ephemeral, python binds and prints it back), not a
# fixed literal: two overlapping runs on one box collided on a hard-coded
# 8934 and the older run's cleanup SIGKILLed the newer mid-probe (measured:
# exit 137 seconds in, no diagnostic).
MOCK_PORT_FILE="$SCRATCH/mock.port"
cat > "$SCRATCH/mock.py" <<'PY'
#!/usr/bin/env python3
# Scripted anthropic-messages endpoint: parent (canary in request) -> turn 1
# tool_use(task fleet-finisher), turn 2 tool_use(wait), then text DONE.
# Child (no canary) -> text OK end_turn. Routes on the canary because the
# parent's request embeds the task text; see the header note in smoke-omp.sh.
import json, os, http.server, socketserver

CANARY = "SMOKE-PARENT-CANARY-9c1f"
TASK_INPUT = {
    "context": "# Goal\nsmoke tier probe",
    "tasks": [{"agent": "fleet-finisher", "task": "Reply with exactly OK and stop.",
               "solutionSpace": "one action: reply OK"}],
}
LOG = open(os.environ["MOCK_LOG"], "a")


def sse(events):
    return "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events).encode()


def envelope(name, inp, mid, model, stop="tool_use"):
    block = ({"type": "tool_use", "id": "toolu_" + mid, "name": name, "input": {}}
             if name else {"type": "text", "text": ""})
    delta = ({"type": "input_json_delta", "partial_json": json.dumps(inp)}
             if name else {"type": "text_delta", "text": inp})
    return sse([
        {"type": "message_start", "message": {"id": mid, "type": "message", "role": "assistant",
         "model": model, "content": [], "usage": {"input_tokens": 10, "output_tokens": 0}}},
        {"type": "content_block_start", "index": 0, "content_block": block},
        {"type": "content_block_delta", "index": 0, "delta": delta},
        {"type": "content_block_stop", "index": 0},
        {"type": "message_delta", "delta": {"stop_reason": stop}, "usage": {"output_tokens": 5}},
        {"type": "message_stop"},
    ])


def flat(msgs):
    out = []
    for m in msgs:
        c = m.get("content")
        if isinstance(c, str):
            out.append(c)
        elif isinstance(c, list):
            for b in c:
                if isinstance(b, dict):
                    out.append(str(b.get("text") or b.get("content") or b.get("name") or ""))
    return " ".join(out)


STATE = {"parent_turns": 0}


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0)) or b"{}"))
        except (ValueError, TypeError):
            return self._err(400, b'{"error":{"type":"invalid_request_error"}}')
        model = body.get("model", "?")
        text = flat(body.get("messages", []))
        parent = CANARY in text
        LOG.write(json.dumps({"model": model, "kind": "parent" if parent else "child"}) + "\n")
        LOG.flush()
        if not parent:
            payload = envelope(None, "OK", "msg_c1", model, stop="end_turn")
        else:
            STATE["parent_turns"] += 1
            n = STATE["parent_turns"]
            payload = (envelope("task", TASK_INPUT, "msg_p1", model) if n == 1
                       else envelope("wait", {"handles": ["TierProbe"]}, "msg_p2", model) if n == 2
                       else envelope(None, "DONE", "msg_pd", model, stop="end_turn"))
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _err(self, code, payload):
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        self._err(405, b'{"error":{"type":"invalid_request_error"}}')


if __name__ == "__main__":
    socketserver.TCPServer.allow_reuse_address = True
    srv = socketserver.TCPServer(("127.0.0.1", 0), H)  # ephemeral; the bound port goes to MOCK_PORT_FILE
    with open(os.environ["MOCK_PORT_FILE"], "w") as fh:
        fh.write(str(srv.server_address[1]) + "\n")
    srv.serve_forever()
PY
# The mock's own output goes to a file, not /dev/null: a mock that dies at
# startup (or raises mid-run) otherwise leaves only a cause-less timeout.
MOCK_PORT_FILE="$MOCK_PORT_FILE" MOCK_LOG="$MOCK_LOG" python3 "$SCRATCH/mock.py" >"$SCRATCH/mock.err" 2>&1 &
MOCK_PID=$!
MOCK_PORT=""
for _ in $(seq 50); do
  if [ -s "$MOCK_PORT_FILE" ]; then MOCK_PORT="$(cat "$MOCK_PORT_FILE")"; break; fi
  sleep 0.2
done
[ -n "$MOCK_PORT" ] || { echo "::error::smoke-omp: scripted mock never reported a bound port — mock output: $(tail -n 5 "$SCRATCH/mock.err" | tr '\n' ' ')"; exit 1; }
for cmd in run-team-help review-and-fix run-merge-bot; do
  # probe_substitution prints its own cause-specific ::error:: line.
  probe_substitution "$cmd" || fail=1
done

cd "$PROBE_DIR"
TIER_RUN_DIR="$SCRATCH_HOME/.omp/agent/sessions"
# omp's own --max-time is the bound (a process-internal watchdog — it prints
# "Deadline exceeded" and exits); no external `timeout` wrapper, because BSD
# (macOS, where this script is run directly per the header) has no `timeout`
# and a missing binary used to fail the run silently under `|| true`.
HOME="$SCRATCH_HOME" ANTHROPIC_API_KEY="sk-ant-omp-smoke-dummy-not-real" ANTHROPIC_BASE_URL="http://127.0.0.1:$MOCK_PORT" \
  omp -p --auto-approve --max-time 60 \
  "SMOKE-PARENT-CANARY-9c1f. Use the task tool exactly once to dispatch agent \"fleet-finisher\" with the task: Reply with exactly OK and stop. Then wait for its completion and print DONE." \
  >"$SCRATCH/parent.out" 2>&1 || true
cd "$OLDPWD"

CHILD_JSONL=""
SCANNED=0
UNPARSED=""
# while-read over process substitution, not `find | while | head`: `head`
# closing the pipe SIGPIPEs the while under `set -o pipefail` and the script
# died BEFORE the error line could print (measured: exit 1, no diagnostic).
# The loop therefore drains the whole find (keep-going flag, no break), and
# avoids the fragile `for f in $(find)` form (SC2044). jq -e answers 1 for a
# file with no fleet-finisher record and above 1 for one it cannot parse
# (measured: truncated JSONL → 5) — kept apart so a parse failure is never
# reported as a missing record.
while IFS= read -r f; do
  SCANNED=$((SCANNED + 1))
  [ -z "$CHILD_JSONL" ] || continue
  jq_rc=0
  jq -e -s 'any(.[]; .type=="session_init" and .agent=="fleet-finisher")' "$f" >/dev/null 2>&1 || jq_rc=$?
  case "$jq_rc" in
    0) CHILD_JSONL="$f" ;;
    1) ;;
    *) UNPARSED="$UNPARSED $(basename "$f") (jq rc $jq_rc)" ;;
  esac
done < <(find "$TIER_RUN_DIR" -name '*.jsonl' -newer "$SCRATCH/mock.py" 2>/dev/null)
if [ -z "$CHILD_JSONL" ]; then
  [ -d "$TIER_RUN_DIR" ] || UNPARSED="$UNPARSED (no $TIER_RUN_DIR at all)"
  echo "::error::smoke-omp: tier probe produced no fleet-finisher child session record ($SCANNED session file(s) scanned${UNPARSED:+; unreadable:$UNPARSED}; mock log: $(tr '\n' ';' < "$MOCK_LOG" 2>/dev/null | cut -c1-200); parent tail: $(tail -c 200 "$SCRATCH/parent.out" | tr '\n' ' '))"
  fail=1
else
  CHILD_MODEL="$(jq -rs '[.[] | select(.type=="model_change") | .model] | last // empty' "$CHILD_JSONL")"
  CHILD_EFFORT="$(jq -rs '[.[] | select(.type=="thinking_level_change") | .thinkingLevel] | last // empty' "$CHILD_JSONL")"
  if [ "$CHILD_MODEL" = "anthropic/claude-haiku-4-5" ] && [ "$CHILD_EFFORT" = "low" ]; then
    echo "smoke-omp: tier OK — fleet-finisher resolved $CHILD_MODEL @ $CHILD_EFFORT (frontmatter @smol:low honored on the link route)"
  else
    echo "::error::smoke-omp: tier REFUSED — fleet-finisher resolved '$CHILD_MODEL @ $CHILD_EFFORT', expected anthropic/claude-haiku-4-5 @ low. A parent-target/medium answer here is the #1430 drop (frontmatter model discarded); high is omp's bare subagent default, never a declared tier."
    fail=1
  fi
fi

if [ "$fail" -ne 0 ]; then
  echo "smoke-omp: FAILED"
  exit 1
fi

echo "smoke-omp: commands substituted (bare names), agents+skills present, tier honored — all against the linked checkout"
