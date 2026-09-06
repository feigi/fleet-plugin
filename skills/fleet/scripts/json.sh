# shellcheck shell=sh
# JSON string escaping for the fleet's shell scripts. Sourced, never executed —
# no shebang, and the `shell=sh` directive above is what tells shellcheck what
# to check it as.
#
# Source it as:
#
#     json_lib="$(dirname "$0")/json.sh"
#     [ -r "$json_lib" ] || die "cannot read $json_lib"
#     # shellcheck source-path=SCRIPTDIR
#     # shellcheck source=json.sh
#     . "$json_lib" || die "$json_lib failed to load"
#
# The `[ -r ]` is NOT belt-and-braces, and `|| die` alone is not enough. `.` is
# a POSIX *special builtin*: failing to open its operand aborts a
# non-interactive shell outright, so `||` never runs. Measured on a missing
# file with `set -e`: /bin/sh (macOS bash 3.2) and bash 3.2/`--posix` exit **1**
# with the guard unfired, dash exits 2 unfired, and only Homebrew bash 5.3
# reaches the `|| die`. Exit 1 is a VERDICT in FIVE of the eight callers here —
# inflight.sh reads it as "ticket taken", verify-sha.sh as "not reachable",
# prove-merge.sh as "not proved", no-undo-audit.sh as "REFUSED, the worktree is
# dirty", release-ticket.sh as "NOT released, blocked" — so a lib that merely
# went missing would fabricate one. claim-ticket.sh, reap.sh and
# worktree-audit.sh define no exit 1 at all, which is not safety: a bare 1 out
# of them is a code their caller has no reading for. The `[ -r ]` catches that
# before `.` can kill the shell; the `|| die` stays for the case `[ -r ]`
# cannot see, and that case is live rather than theoretical — a DIRECTORY at
# this path passes `[ -r ]` and `.` returns 1 with the arm firing (measured,
# /bin/sh and bash 5.3; dash sources a directory at exit 0 instead). A lib that
# reads and has a SYNTAX error aborts before either guard on /bin/sh, bash 3.2
# and `bash --posix`, while bash 5.3 reaches the `|| die` with status 2. The
# suite does NOT cover that case: measured, a syntax error appended at EOF
# leaves bash 3.2 with every function it had already parsed and json.test.mjs
# stays green. CI's `shellcheck -x -S warning` over `git ls-files '*.sh'` is
# what catches it (SC1072/SC1073).
#
# `LC_ALL=C` is a per-command prefix on every tool below, never an export. Three
# of the callers (verify-sha.sh, prove-merge.sh, claim-ticket.sh) do not pin the
# locale, and exporting from a sourced lib would silently re-locale every OTHER
# tool in them. The prefix is a no-op in the five that do pin it (#582), and
# closes the same hazard in the three that do not. It matters here because BSD
# `tr` exits 1 on a byte that is not valid UTF-8 under a UTF-8 locale, and
# `sed` emits nothing at all.
#
# THE RULE ORDER. Backslash first, always: escaping the quote (or any short
# form) before the backslash rule runs turns the backslash IT just introduced
# into `\\` on the second pass. Every rule that adds a backslash comes after
# that one. The five C0 bytes RFC 8259 gives a two-character short form —
# \010 \011 \012 \014 \015 (\b \t \n \f \r) — get theirs. BS and FF are matched
# as a literal byte spelled with `printf`, never as `\b` or `\f`: neither
# spelling matches \010, and neither fails quietly — `\b` in a BRE is a
# zero-width word BOUNDARY to GNU sed and a literal `b` to BSD sed, so the rule
# would insert `\b` at every word edge on one and mangle every letter `b` on the
# other (measured, GNU sed 4.9 and macOS sed). \177 (DEL) is not a C0 byte and
# JSON permits it unescaped, so it is left alone (#146). Every remaining byte
# below \040 has no short form, \013 (VT) included — RFC 8259 lists exactly the
# five above and `\v` is not among them; `tr` turns it into a space, and
# `jrewritten` is how a caller finds out that happened, since a replaced value
# is not the original bytes and must not be treated as a real path or ref.
# Byte-safe because every `tr` set here is ASCII-only and no byte of a
# multi-byte UTF-8 sequence is below \200 — not because UTF-8 avoids the low
# bytes, which it does not: half of it is ASCII. `tr` pads the replacement with
# its last character.
#
# `:a;$!N;$!ba` slurps the whole value into one pattern space before any rule
# runs, so a literal newline in $1 is data the LF rule can reach rather than a
# line break sed's own per-line cycling would swallow. Guarding `N` with `$!`
# matters on its own: unguarded, BSD sed's `N` on the last line hits EOF with
# nothing to append and discards the pattern space instead of printing it —
# POSIX leaves this undefined and GNU sed's answer differs — so plain `N;$!ba`
# prints nothing at all for a single-line value.
#
# EVERY FALLIBLE STAGE'S STATUS IS READ HERE, and that is the #119 fix rather
# than a style choice. A pipeline's status is its LAST stage's, so the
# original `printf | sed | tr` reported only `tr` — forcing `sed` to fail left
# jstr exiting 0 with an empty value and every caller's `|| die` unfired, while
# forcing `tr` worked (measured on PR #425). POSIX sh has no `pipefail` and no
# `PIPESTATUS`, so each stage that can fail is captured and its status read.
# The consequence, and the rule a later edit is checked against: a pipeline may
# still END a function, but only where its LAST stage is the fallible one — `tr`
# closes jstr, `paste` closes jarr and jarr_rewritten, so each function's status
# IS that tool's (measured: breaking `tr` gives jstr the shim's own status,
# breaking `sed` gives 1 from that capture's `|| return 1`).
#
# `$( )` strips trailing newlines off each capture. For a newline INSIDE the
# value that is safe, because `sed` ran first and turned it into the two
# characters `\n`. It is NOT safe for a TRAILING \012: sed consumes that byte as
# its line terminator rather than data, so no rule can see it, sed re-emits an
# indistinguishable one and `$( )` takes it off — `jstr` of `a<LF>` and of `a`
# are byte-identical (measured). No live caller can reach it: every argument
# reaching jstr today is a script literal or a `$( )`/`awk`/`read` capture that
# has already lost its own trailing newline. #119 leaves it there rather than
# adding a sentinel no caller would exercise. jarr is the exception and is
# handled in its own note.
#
# Scratch variables are `json_`-prefixed because /bin/sh has no `local` and
# these land in the sourcing script's namespace.
#
# A path or ref is a byte string with no UTF-8 guarantee (a fetched tree can
# carry a Linux- or latin-1-authored name), but the string these functions
# build is JSON TEXT, which must be valid UTF-8. Every rule above operates
# below \200 or adds ASCII bytes, so a genuinely invalid byte — one that is
# not even part of a malformed multi-byte sequence, just a byte no UTF-8
# sequence starts or continues with — sailed through untouched and landed raw
# in the payload: `jq` then silently substitutes U+FFFD on decode (changing
# what the caller reads back) and a strict parser (`python3 json.load`)
# refuses the payload outright (#613). `jstr` and `jarr` now run the value
# through Python's own UTF-8 decoder with `errors="replace"` first — the same
# U+FFFD a lenient consumer already substitutes, made explicit and JSON-legal
# at the source instead of implicit and consumer-dependent — and `jrewritten`
# reports it as a rewrite like any other replaced byte.

