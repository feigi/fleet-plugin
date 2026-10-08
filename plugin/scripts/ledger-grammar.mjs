// The run ledger's member grammar: a member's token is `<member>` while it is live and
// `<member>=<outcome>` once settled. `ledger.mjs dispatch` writes the bare
// token and `ledger.mjs settle` rewrites it, so a reader derives every
// liveness count from the ledger file alone instead of from the controller's
// memory of what it dispatched.
//
// A module of its own, not a function inside ledger.mjs, because ledger.mjs is
// a CLI that parses argv and exits on import — and `fleet-tick.mjs` is to read
// this same grammar. A second copy of it there would be two readings
// of which members are live, free to drift apart.
//
// Rows stay freeform text. Only a token whose name part is a member name is
// claimed here; everything else a row carries (`class=routine`, `ports=`,
// `ci=`, `held-behind:#M`, merge-bot's `conflict-hold:#<pr>`, the
// `review=`/`reviewed=` pair, the `→ PR#M` arrow) is not a member and is left
// alone.

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
