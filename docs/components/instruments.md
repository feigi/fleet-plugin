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
   - `linked-checkout` (a link to `<checkout>/plugin`, exit 2 for any
     other link target outside omp's cache) — **git mode**: the content
     of every tracked file under `plugin/commands/ plugin/scripts/
     plugin/skills/ plugin/agents/ plugin/workflows/` of that checkout.
   - `npm-install` (a real directory) and `marketplace-install` (a link
     into `.omp/plugins/cache/`) — **files mode**: the content of every
     regular file and symlink under `commands/ scripts/ skills/ agents/
     workflows/` of the realpath, dotfiles included, `package.json` and
     the rest of the top level out.
2. **Pin and compare.** `--pin` writes the baseline to the STATE HOME's
   `.fleet/instruments.sha` (the cwd checkout, or `--repo`'s), which only
   locates the baseline. Line 1 is the digest; line 2 is `root=` —
   the checkout's toplevel in git mode, the realpath in files mode;
   line 3 is `commit=<HEAD>` in git mode (absent when HEAD is unborn or
   unreadable) or `version=<package.json version>` in files mode (absent
   when unreadable). A bare run reads the baseline, resolves the live
   Install root again and compares it with `root=` before hashing
   anything: another path, another kind or no `root=` line at all
   refuses (2). The recorded root is evidence, never followed, so a
   forged `root=` can only make the check refuse. A workspace that does
   not track `plugin/…` pins with no flag.
3. **Exit.** 0 = unchanged; 1 = the tree changed under the pin (finding
   named on stderr — in git mode with `git status` for the uncommitted
   half, then the pin commit and whether HEAD `advanced` past it,
   `rewound` behind it, `diverged` from it or is `unmoved`, or, when git
   cannot compare the two, that the relation is `unknown`; in files mode
   the pinned and current package version and the maintainer's choice to
   adopt or restore it); 2 = the question couldn't be answered (no
   baseline, an unreadable baseline or tree, an Install root that cannot
   be resolved or now resolves elsewhere than the pin). Only 0 lets a
   gate proceed.
4. **When.** The controller pins once at run start and re-checks before
   every gate decision that acts on an instrument's own output — a SHA
   acceptance, a CI verdict, a reap, a label gate. The
   [Finisher](finisher.md) and [Merge bot](merge-bot.md) each carry
   their own copy of the re-check rule in their own dispatch briefs.

## Opinionated choices

- **Tracked files of a checkout, every file of a package, content-hashed**
  — not the whole tree, not `git status`, not file mode. `docs/metrics/`
  is appended by the controller mid-run, so a whole-repo digest would
  fire on the run's own bookkeeping every time, teaching the controller
  to ignore the guard. A checkout's untracked files would fire it on
  ordinary runs; nothing in a package is untracked, and anything in it
  executes.
- **`git status` is deliberately not the mechanism.** It answers off
  the stat cache, so a same-size, same-mtime content change would pass
  silently; hashing bytes accepts a bare `touch` and refuses a rewrite.
- **Refs are deliberately excluded**, even though a stray branch
  matters, because `claim-ticket.sh` and
  [`reap.sh`](../../plugin/scripts/reap.sh) move refs constantly as
  ordinary work — a per-gate ref check would be pure noise.
