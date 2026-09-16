// The slow-but-working git transport that every bounded-fetch caller's
// end-to-end pair is measured against (#346, #347, #1039).
//
// An ssh stub that sleeps and then serves a REAL bare repo through
// `git upload-pack`, so refs genuinely come back: the accept path is exercised
// against a working transport, not a mock of one. Paired with a budget under
// the delay — and neither half is worth much alone, because an accept-only
// case passes just as well against a watchdog that never fires, which is to
// say against no watchdog at all.
//
// A module rather than a copy per suite. Each caller of net.sh asserts its OWN
// stalled wording, so the wording is the part that cannot be shared and this
// fixture is the part that can; two copies of the stub are how the copies come
// to disagree about what "slow but working" means, the argument net.sh's own
// header makes about restating net_stalled's signal set.
//
// Deliberately not a `.test.mjs`: `node --test plugin/scripts/*.test.mjs` does
// not load it as a suite, and importing a test file to reach a fixture inside
// it would register that file's own tests a second time in whichever suite
// imported it.

import { spawnSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Seconds the stub sleeps before it serves anything. Module-internal on
// purpose: no consumer computes a budget from it, so exporting it would only
// create a second place for the number to be read from.
const SLOW_DELAY_S = 3;

/**
 * The ssh-shaped URL a fixture points `origin` at.
 *
 * `example.invalid` is never resolved: GIT_SSH_COMMAND replaces ssh outright.
 * The URL only has to be ssh-SHAPED, which is what routes git to it at all.
 */
export const SSH_URL = "ssh://git@example.invalid/x/y.git";

/**
 * An ssh stub that sleeps `SLOW_DELAY_S` — 3 seconds, the constant both halves
 * of a caller's pair are chosen against, one budget above it and one under —
 * and then serves the bare repo at `origin` through `git upload-pack`. Returns
 * its path, for GIT_SSH_COMMAND.
 *
 * Written beside `origin` unless `dir` names somewhere else — a fixture whose
 * origin sits outside the tree under test needs the stub where its own cleanup
 * will reach it.
 */
export function slowTransport(origin, dir = dirname(origin)) {
  const stub = join(dir, "slow-ssh.sh");
  writeFileSync(stub, `#!/bin/sh\nsleep ${SLOW_DELAY_S}\nexec git upload-pack '${origin}'\n`);
  chmodSync(stub, 0o755);
  return stub;
}

/**
 * Exec the stub once and discard the result, so the bounded call that follows
 * never pays a freshly written executable's FIRST-execution OS scan cost
 * inside the region the budget bounds (#1099) — measured at ~7s of the 13-14s
 * such a call took while the stub was still cold. Same file, same bytes, so
 * the bounded call only ever execs an already-scanned stub. Exit status is
 * whatever an unfed `git upload-pack` returns and is irrelevant here.
 *
 * Only the over-budget half of a pair needs this: a budget under the delay
 * kills the call at the budget however warm the stub is.
 */
export function warmStub(stub, env) {
  spawnSync(stub, [], { env, input: "", timeout: 10_000 });
}
