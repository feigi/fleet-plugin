// run-team's phase 0 step 0 and End of run are the two drivers, `phase0.mjs`
// and `closeout.mjs`; the paragraphs that used to spell each step moved into
// references/phase-0.md and references/close-out.md. These pins hold what only
// the runbook carries about that move:
//
//   - nothing the move took out of SKILL.md was lost: the fixtures under
//     tests/fixtures/run-team-moved-text/ are the removed text, owned by this
//     test — each sentence as the reference file now says it, where the move
//     corrected one — and every sentence of them is found exactly once across
//     references/ and not at all in SKILL.md;
//   - step 0 and End of run stay short — the point of the move;
//   - each `NEED` line a driver prints has its paragraph in SKILL.md, read off
//     the scripts' own sources so a new kind cannot ship unexplained;
//   - the reference files keep a heading per moved step paragraph and carry no
//     issue numbers (plugin/skills ships).
//
// Each pin below holds one claim by a contiguous phrase or an exact count, never
// by independent keywords. THE CEILING shared with every prose pin here: this
// proves text is PRESENT, not that no sentence beside it negates it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Pin } from "./support/prose-pin.mjs";
import { RECEIPT, RECEIPT_HELD, closeoutArchiveName, receiptArchiveName } from "../plugin/scripts/ledger-grammar.mjs";

const PLUGIN = join(import.meta.dirname, "..", "plugin");
const RUN_TEAM_DIR = join(PLUGIN, "skills", "run-team");
const REFERENCES = join(RUN_TEAM_DIR, "references");
const FIXTURES = join(import.meta.dirname, "fixtures", "run-team-moved-text");
const SKILL = Pin.file(join(RUN_TEAM_DIR, "SKILL.md"));
// The tick rows' full text is in references/tick-rows.md; SKILL.md keeps one line for each.
const TICK_ROWS = Pin.file(join(REFERENCES, "tick-rows.md"));
const PHASE0 = readFileSync(join(REFERENCES, "phase-0.md"), "utf8");
const CLOSE_OUT = readFileSync(join(REFERENCES, "close-out.md"), "utf8");

const flat = (text) => text.replace(/\s+/g, " ").trim();
const fixture = (name) => readFileSync(join(FIXTURES, name), "utf8");

// Every reference file, whitespace-flattened, joined by a character no sentence
// holds, so a sentence cannot be matched across two files.
const referenceCorpus = () =>
  readdirSync(REFERENCES)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => flat(readFileSync(join(REFERENCES, f), "utf8")))
    .join("\u0000");

const occurrences = (haystack, needle) => {
  let n = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) n += 1;
  return n;
};

// The removed text as sentences. A bullet's marker stays on its sentence, as it
// does in the reference file the bullet moved to.
const removedSentences = (name) => Pin.sentences(flat(fixture(name))).filter((s) => s !== "");

