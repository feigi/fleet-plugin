# Token pricing source and the columns a $-per-PR figure still lacks

Research ticket: [#2033](https://github.com/feigi/fleet-plugin/issues/2033) (child of wayfinder map [#2030](https://github.com/feigi/fleet-plugin/issues/2030)). Answers the three questions in the ticket body against primary sources: `platform.claude.com`'s pricing docs, `omp://` docs, live `~/.omp/agent/sessions/**/*.jsonl` files on this box, and the repo's own `plugin/scripts/member-outcomes.mjs` / `member-record.mjs`.

## 1. Public list price per model id in the corpus

Ran the ticket's exact extraction against `docs/metrics/member-outcomes.tsv` (2026-09-27):

```
$ awk -F'\t' '!/^#/ {n[$5]++} END{for (k in n) print n[k], k}' docs/metrics/member-outcomes.tsv | sort -rn
5882 claude-opus-5
3781 claude-sonnet-5
1117 claude-haiku-4-5-20251001
531 claude-haiku-4-5
24 claude-opus-4-7
23 claude-opus-4-8
13 claude-fable-5-1
```

`claude-fable-5-1` is **not a fleet member**: the TSV's own header (`docs/metrics/member-outcomes.tsv:40`, "one row has `role` of `-`... that is `__advisor`") and a corpus check confirm all 13 rows carry `role=-`, `subagent_type` blank, and `member=__advisor` — this is omp's own top-level advisor/control-plane model, not a dispatched implementer/reviewer/finisher. It is priced below only because rows carrying it exist in the file; it is not a candidate cell for the router.

Price table, USD per MTok, from the official Claude Platform docs pricing page (**primary source**: <https://platform.claude.com/docs/en/about-claude/pricing>, read 2026-09-27; this is the page `claude.com/pricing` itself points to for "current pricing information"):

| Model id (corpus) | Input | 5m cache write | 1h cache write | Cache read | Output |
|---|---|---|---|---|---|
| `claude-opus-5` | $5 | $6.25 | $10 | $0.50 | $25 |
| `claude-sonnet-5` | $2 | $2.50 | $4 | $0.20 | $10 |
| `claude-haiku-4-5` | $1 | $1.25 | $2 | $0.10 | $5 |
| `claude-haiku-4-5-20251001` | $1 | $1.25 | $2 | $0.10 | $5 |
| `claude-opus-4-7` | $5 | $6.25 | $10 | $0.50 | $25 |
| `claude-opus-4-8` | $5 | $6.25 | $10 | $0.50 | $25 |
| `claude-fable-5-1` (`__advisor`, not a fleet member) | $10 | $12.50 | $20 | $0.25 | $50 |

Notes from the same page, verbatim rules, not restated per-row above:

- **5-minute cache write**: 1.25x the model's base input price. **1-hour cache write**: 2x base input. **Cache read (hit)**: 0.1x base input on every model in this table (Claude Fable 5.1 and Claude Mythos 5.1 are the only two models with a different multiplier, 0.025x — irrelevant here since Fable is not a billable fleet member and Mythos never appears in the corpus).
- `claude-haiku-4-5-20251001` is the dated-snapshot alias of `claude-haiku-4-5`; Anthropic's convention is that a `-YYYYMMDD` suffix pins a snapshot of the bare model id at unchanged pricing. The pricing page lists only the bare id; the dated alias's identical price is **[INFERENCE]** by that naming convention, not read off a row naming the dated id explicitly.
- `claude-opus-4-7` and `claude-opus-4-8` are both listed as retaining Opus 4.6/4.7's $5/$25 rate (`claude-opus-4-8` additionally offers a $10/$50 "Fast Mode" this repo's dispatches do not use — no `speed: "fast"` parameter appears anywhere in `plugin/agents/` or `plugin/scripts/`).
- **Per-generation differences, explicit**: newer is not always dearer and older is not cheaper. Measured from the same table: `claude-opus-5` ($5/$25) is priced the same as the `claude-opus-4-7`/`claude-opus-4-8` generation it superseded, while the newest `claude-opus-5-5` (announced 2026-09-22, not yet present in the corpus — see [TechCrunch](https://techcrunch.com/2026/09/22/anthropic-releases-opus-5-5-with-lower-prices-and-fable-level-performance/), 2026-09-22) is *cheaper* at $4/$20. `claude-sonnet-5` at $2/$10 is cheaper than the `claude-sonnet-4-6` generation it replaced ($3/$15 per the same docs table). This is exactly the corpus header's own warning (`member-outcomes.tsv:46-51`, "SUPERSEDED GENERATIONS ARE A SEPARATE POPULATION... pricing falls with each generation... an older Sonnet is dearer") confirmed against the live rate card: pooling generations under a coarse "opus"/"sonnet" label would silently invert the cost ordering in both directions depending on which pair you pick.
- I added `claude-opus-5-5` to the draft `pricing.json` even though it has 0 rows in today's corpus, because it is this box's currently-configured `modelRoles.slow` target (per `omp config get modelRoles`, corroborated by the charting session's ground truth) and will start appearing the next time `fleet-implementer` dispatches — the pricing table should not lag one dispatch behind the corpus.

## 2. What omp exposes, and what the repo's own scraper drops

### 2a. omp's per-turn usage object — documented and measured

`omp://session.md` documents the `AgentMessage` entry shape (the session JSONL's per-turn record) with a `usage` object; a real message line on this box carries exactly this shape:

```json
{"type":"message","message":{"role":"assistant","provider":"anthropic","model":"claude-sonnet-5",
  "content":[...],
  "usage":{"input":2,"output":201,"cacheRead":0,"cacheWrite":31319,"totalTokens":31522,
    "cost":{"input":4e-6,"output":0.00201,"cacheRead":0,"cacheWrite":0.0783,"total":0.0803}}}}
```

So the raw session file already carries `input`, `output`, `cacheRead`, `cacheWrite` **and a real computed dollar cost** per turn, one usage object per turn (no Claude-style per-content-block repetition — this was independently confirmed in an earlier measurement, agent-brain memory `l0CgKLv9GUvxCKjV2xZ7H`).

**Cache-TTL breakdown, undocumented but present.** Real files on this box also carry a `cttl` object alongside `usage` breaking the cache-write figure into TTL buckets:

```
"usage":{"input":2,"output":1165,"cacheRead":20425,"cacheWrite":15192,"totalTokens":36784,
  "cost":{...,"cacheWrite":0.03798,"total":0.053719},"cttl":{"ephemeral5m":15192}}
```
Measured (`grep -o '"cttl":{[^}]*}' ~/.omp/agent/sessions/**/*.jsonl`): both `ephemeral5m` and `ephemeral1h` keys occur across this box's own session store. `cttl` is **not documented** anywhere under `omp://providers.md`, `omp://models.md`, or `omp://session.md` (grepped all three for `cttl`/`ephemeral`/`cacheRetention`: zero hits in providers.md and models.md) — it is an on-disk-only fact, the same posture the prompt-cache memory (`VnFxcVMVJ4gWAkHCWmP3G`) already flagged for `provider.appendOnlyContext`.

The setting that decides which TTL a write lands in **is** documented: `omp://settings.md:860`, `providers.cacheRetention` (enum `auto`/`short`/`long`/`none`), default `auto` — "`auto` keeps provider defaults (Anthropic: **1h entries on OAuth subscriber sessions, 5m entries plus idle keep-alive refreshes on API keys**)". This box's own setting is `auto` (`omp config get providers.cacheRetention` → `auto`).

**This split is not a rounding error.** Measured on this repo's own omp session corpus (`~/.omp/agent/sessions/-dev-fleet-plugin/**/*.jsonl`, 149,936 `cttl` occurrences):

| TTL bucket | occurrences | cache-write tokens | share of tokens |
|---|---|---|---|
| `ephemeral5m` | 29,361 | 94,679,431 | 25.4% |
| `ephemeral1h` | 120,575 | 277,789,357 | 74.6% |

Three quarters of this repo's own cache-write tokens bill at the 1h rate (2x input), not the 5m rate (1.25x input) the `auto` default's "API key" branch would suggest. A pricing formula that assumes "all cache writes are 5m" would underprice roughly three-quarters of the corpus's cache-write $ by a factor of 1.6 (2/1.25). **This is the single largest correctness risk in any naive $-per-PR formula** and is why the TTL split, not just a blended `cache_write` figure, has to reach the TSV (or the per-turn `cost.total` has to be trusted directly — see below).

### 2b. What `member-record.mjs` already computes vs. what `member-outcomes.mjs` keeps

The shared per-member record (`plugin/scripts/member-record.mjs:8-16`) is documented as carrying `tokens_in`, `tokens_cache_create`, `tokens_cache_read`, `tokens_out`, `cost`, `wall_s`, `turns`, `ticket`, `pr` — **all five token/cost figures already exist at this layer, for both harnesses**:

- **omp fold** (`readOmpSession` → `ompMemberRecord`, `member-record.mjs:631-637,652-657,760-765`): per turn, `input += u.input`, `cacheWrite += u.cacheWrite`, `cacheRead += u.cacheRead`, `output += u.output`, and `if (u.cost?.total is a number) cost += u.cost.total` — folded into a record whose `cost` field is the **omp-real, provider-computed dollar total** (`sawCost ? cost : null`). It does **not** read `u.cttl` anywhere in the file (grepped; only line 631 touches `u.cacheWrite`, the pre-blended total) — the TTL split that already exists in the raw session line is thrown away one layer before the TSV, not just at the TSV boundary.
- **Claude fold** (`foldClaudeTranscript` → `readClaudeMember`, `member-record.mjs:319-323,340-343,390-394,421-427`): per turn, `cacheWrite += u.cache_creation_input_tokens`, `cacheRead += u.cache_read_input_tokens`, `input += u.input_tokens`, folded on `message.id` (one turn, several jsonl lines, summed once — the same overcount bug the TSV header documents at `member-outcomes.tsv:53-58`). `cost` is **hardcoded `null`** (`member-record.mjs:390-394`, "Claude Code transcripts carry no dollar figure and no pricing table exists in this repo to derive one") — Claude-harness rows can never carry a native `$`; they are exactly the rows a repo-owned `pricing.json` is *for*.

**`plugin/scripts/member-outcomes.mjs` drops three of those five fields before they ever reach the TSV:**

- `readMember()` (`member-outcomes.mjs:43-53`) takes `rec` from `readClaudeMember` and forwards only `tokensCacheCreate: rec.tokens_cache_create` and `tokensOut: rec.tokens_out` — `rec.tokens_in`, `rec.tokens_cache_read`, and `rec.cost` are read off the record and discarded in the same function.
- `rowsForOmpSession()` (`member-outcomes.mjs:68-90`, the forwarding at `82-89`) takes `r` from `readOmpSession` and forwards the identical two fields, `tokensCacheCreate: r.tokens_cache_create` / `tokensOut: r.tokens_out` — dropping `r.tokens_in`, `r.tokens_cache_read`, and, critically, **`r.cost` — the real per-turn dollar total omp already computed** — at exactly the same two lines' pattern.
- `COLUMNS` (`member-outcomes.mjs:160-164`) has no `tokens_in`, `tokens_cache_read`, or `cost` slot to receive them even if the two functions above were changed.

So the answer to "which does `member-outcomes.mjs` drop": **`tokens_in`, `tokens_cache_read`, and `cost`, on both harnesses, at the same two functions** — not a harness-specific gap. The omp side additionally loses the cache-write TTL split one layer earlier, inside `member-record.mjs`'s own fold, before `member-outcomes.mjs` even runs.

### 2c. What a $-complete scrape must add, respecting the per-turn fold rule

The TSV header's fold rule (`member-outcomes.tsv:53-58`) is already satisfied by the existing per-turn folds in `member-record.mjs` — summing per LINE, not per turn, is the documented 176%/141% overcount bug this repo already fixed once. Any new column must ride the same already-correct fold, not add a second one:

1. **`tokens_in`** — already folded (`folded.input` / `r.tokens_in`), zero new fold logic; wire it through `readMember`/`rowsForOmpSession` and append it to `COLUMNS`.
2. **`tokens_cache_read`** — already folded (`folded.cacheRead` / `r.tokens_cache_read`), same wiring.
3. **`cost`** — already folded for omp (`folded.cost`, real dollars, blank/`""` when `sawCost` is false — e.g., a torn transcript with no completed turn); always blank for Claude rows until a `pricing.json`-driven computation fills it in downstream (this ticket's deliverable, not `member-outcomes.mjs`'s job — the TSV's own convention is "BLANK MEANS UNKNOWN", `member-outcomes.tsv:11`, so a computed-not-scraped dollar figure does not belong in this column at all; it belonges in a joined/derived column a consumer computes from `pricing.json` plus the four token columns).
4. **Cache-write TTL split** (`tokens_cache_write_5m` / `tokens_cache_write_1h`, or equivalently a `cache_write_ttl` ratio) — this one is **not** already folded anywhere; it requires a new fold step inside `member-record.mjs`'s omp path only (Claude Code has no TTL concept in its transcripts at all — every Claude cache write is implicitly billed at whatever the underlying provider call used, invisible to the transcript). Reading `u.cttl.ephemeral5m` / `u.cttl.ephemeral1h` per turn and accumulating two counters alongside the existing blended `cacheWrite` is the same shape as every other counter in that loop (`member-record.mjs:625-637`) — no architectural change, but it is new code, and it is undocumented API surface (§2a) that could change without notice.
5. **Row count is real**: 8,529+ existing TSV rows can never be backfilled with a TTL split or a Claude `$` figure from the TSV alone, since neither exists in the row as stored — a full re-scrape from the original transcripts (still on disk under `~/.omp/agent/sessions/` / `~/.claude/projects/`, per the retention policy those trees already assume) is required to backfill, exactly as any other `member-outcomes.mjs` column addition already requires (the file's own header: "Re-running the scraper REPLACES rows in place").

**Given omp already computes a real per-turn `$` (§2a-2b), the cheapest correct path for omp rows is not "recompute from a pricing table" at all — it is "wire `folded.cost` through to a `cost` TSV column and trust the provider's own arithmetic," which sidesteps the TTL-split problem entirely for every omp row.** A `pricing.json`-driven formula is still required for (a) Claude-harness rows, which never carry a native `$`, and (b) as an independent check on omp's own figure. Both need the token columns and the pricing table below regardless.

## 3. The pricing file and the $ formula

Draft delivered beside this file: [`docs/metrics/pricing.json`](../metrics/pricing.json), keyed by exact model id (matching `docs/metrics/member-outcomes.tsv` column 5 verbatim, never a coarse "opus"/"sonnet" label — the corpus header's own generation-pooling warning applies here too), each value `{input, cache_write_5m, cache_write_1h, cache_read, output}` in USD per MTok, plus top-level `as_of` (2026-09-27) and `source` (the platform.claude.com pricing URL above).

**$ formula per member row**, once the columns in §2c exist:

```
$row = (tokens_in            / 1e6) * price[model].input
     + (tokens_cache_write_5m / 1e6) * price[model].cache_write_5m
     + (tokens_cache_write_1h / 1e6) * price[model].cache_write_1h
     + (tokens_cache_read     / 1e6) * price[model].cache_read
     + (tokens_out            / 1e6) * price[model].output
```

with two fallbacks a consumer must apply in order, never silently averaging them:

1. **If the row's own `cost` column is non-blank (omp rows once §2c(3) lands): use it directly, unchanged.** It is the provider's own computed total, already correct for whichever TTL applied turn-by-turn — the formula above is not needed and cannot be more accurate than it.
2. **Else (Claude rows, or omp rows scraped before the `cost` column existed) and `tokens_cache_write_5m`/`_1h` are both present: use the split formula above.**
3. **Else (today, for every existing row — no TTL split column exists yet) and only a blended `tokens_cache_write` exists: the formula cannot be evaluated without an assumption.** Given this repo's own corpus is 74.6%-by-token 1h (§2a), assuming all-5m is the wrong default; assuming all-1h is closer but still wrong for the other quarter. **Recommendation: do not publish a $ figure for pre-TTL-split rows at all — report token counts only, and gate any $-per-merged-PR instrument (G3) on rows scraped after the TTL columns land**, exactly the same posture #1066 already took for the pairing gate ("no re-scrape can ever fill it, and it can never hold a deliberate pair" — the TSV header's own words about a different closed category apply identically here).

Never pool `model` values across the generation boundaries `pricing.json` and `member-outcomes.tsv`'s header both warn about; join on the exact `model` string, not a normalized tier label.

## Missing-column summary (for the map body / G1 and G3)

| Column | Exists in `member-record.mjs`? | Reaches `member-outcomes.tsv` today? | Needed for |
|---|---|---|---|
| `tokens_in` | Yes (`folded.input`, both harnesses) | No — dropped at `member-outcomes.mjs:43-53,82-89` | $ formula input term |
| `tokens_cache_read` | Yes (`folded.cacheRead`, both harnesses) | No — same two functions | $ formula cache-read term |
| `cost` (omp-real) | Yes, omp only (`folded.cost`); always `null` for Claude | No — same two functions | Ground-truth $ for omp rows, bypassing the TTL problem entirely |
| cache-write TTL split (`ephemeral5m`/`ephemeral1h`) | No — not folded even inside `member-record.mjs` (only `u.cacheWrite`, the blend, is read at `member-record.mjs:631`) | No | $ formula cache-write term, for Claude rows and as a cross-check on omp's `cost` |
| `pricing.json` (this ticket) | N/A — repo-level artifact | N/A | The whole $ formula; did not exist before this ticket |

## Sources

- `docs/metrics/member-outcomes.tsv` (header, lines 1-103) — corpus, extraction awk, generation-pooling warning, per-turn fold rule, `__advisor`/`role=-` note.
- `plugin/scripts/member-outcomes.mjs:12-14,43-90,156-172` — `readMember`, `rowsForOmpSession`, `COLUMNS`, `FIELD`.
- `plugin/scripts/member-record.mjs:8-16,318-343,389-394,421-427,508-517,600-657,748-765` — shared record shape, Claude fold, omp fold, `ompMemberRecord`.
- <https://platform.claude.com/docs/en/about-claude/pricing> (read 2026-09-27) — model pricing table, prompt-cache multipliers, generation notes.
- `omp://session.md` — `AgentMessage`/`usage` object shape (documented).
- `omp://settings.md:860` — `providers.cacheRetention` semantics (`auto`/`short`/`long`/`none`).
- `~/.omp/agent/sessions/**/*.jsonl` (this box, read 2026-09-27) — live `usage`/`cttl` shape confirmation; `~/.omp/agent/sessions/-dev-fleet-plugin/**/*.jsonl` — the 5m/1h token-share measurement.
- <https://techcrunch.com/2026/09/22/anthropic-releases-opus-5-5-with-lower-prices-and-fable-level-performance/> (2026-09-22) — Opus 5.5 pricing, corroborating the generation-price-inversion note.
- `omp config get providers.cacheRetention` (this box) → `auto`.
