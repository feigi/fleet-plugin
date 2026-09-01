# shellcheck shell=sh
# Reading worktree state for the fleet's shell scripts: the porcelain listing,
# and the two predicates over a worktree path that more than one script asks.
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
# predicate and a `git` reader are neither. #725

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
# and none of them refused. #551, the defect #185 fixed in inflight.sh.
#
# `--porcelain -z` terminates every attribute with NUL instead, which needs git
# 2.36.0 — a floor this repo already exceeds through no-undo-audit.sh's
# `git merge-tree --write-tree --name-only -z`.
#
# NOT `awk -v RS='\0'`. That is a gawk/BWK extension, and the awk this fleet
# actually runs on macOS — /usr/bin/awk, BWK awk 20200816 — does not merely
# ignore it: it stops dead at the first NUL and reports ONE record for a listing
# of any length. Measured under #185, all three spellings, `-v RS='\0'`,
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
# `[ ! -L "$look" ]` in the loop condition, and it is the whole of #725. Every
# `test` primary except `-L` STATS, so it follows a symlink: on a dangling one
# `-e` is false while `-L` is true, and the predicate answered established-absent
# for a path `git worktree add` treats as occupied. Measured — worktree-audit.sh
# reported such a path as `MISSING on disk` with `ahead=0, dirty=0`, which is
# what the fleet controller reads to decide whether a replacement member would
# redo work or destroy it. Same `-e`/lstat split #188 fixed one layer up in
# claim-ticket.sh.
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
# partway. "Not established-absent" is the only answer true of both. #728
#
# `look=${look:-/}` INSIDE the loop, and that placement is the whole of #178:
# `${p%/*}` on `/x` yields the empty string, not `/`, so a path whose every
# ancestor below the root is gone used to fall out on "" and answer unknown about
# an absence the searchable root proves. The same restore written AFTER the loop
# reads identically and is wrong — nothing enters the loop on an empty `$1`, so
# it would rewrite that to `/` too and turn `gone ""` into established-absent.
# Inside, it only ever rewrites what the loop just truncated. gone-walk.test.mjs
# holds that matrix, `gone ""` included, because no caller can reach it: the
# callers test the path non-empty first, and worktree-audit.sh reads its own off
# `git worktree list`, which never emits an empty one — so a caller-level suite
# alone cannot tell the two placements apart.
#
# `!=`, not a non-empty test: `${p%/*}` returns p unchanged when p holds no
# slash, so the emptiness form spins forever on one. git emits absolute paths to
# every caller, but a delete script may not hang on the input that proves
# otherwise.
#
# One definition, in one file, because every caller asks one question. Answered
# separately they drift, and the halves of this fleet that protect a member's
# work stop agreeing about whether there is any work there to protect — which is
# exactly what #725 found: three copies, and only one compensating, at a call
# site rather than in the predicate.
#
# 0 ONLY for established absent; 1 covers present AND cannot-stat, so a caller
# needing those apart pairs this with its own `[ ! -e ]`, as release-ticket.sh's
# dirty check does. Condition context only: a bare `gone` returns 1 on the
# ordinary present answer and `set -e` exits.
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
  # rest of this comment gives: answered separately, the callers drift. #551
  nl_path "$1" && return 1
  look=$1
  while [ ! -e "$look" ] && [ ! -L "$look" ] && [ "$look" != "${look%/*}" ]; do
    look=${look%/*}
    look=${look:-/}
  done
  [ ! -e "$1" ] && [ -x "$look" ]
}
