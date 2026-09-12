// Regression gate for the candidate query's two filters — to-spec specs never
// reach the queue, and the list comes back oldest-first — and for its exit
// codes, which are the whole interface for a caller that reads no stderr: 2 is
// "the query broke", 1 is "the queue is empty", and the two must never swap.
//
// candidates.mjs applies its reduction through gh's `--jq`, so the stub below
// runs the same expression gh would have received — under the system jq it
// execs by default, not the gojq gh embeds and applies in its own process.
// Both predicates are under test that way; the ENGINE itself is under test
// only where a real gojq binary is reachable (`findGojq()` below) — the
// dependency scan since #331, the spec predicate since #204. `\s` and `\d`
// are Unicode-aware in jq's Oniguruma and ASCII-only in Go's RE2, so on some
// inputs — a `## User Stories` heading padded with trailing U+00A0, a
// dependency ref separated from its label by U+00A0 — the two engines
// disagree, and gojq's answer is production's: gh applies gojq, not jq, so
// dropSpecs is the only line of defence against what gojq actually decides.
// A pattern gojq rejects outright at least exits non-zero; a class that
// merely matches differently would leave this suite green on jq alone, which
// is what the gated gojq tests below exist to catch. Stubbing gh to return
// already-reduced JSON would leave the jq expression — which is where both
// predicates actually live — completely untested.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./strip-comments.mjs";
import { between } from "./prose-pin.mjs";

const SCRIPT = fileURLToPath(new URL("./candidates.mjs", import.meta.url));
const ARG_MODULE = fileURLToPath(new URL("./arg.mjs", import.meta.url));

const STUB = `#!/bin/sh
# Stand-in for \`gh issue list … --jq <expr>\`. Applies the expression gh was
# given to the fixture, so the expression is under test rather than assumed.
expr=""
search=""
while [ $# -gt 0 ]; do
  case "$1" in
    --jq) shift; expr="$1" ;;
    --search) shift; search="$1" ;;
  esac
  shift
done
# The fallback is the query with no POSITIVE label: term. The leading space is
# the whole test and cannot be dropped: every exclusion is spelled \`-label:\`,
# so a bare \`*label:*\` matches the unfiltered query too and silently serves it
# the labeled fixture — the fallback then looks untaken however well it works.
# \$search is padded so the term still matches when it leads: gh ignores
# qualifier order, so reordering query()'s template must not invert this.
# No second fixture supplied — both queries see the same rows, as before.
# The two fixtures are deliberately DISJOINT, which real gh could never be
# (unfiltered is a superset). A faithful superset makes the stub's ignored
# --limit stop the cap tests firing. So never assert a labeled row is ABSENT
# from the fallback payload — it was never in that fixture, and it passes
# whatever the code does.
# gh applies \`--jq\` itself, inside its own process, so a reduction that did not
# take is a real failure mode — an old gh, an expression it rejects, a proxy
# answering with an error object. Overriding the expression is the only way a
# test reaches the empty and non-array refusals: the real one always emits an
# array. It is NOT the only way to reach the row-shape refusal, which a fixture
# alone trips whenever a field's type is wrong upstream (\`"number":"11"\` reduces
# to \`{"n":"11"}\`) — the expression fixes the key set, never the value types.
[ -n "$JQ_OVERRIDE" ] && expr="$JQ_OVERRIDE"
fixture="$FIXTURE"
case " $search " in
  *\\ label:*)
    # GitHub ends an UNQUOTED qualifier value at the first space; every word
    # after the first becomes a free-text term instead. Measured against the
    # live repo 2026-08-17: \`label:ready-for-agent candidates\` returns
    # strictly fewer issues than \`label:ready-for-agent\`, while
    # \`label:"ready-for-agent"\` returns exactly as many — the relationship and
    # not the counts, which drift with the queue from hour to hour.
    # Reproduce that split or no test can tell the two forms apart — both
    # contain \` label:\`, so the dispatch above serves the labeled fixture
    # either way and #175 stays green while broken.
    #
    # Opt-in through \$LABEL_EXPECT: unset, the term is parsed and ignored, so
    # every test written before #175 keeps exactly its old dispatch.
    padded=" $search "
    term=\${padded#* label:}
    case "$term" in
      \\"*) label=\${term#\\"}; label=\${label%%\\"*} ;;
      *) label=\${term%% *} ;;
    esac
    ;;
  # No positive \`label:\` term at all, so nothing was parsed out. An empty
  # \$label matches no \$LABEL_EXPECT, which is what refuses the OTHER
  # direction of #175 — a query that dropped the qualifier outright rather
  # than misparsing it. Only a check BELOW the case can see that: such a
  # search never enters the arm above.
  *) label=""; [ -n "$FIXTURE_UNFILTERED" ] && fixture="$FIXTURE_UNFILTERED" ;;
esac
if [ -n "$LABEL_EXPECT" ] && [ "$label" != "$LABEL_EXPECT" ]; then
  # An empty array, not a missing one: the real query would have SUCCEEDED
  # and matched nothing, which is the whole confusion #175 is about.
  echo '[]' | "\${JQ_BIN:-jq}" -c "$expr"
  exit
fi
exec "\${JQ_BIN:-jq}" -c "$expr" "$fixture"
`;

function run(issues, args = ["--require-label", "ready-for-agent"], unfiltered = null, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "candidates-"));
  const fixture = join(dir, "issues.json");
  writeFileSync(fixture, JSON.stringify(issues));
  const gh = join(dir, "gh");
  writeFileSync(gh, STUB);
  chmodSync(gh, 0o755);
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, FIXTURE: fixture, ...extraEnv };
  if (unfiltered) {
    const second = join(dir, "unfiltered.json");
    writeFileSync(second, JSON.stringify(unfiltered));
    env.FIXTURE_UNFILTERED = second;
  }
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env });
  rmSync(dir, { recursive: true, force: true });
  return { ...r, rows: r.stdout.trim() ? JSON.parse(r.stdout) : [] };
}

// For the failure shapes the fixture stub cannot reach — it always `exec`s jq,
// so it can only ever fail by exit status. A gh that kills itself, or one that
// is absent, is a different `execFileSync` error object entirely.
function runWithGh(script) {
  const dir = mkdtempSync(join(tmpdir(), "candidates-gh-"));
  const gh = join(dir, "gh");
  writeFileSync(gh, script);
  chmodSync(gh, 0o755);
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  const r = spawnSync(process.execPath, [SCRIPT, "--require-label", "ready-for-agent"], {
    encoding: "utf8",
    env,
  });
  rmSync(dir, { recursive: true, force: true });
  return r;
}

// Labels are settled by the fixture, not by the query: the stub ignores
// `--search`'s label term beyond picking a fixture. A row in the unfiltered
// fixture therefore has to carry a label that would NOT have matched the
// labeled query, or the two fixtures contradict each other.
const ticket = (n, body, labels = ["ready-for-agent"]) => ({
  number: n,
  title: `ticket ${n}`,
  labels: labels.map((name) => ({ name })),
  body,
});

// #1306: EXCLUDE is a single string literal, pinned whole rather than by N
// independent `assert.match` calls for individual terms — a dropped or
// reordered term sits in the gap BETWEEN two such matches and neither would
// see it. One `assert.equal` over the exact captured span covers every term
// and their order together.
//
// Read through stripComments(), not raw source — the same escape :1039's
// `die()` pin already closes. An unanchored match against raw text is
// satisfied by a declaration parked in a `/* */` block above a reverted one:
// measured, with the correct five-term EXCLUDE moved into a block comment
// and the live declaration reverted to the pre-#1306 five terms, a raw-source
// version of this assertion still passed while the unfiltered scan leaked
// all eight wayfinder tickets back in. stripComments() blanks whole-line and
// block comments (its own documented ceiling), so the mutant reds under it
// and the real declaration's capture is unaffected either way.
test("EXCLUDE carries every canonical exclusion term, in order, as one pinned string (#1306)", () => {
  const src = stripComments(readFileSync(SCRIPT, "utf8"));
  const m = src.match(/const EXCLUDE =\n\s*"([^"]+)";/);
  assert.notEqual(m, null, "candidates.mjs's EXCLUDE declaration no longer matches this pin's shape — update this test");
  assert.equal(
    m[1],
    "-label:in-progress -label:onhold -label:wontfix -label:needs-triage -label:needs-info -label:wayfinder:map -label:wayfinder:research -label:wayfinder:prototype -label:wayfinder:grilling -label:wayfinder:task",
  );
});

test("a to-spec spec is dropped — it is to-tickets' input, not a claimable ticket", () => {
  const { rows } = run([
    ticket(10, "## Problem Statement\n\nx\n\n## User Stories\n\n1. As a user, I want…\n"),
    ticket(11, "## What to build\n\nAdd a --json flag.\n"),
  ]);
  assert.deepEqual(rows.map((r) => r.n), [11]);
});

