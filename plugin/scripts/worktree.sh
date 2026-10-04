# shellcheck shell=sh
# Reading worktree state for the fleet's shell scripts: the porcelain listing,
# path predicates more than one script asks, and in-progress operation state.
# Sourced, never executed — no shebang, and the `shell=sh` directive above is
# what tells shellcheck what to check it as.
#
# Source it as:
#
#     wt_lib="$(dirname "$0")/worktree.sh"
#     [ -r "$wt_lib" ] || die "cannot read $wt_lib"
#     # shellcheck source-path=SCRIPTDIR
#     # shellcheck source=worktree.sh
#     . "$wt_lib" || die "$wt_lib failed to load"
#
# The `[ -r ]` is not belt-and-braces and the `|| die` alone is not enough. `.`
# is a POSIX *special builtin*, so failing to open its operand aborts a
# non-interactive shell outright and the `||` never runs. json.sh carries that
# measurement across five shells; it is the same builtin and the same trap here,
# and this file is sourced by the same scripts.
#
# Not folded into json.sh, which is scoped to JSON escaping: a filesystem
# predicate and a `git` reader are neither.

# The byte `wt_listing` substitutes for a newline found INSIDE a worktree path.
#
# \001 because the listing's own STRUCTURE cannot produce one, which is the
# property the swap actually needs: nothing git emits to hold the format
# together carries a control byte — the attribute keywords are fixed words, an
# object id is hex, and a ref name rejects them outright (`git check-ref-format`
# exits 1, `git branch` refuses). So a \001 reaching `$wt_list` is never part of
# the format, and can never be read as a delimiter or an attribute.
#
# That is the whole guarantee. Two things it deliberately does NOT claim, both
# load-bearing:
#
# It is not a claim that no byte anywhere in the listing can be a \001.
# `locked <reason>` carries free-form text the operator wrote, and git neither
# rejects nor sanitizes a control byte in it — measured, git 2.50.1: `git
# worktree lock --reason` accepts a \001 and the listing hands it straight back.
# Inert here, for reasons worth stating rather than assuming: a lock reason is
# never a path, no caller passes one to `nl_path`, and after the `tr` it sits on
# its own line that no `/^worktree /` or `/^branch /` matches. (`prunable`'s
# reason is git's own fixed prose, so it has no such hole.)
#
# And it is not a claim that a \001 in a PATH proves a newline was there. A path
# may hold one natively; `nl_path` says so, and says why refusing on both is the
# answer rather than guessing which it was. What the byte does establish is the
# only thing any caller needs: this is a path the reader cannot hand back to the
# filesystem byte for byte.
wt_nl=$(printf '\001')

# Does $1 carry the byte `wt_listing` substituted for a newline?
#
# The substitution is not injective: a path that really holds a \001 answers
# true here too. Deliberate, and it is why the answer is a refusal rather than a
# repair — both inputs are paths this reader cannot reproduce byte for byte, and
# refusing on both is correct where guessing which one it was is not.
nl_path() {
  case $1 in
    *"$wt_nl"*) return 0 ;;
  esac
  return 1
}

