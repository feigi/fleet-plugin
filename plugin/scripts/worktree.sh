# shellcheck shell=sh
# Reading worktree state for the fleet's shell scripts: the porcelain listing,
# path predicates more than one script asks, in-progress operation state, and
# the Registration probe — the verdicts every script that deletes a worktree or
# a branch, or reads an absence as "free", asks git before it acts.
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
# A carriage return, which git drops from the end of a `.git` pointer.
wt_cret=$(printf '\r')

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

# ---------------------------------------------------------------------------
# The Registration probe: every verdict a script asks of git about a worktree
# before it deletes one, a branch, or reads an absence as "free". One
# definition per verdict, so a fix lands once and reaches every caller.
#
# Contract shared by every function below. Each returns a status and writes
# named output variables; none prints, none exits, and none decides what a
# refusal means — the caller maps it onto its own reporting shape (keep a
# branch, die, block, record an unknown). A refusal's reason is prose in
# `$wt_why`, written to stand in a receipt field verbatim; each function
# clears `$wt_why` on entry, so it is empty after every answer that is not a
# refusal. Condition context only, like `gone`: a non-zero return exits a
# `set -e` caller.
#
# The outputs are read by the sourcing script and never again in here, which
# is what SC2034 sees on this file's standalone shellcheck run — the
# disables below, as for `wt_listing`.
# ---------------------------------------------------------------------------

# Is anything at all occupying $1? Not the same question as `gone`, which asks
# whether an absence is established; this one asks whether the path is taken.
# `-e` alone FOLLOWS symlinks, so a DANGLING one reads as absent while it still
# occupies the path and still fails the next `git worktree add` (`fatal: '...'
# already exists`) — and that is residue a removal can leave: where a symlink
# POINTS AT the registered worktree directory, `git worktree remove` deletes
# that directory and returns 0, leaving the link behind and now dangling (git
# 2.50.1).
wt_occupied() { [ -e "$1" ] || [ -L "$1" ]; }

# Resolve the worktree registry, `<git-common-dir>/worktrees`, into `$wt_root`
# once per run — the git dir does not move under a running script. 1 with
# `$wt_why` when git cannot name the common directory.
#
# `2>/dev/null`, never `2>&1`, on the capture that answers: it is used as a
# PATH, and a `~/.gitconfig` with a key outside any section makes every git
# command print `error: key does not contain a section: …` on stderr AT EXIT
# 0, which `2>&1` would glue in front of it. Git's own words are fetched with
# a second call, only on the path that refuses, and there stdout is discarded
# so `2>&1` has no path to glue onto.
wt_root=
# shellcheck disable=SC2034
wt_registry_root() {
  wt_why=
  [ -z "$wt_root" ] || return 0
  if ! wt_rr_common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null); then
    wt_rr_err=$(git rev-parse --path-format=absolute --git-common-dir 2>&1 >/dev/null) || :
    wt_rr_err=$(printf '%s' "$wt_rr_err" | tr '\n' ' ') || wt_rr_err=
    wt_why="cannot resolve the git common directory${wt_rr_err:+: $wt_rr_err}"
    return 1
  fi
  wt_root="$wt_rr_common/worktrees"
}