test("every spec is dropped and named — a filter that stops at the first leaks the rest", () => {
  const { rows, stderr } = run([
    ticket(10, "## User Stories\n\n1. As a user, I want…\n"),
    ticket(11, "## Problem Statement\n\ny\n\n## User Stories\n\n2. As a user…\n"),
    ticket(12, "## What to build\n\nx\n"),
  ]);
  assert.deepEqual(rows.map((r) => r.n), [12]);
  // deepEqual on the parsed lines, not a substring match: `/dropped #10/` is
  // satisfied by a hardcoded number and by logging kept rows too. This pins
  // both that 10 and 11 are named and that 12 is not.
  assert.deepEqual(stderr.match(/dropped #\d+/g), ["dropped #10", "dropped #11"]);
});

test("a drop from the no-label run is tagged [unfiltered] — the one pass tag no other test reaches", () => {
  // Every other run() in this file passes --require-label, so the pass-1
  // ternary always takes its `label:` arm and the `unfiltered` arm is
  // unpinned: rename it to anything and the whole suite stays green. Both
  // documented callers do pass the flag (next-ticket/SKILL.md's `## 1. Candidates`
  // step, run-team/SKILL.md's **Candidate scan** step), so this arm is reachable only by a hand-run — but
  // it is a supported invocation, and its tag is what tells a reader which
  // query dropped what. Two rows, not one: the spec supplies the drop line,
  // the ticket keeps the queue non-empty so this exits 0, not the empty-queue 1.
  const { status, stderr, rows } = run(
    [
      ticket(10, "## User Stories\n\n1. As a user…\n", ["ready-for-human"]),
      ticket(11, "## What to build\n\nx\n", ["ready-for-human"]),
    ],
    [],
  );
  assert.equal(status, 0);
  assert.deepEqual(rows.map((r) => r.n), [11]);
  // The closing `\]` is load-bearing: without it this is also satisfied by the
  // fallback pass's `[unfiltered (fallback)]`, the one tag already pinned above.
  assert.match(stderr, /dropped #10 — to-spec spec, not a ticket \(User Stories heading\) \[unfiltered\]/);
});
test("near misses are kept — the predicate's shape is specified, not accidental", () => {
  // One fixture per dimension the regex commits to. Without these, every
  // loosening of the heading match still passes: the dropped fixture differs
  // from a ticket in all of them at once, so it discriminates none.
  //
  // #65: nesting depth (`### User Stories`) moved OUT of this list — it is no
  // longer a near miss, see the depth test below — and the split-heading
  // fixture moved IN, replacing it as the dimension this list now pins.
  const { rows } = run([
    ticket(2, "## user stories\n\nlowercase\n"),
    ticket(3, "##User Stories\n\nno separating space\n"),
    ticket(4, "## User Stories (draft)\n\ntrailing text\n"),
    ticket(5, "Mentions ## User Stories mid-line, not a heading.\n"),
    // #65: the marker alone on its line, heading text starting the next —
    // `\s` spans the newline so this used to read as the same heading. Kept
    // is the fixed behaviour; `dropped #6` in a future run is the regression.
    ticket(6, "##\nUser Stories\n\nmarker and text on separate lines\n"),
    // #65: both ends of the depth range. `#` is an ordinary ticket's h1 and the
    // floor the regex's own name commits to — loosen `#{2,6}` to `#+` and this
    // is what goes red. `#######` is past CommonMark's six-`#` cap, so it is not
    // a heading at all and must not read as the signature; it pins the ceiling
    // the way #7 below pins that the range does not stop at three.
    ticket(10, "# User Stories\n\nan h1, not the signature depth\n"),
    ticket(11, "####### User Stories\n\nseven hashes, past CommonMark's cap\n"),
  ]);
  assert.deepEqual(rows.map((r) => r.n), [2, 3, 4, 5, 6, 10, 11]);
});

test("a spec heading is dropped at depth two through six, however separated and ended — #65", () => {
  // Why the predicate widened at all — see candidates.mjs's spec-predicate
  // comment. What this test adds is the shape of the range and its edges:
  // `####` pins that it does not stop at three (the near-miss list above pins
  // both ends), and #12/#9/#13 ride the same run to pin what may separate the
  // marker from the text and what may end the line.
  const { rows } = run([
    ticket(1, "### User Stories\n\nnested one level deeper\n"),
    ticket(7, "#### User Stories\n\nnested deeper still\n"),
    // #65: CRLF. `$` under `(?m)` matches BEFORE the `\n`, so the line still
    // ends in `\r` and a trailing class of `[ \t]*` cannot reach the anchor —
    // this body stops matching and the spec leaks, silently, with nothing on
    // stderr. GitHub's web textarea submits CRLF, so it is a real body shape,
    // and this is the only line of defence. Narrow the trailing `\s*` and
    // `dropped #12` is what goes missing.
    ticket(12, "## User Stories\r\n\r\n1. As a user…\r\n"),
    ticket(9, "## User Stories   \n\n1. As a user…\n"),
    // #65: a TAB between marker and text. The class is `[ \t]`, but every other
    // fixture here uses a space, so narrowing it to `[ ]` passed the whole repo
    // suite green — the documented half was asserted in prose and pinned
    // nowhere.
    ticket(13, "##\tUser Stories\n\na tab between marker and text\n"),
    ticket(8, "## What to build\n\nx\n"),
  ]);
  // #8 is a real kept ticket, so this is a POSITIVE assertion: a query that
  // dies outright fails it too, which `deepEqual(…, [])` over a spec-only
  // fixture could not. Every other row above must be absent, and the failure
  // names whichever one leaked.
  assert.deepEqual(rows.map((r) => r.n), [8]);
});

// Dependency-scan tests (#58). The forms below are the ones to-tickets
// actually publishes — see candidates.mjs's `depnums` comment — not the bare
// inline phrasings the OLD regex covered alone.

test("a Blocked-by heading with bulleted refs yields every number, not just the first", () => {
  const { rows } = run([ticket(9, "## Blocked by\n\n- #12\n- #13\n")]);
  assert.deepEqual(rows[0].d, [12, 13]);
});

test("None — can start immediately under a heading yields no dependencies", () => {
  const { rows } = run([ticket(9, "## Blocked by\n\n- None — can start immediately\n")]);
  assert.deepEqual(rows[0].d, []);
});

test("a reference in unrelated prose, not under a blocking declaration, is not a dependency", () => {
  const { rows } = run([ticket(9, "- A reference to #77 blocking ticket\n")]);
  assert.deepEqual(rows[0].d, []);
});

test("the bold-label form yields its number — to-tickets' local-file template writes this, not the issue template", () => {
  const { rows } = run([ticket(9, "**Blocked by:** #12\n")]);
  assert.deepEqual(rows[0].d, [12]);
});

test("the original bare inline phrasings still work, now reduced to numbers rather than matched phrase text", () => {
  const { rows } = run([
    ticket(1, "depends on #5\n"),
    ticket(2, "blocked by #99 inline form\n"),
    ticket(3, "requires #3\n"),
    ticket(4, "after #4\n"),
  ]);
  assert.deepEqual(rows.map((r) => r.d), [[5], [99], [3], [4]]);
});

test("several references on one inline label line are all found, not just the first", () => {
  const { rows } = run([ticket(9, "Blocked by: #12, #13\n")]);
  assert.deepEqual(rows[0].d, [12, 13]);
});

test("a heading section ends at the NEXT heading, blocking or not — a ref past it is not swept in", () => {
  const { rows } = run([ticket(9, "## Blocked by\n\n- #12\n\n## Notes\n\nsee #999 for context\n")]);
  assert.deepEqual(rows[0].d, [12]);
});

test("d holds plain issue numbers, not matched phrase strings", () => {
  const { rows } = run([ticket(9, "depends on #5\n")]);
  assert.deepEqual(rows[0].d, [5]);
  assert.equal(typeof rows[0].d[0], "number");
});

test("an open blocking section reads its list items only — a later prose ref is not a phantom blocker", () => {
  // The section flag closes on the NEXT heading, so a `## Blocked by` that is
  // the last heading in the body stays armed to EOF. Collecting every line
  // there turns "None — can start immediately" plus ordinary notes into a
  // blocker the body never declared, and the consumer (next-ticket step 2)
  // drops the ticket without re-reading the body.
  const { rows } = run([
    ticket(9, "## Blocked by\n\n- None — can start immediately\n\nImplementation notes: mirror what #300 did.\n"),
  ]);
  assert.deepEqual(rows[0].d, []);
});

test("a fenced code sample inside an open blocking section is not swept in", () => {
  const { rows } = run([ticket(9, "## Blocked by\n\n- #12\n\n```\ngit log #999\n```\n")]);
  assert.deepEqual(rows[0].d, [12]);
});

test("both passes are line-local — a phrase whose ref opens the next line is not collected", () => {
  // The removed regex's `\s+` crossed newlines and did collect these. The
  // narrowing is deliberate (see candidates.mjs's `depnums` comment); this
  // pins it so it stays a decision rather than drifting back by accident.
  const { rows } = run([
    ticket(1, "Blocked by:\n#12\n"),
    ticket(2, "This depends on\n#5 landing first\n"),
    ticket(3, "requires\n#7\n"),
  ]);
  assert.deepEqual(rows.map((r) => r.d), [[], [], []]);
});

test("'and' joins refs on an inline label line, the same as a comma", () => {
  const { rows } = run([ticket(9, "Blocked by: #12 and #13\n")]);
  assert.deepEqual(rows[0].d, [12, 13]);
});

test("every declarative phrase arms a heading section, not just 'Blocked by'", () => {
  // Dropping `requires` or `depends on` from the heading alternation left the
  // whole suite green: only `## Blocked by` was ever pinned.
  const { rows } = run([
    ticket(1, "## Requires\n\n- #8\n"),
    ticket(2, "## Depends on\n\n- #9\n"),
  ]);
  assert.deepEqual(rows.map((r) => r.d), [[8], [9]]);
});

test("an `after` HEADING arms nothing — it is narrative, not a declaration", () => {
  // `## After the migration` / `## Before` + `## After` are ordinary ticket
  // prose, unlike the three declarative phrases, which head a section only to
  // declare one. A heading that really does name a blocker still resolves,
  // through the inline pass — `after` stays in that alternation.
  const { rows } = run([
    ticket(1, "## After the migration\n\n- see #77 for background\n"),
    ticket(2, "## Before\n\n- old path\n\n## After\n\n- new path short-circuits, see #12\n"),
    ticket(3, "## After #4 lands\n\n- do the thing\n"),
  ]);
  assert.deepEqual(rows.map((r) => r.d), [[], [], [4]]);
});

test("the label's asterisks may close BEFORE the colon as well as after it", () => {
  // `**Blocked by:** #12` and `**Blocked by**: #12` are both bold labels a
  // human writes; only the first was covered, and the regex group carrying
  // the second could be deleted with the whole suite still green.
  const { rows } = run([ticket(9, "**Blocked by**: #12\n")]);
  assert.deepEqual(rows[0].d, [12]);
});

test("a bolded REF yields its number — whitespace and asterisks interleave freely between label and ref", () => {
  // #439: the asterisk groups used to sit ahead of the separating whitespace,
  // so only asterisks flush against the label matched. Markdown puts them on
  // the other side of the space, on the ref — which is what #208's brief
  // wrote, and the scan then read that whole section as no dependency at all.
  const { rows } = run([
    ticket(1, "Blocked by **#179** (decides gone shape)\n"),
    ticket(2, "blocked by **#178**\n"),
    ticket(3, "Depends on **#5**\n"),
    ticket(4, "Blocked by: **#12**\n"),
    ticket(5, "**Blocked by:** **#12**\n"),
    ticket(6, "Blocked by *#12*\n"),
    ticket(7, "**Blocked by** : #12\n"),
  ]);
  assert.deepEqual(rows.map((r) => r.d), [[179], [178], [5], [12], [12], [12], [12]]);
});

test("a bolded ref AFTER the first one still joins the run — asterisks interleave between refs too", () => {
  // #439's residual, found reviewing the fix: the separator between the label
  // and the first ref was widened, the continuation between refs was not, so
  // the second ref's leading `**` ended the run and the number was dropped —
  // no error, no warning, the same wrong admission #439 was filed for, one ref
  // to the right. Revert the continuation and every row here reds.
  const { rows } = run([
    ticket(1, "Blocked by **#12** and **#13**\n"),
    ticket(2, "Blocked by: **#12**, **#13**\n"),
    ticket(3, "Blocked by #12 and **#13**\n"),
    ticket(4, "Depends on **#5**, #6\n"),
  ]);
  assert.deepEqual(rows.map((r) => r.d), [[12, 13], [12, 13], [12, 13], [5, 6]]);
});

test("a noun-form Dependencies heading arms a section, at any heading depth and with a trailing colon", () => {
  // #439's second, independent miss: the gate named the verb forms only, so
  // the heading #208's brief actually used opened nothing, and the list-item
  // branch never engaged either. Both routes into that section failed.
  const { rows } = run([
    ticket(1, "## Dependencies\n\n- #12\n- #13\n"),
    ticket(2, "## Dependency\n\n- #12\n"),
    ticket(3, "### Dependencies:\n\n- #12\n"),
    ticket(4, "###### Dependencies\n\n- #12\n"),
  ]);
  assert.deepEqual(rows.map((r) => r.d), [[12, 13], [12], [12], [12]]);
});

test("a bolded dependency heading arms its section — emphasis is not a different heading", () => {
  // #1031: the gate admitted no emphasis at all, so `## **Dependencies**` armed
  // NO section and every ref its bullets declared was dropped — exit 0, nothing
  // on stderr, the same silent wrong admission #439 was filed for — reached
  // through the heading gate rather than through the inline label separator
  // #439 widened. Both emphasis runs are load-bearing: markdown
  // closes the bold either before the colon (`**Dependencies**:`) or after it
  // (`**Dependencies:**`), and the run is `*`, `**` or `***` depending on
  // whether the author wanted italic, bold or both. Substitute the
  // `\*{0,2}` pair the ticket hypothesised — one leading run, one ahead of the
  // colon and none after it — and rows 5 and 8 red, on both engines.
  const { rows } = run([
    ticket(1, "## **Dependencies**\n\n- #12\n- #13\n"),
    ticket(2, "## **Blocked by**\n\n- #12\n"),
    ticket(3, "## **Depends on**\n\n- #9\n"),
    ticket(4, "## **Requires**\n\n- #8\n"),
    ticket(5, "## **Dependencies:**\n\n- #12\n"),
    ticket(6, "## **Dependencies**:\n\n- #12\n"),
    ticket(7, "## *Dependencies*\n\n- #12\n"),
    ticket(8, "## ***Dependencies***\n\n- #12\n"),
    ticket(9, "###### **Dependency**\n\n- #12\n"),
  ]);
  assert.deepEqual(
    rows.map((r) => r.d),
    [[12, 13], [12], [9], [8], [12], [12], [12], [12], [12]],
  );
});

test("the noun form arms only when it is the WHOLE heading — bolded or not, a Dependency-injection section is prose", () => {
  // The verb forms end at `\b` and tolerate trailing text, because a heading
  // opening with `Blocked by` declares one whatever follows it. The noun form
  // cannot afford that: `## Dependency injection` is an ordinary section title
  // in a code repo, and arming on it turns every `#N` in its bullets into a
  // blocker the body never declared, starving the ticket out of the queue —
  // the same over-fire the list-item restriction exists to prevent. Anchoring
  // the noun alternative to end-of-line is what keeps these three closed;
  // widen it to `\b` like its neighbours and this test is what reds.
  //
  // The bolded halves are #1031's other side: emphasis tolerance is added
  // AROUND that anchor, never by relaxing it, so the run of asterisks must not
  // smuggle in the prefix match the anchor exists to refuse. The runs match
  // ASTERISKS only, which is what keeps ` injection` outside them — spell
  // either one as a general wildcard (`.*`) and all six rows arm, silently
  // inventing #300 as a blocker on every DI section in the queue.
  const { rows } = run([
    ticket(1, "## Dependency injection\n\n- rework the container, see #300\n"),
    ticket(2, "## Dependencies (blocking)\n\n- #300\n"),
    ticket(3, "## Dependency injection:\n\n- see #300\n"),
    ticket(4, "## **Dependency injection**\n\n- rework the container, see #300\n"),
    ticket(5, "## **Dependencies (blocking)**\n\n- #300\n"),
    ticket(6, "## **Dependency injection:**\n\n- see #300\n"),
  ]);
  assert.deepEqual(rows.map((r) => r.d), [[], [], [], [], [], []]);
});

test("#208's own brief text yields both of the open blockers it declared in prose", () => {
  // The live wrong admission #439 was filed from: this section reduced to no
  // dependency at all, so a ticket with two open blockers reached the survivor
  // read as claimable. What this fixture pins is the noun-form heading half:
  // its bolded refs sit on list-item lines inside the armed section, so the
  // list-item branch reads them whatever the label separator does — revert
  // that separator to its pre-#439 form and this row stays green, while
  // reverting the heading gate to the verb forms is what reds it. The
  // separator half is pinned by the two bolded-ref tests above instead.
  // The `PR #390` bullet is collected too: in-section collection reads every
  // `#N` on a list-item line by construction, and a merged ref is inert at the
  // consumer, which drops a ticket only for a blocker that is still open.
  const { rows } = run([
    ticket(208, [
      "## Dependencies",
      "",
      "- Blocked by **#179** (decides `gone()`'s shape, which `Indeterminate` needs), which is itself blocked by **#178**.",
      "- Vocabulary from **PR #390**.",
      "",
      "Recording those as native dependency edges so the fleet does not claim this early.",
      "",
    ].join("\n")),
  ]);
  assert.deepEqual(rows[0].d, [178, 179, 390]);
});

test("the phantom-blocker sweep stays closed against the widened label and heading gates", () => {
  // PR #331 closed these by restricting in-section collection to list-item
  // lines. #439 loosens the label separator and widens the heading gate,
  // neither of which touches that restriction — this pins that they did not,
  // because a regex widened for bold is exactly the change that reopens them.
  // The noun-form rows carry the same shapes through the newly-armed heading,
  // and #1031's bolded rows carry them once more through the emphasis the gate
  // tolerates next: a section armed by `## **Dependencies**` reads its LIST ITEMS
  // only, exactly as the unbolded one does, so the prose ref in row 8 and the
  // fenced one in row 9 stay out of `d`. Widening the gate does not widen what
  // an armed section then sweeps, and that is the half this re-run pins.
  const { rows } = run([
    ticket(1, "## Blocked by\n\nSee #99 for context\n"),
    ticket(2, "## Blocked by\n\n- #1\n\nSome later text mentioning #42\n"),
    ticket(3, "```\nfixes #77\n```\n"),
    ticket(4, "## Dependencies\n\n- #12 and then\n  more about #999\n"),
    ticket(5, "## Dependencies\n\nSee #99 for context\n"),
    ticket(6, "## Dependencies\n\n- #12\n\n```\ngit log #999\n```\n"),
    ticket(7, "## **Dependencies**\n\n- #12 and then\n  more about #999\n"),
    ticket(8, "## **Blocked by**\n\nSee #99 for context\n"),
    ticket(9, "## **Dependencies**\n\n- #12\n\n```\ngit log #999\n```\n"),
    ticket(10, "## **Dependencies**\n\n- None — can start immediately\n\nMirror what #300 did.\n"),
  ]);
  assert.deepEqual(
    rows.map((r) => r.d),
    [[], [1], [], [12], [], [12], [12], [], [12], []],
  );
});

// The gap #63 named: the STUB above execs system jq (Oniguruma), but gh
// applies `--jq` with its embedded gojq (RE2) — a different engine, and every
// other test in this file accepts that gap rather than closing it. This one
// closes it for the dependency scan specifically, since #58 asks for it by
// name: when a real `gojq` binary is reachable (`go install
// github.com/itchyny/gojq/cmd/gojq@v0.12.19`), the STUB runs the fixtures
// through it instead of system jq, so the regex is checked against the exact
// engine gh uses — not merely a same-family stand-in. No `gojq` on this
// machine → skip, loudly, rather than silently passing on the weaker engine.
// Answering `--version` is not the same as BEING gojq: system jq answers it
// too, and resolving to it would run the fixtures on Oniguruma under a name
// claiming RE2 — the silent degrade this whole check exists to refuse. gojq
// prints `gojq 0.12.19 (rev: …)`, jq prints `jq-1.7.1-apple`.
const isGojq = (bin) =>
  /^gojq /.test(spawnSync(bin, ["--version"], { encoding: "utf8" }).stdout ?? "");

function findGojq() {
  const named = process.env.GOJQ_BIN;
  // A caller who names the binary asked for that engine. Falling back past it
  // would run the check on something else and still report the gojq test green.
  if (named && !isGojq(named)) throw new Error(`GOJQ_BIN=${named} is not gojq`);
  if (named) return named;
  if (isGojq("gojq")) return "gojq";
  // No `go` on PATH → spawnSync fails ENOENT and `stdout` is undefined, not "".
  // Without `?.` this throws at import, taking every test in the file with it —
  // the opposite of the loud skip the comment above promises.
  const gopath = spawnSync("go", ["env", "GOPATH"], { encoding: "utf8" }).stdout?.trim();
  if (!gopath) return null;
  const candidate = join(gopath, "bin", "gojq");
  return isGojq(candidate) ? candidate : null;
}
const GOJQ = findGojq();
const SKIP_WITHOUT_GOJQ = { skip: GOJQ ? false : "no gojq on PATH — go install github.com/itchyny/gojq/cmd/gojq@v0.12.19 to run this check" };

test(
  "dependency forms hold under gojq, the engine gh actually applies — not only system jq",
  SKIP_WITHOUT_GOJQ,
  () => {
    const extraEnv = { JQ_BIN: GOJQ };
    // gojq REJECTING the program is the failure this test exists to catch. Read
    // the exit status first: `rows[0]` is undefined the moment the child exits
    // non-zero, so without this the report is `Cannot read properties of
    // undefined (reading 'd')`, naming neither gojq nor the refusal it printed.
    const deps = (body) => {
      const r = run([ticket(9, body)], undefined, null, extraEnv);
      assert.equal(r.status, 0, r.stderr);
      return r.rows[0].d;
    };
    assert.deepEqual(deps("## Blocked by\n\n- #12\n- #13\n"), [12, 13]);
    assert.deepEqual(deps("## Blocked by\n\n- None — can start immediately\n"), []);
    assert.deepEqual(deps("- A reference to #77 blocking ticket\n"), []);
    assert.deepEqual(deps("**Blocked by:** #12\n"), [12]);
    assert.deepEqual(deps("depends on #5\n"), [5]);
    assert.deepEqual(deps("Blocked by: #12, #13\n"), [12, 13]);
    assert.deepEqual(deps("## Blocked by\n\n- #12\n\n## Notes\n\nsee #999 for context\n"), [12]);
    // #439's two forms, on the engine that produced the live wrong admission.
    assert.deepEqual(deps("Blocked by **#179**\n"), [179]);
    assert.deepEqual(deps("Blocked by: **#12**\n"), [12]);
    assert.deepEqual(deps("Blocked by **#12** and **#13**\n"), [12, 13]);
    assert.deepEqual(deps("Blocked by: **#12**, **#13**\n"), [12, 13]);
    assert.deepEqual(deps("**Blocked by** : #12\n"), [12]);
    assert.deepEqual(deps("## Dependencies\n\n- #12\n- #13\n"), [12, 13]);
    assert.deepEqual(deps("## Dependency injection\n\n- see #300\n"), []);
    assert.deepEqual(deps("## Blocked by\n\nSee #99 for context\n"), []);
    // #1031's widened heading gate, on the engine gh actually applies. The
    // emphasis runs are plain `\*`, which Oniguruma and RE2 spell alike — so
    // these rows are expected to AGREE with the system-jq fixtures above, and
    // exist to confirm that rather than because a divergence was found. The
    // negative rows matter most here: RE2 has no backtracking, so a `$` anchor
    // reached through a widened alternation is exactly where the two engines
    // could have parted, and `## **Dependency injection**` arming under gojq
    // alone would be invisible to every other test in this file.
    assert.deepEqual(deps("## **Dependencies**\n\n- #12\n- #13\n"), [12, 13]);
    assert.deepEqual(deps("## **Blocked by**\n\n- #12\n"), [12]);
    assert.deepEqual(deps("## **Dependencies:**\n\n- #12\n"), [12]);
    assert.deepEqual(deps("## ***Dependencies***\n\n- #12\n"), [12]);
    assert.deepEqual(deps("## **Dependency injection**\n\n- see #300\n"), []);
    assert.deepEqual(deps("## **Dependency injection:**\n\n- see #300\n"), []);
    assert.deepEqual(deps("## **Dependencies (blocking)**\n\n- #300\n"), []);
    assert.deepEqual(deps("## **Dependencies**\n\nSee #99 for context\n"), []);
    // The discriminator, and the only assertion here system jq cannot satisfy:
    // `\s` is Unicode-aware in Oniguruma and ASCII-only in RE2, so a U+00A0
    // between label and ref reduces to [12] under jq and [] under gojq. Without
    // it every assertion above passes on either engine — deleting the STUB's
    // `JQ_BIN` plumb would leave this test green having never reached gojq.
    // Keep the `\u00a0` escape: a literal NBSP does not survive being copied.
    assert.deepEqual(deps("Blocked by:\u00a0#12\n"), []);
    // #439 widened that separator to `[\s*]*` but kept `\s` rather than an
    // explicit ASCII class (#383 owns that question), so the bolded form
    // inherits the same split: [12] under Oniguruma, [] under RE2. Keep the
    // `\u00a0` escape here too — a literal NBSP does not survive being copied.
    assert.deepEqual(deps("Blocked by:\u00a0**#12**\n"), []);
  },
);

// #65: the spec predicate's decisions, checked against gojq specifically —
// gojq is what gh applies, so gojq is where a leak would actually happen.
// The first three fixtures are plain ASCII (`#`, `[ \t]`, `\r`), so none of
// them is expected to diverge between engines; they exist to confirm that,
// not because a divergence was found — space, tab and `\r` are all `\s` in
// both engines. The predicate's trailing `\s*` is #65's own doing: b4739c8
// widened it back from `[ \t]*` so a CRLF line's `\r` still reaches the
// anchor, which is the only reason the third fixture matches at all — narrow
// that class and the CRLF assertion is what reds. It is also the one
// position that CAN diverge: `\s` is Unicode-aware in Oniguruma and
// `[\t\n\f\r ]` in RE2 — not every ASCII whitespace, a vertical tab
// diverges too — so a heading padded with trailing U+00A0 is a spec under jq
// and not under gojq, and in production that spec leaks as a claimable
// ticket rather than being dropped. #204 adds that case below as the
// discriminator, closing for THIS predicate the gap #331 already closed for
// the dependency scan's — see this file's header.
test(
  "the spec predicate holds under gojq — depth widened, split heading not spanned, CRLF caught",
  SKIP_WITHOUT_GOJQ,
  () => {
    const extraEnv = { JQ_BIN: GOJQ };
    // #9 is the body under test; #999 keeps the queue non-empty either way, so
    // a passing run always exits 0 and #9's presence/absence in rows is what
    // reads the verdict — dropSpecs strips the `spec` field from surviving rows.
    const isDroppedAsSpec = (body) => {
      const r = run(
        [ticket(9, body), ticket(999, "## What to build\n\nx\n")],
        undefined,
        null,
        extraEnv,
      );
      assert.equal(r.status, 0, r.stderr);
      return !r.rows.some((row) => row.n === 9);
    };
    assert.equal(isDroppedAsSpec("### User Stories\n\nnested one level deeper\n"), true);
    assert.equal(isDroppedAsSpec("##\nUser Stories\n\nsplit across lines\n"), false);
    assert.equal(isDroppedAsSpec("## User Stories\r\n\r\n1. As a user…\r\n"), true);
    // The discriminator, and the only assertion here system jq cannot
    // satisfy: `\s` is Unicode-aware in Oniguruma and ASCII-only in RE2, so a
    // trailing U+00A0 after the heading text reduces to spec:true under jq
    // and spec:false under gojq. Without it every assertion above passes on
    // either engine — deleting the STUB's `JQ_BIN` plumb would leave this
    // test green having never reached gojq. `false` is gojq's answer, i.e.
    // production's — NOT a ruling that a heading padded with U+00A0 should
    // read as a ticket rather than a spec; #383 owns that question and may
    // flip it. Keep the `\u00a0` escape: a literal NBSP does not survive
    // being copied, and has already produced a false refutation of a correct
    // finding in this repo (#200).
    assert.equal(isDroppedAsSpec("## User Stories\u00a0\n\nx\n"), false);
  },
);

test("the cap is checked before specs are dropped — filtering first hides truncation", () => {
  // The ordering candidates.mjs calls load-bearing. Swap the two and this is
  // the only thing that fails: dropSpecs shrinks the array below --limit, the
  // cap check stops seeing a capped list, and the silent-truncation bug the
  // "no silent caps" rule exists to close comes back with every test green.
  const { status, stderr } = run(
    [
      ticket(10, "## User Stories\n\n1. As a user…\n"),
      ticket(11, "## What to build\n\nx\n"),
    ],
    ["--require-label", "ready-for-agent", "--limit", "2"],
  );
  assert.equal(status, 2);
  assert.match(stderr, /capped/);
});

test("a labeled queue of only specs falls back to unfiltered — all filtered out is an empty queue", () => {
  // The emptiness test gating --allow-fallback has to read the length AFTER
  // the specs are dropped. Reading the raw one leaves a ready-for-agent queue
  // holding nothing but to-spec specs reporting "no work" with the fallback
  // untried, while #12 sits there claimable.
  const { rows, status, stderr } = run(
    [
      ticket(10, "## Problem Statement\n\nx\n\n## User Stories\n\n1. As a user…\n"),
      ticket(11, "## User Stories\n\n2. As a user…\n"),
    ],
    ["--require-label", "ready-for-agent", "--allow-fallback"],
    [
      ticket(12, "## What to build\n\nreal work\n", ["ready-for-human"]),
      // A spec HERE is what makes the assertion below discriminate: delete the
      // strip inside the fallback and #13 ships as a claimable ticket. A leaked
      // spec passes phase 2's bail tests, so a member implements a whole spec.
      ticket(13, "## User Stories\n\n4. As a user…\n", ["ready-for-human"]),
    ],
  );
  assert.deepEqual(rows.map((r) => r.n), [12]);
  // The BRANCH ran, not merely that the unfiltered fixture reached some query.
  // Move the positive term to the front of `search` and the stub serves the
  // LABELED query the unfiltered fixture: same payload, same status, fallback
  // never entered. The payload alone pins the fixture, never the branch.
  assert.match(stderr, /retrying unfiltered/);
  // Each pass's drop line is attributable to the query it came from. Swap the
  // two dropSpecs call-site labels and both lines still print, both still name
  // a real spec, and nothing else in this file notices — these two asserts are
  // what tell pass 1's drop from pass 2's. Deliberately not a count: drops are
  // not deduplicated across passes (candidates.mjs's dropSpecs, #133), so a raw
  // `grep -c 'dropped #'` reads 4 here whether or not the tags are present.
  assert.match(stderr, /dropped #10 — to-spec spec, not a ticket \(User Stories heading\) \[label:ready-for-agent\]/);
  assert.match(stderr, /dropped #13 — to-spec spec, not a ticket \(User Stories heading\) \[unfiltered \(fallback\)\]/);
  // Two queries actually RAN. The announcement above prints before the query,
  // so it pins the branch being entered, never that its answer shipped.
  assert.equal(stderr.match(/^\$ gh /gm).length, 2);
  // The strip inside the block ran. Delete that line and every assertion above
  // still passes while `spec` — and any spec row — reaches the payload.
  assert.deepEqual(Object.keys(rows[0]).sort(), ["d", "l", "n", "t"]);
  // Exit 0, not 1: the payload and the "is there work" answer are one fact,
  // and a caller that reads only the status must not still hear "empty".
  assert.equal(status, 0);
});

test("the cap is checked before specs are dropped in the fallback too, not only in the labeled query", () => {
  // The cap-before-drop ordering of "the cap is checked before specs are
  // dropped", one branch deeper — NOT the drop-before-emptiness test directly
  // above, which pins the other half of the same wedge. The labeled query is
  // under its cap on 1 row, empties out, and hands over to the fallback —
  // whose 2 rows hit --limit 2 exactly. Drop first and one spec leaves, the
  // cap check sees 1, and the truncated list ships as an answer.
  const { status, stderr } = run(
    [ticket(10, "## User Stories\n\n1. As a user…\n")],
    ["--require-label", "ready-for-agent", "--allow-fallback", "--limit", "2"],
    [
      ticket(12, "## User Stories\n\n3. As a user…\n", ["ready-for-human"]),
      ticket(13, "## What to build\n\nx\n", ["ready-for-human"]),
    ],
  );
  assert.equal(status, 2);
  // Pin which query refused. `/capped/` alone is satisfied by the labeled
  // query dying, which is a different bug with the same exit code.
  assert.match(stderr, /unfiltered \(fallback\)/);
});

test("the spec predicate never reaches the payload — it is pure token cost downstream", () => {
  const { rows } = run([ticket(12, "## What to build\n\nplain ticket\n")]);
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ["d", "l", "n", "t"]);
});

// `$ gh …` is echoed by query() before every invocation, so its absence is how
// these pin that the refusal came BEFORE any query ran. Status 2 alone does not:
// a query that ran and then died still exits 2, and for --require-label the
// query that runs is the widening one the whole file exists to prevent.
const queriesRun = (stderr) => (stderr.match(/^\$ gh /gm) ?? []).length;

test("a trailing --limit refuses — an absent value is not a licence to use the default", () => {
  const { status, stderr } = run(
    [ticket(11, "## What to build\n\nx\n")],
    ["--require-label", "ready-for-agent", "--limit"],
  );
  assert.equal(status, 2);
  // Not 0-with-500-rows. `arg()` handed back `undefined`, `?? 500` read that as
  // "flag absent", and the positive-integer guard never saw the malformed input
  // it exists to catch.
  assert.equal(queriesRun(stderr), 0);
});

test("a trailing --require-label refuses — a falsy label runs the query --allow-fallback exists to gate", () => {
  const { status, stderr } = run([ticket(11, "## What to build\n\nx\n")], ["--require-label"]);
  // The worst of the three: query() reads a falsy label as "no label", so the
  // UNFILTERED query shipped at exit 0 — the exact widening onto ready-for-human
  // that run-team/SKILL.md's "do NOT pass `--allow-fallback`" prevents, reached
  // without the flag. Asserting the status alone would pass on a run that
  // widened and then happened to die.
  assert.equal(queriesRun(stderr), 0);
  assert.equal(status, 2);
});

test("a --require-label whose value is the next flag refuses — it reaches the same widening", () => {
  // Same harm as the trailing case, one keystroke away: `--allow-fallback` is
  // consumed as the label, `label:--allow-fallback` matches nothing, and the
  // empty result hands straight over to the unfiltered fallback at exit 0.
  const { status, stderr } = run([ticket(11, "## What to build\n\nx\n")], ["--require-label", "--allow-fallback"]);
  assert.equal(queriesRun(stderr), 0);
  assert.equal(status, 2);
});

test("a --require-label whose value is empty refuses — an unset shell variable is not 'no label'", () => {
  // The likeliest spelling of all of them, and the only one the caller cannot
  // see: `--require-label "$LABEL"` with the variable unset leaves an empty
  // argv slot, not a missing one. `""` is falsy, so query() dropped the label
  // term and ran the UNFILTERED search at exit 0 — and stderr said
  // `N candidate(s)` with no label suffix, indistinguishable from a clean run.
  const { status, stderr } = run([ticket(11, "## What to build\n\nx\n")], ["--require-label", ""]);
  assert.equal(queriesRun(stderr), 0);
  assert.equal(status, 2);
});

test("a --require-label=value refuses — indexOf cannot see the = form, so the flag reads as absent", () => {
  // Not the same route as the three above: `indexOf("--require-label")` misses
  // `--require-label=x` entirely, so arg() returned null — "flag absent" — and
  // the unfiltered query ran at exit 0 with the label the caller did pass.
  const { status, stderr } = run(
    [ticket(11, "## What to build\n\nx\n")],
    ["--require-label=ready-for-agent"],
  );
  assert.equal(queriesRun(stderr), 0);
  assert.equal(status, 2);
});

test("an unknown flag refuses and names it — a flag that is merely ignored runs unfiltered", () => {
  // `--label ready-for-agent` is not an invented typo: it is what run-team's
  // phase 0 rule said, one line under a command spelling it `--require-label`.
  // Ignored, the label term never reaches gh, so the ready-for-human queue
  // ships at exit 0 — the widening `--require-label` exists to prevent, reached
  // by following this repo's own instruction.
  const { status, stderr } = run(
    [ticket(11, "## What to build\n\nx\n")],
    ["--label", "ready-for-agent"],
  );
  assert.equal(queriesRun(stderr), 0);
  assert.equal(status, 2);
  // The flag has to be NAMED. A bare "bad arguments" leaves the caller — markdown
  // read by a model, with no way to see the script — re-guessing its own spelling.
  // Line-anchored, per die()'s leading newline.
  assert.match(stderr, /^candidates: Unknown option '--label'/m);
});

// The test above is satisfied by a guard that only works when the bad flag is
// FIRST, which is what shipped: the catch tested
// `e.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION"` and dropped every other
// parseArgs error. That is not a narrower guard but a disabled one. parseArgs
// stops at the FIRST offending argument, so an argument raising any other code
// was swallowed and the unknown flag behind it was never reached — the query
// then ran UNFILTERED at exit 0, which is the whole harm #173 exists to stop.
//
// Rows 1-2 are the two masking arguments on their own; rows 3-4 put a real
// `--label` BEHIND each of them, which is the shape the code test let through
// and the one no other test in this file covers. All four must refuse before
// any query — `status` alone is not enough, since exit 2 is also what a broken
// query produces after gh has already run.
//
// Rows 2 and 4 no longer reach parseArgs at all: #364 gave has() its own `=`
// guard, evaluated when `allowFallback` is assigned — above and long before
// the parseArgs call below — so the boolean case now dies with has()'s own
// boolean-specific wording (distinct from arg()'s "needs a space-separated
// value", since a boolean has no value to take), never Node's "does not take
// an argument". That does NOT make `ERR_PARSE_ARGS_INVALID_OPTION_VALUE` dead
// here, and an earlier draft of this comment claimed it did: arg()'s own `=`
// guard is indexOf-gated, firing only when the bare spelling is absent, so a
// REPEATED string flag whose later occurrence carries no value sails past both
// guards into parseArgs — measured, `--limit 5 --limit` raises exactly that
// code, with Node's wording (#462 review). The catch stays unconditional for
// that reason among others. The loop still refuses before any query and still
// names the offending flag, which is the property that matters; only the
// source moved.
for (const [what, args, refusal] of [
  [
    "a bare positional",
    ["ready-for-agent"],
    /^candidates: Unexpected argument 'ready-for-agent'\./m,
  ],
  [
    "a boolean flag handed a =value",
    ["--allow-fallback=true"],
    /^candidates: --allow-fallback is a boolean flag, not --allow-fallback=/m,
  ],
  [
    "an unknown flag behind a positional",
    ["junk", "--label", "ready-for-agent"],
    /^candidates: Unexpected argument 'junk'\./m,
  ],
  [
    "an unknown flag behind a =value boolean",
    ["--allow-fallback=true", "--label", "ready-for-agent"],
    /^candidates: --allow-fallback is a boolean flag, not --allow-fallback=/m,
  ],
]) {
  test(`${what} refuses before any query — every parseArgs error is a refusal, not just the unknown-name one`, () => {
    const { status, stderr } = run([ticket(11, "## What to build\n\nx\n")], args);
    assert.equal(queriesRun(stderr), 0);
    assert.equal(status, 2);
    // The refusal has to name the OFFENDING argument, not merely the accepted
    // set: parseArgs reports the first offender, and a caller told only "bad
    // arguments" cannot tell which of its four tokens was wrong.
    assert.match(stderr, refusal);
  });
}

// Pre-#364, `--allow-fallback=<value>` was silently IGNORED rather than merely
// unchecked: `has()` compared exactly, so no `=` form ever matched and the
// fallback was disabled without a word. The fixtures below are the arrangement
// that showed it — the labeled query comes back empty and the unfiltered one
// has a row — so the flag was the only thing standing between exit 1 and exit
// 0. Measured on the pre-fix version, all three spellings here exited 1
// ("queue empty, query fine") for a run that never applied the flag it was
// handed, while the space-separated spelling exited 0 off the fallback.
// `notEqual(1)` is the load-bearing assertion, not decoration: it pins the
// exact wrong code the ignored form used to produce, now unreachable — has()
// refuses this argv outright, before `allowFallback` is even assigned. All
// three spellings are the ones the ticket's acceptance criteria name.
for (const v of ["=true", "=false", "="]) {
  test(`--allow-fallback${v} refuses outright, rather than being silently dropped and falling through`, () => {
    const { status, stderr } = run(
      [],
      ["--require-label", "nonexistent", `--allow-fallback${v}`],
      [ticket(12, "## What to build\n\ny\n", ["ready-for-human"])],
    );
    assert.equal(queriesRun(stderr), 0);
    assert.notEqual(status, 1);
    assert.equal(status, 2);
    assert.match(stderr, /^candidates: --allow-fallback is a boolean flag, not --allow-fallback=/m);
  });
}

// The control for the test above. Without it, "refuses the = form" is equally
// satisfied by a guard that refuses `--allow-fallback` in every spelling, which
// would break the one caller that legitimately passes it
// (next-ticket/SKILL.md's `## 1. Candidates` step). Same fixtures,
// space-separated: the fallback has
// to run and ship the unfiltered row at exit 0.
test("--allow-fallback still falls back in its space-separated spelling — the = refusal is not a blanket one", () => {
  const { status, stderr, rows } = run(
    [],
    ["--require-label", "nonexistent", "--allow-fallback"],
    [ticket(12, "## What to build\n\ny\n", ["ready-for-human"])],
  );
  assert.equal(queriesRun(stderr), 2);
  assert.equal(status, 0);
  assert.deepEqual(rows.map((r) => r.n), [12]);
});

// The parseArgs call sits BELOW the value guards so their wording wins wherever
// both would refuse, and ORDER is the only thing that decides that. Node's
// message for this same argv is "Option '--require-label <value>' argument
// missing", which names the syntax; #169's names the flag the way every other
// refusal in this file does. Anchored at both ends so the suffix parseArgs'
// branch appends cannot satisfy it.
test("--require-label with no value keeps #169's wording — the name check runs after the value guards", () => {
  const { status, stderr } = run([ticket(11, "## What to build\n\nx\n")], ["--require-label"]);
  assert.equal(queriesRun(stderr), 0);
  assert.equal(status, 2);
  assert.match(stderr, /^candidates: --require-label needs a value$/m);
});

test("gh output that is not an array refuses — a reduction that did not apply is not an empty queue", () => {
  const { status, stderr } = run(
    [ticket(11, "## What to build\n\nx\n")],
    ["--require-label", "ready-for-agent"],
    null,
    { JQ_OVERRIDE: '{message:"Not Found"}' },
  );
  // 2, not 1. Unchecked, the object flows on and the first use of it throws —
  // and an uncaught throw exits 1, the code reserved for "successful query, no
  // survivors". A caller reading only the status hears "there is no work".
  assert.equal(status, 2);
  // Anchored on the die() prefix: `--jq` also appears in the echoed `$ gh` line,
  // so an unanchored /--jq/ passes on a run that never refused at all.
  assert.match(stderr, /^candidates: .*--jq/m);
});

test("gh output that is empty refuses — the reduction emits an array for every input, including none", () => {
  // The one shape the checks below cannot see, because it never reaches the
  // parse. `[…]`-wrapped, the expression emits `[]` for an empty list, so no
  // output at all means it did not run — the same fact as a wrong shape, and
  // NOT an empty queue. Returning `[]` here spent that on exit 1, "no work".
  const { status, stderr } = run(
    [ticket(11, "## What to build\n\nx\n")],
    ["--require-label", "ready-for-agent"],
    null,
    { JQ_OVERRIDE: "empty" },
  );
  assert.equal(status, 2);
  assert.match(stderr, /^candidates: .*--jq/m);
});

test("gh rows that were never reduced refuse — raw issues are not {n,t,l,d,spec}", () => {
  // What a gh that ignored `--jq` actually returns: the unreduced `--json`
  // payload. An array, so an array check alone passes it through.
  const { status, stderr } = run(
    [ticket(11, "## What to build\n\nx\n")],
    ["--require-label", "ready-for-agent"],
    null,
    { JQ_OVERRIDE: "." },
  );
  assert.equal(status, 2);
  assert.match(stderr, /^candidates: .*--jq/m);
  // The refusal names the row by index and never prints it. This is the one
  // payload-shaped stderr path in the file, and an unreduced row carries the
  // full issue body — the ~97% this script exists to not fetch. Without this,
  // a die() that interpolated the row instead of its index kept the whole
  // suite green while emitting every body it refused to pull.
  assert.doesNotMatch(stderr, /What to build/);
});

test("a failed gh query refuses without re-emitting gh's own stderr", () => {
  // A program jq cannot compile: it exits non-zero, so execFileSync throws and
  // the fail-closed die() runs. jq echoes the offending program in its own
  // error, which is the marker below.
  const { status, stderr } = run(
    [ticket(11, "## What to build\n\nx\n")],
    ["--require-label", "ready-for-agent"],
    null,
    { JQ_OVERRIDE: "MARKER_ZZZ(((" },
  );
  // 2, not 1: a broken query is not an empty queue — the archetypal fail-closed
  // path, and the one die() in query() that had no test at all.
  assert.equal(status, 2);
  // Both halves of the contract, and neither is a count over the whole stream.
  // Counting occurrences looks like the tighter pin but is coupled to jq's
  // choice of error path: `(((` is unbalanced, so jq takes the SYNTAX-error
  // branch, which echoes the program once. Balanced `MARKER_ZZZ` takes the
  // undefined-function branch, which names the symbol AND echoes the program —
  // two occurrences from the child alone, failing an exactly-1 assertion
  // against correct code.
  //
  // So: the child's copy must arrive (execFileSync forwards it), and the
  // refusal line must not carry it a second time (#176 — measured 7,700 B of
  // gh stderr becoming 15,454 B, into a caller that is markdown read by a
  // model). The same duplication this file's row-shape refusal already avoids.
  assert.match(stderr, /MARKER_ZZZ/);
  const refusal = stderr.match(/^candidates: .*$/m)[0];
  assert.match(refusal, /^candidates: gh issue list failed/);
  assert.doesNotMatch(refusal, /MARKER_ZZZ/);
});

test("the exit code survives a gh stderr larger than the pipe buffer — the case that motivated it", () => {
  // The failure mode the fix targets, at the size it actually happens. Once
  // ~64 KiB of gh's forwarded stderr is already queued on a pipe, this fd is
  // non-blocking and die()'s own writeSync can throw EAGAIN. Unfixed, that
  // throw is uncaught: process.exit(2) never runs and the process falls
  // through to exit 1 — "query fine, queue empty", the wrong fact (#299).
  // Under the buffer every variant passes, so the program must stay large.
  //
  // Flaky by nature — it races the pipe reader — so it's pinned by repeated
  // runs under Linux (this repo's CI target), not by a single local pass:
  // unfixed, 7/15 runs inverted to exit 1; fixed, 0/20 did, 1000+ msgs run.
  // On darwin EAGAIN never fires at all — unfixed, the status assertion below
  // caught the revert 0/15 — so a local green confirms nothing and the source
  // pin at the end is the only gate on this platform.
  //
  // Text, not just status: this only asserts the EXIT CODE, not the refusal
  // wording. `die()`'s catch swallows the write failure to keep exit 2, so
  // under the exact EAGAIN this test forces, the message CAN still be lost —
  // recovering it needs a retry loop, and #299 puts that out of scope.
  const { status, stderr } = run(
    [ticket(11, "## What to build\n\nx\n")],
    ["--require-label", "ready-for-agent"],
    null,
    { JQ_OVERRIDE: `${"z".repeat(100_000)}(((` },
  );
  assert.ok(stderr.length > 60_000, `gh stderr must exceed the buffer, got ${stderr.length}`);
  assert.equal(status, 2);
  // The guard's SHAPE, deterministically — the assertion above is the race.
  // Stripped first, and this is not optional: against raw source a `die()`
  // genuinely reverted to console.error with the good shape parked in a block
  // comment passes 375/375 (measured), because a `^…/m` anchor matches inside
  // the comment. Dropping this pin also drops the only pin on #176, which is
  // what the refusal-text assertion this test used to carry was doing.
  //
  // #367 moved die() into arg.mjs's makeDie() — candidates.mjs's own source no
  // longer contains the try/catch shape, so a lift pin against SCRIPT alone
  // would now test a module nothing here calls (a source text-lift pin tests
  // a COPY). The SHAPE is pinned here; the CALL SITE that wires it in is
  // pinned for all seven consumers in arg.test.mjs, not here — pinning it here
  // was vacuous: candidates.mjs can define a local console.error makeDie(),
  // keep `const die = makeDie(NAME);` verbatim, and the suite stays green at
  // 640/640 (measured). That line pins a NAME, not the module it resolves to.
  //
  // Each fragment anchored at a line start under /m — the old regex joined
  // them with a bare `\s*` and no anchor at all. stripComments() blanks
  // whole-line comments only (its own documented ceiling), so a trailing
  // `code; // function die(msg) { try { writeSync(2,` survives stripping and
  // satisfied the old regex with die() genuinely reverted (measured).
  // Requiring each fragment at a line START refuses that — the decoy sits
  // mid-line, and a whole-line decoy is blanked to "". `\s*^\s*` between the
  // fragments rather than a literal `\n` on purpose: a future editor adding a
  // comment line inside makeDie must not turn this pin red (measured — the
  // adjacency form over-fired on exactly that). Do not terminate the lines
  // with `$` either; that over-fires on a trailing comment (measured).
  assert.match(
    stripComments(readFileSync(ARG_MODULE, "utf8")),
    /^\s*(?:return )?function die\(msg\) \{\s*^\s*try \{\s*^\s*writeSync\(2,/m,
  );
});

test("gh missing entirely is named as ENOENT — the shape that prints nothing at all", () => {
  // The other side of `e.code ?? …`. Deleting the whole `e.code` half leaves
  // the suite green without this: the jq test above only ever reaches the
  // exit-status branch. ENOENT is the shape where die() is the SOLE diagnostic
  // — nothing spawned, so no child stderr was forwarded to fall back on.
  const { status, stderr } = run(
    [ticket(11, "## What to build\n\nx\n")],
    ["--require-label", "ready-for-agent"],
    null,
    { PATH: "/nonexistent" },
  );
  assert.equal(status, 2);
  assert.match(stderr, /^candidates: gh issue list failed: ENOENT$/m);
});

test("a signal-killed gh is named by its signal, not reported as `exit null`", () => {
  // Third disjoint shape: `e.code` undefined AND `e.status` null, so a
  // two-branch expression prints `exit null` and names nothing. Live for gh —
  // the OOM killer on a large query, a SIGPIPE, a propagated Ctrl-C — and the
  // child prints nothing on its way out, so this line is all the caller gets.
  const { status, stderr } = runWithGh(`#!/bin/sh\nkill -TERM $$\n`);
  assert.equal(status, 2);
  assert.match(stderr, /^candidates: gh issue list failed: killed by SIGTERM$/m);
  assert.doesNotMatch(stderr, /exit null/);
});

test("a payload past the pipe buffer arrives whole — truncated JSON must never read as exit 0", () => {
  // process.exit() discards queued writes, and stdout on a pipe (which is what
  // spawnSync gives us, and what every real caller gives it) is async. 499 rows
  // — one UNDER the default --limit, so refuseIfCapped never fires — measured
  // 65,536 B and mid-JSON at exit 0: a corrupt payload typed as success, the
  // one outcome this file's exit codes exist to make impossible.
  //
  // The pin is `rows`, which run() JSON.parses: truncation throws there. The
  // byte assertion is what makes it meaningful — under the buffer this test
  // passes against process.exit() too, so it must stay comfortably over.
  const issues = Array.from({ length: 499 }, (_, i) => ({
    number: i + 1,
    title: "t".repeat(120),
    labels: [{ name: "ready-for-agent" }, { name: "size:m" }],
    body: "## What to build\n\ndepends on #7\n",
  }));
  const { status, stdout, rows } = run(issues);
  assert.ok(stdout.length > 70_000, `payload must exceed the 64 KiB buffer, got ${stdout.length}`);
  assert.equal(rows.length, 499);
  assert.equal(status, 0);
});

test("an empty queue is exit 1, not 2 — the query worked and there is no work", () => {
  // The other half of the contract in this file's header. Every refusal above
  // pins 2; nothing pinned 1, so a change spending 2 on an empty queue — the
  // swap the header forbids — shipped green. Verified by mutation: flipping the
  // `: 1` arm of `rows.length === 0 ? (allFilteredOut ? 3 : 1) : 0` to `: 2`
  // fails this test, the #64 fallback-genuinely-empty test below, AND
  // fleet-tick's "supply comes from candidates.mjs" — every reader of that arm,
  // across both files. Before #64 the line read `rows.length === 0 ? 1 : 0`
  // and this was indeed the only test that saw it; the exit-3 branch and its
  // fallback test are what made that count stale.
  const { status, stdout } = run([], ["--require-label", "ready-for-agent"]);
  assert.equal(status, 1);
  assert.equal(stdout.trim(), "[]");
});

test("an all-filtered labeled queue with no fallback is exit 3, not 1 — the caller can tell filtered-empty from genuinely-empty (#64)", () => {
  // No --allow-fallback, so this is a single pass: the labeled query returns
  // rows and dropSpecs removes every one. Byte-identical to a genuinely empty
  // queue on stdout; the exit code is the only place the two facts differ.
  const { status, stdout } = run([
    ticket(10, "## User Stories\n\n1. As a user…\n"),
    ticket(11, "## Problem Statement\n\ny\n\n## User Stories\n\n2. As a user…\n"),
  ]);
  assert.equal(stdout.trim(), "[]");
  assert.equal(status, 3);
});

test("an all-filtered fallback pass is exit 3 even though the labeled pass was genuinely empty — the verdict is the fallback's own, not pass 1's (#64)", () => {
  // Pass 1 (labeled) comes back with zero rows — genuinely empty, nothing to
  // filter, so pass 1's own flag would be false. Pass 2 (fallback) comes back
  // with rows and drops every one. If the two passes' flags were AND'd together
  // instead of the fallback's replacing pass 1's outright, this would wrongly
  // read pass 1's "false" through and report exit 1 — verified by mutation, and
  // this is the only test in the suite that the AND breaks. OR is the
  // complementary bug, which this test cannot see (false OR true is true
  // either way); the test below is what pins that direction.
  const { status, stdout, stderr } = run(
    [],
    ["--require-label", "ready-for-agent", "--allow-fallback"],
    [
      ticket(12, "## User Stories\n\n1. As a user…\n", ["ready-for-human"]),
      ticket(13, "## Problem Statement\n\nz\n\n## User Stories\n\n2. As a user…\n", ["ready-for-human"]),
    ],
  );
  assert.match(stderr, /retrying unfiltered/);
  assert.equal(stdout.trim(), "[]");
  assert.equal(status, 3);
});

test("a labeled all-specs query that falls back to a genuinely empty unfiltered query is exit 1, not 3 — pass 1's drop must not leak into pass 2's verdict (#64)", () => {
  // The edge case the ticket names explicitly. Pass 1 (labeled) has rows and
  // drops every one as a spec — pass 1's own flag is true. Pass 2 (fallback)
  // comes back with no rows at all — genuinely empty, nothing to filter. If
  // pass 1's "true" carried forward (an OR instead of a plain reassignment),
  // this would wrongly report exit 3 for a fallback that filtered nothing.
  const { status, stdout, stderr } = run(
    [ticket(10, "## User Stories\n\n1. As a user…\n")],
    ["--require-label", "ready-for-agent", "--allow-fallback"],
    [],
  );
  assert.match(stderr, /retrying unfiltered/);
  assert.equal(stdout.trim(), "[]");
  assert.equal(status, 1);
});

test("candidates come back oldest first, whatever order gh returned them in", () => {
  // gh defaults to created-desc, so newest-first is the realistic input.
  const { rows } = run([
    ticket(42, "## What to build\n\nc\n"),
    ticket(19, "## What to build\n\nb\n"),
    ticket(7, "## What to build\n\na\n"),
  ]);
  assert.deepEqual(rows.map((r) => r.n), [7, 19, 42]);
});

// #175. The search term is built by interpolation, so the label's own
// characters are read by GitHub's query parser, not carried past it. The stub
// above models the one split that matters — an unquoted value ends at the
// first space. Neither test below is green on both trees, but they go red for
// different reasons. On the raw interpolation the first fails outright: the
// term resolves to `good`, the query matches nothing, and the empty answer
// surfaces as exit 1. The second's QUERY OUTCOME — status and rows — is
// identical either way, which is the whole point of it: quoting the label
// every current caller actually passes is a no-op for what comes back. Its
// wire-form assertion is the fix-dependent half, and reds on the raw
// interpolation exactly like the first.

test("a multi-word label is quoted into the search term — unquoted, every word after the first is free text (#175)", () => {
  // The ticket's headline symptom, and the one the exit-code contract makes
  // expensive: the query silently did not mean what was asked, matched
  // nothing, and its empty result read as exit 1 — "the query worked and
  // there is no work" — against a queue that was not empty. Reachable in a
  // repo that remapped its triage labels (docs/agents/triage-labels.md invites
  // exactly that), where the AFK-ready role can be spelled `good first issue`.
  const { status, rows } = run(
    [ticket(11, "## What to build\n\nx\n", ["good first issue"])],
    ["--require-label", "good first issue"],
    null,
    { LABEL_EXPECT: "good first issue" },
  );
  assert.equal(status, 0);
  assert.deepEqual(rows.map((r) => r.n), [11]);
});

test("a single-word label still resolves to itself — quoting must not disturb the only label every caller passes", () => {
  // AC-3's other half, and the half a quoting fix can newly break: this term
  // is what next-ticket/SKILL.md's `## 1. Candidates` step, run-team/SKILL.md's
  // **Candidate scan** step and fleet-tick.mjs's `supply` all send, so a change that widened or narrowed it would
  // empty the fleet's queue at exit 1 — #175's own defect, relocated. Measured
  // against the live repo 2026-08-17: `label:ready-for-agent` and
  // `label:"ready-for-agent"` return the same count, so the quoting is a no-op
  // HERE, which is a fact about GitHub's parser and not one this stub can
  // prove. What the stub can prove is the half that would break: the term
  // still resolves to `ready-for-agent` and nothing else.
  const { status, rows, stderr } = run(
    [ticket(11, "## What to build\n\nx\n")],
    ["--require-label", "ready-for-agent"],
    null,
    { LABEL_EXPECT: "ready-for-agent" },
  );
  assert.equal(status, 0);
  assert.deepEqual(rows.map((r) => r.n), [11]);
  // Anchored on the `--json` that follows, so this cannot be satisfied by a
  // term with the label plus trailing free text — the exact shape #175 is.
  assert.match(stderr, /--search -label:in-progress[^\n]* label:"ready-for-agent" --json/);
});

test("a label with no space is quoted too — the wire form carries every label, not only the ones a space would break", () => {
  // What this pins is the UNIFORMITY, not a second dangerous character. Space
  // is how the ticket found the bug and — measured 2026-08-17 — it is the only
  // character GitHub splits an unquoted value on: `label:auto:logs` and
  // `label:"auto:logs"` agree on renovatebot/renovate, so `status:ready` would
  // in fact survive unquoted. The fix quotes it anyway because quoting a value
  // that needs none is a measured no-op, and one unconditional form beats a
  // `/\s/` predicate that has to stay in step with GitHub's parser; quoting
  // only when /\s/ matched would pass every other test in this suite unnoticed.
  // Behaviour cannot pin this one — the stub's parser resolves the label under
  // either form — so the wire form is the assertion.
  const { stderr } = run(
    [ticket(11, "## What to build\n\nx\n", ["status:ready"])],
    ["--require-label", "status:ready"],
  );
  assert.match(stderr, /--search -label:in-progress[^\n]* label:"status:ready" --json/);
});

test("a label containing a double quote refuses — an unrepresentable query must not run as an empty one", () => {
  // What the fix itself newly makes possible: the term is `label:"<value>"`,
  // so a `"` inside the value closes it early and the remainder becomes free
  // text — #175's defect with the quoting applied. Refuse at exit 2 ("the
  // query broke") rather than send it, because the alternative is the fail-open
  // this file exists to prevent: a misparsed query whose empty result is
  // indistinguishable from an empty queue. Escaping instead was not shipped
  // because there is nothing to escape TO: GitHub does honour `\"` inside a
  // qualifier, so a backslash cannot rescue a quote — it only moves the same
  // misparse one character left, which is what the next test pins.
  const { status, stderr } = run(
    [ticket(11, "## What to build\n\nx\n")],
    ["--require-label", 'say "hi"'],
  );
  assert.equal(status, 2);
  assert.match(stderr, /^candidates: --require-label cannot contain a double quote/m);
  // Refuses BEFORE gh, like every other value guard: a query that cannot be
  // built correctly must not be sent at all.
  assert.equal(queriesRun(stderr), 0);
});

test("a label ending in a backslash refuses too — it eats the closing quote the fix adds", () => {
  // The same term broken from the other side, and the side that leaves no
  // trace. Measured against feigi/claude-config 2026-08-17: negating a label
  // no issue carries is a no-op, so `-label:"zzz" label:"ready-for-agent"`
  // returns the same count as `label:"ready-for-agent"` alone — but
  // `-label:"zzz\" label:"ready-for-agent"` returns the count for
  // `ready-for-agent` as FREE TEXT, the backslash having eaten the closing
  // quote and swallowed the whole following qualifier. Doubling does not
  // escape it. In the shape query() actually builds the label term comes
  // LAST, so a trailing backslash leaves its value unterminated and the query
  // answers zero rows at HTTP 200, no error — #175's silent empty, reached
  // through the fix rather than around it. Without this case the widened
  // guard is unpinned: narrowing it back to `"` alone leaves every other test
  // in this file green.
  const { status, stderr } = run(
    [ticket(11, "## What to build\n\nx\n")],
    ["--require-label", "trailing\\"],
  );
  assert.equal(status, 2);
  assert.match(stderr, /^candidates: --require-label cannot contain a double quote or a backslash/m);
  assert.equal(queriesRun(stderr), 0);
});

// The other half of #173, and the half that produced the refused invocation
// above: the rule a controller reads lives in another file and was pinned by
// nothing, so it named a flag the script has never accepted.
const RUN_TEAM = readFileSync(join(import.meta.dirname, "..", "skills", "run-team", "SKILL.md"), "utf8");

test("run-team's phase 0 rule names the flag candidates.mjs accepts", () => {
  // The step-1 bullet alone. A slice any wider is vacuous for this claim: the
  // `candidates.mjs` invocation in the same bullet already spells
  // `--require-label` correctly, so a positive match anywhere in phase 0 stays
  // green with the rule naming anything at all.
  const step1 = between(RUN_TEAM, "1. **Candidate scan**", "\n2. ", "run-team/SKILL.md");
  // Leading backtick, so this can only be satisfied by the RULE: in the command
  // above it, `--require-label` is preceded by a line break, not a backtick.
  // The gap is loose enough that rewording around `mandatory` stays green and
  // tight enough that a different flag in the rule does not.
  assert.match(
    step1,
    /`--require-label ready-for-agent`[\s\S]{0,20}mandatory/,
    "run-team's mandatory-label rule no longer names --require-label",
  );
  // The positive pin cannot see a SECOND sentence naming the wrong flag, which
  // is exactly what shipped. `--require-label` does not contain `--label`, so
  // this needs no quoting to tell them apart.
  assert.doesNotMatch(
    step1,
    /--label\b/,
    "run-team's phase 0 step 1 names `--label`, which candidates.mjs refuses",
  );
});

// --- #240: the third carrier, and the one the pin above cannot see. The rule
// in run-team/SKILL.md is pinned; the design spec that rule descends from was
// not, and it still spelled the flag `--label`.
//
// The spelling was CORRECT the day that spec was written: at `02bfd59`, the
// commit that added it, `next-ticket` step 1 — the step the spec cites rather
// than restates — was a raw `gh issue list` reading "Add `--label
// ready-for-agent` first". `c3310fe` moved that query into this script the next
// day, and this script has read `arg("require-label")` in every commit of its
// life. That is why the spec carries a supersession note rather than a silent
// swap: these documents are dated records, and only a behavioural claim the
// code contradicts gets corrected in them.
const SPEC_RUN_TEAM_DESIGN = fileURLToPath(
  new URL("../../docs/specs/2026-07-22-run-team-agent-fleet-design.md", import.meta.url),
);
const SPEC_COCKPIT_DESIGN = fileURLToPath(
  new URL("../../docs/specs/2026-07-24-fleet-cockpit-design.md", import.meta.url),
);

// Derived from the declaration, not restated from it: a rename of the accepted
// flag reddens here, which is the whole failure this ticket is an instance of —
// a hand-copied spelling that nothing made move with the script.
//
// Guarded at every step, and called from a test body rather than run at module
// scope, because an unguarded index here fails at IMPORT, and an import-time
// failure takes down every test in this file — the ones deriving the flag and
// the ones that have nothing to do with it alike — leaving one node-authored
// `TypeError` that names a file and a line but never names `OPTIONS` as the
// thing to look at. Measured on this tree by appending an unguarded
// module-scope `.match(...)[0]` to this file and one-lining `OPTIONS`:
// `node --test plugin/scripts/candidates.test.mjs` then reports one
// synthetic test, zero passes, and that TypeError.
//
// Reformatting `OPTIONS` — one-lining it, wrapping it in `Object.freeze`,
// anything that drops the literal `\n};` this regex needs — has zero
// behavioural effect, so what the guard buys is that such a reformat costs
// only the tests that derive the flag: measured by one-lining `OPTIONS` on
// this tree, those tests red with this guard's own `OPTIONS block no longer
// matches — update this test` message and every other test in this file still
// runs and passes.
//
// The `*label` match is global and required to be UNIQUE rather than indexed
// at the first hit, because indexing fails SILENTLY: an `"exclude-label"`
// declared above `"require-label"` would pin the specs below to a flag they do
// not mean, and a test passing for the wrong reason is this ticket's own defect
// class. Anchoring to the literal `require-label` would settle the ordering by
// restating the string this test exists to stop restating.
function declaredLabelFlag() {
  const block = readFileSync(SCRIPT, "utf8").match(/const OPTIONS = \{[\s\S]*?\n\};/);
  assert.ok(block, "candidates.mjs' OPTIONS block no longer matches — update this test");
  const flags = [...block[0].matchAll(/"([a-z-]*label)":/g)];
  assert.equal(
    flags.length,
    1,
    `candidates.mjs' OPTIONS declares ${flags.length} \`*label\` flags, not the 1 this test derives — update this test`,
  );
  return flags[0][1];
}

test("the run-team design spec's candidate-scan step names the flag this script declares", () => {
  const DECLARED_LABEL_FLAG = declaredLabelFlag();
  // The step alone, for the reason the run-team pin above gives: a match
  // anywhere in the document is vacuous, and here it is worse than vacuous —
  // the supersession note at the head cites `--label` deliberately, as the
  // spelling this script refuses, so a file-wide negative would fail on the
  // correction's own prose.
  const step = between(
    readFileSync(SPEC_RUN_TEAM_DESIGN, "utf8"),
    "1. Candidate scan",
    "\n2. ",
    "the run-team design spec",
  );

  assert.ok(
    step.includes(`\`--${DECLARED_LABEL_FLAG} ready-for-agent\``),
    `the spec's candidate-scan step no longer names --${DECLARED_LABEL_FLAG}, the label flag this script's OPTIONS declares`,
  );
  // `--require-label` does not contain `--label`, so this tells them apart with
  // no quoting — same reasoning as the run-team pin above.
  assert.doesNotMatch(
    step,
    /--label\b/,
    "the spec's candidate-scan step names `--label`, which this script refuses at exit 2",
  );
});

// --- #851: another live carrier of the flag spelling, and not the last
// carrier nothing asserts on. `git grep -l -- --require-label docs skills`
// lists the carriers; several are unpinned, filed as #1196 — measured by
// rewriting `docs/specs/2026-07-23-fleet-plugin-design.md`'s value-bearing
// `[--require-label L]` synopsis row to `[--label L]`, which leaves this whole
// suite green. `next-ticket/SKILL.md` earns a pin here because it is what a
// solo caller reads to run the scan, and `--label` is what `gh issue list`
// accepts, so it is the plausible thing to write and the thing this script
// refuses at exit 2. Derived from `OPTIONS`, through the same guarded
// `declaredLabelFlag()` the run-team design-spec pin uses, so a rename of the
// flag reddens here instead of minting the next hand-copied spelling.
//
// What gets pinned is the TOKEN inside the candidate step, not the invocation
// that carries it. Measured, both legs: deleting that step's only fenced block
// and naming the flag in prose instead leaves the whole suite green, while
// deleting the same fence with NO mention of the flag reds with this pin's own
// message. So this holds "the flag named here is the one `OPTIONS` declares",
// never "there is a runnable command here" — a separate invariant #851 does
// not ask for and nothing else in this suite claims.
const NEXT_TICKET = readFileSync(join(import.meta.dirname, "..", "skills", "next-ticket", "SKILL.md"), "utf8");

// Takes the text rather than reading the file, so the discrimination test below
// can put the same pin in front of the input it must red on AND the input it
// must not. A pin only shown to red is not shown to discriminate.
function assertScanRunsDeclaredFlag(text, where) {
  const flag = declaredLabelFlag();
  // The candidate step alone, for the reason both pins above give, and here
  // with a live second reason: step 7 of this same skill says "Never fold
  // `--label` into the create", where `--label` is `gh pr edit`'s own flag and
  // correct (#375). A file-wide negative would fail on that sentence.
  const step = between(text, "## 1. Candidates", "## 2. Dependencies", where);
  assert.ok(
    step.includes(`--${flag} ready-for-agent`),
    `${where}'s candidate scan no longer runs the label flag candidates.mjs' OPTIONS declares`,
  );
  // `--require-label` does not contain `--label`, so this tells them apart with
  // no quoting — same reasoning as the two pins above.
  assert.doesNotMatch(
    step,
    /--label\b/,
    `${where}'s candidate scan names \`--label\`, which candidates.mjs refuses at exit 2`,
  );
}

test("next-ticket's candidate scan runs the flag this script declares", () => {
  assertScanRunsDeclaredFlag(NEXT_TICKET, "next-ticket/SKILL.md");
});

test("the next-ticket pin reds on the refused spelling and stays green on text it must accept", () => {
  // REDS on the swap it exists to catch — written through the declared flag
  // rather than the literal, so a rename of the flag moves the mutant with it
  // instead of leaving a mutant that tests nothing.
  assert.throws(
    () => assertScanRunsDeclaredFlag(NEXT_TICKET.replaceAll(`--${declaredLabelFlag()}`, "--label"), "the mutant"),
    /the mutant's candidate scan/,
    "the pin does not red when the candidate scan is given the spelling this script refuses",
  );

  // GREEN, control 1: the live file, which carries a legitimate `--label`
  // outside this slice. This is what separates a bounded pin from a whole-file
  // one — the latter clears "it and only it reds" and still reds on prose it
  // has no business reading.
  assert.match(
    NEXT_TICKET,
    /Never fold `--label` into the create/,
    "next-ticket/SKILL.md no longer carries a legitimate `--label` outside its candidate step — this control now proves nothing",
  );

  // GREEN, control 2: a reflow. Rewrapping prose outside fenced blocks has zero
  // behavioural effect on a skill, and a prose pin that reds on one costs its
  // readers more than it holds.
  //
  // TWO reflows, in opposite directions, because one is not enough to stay
  // honest: an unwrap applied to an already-unwrapped file changes nothing, and
  // a control that asserts its own input changed would then red on the very
  // maintainer edit it exists to bless — measured, by running this against an
  // unwrapped copy of the skill. Requiring only that ONE of the two differs
  // keeps the control non-vacuous whatever the file's current wrapping.
  const outsideFences = (md, f) =>
    md.split(/(```[\s\S]*?```)/).map((part, i) => (i % 2 ? part : f(part))).join("");
  const unwrapped = outsideFences(NEXT_TICKET, (p) => p.replace(/(\S)\n(?=\S)/g, "$1 "));
  const rewrapped = outsideFences(unwrapped, (p) => p.replace(/, (?=\S)/g, ",\n"));
  assert.ok(
    unwrapped !== NEXT_TICKET || rewrapped !== NEXT_TICKET,
    "neither reflow changed next-ticket/SKILL.md — this control now proves nothing",
  );
  assertScanRunsDeclaredFlag(unwrapped, "an unwrapped next-ticket/SKILL.md");
  assertScanRunsDeclaredFlag(rewrapped, "a rewrapped next-ticket/SKILL.md");
});

test("the cockpit spec's gh invocation keeps the flag gh accepts", () => {
  // The other half of the same class, and the one a fix for it can break:
  // `--label` is correct for `gh issue list`, so a sweep for the wrong spelling
  // that did not distinguish the caller would rewrite a working invocation into
  // a broken one. This is the input the check must ACCEPT.
  assert.match(
    readFileSync(SPEC_COCKPIT_DESIGN, "utf8"),
    /`gh issue list --label ready-for-agent`/,
    "the cockpit spec's `gh issue list --label ready-for-agent` changed — `--label` is gh's own flag and is correct there, so a sweep for this script's wrong spelling must leave it alone",
  );
});
