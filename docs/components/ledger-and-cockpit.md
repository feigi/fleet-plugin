# Ledger & Cockpit

## What it is for

The durable record of one run's state — every claim, dispatch, and
settled outcome — and the read-only UI built over it. A controller's own
context is the least durable thing in a fleet run: it compacts, and a
controller that has lost its dispatch map redoes finished work. The
ledger exists so it never has to.

## How it works

[`ledger.mjs`](../../plugin/scripts/ledger.mjs) owns `.fleet/ledger.md`,
one row per ticket, serialized by a file lock so concurrent writers are
last-writer-wins rather than corrupting. `row` and
`settle`/`dispatch`/`drain` are the controller's own subcommands (run
state); `filed`/`ruled` are append-only, because their whole purpose is
to outlive the reasoning that produced them. `dispatch` writes a member's
live token (e.g. `impl-412`) onto its ticket's row and appends it to `##
Dispatched`; `settle` rewrites that token to `<member>=<outcome>` in both
places — an implementer's settle to `PR#M` also folds the PR's own row
into its ticket's. The grammar for every token — member families
(`impl`, `review-pr`, `fix-pr`, `finisher-pr`, `merge-bot`), their
outcome vocabulary, and the retry-suffix convention (`-b`, `-c`, ...) —
lives in [`ledger-grammar.mjs`](../../plugin/scripts/ledger-grammar.mjs),
shared by every reader so nothing re-implements the parse. This one file
is what lets [`fleet-tick.mjs`](../../plugin/scripts/fleet-tick.mjs)
derive every live count — implementers, review units, holds, merge-bot
passes, unclaimed Shortlist depth — without asking a controller to
remember anything. [`board.mjs`](../../plugin/scripts/board.mjs) (`node
~/.fleet/bin/fleet-run board.mjs serve --open`) is the cockpit: a
read-only mirror of the ledger plus live `gh` state, computed by the pure
`computeBoard()` in
[`compute-board.mjs`](../../plugin/scripts/compute-board.mjs) and served
as `board.html`/`board.json`, refreshed on its own loop — it never
depends on the controller feeding it, and launching it twice for the same
workspace is idempotent (an identity handshake finds the already-running
server). A spend panel layers in a third input, the local
member-transcript tree under `~/.omp/agent/sessions`, kept strictly to
the side: it can only populate or omit a `spend` figure, never move a
ticket's stage.

## Opinionated choices

The ledger is the single source of truth for liveness counts; the
controller's own memory is explicitly not trusted for it — every
subcommand rewrites the whole file from what it loaded specifically so a
reader (the tick, the cockpit, a fresh controller after compaction) can
reconstruct run state from the file alone. Filings and rulings are
append-only on purpose: a row that's rewritten in place can lose history
a later reader needs, while `filed`/`ruled` are the run's own audit trail
and must survive exactly what produced them. The cockpit is read-only by
construction — it has no write path back into the ledger, so a
maintainer watching it can never accidentally steer the run.
