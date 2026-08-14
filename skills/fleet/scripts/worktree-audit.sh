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

NAME=worktree-audit
die() { echo "$NAME: $1" >&2; exit 2; }
# One unknown state, one place: null counts, readable:false, one reason. Four
# branches below reach it and differ in nothing but that reason, so a fifth
# added later cannot half-set the quadruple and emit a record whose counts
# contradict its own `readable` field. The MISSING branch stays spelled out —
# it is the one state with non-null counts, and looking different is the point.
unknown() { readable=false; ahead=null; dirty=null; files=""; echo "    UNREADABLE: $wt ($1)" >&2; }

# Is $1 established ABSENT, or merely a path this script cannot stat? A bare
# `[ -d ]` failure is both — an unreadable parent (dropped mount, chmod'd
# ancestor) fails it identically to a directory that was actually removed —
# and the two must not share one report. Walk up to the nearest ancestor that
# exists and require THAT to be searchable: only then is "not there" a
# measurement, not a guess. Same shape and same reason as release-ticket.sh's
# own `gone()` (not shared code — the callers differ in nothing else); named
# there, not by line number, per #129.
gone() {
  look=$1
  while [ ! -e "$look" ] && [ "$look" != "${look%/*}" ]; do look=${look%/*}; done
  [ ! -e "$1" ] && [ -x "$look" ]
}

base=${BASE_REF:-origin/main}
git rev-parse --git-dir >/dev/null 2>&1 || die "not inside a git repository"
git rev-parse --verify --quiet "$base" >/dev/null || die "$base does not resolve"

echo "\$ git worktree list --porcelain" >&2

first=1
printf '['
# The worktree path is the whole rest of its line, never awk's $2:
# `git worktree list --porcelain` prints it raw, so a checkout living under a
# directory with a space in it — ordinary on macOS — was otherwise truncated
# at the first one, and every consumer below given a wrong, nonexistent path.
# The branch line's $2 stays: a ref name cannot contain a space.
git worktree list --porcelain | awk '/^worktree /{w=substr($0,10)} /^branch /{print w"\t"$2} /^detached$/{print w"\tDETACHED"}' |
while IFS="$(printf '\t')" read -r wt br; do
  short=${br#refs/heads/}
  if [ -d "$wt" ]; then
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
    echo "    MISSING on disk: $wt" >&2
  elif [ -e "$wt" ]; then
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
  echo "    $wt  branch=$short  ahead=$ahead  dirty=$dirty" >&2
  [ "$first" = 1 ] || printf ','
  first=0
  printf '{"worktree":"%s","branch":"%s","ahead":%s,"dirty":%s,"dirtyFiles":[%s],"readable":%s}' \
    "$wt" "$short" "$ahead" "$dirty" "$files" "$readable"
done
printf ']\n'
