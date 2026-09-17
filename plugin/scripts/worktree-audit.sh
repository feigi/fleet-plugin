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
# where the local filesystem refuses to hold the name. `paste -sd, -` is the
# obvious one — fed `b\377ad.txt` then `plain.txt` it emits the single byte `b`
# under `en_US.UTF-8` and the whole pair under `C`, exiting 0 both times, a
# truncation carrying no stderr and no status. #582 measured the cost of
# leaving this ambient in no-undo-audit.sh: a truncated list reported as a
# clean, confident answer.
#
# `awk` used to be the immune one — measured byte-identical under
# `en_US.UTF-8` and `C` — and #617 ended that: `jesc` below turns git's octal
# escapes back into bytes with `sprintf("%c", n)`, and that IS locale-sensitive.
# Measured, `%c` with 195: gawk 5.4.1 emits the two-byte UTF-8 encoding of
# U+00C3 under `en_US.UTF-8` and the single byte \303 under `C`; BWK awk
# 20200816 emits the byte under both. gawk is what Linux CI runs, so without
# the pin every non-ASCII dirty filename would come back double-encoded there
# and correct on the developer's Mac.
#
# Safe as a global: nothing in this script sorts, folds case, or uses a `[a-z]`
# range or a POSIX class, so collation and case-folding — the two things
# `LC_ALL=C` otherwise changes — have nothing here to act on. "Nothing" is an
# inventory, not a hope: locale-pin-prose.test.mjs enforces it (#612), because
# this sentence shipped false in no-undo-audit.sh and a `sort` added below
# would otherwise leave every test in this suite green.
export LC_ALL=C

