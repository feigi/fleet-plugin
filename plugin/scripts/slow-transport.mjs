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

// No executable is written here, and that is the load-bearing part (#2221).
// macOS scans a freshly written executable on its FIRST exec, and that scan is
// a system-daemon latency with no bound under load — measured at 15.0-16.0s
// per fresh file at load average ~25 on 14 cores, against 1.0s for the same
// one-second script exec'd a second time, run as `sh <file>`, or run as
// `sh -c` with no file at all. The stub used to be such a file, exec'd from
// INSIDE the region each caller's budget bounds. #1099 moved that scan out
// with a warm-up exec under a 10s timeout, but the scan outgrew the timeout
// under load, and a first exec killed before it finishes leaves the scan
// unpaid: the next exec of that file measured 14.5-15.0s again. So the
// bounded call paid it anyway, and a ~6s transport crossed a 20s budget — the
// two slow-but-working failures #2221 reports, from a full-suite run.

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
 * A GIT_SSH_COMMAND value for an ssh stub that sleeps `SLOW_DELAY_S` before it
 * serves the bare repo at `origin` through `git upload-pack`.
 *
 * `SLOW_DELAY_S` (3s) is the sleep PER INVOCATION, not the cost a bounded
 * caller actually pays: git's ssh transport invokes this stub TWICE for
 * every network command routed through it — once with `-G` to resolve the
 * connection before it opens one, once for the real session — for a fetch
 * and an ls-remote alike (measured, git 2.50.1). So the region a caller's
 * budget bounds really costs ~2 × SLOW_DELAY_S (~6s measured), and that
 * doubled number, not the 3s constant alone, is what each caller's pair is
 * chosen against: one budget above it, one under.
 *
 * A command line rather than a script path, so the only programs it execs are
 * `sh`, `sleep` and `git`, none of them freshly written (see the header). git
 * runs the value through a shell and appends its own arguments — `-G`, the
 * host, the remote command, and whatever `-o` options the caller under test
 * adds — which land after `$0` and are ignored; `$0` is `origin`.
 */
export function slowTransport(origin) {
  return `sh -c 'sleep ${SLOW_DELAY_S}; exec git upload-pack "$0"' '${origin}'`;
}
