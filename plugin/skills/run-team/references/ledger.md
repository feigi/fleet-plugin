# The run ledger: the evidence behind its rules

Evidence for the rules SKILL.md's wake and dispatch sections state, keyed by the rule each justifies.

## Writer policy: every write is serialized by `<file>.lock`

**Writer policy: the controller owns run state (`row`/`token`/`settle`/`dispatch`/`review`/`drain`/`ruled`);
filers append filings with `filed`; all writes are serialized by `<file>.lock`.**
Every write rewrites the whole file from what it read, so without the lock two
concurrent writers are last-writer-wins — measured, 8 concurrent `filed` kept
2–5 of 8 rows. A writer that cannot take the lock within 10 s exits 2
naming the holder's pid, having written nothing; a lock whose holder is dead is
taken over, and a leftover `<file>.lock.reap` is never reclaimed. One other
shape wedges the lock permanently the same way, needing the same fix: an empty
`<file>.lock` — its writer was killed between creating it and writing its pid
into it — is unparseable and therefore, by design, always read as live rather
than handed to the death check; its timeout names `<file>.lock` itself, since
there is no pid to name. A zombie holder — a pid whose process exited
but whose parent never `wait()`-ed on it — also answers a liveness check as
alive, because the OS keeps a reserved pid until it is reaped, but that is
transient, not a wedge: once the pid is reaped (the parent's own exit is
normally enough to trigger this), the next writer's death check reads it as
dead and takes the lock over the same as any other dead holder — no hand
removal needed. The other two shapes do not clear on their own — remove
`<file>.lock` or `<file>.lock.reap` by hand once nothing is writing. Reads
(`check`, `read`) take no lock.

## The gap the lock does not close

**The gap the lock does not close:** `check` → `gh issue create` → `filed` is
three commands, and the lock covers each one alone, so two filers can both read
`clean` in the seconds before either records. Accepted — the measured
same-run accidental duplicate was filed minutes apart — and no
claim/reserve step exists to close it.

## `check`'s exits and its `verdict`

`check` exits **0** clean, **1** already in this run's filed list, **2** usage
error (no JSON on stdout), **3** the ledger is clean but open or closed tracker issues match — read
those and decide. Exit **3** is scored: some row gh returned has to score above
zero against the subject, because the ANDed query also matches issues the
overlap rates 0.00, and every measured stop over those was survived only by a
reader who overrode it and searched the tracker by hand — obeying it would have
dropped a real deferral. It also prints the closest filed rows with an overlap score.
Those never move the exit code — the same finding gets worded differently by
whoever finds it second — but once the tracker read succeeds, a filed row at or
above `NEAR_SOFT_HIT` in `ledger.mjs` does move the verdict to `soft-hit`, as
does a tracker set with no scoring row in it; a read that failed stays
`unverified`, which outranks both. **Exit 0 is not automatically "safe to file":** when `gh`
cannot be reached the answer is ledger-only, and it says `TRACKER NOT CHECKED` —
an issue filed by an earlier run is invisible to it; and `soft-hit` means rows
worth reading were found while none of them established a duplicate, so read
them before filing. The stdout JSON names all of that in one field:
`verdict` is `already-filed`, `tracker-hit`, `clean`, `soft-hit` or
`unverified`. Only `already-filed` and `tracker-hit` carry a non-zero code, so
`verdict` is the only thing that tells a searched-and-clean tracker from one
that was never read and from one whose rows you have to read yourself.

## Why the ledger outlives your context

One git-ignored `.fleet/ledger.md` per run is updated at every state change through the `~/.fleet/bin/fleet-run ledger.mjs` subcommands (`row`, `filed`, `ruled`, `check`, `read`, `dispatch`, `settle`, `review`, `drain`, `rotate`). Your context is the least durable thing in the run: it compacts, and a controller that loses the dispatch map or the filed list redoes finished work. Two duplicate tickets shipped in one run from exactly that.

## One line per ticket

One line per ticket, rewritten in place (`ledger.mjs row <ticket> <text>`; `ledger.mjs token <key> <token>…` adds a token and keeps every token already on the row):

