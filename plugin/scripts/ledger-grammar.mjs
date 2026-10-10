// The run ledger's grammar: its sections on disk, a row's Exclusion and its
// PR, and its members. A member's token is `<member>` while it is live and
// `<member>=<outcome>` once settled. `ledger.mjs dispatch` writes the bare
// token and `ledger.mjs settle` rewrites it, so a reader derives every
// liveness count from the ledger file alone instead of from the controller's
// memory of what it dispatched.
//
// A module of its own, not a function inside ledger.mjs, because ledger.mjs is
// a CLI that parses argv and exits on import — and `fleet-tick.mjs`,
// `compute-board.mjs` and `shortlist.mjs` read this same grammar. A second
// copy of it in any of them would be two readings of one row, free to drift
// apart.
//
// Rows stay freeform text. Only a token whose name part is a member name is
// claimed as a member here; everything else a row carries (`class=routine`,
// `ports=`, `ci=`, `held-behind:#M`, `conflict-hold:#<pr>`, the
// `review=`/`reviewed=` pair, the `→ PR#M` arrow) is not a member. The
// review pair has a grammar of its own below, REVIEW and REVIEWED, which
// `ledger.mjs row` checks a write against before it lands.

import { createHash } from "node:crypto";

// The outcome vocabulary, verbatim from the spec. A word is matched exactly,
// except the three that carry a value, which match OUTCOME_PATTERNS below.
const FAMILIES = {
  impl: { label: "impl-N", bound: "ticket", outcomes: ["PR#M", "bailed", "released", "killed", "tier-mismatch"] },
  "fix-pr": { label: "fix-pr-M", bound: "pr", outcomes: ["applied:<head>", "no-op", "failed", "killed"] },
  "finisher-pr": { label: "finisher-pr-M", bound: "pr", outcomes: ["labelled", "failed", "killed", "halted:<cause>"] },
  "merge-bot": { label: "merge-bot-n", bound: null, outcomes: ["done", "killed"] },
};
// Every family parseMember can yield: MEMBER below is built from this list,
// so every family it matches has an entry here by construction.
export const MEMBER_FAMILIES = Object.freeze(Object.keys(FAMILIES));
// A finisher halt's causes: the finisher worked correctly and refused
// to label, which `failed` (it crashed or gave up) does not say. `unreadable`,
// `missing` and `absent` are duty 1's audit-read halts.
export const HALT_CAUSES = ["live-editor", "rebase", "past-pin", "unreadable", "missing", "absent", "other"];
const OUTCOME_PATTERNS = {
  "PR#M": /^PR#[1-9][0-9]*$/,
  "applied:<head>": /^applied:[0-9a-f]{7,40}$/i,
  "halted:<cause>": new RegExp(`^halted:(?:${HALT_CAUSES.join("|")})$`),
};

// A number with no leading zero, so `impl-0412` cannot be a second name for
// `impl-412`. A single trailing lowercase letter is a replacement's retry
// suffix (`impl-<N>-b` — member-record.mjs has -b, -c and -d observed);
// merge bots take none, because a replacement for a dead bot gets a new n.
// Attempts on one number order by it: no suffix first, then by letter.
const MEMBER = new RegExp(`^(${MEMBER_FAMILIES.join("|")})-([1-9][0-9]*)(-[a-z])?$`);

/** `{name, family, number, retry, bound}` for a member name, else null.
 * `retry` is the suffix letter (`"b"` for `impl-412-b`), null for none.
 * `bound` is "ticket", "pr", or null for a merge bot, which works neither. */
export function parseMember(name) {
  const m = MEMBER.exec(name);
  if (!m || (m[1] === "merge-bot" && m[3])) return null;
  return { name, family: m[1], number: Number(m[2]), retry: m[3] ? m[3].slice(1) : null, bound: FAMILIES[m[1]].bound };
}

/**
 * One whitespace-delimited token: null when it is not a member token at all,
 * otherwise the member plus `outcome` (null while live) and `error` (null
 * unless the outcome is outside its family's vocabulary). A malformed outcome
 * is reported rather than dropped, so a reader can refuse the row instead of
 * counting the member live or gone on a guess.
 */
export function parseToken(token) {
  const eq = token.indexOf("=");
  const member = parseMember(eq === -1 ? token : token.slice(0, eq));
  if (!member) return null;
  if (eq === -1) return { ...member, outcome: null, error: null };
  const outcome = token.slice(eq + 1);
  const f = FAMILIES[member.family];
  const ok = f.outcomes.some((o) => (OUTCOME_PATTERNS[o] ? OUTCOME_PATTERNS[o].test(outcome) : o === outcome));
  return {
    ...member,
    outcome,
    error: ok ? null : `'${outcome}' is not an outcome of ${f.label} — expected ${f.outcomes.join(" | ")}`,
  };
}

