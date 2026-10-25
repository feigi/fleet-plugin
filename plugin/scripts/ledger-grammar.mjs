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
// `ledger.mjs review` writes and `ledger.mjs row` checks a write against
// before it lands.

import { createHash } from "node:crypto";

// How an archive beside the ledger is named. `ledger.mjs rotate` files the
// ledger as `ledger.<stamp>.md`, the two run receipts, the phase-0 one as
// `phase0.<stamp>.json` and the end-of-run one as `closeout.<stamp>.json`,
// and the briefs directory as `briefs.<stamp>`, all under one stamp.
// `phase0.mjs` files a phase-0 receipt the rotation left behind the same
// way, so the format lives here once.
const RECEIPT_STEM = "phase0";
export const RECEIPT = `${RECEIPT_STEM}.json`;
// Where a previous run's receipt waits, beside the ledger, until the next run's
// rotation files it: `phase0.mjs` holds a receipt there at startup, and
// `closeout.mjs finish` sets the run's own there, so a run that ended cleanly
// leaves no receipt for the next run to resume.
export const RECEIPT_HELD = `${RECEIPT_STEM}.previous.json`;
export const archiveStamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replaceAll(":", "");
export const receiptArchiveName = (stamp) => `${RECEIPT_STEM}.${stamp}.json`;
const CLOSEOUT_STEM = "closeout";
export const CLOSEOUT_RECEIPT = `${CLOSEOUT_STEM}.json`;
export const closeoutArchiveName = (stamp) => `${CLOSEOUT_STEM}.${stamp}.json`;
// The directory dispatch-prompt.mjs renders a member's brief into, beside the
// ledger, archived by the same rotate under the same stamp: `briefs.<stamp>`.
export const BRIEFS = "briefs";
export const briefsArchiveName = (stamp) => `${BRIEFS}.${stamp}`;

