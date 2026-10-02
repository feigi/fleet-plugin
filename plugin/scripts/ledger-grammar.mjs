// The run ledger's member grammar (#1799; spec 2026-09-24 § 6 §2, ADR 0012
// Decision 5): a member's token is `<member>` while it is live and
// `<member>=<outcome>` once settled. `ledger.mjs dispatch` writes the bare
// token and `ledger.mjs settle` rewrites it, so a reader derives every
// liveness count from the ledger file alone instead of from the controller's
// memory of what it dispatched.
//
// A module of its own, not a function inside ledger.mjs, because ledger.mjs is
// a CLI that parses argv and exits on import — and `fleet-tick.mjs` is to read
// this same grammar (#1803). A second copy of it there would be two readings
// of which members are live, free to drift apart.
//
// Rows stay freeform text. Only a token whose name part is a member name is
// claimed here; everything else a row carries (`class=routine`, `ports=`,
// `ci=`, `held-behind:#M`, merge-bot's `conflict-hold:#<pr>`, #1773's
// `review=`/`reviewed=` pair, the `→ PR#M` arrow) is not a member and is left
// alone.

// The outcome vocabulary, verbatim from the spec. A word is matched exactly,
// except the three that carry a value, which match OUTCOME_PATTERNS below.
const FAMILIES = {
  impl: { label: "impl-N", bound: "ticket", outcomes: ["PR#M", "bailed", "released", "killed", "tier-mismatch"] },
  "fix-pr": { label: "fix-pr-M", bound: "pr", outcomes: ["applied:<head>", "no-op", "failed", "killed"] },
  "finisher-pr": { label: "finisher-pr-M", bound: "pr", outcomes: ["labelled", "failed", "killed", "halted:<cause>"] },
  "merge-bot": { label: "merge-bot-n", bound: null, outcomes: ["done", "killed"] },
};
// A finisher halt's causes (#2083): the finisher worked correctly and refused
// to label, which `failed` (it crashed or gave up) does not say. `unreadable`,
// `missing` and `absent` are duty 1's audit-read halts (#1106).
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
const MEMBER = /^(impl|fix-pr|finisher-pr|merge-bot)-([1-9][0-9]*)(-[a-z])?$/;

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

/** The name the next merge bot takes: 1 + the `merge-bot-` entries in
 * `## Dispatched`, settled ones included. One ledger per run, so n restarts
 * at 1 with every run. */
export function nextMergeBot(dispatched) {
  return `merge-bot-${dispatched.map(parseToken).filter((t) => t?.family === "merge-bot").length + 1}`;
}

// #1398: the definition an implementer should run under, off its ticket
// row's `tier=` token — none means `fleet-implementer`, `tier=<x>` means
// `fleet-implementer-<x>`: `alt` (phase 2's every-5th-Pull alternate) and
// every #2030 per-cell name (`slow-high`) alike. The value becomes a file
// name under `agents/`, so it is held to `[a-z0-9]` words joined by `-`
// rather than joined into a path as written, and two different `tier=`
// values on one row name no single definition — refused, never resolved by
// position.
//
// Here, not in tier-check.mjs, because two readers must agree on it (#2208):
// `ledger.mjs dispatch` prints the definition before the call, and
// tier-check.mjs judges the member against it after. Two copies could name
// different definitions for one row and fail a dispatch made exactly as
// printed.
const TIER_SUFFIX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export function expectedDefinition(rowText) {
  const values = [...new Set(String(rowText ?? "").split(/\s+/)
    .filter((t) => t.startsWith("tier=")).map((t) => t.slice("tier=".length)))];
  if (values.length === 0) return "fleet-implementer";
  if (values.length > 1) throw new Error(`row carries conflicting tier= tokens (${values.map((v) => `tier=${v}`).join(", ")})`);
  if (!TIER_SUFFIX.test(values[0])) throw new Error(`tier=${values[0]} is not a definition suffix — expected [a-z0-9] words joined by '-'`);
  return `fleet-implementer-${values[0]}`;
}

// The agent definition a member is dispatched as (#2208), for a parsed member
// and the text of the row it works: `ledger.mjs dispatch` prints it so the
// `task` call that follows names it off a script's output, not off prose a
// compaction drops. A fix-applier on an unresolved conflict hold of its own PR
// is a `fleet-implementer` whatever the row's `tier=` (#2299) — it rebases the
// PR, it does not work a ticket at a tier. Any other fix-applier is a review
// one and gets null: a generic `task` by design. Whether the hold is
// unresolved is `conflictHeld`, the caller's to supply from fleet-tick.mjs's
// deriveRun() — the reading the tick holds the merge on, which folds every
// row of the PR, never one row's text alone. Throws whatever
// expectedDefinition throws.
export function agentDefinition(member, rowText, conflictHeld = false) {
  switch (member.family) {
    case "impl": return expectedDefinition(rowText);
    case "fix-pr": return conflictHeld ? "fleet-implementer" : null;
    case "finisher-pr": return "fleet-finisher";
    case "merge-bot": return "fleet-merge-bot";
    default: return null;
  }
}