/** Every member token in a row's text, in order. */
export function memberTokens(text) {
  return text.split(/\s+/).filter(Boolean).map(parseToken).filter(Boolean);
}

// `PR#<n>` as a word of a row's text, `PR #<n>` too.
const PR_MENTION = /\bPR\s*#(\d+)\b/;

/**
 * The PR a row's text is about, or null when it names none of its own — the
 * one reading of it every ledger reader keys PR state by. A row carrying an
 * `impl-` token, live, settled or malformed, is its first well-formed settled
 * `impl-<N>=PR#<M>` token's PR in row order, and no PR while it has none: a
 * `PR#` mention in its prose, an `→ PR#M` arrow included, never decides it,
 * wherever it sits. A row with no `impl-` token is its first `PR#<n>`
 * mention's. Falling back to the row's `#<n>` key is each caller's own.
 */
export function rowPr(text) {
  const impls = memberTokens(text).filter((t) => t.family === "impl");
  if (impls.length > 0) {
    const settled = impls.find((t) => t.error === null && t.outcome?.startsWith("PR#"));
    return settled ? Number(settled.outcome.slice("PR#".length)) : null;
  }
  const m = PR_MENTION.exec(text);
  return m ? Number(m[1]) : null;
}

// A row's key number and its PR: the PR every PR-bound token on the row
// speaks for. That PR is rowPr() above: on a row carrying an `impl-` token,
// its settled `impl-<N>=PR#<n>` token's PR, never a prose `PR#` mention; on
// any other row, its first `PR#<n>` mention. A row with none is keyed by the
// PR's own number when it is about a PR at all (a PR this run's implementers
// did not open) — ledger.mjs's memberRowIndex() fallback specifically, which
// gates on the member being PR-bound before it ever reaches this fallback.
// fleet-tick.mjs's deriveRun applies the same row-key fallback to every row's
// own bookkeeping unconditionally, signal or not; only memberRowIndex()'s
// caller already knows it holds a PR-bound member. Ticket and PR numbers share
// GitHub's one number space, so a ticket's key never names an open PR.
export function rowNums(text) {
  const key = text.split(/\s/)[0];
  const keyNum = /^#[0-9]+$/.test(key) ? Number(key.slice(1)) : null;
  return { keyNum, pr: rowPr(text) ?? keyNum };
}

// A PR's review is not a member, so it carries its own pair of row tokens.
// The launch is `review=wf:<runId>` | `review=member:<name>` |
// `review=fallback:<name>`, settled dead as `…=failed`; the capture groups are
// the kind, the runId or runner name, and the `=failed` suffix, so the
// launch's identity — kind and runId or name, `=failed` aside — comes out of
// this one regex. The first runner on PR <n> is `review-pr-<n>`, every later
// one the next letter the PR's rows do not carry yet (`-b`, `-c`, …). The
// result is `reviewed=<head>:<survived>/<refuted>/<unverified>:<run>`, `<run>`
// the name of the review's own run root under `<scratch>/pr<n>/` (`run-` and
// the eight characters `mktemp` chose), where its result file `review.json`
// sits.
export const REVIEW = /^review=(wf|member|fallback):([^=\s]+?)(=failed)?$/;
export const REVIEWED = /^reviewed=([0-9a-fA-F]{7,40}):(\d+)\/(\d+)\/(\d+):(run-[A-Za-z0-9]{8})$/;

// Every PR's token stream: every row that maps to it under rowNums(), in
// ledger row order, its tokens run end to end — the order fleet-tick.mjs's
// fold reads a PR's review record in. A row naming no PR and keyed by no
// number is a stream of its own, under its key.
function streams(rows) {
  const out = new Map();
  for (const text of rows) {
    const id = rowNums(text).pr ?? text.split(/\s/)[0];
    if (!out.has(id)) out.set(id, []);
    out.get(id).push(...text.split(/\s+/).filter(Boolean));
  }
  return out;
}