# Below the locale pin, not above it with `set -eu`: `unset` touches no
# byte-sensitive tool, but locale-pin-prose.test.mjs treats ANY line here that
# is not a comment, a blank, or `set -[eux]+` as work the pin must sit above,
# and refuses on principle rather than on this line's own behaviour. Same
# placement, same reason, as release-ticket.sh's copy.
#
# Both halves are measured on THIS script (#1020), and they break it in two
# different directions — which is why the line names both rather than the one
# that happened to be found first.
#
# GIT_DIR: every git call above the per-worktree loop is bare — `rev-parse
# --git-dir`, `rev-parse --verify "$base_rev"`, and the `worktree list` behind
# `wt_listing` — so an ambient one retargets the whole listing. Measured:
# standing in clone A with `GIT_DIR` naming clone B's `.git`, this script
# emits a full, confident array describing B's worktrees, at rc 0, with
# nothing on stderr to say the question was not the one asked. The fleet
# controller reads this report to decide whether a replacement member would
# REDO work or DESTROY it, and an answer about another checkout is the worst
# possible input to that decision.
#
# GIT_WORK_TREE: it outranks `-C`, so the `git -C "$wt" status --porcelain
# -uall` in the loop stops answering about `$wt`. Measured, on the fleet's own
# layout (`.worktrees/` gitignored, so the parent really is clean): a worktree
# holding an uncommitted file comes back `dirty: 0, dirtyFiles: [],
# readable: true` — a false CLEAN, at rc 0, indistinguishable from a worktree
# that genuinely holds nothing. Same shape as #730's `showUntrackedFiles=no`
# silence, reached through the environment instead of the config.
unset GIT_DIR GIT_WORK_TREE

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
# This script is audit-only — it prints ahead/dirty counts to stdout and never
# itself writes to git state, so a fleet controller acting on a wrong number
# is the whole blast radius, not this process. Unlike release-ticket.sh's
# `--apply` path (which deletes a branch and worktree on the strength of its
# own measurement), there is no accept-list here restricting BASE_REF to a
# remote-tracking ref — judged out of scope for this ticket. What still must
# be fixed regardless of what $base is allowed to name: the measurement
# against it must not be silently wrong.
#
# release-ticket.sh (#1320) found the same bug in the same default: `origin/
# main` is a SHORTHAND, and git resolves a shorthand through its own
# disambiguation order (gitrevisions: refs/<name>, refs/tags/<name>,
# refs/heads/<name>, refs/remotes/<name>, …), in which refs/remotes/origin/
# main comes LAST. A local TAG literally named `origin/main` — `git tag
# origin/main refs/heads/<branch>` — outranks the real remote-tracking
# branch, and every measurement against the bare shorthand then answers
# about the tag's target instead: `ahead` silently reads 0 against a
# worktree that genuinely carries unpushed work, exactly the "nothing here"
# signal below (#172) tells a fleet controller to trust.
#
# The fix is to stop MEASURING against the shorthand: qualify it to the full
# refs/remotes/ path, where there is nothing left to disambiguate, unless it
# is already qualified. $base itself is left unqualified — it never appears
# in this script's JSON output, only in `die` text, where the shorthand
# spelling is what an operator expects to read.
case "$base" in
  refs/remotes/*) base_rev=$base;;
  *) base_rev="refs/remotes/$base";;
esac
git rev-parse --git-dir >/dev/null 2>&1 || die "not inside a git repository"
git rev-parse --verify "$base_rev" >/dev/null || die "$base does not resolve"

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
    #
    # `-uall`: #730 (see reap.sh's branch sweep for the full explanation) — a
    # bare `--porcelain` reads `dirty: 0` over a dirty tree under
    # `status.showUntrackedFiles = no`, and the `&&` chain above, built
    # precisely so a failure to look is never scored as clean, cannot see it
    # either, because the status IS 0.
    #
    # `-uall` over `-unormal` here specifically, unlike reap.sh's `--ignored`
    # reason-string probe (which switched to `-unormal`, same PR): this
    # report's `dirtyFiles[]` is what a fleet controller reads to decide
    # whether a replacement member would REDO work or DESTROY it, and #617
    # already invested in translating git's C-quoting to JSON precisely so
    # `dirtyFiles[]` round-trips to the real path on disk — infrastructure
    # that exists to let the array name individual files, not just
    # directories. `-unormal` would collapse an untracked directory to one
    # entry, silently dropping that granularity for whoever reads this
    # array. Proven, not just asserted: see the nested-directory test in
    # worktree-audit.test.mjs.
    elif ahead=$(git -C "$wt" rev-list --count "$base_rev"..HEAD 2>/dev/null) \
       && status_out=$(git -C "$wt" status --porcelain -uall 2>/dev/null); then
      dirty=$(printf '%s\n' "$status_out" | awk 'NF{c++} END{print c+0}')
      # substr, not $2: a dirty file's own name may hold a space — "XY " is
      # always exactly three bytes in porcelain v1, so the path starts at the
      # fourth. Same truncation as the worktree path above, one caller down.
      #
      # git C-quotes the path itself (wraps it in its own "…", backslash-
      # escaped) whenever it holds a space or other unusual byte — measured,
      # git 2.50.1 — and C-quoting is NOT JSON escaping. `\303\251` for the `é`
      # in `café.txt` is an invalid JSON escape, so ONE such file made the whole
      # array unparseable and cost the caller every other worktree's entry too.
      # #617 settled the open half of that: TRANSLATE git's form into JSON's, so
      # `dirtyFiles[]` round-trips to the real name on disk. The alternative
      # #617 weighed — JSON-escape the C-quoted text itself — parses, but hands
      # a fleet controller a string it cannot pass back to the filesystem, which
      # is the same defect `nl_path` above refuses rather than reports.
      #
      # Not `--porcelain -z` (git's raw, unquoted form) even though it would
      # delete the rename scan below: no shell variable holds a NUL and no awk
      # program holds one either (worktree.sh states that measurement), so it
      # buys a temp file and a `tr` swap, and a filename holding a real newline
      # then becomes indistinguishable from two files — a regression, since
      # C-quoting keeps every path on one line, which is also what keeps the
      # `dirty` count above honest.
      #
      # Not `jstr`: the value arriving here is already an ESCAPED form, not the
      # raw bytes jstr's rules are written for, and it arrives one per line
      # inside awk where no shell function is reachable. The two agree on where
      # it matters — `jesc` replaces the same C0 bytes json.sh's `tr` replaces
      # (\001-\007 \013 \016-\037 → space), plus \000: `tr`'s range starts at
      # \001 because a shell string cannot hold a real NUL byte to feed it, but
      # `jesc` meets \000 as three literal digit characters (git's own octal
      # spelling of the byte), never as an embedded NUL, so the exclusion that
      # protects `tr` does not apply here. Emits the same five short forms, and
      # leaves \177 alone (#146).
      if jfiles=$(printf '%s\n' "$status_out" | awk '
      # git C-quoting to JSON, byte for byte. An UNQUOTED path is returned
      # untouched: git quotes for `"`, `\`, any control byte and any byte with
      # the high bit set, so what it left bare is printable ASCII with nothing
      # JSON needs escaped. `index("01234567", c)`, not a `[0-7]` bracket range
      # — locale-pin-prose.test.mjs scans this file for collation ranges and a
      # range here would read as one (#612). git spells an octal escape with
      # exactly three digits, so the two lookahead reads below always land.
      # jesc_err is a global, deliberately never reset: an unrecognized escape
      # exits the awk program (below) before a second call could matter, so
      # nothing here ever needs to un-set it.
      function jesc(p,   out,i,c,n) {
        if (substr(p,1,1) != "\"") return p
        i=2
        while (i < length(p)) {
          c=substr(p,i,1); i++
          if (c != "\\") { out=out c; continue }
          c=substr(p,i,1); i++
          if (index("01234567", c) > 0) {
            n=(c*64) + (substr(p,i,1)*8) + substr(p,i+1,1); i+=2
            out = out (n < 32 ? " " : sprintf("%c", n))
          } else if (c=="a" || c=="v") out=out " "
          else if (index("bfnrt\\\"", c) > 0) out=out "\\" c
          # An escape letter git 2.50.1 never emits (the #617 enumeration
          # above is exhaustive against it) — dead code under real git, same
          # as the header states. Fail loud rather than pass the byte through
          # unescaped: this file has one rule above every other one, never
          # silently report a wrong answer as a clean one, and a
          # silently-dropped backslash here is exactly that, one dirtyFiles[]
          # entry at a time.
          else { jesc_err=c; return out }
        }
        return out
      }
      NF{
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
        e=jesc(p)
        # Checked here, not after the pipeline: `awk ... | paste -sd, -` would
        # otherwise report the PASTE exit status, and paste never fails on
        # this input — the jesc_err below would kill awk with nothing
        # downstream ever finding out (#617 suggestion 3).
        if (jesc_err != "") {
          print "jesc: unrecognized C-quote escape \\" jesc_err > "/dev/stderr"
          exit 1
        }
        print "\"" e "\""
      }'); then
        readable=true
        files=$(printf '%s\n' "$jfiles" | paste -sd, -)
      else
        unknown "jesc: unrecognized C-quote escape — refusing a corrupted dirtyFiles entry"
      fi
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
  # `$files` is NOT wrapped here: its elements arrive already quoted and already
  # JSON-escaped, by `jesc` in the `files=` awk above (#617).
  # `die` rather than a null field, unlike reap.sh: nothing has been mutated
  # here, so refusing costs no record of work already done.
  wt_j=$(jstr "$wt") && short_j=$(jstr "$short") \
    || die "could not escape the entry for $wt"
  printf '{"worktree":"%s","branch":"%s","ahead":%s,"dirty":%s,"dirtyFiles":[%s],"readable":%s}' \
    "$wt_j" "$short_j" "$ahead" "$dirty" "$files" "$readable"
done
printf ']\n'
