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
# direction is a worktree that gained work after it was checked. Two of them are
# recomputed a second time at the moment of the delete, which is why both
# deletes run before the label is dropped rather than after.
#
# The dirty check's second opinion is git's own — that is what `worktree remove`
# without --force is for. It covers the live-directory case ONLY: `worktree
# remove` gates its own clean check on the same stat this script does, so
# wherever the path cannot be stat'ed git reaches the same conclusion rather
# than an independent one, and the guard at the dirty check below is left as
# sole arbiter — which is why it establishes absence instead of inferring it.
#
# The commit check's is this script's own: `-D` refuses nothing, so the `ahead`
# count is re-run against $base immediately before it. Why `-D` and not `-d`,
# and what that recount does and does not cover, is argued once at the delete
# site below — don't restate it here.
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
# Safe as a global: nothing in this script sorts, folds case, or holds a POSIX
# class. It does use ONE collation range — `*[!0-9]*`, the issue-number guard
# below — and a range IS locale-sensitive by spec, its members drawn from the
# collation sequence rather than the codepoint order. Measured inert here
# (#612): `0-9` matches the ASCII digits and nothing else under `C`,
# `en_US.UTF-8`, `de_DE.UTF-8` and `tr_TR.UTF-8` alike, with superscript `²`,
# Arabic-Indic digits and `½` excluded in all four. So collation and
# case-folding — the two things `LC_ALL=C` otherwise changes — have nothing
# here to act on. locale-pin-prose.test.mjs holds that inventory as a list and
# fails if the code drifts from this paragraph in either direction.
export LC_ALL=C

# Below the locale pin, not above it with `set -eu`: `unset` touches no
# byte-sensitive tool, but locale-pin-prose.test.mjs treats ANY line here that
# is not a comment, a blank, or `set -[eux]+` as work the pin must sit above,
# and refuses on principle rather than on this line's own behaviour.
#
# An ambient GIT_WORK_TREE outranks `-C`, not just plain discovery (measured,
# #427): with GIT_WORK_TREE alone pointing at an unrelated tree, `git -C "$wt"
# rev-parse --show-toplevel` answers about THAT tree, not `$wt` — the linkage
# guard below then blames a healthy `.git`, reporting it resolves to whatever
# the ambient var named. `git -C "$wt" status --porcelain` reads the same
# poisoned environment and would silently answer for the wrong tree too, just
# without a guard in front of it to say so. Every other git call in this
# script (no `-C` at all) is equally hostage to an ambient GIT_DIR retargeting
# it away from the repository the caller actually invoked this in. Unsetting
# both here, before any of them runs, is the one fix that reaches all of them
# at once — the same pattern `ledger.mjs` and `inflight.test.mjs` apply by hand
# per child process, under a comment making the same point: inherited git vars
# outrank cwd (and, here, outrank `-C` too).
#
# GIT_DIR alone does NOT reproduce the linkage guard's misdirection (measured):
# with no GIT_WORK_TREE, the work tree falls back to the discovery default and
# `-C "$wt"` still lands on `$wt`. That is a narrower claim than "GIT_DIR is
# harmless" — left ambient, it still retargets every OTHER git call in this
# script, the ones with no `-C` to even attempt insulating them.
#
# Both halves are pinned, one fixture each: GIT_WORK_TREE by the linkage-guard
# case, GIT_DIR by `an ambient GIT_DIR does not aim the release at another
# repository (#427)`. That second fixture measures the damage end-to-end
# through one of the `-C`-less calls: with only `unset GIT_WORK_TREE` here, the
# run reports `released: true` after deleting the claim's branch name in a
# DIFFERENT repository and leaving this repository's three artefacts intact.
# It pins the class named just above, not a line-by-line proof that every
# single `-C`-less call is retargeted.
#
# No fleet caller sets either var deliberately before invoking this script
# (checked: no assignment to GIT_DIR or GIT_WORK_TREE anywhere upstream of
# `release-ticket.sh` in this repo), so this closes the class with nothing
# left depending on the ambient value.
unset GIT_DIR GIT_WORK_TREE

NAME=release-ticket

# Assigned HERE, above `die`, and not next to `block` where the accumulator is
# otherwise used: `die`'s guard below reads `$blockers`, and `set -u` is
# satisfied by an INHERITED value just as well as by one this run computed. An
# ambient environment variable named `blockers` therefore took the guard true on
# every early die — before `$issue` is assigned at all — and the receipt printf
# then died on `issue: unbound variable`, losing the diagnostic the die exists
# to print. A plain assignment overrides whatever was inherited, so the guard
# once again means "this run accumulated something". The exit code that mistake
# produced is platform-asymmetric (bash-as-/bin/sh gives 1, dash gives 2), which
# is why the pin in the tests is on the prose and not on a number.
blockers=""

