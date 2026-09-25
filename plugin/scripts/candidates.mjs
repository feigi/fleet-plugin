#!/usr/bin/env node
// Open issues that are candidates for work, reduced to the fields a shortlist
// needs.
//
// Never fetches raw bodies for the whole list — they are ~97% of the payload.
// The body is reduced to dependency references by `gh`, which applies `--jq`
// in its own process — so this file checks the rows it gets back rather than
// assuming the reduction applied.
//
// The label policy is a FLAG, not prose. `next-ticket` may drop a required
// label and retry when the result is empty; the fleet must not, because an
// empty ready-for-agent queue means there is no work, not that the net should
// widen — ready-for-human tickets need a human to brainstorm first, and an
// unattended fleet has no channel to one.
//
// Exit-code contract — the whole interface for a caller that reads no
// stderr: 0 = survivors, JSON array on stdout. 1 = the query succeeded and
// returned no rows at all. 2 = the query broke (bad args, gh failure, a
// reduction that did not apply, a capped result). 3 = the query succeeded,
// returned at least one row, and every row was removed by the to-spec
// filter — distinct from 1 so a caller such as run-team's phase 0 can say
// "the only labeled items are specs, run to-tickets" instead of "no work"
// (#64). Exit 3 describes the FINAL query attempt only — with
// `--allow-fallback`, a labeled all-specs pass that falls back to a
// genuinely empty unfiltered pass is exit 1, not 3; the drop count is never
// carried across the two attempts.

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { makeDie, makeArg, makeHas } from "./arg.mjs";

const NAME = "candidates";

// die()/arg()/has() shared with the other fleet scripts — see arg.mjs for
// the fail-open (#61/#169/#364) and pipe-safety (#176/#328/#363) rationale.
// No caller of THIS file is a hand-typed CLI. Two are markdown re-read by a
// model each run (next-ticket/SKILL.md, run-team/SKILL.md), which is why a
// malformed invocation is more plausible here than the shared guard's shape
// alone suggests — a model retypes the flags every time. The third,
// fleet-tick.mjs's readSupply(), spawns it with hardcoded args that cannot drift.
const die = makeDie(NAME);
const arg = makeArg(die);
const has = makeHas(die);

const requireLabel = arg("require-label");
const allowFallback = has("allow-fallback");

// Default well above the proving ground's real volume. Measured 2026-07-23:
// 106 issues survive the exclusions, so the previous hardcoded 100 dropped six
// of them — silently, because a truncated list is indistinguishable from a
// complete one. A high-priority ticket sitting at position 101 was invisible to
// the fleet and nothing said so.
const limit = Number(arg("limit") ?? 500);
if (!Number.isInteger(limit) || limit < 1) die(`--limit must be a positive integer, got '${arg("limit")}'`);

// The accepted flag set, declared once, and the only check on flag NAMES.
// Nothing checked them until #173: an unrecognised flag was ignored, so
// `--label ready-for-agent` — the spelling run-team's own phase 0 rule carried
// — ran the UNFILTERED query at exit 0, the widening `--require-label` exists
// to prevent.
//
// Runs BELOW the value guards, deliberately: where both would refuse — notably
// `--require-label` and `--limit` given with no value — arriving second leaves
// the refusal to #169's wording above rather than Node's. Nothing above emits
// output or runs a query, so refusing this late is still refusing before gh.
//
// The catch is unconditional, and THAT is the guard. Testing `e.code` for
// `ERR_PARSE_ARGS_UNKNOWN_OPTION` is what shipped first and it did not hold.
// `parseArgs` throws on the FIRST offending argument, so dropping any other
// code does not narrow the guard, it disables it for every argv where such an
// argument comes earlier — the unknown flag behind it is never reached. Two
// other codes were measured on node v26.5.0: ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL
// for a bare positional, ERR_PARSE_ARGS_INVALID_OPTION_VALUE both for
// `--boolflag=value` and for a string flag left without its value.
//
// Measured on that version: `ready-for-agent`, `junk --label ready-for-agent`
// and `--allow-fallback=true --label ready-for-agent` each ran the UNFILTERED
// query at exit 0, while `--label ready-for-agent` and
// `--require-label x --bogus` both refused. Position is not what decided it —
// a bad flag last still refused — only whether something earlier threw a code
// the catch dropped.
const OPTIONS = {
  "require-label": { type: "string" },
  "allow-fallback": { type: "boolean" },
  "limit": { type: "string" },
};
// No `strict: true`: strict IS parseArgs' default, and stays the default when
// `allowPositionals`, `tokens` or `allowNegative` are added alongside it —
// measured across 48 argv shapes with and without, zero differences in error
// code, message or `{values, positionals}`.
try {
  parseArgs({ options: OPTIONS });
} catch (e) {
  die(`${e.message} — accepted: ${Object.keys(OPTIONS).map((f) => `--${f}`).join(", ")}`);
}

if (allowFallback && !requireLabel) die("--allow-fallback is meaningless without --require-label");