// The outcome vocabulary, verbatim from the spec. A word is matched exactly,
// except the three that carry a value, which match OUTCOME_PATTERNS below.
// `role` is the dispatch-prompt.mjs template a member of the family is
// rendered from, the one its brief's sidecar must name.
const FAMILIES = {
  impl: { label: "impl-N", bound: "ticket", role: "implementer", outcomes: ["PR#M", "bailed", "released", "killed", "tier-mismatch", "blocked"] },
  "fix-pr": { label: "fix-pr-M", bound: "pr", role: "fix-applier", outcomes: ["applied:<head>", "no-op", "failed", "killed"] },
  "finisher-pr": { label: "finisher-pr-M", bound: "pr", role: "finisher", outcomes: ["labelled", "failed", "killed", "halted:<cause>"] },
  "merge-bot": { label: "merge-bot-n", bound: null, role: "merge-bot", outcomes: ["done", "killed"] },
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

/** The dispatch-prompt.mjs role a member of `family` is rendered as. */
export function memberRole(family) {
  return FAMILIES[family].role;
}

// A `## Dispatched` entry is a member token, followed by `brief=<hash>` when
// `ledger.mjs dispatch` recorded the brief the member was dispatched with:
// the first 8 hex of the sha256 the brief's sidecar carries. A merge bot's
// entry then carries `queued=<pr>,<pr>…` — `queued=none` for an empty queue —
// the open `ready-to-merge` PRs `dispatch` read when it dispatched the bot,
// which its report is judged against at `settle --from-report`. An
// implementer's entry ends with `agent=<definition>`, the definition
// `dispatch` printed for it, which tier-check judges it against. The value
// becomes a file name under `agents/`, so it is held to `[a-z0-9]` words
// joined by `-`, the shape of a `tier=` value. `settle` rewrites the token
// and keeps the words beside it.
const DISPATCHED_ENTRY = /^([^ ]*) brief=([0-9a-f]{8})(?: queued=(none|[1-9][0-9]*(?:,[1-9][0-9]*)*))?(?: agent=([a-z0-9]+(?:-[a-z0-9]+)*))?$/;

/**
 * `{token, brief, queued, agent}` for one `## Dispatched` entry: the member
 * token, the brief's hash or null, the PR numbers of its `queued=` word or
 * null for an entry without one, and the definition of its `agent=` word or
 * null for an entry without one. An entry that is not a member token plus a
 * well-formed `brief=` word, optionally followed by a well-formed `queued=`
 * word and a well-formed `agent=` word, is returned whole as `token`, so a
 * reader parsing it with parseToken() refuses it exactly as it refuses any
 * other entry this grammar cannot parse.
 */
export function parseDispatchedEntry(entry) {
  const m = DISPATCHED_ENTRY.exec(entry);
  if (m === null || parseToken(m[1]) === null) return { token: entry, brief: null, queued: null, agent: null };
  const queued = m[3] === undefined ? null : m[3] === "none" ? [] : m[3].split(",").map(Number);
  return { token: m[1], brief: m[2], queued, agent: m[4] ?? null };
}

/**
 * The `## Dispatched` entry for `token`, with `brief=<brief>` unless brief is
 * null and, after it, `queued=…` unless queued is null and `agent=<agent>`
 * unless agent is null.
 */
export function dispatchedEntry(token, brief, queued = null, agent = null) {
  if (brief === null) return token;
  let entry = `${token} brief=${brief}`;
  if (queued !== null) entry += ` queued=${queued.join(",") || "none"}`;
  if (agent !== null) entry += ` agent=${agent}`;
  return entry;
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
// The launch is `review=wf:<runId>` | `review=member:<name>`, settled dead as
// `…=failed`; the capture groups are the kind, the runId or runner name, and
// the `=failed` suffix. A launch's identity comes out of this one regex,
// `=failed` aside: a workflow's is its runId, a runner's is its name, the one
// hub member of that name. The first runner on PR <n> is `review-pr-<n>`,
// every later one the next letter the PR's rows do not carry yet (`-b`, `-c`,
// …). The
// result is `reviewed=<head>:<survived>/<refuted>/<unverified>:<run>`, `<run>`
// the name of the review's own run root under `<scratch>/pr<n>/` (`run-` and
// the eight characters `mktemp` chose), where its result file `review.json`
// sits.
export const REVIEW = /^review=(?<kind>wf|member):(?<name>[^=\s]+)(?<failed>=failed)?$/;
export const REVIEWED = /^reviewed=([0-9a-fA-F]{7,40}):(\d+)\/(\d+)\/(\d+):(run-[A-Za-z0-9]{8})$/;

// The stream a row belongs to: its PR, else its key.
const streamId = (text) => rowNums(text).pr ?? text.split(/\s/)[0];

// Every PR's token stream: every row that maps to it under rowNums(), in
// ledger row order, its tokens run end to end — the order fleet-tick.mjs's
// fold reads a PR's review record in. A row naming no PR and keyed by no
// number is a stream of its own, under its key.
function streams(rows) {
  const out = new Map();
  for (const text of rows) {
    const id = streamId(text);
    if (!out.has(id)) out.set(id, []);
    out.get(id).push(...text.split(/\s+/).filter(Boolean));
  }
  return out;
}

/** Every token of PR `pr`'s stream, in ledger row order: the tokens firstReview() reads. */
export const prTokens = (rows, pr) => streams(rows).get(pr) ?? [];

// dispositions-check.mjs's verdict on a review fix-applier's disposition
// record: `dispositions-ok=fix-pr-<M>[-x]:<run>`,
// `dispositions-mismatch=…`, `dispositions-escalate=…` (a critical or
// important deferral, or a second mismatch on one review, that a human rules
// on) or `dispositions-unchecked=…` (no rule broke, but where a deferral was
// filed could not be read), `<run>` the run of the review the record
// answers, as its `reviewed=` names it. `ledger.mjs dispatch` refuses a
// finisher on anything but an ok. A
// mismatch returns the PR to fixDue for one retry; an escalate is a hold only
// a human answers, so the tick never re-offers the PR for it; an unchecked is
// answered by running the check again, so the tick never offers a
// fix-applier for it either. A token outside this shape is no verdict at all,
// which the gate reads as unchecked: fail closed.
export function dispositionsToken(tok) {
  const m = /^dispositions-(ok|mismatch|escalate|unchecked)=([^:\s]+):(run-[A-Za-z0-9]{8})$/i.exec(tok);
  if (!m) return null;
  const member = parseMember(m[2]);
  if (member === null || member.family !== "fix-pr") return null;
  return { verdict: m[1].toLowerCase(), member, run: m[3] };
}

/**
 * A PR's first review, read off its `tokens` (prTokens()): walking its
 * `reviewed=` tokens in ledger order, the first that counted no survived and
 * no unverified finding, or that a fix-applier answered — a `dispositions-*`
 * verdict anywhere on the stream names its run. A review with findings no
 * fix-applier answered was superseded, and is skipped; a failed review wrote
 * no `reviewed=`, and is no review. `answered` names runs answered on top of
 * the ledger's: dispositions-check.mjs passes the run of the record it is
 * checking, whose verdict is not written yet. `{head, survived, refuted,
 * unverified, run}`, or null when no review qualifies.
 */
export function firstReview(tokens, answered = []) {
  const runs = new Set(answered);
  for (const tok of tokens) {
    const d = dispositionsToken(tok);
    if (d !== null) runs.add(d.run);
  }
  for (const tok of tokens) {
    const m = REVIEWED.exec(tok);
    if (m === null) continue;
    const review = { head: m[1].toLowerCase(), survived: Number(m[2]), refuted: Number(m[3]), unverified: Number(m[4]), run: m[5] };
    if ((review.survived === 0 && review.unverified === 0) || runs.has(review.run)) return review;
  }
  return null;
}

const isOpen = (launch) => !launch.failed && !launch.answered;

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
      const { kind, name, failed } = m.groups;
      const launch = { id: `review=${kind}:${name}`, kind, name, failed: failed !== undefined, answered: false };
      if (launches.some((l) => l.id === launch.id)) out.repeated.push(launch.id);
      const open = launches.find(isOpen);
      if (open) out.crowded.push({ id: launch.id, open: open.id });
      launches.push(launch);
    } else if (tok.startsWith("reviewed=")) {
      if (!REVIEWED.test(tok)) {
        out.unparseable.push(tok);
        continue;
      }
      const answers = launches.findLast(isOpen);
      if (answers) answers.answered = true;
      else out.unpaired.push(tok);
    }
  }
  out.launches = launches;
  out.open = launches.filter(isOpen).map((l) => l.id);
  return out;
}