# Python's own UTF-8 decoder with errors="replace" (#613), shared script text
# rather than a function: a function called on the right side of a pipe runs
# in its own subshell, and a `json_u8=` assigned inside it would not survive
# back to the caller — every call site below runs this as
# `python3 -c "$JSON_UTF8_PY"` and captures the result itself.
JSON_UTF8_PY='
import sys
sys.stdout.buffer.write(sys.stdin.buffer.read().decode("utf-8", "replace").encode("utf-8"))
'

# Escape $1 into a JSON string BODY — no surrounding quotes, the caller adds
# those. Exit 0 with the escaped value, non-zero if any stage failed.
jstr() {
  # Empty in, empty out, no fork at all (#120). This is what lets a PATH-wide
  # sed/tr outage — the failure inflight.sh measures at its own top — leave a
  # field that legitimately found nothing untouched: that field never calls the
  # broken tool, so it cannot observe its failure.
  [ -n "$1" ] || return 0
  json_u8=$(printf '%s' "$1" | LC_ALL=C python3 -c "$JSON_UTF8_PY") || return 1
  json_esc=$(printf '%s' "$json_u8" \
    | LC_ALL=C sed -e ':a' -e '$!N' -e '$!ba' \
        -e 's/\\/\\\\/g' -e 's/"/\\"/g' \
        -e "s/$(printf '\010')/\\\\b/g" -e 's/\t/\\t/g' -e 's/\n/\\n/g' \
        -e "s/$(printf '\014')/\\\\f/g" -e 's/\r/\\r/g') || return 1
  printf '%s' "$json_esc" | LC_ALL=C tr '\001-\007\013\016-\037' ' '
}

