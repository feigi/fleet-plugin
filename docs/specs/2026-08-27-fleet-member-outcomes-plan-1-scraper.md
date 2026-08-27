# Fleet Member-Outcomes Scraper — Implementation Plan (Part 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record which model and effort every fleet member ran at, for every run,
into a regenerable metrics file — and backfill it from the 154 sessions on disk
that dispatched at least one member (`ls -d ~/.claude/projects/*/*/subagents/`;
the count of session directories is far larger and is not the population here).

**Architecture:** One script, `skills/fleet/scripts/member-outcomes.mjs`,
exporting pure functions and wrapping them in a thin CLI. It reads a session's
`subagents/*.{jsonl,meta.json}` — files the harness already writes — and emits one
tab-separated row per member. Rows are keyed on `session`+`member` and replaced in
place, so re-running is idempotent and the whole file can be regenerated when the
role classifier improves. It imports `classifyRole` from `compute-spend.mjs`
rather than re-deriving roles, so the two files cannot disagree about what a
"reviewer" is.

**Tech Stack:** Node ESM (`.mjs`), `node:test` + `node:assert/strict`, no
dependencies. Matches every other script under `skills/fleet/scripts/`.

**Spec:** `docs/specs/2026-08-27-fleet-member-outcomes-instrumentation-design.md`

## Global Constraints

- **Every column must be derivable from transcripts alone.** A column requiring
  controller input cannot survive regeneration. If a task tempts you to add one,
  the answer is no — see the spec's "Why two files".
- **No verdict columns in `member-outcomes.tsv`.** Ever.
- **No `--backfill` flag.** Backfill is the same CLI call in a shell loop.
- **Pure means pure:** no clock read, no network, no `gh`, no `Date.now()`.
  Anything time-derived comes out of the files being read.
- Run tests with `node --test skills/fleet/scripts/<file>.test.mjs` from the repo
  root.
- Repo root for this work is the worktree `.worktrees/member-outcomes`, branch
  `feature/member-outcomes-instrumentation`. Do not edit the main checkout.

---

### Task 1: File the ticket

**Files:**
- Create: none (GitHub only)

**Interfaces:**
- Consumes: nothing
- Produces: an issue number, referenced by every commit message below as `#N`

- [ ] **Step 1: Create the issue**

```bash
gh issue create --repo feigi/claude-config \
  --title "Record model and effort per fleet member, so tiering can be decided on evidence" \
  --label ready-for-agent \
  --body "Spec: docs/specs/2026-08-27-fleet-member-outcomes-instrumentation-design.md

The fleet dispatches six kinds of member and records the tier of none of them.
implementer-model-tier.test.mjs:19-21 states the gap: board.mjs parses
message.usage off the subagent JSONL and drops message.model on the same line.

Part 1 (this issue): the scraper + backfill.
Part 2 (separate): declared per-role tiers and the within-run control rule."
```

- [ ] **Step 2: Record the number**

Note the issue number it prints. Substitute it for `#N` in every commit message
below.

---

### Task 2: `normalizeModel()`

**Files:**
- Create: `skills/fleet/scripts/member-outcomes.mjs`
- Test: `skills/fleet/scripts/member-outcomes.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces: `normalizeModel(raw: string) => string | null` — `null` means "not a
  model, drop this row"

Raw values measured on disk at `c82c5a5`: `claude-opus-5`,
`claude-haiku-4-5-20251001`, `claude-sonnet-5`, `claude-opus-4-8`,
`claude-opus-4-7`, `<synthetic>`, and the bare aliases `opus`, `sonnet`, `haiku`.

- [ ] **Step 1: Write the failing test**

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeModel } from "./member-outcomes.mjs";

test("a versioned model id is kept verbatim", () => {
  assert.equal(normalizeModel("claude-opus-5"), "claude-opus-5");
  assert.equal(normalizeModel("claude-haiku-4-5-20251001"), "claude-haiku-4-5-20251001");
});

test("the [1m] context variant is stripped — it is the same model", () => {
  // impl-580.meta.json records "claude-opus-5[1m]" while its own messages say
  // "claude-opus-5". Two spellings of one model would split every count.
  assert.equal(normalizeModel("claude-opus-5[1m]"), "claude-opus-5");
});

test("a bare alias stays bare — it cannot be resolved to a version", () => {
  // Guessing a version here would invent data. `opus` is honestly less precise
  // than `claude-opus-5`, and a read-out can group on the family prefix.
  assert.equal(normalizeModel("opus"), "opus");
  assert.equal(normalizeModel("sonnet"), "sonnet");
});

test("<synthetic> is dropped, not mapped — it is not a model", () => {
  assert.equal(normalizeModel("<synthetic>"), null);
});

test("empty and absent are dropped", () => {
  assert.equal(normalizeModel(""), null);
  assert.equal(normalizeModel(undefined), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test skills/fleet/scripts/member-outcomes.test.mjs`
Expected: FAIL — cannot find module `./member-outcomes.mjs`

- [ ] **Step 3: Write minimal implementation**