// One stream's review record, read in order. A `reviewed=` answers the
// nearest earlier launch that is neither answered yet nor settled `=failed`;
// one with no such launch is `unpaired`. A launch is open while unanswered
// and not failed: `crowded` holds each launch that appeared while an earlier
// one was open, with that open one; `repeated` each launch whose identity an
// earlier launch already took. A token outside REVIEW/REVIEWED is
// `unparseable` and plays no part in the pairing.
function readReviews(tokens) {
  const launches = [];
  const out = { unpaired: [], repeated: [], crowded: [], unparseable: [] };
  for (const tok of tokens) {
    if (tok.startsWith("review=")) {
      const m = REVIEW.exec(tok);
      if (!m) {
        out.unparseable.push(tok);
        continue;
      }
      const launch = { id: `review=${m[1]}:${m[2]}`, kind: m[1], name: m[2], failed: m[3] !== undefined, answered: false };
      if (launches.some((l) => l.id === launch.id)) out.repeated.push(launch.id);
      const open = launches.find((l) => !l.failed && !l.answered);
      if (open) out.crowded.push({ id: launch.id, open: open.id });
      launches.push(launch);
    } else if (tok.startsWith("reviewed=")) {
      if (!REVIEWED.test(tok)) {
        out.unparseable.push(tok);
        continue;
      }
      const answers = launches.findLast((l) => !l.failed && !l.answered);
      if (answers) answers.answered = true;
      else out.unpaired.push(tok);
    }
  }
  out.launches = launches;
  out.open = launches.filter((l) => !l.failed && !l.answered).map((l) => l.id);
  return out;
}

// The entries of `after` that `before` does not account for, counting
// duplicates: what a write added.
function added(before, after) {
  const left = new Map();
  for (const x of before) left.set(x, (left.get(x) ?? 0) + 1);
  return after.filter((x) => {
    const n = left.get(x) ?? 0;
    if (n === 0) return true;
    left.set(x, n - 1);
    return false;
  });
}

// The runner name a new launch on PR <pr> takes: `review-pr-<pr>`, else the
// first letter from `b` its rows carry on no runner launch. null for a stream
// keyed by no PR number, or with every letter taken.
function nextReviewer(launches, pr) {
  if (typeof pr !== "number") return null;
  const used = new Set(launches.filter((l) => l.kind !== "wf").map((l) => l.name));
  const base = `review-pr-${pr}`;
  if (!used.has(base)) return base;
  for (let c = "b".charCodeAt(0); c <= "z".charCodeAt(0); c++) {
    const name = `${base}-${String.fromCharCode(c)}`;
    if (!used.has(name)) return name;
  }
  return null;
}

const OPEN_WAYS_OUT = "wait for its reviewed=, or, once Member-killed confirms its runner dead, settle it =failed in the same rewrite as the new launch";

/**
 * Why `ledger.mjs row` must not write `line` over `oldLine` (null for a new
 * row), `before` and `after` the ledger's rows on either side of the write —
 * or null when it may. Only a violation the write ADDS is a reason: each
 * rule's offending entries are listed before the write and after it, and the
 * after list must hold nothing the before list lacks, duplicates counted. Where
 * an entry sits plays no part, since `row` rewrites the whole line, so a bad
 * token already on the ledger and carried forward or moved never blocks a
 * write. Entries are token texts, except a launch's, which is its identity
 * with `=failed` aside, so settling a launch in place adds nothing. The rules:
 * - unique members: a member name appears at most once on the line, whatever
 *   its outcome;
 * - unparseable review tokens: a `review=`/`reviewed=` matches REVIEW/REVIEWED;
 * - paired results: every `reviewed=` answers a launch (readReviews above);
 * - unique launches: a launch identity appears at most once in its PR's stream;
 * - one open launch per PR: no launch appears while an earlier one is open;
 * - an open launch is never removed: every launch open before the write is in
 *   its PR's stream after it, `=failed` allowed, on any of the PR's rows.
 */
