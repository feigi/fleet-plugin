#!/bin/sh
# Per worktree: how many commits ahead of the base, and what is uncommitted.
#
# Run before dispatching a replacement for a killed member. The distinction that
# matters is committed-and-pushed vs committed-only vs uncommitted-in-the-worktree:
# only the last exists nowhere else, and a replacement told the wrong one will
# either redo finished work or destroy unfinished work.
#
# Read-only. Never exits non-zero for a dirty or absent worktree — that is the
# finding, not an error. Three states, never two: present-and-readable (real
# counts), established absent (a directory that really is not there — zero
# counts, a measurement), or unknown (anything this script could not actually
# look at — null counts, readable:false). A worktree that IS present but whose
# git commands fail (permissions, corrupt git dir), one behind an unreadable
# parent (a dropped mount, a chmod'd ancestor), and one whose .git linkage is
# missing (git would silently answer for the ENCLOSING repo instead, rc 0) are
# all the unknown state — none of them is ever silently ahead:0, dirty:0, which
# reads as "nothing here, safe to discard" and is indistinguishable from a
# genuinely empty worktree. #82, #128.
set -eu

# Byte semantics for the `awk` and `paste` below — this script runs no `tr`,
# no `sed` and no `grep`. Both are fed worktree paths and the file names
# `git status --porcelain` prints, which reach us from a fetched tree even
# where the local filesystem refuses to hold the name. `awk` is the immune one:
# measured byte-identical under `en_US.UTF-8` and `C`. `paste -sd, -` is not —
# fed `b\377ad.txt` then `plain.txt` it emits the single byte `b` under
# `en_US.UTF-8` and the whole pair under `C`, exiting 0 both times. So the pin
# is load-bearing here for exactly one call, and silently so: that truncation
# carries no stderr and no status. #582 measured the cost of leaving this
# ambient in no-undo-audit.sh: a truncated list reported as a clean, confident
# answer.
#
# Safe as a global: nothing in this script sorts, folds case, or uses a `[a-z]`
# range or a POSIX class, so collation and case-folding — the two things
# `LC_ALL=C` otherwise changes — have nothing here to act on. "Nothing" is an
# inventory, not a hope: locale-pin-prose.test.mjs enforces it (#612), because
# this sentence shipped false in no-undo-audit.sh and a `sort` added below
# would otherwise leave every test in this suite green.
export LC_ALL=C

NAME=worktree-audit
die() { printf '%s: %s\n' "$NAME" "$1" >&2; exit 2; }

