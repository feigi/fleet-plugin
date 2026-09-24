#!/usr/bin/env python3
"""Probe script for issue #1772 (omp-liveness-pool research).

NOT a standalone script — every function body below is exactly what was
pasted into an omp `eval` (Python) cell during the live probe on
2026-09-24. It depends on that kernel's injected globals (`agent`,
`workpool`, `read`/`write` prelude helpers) and on the `omp` CLI being on
PATH. Kept here as a record of the exact probe, re-runnable by pasting each
function's body into a fresh `eval` cell in order.
"""

import re
import subprocess
import time
from collections import Counter


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
    """(a): the two bare reads the census question starts from.
    Run via the `read` tool, not inside `eval`:
      read proc://
      read history://
    Both return one table each. Filtering the `id` column by name-pattern
    alone (impl-*, fix-pr-*, finisher-pr-*, merge-bot-*) is NOT a live
    census — see probe_a_census_accuracy() for what it miscounts."""


def probe_a_census_accuracy():
    """(a): what an id-prefix regex over ONE bare read actually counts,
    against the history:// status column as the reference. Re-run during
    PR #1783's review from a fleet member's seat mid-run; uses the eval
    prelude's read(), which delegates proc:// and history:// to the read
    tool."""
    hist = read("history://")  # noqa: F821
    rows = []
    for line in hist.splitlines():
        line = re.sub(r"^\d+:", "", line)
        if not line.startswith("|") or re.match(r"^\|\s*(id|---)", line):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        rows.append({"id": cells[0], "status": cells[1], "parent": cells[3], "last": cells[4]})
    naive = re.compile(r"^(impl|fix-pr|finisher-pr|merge-bot)-")
    matched = [r for r in rows if naive.match(r["id"])]
    running = [r["id"] for r in rows if r["status"] == "running"]
    proc_ids = [l.split(" ")[0] for l in read("proc://").splitlines() if l.strip()]  # noqa: F821
    print("history rows:", len(rows), dict(Counter(r["status"] for r in rows)))
    print("naive id-regex matches:", len(matched), dict(Counter(r["status"] for r in matched)))
    print("  of which not running:", [(r["id"], r["status"], r["last"]) for r in matched if r["status"] != "running"])
    print("  of which dot-qualified children:", [r["id"] for r in matched if "." in r["id"]])
    print("history running:", running)
    print("proc ids:", proc_ids)
    print("running agents absent from proc://:", [i for i in running if i not in proc_ids])
    # Measured 2026-09-24, mid-run:
    #   history rows: 190 {'running': 10, 'parked': 180}
    #   naive id-regex matches: 19 {'parked': 10, 'running': 9}
    #   of which not running: impl-1712, impl-1744, fix-pr-1742, fix-pr-1733,
    #     fix-pr-1733.RefuteDashDash, fix-pr-1733.RefuteDiffSwallow,
    #     fix-pr-1762, merge-bot-wave1, merge-bot-wave2, fix-pr-1762b
    #     (all parked, 3-4h ago)
    #   of which dot-qualified children: fix-pr-1733.RefuteDashDash,
    #     fix-pr-1733.RefuteDiffSwallow
    #   proc ids: 8 running fix-pr-* task jobs + 2 services
    #   running agents absent from proc://: Main, fix-pr-1783 (the reader)


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
