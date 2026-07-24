# Isolation: filesystem vs stack

Why isolation envelope file not briefing, why private filesystem not private stack. Assertions these justify live in SKILL.md Phase 1 + Guards sections; evidence here.

## Materialize the isolation envelope as a file, not a briefing

Env vars in prompt missed five times in one run — including briefed member, and specialist whose parent briefed but did not pass down. So `claim-ticket.sh` writes runner as file (`.worktrees/<N>-slug/agent-test`) and `.git/info/exclude`s it. Brief members with `./agent-test <file>` and nothing else: anyone who finds worktree finds runner — including grandchildren you never dispatched. Ports derive from `<N>`, so collisions impossible not discouraged — difference between safeguard and rule.

## Filesystem isolation is not stack isolation

Snapshot and `./agent-test` solve different problems; conflating them is how second gets skipped: compose project name comes from environment, not working directory, so three agents on three snapshots still collide on one postgres. Symlinking `node_modules` does not help. "I'm on my own copy" is exactly the intuition that skips runner — say both, every time.

## Per-member scratchpad subdirectory

One flat namespace, generic filenames (`b.min.js`, `probe.mjs`) — one agent overwrote sibling's `package.json`. Each member gets own scratchpad subdirectory so throwaway files cannot collide by name.

## IDE/harness diagnostics attribute by bare filename, with no path

Probe copies carry same filenames as real tree, so specialist's throwaway mutation surfaces as errors that read exactly like live worktree's — and line numbers can plausibly line up with real in-flight edits. Never relay diagnostic without reproducing it in that member's specific worktree (`npx tsc --noEmit` from there). Ran twice in one session: clean first time (sibling's probe), genuinely broken second. Telling implementer to chase phantom in file it is mid-rewrite on is expensive failure.