export function rowWriteRefusal(before, after, oldLine, line) {
  const names = (text) => (text === null ? [] : memberTokens(text).map((t) => t.name));
  const dupes = (list) => list.filter((n, i) => list.indexOf(n) !== i);
  const member = added(dupes(names(oldLine)), dupes(names(line)))[0];
  if (member !== undefined) {
    return `member '${member}' appears more than once on this line — unique members: one token per member, live or settled`;
  }
  const was = streams(before);
  const now = streams(after);
  const where = (id) => (typeof id === "number" ? `PR #${id}` : `row ${id}`);
  const read = (map, id) => readReviews(map.get(id) ?? []);
  for (const [id, tokens] of now) {
    const a = readReviews(tokens);
    const b = read(was, id);
    const bad = added(b.unparseable, a.unparseable)[0];
    if (bad !== undefined) {
      return `'${bad}' on ${where(id)} is not review=wf:<runId> | member:<name> | fallback:<name> (optionally =failed) `
        + "or reviewed=<head>:<survived>/<refuted>/<unverified>:<run> — unparseable review token";
    }
    const unpaired = added(b.unpaired, a.unpaired)[0];
    if (unpaired !== undefined) {
      return `'${unpaired}' on ${where(id)} answers no open launch — paired results: every reviewed= follows a review= `
        + "launch that no earlier reviewed= answered and that is not settled =failed; write a reviewed= only off a review result file";
    }
    const repeated = added(b.repeated, a.repeated)[0];
    if (repeated !== undefined) {
      const next = nextReviewer(a.launches, id);
      return `launch '${repeated}' is already on ${where(id)}'s rows — unique launches: every launch takes an identity the PR has not used`
        + (next === null ? "" : `; the next free reviewer name is ${next}`);
    }
    const crowded = added(b.crowded.map((c) => c.id), a.crowded.map((c) => c.id))[0];
    if (crowded !== undefined) {
      const { open } = a.crowded.find((c) => c.id === crowded);
      return `launch '${crowded}' on ${where(id)} while launch '${open}' is open — one open launch per PR: ${OPEN_WAYS_OUT}`;
    }
  }
  for (const [id, tokens] of was) {
    const kept = new Set(read(now, id).launches.map((l) => l.id));
    const dropped = readReviews(tokens).open.find((l) => !kept.has(l));
    if (dropped !== undefined) {
      return `this write removes open launch '${dropped}' from ${where(id)}'s rows — an open launch is never removed, `
        + `only settled =failed where it stands: ${OPEN_WAYS_OUT}`;
    }
  }
  return null;
}

// A ticket row is `#N <text>`; it is an Exclusion when `excluded` is the
// text's first word — `impl-N · … excluded …` is a row about something else.
// `#N excluded · behind-pr:#M` / `behind-issue:#M`: `#M` is an issue or PR
// number, or the branch name recorded before that PR existed.
const EXCLUDED_ROW = /^#[0-9]+[ \t]+excluded(?=[ \t]|$)([\s\S]*)$/;
const PREMISE = /\bbehind-(pr|issue):#?([^\s,;]+)/g;

/** The `{kind, target}` premises an Exclusion row names, in row order and
 * possibly none, or null for any other row. */
export function premisesOf(row) {
  const m = EXCLUDED_ROW.exec(row);
  if (!m) return null;
  return [...m[1].matchAll(PREMISE)].map(([, kind, target]) => ({ kind, target }));
}

export const ROWS = "## Rows";
export const DISPATCHED = "## Dispatched";
export const FILED = "## Filed";
export const RULED = "## Ruled";
export const DRAIN = "## Drain";

// What a section header looks like on disk, defined once because a second
// copy drifts: ledger.mjs slices sections with it, and sets its readability
// flag from it. Anchored to a real line start (or string start), not
// a bare substring search — otherwise an escaped entry that merely CONTAINS
// the text "## Filed" (never a physical line, just a run of characters inside
// a one-line entry) is found by indexOf() before the genuine header and the
// whole section is sliced from the wrong offset.
export const headerRe = (name) => new RegExp(`(^|\\n)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\n|$)`);

// One entry is always exactly one physical line on disk. Escape backslash
// first, then newline, so a `\` in entry text can never be mistaken for the
// start of an escape sequence introduced by this encoding. Without this, an
// entry containing a real newline — or a line that happens to look like
// `## Filed` or `- #<issue> ...` — gets misparsed on reload: real records
// silently drop, or phantom ones get injected.
export function escapeText(s) {
  return s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}
export function unescapeText(s) {
  return s.replace(/\\(\\|n)/g, (_, c) => (c === "n" ? "\n" : "\\"));
}

/** The name the next merge bot takes: 1 + the `merge-bot-` entries in
 * `## Dispatched`, settled ones included. One ledger per run, so n restarts
 * at 1 with every run. */
export function nextMergeBot(dispatched) {
  return `merge-bot-${dispatched.map(parseToken).filter((t) => t?.family === "merge-bot").length + 1}`;
}

// An implementer cell is `<role>-<level>` — an omp role and a thinking
// level — and each cell is one definition, `fleet-implementer-<cell>`, whose
// `model:` is `@<role>:<level>`. Nothing is named
// `fleet-implementer` alone, so CELL_DEF is the whole implementer family:
// derived from CELL rather than spelled twice, so a level added to one cannot
// be missing from the other.
export const CELL = /^(slow|task|smol)-(minimal|low|medium|high|xhigh|max)$/;
export const CELL_DEF = new RegExp(`^fleet-implementer-${CELL.source.slice(1)}`);