# True iff $1 held a byte jstr/jarr had to REPLACE rather than escape — every C0
# byte except \010 \011 \012 \014 \015 (escaped above, never replaced) and \177
# (preserved, never replaced). `$()` strips trailing newlines off both sides,
# and \012 is the one byte it strips: it is not in the delete set, so the same
# suffix comes off both and the strip cannot manufacture a difference. It does
# hide one — a value ending in \012 answers `false` here while jstr has already
# dropped that byte — which is the trailing-\012 case the header bounds as
# unreachable from every live caller, not a byte jarr/jstr REPLACED.
jrewritten() {
  # Same short circuit as jstr, same reason: nothing to have rewritten, so no
  # need to ask a tool that might not be there.
  [ -n "$1" ] || { printf false; return 0; }
  # `|| return 1` is load-bearing, not belt-and-braces. This function's last
  # command is an AND-OR list that always exits 0 on its own (`[ … ] && printf
  # false || printf true`, and the early `printf true; return 0` below is its
  # own explicit return), so a failed `tr` (or `python3`) reaches the caller
  # only by `set -e` aborting the function — and a call site inside an `if`
  # condition is exempt from `set -e`. Whether that exemption also reaches
  # this assignment is the shell's own choice, and shells disagree. Measured:
  # `dash`, Apple's `/bin/sh`, and bash 3.2.57 in POSIX/sh mode abort here,
  # which is correct; bash 5.3 in EVERY mode — plain, invoked as `sh`, and
  # `--posix` — plus bash 3.2.57 outside POSIX mode and zsh 5.9 all run on to
  # the always-0 last line and hand back a confident `true` about bytes
  # nothing ever examined. That second list covers every distro whose
  # `/bin/sh` is bash 5.x. Returning explicitly makes the status this
  # function's own on all of them.
  json_raw=$(printf '%s' "$1" | LC_ALL=C tr -d '\001-\007\013\016-\037') || return 1
  json_orig=$(printf '%s' "$1")
  # The C0 scrub above already answers `true` on its own — no need to also
  # fork python3 to ask whether UTF-8 needed repairing too, the OR is already
  # satisfied.
  [ "$json_raw" = "$json_orig" ] || { printf true; return 0; }
  # `jarr_rewritten` calls this once per line, and a repo's own paths are
  # overwhelmingly plain ASCII — the case the C0 check above does NOT catch,
  # since it only differs on a rewrite. A value holding no byte >= \200 at
  # all decodes as UTF-8 to itself unconditionally (pure ASCII is already
  # valid UTF-8), so python3 has nothing to find; this tr is what lets that
  # common case skip the interpreter start instead of paying for one on every
  # line regardless of content (measured 8.4x slower before this and the
  # short-circuit above existed).
  json_ascii=$(printf '%s' "$1" | LC_ALL=C tr -d '\200-\377') || return 1
  [ "$json_ascii" = "$json_orig" ] && { printf false; return 0; }
  # jstr also repairs a byte that is not valid UTF-8 (#613) — a second,
  # independent replacement alongside the C0 scrub above, so a second,
  # independent check: this value must decode as strict UTF-8 unchanged, or
  # jstr rewrote it too.
  json_u8=$(printf '%s' "$1" | LC_ALL=C python3 -c "$JSON_UTF8_PY") || return 1
  [ "$json_u8" = "$json_orig" ] && printf false || printf true
}