```
#<t1> impl-<t1>=PR#<p1> → PR#<p1> → MERGED 73b356de
#<t2> impl-<t2>=PR#<p2> → PR#<p2> · fix-pr-<p2> · ports=16<t2> · ruled:6-applies · held-behind:#<t3>
#<t3> impl-<t3> · tier=task-high
#<t4> excluded · behind-pr:#<p2>
#<t5> excluded · behind-issue:#<t3>
```

## Writing before dispatch

A member that dies between spawn and write is invisible — and members die in batches.

## filed and ruled

`filed` is checked with `ledger.mjs check <subject>` before every `gh issue create`, so a finding already recorded this run is not filed twice. That is not a guarantee against duplicates at large; the tracker query, described under `check`'s exits and its `verdict` above, is what covers those.

`ruled` records PR + decision + one-line reason, so a replacement controller does not re-litigate a settled call.

## Label-off and conflict holds

`label-off=<finisher-pr-M[-x]>` is written before you take `ready-to-merge` off PR M on purpose (taking it off before you approve a push, or clearing one left on a moved head), naming that PR's latest finisher attempt: the tick reads a missing label as a finisher's miss only after the last attempt a `label-off=` names, so without it your own removal reads as one.

`ci=<run-id>:<attempt>:<conclusion>` and `held-behind:#<lower>` are row tokens the same way, and so is `conflict-hold:#<pr>` — written by the merge bot itself (`run-merge-bot.md` step 1), or by you off the tick's `CONFLICT` line, naming the row's own PR. It is not an Exclusion: that gates a ticket's claim, this a PR's merge.

`parked=<head>:<body digest>:main-gain-removed:<path>` is a row token too, written by `fleet-event.mjs merge-bot-report` off a merge bot's `main-gain-removed` refusal, binding the PR's head and a digest of its body as they stood: while both still match, the tick counts the PR parked beside the held ones, so it alone never prints `DISPATCH merge-bot`, and a new head or an edited body lifts it with no write. No other refusal reason parks.

## The review pair on a PR's row

A PR's review is not a member, so it carries its own pair of row tokens, written with `review` onto the PR's row (**The reviewer**): `review=wf:<runId>` | `review=member:<name>` at launch, `<name>` being `review-pr-<n>` for the PR's first runner and the next letter its rows do not carry yet (`review-pr-<n>-b`, `-c`, …) for every later one, settled dead as `…=failed`, then `reviewed=<head>:<survived>/<refuted>/<unverified>:<run>` when the result lands, `<run>` the review's `run-XXXXXXXX` run root under `<scratch>/pr<n>/`, which holds its `review.json`.

## The ledger's readability field: `ledger.ok`

The ledger half reports its own readability as its own field, `ledger.ok`, the peer of `tracker.ok`: false when the file did not exist, and false too when the path led to something that did not parse as a ledger — which is what tells a ledger that was read and held nothing filed from one there was nothing to read. The absent case is the normal one for a run's first `check` — `.fleet/` is git-ignored and created lazily by the first write — so it stays `clean` at exit 0, and `ledger.ok` is the field that says why rather than the verdict moving. The stderr warning is deliberately narrower than the field: it fires on a path with no file, so a `--file` that landed on the wrong existing file is a silent `ok:false` with nothing on stderr.

## Suite slots

**The suite slots wedge the same ways, and clear the same way.**

`~/.fleet/suite-slots/<i>.lock` is built on the ledger's lock primitive, so an empty or unparseable `<i>.lock` and a leftover `<i>.lock.reap` are permanent, a zombie holder is transient, and a dead holder is taken over. A wait that expired with exit 75 names each wedged file — remove it by hand once no suite run is running, the way the Writer policy section above removes `<file>.lock`.

## Adding a token

Token additions go through `ledger.mjs token`. `ledger.mjs token <key> <token>…` adds a token and keeps every token already on the row. Re-typing the row with `row` replaces the whole line, so it drops the tokens you do not restate.
