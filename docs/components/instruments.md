# Instruments

## What it is for

Detecting — never preventing — a silent change to the scripts and
runbooks the controller's own gate decisions depend on. The controller
reads its instruments out of the Install root — the tree `fleet-run`
executes and omp loads the runbooks from — and any dispatched member can
write to that tree: `member-write-guard` refuses a member's
`write`/`edit`/`ast_edit` into the Install root, but a `bash` or `eval`
write lands there anyway.

## How it works
1. **Scope.** [`instruments.sh`](../../plugin/scripts/instruments.sh)
   certifies the live Install root, resolved inline on every pin and
   every check from `$HOME/.omp/plugins/node_modules/@feigi/fleet-ctl`
   the way `fleet-run` resolves it, with the kind named as
   `fleet-provenance` names it:
   - `npm-install` (a real directory) and `marketplace-install` (a link
     into `.omp/plugins/cache/`) — the content of every regular file and
     symlink under `commands/ scripts/ skills/ agents/ workflows/` of the
     realpath, dotfiles included, `package.json` and the rest of the top
     level out.
   - `linked-checkout` (any other link, `omp plugin link`) — **refused**,
     at pin and at check: exit 2, nothing on stdout, the message naming
     the link and saying to `omp plugin uninstall @feigi/fleet-ctl` and
     `omp plugin install @feigi/fleet-ctl`. A fleet run executes an
     installed package; a linked working tree moves under it with every
     checkout and edit. The link stays the dev loop for interactive
     sessions.
2. **Pin and compare.** `--pin` writes the baseline to the STATE HOME's
   `.fleet/instruments.sha` (the cwd checkout, or `--repo`'s), which only
   locates the baseline. Line 1 is the digest; line 2 is `root=`, the
   realpath; line 3 is `version=<package.json version>` (absent when
   unreadable). A bare run reads the baseline, resolves the live
   Install root again and compares it with `root=` before hashing
   anything: another path, another kind or no `root=` line at all
   refuses (2) — a baseline an older plugin recorded for a checkout
   included. The recorded root is evidence, never followed, so a
   forged `root=` can only make the check refuse. A workspace that does
   not track `plugin/…` pins with no flag.
3. **Exit.** 0 = unchanged; 1 = the tree changed under the pin (finding
   named on stderr: the pinned and current package version and the
   maintainer's choice to adopt or restore it); 2 = the question
   couldn't be answered (no baseline, an unreadable baseline or tree, a
   linked checkout, an Install root that cannot be resolved or now
   resolves elsewhere than the pin). Only 0 lets a gate proceed. A
   fast-forward of the workspace checkout after the pin is exit 0: the
   pin certifies the installed package, not the checkout.
4. **When.** The controller pins once at run start and re-checks before
   every gate decision that acts on an instrument's own output — a SHA
   acceptance, a CI verdict, a reap, a label gate. The
   [Finisher](finisher.md) and [Merge bot](merge-bot.md) each carry
   their own copy of the re-check rule in their own dispatch briefs.

## Opinionated choices

- **Every file of a package, content-hashed** — not the whole tree, not
  file mode. `docs/metrics/` is appended by the controller mid-run, so a
  whole-repo digest would fire on the run's own bookkeeping every time,
  teaching the controller to ignore the guard. Nothing in a package is
  untracked, and anything in it executes.
- **The bytes are hashed, never a stat cache**, so a bare `touch` is
  accepted and a rewrite refused.
- **A linked checkout is refused, not certified.** A working tree moves
  under a run with every checkout, merge and edit in it, which no digest
  can tell from tampering.
