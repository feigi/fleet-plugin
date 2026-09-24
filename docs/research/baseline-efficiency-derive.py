#!/usr/bin/env python3
"""Derivation script for issue #1769 (R1): baseline the four efficiency
signals the wayfinder ADRs will guard on, over the most recent run(s)
totalling >=20 merged PRs.

PREREQUISITE, MACHINE-LOCAL: this reads the raw omp session transcript
directly from `~/.omp/agent/sessions/-dev-fleet-plugin/<session>`. That tree
is not part of the git repo and is not portable — it only exists on the
workstation that ran the fleet session. Re-running this script anywhere else
requires that same transcript tree (or a different SESSION_DIR pointed at a
different session covering >=20 merged PRs).

It also shells out to `plugin/scripts/member-outcomes.mjs` (must be run from
the repo root) and to `gh pr list` (needs `gh` authenticated against
feigi/fleet-plugin).

Run: `python3 docs/research/baseline-efficiency-derive.py` from the repo root.

METHOD SUMMARY (see docs/research/baseline-efficiency.md for the full
write-up):
  - The window is ONE continuous omp session
    (2026-09-18T15-04-10-915Z_01a0b50b-e5a3-76ce-9591-42b8312f5408), the most
    recent session with settled (non-growing) transcripts, spanning three
    `/fleet-ctl:run-team` invocations (`3 6`, `2 5`, `2 5`) and 75 verified
    merged PRs — comfortably over the >=20 floor.
  - Signal 1/2 (cache_creation per merged PR): sum tokens_cache_create across
    all of this session's dispatched members (role != memory) for the fleet
    total; fold the session's OWN top-level transcript's assistant turns for
    the controller total. Divide each by n=75.
  - Signal 3 (implementer idle ratio): read each implementer-role member's
    own transcript for its first/last timestamp (its live interval), sweep
    those intervals against the declared cap from each `/run-team <impl>
    <reviewers>` invocation, piecewise by invocation.
  - Signal 4 (review start latency): earliest session_init dispatch,
    across this session's specialist/reviewer/finisher members, whose task
    text names a given PR (via its `.fleet/scratch/pr<N>` path or a bare
    `PR #<N>`), minus that PR's `createdAt` from `gh pr list`.
"""
import json, re, subprocess, statistics
from pathlib import Path
from datetime import datetime

HOME = Path.home()
SESSION_NAME = "2026-09-18T15-04-10-915Z_01a0b50b-e5a3-76ce-9591-42b8312f5408"
SESSION_DIR = HOME / ".omp/agent/sessions/-dev-fleet-plugin" / SESSION_NAME
TOP_JSONL = SESSION_DIR.parent / f"{SESSION_NAME}.jsonl"

COLUMNS = ["session", "run_date", "role", "member", "model", "effort", "ticket", "pr",
           "tokens_cache_create", "tokens_out", "wall_s", "turns", "agent", "harness",
           "subagent_type"]