# Count the registry entries on disk into `$wt_registered`.
#
# `worktree list --porcelain` reads `<git-common-dir>/worktrees`, the admin
# directory git writes one subdir per linked worktree into. When that
# directory — or any file git needs inside one of its entries — cannot be read,
# git does not error: it silently drops the affected entries and still exits 0
# (git 2.50.1). Predicting which reads git needs is one level too shallow:
# `chmod 000` on the `gitdir` FILE inside an entry passes every permission test
# a script could make on the entry itself and still drops the worktree from the
# listing — measured. So count instead: one registry entry on disk per linked
# worktree, against what git reported.
#
# Absent entirely answers nothing here: a repo whose worktrees were removed and
# pruned (or never existed) has no `worktrees` dir, and zero entries against
# the main worktree alone is a match. A registry or entry removed OUTRIGHT
# under a live worktree drops both counts in step, so they agree over it too;
# `wt_count_pointers` is what refuses that. Present but unreadable is a refusal, and
# not redundant with the count: unreadable, the glob below expands to nothing,
# and zero-on-disk would AGREE with the empty listing git returns for the same
# reason. `-d` joins `-r` and `-x` there because a registry replaced by a
# mode-755 FILE passes both, globs to nothing, counts 0 against git's 0, and
# agrees.
#
# A registry entry is a directory; anything else in here is not git's. And an
# EMPTY directory is skipped: that is an operator's stray `mkdir`, which git
# ignores — counting one refuses every pass in the repo, forever (measured, git
# 2.50.1: git lists 2 worktrees where a bare `-d` count said 2 registered
# against 1 linked). Emptiness, NOT the absence of a `gitdir` file: git drops
# an entry whose `gitdir` was deleted, so keying the skip on that file lets the
# entry through as "not git's" and the counts agree over a checkout that may
# still be on disk (measured: listed 1 → linked 0, and a gitdir-keyed count
# returns 0 to match). A corrupt entry still holds git's own files —
# commondir, HEAD, index, logs, refs — so emptiness separates it from a stray.
#
# `ls`'s STATUS, not just its output: an entry that could not be LISTED is not
# an empty one, and `2>/dev/null` hides the difference. A stray `mkdir` lists
# empty at rc 0; an entry chmod'd 000 or 0111 fails EACCES and prints nothing
# just the same. Reading only the output skips that entry — and git drops it
# too, so the counts AGREE over a member's uncommitted work (measured, against
# release-ticket.sh: exit 0, `released:true`, branch deleted). Could not read
# it, so it is counted, and the mismatch refuses.
# shellcheck disable=SC2034
wt_count_registry() {
  wt_registered=0
  wt_registry_root || return 1
  [ -e "$wt_root" ] || return 0
  [ -d "$wt_root" ] && [ -r "$wt_root" ] && [ -x "$wt_root" ] || {
    wt_why="worktree registry $wt_root could not be read"
    return 1
  }
  for wt_cr_entry in "$wt_root"/*; do
    [ -d "$wt_cr_entry" ] || continue
    if wt_cr_ls=$(ls -A "$wt_cr_entry" 2>/dev/null) && [ -z "$wt_cr_ls" ]; then continue; fi
    wt_registered=$((wt_registered + 1))
  done
  return 0
}

# Count the linked worktrees in `$wt_list` as it stands into `$wt_linked`.
#
# awk, not `grep -c … || true`: `grep -c` exits 1 on zero matches, and the
# `|| true` that absorbs it absorbs a grep that could not RUN just as happily,
# leaving the count empty and `$((listed - 1))` at -1. This program holds no
# `exit`, so its status is the counter's own. The main worktree is always
# listed first and has no registry entry of its own, hence the -1 — and the
# `-ge 1` floor, because a listing with no main checkout at all comes only
# from a broken or shimmed git and reads as -1 linked otherwise. A newline
# inside a path never moves this count: `wt_listing` has already swapped it,
# so every record contributes exactly one `worktree ` line.
# shellcheck disable=SC2034
wt_count_linked() {
  if ! wt_cl_n=$(printf '%s\n' "$wt_list" | LC_ALL=C awk '/^worktree /{c++} END{print c+0}'); then
    wt_why="could not count the worktrees git listed"
    return 1
  fi
  if [ "$wt_cl_n" -lt 1 ]; then
    wt_why="git listed no worktrees at all — not even the main checkout, so the listing cannot be trusted"
    return 1
  fi
  wt_linked=$((wt_cl_n - 1))
}

# One count pair: the registry first, then a fresh listing, then its count.
# 0 counted (agreeing or not), 1 a count refused (`$wt_why`), 2 the listing
# could not be read (`$wt_why` carries `$wt_err`).
wt_count_pair() {
  wt_count_registry || return 1
  if ! wt_listing; then
    wt_why=$(printf '%s' "$wt_err" | tr '\n' ' ')
    return 2
  fi
  wt_count_linked || return 1
}

# Is any fleet worktree standing with its registration removed under it? 0
# when none is; 1 with `$wt_why` naming the first `.worktrees/*` pointer git
# does not list that names an admin dir the registry does not hold, or that
# could not be read. Reads `$wt_list` for the main checkout and the listed
# paths, and `$wt_root` for the registry, both as `wt_count_pair` left them.
#
# The counts cannot see this: git lists a linked worktree only from its admin
# dir, so a registry `rm -rf`'d whole, or one entry removed, drops the entry
# from the registry count AND the listing in step. They agree, the worktree's
# branch reads as held by nothing, and `git branch -D` deletes it too — git's
# own "used by worktree" refusal reads the same admin state (measured, git
# 2.50.1, for both shapes and for an entry emptied to a bare directory, which
# the registry count skips and git ignores). Nothing in the registry names the
# orphan any more, so the cross-check reads the other end of the link: the
# `.git` file in each `.worktrees/*` directory, the layout claim-ticket.sh
# creates every fleet worktree in.
#
# A directory git LISTS is skipped first: its admin dir exists, since that is
# where git read it from, so its branch is already held in the listing, and
# whatever else is wrong with it is the caller's per-worktree guards' to
# answer. Its path is matched byte for byte against the listing's, under the
# main checkout path the listing itself spells. Of the rest, only a pointer
# into THIS registry is answered for: its admin dir's parent is named
# `worktrees` and sits in the same directory (`-ef`) as `$wt_root`'s. Anything
# else under `.worktrees/` — a directory with no `.git`, a `.git` DIRECTORY (a
# clone, not a linked worktree), a pointer into another repo — is not a linked
# worktree of this repo and is skipped. A pointer is read the way git reads it
# (git 2.50.1): `gitdir: <path>` on its first line, a trailing CR dropped, a
# relative path resolved against the worktree directory. An unlisted
# directory, pointer or named admin dir that cannot be read is a refusal: what
# it names is unknown, and unknown is never "registered".
#
# Ceilings, left open on purpose. A `.worktrees` directory that cannot be
# listed is skipped, not refused: every worktree in it that git still lists is
# answered by the caller's own guards, each with its own remedy, and an
# unlisted one behind it needs that fault and a removed registry entry at once.
# And only `.worktrees/*` itself is read, the depth claim-ticket.sh creates
# worktrees at: one nested deeper (`.worktrees/feature/x`) is not, since
# reaching it means walking every directory under `.worktrees/` that holds no
# `.git` — operators' scratch trees included — on every count.
# shellcheck disable=SC2034
wt_count_pointers() {
  wt_cp_main=${wt_list%%"
"*}
  case $wt_cp_main in
    "worktree "?*) wt_cp_main=${wt_cp_main#worktree } ;;
    *)
      wt_why="git's listing does not open with the main checkout's path"
      return 1
      ;;
  esac
  if nl_path "$wt_cp_main"; then
    wt_why="the main checkout's path carries a newline, so its .worktrees directory cannot be named"
    return 1
  fi
  wt_cp_dir=$wt_cp_main/.worktrees
  [ -d "$wt_cp_dir" ] && [ -r "$wt_cp_dir" ] && [ -x "$wt_cp_dir" ] || return 0
  for wt_cp_wt in "$wt_cp_dir"/*; do
    [ -d "$wt_cp_wt" ] || continue
    case "
$wt_list
" in
      *"
worktree $wt_cp_wt
"*) continue ;;
    esac
    [ -x "$wt_cp_wt" ] || {
      wt_why="worktree directory $wt_cp_wt is not in git's listing and could not be searched, so whether it has lost its registration is unknown"
      return 1
    }
    wt_cp_ptr=$wt_cp_wt/.git
    [ -f "$wt_cp_ptr" ] || continue
    wt_cp_line=
    # `|| :` because a last line with no newline fails `read` with the line read.
    if ! [ -r "$wt_cp_ptr" ] || ! { IFS= read -r wt_cp_line || :; } 2>/dev/null <"$wt_cp_ptr"; then
      wt_why="worktree pointer $wt_cp_ptr could not be read, and git does not list its worktree, so whether its admin dir is registered is unknown"
      return 1
    fi
    wt_cp_line=${wt_cp_line%"$wt_cret"}
    case $wt_cp_line in
      "gitdir: "?*) wt_cp_admin=${wt_cp_line#gitdir: } ;;
      *)
        wt_why="worktree pointer $wt_cp_ptr names no admin dir (no gitdir: line), and git does not list its worktree, so whether it is registered is unknown"
        return 1
        ;;
    esac
    case $wt_cp_admin in
      /*) ;;
      *) wt_cp_admin=$wt_cp_wt/$wt_cp_admin ;;
    esac
    while :; do
      case $wt_cp_admin in
        ?*/) wt_cp_admin=${wt_cp_admin%/} ;;
        *) break ;;
      esac
    done
    wt_cp_reg=${wt_cp_admin%/*}
    [ "${wt_cp_reg##*/}" = worktrees ] || continue
    # shellcheck disable=SC3013,SC2319 # -ef as in wt_linkage; the else's $? is the `[ -ef ]` test's own rc, read before anything else runs, to fail closed on rc>=2
    if [ "${wt_cp_reg%/*}/" -ef "${wt_root%/*}/" ]; then :; else
      wt_cp_rc=$?
      [ "$wt_cp_rc" -ge 2 ] || continue
      wt_why="could not compare the repo $wt_cp_ptr points into with ${wt_root%/*} (test -ef exited $wt_cp_rc), so whether it names this registry is unknown"
      return 1
    fi
    if ! [ -d "$wt_cp_admin" ]; then
      wt_why="worktree pointer $wt_cp_ptr names admin dir $wt_cp_admin, which is missing from the worktree registry $wt_root — git lists no worktree there, so no absence it reports can be trusted; inspect the directory and, once its work is saved, remove it by hand"
      return 1
    fi
    # `ls`'s STATUS, not just its output: an admin dir that cannot be listed is
    # not an empty one, and `2>/dev/null` alone reads both as "nothing to say".
    if ! wt_cp_ls=$(ls -A "$wt_cp_admin" 2>/dev/null); then
      wt_why="worktree pointer $wt_cp_ptr names admin dir $wt_cp_admin, which could not be listed, and git does not list its worktree, so whether it is registered is unknown"
      return 1
    elif [ -z "$wt_cp_ls" ]; then
      wt_why="worktree pointer $wt_cp_ptr names admin dir $wt_cp_admin, an empty directory git does not list — git lists no worktree there, so no absence it reports can be trusted; inspect the directory and, once its work is saved, remove it by hand"
      return 1
    fi
  done
  return 0
}

