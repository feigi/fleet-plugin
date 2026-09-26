# `fleet` cockpit — a live board of the ticket/PR pipeline

Date: 2026-07-24
Status: Design approved, plan pending.
Artifact (planned): `~/.claude/skills/fleet/scripts/board.mjs`,
`~/.claude/skills/fleet/scripts/board.html`,
`~/.claude/skills/fleet/scripts/computeBoard.mjs` (+ test).
Repo: `feigi/claude-config`
Relates to: `docs/specs/2026-07-23-fleet-plugin-design.md`,
`docs/specs/2026-07-22-run-team-agent-fleet-design.md`

## Problem

`/run-team` runs a fleet unattended and emits its status only as a **text table
in the controller's terminal** (SKILL.md "Report"). That table is trapped in the
controller's context — the run's *least durable* thing: it compacts, scrolls
away, and is invisible to anyone not watching that pane. There is no glanceable,
persistent view of "where is every ticket in the pipeline, and does anything
need me right now?"

The controller already has the raw material for such a view. It writes a durable
`.fleet/ledger.md` (one row per ticket, written **before** dispatch, rewritten in
place at every state change), and every other fact — labels, PR state, CI
conclusion — is a `gh` query away.

## Goal

A **live cockpit**: a browser board, refreshed while a wave runs, that shows
every ticket's pipeline stage as a kanban flow with an **attention strip** pinned
on top that surfaces only the exceptions needing a human. It must be:

- **Decoupled from the controller.** Pipeline state is a pure function of
  `ledger + GitHub`. It survives controller compaction or death — the controller
  launches it once and never feeds it again. (The `spend` panel adds a third,
  read-only input — the local transcript tree under `~/.claude/projects`. It is
  telemetry only: it can populate or omit `spend`, never move a ticket.)
- **Zero new failure mode in the event loop.** run-team adds exactly one
  background launch in phase 0; it never has to "remember to update the board."
- **In the plugin's established style.** Node scripts + `gh`, no build step,
  self-contained files, atomic writes — same idiom as `ledger.mjs`,
  `ci-state.mjs`, `diff-stats.mjs`.

Non-goals (v1): a standing repo-wide board independent of runs; a shareable
hosted artifact; multi-run history. `build --once` yields a static end-of-run
snapshot as a free byproduct, which covers the "post-run report" want without
being designed for.

## Rejected alternatives

- **Controller pushes state** (writes `board.json` at each event-loop
  transition). Highest fidelity — the controller knows causes `gh` cannot show
  (killed + replacement dispatched, ruled reasons, collision-defers). Rejected:
  it couples the dashboard to controller liveness (board freezes on death or
  compaction) and adds *another silently-failing rule* to an already-dense
  SKILL.md, contradicting the plugin's own "context is the least durable thing"
  principle. Its one real gain is recovered cheaply — see **Enrichment tier**.
- **Pure client-side GitHub board** (static HTML hitting the GitHub API from the
  browser, no local scripts). Simplest and shareable, but it is a *generic*
  GitHub board, not a fleet cockpit: agent names, rulings, held-behind, filed
  follow-ups and killed members live only in the local ledger and are invisible
  to it — so it **cannot render the attention strip**, which is the point.

## Architecture

Three units with clean boundaries:

1. **`computeBoard(inputs) → boardModel`** — a **pure function**, the tested
   core. Input: parsed ledger (`{rows, filed, ruled}`), `gh` issue list, `gh` PR
   list, per-PR CI state, and the previous `boardModel`. Output: the board model
   (below). No I/O, no `gh`, no clock read inside — time is passed in. All the
   tricky stage-derivation and flag logic lives here so it is unit-testable in
   isolation.
2. **`board.mjs build`** — gathers raw inputs (`ledger.mjs read --require-file`,
   `gh issue list --label ready-for-agent`, `gh pr list`, `ci-state.mjs --pr N`
   per open PR), stamps the current time, calls `computeBoard`, prints
   `board.json` to stdout. `build --once > .fleet/board.json` produces a static
   snapshot.
