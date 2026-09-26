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
// `ci=`, `held-behind:#M`, #1773's `review=`/`reviewed=` pair, the `→ PR#M`
// arrow) is not a member and is left alone.

// The outcome vocabulary, verbatim from the spec. A word is matched exactly,
// except the two that carry a value, which match OUTCOME_PATTERNS below.
const FAMILIES = {
  impl: { label: "impl-N", bound: "ticket", outcomes: ["PR#M", "bailed", "released", "killed", "tier-mismatch"] },
  "fix-pr": { label: "fix-pr-M", bound: "pr", outcomes: ["applied:<head>", "no-op", "failed", "killed"] },
  "finisher-pr": { label: "finisher-pr-M", bound: "pr", outcomes: ["labelled", "failed", "killed"] },
  "merge-bot": { label: "merge-bot-n", bound: null, outcomes: ["done", "killed"] },
};
const OUTCOME_PATTERNS = {
  "PR#M": /^PR#[1-9][0-9]*$/,
  "applied:<head>": /^applied:[0-9a-f]{7,40}$/i,
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
