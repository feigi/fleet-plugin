# Cockpit tabs: Cell evidence and Tokens

Date: 2026-10-27
Status: decided on map #3876 ("Cockpit tabs that explain why each Cell is used"), 2026-10-26 to 2026-10-27; handed to `/to-tickets` and filed as #3891–#3898 (§ 13).
Map: feigi/fleet-plugin#3876. Decision tickets: #3877 (research), #3878, #3879, #3880, #3883 (grilling), #3881 (prototype); this spec is #3882.
Prototype: `prototype/cockpit-tabs.html` on the throwaway branch `prototype/cockpit-tabs`, never merged.
Research: `docs/research/cockpit-evidence-records.md` on the branch `research/cockpit-evidence-records`.
Amends: `docs/specs/2026-07-24-fleet-cockpit-design.md` (its v1 non-goals, its page and its testing sections; see the amendments there).
Relates to: `docs/specs/2026-09-28-model-effort-router-design.md` (the Router, the cost guard and the route line this spec extends), #3673 (router trust: changes the numbers the tab shows, not the tab), #3875 (the cockpit's lifetime), #3885 (an undrawn Pull runs as `fleet-implementer-slow-high` whatever Cell its policy row names), #3886 and #3887 (a consumer's first runs).
Base tree: origin/main `ac26799a`. Line numbers drift; re-grep before editing. "Today" means `ac26799a`'s records and the 2026-10-26 19:17Z guard; every figure moves with each run.

Cells are model roles paired with a thinking level. No model name is written
into the page, a Cell token, or a definition: every model the tab names comes
from a record (charting decision 6).

## 1. Scope

The cockpit (`board.mjs serve`) gains a tab strip: **Board · Cell evidence · Tokens**.

- **Cell evidence** explains, from the records, why each implementer Cell is
  used. It answers three questions, each figure with its trust status:
  - per Objective × Stratum row: the Cell routes now gives and why, beside the
    Cell the evidence favours, with each candidate's verdict and interval;
  - per Cell: what the cost guard holds it to — merged PRs against `MIN_N`,
    the fail-rate gap against the 15-point Quality floor, $ per merged PR
    against `slow-high`;
  - per live Pull: why it ran on its Cell. That answer sits on the Pull's
    board card (§ 7); the tab lists each Cell's Pulls and links to them.
- **Tokens** is today's token panel (cache-write by member role and by tool),
  moved to its own tab.
- Every implementer card from IMPLEMENTING to MERGED gains a Cell line (§ 7).

Only implementer Cells are explained. Every other member's Declared tier is
listed as "declared, not measured" (charting decision 2).

Between runs the tabs are reached by a hand launch, `fleet-run board.mjs serve --open`
(charting decision 7); #3875 keeps such a cockpit alive.

