# Instruments

## What it is for

Detecting — never preventing — a silent change to the scripts and
runbooks the controller's own gate decisions depend on. The controller
reads its instruments out of the main checkout, and any dispatched
member can write to that same checkout.

## How it works
1. **Scope.** [`instruments.sh`](../../plugin/scripts/instruments.sh)
   hashes the content of every tracked file under the plugin's own
   component directories (`plugin/commands/ plugin/scripts/
   plugin/skills/ plugin/agents/ plugin/workflows/`) in the AUDITED
   tree: the checkout the baseline records (see 2), else the working
   directory's checkout (or `--repo <path>` for a named worktree).
2. **Pin and compare.** `--pin` writes the digest to the STATE HOME's
   `.fleet/instruments.sha` (the cwd checkout, or `--repo`'s) beside a
   `root=` line naming the audited tree; a bare run reads the baseline
   first, audits the recorded tree — re-verifying it is still that
   checkout and refusing (2) if it moved — then compares. On a
   workspace that does not track `plugin/…`,
   `--pin --audit <plugin-checkout>` names the tree once and every
   later check, `merge-gate.mjs`'s leg included, follows it with no
   further flag. The pointer is honoured only in that shape: a
   recorded FOREIGN root in a home that tracks its own set, or an
   `--audit` naming one, refuses — a writable `.fleet/` must not
   become a way to move the gate onto a tree its writer controls.
3. **Exit.** 0 = unchanged; 1 = the tree changed under the pin (finding
   named on stderr, with `git status` for the uncommitted half); 2 =
   the question couldn't be answered (no baseline, or an unreadable
   baseline/tree). Only 0 lets a gate proceed.
4. **When.** The controller pins once at run start and re-checks before
   every gate decision that acts on an instrument's own output — a SHA
   acceptance, a CI verdict, a reap, a label gate. The
   [Finisher](finisher.md) and [Merge bot](merge-bot.md) each carry
   their own copy of the re-check rule in their own dispatch briefs.

## Opinionated choices

- **Tracked, content-hashed files only** — not the whole repo, not
  `git status`, not file mode. `docs/metrics/` is appended by the
  controller mid-run, so a whole-repo digest would fire on the run's
  own bookkeeping every time, teaching the controller to ignore the
  guard.
- **`git status` is deliberately not the mechanism.** It answers off
  the stat cache, so a same-size, same-mtime content change would pass
  silently; hashing bytes accepts a bare `touch` and refuses a rewrite.
- **Refs are deliberately excluded**, even though a stray branch
  matters, because `claim-ticket.sh` and
  [`reap.sh`](../../plugin/scripts/reap.sh) move refs constantly as
  ordinary work — a per-gate ref check would be pure noise.
