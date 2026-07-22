#!/bin/bash
# Harness-agnostic auto-recall helpers, shared by the Claude UserPromptSubmit
# hook (hooks/claude/memory-recall-on-prompt.sh) and the Copilot
# userPromptSubmitted hook (hooks/copilot/memory-userprompt.sh).
#
# SOURCE this file (don't execute it) — it only defines functions. Each harness
# wrapper handles its own stdin parsing and output-envelope shape; the shared
# pieces here are the substantive-prompt gate, workspace derivation, and the
# search → format → cache-write recall core.

# Directory this lib lives in, captured at source time. cache-write.sh is always
# co-located: installed layout = <hooksDir>/lib/, repo layout = hooks/shared/lib/.
_RECALL_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"

# Opt-in diagnostics, off unless AGENT_BRAIN_DEBUG is set to a non-empty value.
#
# Every failure path in this file is deliberately non-blocking and silent,
# which makes four very different states indistinguishable from the outside
# (exit 0, no stdout, no stderr): nothing listening on the port, an HTTP error
# from the server, a response whose payload shape changed, and a genuine
# zero-match search. Set AGENT_BRAIN_DEBUG=1 to get a one-line reason on stderr
# for each of them instead.
#
# stderr ONLY — stdout belongs to the harness JSON envelope. The normal
# (non-debug) path stays completely silent.
recall_debug() {
  [ -n "${AGENT_BRAIN_DEBUG:-}" ] || return 0
  printf 'memory-recall: %s\n' "$*" >&2
}

# Human-readable gloss for the curl exit codes this hook actually hits. curl's
# own diagnosis is otherwise discarded by the `2>/dev/null || return 1` on the
# search call, which is what collapses "server is down" (exit 7) and "server
# returned 500" (exit 22) into the same silent nothing.
_curl_exit_hint() {
  case "$1" in
    6) printf 'could not resolve host' ;;
    7) printf 'connect failed — nothing listening on that port' ;;
    22) printf 'server returned HTTP >= 400' ;;
    28) printf 'timed out' ;;
    52) printf 'empty reply from server' ;;
    56) printf 'receive error' ;;
    *) printf 'see curl(1) EXIT CODES' ;;
  esac
}

