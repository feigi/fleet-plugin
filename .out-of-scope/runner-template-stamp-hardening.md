# Runner Template Stamp Hardening

The `agent-test` runner that `claim-ticket.sh` writes into each worktree carries a
one-line template stamp — a `cksum` of the emitting script — so an operator can tell
whether the runner in front of them came from the current template. Four separate
proposals to harden that stamp and its tests have been examined and rejected. The stamp
stays as it is: a `cksum` of the whole script, assigned to a variable, read one line
later inside the heredoc, with tests that deref the match without a null guard.

## Why this is out of scope

Each proposal was applied to a copy and measured before being refused. They fail for
four different reasons, which is the reason to record them together — the stamp keeps
attracting tidy-looking changes that each cost something the tidiness does not pay for.

**Inlining the `cksum` into the heredoc** (dropping the single-use variable) forecloses
the exit-status guard that two sibling findings want. Inside a heredoc substitution
there is nowhere to read a status or to `die` — the escape hatch was tested, and
`{ cksum … || die; }` still finishes at exit 0 with a blank stamp, because `die` exits
only the subshell:

```sh
# measured: outer script exits 0, stamp emitted blank
# agent-test template: $(cksum "$0" | cut -d' ' -f1 || die "cksum failed")
```

**Swapping `cksum` for a cryptographic hash** solves a problem the stamp does not have.
The stamp over-reports by construction — it hashes the whole script, not the emitted
template — and the error is one-way and documented as such. The docstring half of that
finding, which corrected two overclaims in the comment, *was* applied in PR #247; only
the hash swap is refused.

**Guarding the stamp regex deref in the tests** buys nothing measurable. Under the
mutation it was proposed for, sibling assertions fail first with a message that already
names the missing stamp, so the guarded and unguarded suites report the same defect —
the guard only changes which of several failures prints the tidier text.

**Deleting the `node --test` entrypoint stamp test as subsumed** loses real coverage.
Three distinct mutations confined to that branch survive when the test is removed and
are caught when it is present.

## Prior requests

- #253 — "inline the runner template cksum into the heredoc and drop tmpl_stamp"
- #254 — "replace cksum with a stronger hash for the runner template stamp"
- #255 — "guard the stamp regex deref in claim-ticket.test.mjs"
- #259 — "delete the node --test entrypoint stamp test as subsumed"
