# shellcheck shell=sh
# The fleet's bounded, prompt-suppressed git transport (#92, #346, #347).
# Sourced, never executed — no shebang, and the `shell=sh` directive above is
# what tells shellcheck what to check it as.
#
# Source it as:
#
#     net_lib="$(dirname "$0")/net.sh"
#     [ -r "$net_lib" ] || die "cannot read $net_lib"
#     # shellcheck source-path=SCRIPTDIR
#     # shellcheck source=net.sh
#     . "$net_lib" || die "$net_lib failed to load"
#
# The `[ -r ]` is not belt-and-braces; json.sh's header holds the measurements
# behind that shape and they apply here unchanged — `.` is a POSIX special
# builtin, so failing to open its operand aborts a non-interactive shell before
# any `||` on the line can run.
#
# WHY A LIB. #346 landed this mechanism inside inflight.sh's probe 2, for the
# one call that probe makes. Every other unattended `git` network call in the
# fleet — release-ticket.sh's pushed-branch lookup, and the fetches in
# prove-merge.sh, reap.sh and verify-sha.sh — still ran raw, so each of them
# could prompt on a credential or a host key, or stall on a transport that
# connects and then goes quiet, holding a fleet slot indefinitely (#347). The
# alternative considered was copying the transport flags to each call site; it
# is what this file exists to avoid, and it would not have bounded the connect
# phase in any case, since git exposes no knob for it. So the mechanism moved
# here whole and probe 2 became its first caller rather than its owner.
#
# `gh` calls are deliberately NOT routed through this. Measured during the
# PR #332 review, `gh issue view` against a silent listener failed on its own at
# 10.0s with `net/http: TLS handshake timeout` — `gh` is already bounded, and
# wrapping it would buy a second bound over the first.
#
# `LC_ALL=C` is a per-command prefix below, never an export, for the reason
# json.sh gives: prove-merge.sh and verify-sha.sh do not pin the locale, and
# exporting from a sourced lib would silently re-locale every other tool in them.

# net_budget <default> <override> — print the budget a call gets, in seconds.
#
# The override exists so the tests can buy a short budget instead of paying the
# default one per case. It can only ever SHORTEN: a knob that could lengthen it
# would be one more way for configuration to remove the bound, which is the
# defect the ssh half of #346 reports, and reproducing it here to be convenient
# would be its own bug. A value that is not a positive integer is not an error
# and not a bound either — the default stands.
#
# `??????*` is that last clause holding for a digit string too large for the
# shell's integer. Without it `[` is handed the value and contradicts the
# sentence above out loud: measured, `sh` says `[: 99999999999999999999:
# integer expression expected` and dash says `[: Illegal number:` — a raw
# diagnostic naming a line number rather than the variable, on the same stderr
# that carries the caller's own reasons. Six digits, not twenty: anything from
# 100000 up was going to be ignored by the `-lt` below regardless, so the arm
# costs no reachable value and leaves the five-digit forms `[` reads correctly
# (029 among them) taking the same path they always did.
#
# The caller passes the override's VALUE, not its name, so each script keeps its
# own env var and the one this file would otherwise impose on all of them does
# not exist. `printf`, not `echo`: the value reaches here as raw environment.
net_budget() {
  net_budget_v=$1
  case ${2:-} in
    '' | *[!0-9]* | ??????*) : ;;
    *) if [ "$2" -gt 0 ] && [ "$2" -lt "$net_budget_v" ]; then net_budget_v=$2; fi ;;
  esac
  printf '%s' "$net_budget_v"
}