# Resolve workspace_id = canonical git repo name (stable across worktrees).
# Falls back to the directory basename outside a git repo. Lowercased.
# Empty/nonexistent dir → "unknown-workspace" (never "/" or a plausible wrong
# path; git -C "" would otherwise resolve against the hook process cwd).
derive_workspace_id() {
  local dir="$1" common repo
  if [ -z "$dir" ] || [ ! -d "$dir" ]; then
    echo "unknown-workspace"
    return
  fi
  common=$(git -C "$dir" rev-parse --git-common-dir 2>/dev/null)
  if [ -n "$common" ]; then
    case "$common" in /*) ;; *) common="$dir/$common" ;; esac   # absolutize relative .git
    repo=$(cd "$(dirname "$common")" 2>/dev/null && pwd)
    if [ -n "$repo" ]; then
      basename "$repo" | tr '[:upper:]' '[:lower:]'
      return
    fi
  fi
  basename "$dir" | tr '[:upper:]' '[:lower:]'
}

# Resolve where agent-brain roots its workspace files (index + cache): the git
# worktree toplevel (via --show-toplevel, which returns the symlink-resolved path),
# not the raw cwd — so a session launched from a subdir doesn't write a nested
# .agent-brain/ tree. Distinct from the --git-common-dir used for the worktree-
# stable workspace_id. Falls back to the input dir outside a git repo or if
# resolution yields a non-directory. Called by wrappers that receive a raw
# `.cwd` from stdin (Copilot, Codex) rather than an already-resolved project
# root; the Claude recall hooks pass $CLAUDE_PROJECT_DIR verbatim instead.
derive_workspace_dir() {
  local dir="$1" top
  top=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null)
  if [ -n "$top" ] && [ -d "$top" ]; then
    printf '%s\n' "$top"
  else
    printf '%s\n' "$dir"
  fi
}

# Substantive-prompt gate: returns 0 (fire recall) for a prompt that is, after
# trimming, longer than 20 chars, multi-token (contains whitespace), and not a
# slash command. Returns 1 (skip) otherwise. Mirrors the rule documented in the
# recall snippet so Claude and Copilot gate identically.
is_substantive_prompt() {
  local prompt="$1" trimmed
  # A sed failure (locale / BSD-vs-GNU -E edge) must NOT be read as "skip" — that would
  # silently drop recall on a real prompt. Fall back to the untrimmed prompt instead.
  trimmed=$(printf '%s' "$prompt" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' 2>/dev/null) || trimmed="$prompt"
  [[ ${#trimmed} -le 20 ]] && return 1                 # too short
  [[ "$trimmed" =~ ^[^[:space:]]+$ ]] && return 1      # single token (no whitespace)
  [[ "$trimmed" =~ ^/ ]] && return 1                   # slash command
  return 0
}

# ---------------------------------------------------------------------------
# Per-turn injected-id ledger.
#
# Keyed on session_id ALONE. The turn boundary is established by the
# prompt-submit hook truncating this file at turn start, NOT by a per-turn id:
# claude sends prompt_id and codex sends turn_id, so keying on the reset event
# sidesteps the naming divergence instead of branching on it.
# ---------------------------------------------------------------------------

ledger_path() {
  local session_id="$1" safe
  # Filesystem-safe, never empty. An empty session_id collapses to one shared
  # bucket — over-dedup is conservative; writing to a bare path is not.
  safe=$(printf '%s' "${session_id:-default}" | tr -c 'A-Za-z0-9_.-' '_')
  printf '%s\n' "${TMPDIR:-/tmp}/agent-brain-recall-${safe}"
}

# Truncate for a new turn, and prune ledgers older than 3 days so abandoned
# sessions don't accumulate. Pruning is best-effort and never fatal.
#
# A FAILED truncate must never leave the previous turn's ids readable. Callers
# invoke this as `ledger_reset "$LEDGER" || true`, so a plain `return 1` on an
# existing, NON-EMPTY, unwritable ledger (mode 444, or another user's file in a
# shared TMPDIR) was swallowed and the stale ids survived — ledger_read then
# served them as the exclude list for every mid-turn recall in this turn,
# filtering out EVERY match. Recall silently dead, indistinguishable from a
# dead server. So: on truncate failure, unlink and recreate. If even that
# fails, the file is left unwritable, which ledger_read detects and treats as
# "no ledger" → no exclusions. Failing OPEN (no dedup, possibly a duplicate
# injection) is correct here; failing CLOSED (exclude everything) is not —
# the same principle the ledger_append note below states.
ledger_reset() {
  local path="$1" dir rc=0
  # The braces matter: `: > "$path" 2>/dev/null` does NOT suppress a failing
  # redirection, because the redirect that fails is processed before stderr is
  # pointed at /dev/null. Wrapping in a group applies the suppression first.
  if ! { : > "$path"; } 2>/dev/null; then
    rm -f "$path" 2>/dev/null
    if ! { : > "$path"; } 2>/dev/null; then
      recall_debug "ledger reset failed, ledger unwritable ($path); dedup disabled this turn"
      rc=1
    fi
  fi
  dir=$(dirname "$path")
  find "$dir" -maxdepth 1 -name 'agent-brain-recall-*' -mtime +3 -delete 2>/dev/null
  return "$rc"
}

# Append newline-separated ids. Returns 1 on write failure so callers can log,
# but callers MUST NOT suppress recall on that failure — dedup is an
# optimization, recall is the feature.
ledger_append() {
  local path="$1" ids="$2"
  [ -z "$ids" ] && return 0
  printf '%s\n' "$ids" >> "$path" 2>/dev/null || return 1
  return 0
}

# Emit already-injected ids as a comma-separated list for run_recall's
# exclude argument. Missing/unreadable ledger yields empty (no exclusions).
#
# Capped at the 50 most recent ids. The cap exists because not every harness
# has a turn-reset event: copilot-vscode wires no UserPromptSubmit-equivalent
# hook at all (see hooks/README.md "Coverage" / the mid-turn-recall design
# doc's harness table), so ledger_reset never runs there and this file would
# otherwise grow for the entire life of the session — the 3-day
# `find -mtime +3` prune in ledger_reset never gets a chance to run either,
# since it lives inside the reset call. Without a cap the exclude list grows
# unbounded and mid-turn recall degrades toward excluding everything.
#
# `tail` MUST run BEFORE `sort -u`. `sort -u` destroys insertion order, so
# sorting first and then capping would keep "the 50 alphabetically-first ids
# ever injected", not "the 50 most recently injected" — silently
# reintroducing the unbounded-growth failure mode this cap exists to close.
# Consequently ledger_read does not preserve insertion order beyond this
# 50-line tail window; the CSV it returns is alphabetically sorted (an
# artifact of the dedup), not chronological.
ledger_read() {
  local path="$1"
  [ -f "$path" ] || return 0
  # Fail OPEN on an unusable ledger. A ledger we cannot write cannot have been
  # truncated at turn start (ledger_reset tried and failed) and cannot receive
  # this turn's ids either, so whatever it holds is stale by construction —
  # the previous turn's ids, or another user's in a shared TMPDIR. Returning
  # them as exclusions would filter out EVERY match for the rest of the
  # session. No dedup beats no recall.
  if [ ! -w "$path" ]; then
    recall_debug "ledger not writable ($path); ignoring its stale ids rather than excluding everything"
    return 0
  fi
  tail -n 50 "$path" 2>/dev/null | sort -u | grep -v '^[[:space:]]*$' | paste -sd, - 2>/dev/null
  return 0
}

# Run auto-recall and print the additionalContext TEXT (caller wraps it in the
# harness-appropriate JSON envelope). Returns 1 (no output) on any failure path
# or when there are no matches, so callers never advertise an empty recall.
#
# Args: prompt user_id workspace_id workspace_dir port [exclude_csv]
run_recall() {
  local prompt="$1" user_id="$2" workspace_id="$3" workspace_dir="$4" port="$5" exclude="${6:-}"
  local body resp lines writer items count rc total excluded url

  # The advertised cache paths (and the cache-write target) are rooted at
  # $workspace_dir. An empty/relative/nonexistent value would emit a dead link
  # like "/.agent-brain/cache/<id>.md" rooted at filesystem root. Bail rather
  # than advertise it. The case glob also catches the empty string (no match on /*).
  case "$workspace_dir" in
    /*) ;;
    *) echo "memory-recall: WORKSPACE_DIR not absolute; skipping recall to avoid dead cache links" >&2; return 1 ;;
  esac
  [ -d "$workspace_dir" ] || { echo "memory-recall: WORKSPACE_DIR not a directory; skipping recall to avoid dead cache links" >&2; return 1; }

  # limit/min_similarity tuned in spec
  # (docs/superpowers/specs/2026-05-07-memory-recall-on-prompt-design.md).
  body=$(jq -nc \
    --arg q "$prompt" \
    --arg u "$user_id" \
    --arg w "$workspace_id" \
    '{query: $q, user_id: $u, workspace_id: $w, scope: ["workspace","user","project"], limit: 5, min_similarity: 0.5}' \
    2>/dev/null) || { recall_debug "could not build request body (jq failed)"; return 1; }

  url="http://127.0.0.1:${port}/api/tools/memory_search"
  resp=$(curl -fsS --max-time 3 \
    -H 'content-type: application/json' \
    -d "$body" \
    "$url" 2>/dev/null)
  rc=$?
  if [ "$rc" -ne 0 ]; then
    recall_debug "curl exit $rc ($(_curl_exit_hint "$rc")) for $url"
    return 1
  fi

  # Shape probe BEFORE formatting. A payload whose key changed (.results
  # instead of .data) yields exactly the same empty $lines as a genuine
  # zero-match search, and both used to exit 1 in silence. Separate them here
  # so the debug line can say which one actually happened.
  total=$(printf '%s' "$resp" | jq -r \
    'if (.data | type) == "array" then (.data | length) else "notarray" end' 2>/dev/null) \
    || total="unparsable"
  case "$total" in
    unparsable) recall_debug "response is not JSON (jq parse failed)"; return 1 ;;
    notarray) recall_debug "response shape unexpected: no .data array"; return 1 ;;
    "") recall_debug "empty response body from $url"; return 1 ;;
  esac

  lines=$(printf '%s' "$resp" | jq -r \
    --arg cache "$workspace_dir/.agent-brain/cache" \
    --arg excl "$exclude" '
    ($excl | split(",") | map(select(length > 0))) as $skip
    | .data
    | if . == null or length == 0 then empty
      else
        map(select(.id as $id | ($skip | index($id)) | not))
        | if length == 0 then empty
          else
            map(
              "\(.id) [\(.scope)] \(.type)"
              + ( if (.tags // [] | length) > 0
                  then " {" + ((.tags // []) | join(",")) + "}"
                  else "" end )
              + " — \(.title): "
              + ( (.content // "") | split("\n")[0] | .[0:80] )
              + " → \($cache)/\(.id).md"
            )
            | join("\n")
          end
      end
  ' 2>/dev/null) || { recall_debug "could not format results (jq failed)"; return 1; }

  if [[ -z "$lines" ]]; then
    # Reached only when the response WAS a well-formed .data array — so this is
    # the genuine "nothing to inject" case, either an empty result set or every
    # result already injected earlier this turn.
    if [ -z "$exclude" ]; then
      excluded=0
    else
      excluded=$(printf '%s' "$exclude" | tr ',' '\n' | grep -c '[^[:space:]]')
    fi
    recall_debug "0 matches to inject ($total returned by search, $excluded already injected this turn)"
    return 1
  fi

  # Cache the recalled memories so the linked paths resolve (best-effort).
  # memory_search results carry no source_path (only memory_get does) → recall
  # always writes a copy; a later memory_get upgrades vault entries to symlinks
  # via the PostToolUse hook. Projection kept identical to session-start.
  writer="${_RECALL_LIB_DIR}/cache-write.sh"
  if [ -f "$writer" ]; then
    items=$(printf '%s' "$resp" | jq -c \
      '[ (.data // [])[] | {id, source_path, content, title, type, scope, version, updated_at} ]' 2>/dev/null) || items=""
    # cache-write.sh emits its own `cache-write:`-prefixed breadcrumbs and exits 0
    # even on failure, so the `||` branch below is a defensive net (fires only if a
    # future cache-write returns non-zero). Either way a missing convenience cache is
    # non-fatal: the advertised "→ .../cache/<id>.md" links may not resolve, but the
    # prompt is never blocked.
    if [ -n "$items" ]; then
      printf '%s' "$items" | bash "$writer" "$workspace_dir/.agent-brain/cache" \
        || echo "memory-recall: cache-write failed; advertised cache paths may not resolve" >&2
    else
      echo "memory-recall: could not build cache items; advertised cache paths may not resolve" >&2
    fi
  fi

  # $lines and the cache write already succeeded — count the formatted lines directly.
  # Each memory formats to exactly one line, so this count is exact and accounts for exclusions.
  count=$(printf '%s\n' "$lines" | grep -c .)

  printf 'Auto-recall: %s potentially relevant memories. Fetch any with memory_get(id) before responding.\n%s' \
    "$count" "$lines"
}

# ---------------------------------------------------------------------------
# Failure-side detection (PostToolUse).
#
# Deliberately NOT keyed on exit status: grep no-match, test, diff and find all
# exit 1 as ordinary control flow. A hook that treats those as failures fires
# constantly and becomes noise the agent learns to ignore — the exact fate of
# the write-side nudge.
# ---------------------------------------------------------------------------

# Args: tool_response command [tool_name]
#
# tool_name is OPTIONAL so existing call sites (and the tests written before
# this arg existed) keep working unchanged when they omit it.
#
# Why it matters: Copilot's hooks.json entries carry no matcher field, so
# this function is the ONLY gate on the failure side there (Claude and Codex
# additionally get a harness-level `Bash`/`Bash|apply_patch` matcher, but
# that must not be the only thing standing between an arbitrary tool
# response and a recall firing). For a non-Bash tool call `.tool_input.command`
# is empty, so the benign-exit-binary check below never engages, and ANY
# response containing "error"/"failed"/"not found"/"cannot " etc. fires —
# including an agent-brain memory_get/memory_search response whose CONTENT is
# memory text. That text is guaranteed to match memories above the 0.5
# similarity threshold, since it often IS one: recall would trigger recall.
# So skip agent-brain's own MCP tools outright, matching both the hyphen
# form (mcp__agent-brain__…, used by Claude and Copilot) and the underscore
# form (mcp__agent_brain__…, used by Codex) — see is_high_consequence_action
# below for the same claude/codex naming divergence.
is_tool_failure() {
  local resp="$1" tool="${3:-}" lowered scrubbed
  # $2 (the command string) is still accepted so every existing call site and
  # test keeps working, but it is deliberately NOT inspected any more — see the
  # benign-exit note below. It is left unassigned rather than assigned-unused.
  [ -z "$resp" ] && return 1

  case "$tool" in
    mcp__agent-brain__* | mcp__agent_brain__*) return 1 ;;
  esac

  # There is no benign-exit-binary allowlist here on purpose. There used to be
  # one (grep/egrep/fgrep/rg/test/diff/cmp/find), and it was inert: it
  # suppressed only when the response was whitespace-only, but whitespace can
  # never match the error regex below, and a truly empty response already
  # short-circuits at the `[ -z "$resp" ]` line above — which is what actually
  # implements "a grep that matched nothing is not a failure". It was also
  # mis-parsed (`awk '{print $1}'` over a MULTI-LINE command yields a
  # multi-line head_bin that matches no case arm) and trivially bypassed by an
  # env prefix (`FOO=bar grep …`) or `sudo grep …`. Deleted rather than tuned:
  # it removed nothing the empty-response check does not already remove, and
  # tightening it would mean inferring "the command succeeded" from a response
  # string that carries no exit status. That is the same regex-tuning treadmill
  # the rule-5 pre-side matcher was deleted for (see is_high_consequence_action).
  #
  # Known and accepted: `grep -rn error src/` still reads as a failure, because
  # its matched CONTENT contains the word. Suppressing that needs an exit
  # status the hook does not receive; a content-shape heuristic would start
  # dropping real failures (e.g. `find … -exec rm …` whose output is `rm:
  # Permission denied`, not `find: …`). Left as-is until there is evidence.

  # Case-fold once, so the scrub below can be a plain portable sed (BSD sed has
  # no `s///I` flag). LC_ALL=C keeps tr/sed/grep bytewise: raw tool output is
  # not guaranteed to be valid UTF-8, and an "illegal byte sequence" abort here
  # would read as "not a failure" and silently drop recall.
  lowered=$(printf '%s' "$resp" | LC_ALL=C tr '[:upper:]' '[:lower:]' 2>/dev/null)
  [ -z "$lowered" ] && lowered="$resp"

  # Success is routinely reported in the vocabulary of failure: "Build
  # complete. 0 errors, 0 warnings." and "Tests: 42 passed, 0 failed" both used
  # to fire. Delete the zero-count shapes first so the occurrences that survive
  # are real ones. Non-zero counts ("2 errors", "3 tests failed") are untouched,
  # and the optional middle word covers "0 tests failed" / "no checks failed".
  scrubbed=$(printf '%s' "$lowered" | LC_ALL=C sed -E \
    's/(^|[^a-z0-9_])(0|no|zero)[[:space:]]+([a-z]+[[:space:]]+)?(error|failure|failed|warning)[a-z]*/\1/g' \
    2>/dev/null) || scrubbed="$lowered"
  [ -z "$scrubbed" ] && return 1

  # Leading word boundary only. A trailing one would break the inflected forms
  # that must still match ("errors", "failures"), while the leading one is what
  # stops "terror"/"skilled"/"zoom" from firing.
  #
  # The kill/crash signals are the whole point of the failure side: `Killed`,
  # `OOM`/`OOMKilled`, `Segmentation fault`, `core dumped` and a 128+N exit
  # status carry NONE of the older keywords, so the highest-severity failures
  # were exactly the ones that never triggered recall.
  printf '%s' "$scrubbed" | LC_ALL=C grep -qE \
    '(^|[^a-z])(error|failed|failure|exception|traceback|assertion|not found|no such|cannot|unable to|killed|oom|out of memory|segmentation fault|segfault|bus error|core dumped|abort trap|exit (code )?1(2[89]|3[0-9]|4[0-3]))' \
    && return 0
  return 1
}