```javascript
// Scraper for per-member model/effort facts. Pure over the harness's own
// subagent transcripts: no clock, no network, no gh. See
// docs/specs/2026-08-27-fleet-member-outcomes-instrumentation-design.md.

// `<synthetic>` is not a model — it is the harness labelling a turn it
// generated itself, and mapping it to anything would invent a data point. The
// `[1m]` suffix is a context-window variant of the SAME model: meta.json writes
// `claude-opus-5[1m]` while that member's own messages write `claude-opus-5`,
// so keeping both spellings would split every count in half.
export function normalizeModel(raw) {
  const s = String(raw ?? "").trim();
  if (!s || s === "<synthetic>") return null;
  return s.replace(/\[[^\]]*\]$/, "");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test skills/fleet/scripts/member-outcomes.test.mjs`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add skills/fleet/scripts/member-outcomes.mjs skills/fleet/scripts/member-outcomes.test.mjs
git commit -m "feat(member-outcomes): normalizeModel drops <synthetic> and folds the [1m] variant (#N)"
```

---

### Task 3: `parseMemberName()`

**Files:**
- Modify: `skills/fleet/scripts/member-outcomes.mjs`
- Test: `skills/fleet/scripts/member-outcomes.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces: `parseMemberName(name: string) => { ticket: string, pr: string }` —
  both `""` when the name carries no number

`ticket` and `pr` must be derived, never supplied, per the Global Constraints.
Fleet member names follow `impl-<issue#>`, `fix-pr-<pr#>`, `review-pr-<pr#>`,
`merge-bot-<wave#>` (`references/member-lifecycle.md:7`), plus the two live
finisher spellings `finish-<n>` and `finisher-pr-<n>` (`compute-spend.mjs:17-20`).

- [ ] **Step 1: Write the failing test**

```javascript
import { parseMemberName } from "./member-outcomes.mjs";

test("impl-<n> names a TICKET, not a PR", () => {
  assert.deepEqual(parseMemberName("impl-580"), { ticket: "580", pr: "" });
});

test("every pr-shaped member name yields a PR and no ticket", () => {
  assert.deepEqual(parseMemberName("fix-pr-662"), { ticket: "", pr: "662" });
  assert.deepEqual(parseMemberName("review-pr-555"), { ticket: "", pr: "555" });
  assert.deepEqual(parseMemberName("finisher-pr-904"), { ticket: "", pr: "904" });
});

test("merge-bot's number is a WAVE, so it is neither ticket nor pr", () => {
  // merge-bot-12 is the twelfth wave, not PR 12. Booking it as a pr would join
  // this row to an unrelated PR's verdict row.
  assert.deepEqual(parseMemberName("merge-bot-12"), { ticket: "", pr: "" });
});

test("a retry suffix does not change what the name identifies", () => {
  // run-team spawns `impl-<N>-b` when a member is re-dispatched.
  assert.deepEqual(parseMemberName("impl-580-b"), { ticket: "580", pr: "" });
});

test("an unrecognised name yields blanks, never a guess", () => {
  assert.deepEqual(parseMemberName("size candidate 7"), { ticket: "", pr: "" });
  assert.deepEqual(parseMemberName(""), { ticket: "", pr: "" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test skills/fleet/scripts/member-outcomes.test.mjs`
Expected: FAIL — `parseMemberName is not a function`

- [ ] **Step 3: Write minimal implementation**

```javascript
// A member's name is the only place its unit of work is recorded — nothing
// writes ticket or PR into meta.json. `merge-bot-<n>` is deliberately excluded:
// its number is a WAVE index, and booking it as a pr would join the row to an
// unrelated PR's verdict. The `-b` retry suffix is stripped first, because a
// re-dispatched member works the same unit.
export function parseMemberName(name) {
  const s = String(name ?? "").trim().replace(/-[a-z]$/, "");
  let m = /^(?:fix|review|finisher)-pr-(\d+)$/.exec(s);
  if (m) return { ticket: "", pr: m[1] };
  m = /^impl-(\d+)$/.exec(s);
  if (m) return { ticket: m[1], pr: "" };
  return { ticket: "", pr: "" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test skills/fleet/scripts/member-outcomes.test.mjs`
Expected: PASS, 10 tests

- [ ] **Step 5: Commit**

```bash
git add skills/fleet/scripts/member-outcomes.mjs skills/fleet/scripts/member-outcomes.test.mjs
git commit -m "feat(member-outcomes): parse ticket/pr from member name, never from a supplied field (#N)"
```

---

### Task 4: `readMember()`

**Files:**
- Modify: `skills/fleet/scripts/member-outcomes.mjs`
- Test: `skills/fleet/scripts/member-outcomes.test.mjs`

**Interfaces:**
- Consumes: `normalizeModel`, `parseMemberName`
- Produces: `readMember(jsonlText: string, meta: object) => Row | null` where
  `Row` is
  `{ role, member, model, effort, ticket, pr, tokensCacheCreate, tokensOut, wallS, turns, errored }`.
  `null` means the transcript contributed no usable model.

Takes **text**, not a path, so it stays pure and testable without fixtures on
disk. Task 5 does the file reading.

`effort` is read from the per-message `"effort"` field in the JSONL. It is NOT in
`meta.json` — across 400 sampled `*.meta.json` the key set is `agentType`,
`description`, `spawnDepth`, `toolUseId`, `model`, `parentAgentId`, `name`,
`taskKind`, `teamName`, `color`, `planModeRequired`, `permissionMode`,
`customAgentType`, and no effort.

