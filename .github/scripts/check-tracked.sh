#!/usr/bin/env bash
# Run a checker over every tracked file matching a glob — and REFUSE an empty
# match.
#
# Usage: check-tracked.sh '<glob>' <xargs args and command...>
#   .github/scripts/check-tracked.sh '*.mjs' -n1 node --check
#
# Everything after the glob is handed to xargs verbatim, which is why `-n1`
# stays at the call site: shellcheck wants all its files in one invocation, the
# other checkers want one file each.
#
# Why this exists (#161). The steps here used to be
# `git ls-files '<glob>' | xargs -r <checker>`. `xargs -r` exits 0 on empty
# input and every checker prints nothing on success, so a run that checked 23
# files and a run that checked 0 were byte-identical in the log — one directory
# rename and a step is vacuously green forever. `pipefail` cannot see it: the
# left-hand side SUCCEEDS, it just succeeds with nothing. `shopt -s failglob`,
# the fix PR #157 used for the Tests step, does not apply either — the glob is
# quoted and expanded by `git ls-files`, not by the shell.
#
# So: print the count, and make zero fatal. Every glob in ci.yml matches files
# today, so the refusal cannot fire on the real tree; the day one legitimately
# empties, this is a loud one-line edit here instead of a silent green.
#
# NUL-delimited end to end, so a tracked path holding a space or a quote is
# passed through intact. None does today — that is the point: the day one
# arrives, the failure is not silent. `while read -d ''` rather than `mapfile
# -d ''`, which needs bash 4.4 and so cannot run on a stock macOS /bin/bash.
set -euo pipefail

# A checker is not optional. `xargs` handed no command falls back to its own
# default, `echo`, so a call that lost its checker would print the filenames
# and exit 0 having run none of them — this script's whole contract is that it
# never exits 0 having verified nothing, and that includes being handed nothing
# to verify with. `$#` is read before `$1`, so a call that lost the glob too
# gets this ::error:: line naming the script instead of bash's own `unbound
# variable` diagnostic.
if [ "$#" -lt 2 ]; then
  echo "::error::check-tracked.sh: usage: check-tracked.sh '<glob>' <xargs args and command...>"
  exit 1
fi

glob=$1
shift

files=()
while IFS= read -r -d '' f; do files+=("$f"); done < <(git ls-files -z -- "$glob")

echo "checking ${#files[@]} file(s) matching $glob"
if [ "${#files[@]}" -eq 0 ]; then
  # Also the shape a failed `git ls-files` takes — its status is lost to the
  # process substitution, and "nothing was verified" is true either way.
  echo "::error::no tracked file matches $glob — this check verified nothing"
  exit 1
fi

printf '%s\0' "${files[@]}" | xargs -0 "$@"