// How many times the removed text, both fixtures together, says a sentence. The
// two metrics paragraphs each said "Exit 0: both ran." when they moved — once in
// the step the controller ran at phase 0 and once in the step it ran at close-out
// — so a sentence is owed as many times as it is said, not once.
const owed = (() => {
  const counts = new Map();
  for (const name of ["phase-0-step-0.txt", "close-out-metrics.txt"]) {
    for (const s of removedSentences(name)) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return counts;
})();

// --- nothing the move took out is lost ----------------------------------------

for (const [name, what] of [
  ["phase-0-step-0.txt", "phase 0 step 0"],
  ["close-out-metrics.txt", "the close-out metrics paragraphs"],
]) {
  test(`every sentence removed from SKILL.md with ${what} is found exactly as often as it was said, once but for a repeated one, across references/`, () => {
    const sentences = removedSentences(name);
    assert.ok(sentences.length > 20, `the fixture ${name} read as ${sentences.length} sentences — the fixture or the splitter is broken`);
    const corpus = referenceCorpus();
    const lost = [];
    const doubled = [];
    for (const s of sentences) {
      const n = occurrences(corpus, s);
      if (n === 0) lost.push(s);
      else if (n !== owed.get(s)) doubled.push(`${n}× (owed ${owed.get(s)}×) ${s}`);
    }
    assert.deepEqual(lost, [], `sentences removed from SKILL.md that no reference file carries`);
    assert.deepEqual(doubled, [], `sentences carried more or fewer times across references/ than the removed text said them`);
  });

  test(`no sentence removed with ${what} is still in SKILL.md`, () => {
    const skill = flat(SKILL.text);
    const back = removedSentences(name).filter((s) => skill.includes(s));
    assert.deepEqual(back, [], `sentences the move took out that SKILL.md carries again`);
  });
}

test("the fixtures are the text the move removed: phase 0 step 0's paragraphs and the metrics paragraphs of the guard", () => {
  // Anchors on the first and last sentence of each, so a fixture trimmed to
  // make the test pass is caught here rather than by a shorter claim.
  const p0 = flat(fixture("phase-0-step-0.txt"));
  assert.ok(p0.startsWith("**Fast-forward the checkout before you trust these rules"), "the step-0 fixture lost its first paragraph");
  assert.ok(p0.endsWith("and is never nothing stranded."), "the step-0 fixture lost its last paragraph");
  const co = flat(fixture("close-out-metrics.txt"));
  assert.ok(co.startsWith("**Then record the run's member facts"), "the metrics fixture lost its first paragraph");
  assert.ok(co.endsWith("only what the harness still holds."), "the metrics fixture lost its last paragraph");
});

test("the reflow of a reference file's wraps stays green: the check reads sentences, not line breaks", () => {
  // The accept direction: a rewrap of the moved text must not read as a loss.
  const reflowed = PHASE0.replace(/\n(?!\n)/g, " ");
  const lost = removedSentences("phase-0-step-0.txt").filter((s) => !flat(reflowed).includes(s));
  assert.deepEqual(lost, []);
});

// --- the drivers stay short -----------------------------------------------------

const step0 = () => {
  const text = SKILL.text;
  const from = text.indexOf("0. **Once per run, before anything else.**");
  const to = text.indexOf("\n1. **Build the Shortlist**");
  assert.ok(from !== -1 && to > from, "phase 0 step 0 moved — re-anchor this test, never widen it");
  assert.equal(text.indexOf("0. **Once per run, before anything else.**", from + 1), -1, "step 0's opener occurs twice");
  return text.slice(from, to).replace(/\n+$/, "");
};

test("phase 0 step 0 is under 60 lines", () => {
  const lines = step0().split("\n").length;
  assert.ok(lines < 60, `phase 0 step 0 is ${lines} lines`);
  assert.ok(lines > 10, `phase 0 step 0 sliced down to ${lines} lines — the extractor is broken, not the docs`);
});

test("phase 0 step 0 ends by pointing at references/phase-0.md", () => {
  assert.ok(step0().endsWith("See references/phase-0.md."), "step 0 no longer ends with its pointer to the reference file");
});

const endOfRun = () => {
  const b = SKILL.bullet("- **The run ends, or the maintainer says drain**", "- **The finisher-gate wakes**", "run-team drain bullet").text;
  const at = b.indexOf("**End of run**");
  assert.notEqual(at, -1, "End of run moved out of the drain bullet — re-anchor this test");
  return b.slice(at).replace(/\n+$/, "");
};

test("End of run is under 25 lines", () => {
  const lines = endOfRun().split("\n").length;
  assert.ok(lines < 25, `End of run is ${lines} lines`);
  assert.ok(lines > 8, `End of run sliced down to ${lines} lines — the extractor is broken, not the docs`);
});

test("End of run runs closeout.mjs begin, the ordinary loop, then closeout.mjs finish, in that order", () => {
  const s = flat(Pin.unemphasized(endOfRun()));
  const begin = s.indexOf("closeout.mjs begin --reason");
  const loop = s.indexOf("until the tick prints `ACTION: run over");
  const finish = s.indexOf("closeout.mjs finish --reason");
  assert.ok(begin !== -1 && begin < loop && loop < finish, `begin at ${begin}, the tick's last line at ${loop}, finish at ${finish}`);
  assert.match(endOfRun(), Pin.phrase("A `NEED tier-outcomes append <pr>` is a reviewed PR with no verdict row — for an implementer's, one that never reached its finisher: run `append <pr>` (**Guard: accumulate per PR**) and run `finish` again."));
  assert.match(endOfRun(), Pin.phrase("A claim it refuses prints `NEED hand-release #<N> <blocker>`"));
  assert.match(endOfRun(), Pin.phrase("so a claim you keep leaves `begin` at exit 4 on every run"));
});

// `check --live` notes a reviewed PR closing no issue, or several, that no
// settled `impl-<N>=PR#<pr>` token names, and warns about one that such a token
// names; closeout.mjs turns only the warning into a NEED. The runbook says that
// one rule, and so does the reference, in its opening steps and again under
// "Scrape the member facts and check the tier rows"; none of them may say an
// "impl token" that no "settled" qualifies, which reads as the live member token.
test("End of run and references/close-out.md: a PR closing none or several is a NEED only if a settled impl token names it, else a note", () => {
  const bareImplToken = /(?<!settled\s+)\bimpl[-\s]+tokens?\b/i;
  assert.match(endOfRun(), Pin.phrase("A PR closing none or several: a NEED if a settled `impl-<N>=PR#<pr>` token names it, else a note."));
  assert.doesNotMatch(endOfRun(), bareImplToken);
  assert.match(CLOSE_OUT, Pin.phrase("with no settled `impl-<N>=PR#<pr>` token naming it takes no row: the check names it in a `note` line and never asks for one. With such a token it is a NEED"));
  assert.match(CLOSE_OUT, Pin.phrase("and that no settled `impl-<N>=PR#<pr>` token names, is named in a `note` line instead: it takes no row."));
  assert.doesNotMatch(CLOSE_OUT, bareImplToken);
});

test("the verdict rules stay in the guard, where the controller rules each PR; the BLANK rule's paragraph is in references/reviewers.md", () => {
  const guard = SKILL.between("**Guard: accumulate per PR", "### Nothing to do: mark the beat and end your turn", "run-team guard").text;
  assert.match(guard, Pin.phrase("`~/.fleet/bin/fleet-run tier-outcomes.mjs append <pr>`, never by hand** (that file's header carries the column meanings)."));
  assert.doesNotMatch(guard, /--closed-own-ticket|--minted-false-claim|yes\|no/, "the guard tells the controller to type a verdict");
  assert.match(guard, Pin.phrase("**A verdict is a measurement only if it post-dates the run that produced it.** See references/reviewers.md."));
  const moved = Pin.file(join(REFERENCES, "reviewers.md")).section("## A sizing verdict is a measurement only if it post-dates the run that produced it", "references/reviewers.md").text;
  assert.match(moved, Pin.phrase("**A value not in hand is left BLANK, never estimated**"));
});

// --- each NEED a driver prints has its paragraph --------------------------------

const needKinds = (script) =>
  [...new Set([...readFileSync(join(PLUGIN, "scripts", script), "utf8").matchAll(/["`]NEED ([a-z]+(?:-[a-z]+)*)/g)].map((m) => m[1]))].sort();

test("every NEED kind phase0.mjs prints has its paragraph in phase 0 step 0", () => {
  const kinds = needKinds("phase0.mjs");
  assert.deepEqual(kinds, ["answer-label-map", "derive-recipe", "resume"], "phase0.mjs prints a NEED kind this test does not list — give it a paragraph");
  const s = step0();
  for (const kind of kinds) assert.ok(s.includes(`\`NEED ${kind}`), `step 0 has no paragraph for \`NEED ${kind}\``);
});

test("every NEED kind closeout.mjs prints has its place in End of run", () => {
  const kinds = needKinds("closeout.mjs");
  assert.deepEqual(kinds, ["hand-release", "merge-wait", "tier-outcomes"], "closeout.mjs prints a NEED kind this test does not list — give it a place");
  const s = endOfRun();
  for (const kind of kinds) assert.ok(s.includes(`NEED ${kind}`), `End of run has no place for \`NEED ${kind}\``);
});

test("the derive-recipe paragraph dispatches the deriver with its rendered brief and stalls on RECIPE NOT PROVEN", () => {
  const s = step0();
  assert.match(s, Pin.phrase("Dispatch a `task` member named `derive-recipe`, agent `fleet-recipe-deriver`, its prompt the brief `~/.fleet/bin/fleet-run dispatch-prompt.mjs render recipe-deriver --member derive-recipe --repo <repo> --scratch <scratch>` prints"));
  assert.match(s, Pin.phrase("`RECIPE NOT PROVEN` → stall: report `STALL — Recipe not proven: <cause>` to the maintainer with the deriver's reason verbatim"));
});

test("the answer-label-map paragraph asks the Label map question, waits, writes the answer with set --create, and stops on a failed labels step", () => {
  const s = step0();
  assert.match(s, Pin.phrase("`NEED answer-label-map` — the `labels` line is the Label map question: ask it as references/phase-0.md words it, and wait"));
  assert.match(s, Pin.phrase("run `label-map.mjs set --create` with the answer (`--accept-suggestions` for `defaults`), say how to make it permanent, and run phase 0 again."));
  assert.match(s, Pin.phrase("A `failed` `labels` step is no question: show it, stop."));
});

test("phase-0.md derives the Label map after the baseline and before the pre-flight, in its order list and its sections", () => {
  assert.match(PHASE0, Pin.phrase("its fixed order — alarm, branch, fast-forward, pin, baseline, labels, preflight, ruleset,"));
  const headings = PHASE0.split("\n").filter((l) => l.startsWith("## "));
  const at = (h) => headings.indexOf(h);
  assert.ok(at("## Derive the Label map") !== -1, "phase-0.md has no Label map section");
  assert.equal(at("## Derive the Label map"), at("## Record the main-checkout baseline") + 1, "the Label map section does not follow the baseline");
  assert.equal(at("## Run the pre-flight"), at("## Derive the Label map") + 1, "the pre-flight does not follow the Label map section");
  const preflight = Pin.of(PHASE0, "phase-0.md").section("## Run the pre-flight", "phase-0 pre-flight section").text;
  assert.doesNotMatch(preflight, /label/i, "the pre-flight section still names a label check");
});

test("the Label map section words the question as the derivation step's payload asks, and says how to keep the answer", () => {
  const s = Pin.of(PHASE0, "phase-0.md").section("## Derive the Label map", "phase-0 Label map section").text;
  assert.match(s, Pin.phrase("`~/.fleet/bin/fleet-run label-map.mjs ensure` in this main checkout"));
  assert.match(s, Pin.phrase("Nothing after it runs — no pre-flight, no Shortlist, no claim — until the map is written."));
  assert.match(s, Pin.phrase("show the maintainer what the step printed and stop. Neither is a question."));
  assert.match(s, Pin.phrase("Put it to the maintainer as one question listing each uncertain role, its suggestion, why, and the alternatives"));
  for (const why of [
    "- `origin` `table`, `exists` false — `declared in <tableFile> but not in the tracker`",
    "- `origin` `table`, `exists` true — `declared more than once in <tableFile> with different labels; the first is the suggestion`",
    "`near match in the tracker`",
    "`the default and a near match are both in the tracker`",
    "`nothing found — the default, to be created`",
    "`was <was> when cached; gone from the tracker (renamed or deleted?) — name the label to use`",
    "`was <was> when cached, now gone from the tracker; `",
    "`your earlier answer <string> is now <role>'s in <tableFile>; `",
    "`your earlier answer <string> is now <role>'s label (its default); `",
  ]) assert.match(s, Pin.phrase(why));
  // The `exists` true bullet with any continuation lines: through to the next bullet or blank line.
  const lines = s.split("\n");
  const from = lines.findIndex((l) => l.startsWith("- `origin` `table`, `exists` true"));
  const to = lines.findIndex((l, i) => i > from && (l.trim() === "" || l.startsWith("- ")));
  const tableExists = lines.slice(from, to === -1 ? lines.length : to).join("\n");
  assert.doesNotMatch(tableExists, /not in the tracker/, "the reason for a live first table string claims it is missing from the tracker");
  assert.doesNotMatch(s, /^\s*- `origin` `table` —/m, "the single `origin` `table` reason is back, whatever the entry's `exists`");
  assert.match(s, Pin.phrase("reply `defaults` to accept every suggestion, or name `<role>=<label>` for any you want otherwise — a role with no suggestion must be named; labels that do not exist are created on your confirmation."));
  assert.match(s, Pin.phrase("`~/.fleet/bin/fleet-run label-map.mjs set --create` with the reply: `--accept-suggestions` for `defaults`, and each `<role>=<label>` the maintainer named."));
  assert.match(s, Pin.phrase("and `tableFile`, the path of the repository's triage-label table, the file the reasons below name. It is the payload's string, read from the echoed payload, never a path you spell yourself."));
  assert.match(s, Pin.phrase("In the same reply, tell the maintainer how to make the answer permanent: add or edit the role's row in the file the payload's `tableFile` names, the role in the first cell and the string in the second."));
  assert.match(s, Pin.phrase("The plugin never writes that table, so neither do you."));
  assert.match(s, Pin.phrase("Exit 2 of `set` is no question"));
  assert.match(s, Pin.phrase("Show the maintainer what it printed and stop, as for a failed `labels` step."));
});

test("the stranded paragraph names its remedy, a stranded impl-<n>-b the ordinary way, and the fold-in prints no NEED for the controller to dispatch", () => {
  const s = step0();
  assert.match(s, Pin.phrase("Dispatch a stranded `impl-<n>-b` the ordinary way"));
  assert.match(s, Pin.phrase("and never with `claim-ticket.sh`: the claim stands."));
  assert.doesNotMatch(s, /NEED review/, "phase0.mjs prints no NEED review line any more");
});

test("step 0 says to run phase0.mjs again until it exits 0 and to dispatch nothing before then", () => {
  const s = step0();
  assert.match(s, Pin.phrase("Dispatch nothing before it exits 0."));
  assert.match(s, Pin.phrase("Once `rotate` has run, a re-run skips every `ok` step but `alarm` and resumes where the last one stopped; before it, a re-run runs every step again."));
});

test("the PHASE0-INCOMPLETE tick row names its remedy: run phase0.mjs again, which resumes at the step that stopped", () => {
  const row = TICK_ROWS.bullet("- `PHASE0-INCOMPLETE <step>[, <step>…] …`", "- `CHECK-LIVENESS <member>", "run-team tick rows").text;
  assert.match(row, Pin.phrase("Run the `phase0.mjs` command the line names and act on what it prints: a re-run resumes at the step that stopped."));
});

// --- the reference files --------------------------------------------------------

test("phase-0.md has one heading per moved step, in the order phase0.mjs runs them", () => {
  const headings = PHASE0.split("\n").filter((l) => /^## /.test(l));
  assert.deepEqual(headings, [
    "## Check the controller alarm",
    "## Fast-forward the checkout",
    "## Pin the instruments",
    "## Record the main-checkout baseline",
    "## Derive the Label map",
    "## Run the pre-flight",
    "## Check the merge gate against its spec",
    "## Drain the pending ticket-features rows and refresh the cost guard",
    "## Launch the cockpit",
    "## Rotate the ledger",
    "## Reclaim scratch",
    "## Derive the Recipe",
    "## Fold in every Owned PR a prior run left open",
    "## Resume the claims a dead run left without a PR",
    "## Build the Shortlist",
  ]);
});

test("close-out.md has one heading per moved metrics step, then one for undoing a drain", () => {
  assert.deepEqual(CLOSE_OUT.split("\n").filter((l) => /^## /.test(l)), [
    "## Scrape the member facts and check the tier rows",
    "## Drain the pending ticket-features rows and refresh the cost guard",
    "## Commit the metrics files and open a PR",
    "## Move the phase-0 receipt",
    "## Undo a drain",
  ]);
});

test("the receipt section names when the step runs, the files it moves between by the names the scripts give them, and how each refusal resumes", () => {
  const s = Pin.of(CLOSE_OUT, "close-out.md").section("## Move the phase-0 receipt", "close-out receipt section").text;
  assert.match(s, Pin.phrase("**Set aside the phase-0 receipt after the commit — before the heartbeat.**"));
  assert.match(s, Pin.phrase(`The receipt \`.fleet/${RECEIPT}\` records`));
  assert.match(s, Pin.phrase(`\`closeout.mjs finish\` moves it to \`.fleet/${RECEIPT_HELD}\``));
  assert.match(s, Pin.phrase(`A missing \`.fleet/${RECEIPT}\` counts as nothing to move and is \`ok\`.`));
  assert.match(s, Pin.phrase("**Fix the cause the error names, then run finish again.**"));
  assert.match(s, Pin.phrase(`**File it by hand as \`.fleet/${receiptArchiveName("<UTC stamp>")}\`, then run finish again.**`));
  assert.match(s, Pin.phrase("**Run finish again:** it finds both names are one file and retries the removal."));
});

test("the rotate section names the held receipt the rotation restores and both receipts rotate archives, by the names the scripts give them", () => {
  const rotate = Pin.of(PHASE0, "phase-0.md").section("## Rotate the ledger", "phase-0 rotate section").text;
  const stamp = "<UTC stamp>";
  assert.match(rotate, Pin.phrase(`Before the rotation, \`phase0.mjs\` puts the held-aside receipt (\`${RECEIPT_HELD}\`) back at \`${RECEIPT}\`, which \`ledger.mjs rotate\` then files as \`${receiptArchiveName(stamp)}\`.`));
  assert.match(rotate, Pin.phrase(`\`ledger.mjs rotate\` archives the run's two receipts with the ledger, under the ledger archive's own stamp: \`.fleet/${receiptArchiveName(stamp)}\` and \`.fleet/${closeoutArchiveName(stamp)}\` beside \`.fleet/ledger.${stamp}.md\`.`));
});

test("the reference files carry no issue, pull request or ADR number: plugin/skills ships", () => {
  for (const [file, text] of [["phase-0.md", PHASE0], ["close-out.md", CLOSE_OUT]]) {
    const hits = text.match(/(?<![\w&])#\d+\b|\bADR[ -]?\d+|\b(?:issue|PR|pull request)\s+#?\d+/gi) ?? [];
    assert.deepEqual(hits, [], `${file} cites a tracker number`);
  }
});

test("SKILL.md sends the controller to both reference files", () => {
  assert.match(SKILL.text, /See references\/phase-0\.md\./);
  assert.match(SKILL.text, /references\/close-out\.md/);
});

// --- the pointers that send the controller from SKILL.md into phase-0.md ------
//
// Step 0 is a short driver: a SKILL.md sentence that says "phase 0" for detail
// lands on a paragraph that does not carry it. Each pointer below names the
// reference file and the heading that holds the detail, and the heading is read
// off phase-0.md, so renaming one there reddens the pointer here too.

const heading = (name) => {
  assert.ok(PHASE0.split("\n").includes(`## ${name}`), `phase-0.md has no "## ${name}" heading, so a SKILL.md pointer to it points nowhere`);
  return name;
};
const STRANDED = heading("Resume the claims a dead run left without a PR");
const BASELINE = heading("Record the main-checkout baseline");
const ROTATE = heading("Rotate the ledger");

test("the carried-token reconciliation after /resume is sent to the stranded-claim section's ancestor branch, which holds it", () => {
  // The reconciliation's full sentence moved to references/member-lifecycle.md
  // with the rest of the after-/resume rationale (#3545); SKILL.md's tier-check
  // bullet keeps the rule and points there.
  const bullet = SKILL.bullet("- **The tier check.**", "- **The exploration rule.**", "run-team after-/resume bullet");
  assert.match(bullet.text, Pin.phrase("**After `/resume`, a carried implementer can hold the whole tick**"));
  assert.match(bullet.text, Pin.phrase("See references/member-lifecycle.md."));
  const para = Pin.file(join(REFERENCES, "member-lifecycle.md")).section("## A carried implementer after `/resume` holds the whole tick", "member-lifecycle after-/resume section");
  assert.match(para.text, Pin.phrase(`follow the carried token's reconciliation in references/phase-0.md, the "${STRANDED}" section, under its \`prior: ancestor\` branch: \`proc://\` reads \`running\` → wait; dead → the Member-killed row.`));
  const branch = Pin.of(PHASE0, "phase-0.md").section(`## ${STRANDED}`, "phase-0 stranded-claim section").text;
  assert.match(branch, Pin.phrase("- `prior: ancestor` — this session's own earlier run"), "the section no longer has the branch the pointer names");
  assert.match(branch, Pin.phrase("read `proc://` once, find each `name` among this session's jobs, and act on its state."), "the section no longer holds the reconciliation");
});

test("the no-baseline remedy runs main-checkout.mjs --record and names the baseline section, never a phase0.mjs re-run", () => {
  const row = TICK_ROWS.bullet("- `MAIN-CHECKOUT-NO-BASELINE …`", "- `PHASE0-INCOMPLETE <step>[, <step>…] …`", "run-team tick rows").text;
  assert.match(row, Pin.phrase(`Yours to fix: run \`~/.fleet/bin/fleet-run main-checkout.mjs --record\`, which references/phase-0.md describes under "${BASELINE}".`));
  assert.match(row, Pin.phrase("A baseline that vanished mid-run is not a fresh run — report it to the maintainer before recording over whatever the tree now holds."));
  assert.doesNotMatch(row, /phase0\.mjs/, "a re-run skips the `ok` baseline step, so it records nothing");
});

test("rotate's retired-name rule and its guard are stated in the rotate section of references/phase-0.md, which holds both", () => {
  const section = Pin.of(PHASE0, "phase-0.md").section(`## ${ROTATE}`, "phase-0 rotate section").text;
  assert.match(section, Pin.phrase("goes into the new ledger's `## Retired` as a bare name"), "the section no longer says which names retire");
  assert.match(section, Pin.phrase("**The guard is the controller record**"), "the section no longer states the guard");
});