**Out of scope** (the map's Out of scope section): measuring or routing
members other than implementers; glossary **Spend** ($ per Pull by Cell) on
the Tokens tab; the router-trust fixes (re-rules, the re-fit gate, the
spec-slice stratum); the cockpit's lifetime; trends of Cell figures across
fits; a consumer version of "installed table behind main's".

## 2. Vocabulary

Three glossary entries land with this spec in CONTEXT.md § Tier: **Routing**,
**Preview fit** and **Cell evidence**. **As-routed** and **Admissible row** are
reworded from "the Cell it drew" to "the Pull's Cell": after burn-in about 4
Pulls in 5 are not drawn, and they book to their policy row's Cell.

The tab names are labels, not domain terms, and get no entry (#3881). The
token tab is **Tokens**: it cannot be read as $, so it does not clash with
**Spend**; "Cache" was rejected because the panel also shows cache-read and
output. Trust labels use the glossary's own words (a Ruling given by hand,
Admissible row, unpriced, untimed) and add no term (#3879). Never a bare
"role" in prose or on the page: say model role (`slow`/`task`/`smol`) or
member role.

## 3. The page

### 3.1 Tabs and what stays global

- **Board · Cell evidence · Tokens**, in that order. Board opens by default.
- The tab and any target are kept in the URL hash, so a reload or a pasted
  link opens the same view (§ 8).
- **Global, above the tabs:** the header, the stale/stalled/ledger banner and
  the attention strip. **Below every tab:** the footer (pool · supply ·
  review-backlog, the cap notice, filed follow-ups). A stalled run or a
  flagged ticket shows on whichever tab is open.
- **Inside the Cell evidence tab:** its alerts (§ 6). While any alert holds,
  the tab's label carries `⚠n`, counted from the same alert list the tab
  draws, so an alert shows from Board too.
- The page stays one self-contained file: inline CSS and vanilla JS, no CDN,
  no build, no dependencies.

### 3.2 The Cell evidence tab, top to bottom

1. A line of in-tab links: policy rows · the guard · declared, not measured.
2. **Alerts** (§ 6.3), one box each, only while the state holds: a headline
   and a sentence.
3. **Policy rows: Objective × Stratum** (§ 5.2).
4. **The guard: what it holds each Cell to** (§ 5.3).
5. **Declared, not measured** (§ 5.4), collapsed.

Footnote texts sit under the section that carries their marks.

## 4. Records

### 4.1 What the tab reads

| The tab shows | Record | Read through |
|---|---|---|
| Routes now | the router table installed beside the script (`router-table.json` in `ticket-router.mjs`'s own directory, the file `route` reads) and `.fleet/cost-guard.json` | `validateTable` and `readGuard`, and `rowDispatch` (new, § 10.1), the function `route` itself calls, so the tab cannot disagree with routing |
| What the guard holds each Cell to | `.fleet/cost-guard.json`, extended (§ 10.3) | `readCostGuard` (`fleet-tick.mjs`): figures show only from a file it accepts; nothing is recomputed |
| What the evidence favours | `.fleet/router-preview.json`, new (§ 10.4) | `validateTable` on its `table` |
| Each Cell's Tier route model | `omp config get modelRoles --json`, in the cockpit's own environment (which can differ from the controller's; each card's Resolved tier stays the record of what ran) | `tier-roles.mjs`: `readOmpConfigValue`, `resolveRole`, `modelsEqual` |
| Declared, not measured | the installed definitions, `../agents/*.agent.md` from the script's directory, minus the five implementer Cells (14 members today) | `parseFrontmatter` |
| The live run's Objective | `.fleet/phase0.json` `objective`; absent between runs, so nothing is marked | the receipt read the gather already makes every tick |
| Whose runs the installed table is | its `fitted_commit` and `n_rows`; the install's `package.json` (`../package.json` from the script's directory) `name`, `version` and `repository` | — |
| The guard section's heading when there is no guard | the `metrics` step (`status`, `at`, `output`) of `.fleet/phase0.json` and `.fleet/closeout.json`, the newer of the two | — |
| Records not on main | the `tsv_blobs` the guard and the Preview fit record; main's blob ids from `gh api --hostname <host> repos/<owner>/<name>/contents/docs/metrics`; `.fleet/closeout.json` `pr` and `steps["commit-and-pr"].at` | — |
| Installed table behind main's (this repository only) | the checkout's `plugin/scripts/router-table.json` | `validateTable` |
| Each card's Cell line | the ledger's `## Routed` entry (§ 10.2), the row's `tier=` tokens, `## Dispatched` `agent=`, the members' transcripts | `parseRouting`; the member record the gather already builds |

The Cell evidence tab reads no per-Pull record. The pending features rows,
the ledger's tokens, the scratch `pull.json` and the transcripts are the
card's alone (#3880).

`<host>` and `<owner>/<name>` come from the `repoUrl` the gather already reads
through `gh repo view`. The call is never `repos/{owner}/{repo}`: in a
checkout whose remote is on a GitHub Enterprise host, `gh repo view` finds
that host but `gh api` sends the placeholder request to `api.github.com`,
which answers 404 (measured in diagram-docs' checkout).

### 4.2 When each is re-read

- **Every file, every tick, nothing cached** — the gather's existing rule
  (`board-gather.mjs`'s receipt comment). With no TSV parsed, each file is a
  few KB.
- **Two calls are read at most once a minute:** `modelRoles`, and the
  `docs/metrics` contents call. Each is re-read when its last read is 60 s
  old or more, its value and read time carried forward in `board.json` the
  way `ci` and `repo` are. A failed read keeps the carried value and shows its
  age (§ 6.2). Each is one more serial spawn, on one tick in four.
- Rejected: the cockpit fitting or recomputing by itself. Close-out commits
  the TSVs on the artifacts branch and switches back to `main`, so between
  runs the files on disk lack the last run's rows until that PR merges, and a
  cockpit-side fit or `computeReport` would count fewer Pulls than the guard
  judged. The Preview fit is written beside the guard instead (§ 10.4).
- Rejected: the cockpit caching per-Pull records. `pull.json` is deleted once
  its issue closes (`reclaim-scratch.mjs`'s root sweep runs after every merge
  pass and at phase 0), close-out drains the pending features rows, and a
  features row cannot identify its run. The Routing goes on the ledger
  instead (§ 10.2).

### 4.3 Whose runs each side counts

- **Routes now** names its table by the install's `package.json` `repository`,
  taking the host and `owner/name` from its `url`.
  - It reads "this repository's runs" when that is the workspace's repo,
    compared on host and `owner/name` with `repoUrl` — never on the `repo`
    name alone. Otherwise it reads "<owner/name>'s runs".
  - Then come `fitted_commit` (7 characters) and `n_rows`, and the install's
    `name` and `version`, or "linked checkout" for version `0.0.0`:
    "this repository's runs · fitted at 1a2b3c4 on 198 Pulls · @feigi/fleet-ctl 3.105.0".
  - An unfitted table reads "never fitted": "feigi/fleet-plugin's runs · never fitted · @feigi/fleet-ctl 3.104.0".
  - An install with no usable `repository` reads "another repository's runs",
    and the comparison reads "not checked: the install names no repository".
  - In a consumer, routes now's source carries a footnote: "this repository's
    runs reach routing only through its cost guard, which can hold a Cell back
    but never picks one". A consumer's guard can only remove Cells
    (`tripped`); the rows, `reasons`, `estimates`, `burn_in`, `stage` and
    `cells` are the shipped table's, and only a repo-local hook ever fits it,
    so a consumer stays in burn-in until a plugin release ships a fitted
    table.
- **The guard and the Preview fit** read "this repository's runs", each with
  its `computed_at`. The Preview fit takes only `stage`, `cells`,
  `classifier` and `window_start` from its prior; its rows, estimates and
  burn-in are the workspace's own records laid out on the shipped table's
  Cells.

## 5. The Cell evidence tab

### 5.1 States the whole tab passes through

| State | Holds while | Routes now | Evidence favours | The guard |
|---|---|---|---|---|
| **No cost guard** | no guard `readGuard` accepts: a fresh consumer through its first two runs, a refresh that fails every time, a lost file | "no cost guard: every Pull runs at slow-high, the default Cell"; each row's dispatch "slow-high only" | "no Preview fit: it is written only beside a cost guard" | heading quotes the newest `metrics` step (below); each Cell "no figures yet for <model>" |
| **Holds nothing back** | verdict `none`: from the first guard until the baseline Cell has `min_n` merged PRs | as the table says | the Preview fit | "holds no Cell back until slow-high has 20 merged PRs: it has k"; each Cell "n of 20" |
| **Before the first Preview fit** | a guard, no `router-preview.json` (this repository's first state once the tab ships) | as the table says | "no Preview fit yet: the next phase 0 writes one", column empty | the new counts read "not checked"; records-against-main reads "not checked: this guard predates the blob ids it needs" |
| **Normal** | a guard and a Preview fit | § 5.2 | § 5.2 | § 5.3 |

**No cost guard: the guard section's heading** quotes metrics-refresh's own
line, with its time, from the newest `metrics` step in the phase 0 and
close-out receipts:

- "skipped at <t>: docs/metrics/member-outcomes.tsv not found — no corpus to guard yet";
- "failed at <t>: … malformed row: 20 fields, expected 23";
- with no receipt, "no phase 0 or close-out receipt here";
- for a guard on disk that the newest refresh did not write: "the newest
  refresh failed at <t>: <why>; these figures are from <computed_at>".

None of these is an alert. A failing refresh already stops phase 0 (at
`metrics`, before its `cockpit` step) and close-out, and a fresh workspace is
not a fault, so these words are only read in a cockpit launched by hand or
left over from an earlier run.

**Holds nothing back:** the Cell and the 20 come from the guard's `baseline`
and `min_n`. There is no forecast of when it ends. The words are the same in
every workspace; this repository passes through the state again whenever
`slow-high`'s model changes, because only a Cell's newest generation is
judged.

### 5.2 Policy rows: Objective × Stratum

**Two side headings, side by side.** Each gives its title (routes now,
evidence favours), its source line (§ 4.3), its burn-in or no-guard heading,
and any trust labels for that side.

- Today, routes now: "this repository's runs · never fitted · @feigi/fleet-ctl 3.104.0"
  and "never fitted: every Pull drawn over 3 Cells".
- Today, evidence favours (on a scratch Preview fit of `ac26799a`):
  "Preview fit · this repository's runs · computed <t> · 198 Pulls" and
  "stage 2: slow-medium and task-max have 0 of the 20 merged PRs each needs".

**Burn-in headings**, each from its own side's table (`burn_in`, `stage`,
`cells`, `guard.n` against `MIN_N`):

- An unfitted table: "never fitted: every Pull drawn over K Cells", in every
  workspace.
- Routes now, fitted and in burn-in: the counts are the installed table's own
  `guard.n`, what its fit saw, so they read in the past tense and name the
  source: "stage 2 at its fit on feigi/fleet-plugin's runs: slow-medium and
  task-max had 0 of the 20 merged PRs each needs; every Pull drawn over 5
  Cells". In a consumer the heading adds what ends it: "a later fit, reaching
  this install with a plugin release". Nothing a consumer does ends the
  shipped burn-in.
- Evidence favours in burn-in: the workspace's own counts, present tense:
  "stage 2: slow-medium and task-max have 0 of the 20 merged PRs each needs".
- K counts the Cells the draw uses under the workspace's guard, the same
  count each row's dispatch uses.
- `fit --due`'s `MERGED=<n>/50` is not shown: it counts toward the re-fit
  gate, not toward any figure, and a consumer has no `fitted_commit` to count
  from.

**One row-aligned table** for both Objectives, routes now on the left and
evidence favours on the right.

- Rows: each Objective, with `*` and every Stratum (light, heavy, unknown).
  The live run's Objective is marked; between runs nothing is.
- Each side's cell gives the row's Cell and its reason, from its own record.
  Each candidate shows its n, its verdict and its 95% interval (the table's
  `reasons` and `estimates`), with the model-name label (below) where its
  judged generation differs from the Tier route model.
- Evidence favours' Cell carries `≠ routes now` wherever the two differ.
- **Dispatch** — what `route` does with that row under the current guard:
  - no guard `readGuard` accepts → `slow-high` only (`guard-missing`);
  - burn-in → every Pull drawn evenly over `cells` minus the tripped;
  - otherwise the row's Cell, `slow-high` when that Cell tripped
    (`table-cell-tripped`), with every 5th `impl-` row drawn over the rest.

  Dispatch sits in a side's heading when every row on that side dispatches
  alike ("drawn over 3 Cells: slow-high, task-high, smol-high"), and shows on
  a row only where that row differs, such as a tripped row Cell replaced by
  `slow-high`.
- **A Stratum with no row of its own on either side** collapses to one line
  under its Objective: "unknown: no row on either side, follows *". A Stratum
  only one side lacks keeps its row, and that side reads "no row of its own:
  follows *".
- Footnotes under the section: the consumer's source footnote (§ 4.3) and the
  guard-against-Preview-fit n footnote (§ 6.2).

**Model names when the generations differ.** Each side compares a candidate's
judged generation with that Cell's Tier route model (`resolveRole` on
`modelRoles`, matched with `modelsEqual`).

- It names the generation only where the two differ: "judged on
  claude-sonnet-5-5; task-high runs <model> here". When every candidate on a
  side differs, this becomes one line in that side's heading.
- Exact match apart from the provider prefix: `claude-opus-5.5` is not
  `claude-opus-5-5`. Both names show and the reader judges. There is no alias
  table.
- An unset model role reads "modelRoles.<role> unset: omp picks the model",
  and that Cell's comparisons read "not checked".
- A row with no estimate — every row of an unfitted table — names no
  generation and carries no flag.
- Never an alert: in a consumer the difference can hold for good.
- Figures stay keyed on the dispatch model, as **Cell generation** defines.
  `modelRoles` keys nothing; it only feeds the flag.

### 5.3 The guard: what it holds each Cell to

**The heading** gives the verdict state: "trips nothing", "trips <cells>",
"holds no Cell back until slow-high has 20 merged PRs: it has k", or "no cost
guard". Under it, a source line: "this repository's runs · computed <t> ·
window from <date> · min 20 merged PRs · floor 15 pts over slow-high" (from
`computed_at`, `window_start`, `min_n` and `trip_points`). Then any
heading-level checks: "not checked" with why (§ 6.1), a failing `modelRoles`
read, the no-guard quotes (§ 5.1), and an alert-level check that cannot run.

**All five implementer Cells are always drawn**, in a fixed order:
slow-high, task-high, smol-high, slow-medium, task-max. A card or a rescue
can name any of them, and no link may point at nothing.

**Each entry's header line:** the Cell, "judged on <generation>", "Tier route:
<model> · <level>" with "⚑ differs from the judged generation" where it does
(charting decision 6), and a baseline mark on `slow-high`.

**Three figures per entry**, each the newest generation's:

- **Merged PRs:** "n ≥ 20 ✓" or "n of 20: not judged"; left out and pending
  beside it when k > 0; footnote marks (comma-separated) for no Admissible
  row, unpriced and untimed.
- **Fail rate:** "21.7% · +10.2 pts on slow-high · 4.8 pts inside the floor";
  the baseline reads "11.6% · the floor is 26.6%". The gap is worked from the
  entry's `n_claims` and `n_failed`, exact, not from rounded rates. "k of n
  Rulings given by hand" sits beside it when k > 0.
- **$ per merged PR:** "$10.20 · −31.6% on slow-high".

**Older generations** sit nested under their Cell's entry, marked not judged,
each with its own anchor.

**"this run's Pulls"** lists the Pulls booked to the Cell, from the cards in
`board.json` with no extra reads, each linking to its card with its mark
where it has one. Booking is As-routed, so a Pull with no Admissible row is
listed under its Cell with its mark. This answers charting decision 3's "per
live Pull, why it ran on its Cell".

**A Cell or generation with no figures** — not in the guard, or no guard —
reads "no figures yet for <model>" (the Tier route model, or the card's
model when a card links to a generation), so a card's link still lands.

### 5.4 Declared, not measured

Collapsed under "Declared, not measured: 14 other members"; opens on click.
Open, it lists each member, its Declared tier, and its Tier route model ·
level.

## 6. Trust labels

### 6.1 How a label shows

A label's place follows what it qualifies:

- **Beside the figure:** a few words next to one figure, or, for a whole side
  (routes now, evidence favours), in that side's heading.
- **Footnote:** a mark on the figure and a sentence under its section, for a
  label that needs a sentence.
- **Alert:** a state of the whole records, at the top of the tab, shown only
  while it holds.

No mark means no known gap. A count the record lacks reads "not checked",
never 0 — the board's "unknown is not zero" rule. A check that cannot run
(the contents call fails, `modelRoles` was never read, the guard was written
by a plugin older than the field) reads "not checked", with why and when it
last succeeded, where its signal would show. An alert-level check that cannot
run says so in the guard section's heading instead, so an offline cockpit
never raises an alert. A label states its claim and cites no ticket.

### 6.2 The signals

| Signal | Computed from | Shown | In a consumer |
|---|---|---|---|
| Burn-in, and why | each side's own table: `burn_in`, `stage`, `cells`, `guard.n` against `MIN_N` | each side's heading (§ 5.2) | yes; routes now's counts are the shipped table's runs |
| Rulings given by hand | the entry's `by_hand`, per Cell generation | beside the fail rate when k > 0 | yes |
| Merged with no Ruling | the entry's `no_ruling` (guard only) | alert naming each Cell and its k | yes |
| No Admissible row, unpriced, untimed | the entry's `excluded`, `unpriced`, `untimed` | footnote on n when k > 0 | yes |
| Left out, pending | the entry's `left_out`, `pending` | beside n when k > 0 | yes |
| Records not on main | the guard's and the Preview fit's `tsv_blobs`, main's ids, the close-out receipt | alert | yes |
| Installed table behind main's | the installed table against the checkout's `plugin/scripts/router-table.json` | routes now's heading | no: this repository only |
| Guard and Preview fit count different merges on the same files | both files' `n` | footnote on the fit's n | yes |
| Preview fit read another guard or other TSVs | `guard_computed_at` against the guard's `computed_at`; both files' `tsv_blobs` | evidence favours' heading | yes |
| Preview fit's prior is not the installed table | `prior`'s `stage`, `cells`, `classifier`, `window_start` against the installed table's | evidence favours' heading | yes; likeliest right after a plugin update |
| Router and tick read the guard differently | `readGuard` against `readCostGuard` | alert | yes |
| `modelRoles` read failing | the read's time and error, carried in `board.json` | beside the Tier route model, after a failed read only | yes |

**Rulings given by hand.** A Ruling is derived when its note has `append`'s
form, `review <run> at <head7>, record …` or `…, no record: …`; any other
Ruling was given by hand. The label reads "k of n Rulings given by hand".
Today, newest generations: slow-high 56 of 69, task-high 60 of 69, smol-high
26 of 32. Not shown: re-rule progress (this count read the other way) and the
writer split (close-out against backfilled), which puts derived Rulings in
with close-out's hand-given ones although the two fail at very different
rates.

**Merged with no Ruling.** Such a Pull stays counted as not merged, so n reads
low and $ per merged PR high, in the guard and the Preview fit alike; the fit
is given no PR states and carries no count. The alert names each Cell and its
k: "merged with no Ruling: task-high 2, smol-high 1 — each counts as not
merged, so n reads low and $ per merged PR high". The tab does not run the
ledger-wide missing-Ruling check (`tier-outcomes.mjs check --live --ledger`,
#3674): that check stays the re-fit gate's, looks at other PRs than the
tab's, and takes seconds per ledger. Today the count is 0 in every Cell.

**No Admissible row, unpriced, untimed** each mean the Cell's figure rests on
fewer Pulls than were drawn to it, for a reason about the run or its records.
Footnote words:

- "k drawn here have no Admissible row: they ran under another Cell, at
  another effort, or with no model on record, so they count in no Cell's
  figures";
- "k unpriced: part of their Spend can't be booked";
- "k untimed: a member's work time isn't on record".

Left-out Pulls have no outcome to judge and pending ones none yet, so those
two are plain counts beside n. Today: task-high has 1 Pull with no Admissible
row, smol-high 5 and 1 unpriced.

**Records not on main.** Three states raise the alert:

- the receipt's PR is open and the guard was computed at or before the
  commit step: "counts the rows of open PR #M, not on main yet";
- the receipt's PR is open and the guard was computed after the commit step:
  "lacks the rows of open PR #M";
- the guard's ids differ from main's and no receipt PR is open: "main's
  records changed after <computed_at>; the next phase 0 recomputes".

The two blob ids show under the headline. A 404 from the named host reads
"main holds no metrics yet" where the check's result shows; any other
failure reads "not checked". Known limit: the receipt names only the last
close-out's metrics PR. Today the third state holds: the 19:17Z guard read
`tier-outcomes.tsv` blob `9df10b12`, and main holds `84123e74` since 21
re-rules landed and the run's metrics PR merged.

**Installed table behind main's.** Only where the install's `repository`
names the workspace's repo (§ 4.3): when the installed table's
`fitted_commit` and `n_rows` differ from the checkout's, routes now's heading
reads "main's table is fitted at X on N Pulls; this install routes by Y until
the plugin is updated". A merged re-fit reaches the install only with a
release. Today both are unfitted, so there is no label.

**Guard against Preview fit.** When both read the same files and a Cell's
merged n still differs, the fit's n carries the footnote: "the guard counts
merges by GitHub's state, the fit by Rulings, and the fit admits only drawn
or rule-sized Pulls". It shows whenever a ruled PR is still open at phase 0
or close-out, since a PR is ruled before its finisher runs.

**Preview fit read another guard or other TSVs.** Evidence favours' heading
reads "fitted beside the guard of <guard_computed_at>, not this one" when
`guard_computed_at` differs from the guard's `computed_at`, and "fitted on
other records than the guard's" when the two files' `tsv_blobs` differ.

**Preview fit's prior.** Fires only when a field `fitTable` reads from its
prior differs from the installed table's: `stage`, `cells` and `classifier`,
plus `window_start` when the guard gave none. A release that changes only
fields the fit recomputes, or only `fitted_commit` and `version`, raises no
label, because the next phase 0's refit would come out the same. The words
name the prior: "fitted against <version, fitted_commit>; the next phase 0
refits".

**Guard readers.** The guard section shows figures only from a file
`readCostGuard` accepts. A guard that `readGuard` accepts and `readCostGuard`
refuses, or the reverse, raises an alert naming which reader accepts and why
the other refuses. `readCostGuard` checks only the fields it needs, so the
extended guard file passes as long as each entry keeps an integer `n` and a
`mean_usd` and `fail_rate` that are numbers or null.

**`modelRoles` read failing.** After a failed read only, beside the Tier
route model: "as read at <time>; reading fails: <why>". Never read: "not
checked: modelRoles not read yet".

### 6.3 Alerts

The alert list is exactly: merged with no Ruling, records not on main, and
the guard readers disagreeing. The tab's `⚠n` counts it. Everything else is a
heading label or a footnote.

## 7. The card's Cell line

### 7.1 What it says

Every card whose ledger row has an `impl` token, from IMPLEMENTING to MERGED,
carries a Cell line about its latest Pull — the last of the row's `impl`
tokens with a `## Routed` entry, a later `impl` token being a rescue under it;
on a row with no entry, which predates the Routing, the row's latest `impl`
token, as the card already follows.
POOL cards and PR-only rows carry none. The line lasts exactly as long as the
card, because both come from the row in `ledger.md`.

| Part | Says | From |
|---|---|---|
| Cell | the Pull's Cell; "rescue at <cell>" when a later implementer ran at another Cell | the Routing; a later `tier=` and `## Dispatched` `agent=` |
| Why | the draw first, then the reason (7.2) | the Routing |
| Stratum | the Stratum and the numbers that set it: "heavy: 13,638 chars (past 3,483), 11 criteria (past 5)", "unknown: no brief read"; under arm B, "sized <label>" | the Routing; the thresholds, exported by `ticket-router.mjs` |
| Model | the dispatch-time model and thinking level of the Pull's first implementer at its Cell, keyed the way the Cell generation is: "claude-haiku-5-5 · high". Adds "fell back to <model>" when the last turn's model differs. A rescue shows its own model beside "rescue at". "not on record" when the transcript holds none | the member record the gather already builds |
| Mark | where the first implementer ran off the Pull's Cell (7.3) | the ledger and the transcript |

Rows written before the Routing read "not on record" for whatever their
tokens lack (the Cell then comes from `tier=`), and an old `route=` value
reads "recorded as …". Today's three cards predate the Routing.

### 7.2 How the reason is worded

| Routing | Card says |
|---|---|
| drawn k of K | "drawn k of K: burn-in" or "drawn k of K: every 5th Pull" |
| drawn, with a tripped Cell left out (`guard-tripped`) | adds "left out as tripped: smol-high" |
| not drawn, `ok` | "cost row, heavy"; adds "follows *" when the table has no heavy row |
| not drawn, `table-cell-tripped` | "cost row's task-high tripped: default Cell" |
| not drawn, `guard-missing` | "no cost guard yet: default Cell only" |
| not drawn, `guard-tripped` (no Cell left to draw) | "every other Cell tripped: no draw" |
| `no-issue-json` / `no-sizing` | "issue unreadable when routed" / "no sizing"; the Stratum reads unknown |
| any other recorded value | "recorded as …" |

`REASON` keeps only the first thing that went wrong, and the card never
guesses the rest. The card shows the Routing as recorded and never re-checks
it against today's guard: during a run the guard on disk is the one the run
routed by, and what routes now is the tab's to show.

### 7.3 The mark

The mark judges the first implementer, the one the Pull's Cell binds.

- If it ran under another definition or at another level, and a later
  implementer has an Admissible row: "first ran as fleet-implementer-slow-high"
  or "first ran at medium, not high".
- If no implementer has an Admissible row: "ran as …: no Admissible row, so it
  counts in no Cell's figures", or "no model on record: …".
- "Ran as" reads the `## Dispatched` entry's `agent=`, else `tier-ok=`, else
  the transcript.
- Whether a row is Admissible is decided by the figures' own test,
  `admissibleRow`, applied to the transcript's record. When no transcript can
  be read, that clause reads "not checked".
- A rescue at another Cell keeps "rescue at <cell>" and gets no mark. The
  `=tier-mismatch` attention flag is unchanged.

#3777 is the shape on record: it drew task-high, its first implementer was
dispatched as `fleet-implementer-slow-high` and stopped by the tier check, and
`impl-3777-b` ran as `fleet-implementer-task-high`. #3885 is the shape that
nothing yet prevents: an undrawn Pull run as `fleet-implementer-slow-high`
whatever its policy row names, which the mark shows.

### 7.4 How it is drawn

Two lines below the card's existing meta line:

1. Cell · why: "smol-high · drawn 2 of 3: burn-in". A rescue adds "· rescue
   at <cell> <model · level>".
2. Stratum with its numbers · model · level: "heavy: 9,658 chars (past
   3,483), 8 criteria (past 5) · claude-haiku-5-5 · high".

A mark adds a third line starting with ⚑: amber, or red when the Pull counts
in no Cell's figures. "not on record" parts are drawn dim and italic in their
place. The one-line compact form was rejected: it hid the Stratum's numbers
behind a hover.

### 7.5 Between runs

Close-out moves `phase0.json` to `phase0.previous.json`, while `ledger.md`
still holds that run until the next rotation. When `phase0.json` is absent,
the gather reads the transcripts of the session `phase0.previous.json` names,
for the cards only. The Tokens panel is unchanged by this.

## 8. Links

Links are hash routes, a pure function of the hash:

| Link | Route |
|---|---|
| a tab | `#board`, `#cells`, `#tokens` |
| a card's Cell, at the Pull's generation | `#cells/<cell>@<generation>`; an older generation resolves to its nested row |
| a reason from a policy row | `#cells/row/<objective>/<stratum>` |
| a guard entry's Pull | `#board/<issue>` |
| an attention-strip ticket | `#board/<issue>` |

- The target scrolls into view and flashes once. The browser's Back returns
  to where you were. Nothing opens a new window.
- A link with no target lands on the tab's top. Every link the page draws has
  a target in every state, which is why all five Cells are always drawn and a
  generation with no figures still gets an entry.

## 9. The Tokens tab

The token panel moves to its own tab, unchanged apart from two headings: "spend"
becomes "tokens", and "by role" becomes "by member role". Every outcome of
`spendView` (hidden, note, error, panel) renders on this tab as it does on
today's board.

## 10. Producer changes

### 10.1 `ticket-router.mjs`

- **`rowDispatch({ table, guard, objective, stratum })`**, new and exported:
  what `route` does with one row under one guard, with no per-Pull input —
  `{ policy, reason, draw: null | { by: "burn-in" | "every-5th", cells } }`,
  where `reason` is `guard-missing`, `table-cell-tripped` or `ok` and `cells`
  are the Cells a draw would pick from (the tripped left out, and on an
  every-5th draw the `cost` row's Cell as well). `route` calls it for its row,
  so the tab and routing cannot disagree. `rowFor` is exported beside it.
- **`route` prints everything the Routing holds** (§ 10.2), on one line in the
  existing `KEY=VALUE` form:
  `POLICY=<cell> CELL=<cell> DRAW=<k/K|-> BY=<burn-in|every-5th|-> STRATUM=<light|heavy|unknown> BRIEF=<chars|-> CRITERIA=<n|-> SIZED=<light|heavy|-> OBJECTIVE=<cost|speed> TRIPPED=<cell,…|-> REASON=<reason>`.
  `TRIPPED` is the guard's `tripped` at route time; `SIZED` is arm B's sizing
  label. Today's line lacks burn-in, the tripped Cells, the brief length, the
  criteria count and the sizing label.
- **The Stratum thresholds are exported** (`HEAVY_BRIEF_CHARS`,
  `HEAVY_CRITERIA`), for the card's "(past 3,483)".

### 10.2 The Routing on the ledger

The form is a **ledger section of its own**, `## Routed`, one entry per Pull:

```
## Routed
- impl-3747 POLICY=slow-high CELL=smol-high DRAW=2/3 BY=burn-in STRATUM=heavy BRIEF=9658 CRITERIA=8 SIZED=- OBJECTIVE=cost TRIPPED=- REASON=ok
```

- The entry is the Pull's first implementer's member token, then `route`'s
  line verbatim: one grammar, owned by `ledger-grammar.mjs`
  (`ROUTED = "## Routed"`, `parseRouting`, `formatRouting`), read by
  `pull.mjs` off `route`'s stdout, by `ledger.mjs` to validate, and by the
  cockpit.
- **Why a section, not row tokens.** The row is rewritten in place at every
  state change and its tokens are replaced one by one; eleven more words on
  it would cross every reader of `## Rows` and every rewrite. The Routing is
  written once and never changes, like a `## Dispatched` entry, while `tier=`
  stays the row's mutable "Cell the next implementer runs at".
- **Written by the row step.** `pull.mjs`'s row step writes the row and its
  Routing in one `ledger.mjs row` call (`--routing <line>`), one atomic write.
  `ledger.mjs` refuses a line `parseRouting` rejects and a second entry for a
  member that has one.
- **`tier=` keeps its meaning**: present exactly when `DRAW` is not `-`, the
  Cell the next implementer runs at. `implRow` reads its absence, and
  `ledger.mjs`'s cell-change refusal and token replace read it as the row's
  Cell; none of that changes.
- **`route=` is retired.** No script reads it. The run-team Pull reference
  (`references/pull.md`) is rewritten to the new row step. Old rows keep it;
  the card reads it as "recorded as …".
- **Rotate carries** each `## Routed` entry whose member a carried row names,
  as it carries `## Dispatched` entries.

### 10.3 The guard file

`guardFile` (`pr-cost.mjs`) keeps each Cell's whole `computeReport` entry
beside the fields readers use today (`n` stays, `n_merged`): `n_pulls`,
`n_claims`, `n_failed`, `median_usd`, `router_usd`, `usd_diff_ci95`,
`left_out`, `unpriced`, `untimed`, `excluded`, and three new counts:

- `by_hand`: merged Pulls whose Ruling was given by hand (`tally`, through
  the derived-note test `tier-outcomes.mjs` exports beside `deriveRuling`);
- `no_ruling`: Pulls whose PR merged with no Ruling (`attribute`, when given
  PR states);
- `pending`: Pulls whose PR is still open or not in the list, per generation
  (today `computeReport` keeps pending PRs run-wide only).

Older generations stay nested in the entry's `older`, never as extra `cells[]`
entries: `readGuard` keys entries by Cell, so one would overwrite the newest
generation's `n`. The file also keeps `trip_points` beside `min_n`, for
`min_n`'s own reason (a reader prints the margin the guard applied rather than
restating it), and `tsv_blobs`: the git blob id of every TSV the guard read,
keyed by path, computed in-process. `readGuard` and `readCostGuard` both keep
accepting the file.

Every fitted table's `estimates` carry `by_hand` too. Once the router table
has been fitted, the change that adds the count re-fits it: `--check`
compares whole tables.

### 10.4 The Preview fit

`metrics-refresh.mjs` gains a third duty after the cost guard, at phase 0 and
close-out: `fitTable` over the working-tree TSVs the guard just read and the
guard just written, with the installed table as prior and no commit. It is
called in-process: the guard runs as a subprocess because its exit status is
its verdict, which a fit does not have, and the `fit` CLI reads TSVs only as
committed, so a working-tree CLI mode would be a second fit path. A fit over
195 Pulls took 0.24 s locally.

It writes `.fleet/router-preview.json` through a temp file and a rename:

```
{ computed_at, guard_computed_at, tsv_blobs,
  prior: { fitted_commit, version, stage, cells, classifier, window_start },
  table }
```

- It runs only when the guard duty wrote a guard.
- It never fails the run: an error prints
  `metrics-refresh: preview: failed — <why>`, leaves the old file in place
  and leaves the exit status unchanged.
- It is never routed and never committed.

### 10.5 The cockpit

- `board-gather.mjs` reads the records of § 4.1 every tick; reads
  `modelRoles` and main's blob ids at most once a minute, carried forward in
  `board.json`; and keeps `resolvedModelIdentity`, `thinking` and
  `subagent_type` for each implementer from the member record it already
  builds (today it keeps only the last turn's `model`). The model is keyed
  through `dispatchModel`, so it names the Pull's Cell generation.
- `board.json` gains `cellEvidence` (the tab's model), a `cellLine` on each
  implementer card, and the carried `modelRoles` and `mainMetrics` reads, each
  `{ value, readAt, error }`.

## 11. Test seams

The board's split holds: gather is impure, compute is pure, the page renders.

| Seam | Where | Pins |
|---|---|---|
| `rowDispatch` | `ticket-router.mjs` | for every Objective × Stratum and guard state (missing, none, tripped row Cell, tripped draw Cell, burn-in, fitted), `route`'s `CELL`/`REASON`/draw set agree with it |
| `parseRouting` / `formatRouting` | `ledger-grammar.mjs` | round-trip; refusals; an old row with `route=` and no entry |
| the derived-note test | `tier-outcomes.mjs` | `append`'s two note forms are derived; anything else is by hand |
| `tally` / `attribute` counts | `pull-attribution.mjs` | `by_hand`, `no_ruling`, `pending` per generation |
| `guardFile` | `pr-cost.mjs` | whole entries, `older` nested, `trip_points`, `tsv_blobs`; `readGuard` and `readCostGuard` accept it |
| the preview duty | `metrics-refresh.mjs` | writes the file beside a fresh guard; skipped with no guard; a failure keeps the old file and the exit |
| `computeCellEvidence(inputs)` | new `compute-cell-evidence.mjs`, pure | each state of § 5.1; the policy-rows view (each side's shared dispatch, per-row exceptions, collapsed Strata, `≠` marks); each signal of § 6.2 on and off; whose-runs words; model-name labels; the alert list |
| `cellLine(card inputs)` | `compute-board.mjs`, pure, through `admissibleRow` and `dispatchModel` | every reason of § 7.2; each mark of § 7.3; "not on record" and "recorded as …" on old rows; rescue |
| `routeHash(hash)` | `board.html`, lifted out by the tests as `spendView` is (regex on a column-0 `function`, `new Function`) | hash → tab and target id for every route of § 8; an unknown target lands on the tab's top |
| `spendView` | `board.html` | unchanged; its heading texts move with the rename |

Words live in the pure functions, not in the page, so the tests pin them
where they are built.

## 12. Change surface

Grouped by the ticket (§ 13) that owns each change. Each ticket also amends
the docs its change falsifies: `docs/specs/2026-09-28-model-effort-router-design.md`
(the route line, the guard file's fields), `docs/specs/2026-07-24-fleet-cockpit-design.md`
(the `board.json` shape) and the scripts' own header comments.

**T1 — tabs and Tokens:** `board.html` gains the tab strip, the hash router
(`routeHash`) and the global/per-tab split; the token panel moves to Tokens
with its two headings renamed. Cell evidence is not yet in the strip.

**T2 — the guard file's figures:** `tier-outcomes.mjs` exports the
derived-note test; `pull-attribution.mjs` counts `by_hand`, `no_ruling` and
`pending`; `pr-cost.mjs` `guardFile` keeps whole entries, `trip_points` and
`tsv_blobs`.

**T3 — the guard section:** `compute-cell-evidence.mjs` (guard part),
`board-gather.mjs` (guard, receipts' `metrics` steps, agent definitions,
`modelRoles` carried), `board.html` (the Cell evidence tab with the guard
section and Declared, not measured).

**T4 — routes now:** `ticket-router.mjs` (`rowDispatch`, `rowFor` exported,
`route` calls it), `compute-cell-evidence.mjs` (policy rows, routes now side,
whose-runs words), `board-gather.mjs` (installed table, install
`package.json`, live Objective), `board.html`.

**T5 — the Preview fit:** `metrics-refresh.mjs` (the preview duty),
`compute-cell-evidence.mjs` (evidence favours side, `≠` marks, its heading
labels), `board-gather.mjs`, `board.html`.

**T6 — alerts against main and between readers:** `board-gather.mjs` (the
contents call with `--hostname`, carried; the close-out receipt; the
checkout's table), `compute-cell-evidence.mjs` (records not on main, guard
readers, installed table behind main's, the alert list), `board.html` (alerts,
`⚠n`).

**T7 — the Routing on the ledger:** `ticket-router.mjs` (`route` prints the
Routing; thresholds exported), `ledger-grammar.mjs` (`## Routed`,
`parseRouting`, `formatRouting`), `ledger.mjs` (`row --routing`, validation,
rotate carry), `pull.mjs` (row step; `route=` retired),
`plugin/skills/run-team/references/pull.md`.

**T8 — the card's Cell line:** `board-gather.mjs` (implementer model,
thinking, subagent type; `phase0.previous.json` for cards), `compute-board.mjs`
(`cellLine`), `board.html` (the line, the mark, links card → guard entry and
row; the guard entry's "this run's Pulls").

## 13. Tickets (input to `/to-tickets`)

Filed 2026-10-27, `ready-for-agent` + `enhancement`, blockers first, each
with a `## Blocked by` section and GitHub's native blocking edges.

| # | Issue | Title | Blocked by | Delivers | Spec § |
|---|---|---|---|---|---|
| T1 | #3891 | Cockpit tabs: Board and Tokens, kept in the URL hash | — | the tab strip, hash routes, the token panel on Tokens with its headings renamed; banner, attention strip and footer global | 3, 8, 9 |
| T2 | #3892 | The cost guard keeps every per-Cell figure it judged | — | `cost-guard.json` with whole entries, `older`, `by_hand`, `no_ruling`, `pending`, `trip_points`, `tsv_blobs`; both readers accept it | 10.3 |
| T3 | #3894 | Cell evidence tab: what the guard holds each Cell to | T1, T2 | the tab with the guard section (all five Cells, three figures, labels, older generations, no-guard and holds-nothing-back headings) and Declared, not measured | 5.1, 5.3, 5.4, 6 |
| T4 | #3895 | Cell evidence tab: what routes now, row by row | T3 | routes now side: whose runs, burn-in words, dispatch, collapsed Strata, model-name labels, installed table from `rowDispatch` | 4.3, 5.2 |
| T5 | #3896 | The Preview fit, and what the evidence favours | T4 | `router-preview.json` at phase 0 and close-out; evidence favours side with `≠ routes now` and its heading labels | 5.2, 6.2, 10.4 |
| T6 | #3897 | Cell evidence alerts: records not on main, guard readers | T5 | the three alerts, `⚠n` on the tab label, installed table behind main's | 6.2, 6.3 |
| T7 | #3893 | Each Pull's Routing on the ledger | — | `route` prints the whole Routing; `## Routed` written with the row; `route=` retired; rotate carries entries | 10.1, 10.2 |
| T8 | #3898 | A card says which Cell its Pull ran on, and why | T3, T7 | the card's Cell line, mark and links both ways | 7, 8 |