# Read the worktree listing into `$wt_list`, in a form where a newline inside a
# path cannot end a record. On success `$wt_err` is empty; on failure `$wt_list`
# is empty and `$wt_err` names the cause.
#
# A worktree path may legally contain a newline (APFS and ext4 both allow it),
# and the plain porcelain terminates every attribute with one — so one record
# split into two and every consumer's `substr($0,10)` truncated the path at the
# newline. Measured on a real linked worktree at `.../wt/fix-33<LF>slug`, git
# 2.50.1: three scripts each handed a downstream consumer a path not on disk,
# and none of them refused — the defect already fixed in inflight.sh.
#
# `--porcelain -z` terminates every attribute with NUL instead, which needs git
# 2.36.0 — a floor this repo already exceeds through no-undo-audit.sh's
# `git merge-tree --write-tree --name-only -z`.
#
# NOT `awk -v RS='\0'`. That is a gawk/BWK extension, and the awk this fleet
# actually runs on macOS — /usr/bin/awk, BWK awk 20200816 — does not merely
# ignore it: it stops dead at the first NUL and reports ONE record for a listing
# of any length. Measured, all three spellings, `-v RS='\0'`,
# `-v RS='\000'` and `BEGIN{RS="\0"}`, every one of them `count=1`. No awk
# program can hold a NUL byte either, so the swap has to happen before awk sees
# the stream at all.
#
# One `tr` pass does it, exactly as inflight.sh's probe 3 does: NUL becomes the
# newline every awk here already splits on, and a newline inside a path becomes
# `$wt_nl`. `tr` translates simultaneously from one table, so the two mappings
# cannot feed each other the way two piped stages would. Every existing
# `/^worktree /`, `/^branch /` and `substr($0,10)` reads the result unchanged,
# and git's own `\0\0` record separator arrives as the blank line the plain
# porcelain already emitted — so an ordinary path parses byte for byte as
# before.
#
# A temp file, and it is not incidental: `-z`'s separator is NUL and no shell
# variable can hold one, so the swap cannot happen inside a command
# substitution around git. It also keeps git's status readable on its own — a
# pipeline reports only its last stage, so `$(git … | tr …)` would report `tr`'s
# and a git that could not run at all would read as an empty listing, which is
# an answer several callers act on.
#
# `LC_ALL=C` on the `tr` rather than inherited: under a UTF-8 locale BSD `tr`
# exits 1 on a byte that is not valid UTF-8, and such a byte reaches a worktree
# path from any filesystem that does not police names. Every caller pins the
# locale globally already; a sourced helper does not get to assume that.
#
# `wt_list` and `wt_err` are this function's OUTPUT, read by the sourcing script
# and never again in here, which is what SC2034 sees when it checks this file on
# its own — `check-tracked.sh '*.sh' shellcheck -x -S warning` runs it standalone
# as well as through each caller.
# shellcheck disable=SC2034
wt_listing() {
  wt_list=
  wt_err=
  wt_tmp=$(mktemp) || {
    wt_err="could not create a temporary file to hold the worktree list"
    return 1
  }
  # `2>&1 >"$wt_tmp"` in that order: stderr is duplicated onto the substitution
  # FIRST, then stdout is pointed at the file. The substitution's status is
  # git's own, so a git that could not run is distinguishable from one that
  # produced a listing — and the cause is git's own prose rather than a guess.
  if ! wt_err=$(git worktree list --porcelain -z 2>&1 >"$wt_tmp"); then
    rm -f "$wt_tmp"
    [ -n "$wt_err" ] || wt_err="git worktree list failed"
    return 1
  fi
  if ! wt_list=$(LC_ALL=C tr '\n\000' '\001\n' <"$wt_tmp"); then
    rm -f "$wt_tmp"
    wt_list=
    wt_err="could not read the worktree list from $wt_tmp"
    return 1
  fi
  # git writes on stderr at rc 0 too, and that text is not a failure — clear it
  # so `[ -n "$wt_err" ]` never reads a warning as one.
  wt_err=
  rm -f "$wt_tmp"
  # Explicit, because `rm` would otherwise be the last command and hand its own
  # status to every caller: a temp file that could not be unlinked is a leak,
  # never a reason to tell a caller the listing failed to read.
  return 0
}