**`model` must come off the transcript too, and this is not merely tidiness.**
Measured 2026-08-27: `meta.json` carries `model` only when the DISPATCH supplied
it. A member resolved from an agent definition writes four keys — `agentType`,
`description`, `toolUseId`, `spawnDepth` — and no `model` at all. Part 2 declares
the implementer's tier in exactly that way, so a scraper falling back to
`meta.model` would go blank on precisely the members this whole exercise exists
to measure.

- [ ] **Step 1: Write the failing test**

```javascript
import { readMember } from "./member-outcomes.mjs";

const line = (o) => JSON.stringify(o);
const assistant = (model, effort, usage = {}) => line({
  type: "assistant", isSidechain: true, effort,
  timestamp: "2026-08-25T07:14:12.147Z",
  message: { model, usage: { cache_creation_input_tokens: 0, output_tokens: 0, ...usage } },
});
const meta = (o = {}) => ({ agentType: "impl-580", description: "Implement ticket 580", name: "impl-580", spawnDepth: 0, ...o });

test("model and effort come off the transcript, not the meta", () => {
  // meta.json never records effort, and records model only when the dispatch
  // supplied one — a frontmatter-resolved member has no `model` key at all.
  // The transcript is the only source that answers both.
  const row = readMember([
    assistant("claude-opus-5", "xhigh"),
    assistant("claude-opus-5", "xhigh"),
  ].join("\n"), meta());
  assert.equal(row.model, "claude-opus-5");
  assert.equal(row.effort, "xhigh");
});

test("usage sums across turns", () => {
  const row = readMember([
    assistant("claude-opus-5", "xhigh", { cache_creation_input_tokens: 100, output_tokens: 7 }),
    assistant("claude-opus-5", "xhigh", { cache_creation_input_tokens: 250, output_tokens: 3 }),
  ].join("\n"), meta());
  assert.equal(row.tokensCacheCreate, 350);
  assert.equal(row.tokensOut, 10);
  assert.equal(row.turns, 2);
});

test("a torn final line is skipped, not fatal", () => {
  // A transcript can be read while it is still being written.
  const row = readMember(
    assistant("claude-opus-5", "xhigh", { output_tokens: 5 }) + '\n{"type":"assis',
    meta(),
  );
  assert.equal(row.tokensOut, 5);
  assert.equal(row.turns, 1);
});

test("a member with no effort field records blank, not a default", () => {
  // haiku carries no effort control at all. Defaulting to the session's value
  // would assert something never measured.
  const row = readMember(assistant("claude-haiku-4-5-20251001", undefined), meta());
  assert.equal(row.effort, "");
});

test("a transcript whose only model is <synthetic> yields no row", () => {
  assert.equal(readMember(assistant("<synthetic>", "xhigh"), meta()), null);
});

test("mixed models record the LAST — a mid-run switch is the tier it finished at", () => {
  const row = readMember([
    assistant("claude-opus-5", "xhigh"),
    assistant("claude-sonnet-5", "xhigh"),
  ].join("\n"), meta());
  assert.equal(row.model, "claude-sonnet-5");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test skills/fleet/scripts/member-outcomes.test.mjs`
Expected: FAIL — `readMember is not a function`

- [ ] **Step 3: Write minimal implementation**

```javascript
import { classifyRole } from "./compute-spend.mjs";

// One row from one member's transcript plus its meta. Takes TEXT rather than a
// path so it stays pure — the file reading lives in rowsForSession().
//
// The torn-line skip mirrors board.mjs: a transcript can be read while it is
// still being appended to, and losing a whole member over its last few bytes
// would be a blackout rather than degradation.
//
// `model` records the LAST turn's, not the first: a member whose model changed
// mid-run finished at the later one, and that is the tier its output reflects.
export function readMember(jsonlText, meta) {
  let model = null, effort = "", cache = 0, out = 0, turns = 0;
  let firstTs = null, lastTs = null;
  for (const raw of String(jsonlText ?? "").split("\n")) {
    if (!raw.trim()) continue;
    let d;
    try { d = JSON.parse(raw); } catch { continue; }
    const ts = d.timestamp;
    if (ts) { firstTs ??= ts; lastTs = ts; }
    const m = d.message;
    if (!m || d.type !== "assistant") continue;
    const norm = normalizeModel(m.model);
    if (norm) model = norm;
    if (typeof d.effort === "string") effort = d.effort;
    const u = m.usage ?? {};
    cache += Number(u.cache_creation_input_tokens ?? 0);
    out += Number(u.output_tokens ?? 0);
    turns++;
  }
  if (!model) return null;

  const member = String(meta?.name ?? meta?.agentType ?? "");
  const { ticket, pr } = parseMemberName(member);
  const span = firstTs && lastTs ? (Date.parse(lastTs) - Date.parse(firstTs)) / 1000 : 0;
  return {
    role: classifyRole(meta), member, model, effort, ticket, pr,
    tokensCacheCreate: cache, tokensOut: out,
    wallS: Number.isFinite(span) ? Math.round(span) : 0,
    turns,
    // A member that produced no assistant turn at all never reaches here (no
    // model), so `errored` marks the other shape: turns happened, then the
    // transcript stopped. It is a stall or a terminal API failure, NOT a code
    // defect — the verdict for that lives in tier-outcomes.tsv.
    errored: turns > 0 && lastTs === firstTs ? "yes" : "no",
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test skills/fleet/scripts/member-outcomes.test.mjs`
Expected: PASS, 17 tests

