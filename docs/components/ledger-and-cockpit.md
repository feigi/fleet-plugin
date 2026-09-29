# Ledger & Cockpit

## What it is for

The durable record of one run's state — every claim, dispatch, and
settled outcome — and the read-only UI built over it. A controller's own
context compacts; a controller that has lost its dispatch map redoes
finished work. The ledger exists so it never has to.

## How it works
1. **Write.** [`ledger.mjs`](../../plugin/scripts/ledger.mjs) owns
   `.fleet/ledger.md`, one row per ticket, serialized by a file lock —
   without it, concurrent writers would be last-writer-wins (#531).
   `row`/`settle`/`dispatch`/`drain` are the controller's own
   subcommands; `filed`/`ruled` are
   append-only, outliving the reasoning that produced them.
2. **Track.** `dispatch` writes a member's live token (e.g. `impl-412`)
   onto its row and appends it to `## Dispatched`; `settle` rewrites it
   to `<member>=<outcome>` in both places. Token grammar lives in
   [`ledger-grammar.mjs`](../../plugin/scripts/ledger-grammar.mjs),
   shared by every reader.
3. **Derive.** This one file lets
   [`fleet-tick.mjs`](../../plugin/scripts/fleet-tick.mjs) derive every
   live count — implementers, review units, holds, unclaimed Shortlist
   depth — without asking a controller to remember anything.
4. **Serve.** [`board.mjs`](../../plugin/scripts/board.mjs) (`fleet-run
   board.mjs serve --open`) is the cockpit: a read-only mirror of the
   ledger plus live `gh` state, computed by the pure `computeBoard()` in
   [`compute-board.mjs`](../../plugin/scripts/compute-board.mjs). It
   never depends on the controller feeding it; a second launch for the
   same workspace is idempotent. A spend panel layers in a third input
   — the local `~/.omp/agent/sessions` transcript tree — kept strictly
   to the side: it can only populate or omit a `spend` figure, never
   move a ticket's stage.

## Opinionated choices

- **The ledger is the single source of truth for liveness counts; the
  controller's own memory is not trusted.** Every subcommand rewrites
  the whole file from what it loaded, so a reader (the tick, the
  cockpit, a fresh controller after compaction) can reconstruct run
  state from the file alone.
- **Filings and rulings are append-only on purpose.** A row rewritten
  in place can lose history a later reader needs, while `filed`/`ruled`
  are the run's own audit trail.
- **The cockpit is read-only by construction.** It has no write path
  back into the ledger, so a maintainer watching it can never
  accidentally steer the run.