# Is the listing COMPLETE — does git list exactly as many linked worktrees as
# the registry holds entries? A listing that silently dropped an entry hands
# every lookup over it "no worktree" for a branch a live worktree holds, at
# rc 0, so its absences cannot be trusted until this agrees.
#
# Reads the listing itself, through `wt_listing`, and leaves it in `$wt_list`:
# the caller's lookups then scan the very listing the counts validated. Sets
# `$wt_registered`, `$wt_linked` and `$wt_root`.
#
# 0: the counts agree, and every fleet worktree's pointer names a registered
#    admin dir.
# 1: refused — `$wt_why` names the cause: the common directory or the
#    registry could not be read, the listing could not be counted, the
#    counts still disagree, or a `.worktrees/*` pointer names an admin dir the
#    registry does not hold (`wt_count_pointers`). A standing disagreement is
#    named by the DIRECTION observed. FEWER listed than registered is git
#    dropping an entry it could not read — the fault this check exists to
#    catch. MORE listed than registered is the reverse, the registry read
#    missing entries, which under a parallel fleet is a sibling's `git
#    worktree add` landing between the two reads. One message cannot serve
#    both: they send the reader to opposite places.
# 2: the listing itself could not be read — `$wt_why` is `wt_listing`'s cause,
#    flattened to one line, and `$wt_err` holds it as read.
#
# Recount before refusing. The registry scan and git's listing are two reads
# at two instants, not one atomic read, and a sibling agent's `git worktree
# add` or `remove` landing in the gap makes them disagree with nothing wrong —
# measured on the per-script copy of this recount that release-ticket.sh once
# held: 3/100 dry-run releases aborted on the cross-check under a throttled
# churner, 48-66/80 unthrottled, all with zero real faults. A mismatch
# therefore re-takes BOTH counts, in the same order — registry first, listing
# second. Re-taking the registry alone leaves the linked count pinned to the
# first listing, and a second mutation landing after that listing inflates the
# registry count and flips which direction is reported (measured on the copy
# inflight.sh once held). A mutation landing between a pair's registry count
# and its listing is already reflected in that listing, so a re-taken pair
# needs a mutation inside its own narrower window to escape (measured on that
# inflight.sh copy while it re-took the registry alone: 1.99% -> 0.00% at 2
# mutations/s, 56.6% -> 1.29% saturated).
#
# That window is still a gap between two reads, so a further mutation inside a
# re-taken pair escapes it the same way; closing that for good would need an
# atomic snapshot of registry and listing together, which git does not offer.
# Each extra pass demands one more precisely-timed mutation to defeat, while a
# genuinely dropped entry is a standing state that survives every pass — so
# the re-take is bounded at two passes (`wt_counts_passes`) rather than chased.
# A false refusal costs one wait; a guessed agreement costs a deletion.
wt_counts_passes=2
# shellcheck disable=SC2034
wt_counts() {
  wt_why=
  wt_count_pair || return $?
  wt_ct_left=$wt_counts_passes
  while [ "$wt_linked" -ne "$wt_registered" ] && [ "$wt_ct_left" -gt 0 ]; do
    wt_count_pair || return $?
    wt_ct_left=$((wt_ct_left - 1))
  done
  if [ "$wt_linked" -lt "$wt_registered" ]; then
    wt_why="git listed $wt_linked worktrees for $wt_registered registry entries in $wt_root — the listing is incomplete, so no absence it reports can be trusted"
    return 1
  elif [ "$wt_linked" -gt "$wt_registered" ]; then
    wt_why="git listed $wt_linked worktrees but only $wt_registered registry entries were counted in $wt_root — the registry read missed entries git can see, so no absence it reports can be trusted"
    return 1
  fi
  wt_count_pointers
}