# Kill $1 and everything descended from it. Killing the named process alone is
# not enough and not a near miss: git hands the transport to a helper, and that
# helper inherits this script's stderr. Measured against the accept-then-silent
# listener, killing only the `ls-remote` process left a `git remote-https`
# holding that pipe — the script had already written its answer and exited, and
# the caller still sat until its own cap expired, reading as a hang in a script
# that had in fact terminated. So the subtree is the unit, not the process.
#
# A process group would say this in one signal, but `set -m` is how a POSIX
# shell asks for one and it is not available where this runs: measured, dash
# with no controlling terminal answers "can't access tty; job control turned
# off" and the group kill then fails, and dash is `/bin/sh` on the Linux this
# suite runs under.
#
# The snapshot is taken BEFORE anything is signalled, because killing the root
# reparents its children and the links this walk follows are gone by then.
#
# Ceiling: with no `ps` to read, this falls back to the named process alone and
# a helper can survive it. That is the pre-#346 behaviour for that one case, not
# a new failure, and it is preferred over signalling a set derived from nothing.
# But it is not silent: the fallback records itself in $net_wdfile so the reason
# printed downstream can say the bound may not have held. A degraded kill that
# reads exactly like a clean one is the defect #346 asks this script not to
# have — measured, `ps` shimmed to exit 127 produced byte-identical stderr to
# the healthy run while a `git remote-https` survived and held the caller for
# its whole cap. `${net_wdfile:-/dev/null}` because net_kill_tree also runs
# before that file exists and on the path where mktemp is not reached at all.
#
# TERM then KILL, with no pause between them: a descendant that traps TERM
# otherwise holds the fetch's inherited stderr and the caller hangs past the
# budget anyway — measured against a GIT_SSH_COMMAND wrapper doing `trap '' TERM`,
# the caller sat out its full 30s backstop with the script long since exited.
# A `sleep 1` between the two signals, the obvious shape, does NOT work here:
# the watchdog subshell is itself killed through this same function while it
# would be inside that sleep, so the KILL never lands. Which signal git actually
# dies of is no longer load-bearing — $net_wdfile, not the exit status, is
# what says the watchdog fired.
#
# The `do { … } while (grew)` fixpoint is not decoration. `for (p in parent)`
# visits keys in awk's own hash order, so a single pass misses any descendant
# the iteration reaches before its own parent has been marked. `ps -A` prints
# parents first, which is exactly why every end-to-end case here stays green on
# that mutant.
#
# What holds it is the descending-pid chain in net.test.mjs's net_kill_tree
# case — each child's pid BELOW its parent's, the shape pid wraparound produces.
# Feeding the rows in a different order does not hold it: the hash order is not
# the input order, and measured, the same key set fed parents-first and
# children-first iterated identically, so a child-ahead-of-parent table stays
# green on the single-pass mutant. The descending chain reds it on every awk
# reachable from here — one-true-awk 20200816 (darwin's /usr/bin/awk), mawk
# 1.3.4 (what ubuntu-latest runs) and gawk 5.4.1. An ASCENDING chain is not a
# substitute: gawk walks those keys in ascending order, which is already
# topological, so the mutant survives it there.
net_kill_tree() {
  net_kin=$1
  if net_snap=$(ps -A -o pid=,ppid= 2>/dev/null); then
    net_kin=$(printf '%s\n' "$net_snap" | LC_ALL=C awk -v root="$1" '
      { parent[$1] = $2 }
      END { doomed[root] = 1
            do { grew = 0
                 for (p in parent)
                   if (!(p in doomed) && (parent[p] in doomed)) {
                     doomed[p] = 1; grew = 1
                   }
               } while (grew)
            for (p in doomed) printf "%s ", p }') ||
      { net_kin=$1; printf 'degraded ' >>"${net_wdfile:-/dev/null}" || :; }
  else
    printf 'degraded ' >>"${net_wdfile:-/dev/null}" || :
  fi
  # shellcheck disable=SC2086  # a pid list, and word splitting is how kill reads it
  kill $net_kin 2>/dev/null || :
  # shellcheck disable=SC2086
  kill -9 $net_kin 2>/dev/null || :
}

# net_wdnote <wdfile> — what the watchdog recorded about the last net_git call:
# `fired` if the budget elapsed and the call was killed, `degraded` if the
# process table could not be read and only the named process was signalled.
#
# It has to be a file rather than a variable. The sleeper is a background
# grandchild, so nothing it sets in a variable reaches the shell that reads it,
# and its own exit status is discarded; a caller that captures net_git's stdout
# puts the whole call in a command substitution besides, which loses every
# assignment it makes. The marker is written BEFORE net_kill_tree, never after,
# because `wait` returns the instant the call dies and would otherwise race the
# write.
#
# A file a caller WANTS, not one it needs: `mktemp` failing must not cost a
# verdict that is otherwise answerable, so an empty <wdfile> is legal and reads
# back as an empty note. What is lost then is the wording, never the answer.
net_wdnote() {
  [ -n "${1:-}" ] || return 0
  cat "$1" 2>/dev/null || true
}

# net_stalled <status> — was the call most likely killed by the watchdog?
#
# The weaker of the two tests, for a caller with no temp file to give. It reads
# the watchdog's work off a signal number this shell does not own, so it cannot
# tell our SIGTERM from anyone else's: a call killed from OUTSIDE is reported as
# a stall. Accepted, and the reason is that both wordings sit under the same
# verdict — the caller could not answer either way — so the cost is a sentence,
# never a claim. 137 as well as 143, because net_kill_tree escalates to SIGKILL
# and git can lose that race.
#
# A caller that owns a temp file gets the sharper test instead: net_wdnote reads
# a marker written by the watchdog and by nothing else, which is what separates
# a 30s budget that really elapsed from a 4s kill reported as one. inflight.sh
# has that file, keeps it, and reads it back through net_wdnote; the scripts
# with no temp file and no EXIT trap of their own take this instead, rather than
# growing one apiece for a wording — as does inflight.sh itself, on the one path
# where its own mktemp failed and there is no marker to read.
net_stalled() {
  [ "$1" -eq 143 ] || [ "$1" -eq 137 ]
}

# net_git <wdfile> <budget> <git arg>... — run one `git` network call
# unattended: it neither prompts nor outlives <budget> seconds.
#
# stdout is git's stdout, stderr is left on stderr — git's own diagnostic of a
# failure is the useful thing to read, and folding it into the value is how a
# host-key notice comes back looking like a result. The return status is git's
# own, so `if ! out=$(net_git …)` reads exactly as `if ! out=$(git …)` did.
#
# <wdfile> is how the watchdog says it fired, and the caller reads it AFTER the
# call with net_wdnote — see there for why it is a file and not a variable. A
# caller with no file to give passes an empty string and loses only the sharper
# wording, never the verdict.
#
# GIT_TERMINAL_PROMPT=0 covers git's own username/password prompt.
# Unconditional, not gated on stdin being a tty: every caller here answers on a
# machine-read exit status, and a human with no cached credential is better
# served by that status naming what is unknown than by a prompt a machine
# caller never answers.
#
# A suppressed prompt is not a bound: measured, a stalled transport blocks
# identically with or without GIT_TERMINAL_PROMPT=0 (killed at 8s, rc 142
# either way) — prompting and hanging are different failures. `timeout(1)`
# would be the obvious bound but is GNU coreutils, absent by default here
# (verified: neither `timeout` nor `gtimeout` on this host's PATH), so the
# bound comes from git's own transport knobs.
#
# ssh: BatchMode=yes refuses any interactive prompt (host key, passphrase)
# rather than hanging on one, so it doubles as prompt suppression for the ssh
# case.
#
# ConnectTimeout is the option that bounds the stalled transport measured
# above: it gates the banner exchange, not only the TCP handshake, so a peer
# that accepts the connection and then never speaks is cut off at
# ConnectTimeout. Measured against that exact case (OpenSSH_10.2p1, the
# accept-then-silent listener the test at inflight.test.mjs uses) — both
# options set: "Connection timed out during banner exchange" at 10.0s;
# ConnectTimeout alone, ServerAlive dropped: 10.0s, identical; ServerAlive
# alone, ConnectTimeout dropped: still running at 30s, killed from outside.
# ServerAlive keepalives only ride an established transport, and here that
# transport never comes up, so they contribute nothing to this case. Their job
# is the session that gets past banner and authentication and only then goes
# quiet, which nothing here exercises.
#
# 10s to connect and 2x5s of silence: generous enough for a slow-but-working
# link, short enough that a stalled call does not hold a fleet slot for
# minutes. Retune here if either stops holding — but retune the right one: the
# accept-then-silent case rides on ConnectTimeout alone, so shortening
# ServerAlive does not tighten it and dropping ConnectTimeout removes it.
#
# A user's own ssh command is honoured, not replaced — these options are
# appended to whatever GIT_SSH_COMMAND, core.sshCommand or GIT_SSH already says
# (falling back to plain "ssh"), so a configured identity file or proxy command
# still runs. All three, because git's own precedence is GIT_SSH_COMMAND >
# core.sshCommand > GIT_SSH: setting GIT_SSH_COMMAND here without consulting
# GIT_SSH would silently drop a wrapper the user had working before this call
# was bounded at all.
#
# Appended, so they are defaults the user's own command overrides, never a
# ceiling over it: ssh takes the FIRST value of a repeated -o, so an option
# their command already carries is the one that applies and the value set here
# is discarded. Measured, OpenSSH_10.2p1: `ssh -o ConnectTimeout=45 -o
# ConnectTimeout=10 -G` reports connecttimeout 45; and against the
# accept-then-silent listener, with these options appended to a user command
# exactly as net_git appends them, a user ConnectTimeout of 3 cut the
# connection at 3.0s and one of 25 at 25.0s, the 10s set here applying only
# where the user set none. So the bound degrades to whatever bound the user
# asked for, and terminates only where that value does. Measured on the same
# listener: a user ConnectTimeout of 0 is accepted, wins by the same rule and
# left the call still connecting at 40s, where the 10s set here cut at 10.2s —
# unbounded, through the user's own config, which is the #92 hang again. The
# watchdog below is what now bounds that case, since it bounds the call rather
# than the transport and so does not depend on any value ssh resolved (#346).
# Ordering these first would bound the call at its own value instead,
# at the cost of silently overriding a deliberate proxy or timeout config: a
# real regression traded for a hypothetical one, so it is not done.
#
# The same rule makes BatchMode a user opt-out. A command carrying
# `-o BatchMode=no` keeps it and ssh goes back to asking, which
# GIT_TERMINAL_PROMPT=0 does not reach — that suppresses git's own credential
# prompt, not ssh's. Measured with GIT_TERMINAL_PROMPT=0 set throughout: with
# the BatchMode=yes set here alone, an unknown host key fails at once ("Host key
# verification failed"); with a user's BatchMode=no ahead of it and a terminal
# reachable, ssh sat on "Are you sure you want to continue connecting" until
# killed — the unattended hang #92 exists to stop. Reachable is the operative
# word: with no terminal available it aborts rather than waiting. Honoured
# anyway, because it is the user's explicit setting; this records what that
# costs rather than warning about a choice they made on purpose. The watchdog
# below is what now ends that wait, and it is the only thing here that can:
# the prompt is ssh's, so no git-side variable reaches it, and the setting that
# opens it is the user's own, so overriding it is not on offer either. No test
# covers this one — the exposure needs a reachable terminal, and the harness
# runs without one, where ssh aborts at once instead of asking (#346).
#
# http: lowSpeedLimit/lowSpeedTime is git's (curl's) own bound for a transfer
# that goes quiet — abort if it sits under 1000 bytes/s for 10s.
#
# It bounds a transfer already under way and nothing before one, so it is a
# weaker bound than the ssh side, not a counterpart to it. Measured against the
# same accept-then-silent listener: a plain http origin aborts at 10.0s
# ("Operation too slow"), but an https one never starts a transfer at all — the
# TLS handshake does not complete, so the timer never arms and the call outlived
# every cap put on it. Nothing here reaches the connect phase either, on either
# scheme: `git help config` lists lowSpeedLimit and lowSpeedTime as its whole
# http timing vocabulary, and `git config --get http.connectTimeout` finds no
# such key to read. What is left of connect is curl's own default, which this
# script does not set and cannot shorten.
#
# Hence the watchdog below, and hence these knobs are no longer the bound. They
# stay anyway, and that is a decision rather than an oversight (#346): each one
# fails earlier than the watchdog and in git's own words, which is the more
# useful thing to read on a terminal, and dropping them would make every ssh
# stall wait out the full budget where ConnectTimeout ends it in a fraction of
# that. Defence in depth costs nothing here — the watchdog does not care whether
# they fired, and neither reads the other's state.
# Backgrounded and waited on, rather than polled: `wait` returns the moment the
# call does, so a reachable origin pays nothing for the bound being here. The
# sleeper is what enforces it, and it is killed by the same subtree walk as the
# call — its own `sleep` is a child, and an orphaned sleeper does not sit
# harmlessly: it wakes at the end of its budget and fires net_kill_tree at a pid
# this shell no longer owns, which after a budget's worth of pid churn can be an
# unrelated process — and, since #346, an unrelated SUBTREE. It cannot leak onto
# the caller's stderr whatever else it does, because the `>/dev/null 2>&1` below
# is on the sleeper itself and both its descriptors are already closed.
#
# `wait` is captured through an explicit `|| net_status=$?`, and `set -e` is
# why: a bare `wait` on a killed child aborts at that line, which is after the
# call is dealt with but before the sleeper is, and the sleeper would be the
# leak. The status is then carried out by an explicit `exit` rather than by
# whatever the subshell happens to end with, and the function returns what the
# subshell exited with.
net_git() {
  # The whole body is a SUBSHELL, and that is not style. A caller who captures
  # stdout gets one for free from `$( )`; a caller who does not — the fetches,
  # which write to stderr and are read by their exit status — runs the body in
  # its own shell, and there the shell REPORTS the SLEEPER it reaped once the
  # caller runs on past the call: measured, `verify-sha.sh: line 77: 61980
  # Terminated: 15 { sleep …` landed on the script's stderr, between its own
  # trace line and its own result, on a completely healthy fetch. The notice is
  # the shell's, not the job's, so no redirection on the job can reach it; `( )`
  # is what covers it, by leaving the sleeper behind in a shell that exits
  # before it would announce anything. Bash-as-sh is the shell that prints it —
  # measured, dash announces no sleeper with the subshell or without it.
  #
  # That is the SLEEPER, and it is the whole of what `( )` buys. The git job is
  # a separate notice on a separate path: it is reaped by an explicit `wait`,
  # which announces a signalled child from INSIDE the subshell, onto the same
  # stderr. Measured on the watchdog-killed path, with the subshell and without
  # it alike, bash-as-sh printed `Terminated: 15  GIT_TERMINAL_PROMPT=0 …` and
  # dash a bare `Terminated: 15`, above the caller's own reason — and a caller
  # that CAPTURES stdout got it too, so there was never a path where nothing
  # printed it. The `2>/dev/null` on the `wait` below is what covers that one.
  (
  net_wdfile=$1
  net_budget_s=$2
  shift 2
  net_base_ssh=$(git config --get core.sshCommand 2>/dev/null || true)
  # GIT_SSH is a program PATH, not a command line, so it is quoted rather than
  # pasted raw: git runs GIT_SSH_COMMAND through a shell, which would otherwise
  # split a path containing spaces into a program and its arguments.
  [ -n "$net_base_ssh" ] || net_base_ssh="${GIT_SSH:+\"$GIT_SSH\"}"
  [ -n "$net_base_ssh" ] || net_base_ssh=ssh
  GIT_TERMINAL_PROMPT=0 \
  GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-$net_base_ssh} -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=2" \
  git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=10 "$@" &
  net_pid=$!
  { sleep "$net_budget_s"; printf 'fired ' >>"$net_wdfile" || :; net_kill_tree "$net_pid"; } >/dev/null 2>&1 &
  net_wd_pid=$!
  net_status=0
  wait "$net_pid" 2>/dev/null || net_status=$?
  net_kill_tree "$net_wd_pid"
  exit "$net_status"
  )
}