- [ ] **Step 5: Commit**

```bash
git add skills/fleet/scripts/member-outcomes.mjs skills/fleet/scripts/member-outcomes.test.mjs
git commit -m "feat(member-outcomes): readMember extracts model/effort/usage from one transcript (#N)"
```

---

### Task 5: `rowsForSession()`

**Files:**
- Modify: `skills/fleet/scripts/member-outcomes.mjs`
- Test: `skills/fleet/scripts/member-outcomes.test.mjs`

**Interfaces:**
- Consumes: `readMember`
- Produces: `rowsForSession(sessionDir: string) => Row[]`, each Row gaining
  `session` and `run_date`

`session` is the session directory's basename. `run_date` is the newest
transcript's mtime as `YYYY-MM-DD` — derived from the files, not from a clock, so
the function stays pure in the sense that matters: same inputs, same output.

- [ ] **Step 1: Write the failing test**

```javascript
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rowsForSession } from "./member-outcomes.mjs";

function fixture(members) {
  const root = mkdtempSync(join(tmpdir(), "mo-"));
  const dir = join(root, "sess-abc", "subagents");
  mkdirSync(dir, { recursive: true });
  for (const [name, jsonl, meta] of members) {
    writeFileSync(join(dir, `agent-a${name}.jsonl`), jsonl);
    writeFileSync(join(dir, `agent-a${name}.meta.json`), JSON.stringify(meta));
    utimesSync(join(dir, `agent-a${name}.jsonl`), new Date("2026-08-25T09:00:00Z"), new Date("2026-08-25T09:00:00Z"));
  }
  return join(root, "sess-abc");
}

test("one row per member, stamped with the session and its run date", () => {
  const dir = fixture([
    ["impl-580", assistant("claude-opus-5", "xhigh"), meta()],
    ["merge-bot-12", assistant("claude-opus-5", "xhigh"), meta({ agentType: "merge-bot-12", name: "merge-bot-12", description: "merge bot wave 12" })],
  ]);
  const rows = rowsForSession(dir);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].session, "sess-abc");
  assert.equal(rows[0].run_date, "2026-08-25");
});

test("a member with no .jsonl is skipped without losing its siblings", () => {
  const dir = fixture([["impl-580", assistant("claude-opus-5", "xhigh"), meta()]]);
  mkdirSync(join(dir, "subagents"), { recursive: true });
  writeFileSync(join(dir, "subagents", "agent-aorphan.meta.json"), JSON.stringify(meta()));
  assert.equal(rowsForSession(dir).length, 1);
});

test("an unparseable meta does not take the whole session down", () => {
  // board.mjs skips a bad transcript rather than blacking out the panel; same
  // rule here, for the same reason.
  const dir = fixture([["impl-580", assistant("claude-opus-5", "xhigh"), meta()]]);
  writeFileSync(join(dir, "subagents", "agent-abad.jsonl"), assistant("claude-opus-5", "xhigh"));
  writeFileSync(join(dir, "subagents", "agent-abad.meta.json"), "{not json");
  assert.equal(rowsForSession(dir).length, 1);
});

test("a session directory with no subagents dir yields no rows and does not throw", () => {
  const root = mkdtempSync(join(tmpdir(), "mo-"));
  assert.deepEqual(rowsForSession(root), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test skills/fleet/scripts/member-outcomes.test.mjs`
Expected: FAIL — `rowsForSession is not a function`

- [ ] **Step 3: Write minimal implementation**

```javascript
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";

// Walks one session's subagents dir. Every failure is per-member: one unreadable
// transcript or unparseable meta must not cost the other sixteen members their
// rows. board.mjs takes the same stance on the same files.
//
// run_date comes from the newest transcript's mtime rather than a clock read, so
// a backfill run in December still dates an August session in August.
export function rowsForSession(sessionDir) {
  const dir = join(sessionDir, "subagents");
  let names;
  try { names = readdirSync(dir); } catch { return []; }

  const rows = [];
  let newest = 0;
  for (const f of names.filter((x) => x.endsWith(".jsonl"))) {
    try {
      const jsonl = readFileSync(join(dir, f), "utf8");
      const meta = JSON.parse(readFileSync(join(dir, f.replace(/\.jsonl$/, ".meta.json")), "utf8"));
      const row = readMember(jsonl, meta);
      if (!row) continue;
      newest = Math.max(newest, statSync(join(dir, f)).mtimeMs);
      rows.push(row);
    } catch { /* one member's loss, not the session's */ }
  }
  const session = basename(sessionDir);
  const run_date = newest ? new Date(newest).toISOString().slice(0, 10) : "";
  return rows.map((r) => ({ session, run_date, ...r }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test skills/fleet/scripts/member-outcomes.test.mjs`
Expected: PASS, 22 tests

- [ ] **Step 5: Commit**

```bash
git add skills/fleet/scripts/member-outcomes.mjs skills/fleet/scripts/member-outcomes.test.mjs
git commit -m "feat(member-outcomes): rowsForSession walks one session, skipping per member (#N)"
```

---

### Task 6: `mergeRows()` and `formatTsv()`

