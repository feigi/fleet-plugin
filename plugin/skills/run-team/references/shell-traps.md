# Shell traps

## Shell traps

Monitor and Bash commands run under **zsh**, and the shell in SKILL.md is
prescriptive — copied verbatim into a watcher or into the merge bot's agent
body. So every trap here is a zsh-vs-bash difference that ships as a
green-looking gate: correct in the shell you tested in, silently wrong in the
one it runs in. **Own the CI waits**'s monitor paragraph points here instead of
restating any of it. The merge bot's agent body is the one place this block is
copied whole (see **The merge bot**); the other deliberate copy is named at the end.

A bot already looping cannot be corrected — the loop consumes the turns a correction would land in — so `agents/fleet-merge-bot.agent.md` carries **every entry in `references/shell-traps.md`'s Shell traps**, each written out in full: the rules with the measurements from that file beside them, and the bot has them before its first turn. An edit to `references/shell-traps.md` lands in that body in the same change.

**zsh word-splits an unquoted command substitution's result; it does NOT split an unquoted parameter expansion.**

**Word the rule against the first row.**

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

The inline `$(printf '%s\n' "$prs")` form splits correctly too and is what the watcher block under **Own the CI waits** uses, but it splits on *every* whitespace character, so it is safe only for values that cannot contain one — PR numbers cannot, branch names and paths can.

**`</dev/null` every command inside a `while read` loop.**

**A probe that could not look emits an event; it never `continue`s.** Stated in
full at *A probe that cannot read is a transition event, not silence* under **Own the CI waits**,
and it binds every watcher in SKILL.md rather than that one block: the third
value beside pass and fail is what turns a broken loop into a loud failure
instead of a quiet one. A guard that drops an unreadable probe — `[ -n "$json" ]
|| continue` — makes *could not look* indistinguishable from *nothing to report*.

**`$?`/`PIPESTATUS` is unconditionally-TRUE in zsh.** zsh has no `PIPESTATUS`
(its array is lowercase `pipestatus`, 1-indexed), so `${PIPESTATUS[0]}` is always
empty and `[ "" -eq 0 ]` passes. A bot's merge gate opened without ever reading
an exit code.

**`status` is a READ-ONLY variable in zsh**, an alias for `$?`. Name the variable anything else (`ci_status`).

**The other deliberate copy is `env $cfg sh ./probe.sh`.** The first trap's
mechanism bites argv as well as loops, and that instance stays written out in the
fix-applier body and every refuter brief rather than here,
because the seats that inject faults are the ones that need it and a bot reads
gates without ever injecting one. Do not fold it into this block, and do not
restate this block there.

## zsh splits a command substitution, never an unquoted parameter expansion

That one difference is the whole rule, and the
hazard is the **assigned-variable** form, never `$(…)`. Measured on zsh 5.9
against `849`, `850`, `852` on three lines:

| Form | zsh | bash / sh |
|---|---|---|
| `prs=$(gh pr list …)` then `for pr in $prs` | **1 iteration**, all three glued into one value | 3 |
| `for pr in $(gh pr list …)` | 3 | 3 |
| `for _ in $(seq 1 60)` | 60 | 60 |

## Word the rule against the first row

A warning spelled *never `for x in
$(…)`* names the safe form as the hazard, so a reader avoids the form that works,
keeps the one that collapses, and rewrites correct bounded polls on the way.
A ticket was once filed carrying that inversion in its own remedy clause and in its title,
and its filer measured both forms and retracted it; the corrected rule is this
row. `$(…)` splits. Leave it alone.

## The inline `$(printf …)` form splits on every whitespace character

Measured on a two-line list whose first value is `two words`: three
iterations through `$(printf …)`, two through `while IFS= read -r`. On an empty
`$prs` the counts diverge the other way: `for pr in $(printf '%s\n' "$prs")`
iterates **zero** times, but the heredoc form iterates **once** with `pr` empty —
the guard above is what stops that iteration from probing `--pr ""`.

## `</dev/null` every command inside a `while read` loop

The loop's stdin *is*
the list, and any inner command that reads stdin eats the rest of it. Measured on
the three-line list above: one unredirected inner reader takes the loop to **1
iteration**, `</dev/null` on it restores 3 — the identical signature to the
word-split bug, so a correct heredoc fix missing this half looks exactly like no
fix at all, and reads as one.

## `status` is a read-only variable in zsh

So the obvious
bash idiom for reading the payload — `status=$(jq -r '.status' ci.json)` — aborts
with `read-only variable: status`. Measured this way it fails safe (a hard abort,
no merge), but the same assignment inside an `if`, or with stderr suppressed,
reads as a check that silently did not run. Same root cause as the `PIPESTATUS`
trap, opposite failure direction — so name the variable anything else
(`ci_status`).