# Is $1 established ABSENT, or merely a path this script cannot stat? A bare
# `[ -e ]` failure is both — an unreadable parent (dropped mount, chmod'd
# ancestor) fails it identically to a directory that was actually removed — and
# only the second is nothing to protect. Walk up to the nearest ancestor that is
# there and require THAT to be searchable: only then is "not there" a
# measurement rather than a guess. The walk is what keeps `rm -rf .worktrees`
# answerable — the parent goes with the child, and testing the immediate parent
# alone reads its absence as unknown, which is the permanent refusal the callers
# exist to stop producing.
#
# `[ ! -L "$look" ]` in the loop condition, and it is the whole fix. Every
# `test` primary except `-L` STATS, so it follows a symlink: on a dangling one
# `-e` is false while `-L` is true, and the predicate answered established-absent
# for a path `git worktree add` treats as occupied. Measured — worktree-audit.sh
# reported such a path as `MISSING on disk` with `ahead=0, dirty=0`, which is
# what the fleet controller reads to decide whether a replacement member would
# redo work or destroy it. Same `-e`/lstat split claim-ticket.sh guards one
# layer up.
#
# In the LOOP condition rather than as a fourth clause on the result, because
# that placement answers a second shape for free: a dangling symlink standing in
# for an ANCESTOR. The walk stops on it, `[ -x ]` through it is false, and the
# answer is unknown — where a `[ ! -L "$1" ]` bolted onto the result would still
# have called `/dangling/child` established-absent. For $1 itself the walk never
# starts, `look` stays `$1`, and `[ -x "$1" ]` through the dangling link is
# false, so the existing result line needs no change at all.
#
# A dangling worktree link arrives by two routes with OPPOSITE claim states, and
# this predicate must hold under both: rc-0 residue behind a `git worktree
# remove` that deleted a symlink's target, with no live claim; and
# release-ticket.sh's rc-255 halt path, which leaves the link with the branch and
# the `in-progress` label still alive — a live claim, mid-release, that failed
# partway. "Not established-absent" is the only answer true of both.
#
# `look=${look:-/}` INSIDE the loop, and that placement is the whole fix:
# `${p%/*}` on `/x` yields the empty string, not `/`, so a path whose every
# ancestor below the root is gone used to fall out on "" and answer unknown about
# an absence the searchable root proves. The same restore written AFTER the loop
# reads identically and is wrong — nothing enters the loop on an empty `$1`, so
# it would rewrite that to `/` too and turn `gone ""` into established-absent.
# Inside, it only ever rewrites what the loop just truncated. The suite's direct
# test of `gone` holds that matrix, `gone ""` included, because no caller can
# reach it: the callers test the path non-empty first, and worktree-audit.sh
# reads its own off `git worktree list`, which never emits an empty one — so a
# caller-level suite alone cannot tell the two placements apart.
#
# `!=`, not a non-empty test: `${p%/*}` returns p unchanged when p holds no
# slash, so the emptiness form spins forever on one. git emits absolute paths to
# every caller, but a delete script may not hang on the input that proves
# otherwise.
#
# One definition, in one file, because every caller asks one question. Answered
# separately they drift, and the halves of this fleet that protect a member's
# work stop agreeing about whether there is any work there to protect — which is
# exactly what separate copies of it did: three, and only one compensating, at
# a call site rather than in the predicate.
#
# 0 ONLY for established absent; 1 covers present AND cannot-stat, so a caller
# needing those apart pairs this with its own `[ ! -e ]`, as release-ticket.sh's
# dirty check does. Condition context only: a bare `gone` returns 1 on the
# ordinary present answer and `set -e` exits.
#
# $1 must be absolute; a relative operand can answer 1 for a path that is
# genuinely absent.
gone() {
  # A path carrying the byte `wt_listing` substituted does not name the file git
  # named, so every `test` below asks about a DIFFERENT path — one that is
  # reliably not there, which is why the walk answered established-absent for it
  # and each caller then acted on that. Measured: release-ticket.sh emitted its
  # newline refusal and then a second blocker on the same path asserting the
  # directory "is gone" and naming `git worktree prune` as the remedy, for a
  # worktree on disk holding an uncommitted file and for which prune is a no-op
  # — the permanent-refusal shape the surrounding guards exist to prevent.
  # Refused in the predicate rather than at each call site for the reason the
  # rest of this comment gives: answered separately, the callers drift.
  nl_path "$1" && return 1
  look=$1
  while [ ! -e "$look" ] && [ ! -L "$look" ] && [ "$look" != "${look%/*}" ]; do
    look=${look%/*}
    look=${look:-/}
  done
  [ ! -e "$1" ] && [ -x "$look" ]
}

# Which git operation does the worktree at $1 have in progress, and which
# branch does that operation hold?
#
# Sets `wt_op` to the in-progress marker found in its admin dir (empty: none),
# and `wt_op_held` to the space-separated `refs/heads/<b>` a stopped rebase or
# bisect holds (empty: none). Returns 1 when the admin dir cannot be read —
# "cannot tell", never "nothing in progress" — and every caller fails closed on
# it. Condition context only, like `gone`.
#
# The in-progress markers are the states git records while an operation runs.
# Measured, git 2.50.1 (Apple Git-155): `git worktree remove` WITHOUT `--force`
# removes a worktree holding an interrupted rebase, and one holding a bisect, at
# exit 0 — both leave `git status --porcelain` empty, so the sequencer state,
# the todo list and the original head go with the directory. The remaining
# sequencer states leave staged or unmerged paths behind, so a dirty check
# already answers for them; they are listed anyway because a state git records
# is cheaper to test than to argue about.
#
# The held branch is the half `git worktree list --porcelain` cannot give.
# Only a rebase and a bisect DETACH HEAD, and a detached worktree's porcelain
# record carries `detached` instead of a `branch refs/heads/<b>` line — yet git
# still counts the branch as that worktree's: measured, git 2.50.1, `git branch
# -D` refuses "used by worktree" for a sibling stopped at a `rebase -i` edit
# step and for one mid-bisect, both listed `detached`. git answers out of the
# admin dir: `rebase-merge/head-name` or `rebase-apply/head-name` hold the full
# `refs/heads/<b>`, `BISECT_START` holds the SHORT name `<b>` the bisect started
# from. `MERGE_HEAD`, `CHERRY_PICK_HEAD` and `REVERT_HEAD` leave HEAD on its
# branch, so the porcelain `branch` line already names what they hold. A
# head-name of `detached HEAD` names no branch and is not collected. A bisect
# started from a detached HEAD is different: `BISECT_START` holds that HEAD's
# full SHA, which the code below still turns into `refs/heads/<sha>` and
# collects — matching only a branch literally named with that 40-hex string,
# which nothing in this fleet's naming ever produces.
#
# `2>/dev/null` on the admin-dir read, NOT the `2>&1` the fleet's message-text
# captures fold in, because this capture is used as a PATH. Measured: a
# `~/.gitconfig` with a key outside any section makes every git
# command print `error: key does not contain a section: …` to stderr AT EXIT 0,
# so `2>&1` returns that line glued in front of the git dir, every `[ -e ]`
# below then matches nothing, and a worktree holding an interrupted rebase reads
# as holding nothing at all.
#
# A rebase state dir that exists but cannot be searched is "cannot tell" too:
# `[ -e ]` on the `head-name` inside it fails exactly as it does on a head-name
# that is not there, and only the second is an answer.
#
# `wt_op` is this function's OUTPUT, read by the sourcing script; so is
# `wt_op_held`, read by `wt_holding` below and by worktree-audit.sh —
# SC2034, as for `wt_listing`.
#
# The admin dir is normally found by asking git FROM $1 (`rev-parse
# --absolute-git-dir`), which needs nothing but $1's own `.git` pointer file —
# so a worktree this reader cannot even enter (a bare permission bit on $1
# itself) answers "cannot read" exactly as intended: nothing about $1 being
# unreadable says anything about whether its admin dir agrees, and this
# function must not go looking behind that refusal. Pass a non-empty $2 only
# when the CALLER has independently established $1 does not exist AT ALL —
# `[ -e "$1" ]`, never git's own `prunable`: measured, git 2.50.1, a worktree
# chmod 000'd (still there, merely unreadable) is marked `prunable` in the
# porcelain too, identically to one `rm -rf`'d out from under git, so
# `prunable` cannot tell the two apart and a reader keyed on it would reopen
# the chmod-000 case this function must keep closed. Only once $1 is
# confirmed gone does this function look for the admin dir a different way:
# `worktrees/*/gitdir` under THIS repo's own git dir names every admin dir by
# the worktree path it was registered for, and that registry lives under this
# repo's `.git`, never under the worktree — a directory `rm -rf`'d out from
# under git leaves its bookkeeping, and whatever rebase or bisect state it
# held, untouched.
# shellcheck disable=SC2034
wt_op_state() {
  wt_op=
  wt_op_held=
  if [ -n "${2:-}" ]; then
    wt_op_dir=
    wt_op_common=$(git rev-parse --git-common-dir 2>/dev/null) || return 1
    for wt_op_gitdir in "$wt_op_common"/worktrees/*/gitdir; do
      [ -e "$wt_op_gitdir" ] || continue
      wt_op_reg=$(cat "$wt_op_gitdir" 2>/dev/null) || continue
      [ "$wt_op_reg" = "$1/.git" ] || continue
      wt_op_dir=${wt_op_gitdir%/gitdir}
      break
    done
    [ -n "$wt_op_dir" ] || return 1
  else
    wt_op_dir=$(git -C "$1" rev-parse --absolute-git-dir 2>/dev/null) || return 1
    [ -n "$wt_op_dir" ] || return 1
  fi
  for wt_op_m in rebase-merge rebase-apply MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD BISECT_LOG; do
    if [ -e "$wt_op_dir/$wt_op_m" ]; then wt_op=$wt_op_m; fi
  done
  for wt_op_m in rebase-merge rebase-apply; do
    if [ -d "$wt_op_dir/$wt_op_m" ] && [ ! -x "$wt_op_dir/$wt_op_m" ]; then return 1; fi
  done
  for wt_op_f in rebase-merge/head-name rebase-apply/head-name BISECT_START; do
    [ -e "$wt_op_dir/$wt_op_f" ] || continue
    wt_op_ref=$(cat "$wt_op_dir/$wt_op_f") || return 1
    case $wt_op_f in BISECT_START) wt_op_ref=refs/heads/$wt_op_ref ;; esac
    case $wt_op_ref in
      refs/heads/?*) wt_op_held="${wt_op_held:+$wt_op_held }$wt_op_ref" ;;
    esac
  done
  return 0
}

# Which registered worktree holds branch ref $1 (`refs/heads/<b>`), by either
# route git itself counts: checked out, per its porcelain `branch` line, or held
# by a rebase or bisect stopped in a detached worktree, per `wt_op_state`. Reads
# `$wt_list` as `wt_listing` last left it, so a caller wanting a fresh answer
# re-reads the listing first.
#
# 0: held — `wt_holder` names the worktree and `wt_holder_how` the route, as a
#    clause (`is checked out`, …) to follow the branch name in a message.
# 1: no worktree holds it.
# 2: cannot tell — `wt_holder` names a worktree whose record this reader
#    cannot resolve even through `wt_op_state`'s registry route: its listed
#    path cannot be handed back to git (`nl_path`), or its admin dir cannot be
#    found or read there either.
#
# Detached records only go to `wt_op_state`, deliberately: a worktree whose
# record carries a `branch` line is answered by that line, and an unreadable
# one of those holds nothing a stopped rebase or bisect could add — so it is
# never allowed to turn into a "cannot tell" that halts every caller.
#
# A worktree `rm -rf`'d out from under git keeps its detached record — git
# marks it `prunable` — and keeps its admin dir, which lives under THIS
# repo's `.git`, never under the worktree itself. `[ -e ]` on the listed path,
# not git's own `prunable` (measured: a merely chmod-000'd worktree, still
# there, is marked `prunable` too — the two are not the same fault), is what
# tells `wt_op_state` it may look for that admin dir a different way; the
# ordinary route — asking git FROM the worktree's own directory — cannot,
# because there is no directory left to ask from.
#
# A record naming neither a `branch` nor the literal `detached` line is a HEAD
# git itself could not classify from the worktree's own directory — measured,
# git 2.50.1: an admin `HEAD` file holding garbage (not a ref, not a SHA)
# emits neither line, exactly the shape a corrupted mid-rebase HEAD produces.
# That corruption is confined to the `HEAD` FILE's bytes; the admin dir
# holding it, and whatever `rebase-merge`/`BISECT_START` state sits beside it,
# is untouched — so this case resolves through the SAME registry route as a
# gone worktree, unconditionally, rather than answering "cannot tell" for a
# worktree that may hold nothing of this caller's at all. Only once even that
# route cannot read an admin dir does this fall back to "cannot tell".
#
# Each record is read whole before it is judged — `branch`, `detached`, and
# the boundary that ends it — never decided line by line, because a record's
# `branch` line can arrive for ANY branch, not just $1, and only the full
# absence of both `branch` and `detached` means the record itself could not
# be classified. A record is settled at the next `worktree` line, or after
# the loop for the last one, since the trailing blank line `wt_listing`'s
# `$(...)` capture strips is not there to trigger it.
#
# A plain line loop, no awk: the listing's records are one attribute per line
# and `wt_listing` has already swapped any newline inside a path for `$wt_nl`,
# so `read -r` sees one attribute at a time. The heredoc keeps the loop in this
# shell, so its `return` answers for the function.
#
# Condition context only: 1 and 2 would exit a `set -e` caller.
# shellcheck disable=SC2034
wt_holding() {
  wt_holder=
  wt_holder_how=
  wt_h_path=
  wt_h_branch=
  wt_h_detached=
  wt_h_seen=
  while IFS= read -r wt_h_line; do
    case $wt_h_line in
      "worktree "*)
        if [ -n "$wt_h_seen" ]; then
          wt_h_settle "$1"; wt_h_rc=$?
          [ "$wt_h_rc" -eq 1 ] || return "$wt_h_rc"
        fi
        wt_h_path=${wt_h_line#worktree }
        wt_h_branch=
        wt_h_detached=
        wt_h_seen=1
        ;;
      "branch $1") wt_h_branch=$1 ;;
      "branch "*) wt_h_branch=${wt_h_line#branch } ;;
      detached) wt_h_detached=1 ;;
    esac
  done <<EOF
$wt_list
EOF
  if [ -n "$wt_h_seen" ]; then
    wt_h_settle "$1"; wt_h_rc=$?
    [ "$wt_h_rc" -eq 1 ] || return "$wt_h_rc"
  fi
  return 1
}

# Shared tail for `wt_h_settle`'s `detached` and unclassified-HEAD arms:
# resolve `$wt_h_path`'s in-progress state — passing $2 through as
# `wt_op_state`'s registry-route flag — and report whether it holds branch
# ref $1. Returns 0/1/2 exactly as `wt_h_settle` does, and sets
# `wt_holder`/`wt_holder_how` the same way.
# shellcheck disable=SC2034
wt_h_check_op() {
  if nl_path "$wt_h_path" || ! wt_op_state "$wt_h_path" "${2:-}"; then
    wt_holder=$wt_h_path
    return 2
  fi
  case " $wt_op_held " in
    *" $1 "*)
      wt_holder=$wt_h_path
      wt_holder_how="is held by a rebase or bisect in progress"
      return 0
      ;;
  esac
  return 1
}

# Decide whether the worktree record `wt_holding` just finished reading
# (`$wt_h_path`, `$wt_h_branch`, `$wt_h_detached`) holds branch ref $1.
# Returns 0 (held — sets `wt_holder`/`wt_holder_how`), 1 (this record does not
# hold it, keep reading) or 2 (cannot tell — sets `wt_holder`). Never called
# with `$wt_h_path` empty. Split out of `wt_holding` so a record can be
# settled from two call sites (mid-loop, and after it for the last record)
# without duplicating the decision.
# shellcheck disable=SC2034
wt_h_settle() {
  if [ -n "$wt_h_branch" ]; then
    [ "$wt_h_branch" = "$1" ] || return 1
    wt_holder=$wt_h_path
    wt_holder_how="is checked out"
    return 0
  fi
  if [ -n "$wt_h_detached" ]; then
    wt_h_gone=
    [ -e "$wt_h_path" ] || wt_h_gone=1
    wt_h_check_op "$1" "$wt_h_gone"
    return $?
  fi
  # Neither a `branch` line nor the literal `detached` line: git could not
  # classify this record's HEAD from the worktree's own directory at all (a
  # corrupted admin HEAD is that shape, measured) — go straight to the
  # registry route, unconditionally, since the ordinary one already failed by
  # definition of being here.
  wt_h_check_op "$1" 1
  return $?
}

# How many times `wt_recheck_delete` re-reads a listing that still shows a
# `git worktree add` in progress, 0.1s apart, before it stops waiting.
wt_init_waits=20

# After `git update-ref -d` has deleted branch ref $1 (`refs/heads/<b>`) at
# tip $2: did a `git worktree add` check that branch out while the delete
# ran? If so, or if that cannot be ruled out, put the ref back at $2.
#
# The holder check before a delete and the delete itself are two git calls,
# and git has no lock that stops a `worktree add` of an existing branch
# between them. Measured, git 2.50.1: such an add writes only the new
# worktree's `HEAD` symref and never touches `refs/heads/<b>`, so the
# compare-and-swap still succeeds and the new worktree is left on a branch
# that no longer exists — `HEAD` unresolvable, and listed with a `branch` line
# forever, so nothing that reads the listing later sees a stray. Once the ref
# is gone a new add fails on `invalid reference`, so only an add that
# resolved the branch before the delete can land this way, and this re-read
# after the delete sees it.
#
# While an add runs, git lists its worktree `detached` and `locked
# initializing`, with no `branch` line. Measured, git 2.50.1: while the add has
# resolved the branch but not yet written the worktree's `HEAD`, `wt_holding`
# answers "cannot tell" (the admin dir has no `HEAD` yet), so a check made
# then would restore the ref under rc 3 with a reason that names no holder.
# So the listing is re-read while any such entry is listed, up to
# `wt_init_waits` times, until the add settles and `wt_holding` can name it; a
# wait that runs out, or a `sleep` that fails, restores the ref.
# `wt_holding` itself has no rule for a `locked initializing` entry: every
# concurrent `claim-ticket.sh` add is listed that way while it runs, and
# reading all of them as "cannot tell" would halt deletes under ordinary fleet
# churn.
#
# The restore is create-only — the null id as the old value — so it never
# overwrites a ref someone else created since. Measured, git 2.50.1: it fully
# heals a worktree whose add finished before the delete (`HEAD` resolves,
# status clean). The branch's reflog does not come back.
#
# 0: no worktree holds the branch; the delete stands.
# 1: a worktree held it — `wt_holder`/`wt_holder_how` as `wt_holding` sets
#    them — and the ref is restored.
# 2: the restore failed — `wt_err` carries git's message. `wt_restore_out` says
#    what state the branch is left in, as a clause to follow the failed
#    restore in a message: deleted, with `wt_repair` the command that restores
#    the ref by hand, or recreated by something else since the delete, in
#    which case `wt_now` is the commit it resolves to and nothing was
#    overwritten. `wt_now` is empty when the branch is deleted.
# 3: no holder could be ruled out — an add still in progress when the wait
#    ran out (`wt_holder` names that entry), a holder check that could not
#    tell, or a listing that would not re-read — and the ref is restored.
# On 1, 2 and 3, `wt_restore_why` says why, as a clause to follow the branch
# name in a message.
#
# Condition context only, like `wt_holding`.
# shellcheck disable=SC2034
wt_recheck_delete() {
  wt_restore_why=
  wt_restore_out=
  wt_now=
  wt_rd_waits=0
  while :; do
    if ! wt_listing; then
      wt_holder=
      wt_restore_why="could not be checked against the worktree list after the delete: $(printf '%s' "$wt_err" | tr '\n' ' ')"
      wt_rd_rc=3
      break
    fi
    wt_rd_path=
    wt_rd_init=
    while IFS= read -r wt_rd_line; do
      case $wt_rd_line in
        "worktree "*) wt_rd_path=${wt_rd_line#worktree } ;;
        "locked initializing") wt_rd_init=$wt_rd_path ;;
      esac
    done <<EOF
$wt_list
EOF
    if [ -z "$wt_rd_init" ]; then
      if wt_holding "$1"; then wt_rd_held=0; else wt_rd_held=$?; fi
      case $wt_rd_held in
        0)
          wt_restore_why="was ${wt_holder_how#is } in worktree $wt_holder during the delete"
          wt_rd_rc=1
          ;;
        1) return 0 ;;
        *)
          wt_restore_why="could not be checked against worktree $wt_holder after the delete"
          wt_rd_rc=3
          ;;
      esac
      break
    fi
    if [ "$wt_rd_waits" -ge "$wt_init_waits" ]; then
      wt_holder=$wt_rd_init
      wt_restore_why="could not be checked after the delete: worktree $wt_rd_init was still being added (locked initializing) when the wait ran out"
      wt_rd_rc=3
      break
    fi
    if ! sleep 0.1; then
      wt_holder=$wt_rd_init
      wt_restore_why="could not be checked after the delete: could not wait for worktree $wt_rd_init to finish being added (locked initializing)"
      wt_rd_rc=3
      break
    fi
    wt_rd_waits=$((wt_rd_waits + 1))
  done
  # The null id as long as the tip itself, so a SHA-256 repository gets its
  # own width.
  wt_rd_null=
  wt_rd_t=$2
  while [ -n "$wt_rd_t" ]; do
    wt_rd_null=${wt_rd_null}0
    wt_rd_t=${wt_rd_t#?}
  done
  wt_repair="git update-ref $1 $2 $wt_rd_null"
  if ! wt_err=$(git update-ref "$1" "$2" "$wt_rd_null" 2>&1); then
    [ -n "$wt_err" ] || wt_err="git update-ref failed"
    if wt_now=$(git rev-parse -q --verify "$1" 2>/dev/null); then
      wt_restore_out="the branch now exists at $wt_now, recreated by something else and left as it is"
    else
      wt_now=
      wt_restore_out="the branch is deleted, restore it with: $wt_repair"
    fi
    return 2
  fi
  wt_err=
  return "$wt_rd_rc"
}