**Files:**
- Modify: `skills/fleet/scripts/member-outcomes.mjs`
- Test: `skills/fleet/scripts/member-outcomes.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces: `COLUMNS: string[]`, `mergeRows(existing: Row[], incoming: Row[]) => Row[]`,
  `formatTsv(rows: Row[]) => string`, `parseTsv(text: string) => Row[]`

Idempotency is the whole point: this is what makes both a phase-3 re-run and a
full regeneration safe.

- [ ] **Step 1: Write the failing test**

```javascript
import { COLUMNS, mergeRows, formatTsv, parseTsv } from "./member-outcomes.mjs";

const row = (o) => ({
  session: "s1", run_date: "2026-08-25", role: "implementer", member: "impl-580",
  model: "claude-opus-5", effort: "xhigh", ticket: "580", pr: "",
  tokensCacheCreate: 0, tokensOut: 0, wallS: 0, turns: 1, errored: "no", ...o,
});

test("re-scraping a session REPLACES its rows rather than appending duplicates", () => {
  const merged = mergeRows([row({ model: "opus" })], [row({ model: "claude-opus-5" })]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].model, "claude-opus-5");
});

test("re-scraping one session leaves every other session untouched", () => {
  // The failure this guards: a backfill loop that rewrites the file per session
  // and drops the previous session each time.
  const merged = mergeRows(
    [row({ session: "s0", member: "impl-1" }), row({ session: "s1", member: "impl-580" })],
    [row({ session: "s1", member: "impl-580", turns: 9 })],
  );
  assert.equal(merged.length, 2);
  assert.equal(merged.find((r) => r.session === "s0").member, "impl-1");
  assert.equal(merged.find((r) => r.session === "s1").turns, 9);
});

test("output order is stable, so a regeneration produces no spurious diff", () => {
  const a = formatTsv(mergeRows([], [row({ member: "impl-9" }), row({ member: "impl-1" })]));
  const b = formatTsv(mergeRows([], [row({ member: "impl-1" }), row({ member: "impl-9" })]));
  assert.equal(a, b);
});

test("a tsv round-trips", () => {
  const rows = [row(), row({ session: "s2", member: "fix-pr-662", role: "reviewer", ticket: "", pr: "662" })];
  assert.deepEqual(parseTsv(formatTsv(rows)).map((r) => r.member), ["fix-pr-662", "impl-580"].sort());
});