# Does $1's `.git` linkage answer for $1 itself? 0 when it does; 1 with
# `$wt_why` when git cannot answer through it, when it answers for another
# directory, when $1 is itself a symlink, or when `[` cannot evaluate the
# compare. Call it once the caller has established the linkage EXISTS (a
# regular `$1/.git` file), and before any git command run through $1 is
# believed — the dirty check first among them.
#
# Existing is not answering. Two shapes keep `.git` a well-formed regular file
# and move git's WORKING TREE elsewhere: a `.git` naming a foreign git dir not
# called `.git` whose `core.worktree` is another directory, and `core.worktree`
# set in the worktree's own `config.worktree` under `extensions.worktreeConfig`,
# `.git` untouched. `git -C "$1" status` then reads THAT tree, so a clean one
# there reads clean over the work sitting in $1 (measured on both shapes, git
# 2.50.1). `--show-toplevel` names the tree git actually answers for, so it is
# compared against $1.
#
# Compared as a DIRECTORY (`-ef`, same device and inode), never as a string:
# $1 is the path `worktree list --porcelain` echoes and `--show-toplevel` is
# git's own resolved spelling, and the two legitimately differ for one and the
# same directory. A parent that was a plain directory at `worktree add` time
# and is a symlink now leaves the listed path non-canonical while git's answer
# is resolved (measured). And a worktree whose name is Unicode NFD-composed
# (`cafe` + U+0301) is listed PRECOMPOSED by the `core.precomposeunicode` git
# writes into every new repo on macOS, while `--show-toplevel` answers the
# on-disk NFD bytes — visually identical, byte-different, one directory
# (measured, git 2.50.1, Apple Git-155). `cd && pwd -P` canonicalises only
# the first: it echoes the spelling it was given, so a byte compare against it
# refused every healthy NFD worktree. `-ef` answers "same directory" for both
# and for any other spelling the filesystem aliases, and still refuses every
# redirect — each names a different directory. POSIX.1-2017's `test` does not
# define `-ef`; it is a ksh-derived extension bash, dash and BSD sh share, and
# POSIX.1-2024 adds it as a base primary. A `[` that cannot evaluate it
# returns 2 or more, and that is refused, never read as "not this one".
#
# $1 ITSELF a symlink needs one more question first, because `-ef` follows the
# link on both sides. A worktree directory replaced by a symlink to a
# different, healthy, registered worktree has git answering for the target and
# `-ef` agreeing, so the compare passes over a directory that is not the one
# registered — and `git worktree remove` then refuses it on its own
# back-pointer check, so a dry run promised what `--apply` cannot do (measured,
# git 2.50.1). So ask that back-pointer here: the admin dir git reaches
# through $1 holds a `gitdir` file naming the `.git` of the worktree it was
# registered for, and the listing derives each worktree's path from exactly
# that file — so for the listed path it reads `$1/.git` byte for byte, and
# through a link to ANOTHER worktree it names that one (measured: a link `A`
# to sibling `B` reaches `worktrees/B`, whose `gitdir` names `B/.git`). Under
# `worktree.useRelativePaths` git writes that file relative to the admin dir
# (measured: `../../../../B/.git`), so a relative one is resolved against it
# first. Then the registered path and $1 are compared as directory ENTRIES:
# the last component by bytes, because `-ef` on it would follow the link and
# is what cannot see this, and the parent by `-ef`, so a parent spelled
# through a symlink (`/tmp` for `/private/tmp`, or `..` segments) still names
# the same entry. Asked only of a link: a link standing in for the worktree's
# OWN renamed directory reaches its own admin dir and passes, and a plain
# directory never needs it — the NFD spelling `-ef` exists for would fail a
# byte compare.
#
# `&& echo x` inside the substitution, then `%?x`: `$(...)` strips EVERY
# trailing newline, so a `core.worktree` naming a sibling directory called $1
# plus a newline byte — git accepts one as an ordinary path character — would
# otherwise name $1 itself and pass the redirect (measured). The sentinel
# leaves `$(...)` only git's own terminating newline to strip.
# `2>/dev/null` on that capture, for `wt_registry_root`'s reason; git's own
# words are fetched with a second call, only on the path that refuses.
#
# What this does NOT cover: shapes that swap which git DIR answers while the
# working tree stays $1 — a `.git` naming a sibling worktree's admin dir, or a
# foreign git dir whose `core.worktree` points back at $1. `--show-toplevel`
# answers $1 for both. A dirty check then reads $1's real files against the
# borrowed index, and `git worktree remove` refuses a `.git` that does not
# point back at its admin dir.
#
# Asked of the listing too, because the link check above needs $1 to BE the
# link, and under `worktree.useRelativePaths` it never is: git stores the
# back-pointer relative and resolves it, for the swapped entry, to the
# TARGET's directory, so the listing reports the swapped worktree at the
# target's path — two records naming one directory, the path the caller holds
# is the target's real directory, and no `-L` fires on it (measured, git
# 2.50.1: the sibling's live, clean worktree was then the one `reap --apply`
# removed). So when `$wt_list` holds more than one record for $1, which
# worktree stands there is unknown and $1 is refused. A caller that has read no
# listing (`$wt_list` empty or unset) skips this question. Counted in shell,
# line by line, so the question adds no external command whose failure would
# be a new way for a caller to refuse.
#
# Trailing slashes and `/.` components come off $1 first, a lone `/` kept:
# `[ -L "link/" ]` and `[ -L "link/." ]` follow the link and are false, and
# `worktree link/` is no listing record, so such a spelling would skip both
# questions above and pass the `-ef` compare.
# shellcheck disable=SC2034
wt_linkage() {
  while :; do
    case $1 in
      ?*/) set -- "${1%/}" ;;
      ?*/.) set -- "${1%/.}" ;;
      *) break ;;
    esac
  done
  wt_why=
  wt_lk_n=0
  # `git -C ""` reads the cwd's own repository, so an empty path is refused
  # here, named, rather than judged as the cwd.
  if [ -z "$1" ]; then
    wt_why="an empty path names no worktree"
    return 1
  fi
  if [ -n "${wt_list:-}" ]; then
    # Whole records, one per line (`wt_listing` swapped any newline inside a
    # path), so equality against `worktree $1` is the path compare, and a path
    # that merely starts with $1 never counts. The heredoc keeps the loop in
    # this shell.
    while IFS= read -r wt_lk_l; do
      if [ "$wt_lk_l" = "worktree $1" ]; then wt_lk_n=$((wt_lk_n + 1)); fi
    done <<EOF