# Build a search query from tool output. Prefers error-signal lines, strips
# ANSI, collapses whitespace, caps at 500 chars. Returns 1 (emitting nothing)
# when under 20 chars of substance remain — a tiny query embeds to noise and
# would match arbitrary memories above the 0.5 threshold.
extract_failure_query() {
  local resp="$1" stripped signal query esc
  # Build ESC via printf rather than embedding a literal escape byte: an inline
  # $'\033' in a concatenated sed expression is fragile to quoting and broke
  # this file once already.
  esc=$(printf '\033')
  stripped=$(printf '%s' "$resp" | sed -E "s/${esc}\[[0-9;]*[a-zA-Z]//g" 2>/dev/null) || stripped="$resp"

  signal=$(printf '%s' "$stripped" | grep -iE 'error|failed|failure|exception|traceback|assertion|not found' 2>/dev/null | head -10)
  [ -z "$signal" ] && signal=$(printf '%s' "$stripped" | head -10)

  query=$(printf '%s' "$signal" | tr '\n' ' ' | sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//' 2>/dev/null)
  # Truncate with a bash substring, NOT `cut -c1-500`: GNU cut counts BYTES
  # (and BSD cut does too outside a multibyte locale), so it can slice a
  # multi-byte UTF-8 sequence in half and leave a dangling lead byte. That
  # reaches `jq --arg`, which on jq 1.7 silently substitutes U+FFFD (measured)
  # and on older jq errors out — so the query is either corrupted at the tail
  # or the whole recall disappears, on any non-ASCII tool output long enough to
  # hit the cap. ${var:0:N} counts CHARACTERS in a UTF-8 locale and so never
  # splits one. Caveat, verified: under LC_ALL=C bash counts bytes too, so this
  # is a strict improvement rather than an absolute guarantee.
  query="${query:0:500}"
  [ ${#query} -lt 20 ] && return 1
  printf '%s' "$query"
}

# ---------------------------------------------------------------------------
# Pre-side matcher (PreToolUse).
#
# PreToolUse fires on EVERY tool call, so this stays narrow — breadth here
# costs a round-trip per call. That is the opposite trade-off from the failure
# side, where the event itself is rare and breadth is nearly free.
#
# Scope reduced 2026-07-20 (#173 follow-up, maintainer-directed): this used to
# also match a CLAUDE.md "rule-5" allowlist of shell commands (deploy,
# migrate, lockfile, hooks config, CI workflows, credential rotation,
# integration tests). That regex went through three fix passes and three
# review rounds and still had verified false negatives (`find … -delete`
# against protected files; `sudo`/env-prefixed/`npx <tool> migrate`/`yarn run`
# invocations) while the originating issue's evidence table never listed a
# single rule-5 miss — the two documented pre-side misses (a `memory-proxy`
# dispatch destroying a memory body, and PR-worktree setup) are exactly the
# two classes still handled below. Deleted rather than tuned further (YAGNI);
# it can come back if real evidence for it appears. A `Bash` tool call
# therefore always SKIPs — this function no longer inspects `.command` at
# all.
#
# Tool-name patterns are leading-wildcard so they match BOTH the claude
# hyphen form (mcp__agent-brain__…) and the codex underscore form
# (mcp__agent_brain__…). A matcher written for only one silently never fires
# on the other — that bug has shipped once already.
# ---------------------------------------------------------------------------

# Args: tool_name tool_input_json
is_high_consequence_action() {
  local tool="$1" input="$2" content sub

  case "$tool" in
    *memory_update | *memory_create)
      # Only large bodies. A small save is cheap to redo; the documented miss
      # was a long-body update destroying content.
      content=$(printf '%s' "$input" | jq -r '.content // ""' 2>/dev/null) || return 1
      [ ${#content} -gt 2000 ] && return 0
      return 1
      ;;
    Agent | *__Agent)
      # Match on subagent_type ALONE. Concatenating .prompt used to make this
      # fire on any dispatch whose prompt merely mentions "memory-proxy" in
      # passing (e.g. an Explore agent asked to read the subagent's own
      # definition file) — a false positive with no bearing on which
      # subagent actually runs.
      sub=$(printf '%s' "$input" | jq -r '.subagent_type // ""' 2>/dev/null) || return 1
      [ "$sub" = "memory-proxy" ] && return 0
      return 1
      ;;
  esac

  return 1
}

# Pre-side mirror of extract_failure_query. Builds the search query from the
# tool input: the command string, the Agent dispatch prompt, or the title /
# first content line for a memory write. Lives here rather than in the shims
# so both recall sides are symmetric and the shim-purity guard (Task 9) stays
# meaningful.
#
# `.prompt` LEADS the chain: an Agent dispatch (the only surviving PreToolUse
# trigger besides memory writes) carries neither `.command` nor
# `.title`/`.content`. Without it first, the surviving Agent trigger would fire
# the matcher above and then yield an empty query here, silently killing the
# recall it was meant to produce.
#
# `.command` is demoted to third and is UNREACHABLE in production: after the
# 2026-07-20 scope reduction only memory_update/memory_create and Agent pass
# is_high_consequence_action, and none of those carry a command — a `Bash` tool
# call always SKIPs. It is retained only as an inert tail so a future trigger
# that does carry a command still produces a query. Do not read its presence as
# evidence that Bash reaches this function.
#
# It must stay ABOVE the content branch: in jq only null/false are falsy, so
# `((.content // "") | split("\n")[0])` yields "" — a TRUTHY value — for an
# input with no content, which would swallow every later alternative.
extract_action_query() {
  local input="$1" query
  query=$(printf '%s' "$input" | jq -r '
    (.prompt // .title // .command // ((.content // "") | split("\n")[0]) // "")' 2>/dev/null) || return 1
  # Character-based truncation, not `cut -c` (bytes) — see extract_failure_query.
  query="${query:0:500}"
  [ ${#query} -lt 10 ] && return 1
  printf '%s' "$query"
}
