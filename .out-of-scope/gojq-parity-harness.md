# gojq Parity Harness

`candidates.test.mjs` runs its dependency-form assertions against **real gojq** as well
as the system `jq`, because `gh --jq` applies gojq and the two engines have different
regex semantics (RE2 vs Oniguruma). The harness — the `JQ_BIN` plumb, `findGojq()`, and
the engine-parity test — stays. Proposals to remove it or to thin it out are refused.

## Why this is out of scope

**Removing the harness as scope creep** misreads which ticket owns it. #58's own
acceptance criteria say the tests must be *"written against the engine `gh` actually
applies — see #63"*, so the harness is required by the ticket rather than smuggled into
it. #63 is itself closed, so removing the harness would leave the gap with no owner at
all. The two genuine defects that arrived with it — an unguarded `spawnSync("go", …)`
that killed the whole file at import on a machine without Go, and a parity test that
stayed green when the `JQ_BIN` plumb was deleted — were both fixed rather than being
arguments against the harness.

**Dropping the `GOJQ_BIN` escape hatch** as config nothing sets is no longer true. It now
carries a hard-failure contract, added precisely because the old probe accepted any
binary that answered `--version`:

```js
if (named && !isGojq(named)) throw new Error(`GOJQ_BIN=${named} is not gojq`);
```

Before that, `GOJQ_BIN=/usr/bin/jq` resolved to system jq and the parity test reported
green having run on Oniguruma under a name claiming RE2 — a false green in the exact
place the harness exists to prevent one.

A related coverage claim was refuted by measurement rather than argument (#340): the jq
program was extracted verbatim and run over 65 fixtures — all four phrase words across
16 forms — under jq 1.7.1-apple and gojq 0.12.19, byte-identical output, plus an
8-mutation single-token matrix. The parity test's narrower phrase coverage is sufficient.

## Prior requests

- #338 — "the gojq harness implements #63, not #58 — remove it"
- #345 — "drop the GOJQ_BIN escape hatch"