def parse_ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def scrape_member_outcomes():
    """Re-run the project's own scraper against the target session, into a
    scratch TSV (never the tracked docs/metrics/member-outcomes.tsv)."""
    out = Path("/tmp/baseline-efficiency-mo.tsv")
    if out.exists():
        out.unlink()
    subprocess.run(
        ["node", "plugin/scripts/member-outcomes.mjs", str(SESSION_DIR), "--file", str(out)],
        check=True, capture_output=True, text=True,
    )
    rows = []
    with open(out, encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line.strip() or line.startswith("#"):
                continue
            cells = line.split("\t")
            if len(cells) != len(COLUMNS):
                continue
            rows.append(dict(zip(COLUMNS, cells)))
    return rows


def fetch_merged_prs():
    p = subprocess.run(
        ["gh", "pr", "list", "--state", "merged", "--limit", "400",
         "--json", "number,mergedAt,createdAt"],
        check=True, capture_output=True, text=True,
    )
    data = json.loads(p.stdout)
    return {d["number"]: d for d in data if d["mergedAt"]}


def first_last_ts(path):
    first = last = None
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if not line.strip():
                    continue
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                ts = d.get("timestamp")
                if isinstance(ts, str):
                    first = first or ts
                    last = ts
    except FileNotFoundError:
        return None, None
    return first, last


def avg_live(intervals, lo, hi):
    """Time-weighted average of concurrently-live intervals within [lo, hi)."""
    clipped = []
    for s, e in intervals:
        s2, e2 = max(s, lo), min(e, hi)
        if s2 < e2:
            clipped.append((s2, e2))
    if not clipped:
        return 0.0
    events = sorted([(s, 1) for s, e in clipped] + [(e, -1) for s, e in clipped])
    area, live, prev_t = 0.0, 0, lo
    for t, delta in events:
        area += live * (t - prev_t).total_seconds()
        live += delta
        prev_t = t
    area += live * (hi - prev_t).total_seconds()
    total_s = (hi - lo).total_seconds()
    return area / total_s if total_s > 0 else 0.0


def main():
    rows = scrape_member_outcomes()
    print(f"scraped {len(rows)} member rows from {SESSION_NAME}")

    # --- Signal 1: fleet cache_creation per merged PR ---
    fleet_total = sum(int(r["tokens_cache_create"] or 0) for r in rows if r["role"] != "memory")

    # --- n: verified merged PRs this session dispatched work for ---
    merged_by_num = fetch_merged_prs()
    candidates = {int(r["pr"]) for r in rows if r["pr"]}
    for r in rows:
        if r["role"] == "merge-bot":
            m = re.search(r"mergebot(\d+)", r["member"])
            if m:
                candidates.add(int(m.group(1)))
            m2 = re.search(r"merge-bot-w\d+[a-z]?-(\d+)", r["member"])
            if m2:
                candidates.add(int(m2.group(1)))
    # fixapplier<N> members (a naming variant parseMemberName does not parse)
    # also embed a PR number directly.
    for r in rows:
        m = re.match(r"^fixapplier(\d+)$", r["member"])
        if m:
            candidates.add(int(m.group(1)))
    verified_merged = sorted(n for n in candidates if n in merged_by_num)
    n = len(verified_merged)
    print(f"n = {n} verified merged PRs (candidates not merged: "
          f"{sorted(c for c in candidates if c not in merged_by_num)})")

    # --- Signal 2: controller cache_creation per merged PR ---
    controller_cache_create = 0
    with open(TOP_JSONL, encoding="utf-8", errors="replace") as f:
        for line in f:
            if not line.strip():
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            m = d.get("message")
            if d.get("type") == "message" and isinstance(m, dict) and m.get("role") == "assistant" and m.get("usage"):
                controller_cache_create += int(m["usage"].get("cacheWrite") or 0)

    # --- Signal 3: implementer idle ratio ---
    impl_intervals = []
    for r in rows:
        if r["role"] != "implementer":
            continue
        f, l = first_last_ts(SESSION_DIR / f"{r['member']}.jsonl")
        if f and l:
            impl_intervals.append((parse_ts(f), parse_ts(l)))

    invocations = [  # (timestamp, implementer-cap) read off the session's own
                     # literal "/fleet-ctl:run-team <impl> <reviewers>" lines
        (parse_ts("2026-09-18T15:04:56.850Z"), 3),
        (parse_ts("2026-09-19T21:38:11.735Z"), 2),
        (parse_ts("2026-09-22T17:47:21.419Z"), 2),
    ]
    session_end = parse_ts("2026-09-23T06:26:29.390Z")
    bounds = [t for t, _ in invocations] + [session_end]
    segments = [(bounds[i], bounds[i + 1], invocations[i][1]) for i in range(len(invocations))]

    num, den = 0.0, 0.0
    for lo, hi, cap in segments:
        a = avg_live(impl_intervals, lo, hi)
        dur = (hi - lo).total_seconds()
        idle = (cap - a) / cap
        num += idle * dur
        den += dur
    idle_ratio = num / den

    # --- Signal 4: review start latency ---
    pr_first_dispatch = {}
    scratch_re = re.compile(r"scratch/pr(\d+)")
    prref_re = re.compile(r"\bPR #?(\d{4})\b")
    for r in rows:
        if r["role"] not in ("specialist", "reviewer", "finisher"):
            continue
        p = SESSION_DIR / f"{r['member']}.jsonl"
        found = [p] if p.exists() else list(SESSION_DIR.glob(f"**/{r['member']}.jsonl"))
        if not found:
            continue
        try:
            with open(found[0], encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    try:
                        d = json.loads(line)
                    except Exception:
                        continue
                    if d.get("type") == "session_init":
                        t, ts = d.get("task", ""), d.get("timestamp")
                        nums = {int(x) for x in scratch_re.findall(t)} | {int(x) for x in prref_re.findall(t)}
                        for pr_n in nums & set(merged_by_num):
                            if ts and (pr_n not in pr_first_dispatch or ts < pr_first_dispatch[pr_n]):
                                pr_first_dispatch[pr_n] = ts
                        break
        except Exception:
            continue

    latencies = []
    for pr_n, dispatch_ts in pr_first_dispatch.items():
        created = merged_by_num[pr_n]["createdAt"]
        lat = (parse_ts(dispatch_ts) - parse_ts(created)).total_seconds()
        if lat >= 0:
            latencies.append(lat)
    latencies.sort()

    def pct(data, p):
        k = (len(data) - 1) * p
        f, c = int(k), min(int(k) + 1, len(data) - 1)
        return data[f] + (data[c] - data[f]) * (k - f)

    print("\n=== RESULTS ===")
    print(f"n merged PRs               : {n}")
    print(f"1. fleet cache_creation/PR : {fleet_total / n:,.0f}  (total {fleet_total:,})")
    print(f"2. controller cache_creation/PR : {controller_cache_create / n:,.0f}  (total {controller_cache_create:,})")
    print(f"3. implementer idle ratio  : {idle_ratio:.3f}")
    print(f"4. review start latency    : median {statistics.median(latencies)/60:.1f} min, "
          f"p90 {pct(latencies, 0.9)/60:.1f} min  (n={len(latencies)})")


if __name__ == "__main__":
    main()
