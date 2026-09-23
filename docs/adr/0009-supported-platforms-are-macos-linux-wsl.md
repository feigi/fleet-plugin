# 0009 — Supported platforms are macOS, Linux and WSL; native Windows is not

**Status:** Accepted. Ruled 2026-09-23 while closing #39, against the audit below.

## Context

Until now nothing in the repo stated which operating systems the fleet runs on — not
the README, not CONTEXT.md, not an ADR, not `plugin.json`. The question surfaced on
#39 because the cockpit's `--open` calls `open`, which exists only on macOS.

Audited before ruling:

- **CI is Linux-only.** All three workflows (`ci.yml`, `release.yml`,
  `release-label.yml`) run on `ubuntu-latest`, with no OS matrix.
- **macOS and Linux differ in exactly one place.** `board.mjs` calls
  `tryRun("open", [url])` at three sites for `serve --open`. No GNU-only construct
  was found (`sed -i` without a suffix, `readlink -f`, `stat -c`, `date -d`).
- **Native Windows would be a port, not a fix.** Everything else assumes a POSIX
  shell and filesystem:
  - 13 `#!/bin/sh` scripts (`claim-ticket.sh`, `inflight.sh`, `reap.sh`, …);
  - the Resolver, `fleet-run`, is itself a shell script;
  - about 100 `spawnSync("sh", …)` calls, about 50 `chmodSync` and about 25
    `symlinkSync`, mostly in tests;
  - skill and command prose written for bash/zsh throughout
    (e.g. `plugin/skills/run-team/SKILL.md`'s zsh-vs-bash rules).
- **Unmeasured:** whether either Harness's shell tool runs on native Windows at all.
  Without one, the skills' instructions cannot run there regardless of what the
  scripts do.

## Decision

1. **The fleet supports macOS, Linux, and Windows via WSL.** Native Windows is not
   supported.
2. **Behaviour that works on only some supported platforms is a defect**, the same
   standing a harness-bound artefact has under **Harness**. `--open` is the one known
   instance (#1714).
3. **CI stays Linux-only.** macOS differs from Linux in one call to a program no
   test executes, so a macOS runner would add a second full suite run for no
   coverage. Add `macos-latest` when a second macOS/Linux divergence appears.

## Consequences

- A request for native Windows support is a new planning question — shell scripts
  ported to node, a non-shell Resolver, Windows variants of the prose, a Windows CI
  leg — not a bug against this repo. Answering it starts with measuring the
  Harness shell tools on Windows.
- `process.env.HOME` without an `os.homedir()` fallback (`board.mjs`,
  `member-record.mjs`) is correct on every supported platform and stays.
- Anything that shells out to an OS-provided program (as `--open` does) must name
  its macOS, Linux and WSL behaviour, or it is the defect in point 2.