3. **`board.mjs serve`** — the long-running process. Loop: `build` →
   **atomic-write** `.fleet/board.json` (temp + rename, as `ledger.mjs` does) →
   serve `.fleet/` over a zero-dep node `http` server → sleep `--interval`. Opens
   the browser once (`--open`), from the launch that binds the port and starts
   the server only (#1714): `open` on macOS; elsewhere `xdg-open`, falling back
   to `wslview` (WSL) when `xdg-open` is not on PATH. With neither, it warns on
   stderr with the URL and keeps serving. Plus **`board.html`**, self-contained
   (inline CSS + vanilla JS, no CDN, no build), polling `/board.json`.

   Which `.fleet/` and which port are **derived from the workspace** (#1582),
   not from the cwd: the workspace is the directory holding the shared git dir
   (`git rev-parse --git-common-dir`), the rule `ledger.mjs` already resolves
   the run's one ledger with, so a cockpit started from a linked worktree
   serves its main checkout's state and the board can never disagree with the
   ledger about which run it belongs to. The port is a stable hash of that
   workspace inside a small window above the original default, which keeps the
   URL bookmarkable across runs while letting two workspaces hold two live
   boards at once. An unresolvable git dir degrades to a cwd-relative `.fleet/`
   and warns, in `defaultLedgerPath()`'s wording; it never dies.

   **Launching twice is a no-op that succeeds** (#1585). A derived port that
   is already held is not a failure by itself, so the launch asks the holder
   who it is: it requests `/board.json` with a ~1s timeout and reads the
   `workspace` the payload names. Ours → print that the cockpit is already
   running, with its URL, exit **0**, start nothing, open nothing even under
   `--open` (#1714) — the launch that started it already had its chance. Anyone
   else — a different workspace, a non-200, a body that will not parse, no
   answer at all — → foreign, step to the next port, bounded to a handful of
   attempts inside the derived range. Only an exhausted range is an error,
   and it names every port it tried. The exit code is the whole point: the
   documented launch is backgrounded (`serve --open &`), so a non-zero exit
   there reaches nobody and the operator just waits for a tab that never
   appears. The identity rides the board payload rather than a lockfile
   precisely so nothing can outlive the process that published it. An
   **explicit** `--port` opts out of both halves: the operator named that
   port, so a bind failure on it is a hard error and no handshake is made.

```
ledger.md ─┐
gh issues ─┼─▶ board.mjs build ─▶ computeBoard() ─▶ board.json ─▶ board.html
gh prs   ──┤        (I/O)            (pure)         (atomic)      (poll+render)
ci-state ──┘
prev board.json (dwell tracking)
```

## Stage model — one column per ticket, all derived from `ledger + gh`

(amended by #1820: the table below reads the Pull-era ledger — member tokens
through `ledger-grammar.mjs`, Exclusion rows, MERGED from `gh`, and the
`review=`/`reviewed=` pair. Amendment 2a, #1839: a PR-bound row with no `impl`
token takes its PR the way `fleet-tick.mjs` does — see **The row's PR** below.
Amendment 5a, #1842: a `review=` token marks review only while it is live — see
**REVIEW** below. #1843: the row's latest `impl` token is its greatest retry
suffix — no suffix, then `-b`, `-c`, … — wherever it sits in the row, so any
ordering of one ticket's own impl tokens picks the same impl/outcome/PR (the
card's `agent`, below, is unrelated and still the last *live* member by
position).)

| Column | Derivation (durable, no controller push) |
|---|---|
| **POOL** | open `ready-for-agent` issue with **no** ledger row, or whose row's latest `impl` token settled `=released`/`=bailed` (no card at all once the issue leaves `ready-for-agent`). An Exclusion row (`#N excluded · behind-pr:#M` / `behind-issue:#M`) is a POOL card with an `excluded:#M` badge (`excluded:<branch>` when `#M` is a branch name): supply, never `stale`, never in `attention`, never in the stall report's `claimed` |
| **IMPLEMENTING** | the row's **latest** `impl` token (greatest retry suffix, not last by position) is live `impl-N`, or settled `=killed`/`=tier-mismatch` — the latter two carry that outcome as a flag in `attention` |
| **REVIEW** | the row's PR (below) is open (or closed unmerged), not `ready-to-merge`. Counts toward `reviewBacklog` (surfaced in the page footer as `review-backlog N`) when the row has neither a live `review=` nor a `reviewed=`, and no live `fix-pr-M`/`finisher-pr-M`. Amendment 5a (#1820, implemented by #1842): a settled `review=…=failed` is a dead review, and the PR is owed one again — run-team `SKILL.md`'s review-due and `fleet-tick.mjs`'s `reviewedAny` read the token the same way. A `=failed` followed by a live redispatch (`review=wf:a=failed review=fallback:review-pr-M-b`) is under review; any live `review=` on the row counts, not only the last one, as `reviewedAny` counts it |
| **READY** | PR carries the `ready-to-merge` label |
| **MERGED** | ledger row contains `MERGED <sha>`, or — the token being written by no rule — `gh` reports the row's PR merged, or (#1841) the previous board already showed that same PR MERGED on this ticket, since MERGED is terminal. The token wins when present. `gh` is asked (#1840) about exactly the row PRs none of the rest places — absent from the open list, no token, not carried forward — in one batched `gh api graphql` query per build, whatever their merge age; no such PR, no query. A failed query reads them as not merged (REVIEW) |

The card's `agent` is the latest live member on the row: an unsettled
`ledger-grammar.mjs` member token, or the runner a `review=member:<name>` /
`review=fallback:<name>` names until it is settled `=failed` or a later
`reviewed=` records its result. `review=wf:<runId>` is a Workflow and names
nobody. The uppercase `KILLED`/`BLOCKED`/`SHA-OFF-BRANCH` cause tokens
(Enrichment tier, below) still apply.

**The row's PR.** On a row with an `impl` token it is the latest `impl` token's
`=PR#M` outcome and nothing else: the `→ PR#M` arrow there is human-readable
only. `fleet-tick.mjs`'s `PR_MENTION` is a blind `PR#<n>` text scan that in
practice also lands on the impl token's embedded value, because that
precedes the arrow in every row this run writes — but nothing enforces that
order, so on such a row the arrow is never a value either reader may rely on.

Amendment 2a (#1820, implemented by #1839): a row with **no** `impl` token —
the `#<pr> <member>` row `ledger.mjs dispatch <pr> fix-pr-<pr>` /
`finisher-pr-<pr>` appends for a PR this run's implementers did not open —
has no outcome to read, so once it carries a PR-bound signal (a `PR#M`
mention, a `fix-pr-M`/`finisher-pr-M` member, `review=` or `reviewed=`) it
takes the tick's PR: its first `PR_MENTION`, else its row key when the row's
first word is exactly `#N`. `compute-board.mjs` imports `PR_MENTION` from
`fleet-tick.mjs` rather than restating it, so the two readers name the same PR
for the same row text once it carries a signal; an unsignaled row (no
mention, no PR-bound member, no `review=`/`reviewed=`) stays `pr: null` here
while `fleet-tick.mjs`'s own row-key fallback still keys it to its ticket
number for its own bookkeeping. That PR then decides the column exactly as a `=PR#M`
outcome does: open → REVIEW (or READY), merged by `gh` or by a `MERGED <sha>`
token → MERGED. A malformed `impl` token still counts as one — that row's key
is a ticket — and an Exclusion row, or a row with no signal, takes no PR.

**`## Dispatched` is deliberately not rendered** (amended by #1820). Its job is
the `merge-bot-<n>` counter, and the row tokens already show every member's
liveness; `computeBoard()` reads only `rows`, `filed` and `ruled`.

POOL reflects the whole `ready-for-agent` queue (supply), not only this run's
approved-but-undispatched pool — approval lives in controller context and is not
durable, so the queue is the honest, derivable stand-in.

`filed` and `ruled` are **not** stages: `filed` → a footer count ("N follow-ups
filed"); `ruled` → detail on the relevant PR card.

## Attention strip — two tiers

**v1 — symptom flags** (from `ledger + gh +` the board's own timing):

- **Red CI** — reuse `ci-state.mjs`'s existing genuine-red-vs-behind-staleness
  logic, so a `skipped` heavy job (behind-count staleness, the normal wave case)
  never false-alarms as red.
- **Held-behind** — ledger `held-behind:#M` or the PR's `held-behind-#M` label.
- **Stale** — dwell in a non-terminal column past a per-column threshold. The
  **serve loop tracks first-seen-in-stage inside `board.json` itself** by diffing
  each build against the previous model, so staleness is self-contained: no
  ledger timestamps, no controller involvement. (`board.mjs` is an ordinary node
  script, so `Date.now()` is available; `computeBoard` receives `now` as an
  argument and stays pure.)

**Enrichment tier** (incremental, additive, *not* v1-blocking) — recovers the
rejected "controller pushes" fidelity through the durable channel the controller
*already writes*. The controller drops a cause-token into the ledger row it
already rewrites — `KILLED`, `BLOCKED`, `SHA-OFF-BRANCH` — and `computeBoard`
reads the *cause*. Until a token exists, that ticket simply surfaces as **stale**.
No new write path, no coupling to controller liveness. Pipeline state stays
`f(ledger, gh)` in every tier; only the side-car `spend` telemetry reads a third
source, and it can never move a ticket.

## board.json — the model (shape)

```jsonc
{
  "generatedAt": 1690000000000,      // epoch ms, for the page's staleness banner
  "interval": 15,
  "ledgerState": "read",             // read|unread|unparsed — see #816

  // Instance identity (#1584). Pass-through inputs joined at gather()'s
  // boundary, never derived inside computeBoard(): `repo`/`repoUrl` come from
  // `gh repo view` (the url carries the host, so PR links resolve on GitHub
  // Enterprise too), `workspace`/`port` from resolveCockpitInstance(). Both
  // identity pairs are null when unknown — no gh answer, or no workspace
  // resolved (the degrade arm) — and never absent: #1585's launch handshake
  // reads `workspace` straight off this JSON. `port` is the port the board
  // was SERVED on, so a `--port 0` board names its ephemeral port and not
  // the 0 that was asked for; on a `build` snapshot, which serves nothing,
  // it is the port this workspace's cockpit answers on.
  "repo": "feigi/fleet-plugin",
  "repoUrl": "https://github.com/feigi/fleet-plugin",
  "workspace": "/Users/me/dev/fleet-plugin",   // absolute, realpath'd — the instance key
  "port": 8337,
  "queue": { "pool": 3, "supply": 3, "reviewBacklog": 1 },  // footer line
  "tickets": [
    {
      "issue": 332,
      "title": "…",
      "column": "MERGED",            // POOL|IMPLEMENTING|REVIEW|READY|MERGED (amended by #1820: an Exclusion is POOL; a released/bailed row is POOL or no card)
      "agent": null,                 // latest live member on the row — impl-N, fix-pr-M, finisher-pr-M, or a review=member:/fallback: runner; null when none is live (amended by #1820)
      "pr": 344,
      "ci": "green",                 // green|red|unknown|null  (null = no PR)
      "sinceEnteredStage": 1690…,    // epoch ms, for dwell / stale
      "flags": ["stale"],            // [] normal; red-ci|held-behind:#N|stale|killed|tier-mismatch|blocked|sha-off-branch; POOL badge excluded:#M (never in attention) (amended by #1820)
      "ruling": "6-applies"          // from ledger `ruled`, on PR cards only
    }
  ],
  "filed": [{ "issue": 351, "subject": "…" }],
  "attention": [ /* the subset of tickets with a flag other than an excluded: badge, most-severe first (amended by #1820) */ ],

  // Side-car telemetry, read from ~/.claude/projects, never from ledger or gh.
  // Tri-state, discriminated by the explicit `ok` TAG and by nothing else:
  //   null                            — no agents spawned yet (panel hidden)
  //   { "ok": false, "error": "…" }   — transcripts unreadable (panel says so)
  //   { "ok": true,  … }              — the object below
  // The page checks `ok` BEFORE reading any success-only field, the way
  // ledger.mjs's `tracker` does. It must never infer the case from another
  // field's presence or truthiness: `error` is `""` for an error thrown without
  // a message and `undefined` for a thrown non-Error, and a truthiness check on
  // it hid the panel for both — a fault rendering as an idle run (#959). An
  // absent message costs only the wording ("no reason given"), never the panel.
  // A payload carrying no `ok` at all reads as an error, not as a success.
  "spend": {
    "ok": true,
    "totals": { "agents": 86, "cacheWrite": 0, "cacheRead": 0, "output": 0, "maxCtx": 0 },
    "roles": [ { "role": "specialist", "agents": 42, "cacheWrite": 0, "pct": 47 } ],
    "tools": [ { "tool": "Bash", "calls": 1974, "resultChars": 0, "cacheWrite": 0, "pct": 69 } ],
    "top":   [ { "label": "…", "role": "specialist", "cacheWrite": 0, "maxCtx": 0, "pct": 0 } ],
    "reviewPct": 84,        // specialists + reviewers, share of cache_creation
    "attributedPct": 48,    // share of cache-write the tool table explains; never 100
    "skipped": 0,           // transcripts that could not be read this tick
    "metaErrors": 0,        // meta sidecars unreadable/wrong-shaped this tick (#602)
    "damaged": 0,           // transcript lines unparseable AWAY FROM THE TAIL this
                            // tick — a torn line may cost its own tool_use blocks
                            // and output_tokens snapshot, not the whole turn's
                            // spend. A torn LAST line is the tear a live writer
                            // has on every tick and counts 0 here (#916)
    "since": null           // --spend-since epoch-ms, when the caller scoped the run
  }
}
```

## The page (`board.html`)

- Self-contained: inline `<style>` + `<script>`, vanilla JS, **no CDN**, no build.
  Dark default via `prefers-color-scheme`, terminal-friendly.
- Layout: **attention strip** on top (hidden when `attention` is empty) · **five
  kanban columns** · **footer** = the SKILL.md queue-depth line (pool / supply /
  review-backlog) + filed follow-ups.
- Card: `#N` + truncated title, agent name, PR# (click → GitHub PR in a new tab,
  resolved against this instance's own `repoUrl`), CI dot, dwell time, flag badges.
- Tab title and header name the repo (`fleet cockpit — <owner>/<repo>`), so two
  cockpits open side by side are tellable apart from the tab strip alone
  (#1584). A payload with no `repo` falls back to the bare `fleet cockpit`.
- Polls `/board.json` on its own interval; renders `generatedAt` age. If that age
  exceeds ~2× `interval`, shows a banner "data stale — server/controller
  stopped?" so a dead feed is visible, never a silently frozen board.

## run-team integration

- **Phase 0, once:** launch `node …/scripts/board.mjs serve --open &` in the
  background. One line in SKILL.md. The controller never touches it again — the
  cockpit is a read-only mirror of `ledger + gh`, so it adds **nothing** to the
  event loop and cannot introduce a new silent-failure rule there.
- **No teardown required** — the server is harmless and serves the last state
  after a run ends. `build --once` remains for an explicit static snapshot.
- **Enrichment tokens** (later) are additive edits to rows the controller already
  rewrites — no new write path is ever introduced.

## Error handling / degradation — partial board beats no board

- A `gh` / `ci-state` call fails (rate limit, network) → keep the last-known
  value for that card, mark it `?`, **do not crash the loop**; log to stderr.
- `.fleet/ledger.md` read (`--require-file`) distinguishes three outcomes, not
  one: **unread** (missing, or the read otherwise failed — permission, a
  crashing `node`), **unparsed** (read, but the answer would not parse), and
  **read** (a real ledger, possibly empty — the normal state of a run that has
  just started). `ledgerState` carries the answer to `board.json`; `board.html`
  draws `unread`/`unparsed` as a warning banner and stays silent on a ledger
  that read empty, so the operator isn't trained to ignore a banner shown on
  every run's first tick (#816). Silently tolerating a missing ledger here
  would defeat the point of distinguishing it everywhere else.
- `ci-state` errors on a PR → CI dot = **unknown, never red**. Never false-alarm.
- `board.json` written atomically (temp + rename) → the page never reads a
  half-written file.
- Derived port in use → handshake, then reuse (exit 0) or step past it; only
  an exhausted range is an error, and it names the ports tried and suggests
  `--port` (#1585). An explicit `--port` in use → that clear error, directly.
  Page cannot reach `/board.json` → "cockpit server not running."

## Testing

- **`computeBoard` gets real unit tests** (vitest, alongside the existing
  `diff-stats.test.mjs`): a fixture table of ledger-row variants × `gh`/CI states
  × injected `now` → expected column, flags and dwell. The stage-derivation and
  the red-vs-stale distinction — the only genuinely tricky logic — is pinned here.
- **Dwell / staleness**: test the diff-against-previous-model logic with injected
  timestamps (deterministic — `now` is an argument).
- **Serve loop + HTTP**: one smoke test — boot the server, `fetch /board.json`,
  assert the model shape.
- **The page**: manual (vanilla, no build). The spend panel's branch decision
  is extracted as a pure `spendView` and unit-tested by `spend-view.test.mjs`
  (#371); the DOM rendering around it is not.

## Open questions

None blocking. The POOL-as-supply framing and the fold of review-backlog into a
REVIEW badge were confirmed during design.
