# Isolation: filesystem vs stack

Why the isolation envelope is a file and not a briefing, and why a private
filesystem is not a private stack. The assertions these justify live in SKILL.md's
Phase 1 and Guards sections; the evidence is here.

## Materialize the isolation envelope as a file, not a briefing

Env vars in a prompt were missed five times in one run — including by a briefed
member, and by a specialist whose parent was briefed but did not pass them down.
So `claim-ticket.sh` writes the runner as a file (`.worktrees/<N>-slug/agent-test`)
and `.git/info/exclude`s it. Brief members with `./agent-test <file>` and nothing
else: anyone who finds the worktree finds the runner — including grandchildren you
never dispatched. Ports derive from `<N>`, so collisions are impossible rather
than discouraged — the difference between a safeguard and a rule.

## Filesystem isolation is not stack isolation

The snapshot and `./agent-test` solve different problems, and conflating them is
how the second gets skipped: the compose project name comes from the environment,
not the working directory, so three agents on three snapshots still collide on one
postgres. Symlinking `node_modules` does not help. "I'm on my own copy" is exactly
the intuition that skips the runner — say both, every time.

## Per-member scratchpad subdirectory

One flat namespace, generic filenames (`b.min.js`, `probe.mjs`) — one agent
overwrote a sibling's `package.json`. Each member gets its own scratchpad
subdirectory so throwaway files cannot collide by name.

## IDE/harness diagnostics attribute by bare filename, with no path

Probe copies carry the same filenames as the real tree, so a specialist's
throwaway mutation surfaces as errors that read exactly like a live worktree's —
and the line numbers can plausibly line up with real in-flight edits. Never relay
a diagnostic without reproducing it in that member's specific worktree
(`npx tsc --noEmit` from there). Ran twice in one session: clean the first time
(a sibling's probe), genuinely broken the second. Telling an implementer to chase
a phantom in a file it is mid-rewrite on is the expensive failure.
