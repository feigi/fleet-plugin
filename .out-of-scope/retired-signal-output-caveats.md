# Caveats on the Output of a Retired Signal

`docs/research/baseline-efficiency-derive.py` prints a `WARNING: N implementer(s) have no
timestamped transcript line; counted idle: …` line when `implementer_intervals()` skips
members for want of a transcript, but `main()` discards the returned `skipped` list, so
Signal 3's `3. implementer idle ratio` RESULTS line prints with no caveat of its own.
Proposals to carry that list through and annotate the line 3 figure are refused. The
WARNING stays the only notice.

## Why this is out of scope

**The signal is retired.** ADR 0031 (Accepted, ruled on #2875) replaced Signal 3, the
implementer-slot idle ratio, in the guard with cycle time created→merged and merged PRs per
active clock hour, both read from GitHub. No guard reads the idle ratio any more, so the
figure a caveat would annotate informs no decision. The one re-pointed run of the script
since then (`docs/research/baseline-efficiency.md`, 2026-10-18 D6) states that the cap
"feeds only signal 3, which this section does not report."

**It matches the script's existing pattern.** Signal 4's `dispatch(es) precede their PR's
createdAt; excluded` WARNING also prints above `=== RESULTS ===`, and its RESULTS line
carries no caveat either. #3477 asked for exactly the "WARNING line naming the members"
shape, and that is what landed. Caveating line 3 alone would leave Signals 3 and 4
inconsistent; caveating both is more output-format change than a retired signal earns.

**The warning already gives the reader the facts.** It names every skipped implementer and
gives the count, a few lines above the figure. On the reference session (2026-09-18) no
implementer is skipped, so the caveat would never print there.

## What would reopen this

A decision to bring the idle ratio back as a guarded or reported signal. At that point,
caveat Signal 3 and Signal 4 together rather than line 3 alone.

## Prior requests

- #4132 — "baseline-efficiency-derive.py: Signal 3's idle-ratio RESULTS line carries no caveat when implementers were counted idle for want of a transcript" (deferred from PR #4130 review)