# A `die` firing after a `block` used to discard every accumulated blocker —
# exit 2, prose on stderr, and no JSON receipt at all, so a caller that already
# had real findings computed got none of them. The guard is on non-empty rather
# than on existence, which keeps every early die — before json.sh is sourced
# below, before anything is accumulated — byte-identical to today: no
# `$blockers` reference is even reached.
#
# Approach 2 (#387): print the same receipt shape the blocked checkpoint and
# `halt` already use, with `$1` appended to `$blockers` exactly as `block`
# would have recorded it — not a new schema, and not a second write. Approach 1
# (emit the receipt as soon as blockers goes non-empty, before whatever can
# die) was ruled out: it lets a run print a receipt and then keep going and
# fail anyway, which is a run with two writes or a receipt describing a state
# the run then left. `label` is `null` here as it is at that checkpoint — the
# label is read after every one of these dies can fire, so this receipt cannot
# claim to know it. `$blockers` already ends in a trailing comma (`block`'s own
# accumulator does that), so splicing the newly-escaped `$1` straight after it
# needs no separator of its own — which is done in the ARGUMENT, so this format
# string stays byte-identical to the blocked checkpoint's rather than growing a
# second blockers slot only this one caller uses.
#
# release-ticket.test.mjs's "block() then die() compose a receipt that still
# parses as JSON, blockers in order (#1080)" pins this by name: two `block()`
# calls, then a `die()` splice, composed for real rather than reasoned about
# by hand the way PR #983 did. Mutation-verified both directions — `block`
# dropping its comma, or appending two instead of one — reds that test.
#
# The `||` arm is the receipt's only voice. `|| die` is what `block` and `halt`
# use and is unavailable here — it would recurse — so a bare `&&` chain left BOTH
# its failures mute: a failed `jstr`, and a failed write. The second is the worse
# one and is not a silent degrade at all: with the chain as the last command
# before `fi`, a receipt printf that cannot write (closed fd, EIO, a full disk on
# a redirect) takes `set -e` and kills the function before its own stderr prose
# below, so the die reason vanishes and the script exits 1 — this script's
# `NOT released` verdict, fabricated out of a write error. Measured on /bin/sh
# (bash 3.2), /bin/dash and bash 5.3; zsh alone survived it. The arm ends the
# list so nothing is left to trip, and it names neither failure specifically,
# because `a && b || c` fires `c` for both and this file does not report a cause
# it did not measure.
die() {
  if [ -n "${blockers:-}" ]; then
    die_j=$(jstr "$1") &&
      printf '{"issue":%s,"branch":"%s","branchRewritten":%s,"worktree":"%s","worktreeRewritten":%s,"label":null,"released":false,"applied":%s,"blockers":[%s]}\n' \
        "$issue" "$branch_j" "$branch_rw" "$wt_j" "$wt_rw" "$apply" "${blockers}\"$die_j\"" ||
      printf '%s: no JSON receipt for #%s — the escape or the write failed\n' "$NAME" "$issue" >&2
  fi
  printf '%s: %s\n' "$NAME" "$1" >&2
  exit 2
}


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

# The worktree readers (#551, #725). worktree.sh's header holds the sourcing
# contract and the measurements behind it, and json.sh's holds the `[ -r ]`
# reasoning both guards share. This script reads exit 1 as its own blocked
# verdict, which is the whole reason that guard is not `|| die` alone.
wt_lib="$(dirname "$0")/worktree.sh"
[ -r "$wt_lib" ] || die "cannot read $wt_lib — refusing to act without the worktree readers"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=worktree.sh
. "$wt_lib" || die "$wt_lib failed to load"

# The bounded, prompt-suppressed git transport (#92, #346, #347). The
# pushed-branch lookup below is unattended: with no bound it can prompt for a
# credential or a host key, or stall on a transport that connects and then goes
# quiet, and either holds a fleet slot until something outside kills it.
# net.sh's header holds the reasoning and the measurements. Sourced below
# json.sh so a lone copy of this script still blames json.sh, the name its
# missing-library test pins.
net_lib="$(dirname "$0")/net.sh"
[ -r "$net_lib" ] || die "cannot read $net_lib — refusing to act without the bounded git transport"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=net.sh
. "$net_lib" || die "$net_lib failed to load"

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
# The accept-list alone does not deliver that: `origin/$branch` IS a
# remote-tracking ref and passes it, while making both guards vacuous in exactly
# the way described above — ahead 0 and cherry empty against the branch's own
# upstream, whatever it carries. `-D` then deletes a commit that exists nowhere
# else at exit 0. Name-based, not a rev-parse comparison: a pristine claim's tip
# legitimately equals origin/main's, so equal SHAs are the normal case.
case "$base" in
  */"$branch") die "BASE_REF must not name the claim's own branch, got '$base'";;
esac

