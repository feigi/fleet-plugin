
Your brief names you, `merge-bot-<n>`, and your scratch directory. Where the text below writes `<n>` or `<scratch>` it names the value your brief gives you, and `<N>` is the number of the PR you are working.

Label names in this file are roles; the Label map gives the string to type; a member never derives the map.

Read `$(~/.fleet/bin/fleet-run --root)/commands/run-merge-bot.md` and run **one**
pass — drain the queue, re-evaluating after each merge, hold a 15-minute grace
for late labels, then report once and exit. The controller dispatched you, which
is what makes you hold that grace instead of arming your own watcher.
The grace ends early, with the report and the exit, once no PR is open. A refusal of the Label map read that run-merge-bot.md opens the pass with ends the pass before any grace is held, as its **The Label map** says.

Your scratch directory is `<scratch>/`; you write only under
`<scratch>/pr<N>/merge-bot-<n>/`.

Your report is the one file you write outside it: `<scratch>/reports/merge-bot-<n>.json`,
the path your brief names, giving every PR queued when you were dispatched
exactly one verdict — `merged`, `held`, `conflictHold` or `refused` — as
run-merge-bot.md's **One verdict per queued PR** says. Your final
message is the one line your brief gives, `merge-bot-<n>: done <path>`. A Label map
refusal follows that line with what `show` printed.

The shell traps below are copied from the controller's skill, `run-team`. In
them `references/ci-watcher.md` is that skill's file on the controller's CI
watcher, which you do not run; each trap applies to every shell
command and loop you run.

**zsh word-splits an unquoted command substitution's result; it does NOT split
an unquoted parameter expansion.** That one difference is the whole rule, and the
hazard is the **assigned-variable** form, never `$(…)`. Measured on zsh 5.9
against `849`, `850`, `852` on three lines:

| Form | zsh | bash / sh |
|---|---|---|
| `prs=$(gh pr list …)` then `for pr in $prs` | **1 iteration**, all three glued into one value | 3 |
| `for pr in $(gh pr list …)` | 3 | 3 |
| `for _ in $(seq 1 60)` | 60 | 60 |

**Word the rule against the first row.** A warning spelled *never `for x in
$(…)`* names the safe form as the hazard, so a reader avoids the form that works,
keeps the one that collapses, and rewrites correct bounded polls on the way.
A ticket was once filed carrying that inversion in its own remedy clause and in its title,
and its filer measured both forms and retracted it; the corrected rule is this
row. `$(…)` splits. Leave it alone.

**Capture-then-loop needs `while IFS= read -r` fed by a heredoc**, which is
line-exact under every shell:

```sh
while IFS= read -r pr; do
  [ -n "$pr" ] || continue                        # a blank line from an empty capture, not a probe that could not look
  node …/ci-state.mjs --pr "$pr" </dev/null      # every inner call, per the trap below
done <<EOF
$prs
EOF
```

The inline `$(printf '%s\n' "$prs")` form splits correctly too and is what the
watcher block in `references/ci-watcher.md` uses, but it splits on *every* whitespace character, so it is safe only
for values that cannot contain one — PR numbers cannot, branch names and paths
can. Measured on a two-line list whose first value is `two words`: three
iterations through `$(printf …)`, two through `while IFS= read -r`. On an empty
`$prs` the counts diverge the other way: `for pr in $(printf '%s\n' "$prs")`
iterates **zero** times, but the heredoc form iterates **once** with `pr` empty —
the guard above is what stops that iteration from probing `--pr ""`.

**`</dev/null` every command inside a `while read` loop.** The loop's stdin *is*
the list, and any inner command that reads stdin eats the rest of it. Measured on
the three-line list above: one unredirected inner reader takes the loop to **1
iteration**, `</dev/null` on it restores 3 — the identical signature to the
word-split bug, so a correct heredoc fix missing this half looks exactly like no
fix at all, and reads as one.

**A probe that could not look emits an event; it never `continue`s.** Stated in
full at *A probe that cannot read is a transition event, not silence* in `references/ci-watcher.md`,
and it binds every watcher rather than that one block: the third
value beside pass and fail is what turns a broken loop into a loud failure
instead of a quiet one. A guard that drops an unreadable probe — `[ -n "$json" ]
|| continue` — makes *could not look* indistinguishable from *nothing to report*.

**`$?`/`PIPESTATUS` is unconditionally-TRUE in zsh.** zsh has no `PIPESTATUS`
(its array is lowercase `pipestatus`, 1-indexed), so `${PIPESTATUS[0]}` is always
empty and `[ "" -eq 0 ]` passes. A bot's merge gate opened without ever reading
an exit code.

**`status` is a READ-ONLY variable in zsh**, an alias for `$?`. So the obvious
bash idiom for reading the payload — `status=$(jq -r '.status' ci.json)` — aborts
with `read-only variable: status`. Measured this way it fails safe (a hard abort,
no merge), but the same assignment inside an `if`, or with stderr suppressed,
reads as a check that silently did not run. Same root cause as the `PIPESTATUS`
trap, opposite failure direction — so name the variable anything else
(`ci_status`).
