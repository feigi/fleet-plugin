#!/bin/sh
# Release a claim that was never dispatched: drop the in-progress label, remove
# the worktree, delete the branch — but only when the claim provably carries no
# work. The inverse of claim-ticket.sh.
#
# Dry-run by default; --apply mutates the tracker and the filesystem.
#
# reap.sh will not do this: no merge happened, so no remote branch was ever
# deleted, so the branch is not [gone] and reap's for-each-ref filter never
# selects it. (Having no unique commits is not a second reason — in reap that is
# what AUTHORIZES the delete.) Nothing else fires either, so the three artefacts
# survive the run and phase 0's in-flight probe reads the ticket as taken — the
# same silent queue shrink the reaping section names for merged tickets.
#
# Every precondition is recomputed inside THIS invocation rather than trusted
# from an earlier tool call, for the reason reap.sh gives: the dangerous
# direction is a worktree that gained work after it was checked. Only the dirty
# check is also recomputed at the moment of the delete, by git itself — that is
# what `worktree remove` without --force and `branch -d` are for, and it is why
# both run before the label is dropped rather than after. That second opinion
# covers the live-directory case ONLY: `worktree remove` gates its own clean
# check on the same stat this script does, so wherever the path cannot be
# stat'ed git reaches the same conclusion rather than an independent one, and
# the guard at the dirty check below is left as sole arbiter — which is why it
# establishes absence instead of inferring it.
set -eu

# Byte semantics for the `awk`, `grep`, `sed` and `tr` below — all four really
# are here, unlike in the siblings this header was copied to. `awk` and `grep`
# parse `git worktree list --porcelain` (worktree paths and branch names),
# `git cherry`'s output, the dirty-file list and `gh`'s labels; `tr` flattens
# git's own error text into a diagnostic; and `jstr`'s `sed | tr` scrubs
# whatever string is being JSON-encoded, `$wt` included. Under a UTF-8 locale
# BSD `tr` and `sed` exit 1 on a byte that is not valid UTF-8 — `sed` emitting
# nothing at all, measured — and `grep` silently drops the line holding it.
# Such a byte reaches us from a fetched tree even where the local filesystem
# refuses to hold the name, and inside `$(...)` a `tr` failure empties the cause
# out of the diagnostic without a trace. #582 measured the cost of leaving this
# ambient in no-undo-audit.sh: a truncated list reported as a clean, confident
# answer.
#
# Safe as a global: nothing in this script sorts, folds case, or uses a `[a-z]`
# range or a POSIX class, so collation and case-folding — the two things
# `LC_ALL=C` otherwise changes — have nothing here to act on.
export LC_ALL=C

NAME=release-ticket
die() { printf '%s: %s\n' "$NAME" "$1" >&2; exit 2; }


# The escaping helpers (#119). json.sh's header holds the sourcing contract and
# the measurements behind it; only what is true of THIS script is repeated here.
# Below `export LC_ALL=C` deliberately: locale-pin-prose.test.mjs allows only
# comments, blanks, a shebang or a `set -` line above that pin, and `json_lib=`
# is none of them.
#
# Exit 1 from this script is a verdict too: `#<n> NOT released — nothing was
# touched`, emitted with the blocker list a precondition scan actually found. A
# library that merely went missing would hand the caller that answer for a
# ticket nothing ever refused, so `[ -r ]` has to fire before the `.` can kill
# the shell.
json_lib="$(dirname "$0")/json.sh"
[ -r "$json_lib" ] || die "cannot read $json_lib — refusing to act without the JSON escaping helpers"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=json.sh
. "$json_lib" || die "$json_lib failed to load"

[ $# -ge 3 ] && [ $# -le 4 ] || die "usage: release-ticket.sh <issue> <slug> <type> [--apply]"
issue=$1
slug=$2
type=$3
# Exact match, and nothing else tolerated in the slot: `--aply` silently became a
# dry run that still reported "released":true, so a caller keying on that field
# marked the claim released while every artefact survived — the silent queue
# shrink this script exists to undo, produced by a typo.
case "${4:-}" in
  ''|--apply) ;;
  *) die "unknown argument '$4' — the only option is --apply";;
esac
apply=false
[ "${4:-}" = "--apply" ] && apply=true

case "$issue" in ''|*[!0-9]*|0?*) die "issue must be a number, got '$issue'";; esac

branch="$type/$issue-$slug"
base=${BASE_REF:-origin/main}

