# Carrying the Spend Directory's Harness as a Tag

`findSubagentsDir()` in `plugin/scripts/board.mjs` answers the cockpit spend panel's
"which session directory?" with a bare path. `gatherSpend()` then picks a reader for
that path by its name:

```js
isOmpSessionDirName(basename(dir)) ? readOmpSpend(dir, sinceMs) : readClaudeSpend(dir, sinceMs);
```

Proposals to have `findSubagentsDir()` return `{ harness, dir }` instead, so the
harness travels with the path rather than being read off its name at each consumer,
are refused. The name stays the one place a session directory's harness comes from.

## Why this is out of scope

**A tag cannot replace the name rule; it can only sit beside it.** `gatherSpend()`
is handed bare paths that no tag can reach. The operator's `--spend-dir` arrives
through `spendDirPin()`'s explicit arm under `serve` and through `gather()`'s
`spendDir = argSpendDir()` default under `build`. `board.test.mjs` also hands
`gatherSpend()` its `dir` directly, in 46 `gatherSpend({ dir … })` calls. Every path
that arrives that way still has to be classified by name, so tagging the heuristic's
answer adds a second route to the harness without removing the first. Two routes can
disagree: the same directory could be read by one reader when the heuristic found it
and by the other when the operator named it. Today that cannot happen, because one
predicate answers for every input.

**`member-outcomes.mjs` is not a consumer of `findSubagentsDir()`.** It does not
import `board.mjs`. Its CLI takes a directory from argv, and `run-team`'s phase-3
step feeds it a glob over `"$HOME/.claude/projects/$PROJECT_DIR"/*/subagents`. That
step also says, in bold, not to narrow the scrape with `findSubagentsDir`. A tag
returned in-process cannot cross a process boundary. Carrying it there would take a
`--harness` flag that a human typing the path would have to get right, which is worse
than reading the directory's own name. `member-record.mjs` exports
`isOmpSessionDirName` for exactly this kind of caller, one "that already hold[s] one
EXPLICIT directory", "so the pattern is defined once". Of the two call sites the
proposal counts, one never sees the value the tag would be attached to.

**On the heuristic path the pairing is identity, not convention.** `ompSessionDirs()`
admits a directory only when `isOmpSessionDirName(e.name)` passes, and yields
`join(root, e.name)`. `gatherSpend()` dispatches on `isOmpSessionDirName(basename(dir))`,
and `basename(join(root, name))` is `name`: the same predicate on the same string.
`claudeSessionDirs()` yields `join(root, s, "subagents")`, whose basename is the
literal `subagents`, and the pattern is anchored on four leading digits. Drift in
the admission filter is also caught by the suite. With the filter weakened to
`e.isDirectory()`, `board.test.mjs`'s *"findSubagentsDir on omp picks this
workspace's newest session DIRECTORY — never the main-session file beside it, never
a stray dir"* fails: it resolves the fixture's `notes/` directory instead of the
real session (measured 2026-09-26). `board-cli.test.mjs`'s *"build: on an omp-only
machine the panel comes from this workspace's omp session"* covers the whole chain
end to end, from heuristic through dispatch to `readOmpSpend`'s numbers.

**The reshape runs through the panel's most-reviewed discriminators.** The
heuristic's three answers (a path string, `null`, `{ error }`) travel through
`spendDirPin()` and `gather()` to `gatherSpend()`. They are told apart by
`typeof answer !== "string"` in the pin's latch gate and by `dir?.error` and `!dir`
in `gatherSpend()`. A `{ harness, dir }` answer is an object, like `{ error }`, so
every one of those checks has to change, and any one left behind fails without a
sound. A latch gate left as it is would read every tagged answer as untrustworthy and
never latch, which brings back #1583's alternating panel; nothing throws or warns
when it does. Those guards are #1583's and #1679's, and `gatherSpend()`'s own header
records #959, the bug that came from routing on a field's truthiness instead of an
explicit tag. On top of that, 28 assertions in `board.test.mjs` compare
`findSubagentsDir()`'s or a pin's answer against a bare path. That is a wide, risky
change with no defect behind it, which is the same refusal
[spend-dir-pin-seed-collapse.md](spend-dir-pin-seed-collapse.md) records for this
same function family.

## What would reopen this

Either of these:

- A measured misroute: a directory that `gatherSpend()` read with the wrong harness's
  reader.
- A session source that the name cannot classify, such as a third harness whose
  session directories are not distinguishable by name, or a change that makes
  `claudeSessionDirs()` or `ompSessionDirs()` yield a directory other than the one
  its name describes.

## Prior requests

- #1878 — "Cockpit spend panel: harness tag for a session dir is re-derived at each
  call site instead of carried as data" (deferred from PR #1867 review, `types`
  dimension, suggestion severity)
