# Shell traps: the measurements behind them

Evidence for the rules SKILL.md states in **Shell traps**, keyed by the rule each justifies.

## zsh splits a command substitution, never an unquoted parameter expansion

**zsh word-splits an unquoted command substitution's result; it does NOT split
an unquoted parameter expansion.** That one difference is the whole rule, and the
hazard is the **assigned-variable** form, never `$(…)`. Measured on zsh 5.9
against `849`, `850`, `852` on three lines:

| Form | zsh | bash / sh |
|---|---|---|
| `prs=$(gh pr list …)` then `for pr in $prs` | **1 iteration**, all three glued into one value | 3 |
| `for pr in $(gh pr list …)` | 3 | 3 |
| `for _ in $(seq 1 60)` | 60 | 60 |

## Word the rule against the first row

**Word the rule against the first row.** A warning spelled *never `for x in
$(…)`* names the safe form as the hazard, so a reader avoids the form that works,
keeps the one that collapses, and rewrites correct bounded polls on the way.
A ticket was once filed carrying that inversion in its own remedy clause and in its title,
and its filer measured both forms and retracted it; the corrected rule is this
row. `$(…)` splits. Leave it alone.

## The inline `$(printf …)` form splits on every whitespace character

The inline `$(printf '%s\n' "$prs")` form splits correctly too and is what Phase
3's block uses, but it splits on *every* whitespace character, so it is safe only
for values that cannot contain one — PR numbers cannot, branch names and paths
can. Measured on a two-line list whose first value is `two words`: three
iterations through `$(printf …)`, two through `while IFS= read -r`. On an empty
`$prs` the counts diverge the other way: `for pr in $(printf '%s\n' "$prs")`
iterates **zero** times, but the heredoc form iterates **once** with `pr` empty —
the guard in SKILL.md's heredoc block is what stops that iteration from probing `--pr ""`.

## `</dev/null` every command inside a `while read` loop

**`</dev/null` every command inside a `while read` loop.** The loop's stdin *is*
the list, and any inner command that reads stdin eats the rest of it. Measured on
the three-line list above: one unredirected inner reader takes the loop to **1
iteration**, `</dev/null` on it restores 3 — the identical signature to the
word-split bug, so a correct heredoc fix missing this half looks exactly like no
fix at all, and reads as one.

## `status` is a read-only variable in zsh

**`status` is a READ-ONLY variable in zsh**, an alias for `$?`. So the obvious
bash idiom for reading the payload — `status=$(jq -r '.status' ci.json)` — aborts
with `read-only variable: status`. Measured this way it fails safe (a hard abort,
no merge), but the same assignment inside an `if`, or with stderr suppressed,
reads as a check that silently did not run. Same root cause as the `PIPESTATUS`
trap, opposite failure direction — so name the variable anything else
(`ci_status`).