# The fleet harness is exactly the caller that sets BASE_REF, and pointing it at
# the claim's own branch makes both commit guards vacuous — ahead 0 and cherry
# empty on a branch that still carries unpushed work. Only a remote-tracking ref
# can answer "is this upstream", so only one is accepted.
case "$base" in
  origin/*|refs/remotes/*) ;;
  *) die "BASE_REF must be a remote-tracking ref, got '$base'";;
esac

git rev-parse --git-dir >/dev/null 2>&1 || die "not inside a git repository"
git rev-parse --verify --quiet "$base" >/dev/null || die "$base does not resolve"

# Locate the worktree by the branch it has checked out, the way reap.sh does —
# not by claim-ticket.sh's ".worktrees/$issue-$slug", which is relative to the
# caller's cwd.
#
# Only a LINKED worktree is ours: `worktree list --porcelain` lists the main one
# first, and a checkout that happens to sit on this branch would otherwise be
# selected for removal. git refuses to remove it — but not before the label was
# dropped, which is the half-release this script exists to prevent. Measured in
# a fresh clone, where the branch really is the main checkout's HEAD.
#
# `worktree list --porcelain` is reading `<git-common-dir>/worktrees`, the
# admin directory git itself writes one subdir per linked worktree into. When
# that directory — or any file git needs inside one of its entries — cannot be
# read, git does not error: it silently drops the affected entries and still
# exits 0 (verified, git 2.50.1). `wt` and `stray` below would then read as "no
# worktree of ours" for a claim that has one — the same absent-vs-unreadable
# confusion `gone` keeps this script out of elsewhere, applied by hand here
# because the question is about a directory git reads, not about a path this
# script stats. So establish the listing is COMPLETE before trusting an absence
# it reports — not by guarding its exit status, which stays 0 throughout.
#
# Do not try to predict which reads git needs: stat'ing each entry directory is
# one level too shallow, because naming an entry needs read+execute on the
# PARENT only. `chmod 000` on the `gitdir` FILE inside an entry passes every
# permission test this script could make on the entry itself and still drops
# the worktree from the listing — measured, and that is #84 unclosed. Count
# instead: one registry entry on disk per linked worktree, against what git
# reported. A mismatch is a silent drop, whichever file inside was unreadable.
#
# Absent entirely is fine and answers nothing here: a repo where a worktree
# was removed and pruned (or never had one) has no `worktrees` dir at all, and
# that emptiness is real, not a permission problem — zero entries against the
# main worktree alone is a match, so the release goes through.
common=$(git rev-parse --path-format=absolute --git-common-dir) ||
  die "cannot resolve the git common directory"
wtroot="$common/worktrees"
registered=0
if [ -e "$wtroot" ]; then
  # The parent needs its own check even so, and this is not redundant with the
  # count: unreadable, the glob below expands to nothing, and zero-on-disk would
  # AGREE with the empty listing git returns for the same reason.
  [ -r "$wtroot" ] && [ -x "$wtroot" ] ||
    die "worktree registry $wtroot could not be read — whether #$issue has a worktree is unknown"
  # A registry entry is a directory; anything else in here is not git's and must
  # not be counted as a worktree git failed to report.
  for entry in "$wtroot"/*; do
    [ -d "$entry" ] || continue
    # Skip only an EMPTY directory. That is an operator's stray `mkdir`, which
    # git ignores — and counting one refuses EVERY release of every ticket in
    # the repo, forever, over something git is right to ignore (measured, git
    # 2.50.1: git lists 2 worktrees where a bare `-d` count said 2 registered
    # against 1 linked). A stray FILE was already skipped by the `-d` above; a
    # stray directory was not, which is why the file case shipped green.
    #
    # Emptiness, NOT the absence of a `gitdir` file, and the difference is a
    # wrong "free": git drops an entry whose `gitdir` was deleted, so keying the
    # skip on that file waves the entry through as "not git's", the count agrees,
    # no refusal fires, and the release proceeds while the checkout may still be
    # on disk (measured: listed 1 → linked 0, and a gitdir-keyed count returns 0
    # to match). A corrupt entry still holds git's own files — commondir, HEAD,
    # index, logs, refs — so emptiness separates it from a stray where the
    # missing `gitdir` does not. This is #384's own second commit, and #395
    # exists partly to keep this copy from inheriting the discriminator it
    # replaced.
    #
    # `ls`'s STATUS, not just its output, and that is the whole point: an entry
    # we could not LIST is not an empty one, and `2>/dev/null` hides the
    # difference. A stray `mkdir` lists empty at rc 0; an entry chmod'd 000
    # (unsearchable) OR 0111 (searchable, so an `-x` test passes it, but not
    # readable) fails EACCES and prints nothing just the same. Reading only the
    # output skips that entry as "not git's" — and git drops it too, so the
    # counts AGREE, no refusal fires, and the claim is freed with the member's
    # uncommitted work still on disk (measured: exit 0, `released:true`,
    # `blockers:[]`, branch deleted, in-progress label dropped, checkout
    # standing). Could not read it, so we cannot tell → count it and let the
    # mismatch below fire. No `-x` test: it answers a narrower question than the
    # status does — it covers only the 000 half — and a failed `ls` already
    # settles both.
    if contents=$(ls -A "$entry" 2>/dev/null) && [ -z "$contents" ]; then continue; fi
    registered=$((registered + 1))
  done
fi

# The path is the whole rest of the line, never $2: `worktree list --porcelain`
# prints it raw, so any checkout living under a directory with a space in it —
# ordinary on macOS — would otherwise be truncated at the first one.
wt_list=$(git worktree list --porcelain)

# The main worktree is always listed first and has no registry entry of its own,
# hence the -1.
#
# awk, not `grep -c … || true`. `grep -c` exits 1 on zero matches — legitimate,
# and `set -e` would read it as fatal — so a `|| true` has to absorb it, and
# that same `|| true` absorbs a grep that could not RUN AT ALL just as happily.
# The count is then the empty string, `$((listed - 1))` is -1 (measured), and
# the mismatch report below blames `git worktree list` for a count no listing
# can produce — sending the operator after git when the fault was a fork
# failure. awk needs no such case separated out: the program contains no `exit`,
# so it returns 0 whether or not anything matched, and every non-zero status is
# a real failure. This script already removed exactly this shape elsewhere.
listed=$(printf '%s\n' "$wt_list" | LC_ALL=C awk '/^worktree /{c++} END{print c+0}') ||
  die "could not count the worktrees git listed for #$issue"
linked=$((listed - 1))
# Name the direction actually observed. The two disagreements have opposite
# causes and send the reader to opposite places, so one message cannot serve
# both: FEWER listed than registered is git silently dropping an entry it could
# not read, which is the fault this whole check exists to catch. MORE listed
# than registered is the reverse — the on-disk count is the stale read, a
# sibling agent's `git worktree add` having landed between the two, which in a
# parallel fleet is routine rather than exotic. Calling that "the listing is
# incomplete" sends an operator hunting a permissions fault that is not there.
if [ "$linked" -lt "$registered" ]; then
  die "git listed $linked worktrees for $registered registry entries in $wtroot — the listing is incomplete, so no absence it reports can be trusted"
elif [ "$linked" -gt "$registered" ]; then
  die "git listed $linked worktrees but only $registered registry entries were counted in $wtroot — the registry read missed entries git can see, so no absence it reports can be trusted"
fi

wt=$(printf '%s\n' "$wt_list" |
     awk -v b="refs/heads/$branch" '/^worktree /{w=substr($0,10);n++} /^branch /&&$2==b&&n>1{print w}')
main_branch=$(printf '%s\n' "$wt_list" | awk '/^worktree /{n++} n==1&&/^branch /{print $2; exit}')
# The main checkout's path, and the anchor the orphan probe below reconstructs a
# claim's directory from. Off git's own listing rather than $PWD: this script is
# routinely run from inside a member's worktree, where a cwd-relative
# ".worktrees/..." names nothing.
main_wt=$(printf '%s\n' "$wt_list" | awk '/^worktree /{print substr($0,10); exit}')

# claim-ticket.sh creates the worktree on this branch, but it does not stay
# there: an interrupted rebase leaves it detached, and a member can switch it.
# The branch lookup above then finds nothing, which reads as "no worktree of
# ours" — so the dirty check is skipped entirely and the script reports a
# release that left the worktree standing, with the member's uncommitted work in
# it. Next run the in-flight probe still sees it and the ticket still reads as
# taken: the exact failure this script exists to fix, reported as success.
#
# The directory name is the one part of the claim that does not move, so match
# on it — by exact suffix, not a pattern, since <slug> is caller-supplied.
stray=$(printf '%s\n' "$wt_list" |
        awk -v d="/$issue-$slug" '/^worktree /{n++; p=substr($0,10)
          if (n>1 && substr(p, length(p)-length(d)+1) == d) {print p; exit}}')

has_branch=false
git rev-parse --verify --quiet "refs/heads/$branch" >/dev/null && has_branch=true

# A mistyped <slug>/<type> names a branch that does not exist, and without this
# the run would drop the label off a ticket whose real claim is untouched —
# invisible to candidates.mjs and still in-flight. Refuse instead of guessing.
if [ "$has_branch" = false ] && [ -z "$wt" ] && [ -z "$stray" ]; then
  die "no branch $branch and no worktree on it — check the <slug> and <type> arguments"
fi

# Every string that reaches the JSON goes through `jstr` from json.sh. <slug>
# and <type> are caller-supplied and git's own stderr is quoted back verbatim,
# so without it a single `"` or backslash anywhere emits a payload the caller
# cannot parse — while the delete has already happened and the exit code still
# says success. The rule list and its ordering live in json.sh, once, rather
# than here and in inflight.sh and in no-undo-audit.sh (#119).
# A `$(...)` in printf's ARGUMENT list sits outside the `|| die` on the printf
# itself: a substitution that fails contributes an EMPTY argument and printf
# still exits 0 — and an unquoted `%s` slot then emits `"...Rewritten":,`,
# malformed JSON at exit 0, which is the failure the receipt exists to rule
# out. Assigned first, each one is a simple command whose status the `&&` chain
# can read and this `|| die` can act on.
# `branch` is settled from argv at the top and `wt` from the worktree listing
# above, both before any receipt below can print, so the four fields are escaped
# once here.
branch_j=$(jstr "$branch") && branch_rw=$(jrewritten "$branch") \
  && wt_j=$(jstr "$wt") && wt_rw=$(jrewritten "$wt") \
  || die "could not escape the receipt fields for #$issue"

# A mutation refused mid-release. `die` printed prose and
# exited before every printf, so a caller parsing this script's stdout got
# nothing at all out of the one case where it most needs to know what happened.
# Enumerate what landed, name the compensating action, still emit the receipt.
#
# WHAT LANDED decides the headline, never the call site: the first mutation
# attempted — the worktree removal when there is one, `git branch -d` when the
# registration is already cleared — refuses with nothing landed, and announcing
# a partial release over that overstates exactly the state this script exists to
# report precisely. A partial release is a refusal that followed a successful
# mutation. Distinct again from the blocked message that reports refused
# preconditions, which means nothing was ATTEMPTED.
#
# The two are NOT a matched pair, and one evenly-shaped detail line asserted
# that they were. `git branch -d` updates a ref, which lands or does not, so a
# boolean call log answers for it completely. `git worktree remove` has TWO
# effects and drops them in order: it deletes the registration before the
# directory and does not put the registration back when the directory delete
# fails (measured, git 2.50.1). Its exit code therefore answers for neither, and
# `nothing landed` over a cleared registration was a positive assertion that was
# false. So `wt_outcome` carries a measured release outcome — CONTEXT.md's four
# states — taken by `release_outcome` after the call rather than read off its rc.
#
# `Unreleased` to start because nothing has been attempted yet, and the line is
# not printed at all when this claim has no worktree of ours: a state whose
# definition is "registration and directory both still present" may not be
# asserted about a worktree that was never there.
wt_outcome=Unreleased
done_branch=false
halt() {
  if [ -n "$wt" ]; then
    case $wt_outcome in
      Unreleased) landed="registration and directory both still present";;
      Deregistered) landed="the registration is cleared, the directory is still on disk";;
      Released) landed="registration and directory both gone";;
      *) landed="what the removal landed could not be measured";;
    esac
    wt_report="worktree $wt is $wt_outcome — $landed"
  fi
  # The receipt carries the outcome in the blocker string, the one field a
  # caller that never sees stderr can read it out of. No new key: nothing in the
  # repo parses this payload, so a field would be shape for no consumer.
  detail=$1
  [ -z "$wt" ] || detail="$1 — $wt_report"
  if [ "$wt_outcome" = Deregistered ] || [ "$wt_outcome" = Released ] || [ "$done_branch" = true ]; then
    printf '%s: #%s PARTIALLY RELEASED — %s\n' "$NAME" "$issue" "$1" >&2
  elif [ "$wt_outcome" = Indeterminate ]; then
    # Neither headline. Asserting `nothing landed` here would be the original
    # defect with a different trigger, and asserting a partial release would
    # invent one; the operator is told the measurement failed instead.
    printf '%s: #%s HALTED mid-release — what landed could not be measured: %s\n' "$NAME" "$issue" "$1" >&2
  else
    printf '%s: #%s HALTED mid-release — nothing landed: %s\n' "$NAME" "$issue" "$1" >&2
  fi
  [ -z "$wt" ] || printf '    %s\n' "$wt_report" >&2
  echo "    branch deleted: $done_branch, in-progress: still on the issue" >&2
  echo "    the ticket still reads as taken — finish or restore it by hand" >&2
  blocker_j=$(jstr "$detail") || die "could not escape the halt blocker for #$issue"
  printf '{"issue":%s,"branch":"%s","branchRewritten":%s,"worktree":"%s","worktreeRewritten":%s,"label":%s,"released":false,"applied":true,"blockers":["%s"]}\n' \
    "$issue" "$branch_j" "$branch_rw" "$wt_j" "$wt_rw" "$has_label" "$blocker_j"
  exit 2
}

blockers=""
# Assigned first, exactly as `halt` does above: a `$(jstr …)` spliced straight
# into the accumulator is not a simple command, so `set -e` reads only the
# assignment and a failed escape would abort at exit 1 — this script's blocked
# verdict — with neither the receipt that verdict carries nor a line on stderr.
block() {
  block_j=$(jstr "$1") || die "could not escape the blocker for #$issue"
  blockers="${blockers}\"$block_j\","
  printf '    BLOCKED: %s\n' "$1" >&2
}

# Is this path ABSENT, or merely one we are not permitted to stat? -e is false
# for both, and neither caller may infer the first from the second: on the dirty
# check that releases a claim whose worktree is still on disk holding the
# member's uncommitted work, on the stray guard it hands the operator a prune
# that unregisters that same worktree. git cannot separate them either — it marks
# both `prunable`, and `worktree remove` ACCEPTS a prunable-because-absent entry
# (rc 0) where a live worktree whose .git was merely deleted it refuses — so
# nothing downstream recomputes what this gets wrong. So walk up to the nearest
# existing ancestor, `/` included, and require THAT to be searchable: only then
# is "not there" a measurement rather than a guess. The walk is what keeps
# `rm -rf .worktrees` answerable — the parent goes with the child, and testing
# the immediate parent alone reads its absence as unknown, which is the
# permanent refusal both callers exist to stop producing.
#
# `look=${look:-/}` INSIDE the loop, and that placement is the whole of #178:
# `${p%/*}` on `/x` yields the empty string, not `/`, so a path whose every
# ancestor below the root is gone used to fall out on "" and answer unknown
# about an absence the searchable root proves. The same restore written AFTER
# the loop reads identically and is wrong — nothing enters the loop on an empty
# `$1`, so it would rewrite that to `/` too and turn `gone ""` into
# established-absent. Inside, it only ever rewrites what the loop just
# truncated. gone-walk.test.mjs holds that matrix, `gone ""` included, because
# no caller can reach it: three test the path non-empty first, and
# worktree-audit.sh reads its own off `git worktree list`, which never emits an
# empty one — so a caller-level suite alone cannot tell the two placements apart.
#
# One predicate, because both callers ask one question. Answered twice they drift,
# and the halves of this script that protect a member's work stop agreeing about
# whether there is any work there to protect.
#
# `!=`, not a non-empty test: `${p%/*}` returns p unchanged when p holds no
# slash, so the emptiness form spins forever on one. git emits absolute paths
# here, but a delete script may not hang on the input that proves otherwise.
#
# 0 ONLY for established absent; 1 covers present AND cannot-stat, so a caller
# needing those apart pairs this with its own `[ ! -e ]`, as the dirty check does.
# Condition context only: a bare `gone` returns 1 on the ordinary present answer
# and `set -e` exits — rc 1, this script's own blocked-run code, and no receipt.
gone() {
  look=$1
  while [ ! -e "$look" ] && [ "$look" != "${look%/*}" ]; do look=${look%/*}; look=${look:-/}; done
  [ ! -e "$1" ] && [ -x "$look" ]
}

# Is the worktree registered at $1 locked? Both remedies this script can name
# turn on the answer, so both callers below ask: `git worktree remove` refuses a
# locked entry outright — before it looks at the directory at all, so present,
# gone or a stand-in makes no difference — and `git worktree prune` SKIPS one
# silently at rc 0, printing nothing and clearing nothing (measured, git 2.50.1,
# on a locked entry whose directory had been deleted). Handing the operator
# either command for a locked entry names an action that cannot work, and every
# later run then blocks identically: the permanent refusal this script exists to
# clear.
#
# Read off the porcelain listing already captured above (`wt_list`) rather than a
# second `git worktree list` call. `cur` is reset on EVERY `worktree ` line, so a
# sibling's `locked` line can never answer for this path. A `locked [<reason>]`
# line is matched by its prefix, since the reason is optional and rides on the
# same line when present, and it is looked for anywhere in the record rather
# than at a fixed offset: a DETACHED worktree has no `branch` line at all, and a
# stray is detached by definition.
#
# The path goes in through the ENVIRON, not `-v`. POSIX has awk process escape
# sequences in a `-v` assignment, so a repo living under a directory with a
# literal backslash in it reached the program mangled — `back\slash` arriving as
# `backslash`, measured — and could then never equal what the porcelain printed.
# The comparison fell to "not locked", which is the permissive answer in a guard
# whose whole job is to refuse to answer permissively. ENVIRON does no such
# processing.
locked() {
  printf '%s\n' "$wt_list" |
    P="$1" awk '/^worktree /{cur=(substr($0,10)==ENVIRON["P"])} cur&&/^locked/{f=1} END{exit !f}'
}

# Did git fail to resolve $1's HEAD, rather than find it genuinely detached or
# on some other branch? Four ways an admin HEAD file breaks all produce the
# same porcelain shape — the null object id with no `branch` line: `chmod 000`
# on it, garbage content in it, a dangling symlink in its place, or a
# directory in its place (measured, git 2.50.1). release-ticket.test.mjs
# builds all four. `chmod 000` is the only one needing a permission bit, so it
# alone carries the `EUID0` skip the file's other permission fixtures do and
# measures nothing on a root runner; the other three reproduce as any user. It
# is also the cheapest of the four to tear down, not the dearest: a file's own
# bits do not gate its unlink, only its parent directory's do, so a mode-000
# HEAD does not even need the chmod-back `repo()`'s teardown runs before
# `rmSync` — the one that closed #184, and that the fixtures putting a mode on
# a DIRECTORY still rest on (measured).
#
# BOTH conditions, never one alone. The null OID alone is also an UNBORN
# branch (`git worktree add --orphan`) — that one carries a real `branch`
# line, so admitting it here would refuse a healthy worktree the moment it
# exists. The absent `branch` line alone is also a genuine DETACHED checkout —
# that one carries a real sha, not the null OID, so admitting it here would
# swallow the ordinary case the `else` below exists for.
#
# Not `detached`: git prints that line on TWO of the four broken shapes above
# (the dangling symlink and the directory-in-HEAD's-place both got it,
# measured) as well as on a genuine detached checkout, so its presence is not
# evidence of a real detached checkout and its absence is not evidence of this
# fault either. A guard keyed on it instead of on `branch` misclassifies half
# of what it exists to catch — and that is pinned, not just reasoned: adding
# `cur&&/^detached$/{hasbranch=1}` reds the symlink and directory fixtures and
# nothing else (measured). Not because they are the only porcelain in the suite
# carrying the line — the genuine `--detach` fixtures print it too — but because
# those carry a real sha, so `nullhead` never fires for them and the added
# trigger has nothing left to flip.
unresolved_head() {
  printf '%s\n' "$wt_list" |
    P="$1" awk '
      /^worktree /{cur=(substr($0,10)==ENVIRON["P"])}
      cur&&/^HEAD 0+$/{nullhead=1}
      cur&&/^branch /{hasbranch=1}
      END{exit !(nullhead && !hasbranch)}'
}

# Is anything at all occupying $1? Not the same question as `gone`, which asks
# whether an absence is established; this one asks whether the path is taken.
# `-e` alone FOLLOWS symlinks, so a DANGLING one reads as absent while it still
# occupies the path and still fails the next `git worktree add` (`fatal: '...'
# already exists`) — and that is residue this very script can leave: where a
# symlink POINTS AT the registered worktree directory, `git worktree remove`
# deletes that directory and returns 0, leaving the link behind and now dangling.
# NOT the symlink standing in for the directory: that is the rc-255 row of the
# table below, and there the target survives emptied, so `-e` alone already sees
# it. Both measured, git 2.50.1. Same reason the non-directory precondition
# below tests -L separately.
#
# Neither shape impeaches the rc-0 fast path at the removal, so nothing there
# needs re-measuring: no shape measured returns 0 with the path git was asked to
# delete still occupied — the dangling residue sits on the LINK, which is a
# different path and reaches this predicate through the orphan probe.
occupied() { [ -e "$1" ] || [ -L "$1" ]; }

# Which release outcome does $1 hold after a `git worktree remove` that refused?
# Measured, never inferred from the rc — that inference is this file's #208.
# git drops the registration BEFORE the directory and does not restore it when
# the directory delete fails, so one call has three landing shapes and the exit
# code separates none of them. All measured on git 2.50.1:
#
#   dirty worktree                     rc 128, registration and directory kept
#   symlink standing in for the dir    rc 255, registration CLEARED, path kept
#   unwritable .git/worktrees          rc 255, registration and directory gone
#
# A FRESH listing, never `wt_list`: that one was captured before any mutation,
# so answering from it would re-read the state this function exists to
# re-measure. Read with the same ENVIRON-keyed awk `locked` uses, and for the
# same reason — a `-v` assignment mangles a backslash in the path, and the
# comparison then falls to the permissive answer.
#
# The tri-valued directory probe is `occupied` composed with `gone`, exactly the
# pairing `gone`'s own contract prescribes for a caller that needs present and
# cannot-stat apart. No second predicate and no third value inside `gone`: the
# three copies of it are pinned byte-identical, and this file already carries
# two answers on unreadable worktrees (#83) from a concept that got duplicated.
#
# Only the four named states, so the two cells CONTEXT.md has no name for are
# not asserted: a registration that survived a directory that did not is
# reported Indeterminate rather than squeezed into Unreleased, whose definition
# is that BOTH are still present.
release_outcome() {
  if ! now=$(git worktree list --porcelain); then
    # The listing is how the registration is read, so a listing git could not
    # produce leaves the registration unknown — not absent.
    echo Indeterminate
  elif printf '%s\n' "$now" |
       P="$1" awk '/^worktree /{if (substr($0,10)==ENVIRON["P"]) f=1} END{exit !f}'; then
    if occupied "$1"; then echo Unreleased; else echo Indeterminate; fi
  elif occupied "$1"; then
    echo Deregistered
  elif gone "$1"; then
    echo Released
  else
    echo Indeterminate
  fi
}

if [ "$main_branch" = "refs/heads/$branch" ]; then
  block "branch $branch is checked out in the main checkout — release it from elsewhere"
fi

if [ -z "$wt" ] && [ -n "$stray" ]; then
  # Which remedy applies turns on whether that directory is still there, and
  # asking only the registration named the wrong one whenever it is not: the
  # entry outlives the directory — `worktree list --porcelain` keeps listing it,
  # annotated `prunable`, after an `rm -rf` — so a claim with nothing left to
  # hand-release was told to hand-release it. That instruction names no action
  # the operator can take, so nothing cleared the entry and every later run
  # blocked identically: the permanent refusal, with the label and the branch
  # standing and the in-flight probe still reading the ticket as taken, that this
  # script exists to clear.
  #
  # Blocked either way, never released. This worktree is not on the claim's
  # branch, so releasing would delete a different ref and then reach the
  # `git worktree prune` a completed apply ends with — unanchoring a detached HEAD's
  # commits, which no ref points at, as a side effect of releasing something
  # else. Naming that prune hands the operator the command that does clear the
  # entry (verified, git 2.50.1: the run after it releases) and leaves the
  # discard their decision.
  #
  # A LOCK outranks both, because it is what makes both refuse: prune skips a
  # locked entry and remove rejects one, so neither remedy above is reachable
  # until the operator unlocks. Named first for that reason, not because it is
  # more likely.
  #
  # UNRESOLVED HEAD outranks the branch-mismatch else, but not the two above:
  # a lock still makes every remedy unreachable regardless of what HEAD says,
  # and a gone directory still means prune regardless of what HEAD says — this
  # fault is only interesting while there is a directory and no lock to talk
  # about. Below it, the `else` — this arm's whole reason to exist is that the
  # `else` cannot tell "genuinely on some other branch" from "git could not
  # tell", and asserts the former for both.
  if locked "$stray"; then
    block "worktree $stray is this claim's and is locked — git worktree unlock $stray, then prune or remove it"
  elif gone "$stray"; then
    block "worktree $stray is this claim's and its directory is gone — git worktree prune to clear the registration"
  elif unresolved_head "$stray"; then
    block "worktree $stray is this claim's but git could not read its HEAD, so its branch is unknown — inspect its entry's HEAD file under $wtroot by hand"
  else
    block "worktree $stray is this claim's but is not on $branch — release it by hand"
  fi
fi

# An Orphaned worktree directory: this claim's directory still on disk with its
# registration already cleared. `stray` cannot see it BY CONSTRUCTION — it is
# awk over git's registry, and there is no registration left to match — so the
# run after a Deregistered halt found no `wt` and no `stray`, deleted the
# branch, dropped the label and exited 0 with `"released":true,"blockers":[]`
# over a directory that is still there. The next `claim-ticket.sh` for the slug
# then died on it (`[ -e "$wt" ] && die`), with nothing left to explain why.
#
# So probe the path directly instead of through the registry, reconstructed from
# the same `<issue>-<slug>` pairing `stray` matches on. Anchored at the main
# checkout, since claim-ticket.sh writes `.worktrees/$issue-$slug` relative to
# its own cwd — a claim made from anywhere but the repo root is outside this
# probe's reach, which is a miss and never a false refusal.
#
# In the PRECONDITION block deliberately, not in the mutation path: here the dry
# run predicts the refusal for free, where placed below it would report only
# under --apply and rebuild the dry/apply asymmetry #86, #385 and #386 were
# filed against.
#
# Gated on this claim having no registration of ours. With `wt` or `stray` set
# the directory IS registered and a guard above owns it — which is what keeps a
# healthy claim, whose worktree sits at exactly this path, from blocking here.
#
# The remedy is a manual removal and deliberately never `git worktree prune`:
# prune clears registrations, and the defining property of this state is that
# there is no registration left to clear, so naming it would hand the operator a
# command that cannot work and every later run would block identically — the
# permanent refusal the stray guard above describes for the mirror-image case.
# Nor an automatic delete: a refusal is a finding to report, and nothing here
# has inspected what is in that directory.
#
# Absence is ESTABLISHED by `gone`, never inferred from `occupied` alone, for
# the reason the dirty check gives: read as "no orphan", a `.worktrees` this
# script may not search would release the claim over one.
if [ -z "$wt" ] && [ -z "$stray" ]; then
  orphan="$main_wt/.worktrees/$issue-$slug"
  if occupied "$orphan"; then
    block "worktree directory $orphan is this claim's and has no registration — inspect it and remove the directory by hand"
  elif ! gone "$orphan"; then
    block "cannot tell whether an orphaned worktree directory is at $orphan, so whether #$issue can be released is unknown"
  fi
fi

if [ "$has_branch" = true ]; then
  # Commits ahead — a member that did work. Measured on the branch ref rather
  # than the worktree's HEAD: the worktree above was located BY that ref, so the
  # two agree, and this still runs when the worktree is already gone.
  ahead=$(git rev-list --count "$base..refs/heads/$branch") ||
    die "cannot count commits on $branch against $base"
  [ "$ahead" -eq 0 ] || block "$ahead commit(s) ahead of $base"

  # Commits that exist nowhere else. Against the remote-tracking ref, never a
  # local main: a local main you never fast-forwarded reads every merged branch
  # as unmerged. Stricter than `ahead` in what it means, weaker in what it
  # catches — a commit already cherry-picked upstream is upstream-equivalent
  # here (a `-` line) and only `ahead` blocks it. Both, or that one walks.
  #
  # Run and count in two steps. Piped straight into `grep -c ... || true`, a
  # `git cherry` that failed outright (rc 128 on a corrupt object store, say)
  # yielded a count of 0 and the check silently passed; only the `ahead` guard
  # above, failing on the same conditions, kept that from being a delete.
  cherry=$(git cherry "$base" "refs/heads/$branch") ||
    die "git cherry failed on $branch against $base, so whether it carries unique commits is unknown"
  uniq=$(printf '%s' "$cherry" | grep -c '^+' || true)
  [ "$uniq" -eq 0 ] || block "$uniq commit(s) unique to $branch (git cherry)"
fi

# A pushed branch — work that survives the local delete and that a PR may
# already point at. Live query, so this one cannot be stale; a failure here is
# an unknown answer, never a "no".
# stderr stays on stderr, never folded into the value: the emptiness of $remote
# IS the answer, so an SSH host-key notice on a successful query used to read as
# a branch that exists. git's own message is more useful on the terminal anyway.
if ! remote=$(git ls-remote --heads origin "refs/heads/$branch"); then
  die "git ls-remote failed, so whether $branch was pushed is unknown"
fi
[ -z "$remote" ] || block "branch $branch exists on origin"

# `-d`, because a directory that is not there holds no uncommitted work. Deleted
# by hand, a worktree leaves its admin files registered, so `worktree list
# --porcelain` keeps listing the entry and the status below ran against a path
# that is gone: it failed, the die read that as "unknown", and the claim could
# then never be released — label, branch and worktree entry all surviving every
# run while the in-flight probe kept reading the ticket as taken. git agrees at
# the delete: `worktree remove` accepts the gone entry and clears the admin
# files outright, so the `prune` below finds nothing left to do (verified, git
# 2.50.1) — and it is only reachable at all once that remove has succeeded.
#
# Not git's own `prunable` annotation, which marks this entry but is not the
# same question: removing only a LIVE worktree's .git file marks it `prunable`
# too, with the directory and every uncommitted change still sitting in it.
# Keying on the annotation would skip the check on that one, and `worktree
# remove` then refuses it (rc 128) — so instead of the refusal the linkage guard
# below reaches on its own, the run gets as far as `halt` and exits 2 over a
# worktree still holding the work, reporting it as a claim nothing touched.
#
# Absence is ESTABLISHED by `gone`, never inferred from a failed -d, because -d
# is also false for a directory we are not permitted to stat — and on this path
# the delete-time recomputation the header leans on is absent (`worktree remove`
# accepts the entry either way, as `gone` explains), so this is the only check
# left standing. Read as "gone", an unsearchable prefix released the claim —
# branch deleted, label dropped, exit 0, `"blockers":[]` — with the member's
# uncommitted work still on disk and now orphaned.
#
# The -e test stays: `gone` reports a path that EXISTS as not-established-absent,
# which is the same answer it gives for one it cannot stat, and only the second
# is unknown.
if [ -n "$wt" ] && [ ! -e "$wt" ] && ! gone "$wt"; then
  die "cannot tell whether $wt exists, so whether it holds uncommitted work is unknown"
fi

# A lock refuses independently of the directory's shape — present, gone or a
# stand-in — so this runs whenever $wt is ours, not only when -d holds below.
# Without it a locked worktree cleared every blocker, the dry run predicted a
# release, and --apply reached `git worktree remove`, which refused it (rc 128)
# after the dirty check below had already said clean. See `locked` for why the
# answer is read off `wt_list`.
if [ -n "$wt" ] && locked "$wt"; then
  block "worktree $wt is locked — git worktree remove refuses a locked entry"
fi

# `worktree remove` validates $wt/.git before touching anything else, and a
# regular file sitting at $wt has none — refused at rc 128 ("does not exist"),
# measured. The dirty check below only opens when $wt IS a directory, so a
# non-directory there cleared every guard silently and only --apply found out.
#
# -L, and it is not what the -e/-d pair already covers: every other `test`
# primary FOLLOWS the link, so a symlink pointing at the real worktree directory
# reads as present-and-a-directory and walked through both of them. That one is
# the worst case in the file — `worktree remove` UNREGISTERS the entry and only
# then fails ("Not a directory", rc 255, measured on git 2.50.1), so the run
# halts reporting a worktree it did not remove after it had already landed
# something. A dangling link is the other shape: -e is false through it, so
# `gone` above calls it established-absent and the unknown-existence die stands
# down by design, leaving this the only guard between it and git's rc-128
# "'…/.git' does not exist" — the refusal the paragraph above was written for.
#
# -L tests the final component only, and `git worktree add` always creates that
# as a real directory, so no worktree this fleet made trips it.
if [ -n "$wt" ] && { [ -L "$wt" ] || { [ -e "$wt" ] && [ ! -d "$wt" ]; }; }; then
  block "worktree $wt exists but is not a directory — git worktree remove will refuse it"
fi

if [ -n "$wt" ] && [ -d "$wt" ]; then
  # Establish that a .git linkage EXISTS before believing the status below.
  # Delete the .git file outright — directory and every uncommitted file still on
  # disk — and `git -C` does not fail: it walks UP to the enclosing repository and
  # reports the PARENT's status at rc 0. `.worktrees/` is gitignored here, so the
  # worktree never appears in that status either: with a clean parent the answer
  # is empty, a positive assertion that the claim is clean produced without ever
  # having looked at it. The -d gate above does not reach it (the directory is
  # there) and neither does the status die below (git succeeded).
  #
  # Existence is not enough on its own: a .git naming a gitdir whose
  # core.worktree is some OTHER directory is a well-formed regular file too, and
  # git then answers happily about that other tree at rc 0 (measured, #135). The
  # block below closes that — this one only establishes the file is there to
  # examine.
  #
  # `-f` and not `-e`: an empty `.git` DIRECTORY leaks exactly like an absent
  # one — git walks up and reports the parent at rc 0 — and -e is true for it
  # (measured). A linked worktree's .git is always a regular file, since
  # `git worktree add` writes one, so -f costs nothing and refuses that too. A
  # dangling .git symlink is likewise rc 0, not the rc 128 the status die needs,
  # so this guard is what catches that one as well.
  #
  # `! -x` for the reason the block above gives: -f is ALSO false for a .git we
  # are not permitted to stat, and this guard may not infer absence from that any
  # more than -d may. An unsearchable worktree still has its .git, so leave it to
  # the status die, which keeps git's own "Permission denied" rather than
  # asserting an absence nothing established (measured: chmod 644 on the worktree
  # makes -f false with the .git sitting right there).
  [ -f "$wt/.git" ] || [ ! -x "$wt" ] || die "$wt has no .git file, so whether it holds uncommitted work is unknown"

  # Now establish the linkage points BACK at $wt, not merely that it exists.
  # Gated on -f rather than "we didn't just die": an unsearchable $wt fails -f
  # too, and this block must not run for it — `cd "$wt"` would fail differently
  # from git's own denial, replacing the "Permission denied" the status die
  # below is there to preserve with a message this script invented instead.
  #
  # `git -C "$wt" rev-parse --show-toplevel` answers with the linkage's own idea
  # of $wt's working tree, canonicalised — comparing it against $wt itself is
  # what closes the class (#74, #115, #135's own repro: a hand-written .git
  # naming a gitdir whose core.worktree is elsewhere makes this comparison
  # mismatch, refusing before the status below is ever believed).
  #
  # $wt must be canonicalised too, or this false-refuses a HEALTHY worktree:
  # `worktree list --porcelain` echoes the admin file's recorded path verbatim,
  # and that path can legitimately be non-canonical — reached through a
  # directory that was a plain dir at `worktree add` time and is a symlink now
  # (measured) — while `--show-toplevel` always answers canonical. `cd "$wt" &&
  # pwd -P` is the POSIX way to the same canonical form; no `realpath` needed,
  # and none is guaranteed to exist.
  if [ -f "$wt/.git" ]; then
    wt_canon=$(cd "$wt" && pwd -P) || die "cannot resolve $wt, so whether it holds uncommitted work is unknown"
    toplevel=$(git -C "$wt" rev-parse --show-toplevel) ||
      die "cannot read the git linkage of $wt, so whether it holds uncommitted work is unknown"
    [ "$wt_canon" = "$toplevel" ] ||
      die "$wt's .git does not point at $wt — it resolves to $toplevel — so whether it holds uncommitted work is unknown"
  fi

  # Same reason: folded-in stderr would be counted as uncommitted changes.
  if ! dirty=$(git -C "$wt" status --porcelain); then
    die "cannot read the status of $wt, so whether it holds uncommitted work is unknown"
  fi
  # Ignored files are deliberately not a blocker: claim-ticket.sh writes
  # agent-test and excludes it, so every fleet worktree has one, and blocking on
  # it would strand every claim. `git worktree remove` deletes ignored files
  # silently and refuses on modified and untracked ones (verified, git 2.50.1) —
  # which is this same check, recomputed by git at the moment of the delete, and
  # only while the directory is there. That is the header's live-directory case:
  # git gates that refusal on the same stat this block's `-d` gate does, so on a path
  # neither can stat it accepts the entry at rc 0 instead, and `gone` is what
  # stands between the member's work and the delete.
  n=$(printf '%s' "$dirty" | grep -c . || true)
  [ "$n" -eq 0 ] || block "worktree $wt has $n uncommitted change(s)"
fi

# Report the blockers before asking GitHub anything. The answer cannot change —
# every artefact stays put either way — and reaching for the tracker first turns
# an offline blocked claim into an unanswerable one, burying the finding the
# caller actually needs. "label":null says it was never read.
if [ -n "$blockers" ]; then
  echo "$NAME: #$issue NOT released — nothing was touched" >&2
  printf '{"issue":%s,"branch":"%s","branchRewritten":%s,"worktree":"%s","worktreeRewritten":%s,"label":null,"released":false,"applied":%s,"blockers":[%s]}\n' \
    "$issue" "$branch_j" "$branch_rw" "$wt_j" "$wt_rw" "$apply" "${blockers%,}"
  exit 1
fi

# Read the label before touching anything, so a tracker that cannot answer stops
# the run before any delete rather than halfway through it.
#
# One name per line, matched whole. Captured with 2>&1 and substring-matched,
# any stderr from a SUCCESSFUL gh — its "a new release is available" notice, an
# auth warning — broke the delimiting, the match missed, and the script deleted
# the worktree and the branch while leaving in-progress on the ticket: exit 0,
# "label":false, indistinguishable from a legitimately already-dropped label,
# and the ticket invisible to candidates.mjs with no artefact left to explain it.
echo "\$ gh issue view $issue --json labels" >&2
if ! labels=$(gh issue view "$issue" --json labels --jq '.labels[].name'); then
  die "gh issue view $issue failed, so the in-progress label cannot be released"
fi
if printf '%s\n' "$labels" | grep -qx in-progress; then has_label=true; else has_label=false; fi

if [ "$apply" = false ]; then
  echo "$NAME: DRY RUN — nothing removed. Pass --apply to act." >&2
  [ "$has_label" = true ] && echo "    would: gh issue edit $issue --remove-label in-progress" >&2
  [ -n "$wt" ] && printf '    would: git worktree remove %s\n' "$wt" >&2
  [ "$has_branch" = true ] && echo "    would: git branch -d $branch" >&2
else
  # Label LAST. The two local deletes are the ones that refuse — that refusal is
  # the dirty check recomputed by git at the moment of the delete, so it is
  # expected, not exceptional. Dropping the label first meant every such refusal
  # left in-progress already gone: with the worktree still standing the ticket
  # read free to candidates.mjs while re-claiming failed on the existing branch.
  # Run them first and a refusal leaves the claim exactly as it was, label and
  # all, which reads as still taken — the direction that costs nothing.
  if [ -n "$wt" ]; then
    # No --force, ever. A refusal is a finding to report, never something to
    # force past. Quote git's own reason: this fires precisely when something
    # appeared that the checks above did not see, so naming a cause here would
    # be a guess.
    printf '$ git worktree remove %s\n' "$wt" >&2
    # Measure on the REFUSAL only. git's two deletes are ordered, not atomic, so
    # a non-zero rc tells us a step failed and nothing about which — that is the
    # whole of #208. A zero rc is different in kind: both deletes completed, and
    # `Released` restates git's own success rather than inferring past a
    # failure. Re-measuring here would also make the happy path answerable by a
    # probe that can return Indeterminate, refusing releases that plainly worked.
    if ! err=$(git worktree remove "$wt" 2>&1); then
      wt_outcome=$(release_outcome "$wt")
      halt "git worktree remove refused $wt: $(printf '%s' "$err" | tr '\n' ' ')"
    fi
    wt_outcome=Released
  fi

  if [ "$has_branch" = true ]; then
    # -d, never -D. Unlike reap.sh's [gone] branches, this one still has its
    # upstream, so -d compares against THAT — origin/main for a fresh claim —
    # and accepts an unmodified claim even when local main is behind. A refusal
    # means the branch carries something the checks above did not see.
    echo "\$ git branch -d $branch" >&2
    if ! err=$(git branch -d "$branch" 2>&1); then
      halt "git branch -d refused $branch: $(printf '%s' "$err" | tr '\n' ' ')"
    fi
    done_branch=true
  fi

  if [ "$has_label" = true ]; then
    echo "\$ gh issue edit $issue --remove-label in-progress" >&2
    gh issue edit "$issue" --remove-label in-progress >/dev/null ||
      halt "could not drop in-progress from issue $issue"
  fi
  # Housekeeping, and the final statement under `set -e`: unchecked, a prune
  # failure exited 1 out of a release that had fully succeeded — the code this
  # script uses for "NOT released, nothing was touched" — before printing any
  # receipt. Nothing about the release depends on it, so it cannot decide the
  # exit status.
  git worktree prune || echo "$NAME: git worktree prune failed; the release itself is done" >&2
fi

printf '{"issue":%s,"branch":"%s","branchRewritten":%s,"worktree":"%s","worktreeRewritten":%s,"label":%s,"released":true,"applied":%s,"blockers":[]}\n' \
  "$issue" "$branch_j" "$branch_rw" "$wt_j" "$wt_rw" "$has_label" "$apply"