$wt_list
EOF
    if [ "$wt_lk_n" -gt 1 ]; then
      wt_why="the worktree listing names $1 for $wt_lk_n worktrees — a symbolic link standing in for another worktree's directory, so which one stands there is unknown"
      return 1
    fi
  fi
  if ! wt_lk_top=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null && echo x); then
    wt_lk_err=$(git -C "$1" rev-parse --show-toplevel 2>&1 >/dev/null) || :
    wt_lk_err=$(printf '%s' "$wt_lk_err" | tr '\n' ' ') || wt_lk_err=
    wt_why="cannot read the git repository at $1 — its .git linkage (the .git file or the gitdir it names) does not resolve${wt_lk_err:+: $wt_lk_err}"
    return 1
  fi
  wt_lk_top=${wt_lk_top%?x}
  if [ -L "$1" ]; then
    if ! wt_lk_admin=$(git -C "$1" rev-parse --absolute-git-dir 2>/dev/null && echo x); then
      wt_lk_err=$(git -C "$1" rev-parse --absolute-git-dir 2>&1 >/dev/null) || :
      wt_lk_err=$(printf '%s' "$wt_lk_err" | tr '\n' ' ') || wt_lk_err=
      wt_why="$1 is a symbolic link through which git could not report its admin dir, so which worktree it stands for is unknown${wt_lk_err:+: $wt_lk_err}"
      return 1
    fi
    if ! wt_lk_back=$(cat "${wt_lk_admin%?x}/gitdir" 2>/dev/null && echo x); then
      wt_why="$1 is a symbolic link whose admin dir's gitdir back-pointer could not be read, so which worktree it stands for is unknown"
      return 1
    fi
    # `cat` adds no newline of its own, so the sentinel alone comes off, then
    # the one newline git writes after the path, if it is there.
    wt_lk_back=${wt_lk_back%x}
    wt_lk_back=${wt_lk_back%"
"}
    wt_lk_back=${wt_lk_back%/.git}
    case $wt_lk_back in
      /*) ;;
      *) wt_lk_back=${wt_lk_admin%?x}/$wt_lk_back ;;
    esac
    case $1 in
      */*) wt_lk_up=${1%/*} ;;
      *) wt_lk_up=. ;;
    esac
    # shellcheck disable=SC3013 # -ef as below; a `[` that cannot evaluate it fails the `!`, so it refuses
    if [ "${wt_lk_back##*/}" != "${1##*/}" ] || ! [ "${wt_lk_back%/*}/" -ef "$wt_lk_up/" ]; then
      wt_why="$1 is a symbolic link to another worktree's directory — its .git linkage reaches the admin dir registered for $wt_lk_back, not for $1"
      return 1
    fi
  fi
  # shellcheck disable=SC3013,SC2319 # -ef is a ksh-derived extension bash/dash/BSD sh share, base in POSIX.1-2024; the else's $? is deliberately the `[ -ef ]` test's own rc, read before anything else runs
  if [ "$wt_lk_top" -ef "$1" ]; then return 0; else wt_lk_rc=$?; fi
  if [ "$wt_lk_rc" -ge 2 ]; then
    wt_why="could not compare $1 with $wt_lk_top, the working tree git answers for through it (test -ef exited $wt_lk_rc)"
    return 1
  fi
  wt_why="$1's .git linkage does not point at $1 — git answers for the working tree at $wt_lk_top, not $1"
  return 1
}