# Neither guard above can see the third route to a vacuous $base, because the
# hijack is spelled as the legitimate DEFAULT. `origin/main` is a SHORTHAND, and
# git resolves a shorthand through its own disambiguation order (gitrevisions:
# refs/<name>, refs/tags/<name>, refs/heads/<name>, refs/remotes/<name>, …), in
# which refs/remotes/origin/main comes LAST. So a local TAG named `origin/main`
# — `git tag origin/main refs/heads/$branch` — outranks the remote-tracking ref
# and every measurement against $base then answers about the claim's own tip:
# ahead 0, cherry empty, and the delete-time recount 0 as well. All three guards
# vacuous at once, and `-D` refuses nothing, so the branch and its unpushed
# commit are destroyed at exit 0 with "released":true and an empty blocker list.
# Measured on a real bare-origin fixture; `git rev-parse origin/main` prints the
# tag's OID under git's own `refname 'origin/main' is ambiguous` warning, which
# nothing here reads. Pre-#760 `-d` refused this ("not fully merged") — the
# guards were already vacuous under it, so `-d` was the sole backstop, and this
# is the one class its removal reopened.
#
# The fix is to stop MEASURING against a shorthand: the accept-list already
# establishes $base names a remote-tracking ref, so qualify it to the full
# refs/remotes/ path, where there is nothing left to disambiguate. $base itself
# is unchanged and stays in every user-facing message — `12 commit(s) ahead of
# origin/main` is what an operator wants to read, not the qualified spelling.
case "$base" in
  refs/remotes/*) base_rev=$base;;
  *) base_rev="refs/remotes/$base";;
esac

git rev-parse --git-dir >/dev/null 2>&1 || die "not inside a git repository"
git rev-parse --verify "$base_rev" >/dev/null || die "$base does not resolve"

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

# A function, not inline, because the count is taken twice: once here, and
# once more at the recount below if the cross-check disagrees with git's own
# listing (#694). The body is unchanged from what stood here as plain
# top-level code before this ticket — mirrors inflight.sh's own
# count_registry, which the same recount need already lives behind there,
# adapted for the difference the ticket turns on: that copy returns a status
# into an accumulate-and-continue probe, this one dies, so the loop itself
# still just dies on an unreadable registry rather than returning past it.
count_registry() {
  registered=0
  [ -e "$wtroot" ] || return 0
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
  return 0
}
count_registry

# The path is the whole rest of the line, never $2: `worktree list --porcelain`
# prints it raw, so any checkout living under a directory with a space in it —
# ordinary on macOS — would otherwise be truncated at the first one.
#
# A newline in that path was the same truncation one byte further out: the plain
# porcelain ends every attribute with one, so the record split and every
# `substr($0,10)` below stopped at the newline. `wt_listing` reads `-z` and
# swaps the separators, so a record ends where git says it ends. #551
#
# `|| die`, where this was a bare assignment: left bare the read died on `set -e`
# under git's own diagnostic, with no line carrying the `release-ticket:` prefix
# a caller greps stderr for — the very reason every lookup OVER this listing is
# already guarded that way.
#
# A function, not inline, because the recount below (#694) needs this whole
# pair — git's own read and the count derived from it — re-taken TOGETHER, not
# just re-assigned in isolation. `linked` and `wt_list`/`wt_err` are this
# function's OUTPUT, exactly as `registered` is `count_registry`'s.
count_linked() {
  wt_listing || die "could not read the worktree list for #$issue: $wt_err"
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
  #
  # What this count does NOT cover, stated because it reads as though it might: a
  # path with a newline in it never moved this number. The orphaned continuation
  # line the plain porcelain produced did not begin `worktree `, so `listed - 1`
  # still equalled `registered` and the cross-check AGREED with a read that had
  # truncated the path. Re-measured on a real linked worktree added at
  # `…/wt/fix-33<LF>slug`, git 2.50.1 (Apple Git-155):
  #
  #   git worktree add -b fix/33-slug "../wt/$(printf 'fix-33\nslug')"
  #   git worktree list --porcelain | awk '/^worktree /{n++} END{print n+0}'
  #   ls .git/worktrees | wc -l
  #
  # `listed - 1` equals `registered` while the same listing's `substr($0,10)` hands
  # back `…/wt/fix-33`, a path `[ -d ]` says is not there. The blindness is the
  # point, not the arithmetic: the orphan line adds no `worktree ` line, so no
  # count over this listing can see the truncation. It is a count of records against
  # registry entries and catches an entry git DROPPED; the path inside a record it
  # does keep is `nl_path`'s to refuse, below. Under `-z` the count is now right by
  # construction — one `worktree ` line per record, whatever the path holds. #551
  listed=$(printf '%s\n' "$wt_list" | LC_ALL=C awk '/^worktree /{c++} END{print c+0}') ||
    die "could not count the worktrees git listed for #$issue"
  # The `|| die` above closes only the route where awk could not RUN. An empty but
  # SUCCESSFUL listing reaches the same -1: awk exits 0 printing `0`, the guard
  # cannot fire, and the mismatch report below blames `git worktree list` for the
  # very count the guard above exists to keep out of an operator's face. One
  # comparison closes it for every branch below at once. `-ge 1`, not `-gt 1`:
  # `listed=1` is the main checkout alone, `linked=0`, the ordinary repo with no
  # linked worktree at all — a guard that refused that would refuse most releases
  # in this repo. Real `git worktree list --porcelain` always prints the main
  # worktree, so reaching this needs a broken or shimmed git; the refusal
  # direction was already right, only the number was nonsense. #699
  [ "$listed" -ge 1 ] ||
    die "git listed no worktrees at all for #$issue — not even the main checkout, so the listing cannot be trusted"
  linked=$((listed - 1))
}
count_linked
# Name the direction actually observed. The two disagreements have opposite
# causes and send the reader to opposite places, so one message cannot serve
# both: FEWER listed than registered is git silently dropping an entry it could
# not read, which is the fault this whole check exists to catch. MORE listed
# than registered is the reverse — the on-disk count is the stale read, a
# sibling agent's `git worktree add` having landed between the two, which in a
# parallel fleet is routine rather than exotic. Calling that "the listing is
# incomplete" sends an operator hunting a permissions fault that is not there.
# Recount before refusing (#694). The registry scan above and git's listing
# just taken are two reads at two different instants, not one atomic read, and
# a sibling agent's `git worktree add` or `remove` landing in the gap makes the
# two counts disagree with nothing actually wrong — measured against this
# script directly: 3/100 dry-run releases aborted on this cross-check under a
# throttled churner, 48-66/80 unthrottled, all with zero real faults among them.
#
# inflight.sh already recounts here (#694) into
# its own accumulate-and-continue probe; this script's whole contract is `die`
# on any unmet precondition instead, so the port keeps that shape rather than
# inheriting the accumulator. Both copies recount BOTH `registered` and
# `linked` — this one from #1408, inflight.sh's from #1421, which closed the
# same window in that copy. Re-taking `registered` alone leaves
# `linked` pinned to the FIRST `wt_listing` call: a second sibling mutation
# landing after that call returns but before the lone recount re-scans the
# registry inflates `registered` without touching `linked`, which can flip
# which branch fires below and name the wrong cause — reporting "the listing
# is incomplete" (implying a fault) for what is, underneath, the same benign
# race the elif below already names correctly. Verified against this script
# directly with a shim landing a second mutation in exactly that window.
#
# A mutation landing between the FIRST count and git's listing is already
# reflected in that listing, so the second count agrees with it — that is the
# invariant the ORIGINAL pair above relies on. Recounting `registered` and
# `linked` together, in the same order (`count_registry` first, `count_linked`
# second, mirroring lines 364-434 above), gives the RECOUNT pair that same
# invariant: escaping it needs a mutation inside the narrower window these two
# calls open between themselves, not the whole span back to the first
# `wt_listing` (measured on inflight.sh's copy while it was still
# registered-only, the same shape of window: 1.99% -> 0.00% at 2 mutations/s,
# 56.6% -> 1.29% saturated). A
# genuinely dropped entry is a standing state, not a moment, so it survives
# the recount and still refuses. The unreadable-registry case above is
# unaffected: `count_registry`'s own `[ -r ] && [ -x ]` guard on $wtroot dies
# the same way on either call, before the recount is ever reached. The
# cannot-read-inside case is NOT unaffected the same way — an entry inside
# $wtroot that `ls -A` cannot read is counted as registered rather than
# dying (above), so a stale one survives the recount too, but what fires on
# it is the mismatch below, not `count_registry` itself: a different guard,
# a different exit code, under "the listing is incomplete" — a cause that
# is not actually what happened.
[ "$linked" -eq "$registered" ] || { count_registry; count_linked; }
if [ "$linked" -lt "$registered" ]; then
  die "git listed $linked worktrees for $registered registry entries in $wtroot — the listing is incomplete, so no absence it reports can be trusted"
elif [ "$linked" -gt "$registered" ]; then
  die "git listed $linked worktrees but only $registered registry entries were counted in $wtroot — the registry read missed entries git can see, so no absence it reports can be trusted"
fi

# Every lookup ASSIGNED from the listing is guarded, for the reason the worktree
# counter above is: left bare, an awk that could not answer ends the run on its
# own diagnostic, with no line carrying the `release-ticket:` prefix a caller
# greps stderr for. The lookups OVER it are guarded too, but never this way —
# `locked` and `unresolved_head` below read the same `$wt_list` through awk and
# answer THROUGH its exit status, where telling "could not run" from "no match"
# needs more than a `|| die`. Each captures that status itself and refuses above
# the range its answer occupies; `locked` carries why (#454).
#
# Neither #243 trigger is what makes these guards worth having, and both are
# narrower than they look. A newline in <slug> reaches the branch lookup as a
# `-v` value, where BSD awk refuses it outright but mawk and gawk accept it
# (measured), so on those the run simply walks past. An undecodable byte would
# arrive as record data instead — the trigger no policy on <slug> could also
# cover — but it is held shut here by one line, `export LC_ALL=C` above: under
# a UTF-8 locale these very programs exit 2 on such a byte, under `C` they read
# it as data (both measured, #582). What the guards actually answer for is an
# awk that could not run AT ALL, which no locale or implementation rules out.
#
# Guarding these ASSIGNMENTS cannot turn an empty answer into a refusal: none of
# them has a non-zero `exit`, so matching nothing is status 0 (measured), and an
# absent worktree stays the answer the checks below expect. The predicates are
# the opposite case — their `exit` is how they answer at all — which is why the
# same sentence cannot be written about them and why their guard is not this one.
wt=$(printf '%s\n' "$wt_list" |
     awk -v b="refs/heads/$branch" '/^worktree /{w=substr($0,10);n++} /^branch /&&$2==b&&n>1{print w}') ||
  die "could not read the worktree git listed for #$issue"
main_branch=$(printf '%s\n' "$wt_list" | awk '/^worktree /{n++} n==1&&/^branch /{print $2; exit}') ||
  die "could not read the main checkout's branch from git's listing for #$issue"
# The main checkout's path, and the anchor the orphan probe below reconstructs a
# claim's directory from. Off git's own listing rather than $PWD: this script is
# routinely run from inside a member's worktree, where a cwd-relative
# ".worktrees/..." names nothing.
main_wt=$(printf '%s\n' "$wt_list" | awk '/^worktree /{print substr($0,10); exit}') ||
  die "could not read the main checkout's path from git's listing for #$issue"

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
#
# Except that it DOES move: `git worktree move` renames the directory, and the
# suffix stops matching (measured, git 2.50.1). On its own that is a miss, not a
# fault — a moved worktree still on this branch is found by `wt` above. The two
# together are the fault: a claim whose HEAD git cannot resolve loses its
# `branch` line, so `wt` is empty, and if it was ALSO moved then `stray` is empty
# too — both blindnesses from the same claim, and the arms below never run. The
# script then released it: branch deleted, label dropped, `released:true` at rc
# 0, over a directory holding staged work and no longer reachable as a
# repository (measured, on the fixture this file's suite now carries).
#
# The registry ENTRY is what survives a move, and it is the only handle left on
# such a claim — but an entry is a NAME, and a name cannot prove ownership, so
# it answers only as a corroborated fallback, below the predicates that
# corroboration needs — `entry_stray`, after `unresolved_head`. The suffix key
# here is unchanged, and answers first.
#
# Through the ENVIRON, not `-v`, for the reason `locked` gives: `-v` processes
# escape sequences in its value, so a needle holding a literal backslash arrives
# mangled and can then never equal what the porcelain printed byte-for-byte.
# Unlike `locked`'s path, this needle is built from argv rather than read off
# disk — but argv is not exempt from a backslash either, and awk itself still
# exits 0 having simply matched nothing: the permissive answer, in a probe whose
# whole job is to catch a claim whose branch moved (#799). ENVIRON does no such
# processing.
stray=$(printf '%s\n' "$wt_list" |
        D="/$issue-$slug" awk '/^worktree /{n++; p=substr($0,10); d=ENVIRON["D"]
          if (n>1 && substr(p, length(p)-length(d)+1) == d) {print p; exit}}') ||
  die "could not scan git's listing for a stray worktree for #$issue"

has_branch=false
git rev-parse --verify --quiet "refs/heads/$branch" >/dev/null && has_branch=true

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
# attempted — the worktree removal when there is one, `git branch -D` when the
# registration is already cleared — refuses with nothing landed, and announcing
# a partial release over that overstates exactly the state this script exists to
# report precisely. A partial release is a refusal that followed a successful
# mutation. Distinct again from the blocked message that reports refused
# preconditions, which means nothing was ATTEMPTED.
#
# The two are NOT a matched pair, and one evenly-shaped detail line asserted
# that they were. `git branch -D` updates a ref, which lands or does not, so a
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
# Why the measurement could not be taken, empty whenever it could. Only
# `Indeterminate` ever carries one, and `halt` appends it to that state's report:
# "could not be measured" names the failure without naming its cause, which is
# the one line an operator mid-release has nothing else to go on. #551
wt_why=
done_branch=false
halt() {
  if [ -n "$wt" ]; then
    case $wt_outcome in
      Unreleased) landed="registration and directory both still present";;
      Deregistered) landed="the registration is cleared, the directory is still on disk";;
      Released) landed="registration and directory both gone";;
      *) landed="what the removal landed could not be measured";;
    esac
    [ -z "$wt_why" ] || landed="$landed: $wt_why"
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

# Assigned first, exactly as `halt` does above: a `$(jstr …)` spliced straight
# into the accumulator is not a simple command, so `set -e` reads only the
# assignment and a failed escape would abort at exit 1 — this script's blocked
# verdict — with neither the receipt that verdict carries nor a line on stderr.
block() {
  block_j=$(jstr "$1") || die "could not escape the blocker for #$issue"
  blockers="${blockers}\"$block_j\","
  printf '    BLOCKED: %s\n' "$1" >&2
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
# And the status is CAPTURED rather than answered with, for the same reason one
# rung down (#454). This predicate's answer IS awk's exit status — 0 locked, 1
# not locked — so an awk that could not run lands above both and, called in a
# condition as both callers must call it, is read as the FALSE answer: "not
# locked" again, the permissive one. Measured through this script with awk
# failing only for the program holding this lock test: the lock blocker never
# fires, the run asks the tracker and reaches `git worktree remove`, and the
# receipt then blames the lock rather than the tool that could not answer.
# `set -e` catches none of it — it is ignored throughout a function invoked in a
# condition, measured on /bin/sh (bash 3.2), /bin/dash, bash 5.3 and zsh — and
# the `|| die` the assignments above use cannot serve here, because there is no
# status left over to die on once the answer has consumed it.
#
# `&& return 0` ahead of the status test, not a bare pipeline whose status the
# next line reads: that makes the pipeline a non-final AND-OR element, where
# `set -e` is ignored in EVERY context, so a bare call outside a condition
# reaches the guard as well. Written the bare way that same call never reaches
# the guard at all — `set -e` kills the script on the pipeline itself, silently,
# carrying awk's own status out instead of this guard's exit 2 and its
# `$NAME`-prefixed diagnostic. Not a fail-open: the bare form answers nothing,
# it dies unattributably (measured, /bin/sh and /bin/dash, awk exiting 2, 5
# and 127).
locked() {
  printf '%s\n' "$wt_list" |
    P="$1" awk '/^worktree /{cur=(substr($0,10)==ENVIRON["P"])} cur&&/^locked/{f=1} END{exit !f}' && return 0
  [ $? = 1 ] || die "could not read whether the worktree at $1 is locked for #$issue"
  return 1
}

# Did git fail to resolve $1's HEAD, rather than find it genuinely detached or
# on some other branch? Four ways an admin HEAD file breaks all produce the
# same porcelain shape — the null object id with no `branch` line: `chmod 000`
# on it, garbage content in it, a dangling symlink in its place, or a
# directory in its place (measured, git 2.50.1). release-ticket.test.mjs
# builds all four. `chmod 000` is the only one needing a permission bit, so it
# alone carries the `EUID0` skip the file's other permission fixtures do and
# measures nothing on a root runner; the other three reproduce as any user.
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
#
# The status is tested for the reason `locked` gives, and the permissive
# answer here is the one this arm exists to stop being given: an awk that could
# not run reads as "HEAD resolves fine", the run falls through to the
# branch-mismatch `else`, and the receipt asserts the worktree is not on the
# claim's branch — about a HEAD nothing could read.
unresolved_head() {
  printf '%s\n' "$wt_list" |
    P="$1" awk '
      /^worktree /{cur=(substr($0,10)==ENVIRON["P"])}
      cur&&/^HEAD 0+$/{nullhead=1}
      cur&&/^branch /{hasbranch=1}
      END{exit !(nullhead && !hasbranch)}' && return 0
  [ $? = 1 ] || die "could not read whether git can resolve the HEAD of the worktree at $1 for #$issue"
  return 1
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

# The registration PROBE at the heart of the arm below: is $1 still listed in
# $now, the fresh post-removal listing? #798. `locked` and `unresolved_head`
# read their own awk's exit status STRAIGHT as the answer — 0 true, 1 false —
# so an awk that could not run (rc >= 2: killed, OOM, a broken interpreter) and
# an awk that ran fine and found no match (rc 1, the genuine "not registered")
# both land on the false side of the same elif, and #798 measured what that
# fold did here: with nothing left to distinguish them, the run fell through to
# `elif occupied "$1"; then wt_outcome=Deregistered` and wrote a false
# Deregistered into the JSON receipt for a registration nothing established was
# actually cleared.
#
# `locked` and `unresolved_head`'s own fix (#454) is not enough copied
# verbatim: both `die` on an awk that could not run, which is right for a
# precondition gate — abort before any mutation is attempted — and wrong here.
# `release_outcome` runs AFTER `git worktree remove` has already run, is called
# as a bare statement rather than inside a `$( )`, and its caller reads
# `$wt_outcome` right after the call returns; a `die` here would abort the
# function with nothing set — worse than the defect it replaces. Nor can the
# status be captured with a bare pipeline followed by a separate `reg=$?` line:
# measured, that does not survive this script's `set -eu` either — `set -e`
# kills the script on the pipeline itself before the assignment is ever
# reached. So this stays a boolean predicate in the `locked`/`unresolved_head`
# shape — a non-final AND-OR element (`… && return 0`), never a bare pipeline
# whose status a later line reads — but the "could not run" case is carried out
# through `$wt_why` instead of `die`, for `release_outcome` to route to
# Indeterminate exactly as it already does for a listing git could not
# produce, one arm up. 0 registered, 1 genuinely not registered (`$wt_why`
# stays empty, already cleared by the caller before this runs), anything else
# could not be told apart from "not registered" by rc alone (`$wt_why` is set
# to say so, straight into the field the caller already reserves for it).
ro_registered() {
  printf '%s\n' "$now" |
    P="$1" awk '/^worktree /{if (substr($0,10)==ENVIRON["P"]) f=1} END{exit !f}' && return 0
  [ $? = 1 ] || wt_why="could not tell whether $1 is still registered for #$issue"
  return 1
}

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
# cannot-stat apart. No second predicate and no third value inside `gone`: it is
# now a single definition in worktree.sh that every caller in the fleet shares,
# so a third value added for this one caller lands in all of them — and this file
# already carries two answers on unreadable worktrees (#83) from a concept that
# got duplicated. #725
#
# Only the four named states, so the two cells CONTEXT.md has no name for are
# not asserted: a registration that survived a directory that did not is
# reported Indeterminate rather than squeezed into Unreleased, whose definition
# is that BOTH are still present.
# Writes `$wt_outcome`, and `$wt_why` whenever the answer is Indeterminate for a
# reason git named. It does NOT echo the state: a `$( )` around the call would
# put the whole body in a subshell, and the cause — which `wt_listing` leaves in
# `$wt_err` — would die with it. That is not hypothetical, it is what this
# function did: the one case where the headline degrades to "what landed could
# not be measured" was the one case whose cause never reached the operator, on
# stderr or in the receipt. Assigning globals is what carries it out. #551
release_outcome() {
  # `wt_listing` writes the shared `$wt_list`, and this function must not disturb
  # the pre-mutation capture the guards above read off it. Saved and put back in
  # the same breath — and now load-bearing rather than defensive, because without
  # the subshell there is nothing else keeping the two reads apart.
  ro_prior=$wt_list
  ro_read=true
  wt_listing || ro_read=false
  ro_err=$wt_err
  now=$wt_list
  wt_list=$ro_prior
  wt_why=
  if [ "$ro_read" = false ]; then
    # The listing is how the registration is read, so a listing git could not
    # produce leaves the registration unknown — not absent. `$ro_err` is git's
    # own prose for why it could not, flattened to one line for the receipt.
    wt_outcome=Indeterminate
    wt_why=$(printf '%s' "$ro_err" | tr '\n' ' ')
  elif ro_registered "$1"; then
    if occupied "$1"; then wt_outcome=Unreleased; else wt_outcome=Indeterminate; fi
  elif [ -n "$wt_why" ]; then
    # awk could not run at all (rc >= 2), which is a different fact from
    # "ran fine and found nothing" — the latter alone means Deregistered is on
    # the table below. #798
    wt_outcome=Indeterminate
  elif occupied "$1"; then
    wt_outcome=Deregistered
  elif gone "$1"; then
    wt_outcome=Released
  else
    wt_outcome=Indeterminate
  fi
}

# A path holding a newline, refused rather than acted on. `wt_listing` delivers
# it whole with the newline substituted, and the substituted byte is one no
# `git worktree remove`, no `[ -d ]` and no `git -C` below can name — so every
# check over it would answer about a different path, which is exactly the silent
# truncation this ticket exists to end. #551
#
# `block`, not `die`: this is a refused precondition like every other one here,
# and the caller gets the receipt that verdict carries. `nl_path ""` is false, so
# a lookup that found nothing is unaffected.
#
# All three keys, because they are three different routes to a worktree of this
# claim's and a newline anywhere in the chain is the same defect: `wt` off the
# branch line, `stray` off the directory-name suffix, and `main_wt` — which the
# orphan probe below builds its path from, so a truncated one sends that probe
# at a directory nobody registered.
if nl_path "$wt"; then
  block "worktree $wt holds a newline in its path — nothing here can stat it, so whether it holds work is unknown"
fi
if nl_path "$stray"; then
  block "worktree $stray holds a newline in its path — nothing here can stat it, so whether it holds work is unknown"
fi
if nl_path "$main_wt"; then
  block "the main checkout $main_wt holds a newline in its path — no path this script builds from it can be stat'd"
fi

if [ "$main_branch" = "refs/heads/$branch" ]; then
  block "branch $branch is checked out in the main checkout — release it from elsewhere"
fi

# The registry ENTRY as a second key for this claim's worktree, consulted ONLY
# when the suffix key found nothing. `git worktree move` renames the directory
# and rewrites the entry's `gitdir` file to follow it, but never renames the
# ENTRY (both measured, git 2.50.1) — so a moved claim whose HEAD git cannot
# resolve, invisible to `wt` and to the suffix key alike, is still reachable
# through `$wtroot/$issue-$slug/gitdir`. That file holds `<worktree path>/.git`,
# and the path git prints in the porcelain is its content with `/.git` stripped,
# echoed VERBATIM with no canonicalisation of its own (measured: a hand-written
# `gitdir` naming a path through a symlink is printed back through the symlink),
# which is what lets the comparison be byte equality against the listing rather
# than a second opinion about the same path.
#
# The entry NAME cannot prove ownership, and the union this fix first shipped
# assumed it could. git derives the name from the directory's basename at
# `worktree add` and appends a digit when that name is taken, so an unrelated
# worktree registered first under `<issue>-<slug>` owns that entry while this
# claim's is `<issue>-<slug>1`; if that stranger is then MOVED its path no
# longer carries the suffix, and this key reaches a worktree the suffix key
# never would. Measured on that fixture, as a plain union: a claim with nothing
# left to release went from `released:true` at rc 0 to a permanent refusal
# naming the stranger's directory as this claim's, and a claim whose own HEAD
# was unreadable had the correct cause over its own directory replaced by the
# wrong cause over the stranger's. Both are pinned below.
#
# So corroborate rather than trust, and let the suffix key answer first. A
# worktree that resolves to a branch which is not this claim's is demonstrably
# not this claim's — the `else` arm below says exactly that about it — so it
# must not refuse the release. One whose HEAD git cannot read MAY genuinely be
# this claim's, and refusing is the safe direction there; the blocker then
# states only what the entry establishes, which is the entry NAME.
#
# Through the ENVIRON, not `-v`, for the reason `locked` gives: this key is a
# path read off disk, and a `-v` assignment processes escape sequences in it, so
# a repo under a directory with a backslash in its name would arrive mangled and
# the comparison would fall to the permissive answer — no match, and back to the
# silent release this exists to stop. The suffix key above went through ENVIRON
# too, for the same reason (#799): its needle is built from argv rather than
# read off disk, but argv is not exempt from a backslash either.
#
# Absent entry, unreadable entry, or one pointing somewhere git is not listing:
# `entry_stray` is empty and the suffix key alone answers, exactly as before.
# Not a fail-open — an entry git could not read is one git drops from the
# listing, and the listed-vs-registered count above refuses first.
stray_own="is this claim's"
# WHICH entry, for the unresolved-HEAD arm alone. That arm is the one fault with
# no remedy to name — measured on a corrupt-HEAD entry, `git worktree repair`
# and `git worktree prune -v` both leave it standing at rc 0, and `remove` with
# and without `--force` both refuse at rc 128 — so "by hand" is the instruction
# and the only thing left to hand over is where by hand goes.
#
# A search, not a name built from the directory. The entry name is git's own,
# on the two measurements the block above already turns on. So `${stray##*/}`
# would assert a path this script never read, which is the defect class #179
# exists to remove, and after a move or behind an entry thief it resolves to
# somebody else's entry outright.
#
# `-x`, not a substring: `gitdir` holds exactly one line whose whole content is
# `<path>/.git`, so whole-line equality is the precise test and subsumes the
# `/.git` anchor. A substring is wrong in BOTH directions — it hits a sibling
# whose directory extends this one (measured: a search for a `9-x` worktree
# also hits `9-x-renamed`'s entry) and one registered under a path that ends
# with this one. `-F` because the subject is a path and its metacharacters are
# not a pattern.
#
# SINGLE quotes around both paths, glob outside them, because this string is
# pasted into a shell and a path is not shell text: under double quotes a `$`
# in the path expands again when the operator runs it and the search comes back
# EMPTY at rc 1 — no entry reported while the entry is right there, this arm's
# own defect one step further out — and an unquoted `$wtroot/*/gitdir` splits
# on a space. A literal `'` in the path still defeats this, acceptably: it
# breaks the pasted command LOUDLY (`unexpected EOF`, rc 2, measured) rather
# than answering wrongly.
#
# Empty on the entry key, which read `$wtroot/$issue-$slug/gitdir` itself and
# puts that name in `$stray_own`: searching for what it already measured would
# be the step backwards. Assigned before that key can answer, so `$stray` here
# is the suffix key's or nothing.
stray_find="; find that entry with: grep -Fxl '$stray/.git' '$wtroot'/*/gitdir"
if [ -z "$wt" ] && [ -z "$stray" ] && [ -r "$wtroot/$issue-$slug/gitdir" ]; then
  entry_wt=$(cat "$wtroot/$issue-$slug/gitdir") ||
    die "could not read the worktree registry entry $wtroot/$issue-$slug/gitdir for #$issue"
  entry_wt=${entry_wt%/.git}
  entry_stray=$(printf '%s\n' "$wt_list" |
                E="$entry_wt" awk '/^worktree /{n++; p=substr($0,10)
                  if (n>1 && p == ENVIRON["E"]) {print p; exit}}') ||
    die "could not scan git's listing for a stray worktree for #$issue"
  if [ -n "$entry_stray" ] && unresolved_head "$entry_stray"; then
    stray="$entry_stray"
    stray_own="holds this claim's registry entry name $issue-$slug"
    stray_find=
  fi
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
  #
  # `$stray_own` says which key found this worktree, because only the suffix key
  # establishes that it is this claim's. The `else` keeps the literal: it is the
  # `! unresolved_head` branch, and the entry key is credited only where
  # `unresolved_head` is true, so `$stray_own` can never be the entry phrase by
  # the time control reaches it.
  if locked "$stray"; then
    block "worktree $stray $stray_own and is locked — git worktree unlock $stray, then prune or remove it"
  elif gone "$stray"; then
    block "worktree $stray $stray_own and its directory is gone — git worktree prune to clear the registration"
  elif unresolved_head "$stray"; then
    block "worktree $stray $stray_own but git could not read its HEAD, so its branch is unknown — inspect its entry's HEAD file under $wtroot by hand$stray_find"
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
  elif [ "$has_branch" = false ] && [ -z "$blockers" ]; then
    # A mistyped <slug>/<type> names a branch that does not exist, and without
    # this die the run would drop the label off a ticket whose real claim is
    # untouched — invisible to candidates.mjs and still in-flight. Refuse
    # instead of guessing.
    #
    # Deferred past the orphan probe above (#624) rather than fired the moment
    # `has_branch` reads false: this exact input — no branch, no worktree, no
    # stray — is also what #208's knock-on leaves behind, a claim whose branch
    # a prior half-release already deleted with its directory still on disk.
    # Fired unconditionally, that state got the same "check the <slug> and
    # <type> arguments" prose as a genuine typo, naming the wrong cause over a
    # directory sitting right there with a real remedy. The orphan probe above
    # answers that question first, so this die runs only once it has had its
    # say.
    #
    # The `-z "$blockers"` conjunct is load-bearing, not dead weight (a prior
    # round of this comment argued the opposite and was wrong): `$blockers` can
    # be non-empty here even though this arm's own occupied/gone siblings above
    # did not fire. `git checkout --orphan release/5-foo` on the MAIN checkout
    # points HEAD at refs/heads/release/5-foo before any commit exists, so
    # `main_branch` (read off `git worktree list --porcelain`) already equals
    # `refs/heads/$branch` and the EARLIER, unrelated "branch ... is checked
    # out in the main checkout" guard above has already `block`ed — while
    # `git rev-parse --verify --quiet refs/heads/$branch` fails on the unborn
    # ref, so `has_branch` still reads false (measured). Without this guard the
    # die fires anyway, appending its own usage-error prose to a receipt that
    # already named the real cause, and exiting 2 instead of the correct
    # blocked-at-1 verdict. Guarding on `$blockers` lets that earlier finding
    # stand as the only word on an otherwise silent run.
    die "no branch $branch and no worktree on it — check the <slug> and <type> arguments"
  fi
