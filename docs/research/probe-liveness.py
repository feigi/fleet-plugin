#!/usr/bin/env python3
"""Probe script for issue #1772 (omp-liveness-pool research).

NOT a standalone script — every function body below is exactly what was
pasted into an omp `eval` (Python) cell during the live probe on
2026-09-24. It depends on that kernel's injected globals (`agent`,
`workpool`, `read`/`write` prelude helpers) and on the `omp` CLI being on
PATH. Kept here as a record of the exact probe, re-runnable by pasting each
function's body into a fresh `eval` cell in order.
"""

import subprocess
import time


def probe_freshagents_setting():
    """(c): read the EFFECTIVE eval.workpool.freshAgents value this session
    runs under. Never writes — matches pool-preflight.mjs's own rule."""
    r = subprocess.run(
        ["omp", "config", "get", "eval.workpool.freshAgents", "--json"],
        capture_output=True, text=True, timeout=10,
    )
    print(r.returncode, r.stdout, r.stderr)
    # Measured 2026-09-24: {"key": "eval.workpool.freshAgents", "value": true, ...}


def probe_hub_absence():
    """(a): confirm `hub` is neither a shell binary nor an eval-kernel
    symbol — run the shell half via `bash`, this half inside `eval`."""
    print('hub' in dir())
    try:
        print(hub)  # noqa: F821
    except NameError as e:
        print("NameError:", e)
    # shell half (run separately via the bash tool):
    #   which hub            -> command not found
    #   hub jobs             -> command not found


def probe_a_bare_reads():
    """(a): one-call liveness census via bare proc:// / history:// reads.
    Run via the `read` tool, not inside `eval`:
      read proc://
      read history://
    Both return one table each; filter the `id` column client-side by
    name-pattern (impl-*, fix-pr-*, finisher-pr-*, merge-bot-*)."""


def probe_a_handle_and_proc(prompt, label):
    """(a): agent() handle + proc://<id> / agent://<id> cross-check."""
    h = agent(prompt, label=label)  # noqa: F821
    print("handle:", h.handle, "status:", h.status)
    # Then, via the `read` tool (not eval):
    #   read proc://<h.id>      -> may transiently 404 right after spawn;
    #                               retry once
    #   read agent://<h.id>     -> "Not found" until the result is delivered
    result = h.wait(timeout=30)
    print("result:", result)
    # Re-read proc://<h.id> / agent://<h.id> after wait(): both resolve.
    return h


def probe_b_lifecycle():
    """(b): workpool push==dispatch lifecycle — status while in flight,
    close-on-full-drain, same-name reopen refusal, new-name reopen ok."""
    pool = workpool(agent="task", name="probe-pull-1")  # noqa: F821
    pool.push("Reply with exactly the word PONG and nothing else.")
    print("in flight:", pool.status())
    # poll (never in production — this is a research probe only):
    for _ in range(60):
        s = pool.status()
        if s["items"]["completed"] + s["items"]["failed"] + s["items"]["cancelled"] >= 1:
            print("settled:", s)
            break
        time.sleep(1)

    # push after close -> RuntimeError: workpool probe-pull-1 is closed
    try:
        pool.push("second item after drain")
    except Exception as e:
        print("push after close:", type(e).__name__, e)

    # reopen SAME name after close -> RuntimeError: workpool "probe-pull-1" already exists
    try:
        workpool(agent="task", name="probe-pull-1")  # noqa: F821
    except Exception as e:
        print("reopen same name:", type(e).__name__, e)

    # reopen under a NEW name -> succeeds immediately
    pool2 = workpool(agent="task", name="probe-pull-2")  # noqa: F821
    pool2.push("Reply with exactly the word PONG3 and nothing else.")
    print("new-name pool:", pool2.status())


def probe_b_stays_open_across_pulls():
    """(b): a pool stays open across multiple pushes as long as at least
    one item is still live; it closes once, on the FIRST moment
    running+queued both hit 0 — not after the first item alone."""
    pool = workpool(agent="task", name="probe-pull-3")  # noqa: F821
    pool.push("Reply with exactly the word ALPHA and nothing else.")
    print("after push #1:", pool.status())
    time.sleep(2)
    pool.push("Reply with exactly the word BETA and nothing else.")
    print("after push #2 (item #1 may still be live):", pool.status())
    for _ in range(60):
        s = pool.status()
        if s["items"]["running"] + s["items"]["queued"] == 0:
            print("both drained, pool closed:", s)
            break
        time.sleep(1)