// #175's other half, and the half the fix below newly makes possible: the
// label is QUOTED into the search term, so a `"` inside it closes that quote
// early and the remainder becomes free text — the same misparse, with the fix
// applied. A `\` breaks the same term from the other side, because GitHub
// DOES honour `\"` as an escaped quote inside a qualifier: measured against
// feigi/claude-config 2026-08-17, negating a label no issue carries is a
// no-op, so `-label:"zzz" label:"ready-for-agent"` returns the same count as
// `label:"ready-for-agent"` alone — while `-label:"zzz\" label:"ready-for-agent"`
// returns the count for `ready-for-agent` as FREE TEXT instead, the backslash
// having eaten the closing quote and swallowed the whole following qualifier.
// Doubling does not escape it. Here the label term is LAST, so a trailing
// backslash leaves its value unterminated and the query answers zero rows at
// HTTP 200, no error — #175's silent empty, with the fix applied. Neither
// character can be represented, so refuse both at exit 2 ("the query broke")
// rather than send a query whose empty answer would read as exit 1.
if (requireLabel && /["\\]/.test(requireLabel)) die(`--require-label cannot contain a double quote or a backslash, got '${requireLabel}'`);

// The five `wayfinder:*` terms are separate `-label:` clauses, not a wildcard —
// GitHub's search has no `-label:"wayfinder:*"` — and none is quoted despite
// the colon each value carries. Measured 2026-09-08 against feigi/fleet-plugin:
// negating `wayfinder:map` alone excludes exactly one more issue than the
// unfiltered open count, and that issue is #1292 — a colon inside a label
// value is parsed as part of the label, not as a delimiter that ends it early
// and spills the remainder into free text, the failure mode `label:"…"`
// quoting exists for a SPACE (see `query()`'s comment below). Stated as a
// relationship rather than a pinned count for the same reason `query()`'s own
// comment gives it below: the queue churns hourly, so a digit is wrong within
// a day and reads as a regression. Quoting every value anyway would cost
// nothing (`-label:"wayfinder:map"` measured identical: same one-issue
// exclusion, same issue) — left unquoted here because an unconditional
// quote-everything rule belongs at the one call site building every label
// term (`query()` below), and EXCLUDE is a static literal no caller
// assembles.
const EXCLUDE =
  "-label:in-progress -label:onhold -label:wontfix -label:needs-triage -label:needs-info -label:wayfinder:map -label:wayfinder:research -label:wayfinder:prototype -label:wayfinder:grilling -label:wayfinder:task";
// `d` walks the body line by line rather than one regex over the whole
// string, because RE2 (gojq's engine — gh applies `--jq` with gojq, not the
// system jq this file's own tests stub; see #63) has no lookahead, so
// "capture every ref up to the next heading" cannot be expressed as a single
// pattern. A heading line (`^#{1,6}[ \t]`) toggles a running "inside a
// blocking section" flag on when its text DECLARES one: any of the verb
// phrases, which end at a non-word character and tolerate trailing text
// because a heading opening with one is declaring a blocker whatever follows
// it; or the noun form
// `Dependencies`/`Dependency`, which must be the WHOLE heading, a trailing
// `:` aside. The noun form cannot be given the verb forms' tolerance:
// `## Dependency injection` is an ordinary section title in a code repo, and
// arming on it would turn every `#N` in its bullets into a blocker the body
// never declared (#439 — the noun form is the heading #208's brief used, and
// the gate named the verbs alone, so that section opened nothing).
//
// Either form may carry EMPHASIS, which markdown puts outside the words:
// `## **Dependencies**` names a dependency exactly as `## Dependencies` does,
// and read without the `\*` runs it armed no section at all, so every ref its
// bullets declared was dropped — exit 0, nothing on stderr, #439's silent
// wrong admission reached through this gate rather than through the inline
// label separator #439 widened (#1031). The runs are
// `\**` rather than `\*{0,2}` because `*`, `**` and `***` are all emphasis a
// heading is written with, and the noun form needs one on EACH side of its
// optional colon: markdown closes the bold before it (`**Dependencies**:`)
// or after it (`**Dependencies:**`) depending on where the author put the
// punctuation, the same both-sides tolerance the inline label separator
// below carries for the same reason. The end-of-line anchor is untouched —
// the runs go AROUND it, and they match asterisks ONLY, so
// `## **Dependency injection**` still arms nothing. Widen either run to a
// general wildcard and that heading arms, which is the whole distinction the
// anchor exists to hold; candidates.test.mjs pins both directions, on both
// engines.
//
// `after` is an inline label only, because `## After the migration` is
// ordinary narrative and arming on it invents a blocker, while a heading that
// really does declare one (`## After #12 lands`) still resolves through the
// inline pass below. The flag clears at ANY following heading (blocking or
// not); inside such a section only LIST-ITEM lines are read — that is the
// `## Blocked by` + list form to-tickets publishes, and the restriction is
// what keeps an unclosed section (nothing
// headed after it, the common shape) from sweeping every later `#N` in the
// body, inventing a blocker that silently starves the ticket out of the
// queue. Independently, any line — inside a section or not — carrying the
// phrase, then any run of whitespace and asterisks around an optional `:`,
// then one or more `#N` refs on that same line is read too — to-tickets'
// local-file `**Blocked by:** #12`, the markdown `Blocked by **#179**` that
// bolds the REF, and the bare `depends on #5` are all instances of that one
// match. The separator is a combined `[\s*]*` run rather than asterisk groups
// flanking the colon: those groups sat ahead of the separating whitespace, so
// they matched only asterisks flush against the phrase, and a space before the
// bold — where markdown actually puts it — dropped the ref (#439). Both passes
// are strictly line-local, which the removed `(?:depends on|…)\s+#\d+` regex
// was not: its `\s+` crossed newlines, so a
// phrase ending one line with its ref opening the next was collected and now
// is not. That narrowing is deliberate — neither to-tickets template writes
// that shape, and the alternative (carrying a "label seen, ref pending" flag
// into the following line) re-opens the same over-fire the list-item
// restriction above closes. A ref elsewhere in the body — not under a
// heading section, not after a label — is not collected: neither pass reaches
// it. Verified against real gojq (`go install
// github.com/itchyny/gojq/cmd/gojq@v0.12.19`) on every form in
// candidates.test.mjs's dependency-forms fixtures, not only the system jq the
// STUB there execs. The engines now agree on every one of those forms,
// including the ones that used to split. The separator is `[\t \p{Zs}*]*`
// and not `[\s*]*`, so `Blocked by:<U+00A0>#12` collects `[12]` under BOTH
// engines where it used to collect `[12]` under Oniguruma and `[]` under RE2
// — #383 ruled the ref a real blocker, because GFM renders that line as
// `Blocked by: #12` and autolinks the ref, so a reader sees a dependency and
// an admission gate must not miss one. Since no fixture splits any more, the
// gated tests can no longer identify their engine by disagreement: the STUB
// records which binary it executed and they assert that recording is gojq.
// The per-position rulings are set out above the JQ declaration below.
//
// `depmiss` is the diagnostic half (#1032), and it is deliberately LOOSER
// than the gate: any heading MENTIONING the concept that the gate did not
// arm. The gate's own pattern is named `armed` and both halves call it, so
// "did not arm" is the exact complement of what opened the section rather
// than a second approximation of it that could drift out of step. An empty
// `d` has two causes stderr could not tell apart — a ticket that declared no
// blocker, and a heading that declared one the gate refused — and the second
// is reachable BY DESIGN, since the noun form arms only as a whole heading:
// `## Dependencies (blocking)` collects nothing and printed the same row as a
// ticket with no dependencies at all. Matching the gate here would report
// nothing, because the headings worth naming are exactly the ones it
// rejected.
//
// So it over-fires by construction, `## Dependency injection` included, and
// THAT is why the stderr line it feeds is worded "not parsed, check the
// heading" and never as a fault: a DI section is not a mistake, and a
// diagnostic that calls it one false-alarms on every code-repo ticket
// carrying one — a line people learn to ignore is worse than no line.
// `after` stays out of the pattern for the same reason it arms no section
// above: `## After the migration` is narrative, so naming it would be noise
// with no near-miss behind it.
//
// A separate pass over the body rather than a third field on `depnums`'
// reducer, which is the pinned one and not worth reshaping for a diagnostic;
// the body is already walked twice and a third walk is nothing against the
// query it rides on. The trim is `rtrimstr("\r")` — literal, not `\s+$` —
// because the only whitespace that would disturb the line this prints is the
// CR of a CRLF body (what GitHub's web textarea writes), and a regex there
// would buy cosmetics at the price of one more regex position to rule on and
// keep portable (#383). `dh` never reaches stdout: the payload is stripped of it
// at the `JSON.stringify` below, because this is a stderr signal and #1032
// rules a payload field out of scope.
// ENGINE-PORTABLE CLASSES (#383). The program below contains no `\\s`, `\\d` or
// `\\b`: every position spells an explicit class. It has to, because the suite
// applies this expression with system jq (Oniguruma, all three Unicode-aware)
// while gh applies it with its embedded gojq (Go RE2, where `\\s` is
// `[\\t\\n\\f\\r ]`, `\\d` is `[0-9]` and `\\b` is ASCII). The same body reduced
// differently depending on who ran it, and gojq's answer is the one that
// reaches production. No library upgrade closes it: gh 2.100.0 embeds gojq
// v0.12.19, which is the latest release, Go's `\\s` is ASCII by design, jq
// 1.8.x still uses Oniguruma, and no inline flag (`(?S)`, `(?a)`, `(?u)`,
// `(?D)`) is accepted by both engines.
//
// The class is chosen PER POSITION, not once for the file. The governing rule
// is that each position follows GitHub's GFM rendering (measured with
// `gh api /markdown`); where no markdown rule applies, it follows what a
// reader sees. So two positions on the same line legitimately differ:
//
//   after a heading's `#` marker — `[ \t]`
//       `armed` and `depmiss`, both of which only ever match a heading that
//       HAS title text after the marker (a keyword like "blocked by" or
//       "dependencies"), so a marker with nothing after it already fails on
//       content grounds and never needs a wider class here. GFM opens a
//       heading on a space or a tab ONLY: `##<U+00A0>x` and `##<FF>x` both
//       render as paragraphs. This narrows ASCII too — `\f` used to open a
//       heading here and deliberately no longer does.
//   after a heading's `#` marker, any-heading toggle — `([ \t]|\r?$)`
//       `depnums`' per-line toggle, which decides whether a line STARTS a new
//       heading at all (armed or not) so an open blocking section resets.
//       Unlike `armed`/`depmiss` above, this one also has to recognize a
//       BARE marker-only heading — no title text follows, so `[ \t]` alone
//       never matches it, and the old open section wrongly kept collecting
//       refs past it (#383 over-collection). GFM still renders a bare `##`
//       as a real (empty) `<h2>`, so it must still close the section: `$`
//       admits end-of-line, `\r?` admits the same position just before a
//       CRLF line's trailing `\r` (the one `split("\n")` leaves behind).
//   list-item indent and marker gap — `[ \t]*` … `[ \t]`
//       Same GFM rule one level down: `-<U+00A0>#12` and `-<FF>#12` render as
//       paragraphs, so neither is a bullet and neither declares a blocker.
//   end of a heading line — `[\t\f\r \p{Zs}]*` before the anchor
//       `armed`'s `dependenc(?:y|ies)` arm and the `spec` predicate. Padding a
//       real heading with U+00A0, EM SPACE or IDEOGRAPHIC SPACE still renders
//       an `<h2>`, so it is still that heading. `\f` is stripped by GFM; `\r`
//       keeps CRLF bodies working; VERTICAL TAB stays EXCLUDED, because GFM
//       renders it as U+FFFD and a replacement character is not blank.
//   inline label/ref separators — `[\t\f\r \p{Zs}*]*`
//       `Blocked by:<U+00A0>#12` renders as `Blocked by: #12` and GitHub
//       autolinks the ref, so a reader sees a blocker — and an admission gate
//       must not be the one thing that misses it. Matches the end-of-heading
//       -line class above for the same reasons and the same characters:
//       `\f` is stripped by GFM, `\r` keeps CRLF bodies working. Missing
//       either one here silently drops a chained ref (`Blocked by
//       #12,\f#13` losing `#13`) — the opposite, worse direction from the
//       over-collection above: an admission gate must never MISS a blocker.
//   every digit run — `[0-9]`
//       Arabic-Indic digits are not refs anyone is trying to support, and this
//       is the position where divergence could take the whole run down rather
//       than change one row: under Oniguruma `\d` collected `#` + U+0661 U+0662,
//       `tonumber` rejected it, and the program exited 5 — so a single ticket
//       body took down the entire candidate listing.
//   word boundary after a blocking phrase — `(?:[^\p{L}\p{M}\p{N}_]|` + anchor
//       Unicode-aware, unlike RE2's ASCII `\b`: a letter, combining mark or
//       digit that CONTINUES the word means a different word, so a heading
//       reading `## Blocked by` + U+00E9 does not arm. Consuming one character
//       rather than matching zero-width is safe — nothing follows this arm.
//
// Wherever any non-ASCII whitespace counts at all, it is `\p{Zs}` and nothing
// wider: every Unicode space separator renders as a blank, so the rule is
// "looks like a space", and both engines agree on `\p{Zs}`. Mind the double
// escaping below — jq's `\\p{Zs}` is `\\\\p{Zs}` in this JS source string.
//
// Measured over 24 fixtures on jq-1.7.1-apple and gojq 0.12.19: zero splits.
// candidates.test.mjs pins the rows that used to split, on both engines, and
// proves which engine each gated test actually reached.
//
// NATIVE EDGES (#1741). `d` is the UNION of the body scan above and the
// numbers on the issue's native "blocked by" edges, which ride the same
// query as gh's `blockedBy` field — no extra round trip, the cost #58
// deferred them on — merged and sorted by the final `unique`. Union, not
// replacement: to-tickets still writes blockers only as body text, and a
// hand-written body can name a blocker nobody wired as an edge, so dropping
// the scan would silently un-block both. The edges close the opposite miss:
// #593's body chains `**#531**` behind a parenthetical the scan cannot
// cross, and only its native edge carries #531. `d` stays RAW — a closed
// blocker's number is kept although the edge carries its state, exactly as
// the scan keeps one, because the consumers (run-team / next-ticket step 2)
// judge openness and a `d` whose two halves meant different things would
// be worse than either. Only `blockedBy` counts: `parent`/`subIssues` are
// hierarchy, not blocking, and are not fetched. A missing or null
// `blockedBy` contributes nothing, so an issue with no edges reduces to
// exactly the body scan's `d`. `d` is bare numbers, so an edge to ANOTHER
// repository's issue would read as this repo's #N — measured 2026-09-25:
// none exists here (0 of 65 edges).
//
// `blockers` refuses rather than truncating. gh fetches the edges as
// `blockedBy(first:50)` (read off `GH_DEBUG=api` on gh 2.100.0) and GitHub
// caps each relationship type at 50 per issue, so `nodes` arrives whole
// today — measured 2026-09-25 across every issue in this repo, open and
// closed: `totalCount` equals `nodes | length` on all 37 issues with edges,
// the most on one being 7. If either constant moves, a longer list arrives
// cut short and `d` drops blockers with nothing said: the silent cap
// refuseIfCapped() refuses for the list as a whole, here for one row. So
// `error()` fails the whole query instead — gh exits non-zero with the
// message and query() dies at exit 2, "the query broke" — because a blocker
// list is the one input an admission gate must never read short.
// `blockedBy` is a gh 2.94.0 field. gh refuses a `--json` field it does not
// know (`Unknown JSON field`, exit 1 — measured on 2.100.0 with a made-up
// one), so an older gh dies at exit 2 here rather than running without edges.
const JQ =
  'def armed: test("(?i)^#{1,6}[ \\\\t]+\\\\**((?:depends on|blocked by|requires)(?:[^\\\\p{L}\\\\p{M}\\\\p{N}_]|$)|dependenc(?:y|ies)\\\\**:?\\\\**[\\\\t\\\\f\\\\r \\\\p{Zs}]*$)");\n' +
  '\n' +
  'def depmiss:\n' +
  '  [ split("\\n")[]\n' +
  '    | select(test("(?i)^#{1,6}[ \\\\t].*(dependenc|blocked by|depends on|requires)") and (armed | not))\n' +
  '    | rtrimstr("\\r")\n' +
  '  ];\n' +
  '\n' +
  'def depnums:\n' +
  '  (reduce (split("\\n"))[] as $line (\n' +
  '      {insec: false, nums: []};\n' +
  '      ($line | armed) as $bh\n' +
  '      | ($line | test("^#{1,6}([ \\\\t]|\\\\r?$)")) as $any\n' +
  '      | (if $any then $bh else .insec end) as $nextsec\n' +
  '      | ($line | test("^[ \\\\t]*([-*+]|[0-9]+[.)])[ \\\\t]")) as $item\n' +
  '      | {\n' +
  '          insec: $nextsec,\n' +
  '          nums: (\n' +
  '            .nums\n' +
  '            + (if $nextsec and $item then [$line | scan("#[0-9]+")] else [] end)\n' +
  '            + [ $line\n' +
  '                | scan("(?i)(?:depends on|blocked by|requires|after)[\\\\t\\\\f\\\\r \\\\p{Zs}*]*:?[\\\\t\\\\f\\\\r \\\\p{Zs}*]*(#[0-9]+(?:[\\\\t\\\\f\\\\r \\\\p{Zs}*]*(?:,|and)?[\\\\t\\\\f\\\\r \\\\p{Zs}*]*#[0-9]+)*)")\n' +
  '                | .[0]\n' +
  '                | scan("#[0-9]+")\n' +
  '              ]\n' +
  '          )\n' +
  '        }\n' +
  '    )).nums\n' +
  '  | map(ltrimstr("#") | tonumber)\n' +
  '  | unique;\n' +
  '\n' +
  'def blockers:\n' +
  '  (.blockedBy.nodes // []) as $nodes\n' +
  '  | if (.blockedBy.totalCount // 0) > ($nodes | length)\n' +
  '    then error("#\\(.number): blockedBy lists \\($nodes | length) of \\(.blockedBy.totalCount) blockers, so d would miss the rest")\n' +
  '    else [$nodes[].number]\n' +
  '    end;\n' +
  '\n' +
  '[.[] | {n:.number,t:.title,l:[.labels[].name],\n' +
  ' spec:((.body//"")|test("(?m)^#{2,6}[ \\\\t]+User Stories[\\\\t\\\\f\\\\r \\\\p{Zs}]*$")),\n' +
  ' d:(((.body//"")|depnums) + blockers | unique),\n' +
  ' dh:((.body//"")|depmiss)}]\n';

function query(label) {
  // The label is a VALUE in GitHub's query language, not part of its syntax,
  // so it is quoted rather than interpolated raw (#175). Unquoted, a value
  // ends at the FIRST SPACE and every word after it becomes a free-text term
  // instead — measured 2026-08-17, `label:ready-for-agent candidates` returns
  // strictly fewer issues here than `label:ready-for-agent`, and on
  // microsoft/vscode `label:help wanted` returns nothing at all where
  // `label:"help wanted"` returns that label's real backlog. A caller reads
  // the narrowed result as the label's own answer, and an empty one as exit 1,
  // "the query worked and there is no work" — against a queue that is not
  // empty. Reachable wherever a repo remapped its triage labels, which
  // docs/agents/triage-labels.md exists to invite. Stated as relationships
  // rather than counts on purpose: the queue churns hourly, so a pinned digit
  // is wrong within a day and reads as the fix having regressed.
  //
  // Quoted unconditionally, not only when the label contains whitespace —
  // though NOT because a second character is dangerous. Space is the one
  // character GitHub splits an unquoted value on; a `:` is inert there,
  // measured the same day: `label:auto:logs` and `label:"auto:logs"` agree on
  // renovatebot/renovate, as do `label:Team:Core` and `label:"Team:Core"` on
  // elastic/kibana. The reason to quote every label is that quoting a value
  // needing none is a measured no-op (`label:ready-for-agent` and
  // `label:"ready-for-agent"` agree here), so one unconditional form beats a
  // predicate that has to stay in step with GitHub's parser to stay correct.
  const search = label ? `${EXCLUDE} label:"${label}"` : EXCLUDE;
  const args = [
    "issue", "list",
    "--state", "open",
    "--limit", String(limit),
    "--search", search,
    "--json", "number,title,labels,body,blockedBy",
    "--jq", JQ,
  ];
  console.error(`$ gh ${args.join(" ")}`);
  let out;
  try {
    out = execFileSync("gh", args, { encoding: "utf8" });
  } catch (e) {
    // Fail closed. A failed query and an empty queue are different facts, and
    // only one of them means "there is no work".
    //
    // Names the cause, never gh's stderr — same discipline as the row-shape
    // refusal below. execFileSync forwards the child's stderr to ours already
    // (it does so precisely because `stdio` is absent from the options above —
    // Node gates the forward on `!options.stdio`, so adding one silently makes
    // this message the only report). Interpolating `e.stderr` therefore emitted
    // every byte twice: measured 7,700 B of gh stderr → 15,454 B, into a caller
    // that is markdown read by a model. `e.message` is the same string, not a
    // safer fallback — Node builds it as `Command failed: <cmd>\n<stderr>`.
    //
    // Three disjoint shapes, so three branches. `e.code` is set when Node
    // itself aborted the call: ENOENT (nothing spawned, nothing printed),
    // ENOBUFS/ETIMEDOUT (the child ran and printed, then Node killed it).
    // `e.signal` is the only field a signal death sets — without it this reads
    // `exit null`, naming nothing, for the OOM kill and the SIGPIPE. `e.status`
    // carries a real exit code, whose stderr the caller has already seen.
    die(
      `gh issue list failed: ${
        e.code ?? (e.signal ? `killed by ${e.signal}` : `exit ${e.status}`)
      }`,
    );
  }
  const trimmed = out.trim();
  // Not `return []`. The reduction is `[…]`-wrapped, so it emits an array for
  // every input including none — empty output means it did not run, which is
  // the same fact as the shape check below, not an empty queue.
  if (trimmed === "") die("gh returned no output — the --jq reduction did not apply");
  let rows;
  try {
    rows = JSON.parse(trimmed);
  } catch (e) {
    die(`could not parse gh output as JSON: ${e.message}`);
  }
  // The reduction runs inside gh, not here, so nothing at this end guarantees
  // it applied — an older gh, an expression it rejects, an error object from a
  // proxy. Unchecked, the wrong shape flows on until the first use of it
  // throws, and an uncaught throw exits 1: the code reserved for "successful
  // query, no survivors". Fail closed, same as the failed-query path above.
  if (!Array.isArray(rows)) die("gh output is not an array — the --jq reduction did not apply");
  const bad = rows.findIndex(
    (r) =>
      !r ||
      typeof r.n !== "number" ||
      typeof r.t !== "string" ||
      !Array.isArray(r.l) ||
      !Array.isArray(r.d) ||
      !Array.isArray(r.dh) ||
      typeof r.spec !== "boolean",
  );
  // The row is named, never dumped: an unreduced payload carries every issue
  // body, ~97% of what this file refuses to fetch in the first place.
  // Says what is wrong, not why: this also fires when the reduction ran fine
  // and the upstream field types were not what it assumed, so it cannot claim
  // the reduction did not apply the way the two checks above can.
  if (bad !== -1) die(`gh output row ${bad} is not {n,t,l,d,dh,spec} — not the shape the --jq reduction produces`);
  return rows;
}

// Hitting the limit exactly means the answer may be incomplete, and there is
// no way to tell from the result itself. Refuse rather than hand back a
// shortlist that silently omits work — "no silent caps" is the rule this
// enforces. Applied verbatim to BOTH the labeled query and the fallback
// query below — the fallback result was previously never re-checked, so
// --require-label <nonexistent> --allow-fallback could ship a silently
// truncated unfiltered list.
function refuseIfCapped(rows, description) {
  if (rows.length === limit) {
    die(
      `exactly ${limit} results${description} — the list is capped and may be truncated. ` +
        `Re-run with a higher --limit; a shortlist that silently drops tickets is not an answer.`,
    );
  }
}

// `## User Stories` is to-spec's signature — mandatory in its template, absent
// from every ticket template. to-spec stamps a whole spec `ready-for-agent`
// with "no need for additional triage", so it arrives looking admissible; it is
// to-tickets' INPUT, not a ticket, however well decided it is.
//
// ponytail: shape-match on to-spec's template, and no markdown awareness — a
// ticket quoting `## User Stories` inside a fenced block is dropped too. Not
// worth a fence parser: every drop is logged by number, so a false positive is
// loud rather than silent.
//
// #65: two shapes the predicate leaves undecided by accident, now decided.
// Depth is `#{2,6}`, not `##` — two or more `#`, not exactly two, and capped
// where CommonMark caps an ATX heading, same as `depnums`' own `#{1,6}` above:
// a line of seven `#` is not a heading and must not read as the signature.
// to-spec's own `<spec-template>` is flat (`## Problem Statement`, `##
// Solution`, `## User Stories`, `## Implementation Decisions` — nothing
// nests), so widening costs nothing against real to-spec output. It closes a
// leak: a spec hand-nested or reformatted under a parent heading (`###
// User Stories`) used to read as an ordinary ticket. The asymmetry decides
// it even where a real to-spec body would never trigger it — a leaked spec
// is silent and expensive (a member implements a whole spec as one ticket),
// a false drop is loud (logged by number, `[unfiltered]`/`[label:…]`
// tagged). The separator between marker and text is `[ \t]+` — horizontal
// whitespace only, not `\s+` — so a heading can never span a line break: a
// body whose line is exactly `##` with `User Stories` starting the next
// line no longer reads as the same heading. That is also #383's ruling for
// this position, on GFM's own rule: only a space or a tab opens a heading, so
// `##<U+00A0>User Stories` renders as a PARAGRAPH and is not a spec at all.
//
// The TRAILING class is `[\t\f\r \p{Zs}]*`, and it is a DIFFERENT class from
// the one after the marker — ruling the two positions separately is the whole
// point. The `$` under `(?m)` already anchors the line end, so the run there
// can only ever eat whitespace before an anchor and can never make a line that
// is NOT the signature read as one, while narrowing it to `[ \t]*` would drop
// the `\r` of a CRLF body — what GitHub's web textarea writes — and leak that
// spec silently. It is spelled out rather than left as `\s*` because `\s` is
// the one construct here whose meaning changes with the engine (Oniguruma
// reads it Unicode-aware, RE2 as `[\t\n\f\r ]`), and #383 ruled the position
// by what GFM renders: `## User Stories` padded with U+00A0, EM SPACE or
// IDEOGRAPHIC SPACE are all real `<h2>`s, so all three are still to-spec specs
// and all three are dropped. `\p{Zs}` is exactly "renders as a blank" and both
// engines agree on it; `\f` is in the class because GFM strips it; `\r` is
// what keeps CRLF working. ASCII VERTICAL TAB is deliberately OUT: GFM renders
// it as U+FFFD, so `## User Stories<VT>` is not blank-padded to a reader and
// is not dropped. Before the ruling this position diverged — a U+00A0-padded
// heading was a spec under the system jq the suite execs and NOT one under the
// gojq gh applies, so in production dropSpecs never fired and the spec shipped
// as a claimable ticket. Pinned against real gojq in candidates.test.mjs,
// which now also pins which engine it reached.
//
// This is the ONLY line of defence — nothing downstream catches a spec. A
// leaked one is decided and needs no human hands, so it passes both of phase
// 2's bail tests, and heavy is explicitly never a bail reason (run-team:180).
// Change to-spec's template and this predicate goes with it, or a member
// implements an entire spec as one ticket.
// `pass` names which query the drop came from — required, not defaulted: the
// fallback runs only when the labeled query emptied out, so in production the
// unfiltered query is a SUPERSET of the labeled one, and every spec dropped in
// pass 1 is dropped again in pass 2. Unattributed, that reads as the same spec
// counted twice; named, a reader can tell "2 drops, 1 spec, seen both passes"
// from "2 drops, 2 specs" at a glance. Deliberately not deduplicated — #133.
function dropSpecs(rows, pass) {
  const kept = [];
  for (const { spec, ...rest } of rows) {
    if (spec) {
      // "no silent caps" covers drops too — a filtered list that does not say
      // what it filtered is indistinguishable from a complete one.
      console.error(`    dropped #${rest.n} — to-spec spec, not a ticket (User Stories heading) [${pass}]`);
    } else {
      kept.push(rest);
    }
  }
  return kept;
}

let rows = query(requireLabel);
console.error(`    ${rows.length} candidate(s)${requireLabel ? ` with label:${requireLabel}` : ""}`);
refuseIfCapped(rows, requireLabel ? ` with label:${requireLabel}` : "");
// After refuseIfCapped, never before: filtering first can shrink the array below
// `limit` and the cap check would stop seeing a truncated list. Before the
// emptiness test below, never after: a queue whose every row was filtered out
// IS an empty queue — see #60. Telling that case apart from a genuinely empty
// one, for a caller reading only the exit code, is #64 — closed by exit 3 at
// the foot of this file, which is what the raw count below is captured for.
// Raw count captured just before the filter that can empty `rows` out, so
// `allFilteredOut` below can tell "nothing came back" from "rows came back
// and the filter ate them all". Reassigned wholesale in the fallback branch,
// never OR'd/summed with pass 1's value — #64's edge case is exactly a pass 1
// all-filtered (raw>0) whose fallback pass is genuinely empty (raw=0), which
// must read as the fallback's own facts (exit 1), not a merge of the two.
const rawCount1 = rows.length;
rows = dropSpecs(rows, requireLabel ? `label:${requireLabel}` : "unfiltered");
let allFilteredOut = rawCount1 > 0 && rows.length === 0;

if (rows.length === 0 && allowFallback && requireLabel) {
  console.error(`${NAME}: empty with label:${requireLabel}; --allow-fallback given, retrying unfiltered`);
  rows = query(null);
  console.error(`    ${rows.length} candidate(s) unfiltered`);
  refuseIfCapped(rows, " unfiltered (fallback)");
  // After refuseIfCapped for the same reason as above; the emptiness half does
  // not transfer, as no gate follows this one. The call must exist because the
  // fallback's rows arrive raw and nothing downstream drops a spec.
  const rawCount2 = rows.length;
  rows = dropSpecs(rows, "unfiltered (fallback)");
  allFilteredOut = rawCount2 > 0 && rows.length === 0;
}

// FIFO among survivors. Issue number is monotonic in creation order, so this
// needs no extra field and no query semantics. Dependencies do not rank —
// blocked tickets are dropped by the CONSUMER reading `d` (run-team step 2 /
// next-ticket step 2), not here, and to-tickets publishes chains blockers-first
// so lower numbers are the blockers anyway. `d` covers every body form
// to-tickets publishes — heading + list, bold/inline label, the original bare
// phrasings — see #58, and GitHub's native blocked-by edges too (#1741), so
// a chain wired only as edges reaches this sort with its blockers in `d`.
// Native sub-issue links are still not read: parent/child is hierarchy, not
// blocking, so a blocker recorded only as one reaches it with none.
rows.sort((a, b) => a.n - b.n);

for (const r of rows) {
  console.error(`    #${r.n} [${r.l.join(",")}] ${r.t}${r.d.length ? `  deps:${r.d.join(";")}` : ""}`);
  // #1032. A SECOND line, never a field on the row above: that row's format is
  // what phase 0 reads and it stays byte-identical, `deps:` suppressed on an
  // empty list and all. Indented under the row it belongs to, and repeating
  // `#N` so a reader who greps the wording still gets the candidate with it.
  //
  // Says what was seen and what was not done with it, and points at the
  // heading. No "error", no "invalid", no imperative to fix anything: the
  // shape that most often reaches here — a noun-form heading carrying
  // qualifying text — is legitimate usage the gate refuses on purpose (see
  // `depmiss` above), so a fault-worded line would false-alarm every ticket
  // that writes one. What the caller does with it is a judgement call this
  // has no standing to make: `d` may be empty because the heading was prose
  // all along, or because a real blocker was declared under a heading the
  // scan does not read, and only the body says which.
  if (r.dh.length) {
    console.error(
      `      #${r.n} heading mentions dependencies, not parsed as a dependency section` +
        ` — refs under it are not in deps, check the heading: ${r.dh.map((h) => `'${h}'`).join(", ")}`,
    );
  }
}

// Compact: the pretty per-candidate view already went to stderr above; this
// payload is parsed by a machine, and indenting up to `--limit` issues is pure
// token cost in the controller's context.
//
// `dh` is dropped here rather than never collected: the heading text exists
// only inside gh's process, where the reduction runs, so the only way to it is
// a field on the row — and #1032 rules a payload field out of scope, the
// stderr signal being the whole of what it asks for. Here, and not in
// `dropSpecs`' destructure where the row's other stderr-only field (`spec`)
// leaves the payload: that runs BEFORE the per-candidate lines above, which
// are what `dh` is for. A replacer, not a rebuilt array: it drops the key
// without copying up to `--limit` rows to do it. Add a field to the
// reduction that stdout SHOULD carry and it needs naming here, or it
// silently never ships.
console.log(JSON.stringify(rows, (k, v) => (k === "dh" ? undefined : v)));

// Exit 1 for a successful query with no survivors, exit 3 when those zero
// survivors are the filter's doing rather than the query's — see the
// exit-code contract in the file header (#64). `allFilteredOut` already
// describes only the final attempt (see above), so no further branching on
// requireLabel/allowFallback is needed here.
//
// exitCode, not exit(): stdout on a pipe is async too, and process.exit() drops
// the queued payload at the 64 KiB buffer while still reporting 0. Measured,
// 499 rows — one under the DEFAULT --limit — arrived truncated mid-JSON at exit
// 0, the corrupt-payload-typed-as-success this file's exit codes exist to make
// impossible. refuseIfCapped cannot see it: that fires at exactly `limit`.
process.exitCode = rows.length === 0 ? (allFilteredOut ? 3 : 1) : 0;
