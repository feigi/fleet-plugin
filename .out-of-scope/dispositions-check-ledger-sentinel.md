# `dispositions-check.mjs`'s ledger sentinel

`dispositions-check.mjs` carries its "no ledger" state as `ledgerFile === null`
and tests that sentinel at two sites: the gate that decides whether to read and
write the ledger, and the `token` field of the stdout verdict object. A proposal
to consolidate the two null tests has been refused.

## Why this is out of scope

`ledgerFile` is bound once: `null` for a `--no-ledger` (standalone) run,
otherwise whatever `ledgerInUse()` returns — the ledger path, or `null` when
that path does not exist. It is a `const` and is never reassigned, so the two
`ledgerFile === null` tests cannot disagree.

The proposed consolidation — an intermediate
`writtenToken = ledgerFile === null ? null : token` — still tests
`ledgerFile === null` at both the gate and the new binding. It moves one test
rather than removing it, and the script's observable behaviour (exit status,
stdout, ledger writes) is identical either way.

The two sites answer different questions. The gate decides whether the script
touches the ledger at all, an operation that can fail. The `token` field reports
that no token was written when there is no ledger, which the test suite pins
(`token: null` in standalone mode). Each reads the sentinel at the point where
it matters; there is no shared logic to factor out.

## What would reopen this

A change that breaks the single-binding invariant — `ledgerFile` becoming
reassignable, or the ledger choice being made in more than one place — so that
the two tests could diverge. Or a measured defect where a token is reported
without being written, or written without being reported.

## Prior requests

- #2474 — "dispositions-check: ledgerFile === null is re-tested at two sites (refuted: no defect)"