# Would removing the directory $1 delete the working directory $2? True when
# $2 is $1 or lies anywhere beneath it (a nested worktree). Removing a
# worktree a script stands in deletes that process's cwd, and every git call
# after it then dies with `fatal: Unable to read current working directory`
# (measured, git 2.50.1, Apple Git-155).
#
# Asked of the DIRECTORY, not the string: `-ef` of $2 and of each of its
# parents in turn. A byte-boundary prefix match missed the same directory
# spelled two ways — a symlinked parent, and the NFD name `wt_linkage`
# records — and a removal deleted the cwd it was standing in (measured). An
# empty $2 names no directory and matches nothing; the walk ends when no `/`
# is left to strip, so a $2 with no slash is compared once and never spins.
#
# A `[` that cannot evaluate `-ef` (2 or more) answers TRUE: fail closed.
# Nothing downstream of this guard re-checks the directory it protects, so
# reading that rc as "not this one" would disable the guard silently.
#
# Returns 0 or 1 only. A match, and every 1, leave `$wt_why` empty: the caller
# names that refusal, because only the caller knows whose cwd $2 is. The
# fail-closed 0 instead sets `$wt_why` to the compare that could not be made,
# and the caller reports that in place of its own wording, which would claim
# a match nothing established. Cleared on entry, so a reason left by an
# earlier probe never stands in for a match.
wt_holds_cwd() {
  wt_why=
  wt_hc_d=$2
  while :; do
    # shellcheck disable=SC3013,SC2319 # -ef as in wt_linkage; the else's $? is the `[ -ef ]` test's own rc, read before anything else runs, to fail closed on rc>=2
    if [ "$wt_hc_d" -ef "$1" ]; then return 0; else wt_hc_rc=$?; fi
    if [ "$wt_hc_rc" -ge 2 ]; then
      wt_why="could not compare $wt_hc_d with $1 (test -ef exited $wt_hc_rc), so whether removing $1 would delete the working directory is unknown"
      return 0
    fi
    case "$wt_hc_d" in
      */*) wt_hc_d=${wt_hc_d%/*} ;;
      *) return 1 ;;
    esac
  done
}

# Which worktree holds branch $1 (the short name, `refs/heads/` added here)?
# Reads `$wt_list` as `wt_listing` (or `wt_counts`) last left it and sets
# `$wt_path` to the path of every record whose `branch` line names it — the
# main checkout included, one per line in listing order, empty when none.
#
# 1 with `$wt_why`, and `$wt_path` empty, whenever the answer is not one the
# listing established, because an empty `$wt_path` is "no worktree" to every
# caller and a delete follows it:
#   - $1 empty: `refs/heads/` names no branch, and matching nothing would
#     read as "no worktree";
#   - `$wt_list` empty: a listing read always holds the main checkout, so an
#     empty one was never read, or died before the caller got here;
#   - awk could not finish the scan (a multibyte conversion failure, killed):
#     its empty output is not an answer;
#   - a holder's path lies inside the worktree registry itself. git resolves a
#     `gitdir` file holding something other than an absolute path relative to
#     the entry's admin dir, so a garbage `gitdir` lists the worktree at
#     `<registry>/<entry>/<garbage>` — measured, git 2.50.1: `not a path` in
#     `gitdir` lists `…/.git/worktrees/<entry>/not a path`, a path nothing is
#     at, while the real checkout stands where it always did. Read as an
#     absent worktree, its registration was cleared and its branch reaped,
#     leaving the checkout orphaned. No `git worktree add` places a worktree
#     inside the registry, so such a path is never where the checkout is.
#
# `-v b=`: awk processes escapes in a `-v` value, which is safe here only
# because a ref name cannot hold a backslash (`git check-ref-format` refuses
# one). The match is on the `branch` line, the path the whole rest of the
# `worktree` line — never `$2`, which a space in the path would truncate.
# shellcheck disable=SC2034
wt_find_branch() {
  wt_path=
  wt_why=
  if [ -z "$1" ]; then
    wt_why="no branch name was given to look up, and an empty one matches no worktree"
    return 1
  fi
  if [ -z "$wt_list" ]; then
    wt_why="the worktree listing was not read, so whether $1 has a worktree is unknown"
    return 1
  fi
  if ! wt_fb_hit=$(printf '%s\n' "$wt_list" |
      awk -v b="refs/heads/$1" '/^worktree /{w=substr($0,10)} /^branch /&&$2==b{print w}'); then
    wt_why="could not scan the worktree listing for $1"
    return 1
  fi
  if [ -n "$wt_fb_hit" ]; then
    wt_registry_root || return 1
    # One holder per line: `wt_listing` swapped any newline INSIDE a path, so
    # every line here is one whole path. The heredoc keeps the loop in this
    # shell, so its `return` answers for the function.
    while IFS= read -r wt_fb_p; do
      case "$wt_fb_p" in
        "$wt_root"/*)
          wt_why="git lists $1's worktree at $wt_fb_p, inside the worktree registry $wt_root — its gitdir file names no worktree, so where the checkout stands is unknown"
          return 1
          ;;
      esac
    done <<EOF
$wt_fb_hit
EOF
  fi
  wt_path=$wt_fb_hit
}

# Which release outcome does $1 hold — measured, never inferred from the rc of
# the `git worktree remove` that preceded it? git drops the registration BEFORE
# the directory and does not restore it when the directory delete fails, so
# one call has three landing shapes and its exit code separates none of them.
# All measured on git 2.50.1:
#
#   dirty worktree                     rc 128, registration and directory kept
#   symlink standing in for the dir    rc 255, registration CLEARED, path kept
#   unwritable .git/worktrees          rc 255, registration and directory gone
#
# Writes `$wt_outcome`, one of CONTEXT.md's four Release outcome states:
# `Unreleased` (registration and directory both present), `Deregistered`
# (registration cleared, directory on disk), `Released` (both gone) or
# `Indeterminate`, and `$wt_why` when Indeterminate for a reason git or awk
# named. A registration that survived a directory that did not has no name of
# its own and reports Indeterminate rather than being squeezed into
# Unreleased. Returns 0 whatever the outcome — the answer is the variable.
#
# A FRESH listing, never the caller's `$wt_list`: that one was captured before
# the mutation this measures. `$wt_list` is put back before returning, because
# the caller's guards read their pre-mutation capture off it. Called as a bare
# statement, never inside `$( )`: a subshell would take `$wt_why` with it.
#
# The registration is read with an `ENVIRON`-keyed awk, because a `-v`
# assignment mangles a backslash in the path and the compare then falls to the
# permissive answer. Its exit status is three-valued: 0 listed, 1 ran and found
# nothing, 2 or more could not run — and that last one must not fold into "not
# registered", which is what put a false Deregistered into a receipt for a
# registration nothing established was cleared (measured). The directory is
# `wt_occupied` composed with `gone`, the pairing `gone`'s own contract
# prescribes for a caller that needs present and cannot-stat apart.
# shellcheck disable=SC2034
wt_outcome() {
  wt_why=
  wt_oc_prior=$wt_list
  if ! wt_listing; then
    wt_list=$wt_oc_prior
    wt_outcome=Indeterminate
    wt_why=$(printf '%s' "$wt_err" | tr '\n' ' ')
    return 0
  fi
  wt_oc_now=$wt_list
  wt_list=$wt_oc_prior
  if printf '%s\n' "$wt_oc_now" |
      P="$1" awk '/^worktree /{if (substr($0,10)==ENVIRON["P"]) f=1} END{exit !f}'; then
    wt_oc_rc=0
  else
    wt_oc_rc=$?
  fi
  if [ "$wt_oc_rc" -eq 0 ]; then
    if wt_occupied "$1"; then wt_outcome=Unreleased; else wt_outcome=Indeterminate; fi
  elif [ "$wt_oc_rc" -ne 1 ]; then
    wt_outcome=Indeterminate
    wt_why="could not tell whether $1 is still registered"
  elif wt_occupied "$1"; then
    wt_outcome=Deregistered
  elif gone "$1"; then
    wt_outcome=Released
  else
    wt_outcome=Indeterminate
  fi
  return 0
}