fi

if [ "$has_branch" = true ]; then
  # Commits ahead — a member that did work. Measured on the branch ref rather
  # than the worktree's HEAD: the worktree above was located BY that ref, so the
  # two agree, and this still runs when the worktree is already gone.
  ahead=$(git rev-list --count "$base_rev..refs/heads/$branch") ||
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
  cherry=$(git cherry "$base_rev" "refs/heads/$branch") ||
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
# 30s: `ls-remote` moves refs and no objects, so this is generous for the work,
# and it is the budget inflight.sh's own `ls-remote` runs on. `FLEET_NET_TIMEOUT`
# is the shorten-only override this lookup shares with the fleet's fetches — but
# NOT with inflight.sh's `ls-remote`, which reads `INFLIGHT_LS_REMOTE_TIMEOUT`
# and nothing else, so shortening this one does not shorten that one. The rule
# is net_budget's, in net.sh.
ls_budget=$(net_budget 30 "${FLEET_NET_TIMEOUT:-}")
ls_rc=0
remote=$(net_git "" "$ls_budget" ls-remote --heads origin "refs/heads/$branch") || ls_rc=$?
if [ "$ls_rc" -ne 0 ]; then
  # A killed lookup and a refused one are different facts and get different
  # words. Both leave the same verdict — the answer is unknown, so nothing is
  # released — but only one of them names a cause this script observed.
  if net_stalled "$ls_rc"; then
    die "git ls-remote did not finish within ${ls_budget}s and was killed, so whether $branch was pushed is unknown"
  fi
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
# `occupied`, where this read `[ ! -e "$wt" ]`: `gone` reports a path that EXISTS
# as not-established-absent, which is the same answer it gives for one it cannot
# stat, and only the second is unknown — so the existence test has to be the one
# that agrees with `gone` about what "exists" means. It did not. Every `test`
# primary except `-L` STATS, so a DANGLING symlink is `-e` false, and once `gone`
# stopped calling that established-absent (#725) this guard read it as "cannot
# tell" and died at exit 2 with no receipt — for a path whose state is known
# exactly, and which the stand-in blocker below already answers. Measured on
# release-ticket.test.mjs's own dangling-link fixture, which is what caught it.
#
# `! occupied && ! gone` is the tri-valued pairing `gone`'s contract prescribes,
# and the same one `release_outcome` composes: present or link-present is not
# unknown, established-absent is not unknown, and what is left over is.
#
# `! nl_path` for the same reason the dangling link needed `occupied`, and it is
# the same trap a second time: `gone` now refuses a substituted path too (#551),
# so without this exemption the pairing reads it as "cannot tell" and dies — for
# a path the newline blocker above has already answered in the operator's own
# terms, downgrading a receipt-carrying `NOT released` verdict to an exit-2 die
# that says nothing the receipt did not. Measured on a worktree registered at a
# path holding a newline.
if [ -n "$wt" ] && ! nl_path "$wt" && ! occupied "$wt" && ! gone "$wt"; then
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
      die "cannot read the git repository at $wt (its .git file or the gitdir it names), so whether it holds uncommitted work is unknown"
    [ "$wt_canon" = "$toplevel" ] ||
      die "$wt's .git does not point at $wt — it resolves to $toplevel — so whether it holds uncommitted work is unknown"
  fi

  # Same reason: folded-in stderr would be counted as uncommitted changes.
  #
  # `-uall`: #730 (see reap.sh's branch sweep for the full explanation) — a
  # bare `--porcelain` reads clean over a dirty tree under
  # `status.showUntrackedFiles = no`, releasing a claim whose only copy of
  # that work is the directory about to be deleted. The `git worktree remove`
  # refusal this block's own comment leans on is no backstop — same
  # machinery, same config.
  if ! dirty=$(git -C "$wt" status --porcelain -uall); then
    die "cannot read the status of $wt, so whether it holds uncommitted work is unknown"
  fi
  # Ignored files are deliberately not a blocker: the tracked `agent-test`
  # bootstrap (#55) materializes `.agent-test.sh`, .gitignore'd, on every run,
  # so every checkout can have one, and blocking on it would strand every
  # claim. `git worktree remove` deletes ignored files
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
  [ "$has_branch" = true ] && echo "    would: git branch -D $branch" >&2
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
      release_outcome "$wt"
      halt "git worktree remove refused $wt: $(printf '%s' "$err" | tr '\n' ' ')"
    fi
    wt_outcome=Released
  fi

  if [ "$has_branch" = true ]; then
    # Recount at the delete, because `-D` carries no opinion of its own. The
    # precondition block ran before the `gh issue view` above, so a commit
    # landing in this worktree across that call reaches the delete having been
    # measured by nothing — destroyed at exit 0 with "released":true and an
    # empty blockers list. `-d` used to refuse that ("not fully merged"); the
    # recount narrows that window rather than closing it, because it is its own
    # git invocation: a commit landing in the milliseconds between this count
    # and the `git branch -D` below is still force-deleted at exit 0. Closing it
    # would take a compare-and-swap on the SHA counted here (`git update-ref -d
    # refs/heads/$branch $tip`), which does not carry `-D`'s own refusal on a
    # branch checked out in a registered worktree — trading this window for that
    # gap, deliberately not taken. Measured against $base, not local HEAD, so it
    # answers the safety question without reintroducing the staleness `-d` fails
    # on (#760). The `git cherry` half is deliberately not recounted: a commit
    # that landed in the window is ahead of $base by construction, and one
    # cherry would mark `-` is patch-equivalent to something already upstream.
    n=$(git rev-list --count "$base_rev..refs/heads/$branch") ||
      halt "cannot recount commits on $branch against $base at the delete"
    [ "$n" -eq 0 ] ||
      halt "$branch gained $n commit(s) since the checks — not deleted"

    # -D, authorized by the `ahead` and `git cherry` guards above, that recount,
    # and nothing else. reap.sh authorizes its own [gone] deletes with `git
    # cherry` ALONE — not this pairing. `-d` measures against HEAD and the
    # branch's upstream, and a claim has no upstream until its first push
    # (claim-ticket.sh passes --no-track, #760), so `-d` falls back to local
    # HEAD alone and refuses a pristine claim whenever local main is behind
    # origin/main — half-releasing it: worktree deleted, branch stranded,
    # in-progress still on the issue. Measured.
    echo "\$ git branch -D $branch" >&2
    if ! err=$(git branch -D "$branch" 2>&1); then
      halt "git branch -D refused $branch: $(printf '%s' "$err" | tr '\n' ' ')"
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