# No positional argument (#525). A caller-supplied path was silently discarded
# — no `$#` check, no usage — so a missing worktree returned a full audit of
# every OTHER worktree at exit 0, first row the main checkout. Refuse loudly
# instead of adding a filter: this script's whole contract is "every worktree,
# every time", and refusing makes every existing caller correct rather than
# teaching the script a second, path-scoped one. Above the opening `[`, same as
# the json_lib guard below, so a refusal never emits a truncated array.
[ $# -eq 0 ] || die "takes no arguments; audits every worktree"

# The escaping helpers (#119). json.sh's header holds the sourcing contract and
# the measurements behind it. This script defines no exit 1 at all, so a bare 1
# out of it is a code its caller has no reading for. Placed here, above the
# opening `[`, so a missing library refuses before the array is started rather
# than truncating it.
json_lib="$(dirname "$0")/json.sh"
[ -r "$json_lib" ] || die "cannot read $json_lib — refusing to audit without the JSON escaping helpers"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=json.sh
. "$json_lib" || die "$json_lib failed to load"

# The worktree readers (#551, #725). worktree.sh's header holds the sourcing
# contract and the measurements behind it, and json.sh's holds the `[ -r ]`
# reasoning both guards share. Above the opening `[` for the reason the json_lib
# guard is: a missing library must refuse before the array is started.
wt_lib="$(dirname "$0")/worktree.sh"
[ -r "$wt_lib" ] || die "cannot read $wt_lib — refusing to audit without the worktree readers"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=worktree.sh
. "$wt_lib" || die "$wt_lib failed to load"
# One unknown state, one place: null counts, readable:false, one reason. Four
# branches below reach it and differ in nothing but that reason, so a fifth
# added later cannot half-set the quadruple and emit a record whose counts
# contradict its own `readable` field. The MISSING branch stays spelled out —
# it is the one state with non-null counts, and looking different is the point.
unknown() { readable=false; ahead=null; dirty=null; files=""; printf '    UNREADABLE: %s (%s)\n' "$wt" "$1" >&2; }

base=${BASE_REF:-origin/main}
git rev-parse --git-dir >/dev/null 2>&1 || die "not inside a git repository"
git rev-parse --verify "$base" >/dev/null || die "$base does not resolve"

echo "\$ git worktree list --porcelain -z" >&2

# Read above the opening `[`, and its failure is a `die` for the reason the
# library guards are: this script had NO status check on the listing at all, so
# a git that could not run emitted `[]` — an empty audit, indistinguishable from
# a repo with no worktrees, which is the answer the fleet controller reads to
# decide whether a replacement member would redo work or destroy it.
wt_listing || die "$wt_err"

first=1
printf '['
# The worktree path is the whole rest of its line, never awk's $2:
# `git worktree list --porcelain` prints it raw, so a checkout living under a
# directory with a space in it — ordinary on macOS — was otherwise truncated
# at the first one, and every consumer below given a wrong, nonexistent path.
# The branch line's $2 stays: a ref name cannot contain a space.
#
# A newline in that path used to end the record before `substr($0,10)` could
# read past it, AND end the `read -r` line below — two truncations, and the loop
# saw a shorter path than even the awk had. `wt_listing` swaps both separators
# before either stage runs, so the path arrives on one line; `nl_path` below is
# what refuses to stat it. #551
#
# The path goes LAST, and the branch first, because the tab this awk delimits
# with is itself a byte a path may hold — and `read -r wt br` split such a path
# at it, reporting a truncated `MISSING on disk` for a worktree that is present
# and clean, with the tail of its path swallowed into the branch field. That is
# #551's own defect shape surviving in #551's own rewrite. With the path last,
# `read` assigns the whole remainder of the line to the final name whatever it
# holds, so no byte in a path can split it. The branch cannot take that slot: a
# ref name rejects a tab outright, which is what makes it safe to read first.
printf '%s\n' "$wt_list" | awk '/^worktree /{w=substr($0,10)} /^branch /{print $2"\t"w} /^detached$/{print "DETACHED\t"w}' |
while IFS="$(printf '\t')" read -r br wt; do
  short=${br#refs/heads/}
  # FIRST, because every arm below stats `$wt` and none of them can: the byte
  # `wt_listing` substituted stands in for a newline, so this path does not name
  # the file git named. Reported rather than skipped — jstr renders the
  # substituted byte as a space, so the entry still names which worktree could
  # not be audited, whole, with the byte neutralised. The same ceiling
  # inflight.sh's probe 3 records, and here it costs a diagnosis rather than a
  # verdict. #551
  if nl_path "$wt"; then
    unknown "path holds a newline — git's own listing cannot be read back to a name this script can stat"
  elif [ -d "$wt" ]; then
    # Establish the .git linkage exists before trusting anything git says
    # through it. Delete a worktree's .git file outright — directory and every
    # uncommitted file still on disk — and `git -C` does not fail: it walks UP
    # to the enclosing repo and reports THAT repo's status at rc 0, which the
    # chain below would otherwise believe. Only a SEARCHABLE $wt lacking a
    # `.git` regular file is a measured absence; an unsearchable $wt is left to
    # the git commands below, which fail on their own and land in the existing
    # unreadable branch — this must not invent a second, weaker guess for it.
    # `.git` is a regular FILE for every linked worktree (`git worktree add`
    # always writes one) but a DIRECTORY for the main checkout, which this
    # script also lists and audits. reap.sh reaches the main checkout too —
    # `git worktree list --porcelain` emits a `branch refs/heads/...` line for
    # it, so a `[gone]` branch checked out there binds reap.sh's own `$wt` to
    # it — and handles that shape explicitly before its own `-f` linkage guard
    # (#128 reference shape) rather than by construction. Here the guard itself
    # must accept both: a real git dir always has `HEAD` sitting directly in
    # it, and an empty stand-in directory or a dangling symlink — the two
    # shapes a broken/deleted linkage takes, and what leaks the parent's status
    # at rc 0 — has neither. `-x "$wt"` gates it for the reason release-ticket.sh
    # gives its own guard: an unsearchable $wt must not be misread as "no
    # linkage established" — leave it to the git commands below, which fail on
    # their own and land in the existing unreadable branch.
    if [ -x "$wt" ] && [ ! -f "$wt/.git" ] && [ ! -f "$wt/.git/HEAD" ]; then
      unknown "no .git linkage — git would answer for the enclosing repo, not this worktree"
    # Chain on `&&`, not `|| echo 0`: a piped `wc -l` always exits 0 even when
    # the git command feeding it failed, so a fallback tacked onto the pipe
    # never fires and a permissions/corruption failure reads as "0 ahead, 0
    # dirty" — indistinguishable from a genuinely clean worktree.
    elif ahead=$(git -C "$wt" rev-list --count "$base"..HEAD 2>/dev/null) \
       && status_out=$(git -C "$wt" status --porcelain 2>/dev/null); then
      readable=true
      dirty=$(printf '%s\n' "$status_out" | awk 'NF{c++} END{print c+0}')
      # substr, not $2: a dirty file's own name may hold a space — "XY " is
      # always exactly three bytes in porcelain v1, so the path starts at the
      # fourth. Same truncation as the worktree path above, one caller down.
      # git C-quotes the path itself (wraps it in its own "…", backslash-
      # escaped) whenever it holds a space or other unusual byte — measured,
      # git 2.50.1 — so wrapping it in a second pair of quotes here would
      # double-quote it into invalid JSON. Only add quotes when git did not
      # already add its own; a filename holding a literal `"` or `\` that git's
      # C-quoting escapes one way and JSON escaping wants another is the
      # existing, unaddressed gap this script has always had for the worktree
      # path and branch name too (#119-shaped), not one this fix opens.
      files=$(printf '%s\n' "$status_out" | awk 'NF{
        p=substr($0,4)
        # A rename/copy line is `<src> -> <dst>`; emit the DESTINATION only —
        # the source path no longer exists, so reporting it names a file that
        # is not there. Gate on the X status byte (R/C), never on a literal
        # " -> ": a filename may legally hold one, and splitting on that emits
        # two broken halves of a name git never split. git C-quotes any path
        # holding a space — measured, git 2.51 — so an UNQUOTED src cannot
        # contain the delimiter, while a QUOTED one can and ends at its own
        # unescaped closing quote, which the scan below finds. Reading the
        # whole rename line as one path put the quotes git had already added
        # inside the pair added below: one such file made the WHOLE payload
        # unparseable, taking every other worktree entry down with it (#82).
        if (substr($0,1,1) ~ /[RC]/) {
          if (substr(p,1,1) == "\"") {
            for (i=2; i<=length(p); i++) {
              c=substr(p,i,1)
              if (c=="\\") i++
              else if (c=="\"") break
            }
            if (substr(p,i+1,4) == " -> ") p=substr(p,i+5)
          } else {
            i=index(p," -> ")
            if (i) p=substr(p,i+4)
          }
        }
        if (substr(p,1,1) != "\"") p = "\"" p "\""
        print p
      }' | paste -sd, -)
    else
      unknown "git rev-list/status failed — treat as unknown, not empty"
    fi
  elif gone "$wt"; then
    readable=false
    ahead=0; dirty=0; files=""
    printf '    MISSING on disk: %s\n' "$wt" >&2
  elif [ -e "$wt" ] || [ -L "$wt" ]; then
    # `-L` beside `-e`, never folded into it: every other `test` primary STATS,
    # so a DANGLING symlink is `-e` false and `-L` true, and without this it fell
    # past both this arm and `gone` into "an ancestor could not be read" — prose
    # that is false of a path whose every ancestor was read fine. `gone` now
    # refuses it too (#725), so this arm is where it lands, and the diagnosis
    # below is true of it: a link IS there, and it is not a directory. The
    # wording stays hedged deliberately — a dangling worktree link is rc-0
    # residue OR release-ticket.sh's rc-255 halt path with the claim still live,
    # and only the hedge is true of both (#728).
    #
    # `-d` false does not mean "not there". A registered worktree path replaced
    # by a regular file, a symlink to one, or a FIFO is all three still LISTED
    # by git (with its `branch` line, so this loop still sees it) and reads
    # perfectly — measured, all three land here. Saying an ancestor could not
    # be read about a path whose every ancestor was read sends a debugger at
    # permissions that are fine. Safe after `gone`, never before: `gone()`
    # requires `[ ! -e "$1" ]`, so reaching here with `-e` true means it
    # already answered false. The state is the same unknown either way — only
    # the reported cause differs.
    unknown "exists but is not a directory"
  else
    unknown "cannot tell whether it exists — an ancestor could not be read"
  fi
  printf '    %s  branch=%s  ahead=%s  dirty=%s\n' "$wt" "$short" "$ahead" "$dirty" >&2
  [ "$first" = 1 ] || printf ','
  first=0
  # `$wt` and `$short` are both reachable, by different routes: a branch name
  # accepts a `"` (git rejects `\` in a ref), while a worktree path is a
  # filename and accepts both. This script's whole output is one array, so a
  # single unescaped byte costs the caller every entry, not just this one.
  # `$files` is NOT wrapped: git C-quotes those paths itself, conditionally,
  # which is a second and different problem — see the `files=` awk above.
  # `die` rather than a null field, unlike reap.sh: nothing has been mutated
  # here, so refusing costs no record of work already done.
  wt_j=$(jstr "$wt") && short_j=$(jstr "$short") \
    || die "could not escape the entry for $wt"
  printf '{"worktree":"%s","branch":"%s","ahead":%s,"dirty":%s,"dirtyFiles":[%s],"readable":%s}' \
    "$wt_j" "$short_j" "$ahead" "$dirty" "$files" "$readable"
done
printf ']\n'