// The entries of `after` that `before` does not account for, counting
// duplicates: what a write added.
export function added(before, after) {
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
// first letter from `b` that no runner launch on the PR's rows already uses —
// `=failed` or not — and no name in `retired` holds, the names an earlier run
// of this omp session launched. null for a stream keyed by no PR number, or
// with every letter taken.
function nextReviewer(launches, pr, retired) {
  if (typeof pr !== "number") return null;
  const used = new Set([...launches.filter((l) => l.kind !== "wf").map((l) => l.name), ...retired]);
  const base = `review-pr-${pr}`;
  if (!used.has(base)) return base;
  for (let c = "b".charCodeAt(0); c <= "z".charCodeAt(0); c++) {
    const name = `${base}-${String.fromCharCode(c)}`;
    if (!used.has(name)) return name;
  }
  return null;
}

/** The runner name the next launch on PR `pr` takes, read off a ledger's
 * `rows` and its `## Retired` names: nextReviewer() over the PR's stream.
 * null with every letter taken. */
export function nextReviewerName(rows, pr, retired = []) {
  return nextReviewer(readReviews(streams(rows).get(pr) ?? []).launches, pr, retired);
}

const OPEN_WAYS_OUT = "wait for its reviewed=, or, once Member-killed confirms its runner dead, settle it =failed in the same `ledger.mjs review` call as the new launch";

/** Whether a word of a row is a review token — `review=…` or `reviewed=…`,
 * parseable or not. `ledger.mjs review` writes these and nothing else. */
export const isReviewToken = (word) => word.startsWith("review=") || word.startsWith("reviewed=");

/**
 * The first review token `line` carries that `oldLine` (null for a new row)
 * does not, duplicates counted, else undefined. `ledger.mjs row` writes none
 * of its own — `ledger.mjs review` puts each on the PR's row, in write order —
 * so a review token a row already holds is carried, never re-judged.
 */
export function addedReviewToken(oldLine, line) {
  const words = (text) => (text === null ? [] : text.split(/\s+/).filter(isReviewToken));
  return added(words(oldLine), words(line))[0];
}

// Every row key a ledger's rows map to each PR number under rowNums(), in
// ledger order.
function prRowKeys(rows) {
  const out = new Map();
  for (const text of rows) {
    const { pr } = rowNums(text);
    if (pr === null) continue;
    if (!out.has(pr)) out.set(pr, []);
    out.get(pr).push(text.split(/\s/)[0]);
  }
  return out;
}

/**
 * `{pr, row}` for the first PR that maps to more than one row in `after` and
 * did not in `before` — `row` the key of the PR's row as `before` holds it,
 * else (`before` held no row for that PR) the first key `after` maps it to —
 * else null. Added only: a split already on the ledger never blocks a write.
 */
export function newSplitRow(before, after) {
  const was = prRowKeys(before);
  for (const [pr, keys] of prRowKeys(after)) {
    const held = was.get(pr) ?? [];
    if (keys.length > 1 && held.length <= 1) return { pr, row: held[0] ?? keys[0] };
  }
  return null;
}

/** The refusal clause for a `newSplitRow` result, shared by every writer that refuses one. */
export function splitRowClause({ pr, row }) {
  return `PR #${pr} would map to more than one row — its PR's row is ${row}`;
}

/**
 * Why `ledger.mjs row` or `ledger.mjs review` must not write `line` over
 * `oldLine` (null for a new row), `before` and `after` the ledger's rows on
 * either side of the write, `retired` the ledger's `## Retired` names —
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
 * - unique launches: a launch identity — a workflow's runId, a runner's name —
 *   appears at most once in its PR's stream;
 * - unretired runners: no launch takes a runner name `retired` holds, which an
 *   earlier run of this omp session launched;
 * - one open launch per PR: no launch appears while an earlier one is open;
 * - an open launch is never removed: every launch open before the write is in
 *   its PR's stream after it, `=failed` allowed, on any of the PR's rows.
 */
export function rowWriteRefusal(before, after, oldLine, line, retired = []) {
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
      return `'${bad}' on ${where(id)} is not review=wf:<runId> | member:<name> (optionally =failed) `
        + "or reviewed=<head>:<survived>/<refuted>/<unverified>:<run> — unparseable review token";
    }
    const unpaired = added(b.unpaired, a.unpaired)[0];
    if (unpaired !== undefined) {
      return `'${unpaired}' on ${where(id)} answers no open launch — paired results: every reviewed= follows a review= `
        + "launch that no earlier reviewed= answered and that is not settled =failed; write a reviewed= only off a review result file";
    }
    const repeated = added(b.repeated, a.repeated)[0];
    if (repeated !== undefined) {
      const next = nextReviewer(a.launches, id, retired);
      return `launch '${repeated}' is already on ${where(id)}'s rows — unique launches: every launch takes an identity the PR has not used`
        + (next === null ? "" : `; the next free reviewer name is ${next}`);
    }
    const reused = a.launches.find((l) => l.kind !== "wf" && retired.includes(l.name) && !b.launches.some((o) => o.id === l.id));
    if (reused !== undefined) {
      const next = nextReviewer(a.launches, id, retired);
      return `launch '${reused.id}' on ${where(id)} names a runner an earlier run of this session already used — unretired runners: omp would answer it with \`${reused.name}-2\``
        + (next === null ? "" : `; the next free reviewer name is ${next}`);
    }
    const crowded = added(b.crowded.map((c) => c.id), a.crowded.map((c) => c.id))[0];
    if (crowded !== undefined) {
      const { open } = a.crowded.find((c) => c.id === crowded);
      // The stream names the later launch as the crowded one, but the write may
      // have added the earlier one — then the new launch is the offender and
      // the open one is the launch the ledger already held.
      const fresh = added(b.launches.map((l) => l.id), a.launches.map((l) => l.id));
      const [offender, holder] = fresh.includes(open) && !fresh.includes(crowded) ? [open, crowded] : [crowded, open];
      return `launch '${offender}' on ${where(id)} while launch '${holder}' is open — one open launch per PR: ${OPEN_WAYS_OUT}`;
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

/**
 * The name of every member the ledger holds settled: a settled copy in
 * `## Dispatched` or on a row settles it, except that a PR-bound member's
 * settled copy counts only on its own PR's row. Malformed tokens are the
 * caller's to have refused: one here is read as nothing.
 */
export function settledOnLedger(rows, dispatched) {
  const settled = new Set();
  for (const e of dispatched) {
    const t = parseToken(e);
    if (t !== null && t.error === null && t.outcome !== null) settled.add(t.name);
  }
  for (const text of rows) {
    const { pr } = rowNums(text);
    for (const t of memberTokens(text)) {
      if (t.error === null && t.outcome !== null && (t.bound !== "pr" || t.number === pr)) settled.add(t.name);
    }
  }
  return settled;
}

/**
 * What a ledger still holds live, and what must travel with it. `tokens` is
 * every unsettled member token and every open review launch, once each, in
 * ledger order, as `{name, token, row}` — the member or runner name (a
 * workflow launch's runId), the token as written, and the key of the first
 * row carrying it, null for a member `## Dispatched` alone names. `rows` is
 * the indices of every row of a stream — the rows one PR's record spans, or
 * a row's own key when it names none — in which any row carries one of those
 * tokens: a stream's rows are read together, so a live row carried without
 * its siblings would lose the PR's review record and the settled copies that
 * keep a bare token from reading live again. `dispatched` is every
 * `## Dispatched` entry whose member is unsettled, plus every settled entry
 * naming a member a kept row carries, for the same reason. A member is
 * settled as settledOnLedger() reads it — the reading
 * fleet-tick.mjs folds liveness by, so nothing that fold calls live is left
 * out. A launch is open while unanswered and not `=failed`, paired across its
 * PR's rows as `rowWriteRefusal` pairs them. Malformed tokens are the caller's
 * to have refused: one here is read as nothing.
 */
export function liveOnLedger(rows, dispatched) {
  const settled = settledOnLedger(rows, dispatched);
  const live = (t) => t !== null && t.error === null && t.outcome === null && !settled.has(t.name);
  const open = new Map();
  for (const [id, tokens] of streams(rows)) {
    const r = readReviews(tokens);
    open.set(id, r.launches.filter((l) => r.open.includes(l.id)));
  }
  const out = { rows: [], dispatched: [], tokens: [] };
  const seen = new Set();
  const add = (name, token, row) => {
    if (seen.has(token)) return;
    seen.add(token);
    out.tokens.push({ name, token, row });
  };
  const streamOf = rows.map(streamId);
  const liveStreams = new Set();
  rows.forEach((text, i) => {
    const key = text.split(/\s/)[0];
    const words = text.split(/\s+/).filter(Boolean);
    const members = memberTokens(text).filter(live);
    const launches = (open.get(streamOf[i]) ?? []).filter((l) => words.includes(l.id));
    if (members.length === 0 && launches.length === 0) return;
    liveStreams.add(streamOf[i]);
    for (const t of members) add(t.name, t.name, key);
    for (const l of launches) add(l.name, l.id, key);
  });
  const carried = new Set();
  rows.forEach((text, i) => {
    if (!liveStreams.has(streamOf[i])) return;
    out.rows.push(i);
    for (const t of memberTokens(text)) if (t.error === null) carried.add(t.name);
  });
  for (const e of dispatched) {
    const t = parseToken(e);
    if (t === null || t.error !== null) continue;
    if (live(t)) {
      out.dispatched.push(e);
      add(t.name, t.name, null);
    } else if (carried.has(t.name)) {
      out.dispatched.push(e);
    }
  }
  return out;
}

// A reviewer's runner name: `review-pr-<n>` for a PR's first, `-b`, `-c`, …
// for each later one. The only runner names the grammar knows, so the only
// ones a rotate retires; a launch under any other name retires nothing. The
// first group is the PR number the name is bound to.
export const REVIEWER = /^review-pr-([1-9][0-9]*)(-[b-z])?$/;

/** Whether `name` is one a `## Retired` line may hold: a member's name or a
 * reviewer's, bare. */
export const isRetirable = (name) => parseMember(name) !== null || REVIEWER.test(name);

/** The name a `## Retired` line retires, read the one way every reader reads
 * the section: the line's text before its first `=` — the whole line when it
 * has none — whatever outcome follows it, so a name written with an outcome
 * stays taken. Null when that name is not retirable: the line names no
 * member or reviewer and is malformed, and read as no name it would release
 * the name it was meant to hold, so `dispatch`, `review`, the tick and
 * `review-failed` refuse it and `rotate` skips it aloud; `token` reads the
 * names and leaves a malformed line to them. */
export function retiredName(line) {
  const eq = line.indexOf("=");
  const name = eq === -1 ? line : line.slice(0, eq);
  return isRetirable(name) ? name : null;
}

/** `## Retired` lines read through retiredName(): `names`, the names they
 * retire in line order, and `malformed`, the lines that name none. */
export function readRetired(lines) {
  const names = [];
  const malformed = [];
  for (const line of lines) {
    const name = retiredName(line);
    if (name === null) malformed.push(line);
    else names.push(name);
  }
  return { names, malformed };
}

// The reviewer runner names a row's `review=member:<name>` launches took,
// `=failed` or answered or open. A workflow launch is named by its runId,
// which no hub member holds.
function launchedRunners(text) {
  const out = [];
  for (const word of text.split(/\s+/)) {
    const m = REVIEW.exec(word);
    if (m !== null && m.groups.kind !== "wf" && REVIEWER.test(m.groups.name)) out.push(m.groups.name);
  }
  return out;
}

/**
 * The names an `ancestor` rotate retires: every member the archive settled —
 * in `## Dispatched` or on any row, the same two places `ledger.mjs dispatch`
 * refuses a repeat from within a run — and every reviewer runner a row
 * launched, that `liveOnLedger` does not carry, plus every name the archive's
 * own `## Retired` already held (`retired`, the names the caller read off its
 * lines with retiredName()), once each: the `## Retired` names first, then the
 * `## Dispatched` entries' in order, then the rows' in the order given, a
 * row's member tokens before the reviewer runners it launched. A retired
 * name stays taken for the rest of the omp session: the process that ran
 * the member still holds a peer under it, and omp answers a second task of
 * that name with `<name>-2` while `hub send <name>` keeps reaching the
 * first. `carried` is `{rows, dispatched}`, the texts of the rows and the
 * `## Dispatched` entries the new ledger carries (`liveOnLedger`'s picks); a
 * name it carries, live or as a settled copy, is on the new ledger already
 * and is not listed twice.
 * `dispatched` is every entry the archive held, well-formed or not, and a row
 * is read whether or not it parsed. A token with an outcome is a name this
 * session used, so it is retired whether or not its outcome is one of its
 * family's: the name on `impl-5=bogus` is retired, though the line is not
 * carried, and so is the name on `impl-5=`, whose outcome is empty — an empty
 * outcome is an outcome, not the absence of one. An unsettled member token —
 * a bare name, no outcome — retires nothing: only a name known gone is
 * retired, and a line whose name does not parse names no member.
 */
export function retiredOnLedger(rows, dispatched, retired, carried) {
  const seen = new Set();
  for (const e of carried.dispatched) seen.add(parseToken(e).name);
  for (const text of carried.rows) {
    for (const t of memberTokens(text)) if (t.error === null) seen.add(t.name);
    for (const name of launchedRunners(text)) seen.add(name);
  }
  const out = [];
  const add = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    out.push(name);
  };
  for (const name of retired) add(name);
  for (const e of dispatched) {
    const t = parseToken(e);
    if (t !== null && t.outcome !== null) add(t.name);
  }
  for (const text of rows) {
    for (const t of memberTokens(text)) if (t.outcome !== null) add(t.name);
    for (const name of launchedRunners(text)) add(name);
  }
  return out;
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

/** The prefix of the `outcome.reason` of a Pull that ended on an Exclusion. pull.mjs writes it on every path that
 * ends a Pull on an Exclusion naming a premise; a row naming no premise leaves the row's own text as the reason,
 * which carries the prefix only when the row does — that Exclusion never lifts, so neither reader takes its head
 * again whatever the reason says. The fleet tick and `pull.mjs next` read it to tell such a Pull from one that ended
 * for good: taken, relabelled, closed or released. */
export const EXCLUDED_REASON = "excluded ·";

/** Whether a Pull's `outcome.reason` says it ended on an Exclusion. */
const exclusionEnded = (reason) => typeof reason === "string" && reason.startsWith(EXCLUDED_REASON);

/** Whether a Pull record ended for good: released, or left for any reason but an Exclusion. The fleet tick's
 * pullOf and `pull.mjs next` both read a Pull's end through it, so the two cannot disagree. */
export const pullEnded = (record) => record.status === "released" || (record.status === "left" && !exclusionEnded(record.outcome?.reason));

export const ROWS = "## Rows";
export const DISPATCHED = "## Dispatched";
export const FILED = "## Filed";
export const RULED = "## Ruled";
export const DRAIN = "## Drain";
export const RETIRED = "## Retired";

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

// A section's entries, unescaped, in file order — none when the header is
// absent. Lenient by design: it refuses nothing, so ledger.mjs's rotate reads
// a ledger its load() refuses through the same slicing, and
// dispatch-prompt.mjs reads `## Rows` without loading the ledger whole.
export function ledgerSection(text, name) {
  const m = headerRe(name).exec(text);
  if (!m) return [];
  const start = m.index + m[1].length + name.length;
  const after = text.slice(start);
  const end = after.search(/\n## /);
  return (end === -1 ? after : after.slice(0, end))
    .split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- "))
    .map((l) => unescapeText(l.slice(2)));
}

/** The name the next merge bot takes: 1 + the highest `merge-bot-<n>` in
 * `## Dispatched`, settled ones included, or among `names` — the other names
 * the session holds, a retired bot's and a settled token on a row — the
 * highest, not the count, since a rotate that carries a live bot forward
 * carries a settled predecessor only when a carried row names it, and
 * retires the rest by name. n restarts at 1 with every run that carries and
 * retires no bot: a `dead` or `none` rotate, whose bots ran in an omp
 * process that is gone. */
export function nextMergeBot(dispatched, names = []) {
  const ns = [...dispatched.map(parseToken), ...names.map(parseMember)]
    .filter((t) => t?.family === "merge-bot").map((t) => t.number);
  return `merge-bot-${Math.max(0, ...ns) + 1}`;
}

/** The replacement name a member of `name`'s family and number takes next:
 * one retry letter past the HIGHEST any of `names` on that number has used,
 * `name` itself included — not past `name`'s own, since a controller can
 * dispatch `-c` before `-b`. No suffix is the `a` attempt; `-z` is the
 * grammar's last, past which there is no legal name, so null. */
export function nextRetry(name, names) {
  const { family, number } = parseMember(name);
  const top = [name, ...names].map(parseMember).filter((m) => m !== null && m.family === family && m.number === number)
    .map((m) => m.retry ?? "a").sort().at(-1);
  return top === "z" ? null : `${family}-${number}-${String.fromCharCode(top.charCodeAt(0) + 1)}`;
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

// The definition an implementer is dispatched under, off its ticket
// row's `tier=` token — none means `fleet-implementer-<POLICY_CELL>`,
// `tier=<x>` means `fleet-implementer-<x>`. The value becomes a file
// name under `agents/`, so it is held to `[a-z0-9]` words joined by `-`
// rather than joined into a path as written, and two different `tier=`
// values on one row name no single definition — refused, never resolved by
// position. A value with no definition behind it (the retired `tier=alt`) is
// `ledger.mjs dispatch`'s to refuse: it checks the file exists.
//
// Here, not in tier-check.mjs, because two readers must agree on it:
// `ledger.mjs dispatch` prints the definition before the call and records
// it on the member's `## Dispatched` entry, and tier-check.mjs judges the
// member against that record — against this function's answer for the row
// only for an entry that holds none. Two copies could name different
// definitions for one row and fail a dispatch made exactly as printed.
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
// compaction drops. A fix-applier is `fleet-fix-applier` for every kind of
// work — a review's findings, a conflict hold, a dispositions retry — whatever
// the row says. Throws whatever expectedDefinition throws, and throws on a
// family this switch has no case for: a `default` answer would print a new
// family as a definition without anyone having decided it is one.
/** @returns {string} the definition name. */
export function agentDefinition(member, rowText) {
  switch (member.family) {
    case "impl": return expectedDefinition(rowText);
    case "fix-pr": return "fleet-fix-applier";
    case "finisher-pr": return "fleet-finisher";
    case "merge-bot": return "fleet-merge-bot";
    default: throw new Error(`agentDefinition has no case for member family '${member.family}' (${member.name}) — add one to ledger-grammar.mjs`);
  }
}