test("a blank field round-trips as blank, never as zero", () => {
  // Blank means UNKNOWN. Reading it back as 0 would make an unmeasured member
  // look like a free one.
  const parsed = parseTsv(formatTsv([row({ effort: "" })]));
  assert.equal(parsed[0].effort, "");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test skills/fleet/scripts/member-outcomes.test.mjs`
Expected: FAIL — `mergeRows is not a function`

- [ ] **Step 3: Write minimal implementation**

```javascript
export const COLUMNS = [
  "session", "run_date", "role", "member", "model", "effort", "ticket", "pr",
  "tokens_cache_create", "tokens_out", "wall_s", "turns", "errored",
];

// Row objects use camelCase; the file uses snake_case. One map, one direction
// each, so a rename cannot silently drop a column.
const FIELD = {
  tokens_cache_create: "tokensCacheCreate", tokens_out: "tokensOut", wall_s: "wallS",
};
const field = (c) => FIELD[c] ?? c;
const key = (r) => `${r.session}\0${r.member}`;

// Replace-by-key, not append. This is what makes a phase-3 re-run and a full
// regeneration both safe, and it is the reason no backfill-only code path is
// needed: the idempotency backfill wants is the idempotency a re-run wants.
export function mergeRows(existing, incoming) {
  const by = new Map((existing ?? []).map((r) => [key(r), r]));
  for (const r of incoming ?? []) by.set(key(r), r);
  return [...by.values()].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
}

export function formatTsv(rows) {
  return rows.map((r) => COLUMNS.map((c) => String(r[field(c)] ?? "")).join("\t")).join("\n") + "\n";
}

export function parseTsv(text) {
  return String(text ?? "").split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => {
      const cells = l.split("\t");
      const r = {};
      COLUMNS.forEach((c, i) => { r[field(c)] = cells[i] ?? ""; });
      return r;
    });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test skills/fleet/scripts/member-outcomes.test.mjs`
Expected: PASS, 27 tests

- [ ] **Step 5: Commit**

```bash
git add skills/fleet/scripts/member-outcomes.mjs skills/fleet/scripts/member-outcomes.test.mjs
git commit -m "feat(member-outcomes): idempotent merge keyed on session+member (#N)"
```

---

### Task 7: The CLI, and the file's header

**Files:**
- Modify: `skills/fleet/scripts/member-outcomes.mjs`
- Create: `docs/metrics/member-outcomes.tsv`
- Test: `skills/fleet/scripts/member-outcomes.test.mjs`

**Interfaces:**
- Consumes: `rowsForSession`, `mergeRows`, `formatTsv`, `parseTsv`, `COLUMNS`
- Produces: a CLI — `node member-outcomes.mjs <session-dir> [--file <tsv>]`

Use `makeDie` from `arg.mjs` (`skills/fleet/scripts/arg.mjs:51`): `die()` is
`writeSync`, not `console.error`, because on a pipe `process.stderr.write` is
async and `process.exit()` discards what is still queued.

- [ ] **Step 1: Write the failing test**

```javascript
import { spawnSync } from "node:child_process";

const CLI = new URL("./member-outcomes.mjs", import.meta.url).pathname;

test("no session dir is a refusal, not a silent no-op", () => {
  const r = spawnSync(process.execPath, [CLI], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /member-outcomes/);
  assert.equal(r.stdout, "");
});

test("a run writes rows, and a second run over the same session changes nothing", () => {
  const dir = fixture([["impl-580", assistant("claude-opus-5", "xhigh"), meta()]]);
  const out = join(mkdtempSync(join(tmpdir(), "mo-out-")), "member-outcomes.tsv");
  const run = () => spawnSync(process.execPath, [CLI, dir, "--file", out], { encoding: "utf8" });
  assert.equal(run().status, 0);
  const first = readFileSync(out, "utf8");
  assert.equal(run().status, 0);
  assert.equal(readFileSync(out, "utf8"), first);
});

test("the header survives a rewrite", () => {
  // The header carries the read-out commands and the blank-means-unknown rule.
  // A rewrite that drops it strands every reader.
  const dir = fixture([["impl-580", assistant("claude-opus-5", "xhigh"), meta()]]);
  const out = join(mkdtempSync(join(tmpdir(), "mo-out-")), "member-outcomes.tsv");
  writeFileSync(out, "# keep me\n");
  spawnSync(process.execPath, [CLI, dir, "--file", out], { encoding: "utf8" });
  assert.match(readFileSync(out, "utf8"), /^# keep me$/m);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test skills/fleet/scripts/member-outcomes.test.mjs`
Expected: FAIL — exit status is not 2 / file not written

- [ ] **Step 3: Write minimal implementation**

Append to `member-outcomes.mjs`:

```javascript
import { writeFileSync, existsSync } from "node:fs";
import { makeDie } from "./arg.mjs";

const NAME = "member-outcomes";

// Only runs as a CLI, never on import — the test file imports the pure helpers.
if (process.argv[1] && process.argv[1].endsWith("member-outcomes.mjs")) {
  const die = makeDie(NAME);
  const argv = process.argv.slice(2);
  const fileIdx = argv.indexOf("--file");
  const file = fileIdx >= 0 ? argv[fileIdx + 1] : "docs/metrics/member-outcomes.tsv";
  const dirs = argv.filter((a, i) => !a.startsWith("--") && i !== fileIdx + 1);
  if (dirs.length !== 1) die("usage: member-outcomes.mjs <session-dir> [--file <tsv>]", 2);
  if (!file || file.startsWith("--")) die("--file needs a path", 2);

  // Header comments are preserved verbatim across the rewrite: they carry the
  // read-out commands and the blank-means-unknown rule, and the rewrite is
  // routine (every re-scrape), so losing them would be a slow, silent erasure.
  const prev = existsSync(file) ? readFileSync(file, "utf8") : "";
  const header = prev.split("\n").filter((l) => l.startsWith("#")).join("\n");
  const merged = mergeRows(parseTsv(prev), rowsForSession(dirs[0]));
  writeFileSync(file, (header ? header + "\n" : "") + formatTsv(merged));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test skills/fleet/scripts/member-outcomes.test.mjs`
Expected: PASS, 30 tests

- [ ] **Step 5: Create the metrics file with its header**

```bash
cat > docs/metrics/member-outcomes.tsv <<'EOF'
# One row per dispatched fleet member per run. DERIVED, NOT AUTHORED: every row
# is produced by skills/fleet/scripts/member-outcomes.mjs from the harness's own
# subagent transcripts. Re-running the scraper REPLACES rows in place, and the
# whole file may be regenerated when the role classifier changes.
#
# NEVER hand-edit a row, and never add a column that a human must fill. A
# hand-entered value cannot survive a regeneration, which is exactly why the
# verdicts live in tier-outcomes.tsv instead. See
# docs/specs/2026-08-27-fleet-member-outcomes-instrumentation-design.md.
#
# BLANK MEANS UNKNOWN, never zero and never "no". `effort` is blank for models
# that carry no effort control; `ticket`/`pr` are blank when the member name
# does not identify one (merge-bot's number is a WAVE).
#
# SUPERSEDED GENERATIONS ARE A SEPARATE POPULATION. Rows carrying an older
# generation (claude-opus-4-7, claude-opus-4-8) must never be pooled with the
# current one under an "opus" label, and never read as a cheaper tier: pricing
# falls with each generation, so an older Opus is not cheaper than the current
# one and an older Sonnet is dearer. Pooling inverts the cost ordering this
# file exists to measure.
#
# `errored` is a stall or terminal API failure, NOT a code defect. Whether the
# work was any good is a verdict, and verdicts live in tier-outcomes.tsv, joined
# on `pr`.
#
# A within-run PAIR — the only unconfounded comparison — is a session+role that
# ran more than one model. Nothing is labelled; the pairing is a query:
#   awk -F'\t' '!/^#/ {k=$1 FS $3; if (!(k FS $5 in s)) {s[k FS $5]; n[k]++}} \
#     END{for (k in n) if (n[k] > 1) print k}' docs/metrics/member-outcomes.tsv
#
# Rows by model:
#   awk -F'\t' '!/^#/ {n[$5]++} END{for (k in n) print n[k], k}' docs/metrics/member-outcomes.tsv
#
# session	run_date	role	member	model	effort	ticket	pr	tokens_cache_create	tokens_out	wall_s	turns	errored
EOF
```

- [ ] **Step 6: Commit**

```bash
git add skills/fleet/scripts/member-outcomes.mjs skills/fleet/scripts/member-outcomes.test.mjs docs/metrics/member-outcomes.tsv
git commit -m "feat(member-outcomes): CLI over one session dir, header preserved across rewrites (#N)"
```

---

### Task 8: Pin the header against the code

**Files:**
- Create: `skills/fleet/scripts/member-outcomes-header.test.mjs`

**Interfaces:**
- Consumes: `COLUMNS`
- Produces: nothing

#472 is open because `tier-outcomes.tsv`'s header has no test tying it to the
guard text it describes. Do not ship a second unpinned metrics header.

- [ ] **Step 1: Write the failing test**

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COLUMNS } from "./member-outcomes.mjs";

const REPO = join(import.meta.dirname, "..", "..", "..");
const TSV = readFileSync(join(REPO, "docs", "metrics", "member-outcomes.tsv"), "utf8");
const header = TSV.split("\n").filter((l) => l.startsWith("#"));

test("the header's column line matches COLUMNS exactly, in order", () => {
  // Drift here is silent and total: every awk one-liner in the header indexes
  // by position, so a column inserted in the code shifts $5 for every reader.
  const line = header.find((l) => l.includes("run_date"));
  assert.ok(line, "header has no column line");
  assert.deepEqual(line.replace(/^#\s*/, "").split("\t"), COLUMNS);
});

test("the header states the blank, hand-edit, and superseded-generation rules", () => {
  // All three are load-bearing and none is enforceable in code, so prose is the
  // only carrier — which is what makes them worth pinning. The third is the one
  // most likely to be dropped as noise by a future editor, and dropping it is
  // how an older, dearer generation gets read as a cheap tier.
  assert.match(TSV, /BLANK MEANS UNKNOWN/);
  assert.match(TSV, /NEVER hand-edit a row/);
  assert.match(TSV, /SUPERSEDED GENERATIONS ARE A SEPARATE POPULATION/);
});

test("the header's pair query names the columns it actually indexes", () => {
  // $1 is session and $3 is role and $5 is model. If COLUMNS changes, this
  // query silently groups on the wrong fields.
  assert.equal(COLUMNS[0], "session");
  assert.equal(COLUMNS[2], "role");
  assert.equal(COLUMNS[4], "model");
});
```

- [ ] **Step 2: Run test to verify it fails**

Temporarily reorder two entries in `COLUMNS`, run the test, confirm it goes red,
then revert. A pin that cannot fail is worse than no pin — a positive regex over
a whole section passes vacuously, and slice size is what does the anchoring.

Run: `node --test skills/fleet/scripts/member-outcomes-header.test.mjs`
Expected: FAIL while reordered, PASS after revert

- [ ] **Step 3: Commit**

```bash
git add skills/fleet/scripts/member-outcomes-header.test.mjs
git commit -m "test(member-outcomes): pin the tsv header against COLUMNS and its own rules (#N)"
```

---

### Task 9: Backfill the 154 member-dispatching sessions on disk

**Files:**
- Modify: `docs/metrics/member-outcomes.tsv` (data only)

**Interfaces:**
- Consumes: the CLI from Task 7
- Produces: a populated metrics file

There is no backfill code. Backfill is the Task 7 CLI in a shell loop — which is
why nothing here needs deleting afterwards.

- [ ] **Step 1: Run the loop**

```bash
ls -d ~/.claude/projects/*/*/ | while read -r d; do
  node skills/fleet/scripts/member-outcomes.mjs "$d" || echo "skipped $d" >&2
done
```

- [ ] **Step 2: Sanity-check the result against the spec's measurements**

```bash
grep -vc '^#' docs/metrics/member-outcomes.tsv
awk -F'\t' '!/^#/ {n[$3]++} END{for (k in n) print n[k], k}' docs/metrics/member-outcomes.tsv | sort -rn
awk -F'\t' '!/^#/ {n[$5]++} END{for (k in n) print n[k], k}' docs/metrics/member-outcomes.tsv | sort -rn
awk -F'\t' '!/^#/ {n[$6]++} END{for (k in n) print n[k], (k==""?"(blank)":k)}' docs/metrics/member-outcomes.tsv | sort -rn
```

Expected, measured at `c82c5a5` — treat a large divergence as a bug in the
scraper, not as news:
- ~2,100 rows (2,102 members had both model and effort recoverable; rows with no
  usable model are dropped)
- roles ranked: specialist ~1416, reviewer ~376, finisher ~289, merge-bot ~255,
  implementer ~255
- models: `claude-opus-5` ~1802, `claude-haiku-4-5-20251001` ~567,
  `claude-sonnet-5` ~262, plus ~23 `claude-opus-4-8` and ~16 `claude-opus-4-7`.
  **Those last two are superseded generations and are a separate population** —
  never pool them into an "opus" bucket and never read them as a cheap tier.
  Pricing falls with each generation, so an older Opus is not cheaper than the
  current one and an older Sonnet is dearer than the current one. Pooling
  inverts the very cost ordering this file exists to measure.
- effort: `xhigh` ~2039, `high` ~67, remainder blank

**These counts will not match exactly and are not supposed to.** They were taken
on 2026-08-27 and every session run since adds rows. A divergence of tens is
drift; a divergence of hundreds, or a role missing entirely, is a defect.

- [ ] **Step 3: Confirm the effort question is NOT answerable, in writing**

```bash
awk -F'\t' '!/^#/ && $3=="implementer" {n[$6]++} END{for (k in n) print n[k], (k==""?"(blank)":k)}' \
  docs/metrics/member-outcomes.tsv
```

If this shows one effort value dominating, that is the expected result and the
spec says so: the back catalogue can rank models and **cannot** answer the effort
question. Do not draw an effort conclusion from it. Record the counts in the
commit message so a later reader sees why.

- [ ] **Step 4: Commit**

```bash
git add docs/metrics/member-outcomes.tsv
git commit -m "chore(member-outcomes): backfill from every session on disk (#N)

Rows by role and model recorded at backfill time; effort is near-constant
across the back catalogue, so these rows can rank models and cannot answer
the effort question. See the spec's 'What backfill can and cannot buy'."
```

---

### Task 10: Wire the scraper into phase 3

**Files:**
- Modify: `skills/fleet/skills/run-team/SKILL.md` (phase 3, the ruling step that
  appends to `tier-outcomes.tsv`)
- Test: `skills/fleet/scripts/member-outcomes-prose.test.mjs`

**Interfaces:**
- Consumes: the CLI from Task 7
- Produces: a controller instruction

- [ ] **Step 1: Find the append instruction**

```bash
grep -n "Append one row" skills/fleet/skills/run-team/SKILL.md
```

It is near `SKILL.md:494`. Read the surrounding paragraph before editing.

- [ ] **Step 2: Write the failing prose pin**

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..", "..", "..");
const RUN_TEAM = readFileSync(join(REPO, "skills", "fleet", "skills", "run-team", "SKILL.md"), "utf8");

// Slice by named anchors and fail loudly when one moves; slice SIZE is what does
// the work. Widen this to the whole phase and a neighbouring paragraph satisfies
// the pin on its own.
function section(start, end) {
  const a = RUN_TEAM.indexOf(start);
  assert.notEqual(a, -1, `anchor moved: ${start}`);
  const b = RUN_TEAM.indexOf(end, a + start.length);
  assert.notEqual(b, -1, `anchor moved: ${end}`);
  return RUN_TEAM.slice(a, b);
}

test("the ruling step runs the scraper and says the run is what scopes it", () => {
  const slice = section("Append one row", "## ");
  assert.match(slice, /member-outcomes\.mjs/);
  assert.match(slice, /session director(y|ies)/i);
});

test("the ruling step does NOT ask the controller to hand-write member rows", () => {
  // The whole invariant: member-outcomes.tsv is derived. An instruction to
  // author a row there would make it un-regenerable.
  const slice = section("Append one row", "## ");
  assert.doesNotMatch(slice, /append .{0,40}member-outcomes/i);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test skills/fleet/scripts/member-outcomes-prose.test.mjs`
Expected: FAIL — no `member-outcomes.mjs` in the slice

- [ ] **Step 4: Add the instruction to SKILL.md**

Insert immediately after the existing `tier-outcomes.tsv` append instruction:

```markdown
**Then record the run's member facts — do not author them.** Run
`node skills/fleet/scripts/member-outcomes.mjs "$SESSION_DIR"` once, where
`$SESSION_DIR` is this session's directory under `~/.claude/projects/`. It
derives every row from the subagent transcripts the harness already wrote, so a
second run over the same session changes nothing and a re-run after a member is
re-dispatched picks the new transcript up. **Never hand-edit
`docs/metrics/member-outcomes.tsv`** — it is regenerated wholesale whenever the
role classifier changes, and a hand-entered value would not survive that. The
verdict for a PR still goes to `tier-outcomes.tsv`, by hand, as before.
```

- [ ] **Step 5: Run test to verify it passes, then mutation-test it**

Run: `node --test skills/fleet/scripts/member-outcomes-prose.test.mjs`
Expected: PASS

Then delete the sentence naming `member-outcomes.mjs`, re-run, and confirm the
test goes RED. Restore it. A prose pin that stays green when its subject is
removed is pinning nothing.

- [ ] **Step 6: Run the whole fleet suite**

Run: `node --test skills/fleet/scripts/`
Expected: PASS. If `implementer-model-tier.test.mjs` fails, you changed the
phase-2 slice it anchors on — that is Part 2's territory, not this plan's.

- [ ] **Step 7: Commit**

```bash
git add skills/fleet/skills/run-team/SKILL.md skills/fleet/scripts/member-outcomes-prose.test.mjs
git commit -m "feat(run-team): phase 3 runs the member-outcomes scraper after ruling (#N)"
```

---

## Done when

- `node --test skills/fleet/scripts/` passes.
- `docs/metrics/member-outcomes.tsv` holds ~2,100 backfilled rows.
- Re-running the scraper over any session produces a zero-line diff.
- Nothing in the repo asks a human to write a row into `member-outcomes.tsv`.

Part 2 (`...-plan-2-tiering.md`) declares per-role tiers and introduces the
within-run pairing. It depends on nothing here except that rows are being
recorded, so it can be scheduled independently.