# The array form: stdin's lines to one quoted JSON string each, comma-joined,
# ready to drop between a `[` and a `]`. Same ruleset as jstr minus the LF rule
# — \012 is the record separator here, never data, and never can be: a caller
# has already lost the ability to tell an element's own newline from the
# boundary between two elements by the time a value reaches per-line stdin,
# which is why no-undo-audit.sh refuses a conflicting path holding one before it
# ever calls this. Escaping a byte this function structurally never receives
# would be dead code standing in for a restructure nobody has needed; #89 owns
# that class.
#
# Empty stdin gives empty stdout at exit 0 — measured as the original
# pipeline's behaviour, and the `[ -n ]` guard is what preserves it: without it
# the `printf '%s\n'` re-emit below would turn "no elements" into one empty
# line and `paste` would answer `""`, inventing an element out of nothing.
jarr() {
  # Same repair as jstr, same reason (#613), run once over the whole
  # (possibly multi-line) input rather than per line: \n is ASCII and never a
  # byte of a multi-byte UTF-8 sequence, so decoding the joined blob in one
  # pass cannot manufacture or hide a line boundary.
  #
  # Unlike jstr's single opaque value, THIS input's own trailing newlines ARE
  # the record separator between array elements — a plain `$()` capture
  # strips every one of them, which silently drops trailing empty elements
  # (measured: `printf 'a\n\n' | jarr` lost its second, empty element, and
  # `printf '\n' | jarr` lost its only one, collapsing `[""]` into the same
  # empty output as a zero-element array). Appending `x` after python3's own
  # output gives `$()` a non-newline character to stop stripping at;
  # `${json_u8%x}` removes exactly that one character back off, and only on
  # the success path — `&&` (not `;`) keeps python3's own exit status as the
  # substitution's, so a failed python3 returns 1 before ever reaching the
  # strip. json_u8 now holds python3's output byte-for-byte, so it is fed to
  # sed with `printf '%s'` (no added newline) rather than `printf '%s\n'`.
  json_u8=$(LC_ALL=C python3 -c "$JSON_UTF8_PY" && printf x) || return 1
  json_u8=${json_u8%x}
  json_esc=$(printf '%s' "$json_u8" | LC_ALL=C sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' \
      -e "s/$(printf '\010')/\\\\b/g" -e 's/\t/\\t/g' \
      -e "s/$(printf '\014')/\\\\f/g" -e 's/\r/\\r/g' \
      -e 's/^/"/' -e 's/$/"/') || return 1
  [ -n "$json_esc" ] || return 0
  json_esc=$(printf '%s\n' "$json_esc" | LC_ALL=C tr '\001-\007\013\016-\037' ' ') || return 1
  printf '%s\n' "$json_esc" | LC_ALL=C paste -sd, -
}

# Parallel boolean array to jarr's own output, true where that line held a byte
# jarr replaced. `read` alone drops a final line with no trailing newline —
# `set -eu` never sees it fail, the loop just never runs its body for that
# line — so `|| [ -n "$line" ]` is load-bearing on the last element, not
# defensive filler. `|| exit 1` inside the loop and `|| return 1` on the capture
# carry a failed `jrewritten` out of the subshell for the same reason the
# captures above exist: left as a pipeline into `paste`, only `paste`'s status
# would survive.
jarr_rewritten() {
  json_esc=$(while IFS= read -r line || [ -n "$line" ]; do
    jrewritten "$line" || exit 1
    echo
  done) || return 1
  [ -n "$json_esc" ] || return 0
  printf '%s\n' "$json_esc" | LC_ALL=C paste -sd, -
}