// The cell a row with no `tier=` runs at: `policy_cell`, `slow-high` on every
// Pull until the router's table picks one per stratum. Exported so
// ticket-router.mjs defaults to the same cell this file maps a bare row to.
export const POLICY_CELL = "slow-high";

// The Exploration Pull's draw: uniform over every cell but
// `policyCell`, keyed off the row's own `session` and `ticket`, so the draw
// is reproducible from the row and a re-dispatch of the same ticket in the
// same session lands on the same cell. No RNG and no seed token. `k` is the
// 1-based index into the sorted remainder, `K` its size; with every
// non-default cell withdrawn (`K === 0`) the Pull runs at `policyCell` and
// `k`/`K` are 0 — the caller writes no draw column then, and there is no
// `% 0` to take.
/** @returns {{cell: string|null, k: number, K: number}} */
export function drawCell({ session, ticket, policyCell, cells }) {
  const E = cells.filter((c) => c !== policyCell).sort();
  const K = E.length;
  if (K === 0) return { cell: policyCell, k: 0, K: 0 };
  const k = 1 + (parseInt(createHash("sha256").update(`${session}\t${ticket}`).digest("hex").slice(0, 8), 16) % K);
  return { cell: E[k - 1], k, K };
}

// The definition an implementer should run under, off its ticket
// row's `tier=` token — none means `fleet-implementer-<POLICY_CELL>`,
// `tier=<x>` means `fleet-implementer-<x>`. The value becomes a file
// name under `agents/`, so it is held to `[a-z0-9]` words joined by `-`
// rather than joined into a path as written, and two different `tier=`
// values on one row name no single definition — refused, never resolved by
// position. A value with no definition behind it (the retired `tier=alt`) is
// `ledger.mjs dispatch`'s to refuse: it checks the file exists.
//
// Here, not in tier-check.mjs, because two readers must agree on it:
// `ledger.mjs dispatch` prints the definition before the call, and
// tier-check.mjs judges the member against it after. Two copies could name
// different definitions for one row and fail a dispatch made exactly as
// printed.
const TIER_SUFFIX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Every `tier=` value a row's text carries, in order, duplicates kept. */
export function tierValues(rowText) {
  return String(rowText ?? "").split(/\s+/).filter((t) => t.startsWith("tier=")).map((t) => t.slice("tier=".length));
}

export function expectedDefinition(rowText) {
  const values = [...new Set(tierValues(rowText))];
  if (values.length === 0) return `fleet-implementer-${POLICY_CELL}`;
  if (values.length > 1) throw new Error(`row carries conflicting tier= tokens (${values.map((v) => `tier=${v}`).join(", ")}) — fix the row with \`ledger.mjs row\``);
  if (!TIER_SUFFIX.test(values[0])) throw new Error(`tier=${values[0]} is not a definition suffix — expected [a-z0-9] words joined by '-' — fix the row with \`ledger.mjs row\``);
  return `fleet-implementer-${values[0]}`;
}

// The agent definition a member is dispatched as, for a parsed member
// and the text of the row it works: `ledger.mjs dispatch` prints it so the
// `task` call that follows names it off a script's output, not off prose a
// compaction drops. A fix-applier on an unresolved conflict hold of its own PR
// is a `fleet-implementer-<POLICY_CELL>` whatever the row's `tier=` —
// it rebases the PR, it does not work a ticket at a tier. Any other fix-applier is a review
// one and gets null: a generic `task` by design. Whether the hold is
// unresolved is `conflictHeld`, the caller's to supply from fleet-tick.mjs's
// deriveRun() — the reading the tick holds the merge on, which folds every
// row of the PR, never one row's text alone. Throws whatever
// expectedDefinition throws, and throws on a family this switch has no case
// for: null is the review fix-applier's deliberate answer, so a
// `default: return null` would print a new family as a generic `task`
// without anyone having decided it is one.
/** @returns {string|null} the definition name; null only for a review fix-applier. */
export function agentDefinition(member, rowText, conflictHeld = false) {
  switch (member.family) {
    case "impl": return expectedDefinition(rowText);
    case "fix-pr": return conflictHeld ? `fleet-implementer-${POLICY_CELL}` : null;
    case "finisher-pr": return "fleet-finisher";
    case "merge-bot": return "fleet-merge-bot";
    default: throw new Error(`agentDefinition has no case for member family '${member.family}' (${member.name}) — add one to ledger-grammar.mjs`);
  }
}
