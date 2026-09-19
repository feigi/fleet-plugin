// #990. A failure injection built from an unquoted shell variable silently does
// not happen under this environment's shell: the probe still runs, still exits
// 0, and reports the child behaving exactly like its baseline — which is
// indistinguishable from a genuine "this mutation has no effect" result and
// reads as a clean corroboration. Measured twice in production, in BOTH
// directions: `fix-pr-983` nearly reported a mutant as behaving identically to
// its baseline (the injection never landed), and `fix-pr-1153` nearly retired a
// real review finding as non-reproducing (the reproduction never landed, and a
// matching exit code on both trees is precisely the signature of a correctly
// refuted finding — nothing anomalous to notice).
//
// Re-measured on this tree while these pins were written, against a `probe.sh`
// echoing both variables back and an `argv.sh` printing `$#`:
//
//   zsh    cfg="SETB=1 BADJ=1"; env $cfg sh ./probe.sh    BADJ=[unset] SETB=[1 BADJ=1]  rc 0
//   bash   same                                           BADJ=[1]     SETB=[1]
//   zsh    cfg=(SETB=1 BADJ=1); env $cfg[@] sh …          BADJ=[1]     SETB=[1]
//   bash   same                                           BADJ=[unset] SETB=[1[@]]      rc 0
//   both   env "${cfg[@]}" sh … / env SETB=1 BADJ=1 sh …  BADJ=[1]     SETB=[1]
//   zsh    sub="pr list --json number"; sh ./argv.sh $sub  argc=1
//   bash   same                                            argc=4
//
// Row four is why these pins demand the BRACED array expansion and require
// `$cfg[@]` to be named non-portable. The ticket's own Direction bullet
// prescribes `env $cfg[@]`, and measured, that spelling reintroduces the
// identical silent no-op one shell over — a variable literally named `SETB`
// taking `1[@]` while `BADJ` stays unset, at exit 0. The issue body is a lead,
// never a citation, so the rule that shipped is the portable spelling with the
// zsh-only one named as the trap it is.
//
// FIVE SEATS, because the rule has to reach the member that WRITES the harness,
// in the prompt text, and no member reads all five:
//
//   1. run-team/SKILL.md's Reviewers prose — the controller's own admission
//      gate, and the one place the rule is JUSTIFIED rather than dictated, so
//      the two-shell reproduction lives there and is pinned as one span.
//   2/3. The two hand-dispatch refuter briefs — run-team/SKILL.md's nested
//      `> >` block and review-and-fix.md step 2 — the pair
//      refuter-scratch-prose.test.mjs already treats as one population,
//      for the reason it gives: a rule added to one is the one that misses
//      whichever path a caller takes.
//   4/5. The refuter prompt TEMPLATE on each harness — workflows/review-pr.js
//      (Claude) and scripts/review-core.js (omp). These carry the largest
//      refuter population by far: the workflow dispatches up to two per
//      critical/important finding, where the hand-dispatch briefs cover one per
//      in-scope `suggestion`. The ticket's Key interfaces say no script change
//      is required; against this tree that is false, and leaving them out would
//      have put the rule everywhere except where most refuters read it.
//
// Plus the fix-applier's own mutation paragraph, which is a sixth site with
// different wording — it governs the fix-applier's OWN mutants rather than a
// refuter's verdict, so only the invocation-form clause is shared verbatim.
//
// WHY 4/5 RENDER RATHER THAN GREP. The prescribed array expansion is
// `env "${cfg[@]}"`, and inside a JS template literal that `${` must be
// escaped or it interpolates a free name and the template stops compiling.
// A source grep cannot tell a correctly escaped `\${cfg[@]}` from one that
// renders as an interpolation of `cfg[@]`, and the prompt a refuter actually
// receives is the RENDERED string. So both templates are lifted and evaluated,
// the technique review-pr-refuter-scratch.test.mjs uses and for its reason —
// a Workflow script cannot be imported — and extraction runs against
// comment-stripped code so a commented-out `agent(...)` call cannot satisfy a
// pin with the live dispatch gutted.
//
// THE CEILING, same as refuter-scratch-prose.test.mjs: these are PRESENCE pins
// over bounded slices. Each rule is ONE contiguous regex — a span with
// `[\s\S]{0,N}?` joins — so text spliced INSIDE a pinned clause reddens it, and
// the mutation matrix below measures that both ways. What they cannot catch is a
// WHOLE NEW sentence appended AFTER a clause carving out an exception; nothing
// pins a clause's neighbourhood. A reflow stays green by design, which the
// matrix's ACCEPT row measures rather than asserts by construction.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase } from "./prose-pin.mjs";
import { stripComments } from "./strip-comments.mjs";
import { promptRenderer } from "./prompt-renderer.mjs";

const REPO = join(import.meta.dirname, "..");

// NOT prose-pin.mjs's exported `stripQuoteGutter`, for the reason
// refuter-scratch-prose.test.mjs duplicates it too: the refuter brief sits in a
// NESTED `> > ` blockquote, and that export's `>+` matches only CONSECUTIVE
// markers, so `> > text` comes back as `> text` and a hard wrap inside a pinned
// phrase leaves a `>` where `\s+` needs whitespace. `(>\s?)+` eats both levels,
// and the join is a single space, which is exactly the inter-word space a
// markdown wrap point replaces.
const stripQuoteGutter = (text) => text.split("\n").map((l) => l.replace(/^(>\s?)+/, "")).join(" ");
const RUN_TEAM = readFileSync(join(REPO, "skills", "run-team", "SKILL.md"), "utf8");
const REVIEW_AND_FIX = readFileSync(join(REPO, "commands", "review-and-fix.md"), "utf8");

// One rule, one regex. `phrase()` already tolerates a rewrap between words; the
// numeric joins are what let a bounded amount of unpinned prose sit between two
// pinned clauses without letting a whole sentence be spliced in unnoticed.
const span = (...parts) =>
  new RegExp(parts.map((p) => (typeof p === "number" ? `[\\s\\S]{0,${p}}?` : phrase(p).source)).join(""));

// --- the invocation-form rule, word-identical in every one of the six seats ---
// AC-3: the safe form stated, with the unquoted-scalar form named as the thing
// not to write. One span from the prescription through the prohibition, so
// deleting either half — or splicing an exception between them — reds.
const SAFE_FORM = span(
  "Build such an invocation as an array expanded braced and quoted",
  8,
  '`cfg=(SETB=1 BADJ=1); env "${cfg[@]}" sh ./probe.sh`',
  8,
  "or inline the assignments literally",
  8,
  "`env SETB=1 BADJ=1 sh ./probe.sh`",
  8,
  "NEVER from an unquoted scalar",
  8,
  '`cfg="SETB=1 BADJ=1"; env $cfg sh ./probe.sh`',
);

// The mechanism, which is what makes the prohibition actionable rather than
// superstition: naming the argument count and the variable that really gets set.
const MECHANISM = span(
  "which under zsh passes ONE argument, sets a variable literally named `SETB` to `1 BADJ=1`, never sets `BADJ` at all, and still exits 0",
);

// The half the ticket's own Direction bullet got wrong. Without this clause a
// member follows the issue body, writes `env $cfg[@]`, and reintroduces the
// defect under bash — so the clause is pinned in its own right, not as a
// footnote to SAFE_FORM.
const PORTABILITY = span(
  "`env $cfg[@]` is not the portable spelling either: measured, bash word-splits it into `SETB=1` and `BADJ=1[@]`, so the injection variable is set to a corrupted value, while zsh behaves exactly as with the bare `$cfg` — `BADJ` never set, exit 0",
);

// --- AC-1 and AC-2, in the refuter briefs -----------------------------------
// The control requirement and what a control concretely IS, as one span: a rule
// that says "carry a control" without saying what one looks like is not
// actionable, and the two halves are exactly what a narrowing edit separates.
const REFUTER_CONTROL = span(
  "A failure injection with no positive control has produced NO result, never a negative one",
  240,
  "prove the injection reached the child: one run whose output differs with it present versus absent, or the child echoing the injected value back",
  120,
  "the cell is unrun",
);

const SEATS = [
  [
    "run-team/SKILL.md's nested refuter brief",
    () => stripQuoteGutter(between(RUN_TEAM, "Try to REFUTE this finding", "Survives → apply it, with one hold", "run-team/SKILL.md")),
  ],
  [
    "review-and-fix.md step 2's refuter brief",
    () => between(REVIEW_AND_FIX, "Try to REFUTE this finding", "That last clause is the whole mechanism", "review-and-fix.md"),
  ],
  ["workflows/review-pr.js's rendered refuter prompt", () => renderTemplate("workflows", "review-pr.js")],
  ["scripts/review-core.js's rendered refuter prompt", () => renderTemplate("scripts", "review-core.js")],
];

// The free names each template interpolates, in the order `render` binds them —
// the same list review-pr-refuter-scratch.test.mjs uses, because both harnesses'
// copies of this dispatch interpolate the same set.
const SCOPE = ["pr", "f", "snap", "stats", "d", "i", "fi", "readRules", "usableDiff", "environmentNote"];
const TEMPLATE_START = "`Try to REFUTE this finding from PR #";
const TEMPLATE_END = "{ label: `verify:";

// prompt-renderer.mjs owns the bounded-slice extraction (and both failure
// messages, via prose-pin.mjs's `between()`), the backtick trim, and the
// compile. Compiling is half the assertion: an unescaped `${` in the
// prescribed array expansion either throws here or silently interpolates
// away the very spelling the rule exists to teach.
function renderTemplate(dir, file) {
  const RENDER = promptRenderer({
    file: `${dir}/${file}`,
    start: TEMPLATE_START,
    end: TEMPLATE_END,
    scope: SCOPE,
    what: `${dir}/${file}'s rendered refuter prompt (opening \`Try to REFUTE this finding from PR #\`, labelled \`verify:\`)`,
  });
  return RENDER(
    7,
    { claim: "the guard fails open", file: "a.js", line: 12, evidence: "line 12 has no else" },
    { path: "/scr/snapshot-abc1234", head: "abc1234", runRoot: "/scr" },
    null,
    { key: "correctness" },
    0,
    0,
    () => "READ RULES",
    () => null,
    () => "TEST ENVIRONMENT",
  );
}

for (const [name, getSeat] of SEATS) {
  test(`${name} refuses a failure-injection result that carries no positive control`, () => {
    assert.match(
      getSeat(),
      REFUTER_CONTROL,
      `${name} no longer requires a positive control, or dropped what a control concretely is — an uncontrolled injection then reads as a negative result, which is the defect (#990)`,
    );
  });

  test(`${name} states the safe invocation form and names the unquoted scalar as the thing not to write`, () => {
    const seat = getSeat();
    assert.match(seat, SAFE_FORM, `${name} no longer prescribes the braced array or literal-inline form, or stopped naming the unquoted scalar as the form not to write (#990 AC-3)`);
    assert.match(seat, MECHANISM, `${name} dropped the mechanism — a prohibition with no measured reason behind it is the first thing a later edit drops`);
    assert.match(seat, PORTABILITY, `${name} dropped the note that \`env $cfg[@]\` is zsh-only — a member following the ticket's own Direction bullet then writes the same silent no-op for bash`);
  });
}

// --- AC-1, AC-2 and AC-4, in the controller's own prose ----------------------
// This is the seat where the rule is JUSTIFIED rather than dictated, so it is
// the seat AC-4 binds: the reproduction has to be here or the rule rests on
// assertion.
const justification = () =>
  between(
    RUN_TEAM,
    "A refutation resting on an injection nothing proved landed is not a refutation",
    "**When YOU extend a finding to sibling sites",
    "run-team/SKILL.md Reviewers prose",
  );

test("the controller admits a negative result only with its positive control", () => {
  assert.match(
    justification(),
    span(
      "a negative result is admitted only together with its **positive control**",
      200,
      "the child's output differing with the injection present versus absent or the child echoing the injected value back",
      120,
      "No control → the cell is unrun: re-run it, and never record it as a negative",
    ),
    "the controller's admission gate no longer requires a control, or no longer says an uncontrolled cell is unrun rather than negative — the gate is the whole of change 1 in #990's Brief",
  );
});

test("the rule carries its measured reproduction, both shells, as one span", () => {
  // Both lines together. The bash line IS the control: on its own the zsh line
  // shows a variable with a surprising value, and nothing establishes that the
  // same text behaves differently elsewhere. Deleting the control line from a
  // reproduction is the mutation this ticket is about, committed against the
  // ticket's own evidence — so it must red here too.
  assert.match(
    justification(),
    span(
      `zsh  -c 'cfg="SETB=1 BADJ=1"; env $cfg sh ./probe.sh'   # BADJ=[unset] SETB=[1 BADJ=1]`,
      4,
      `bash -c 'cfg="SETB=1 BADJ=1"; env $cfg sh ./probe.sh'   # BADJ=[1]     SETB=[1]`,
    ),
    "the two-shell reproduction lost a line or was replaced by an assertion — #990 AC-4 requires the reproduction wherever the rule is justified",
  );
  assert.match(
    justification(),
    span(
      "zsh does not word-split an unquoted parameter expansion, so the whole string arrives as ONE argument",
      200,
      "the probe still exits 0",
    ),
    "the reproduction no longer states what it demonstrates, or dropped that the probe exits 0 — the exit code is why the no-op is silent rather than loud",
  );
});

test("the rule names both failure directions, not only the injection that never lands", () => {
  // #1153's direction is the one that retires a real defect rather than missing
  // one, and it is the direction a reader of the title alone does not get.
  assert.match(
    justification(),
    span(
      "It bites in both directions, and the reproduction direction is the worse one",
      400,
      "which is the signature of a correct refutation with nothing anomalous to notice",
    ),
    "the prose no longer names the reproduction-that-never-happened direction, or no longer says why it is worse — that half is the whole content of #990's second comment",
  );
});

// --- the sixth seat: the fix-applier's own mutation paragraph ----------------
const fixApplierMutationRule = () =>
  stripQuoteGutter(
    between(RUN_TEAM, "A mutation that never landed is not a green", "**Commit BEFORE you mutate", "run-team/SKILL.md fix-applier prompt"),
  );

test("the fix-applier prompt refuses a mutation nothing proved landed, and carries the same invocation form", () => {
  const seat = fixApplierMutationRule();
  assert.match(
    seat,
    span(
      "A mutation that never landed is not a green — it is a cell that did not run",
      120,
      "prove the injection reached the child before you read its result",
      260,
      "indistinguishable from a real no-effect result, and a reproduction that never happened reads as a refutation",
    ),
    "the fix-applier prompt no longer requires the injection be proved to have landed — its mutant-kill rule then reads a no-op mutation as a test that discriminates (#990)",
  );
  assert.match(seat, SAFE_FORM, "the fix-applier prompt lost the safe invocation form — the seat that does the most mutating is the one that most needs it");
  assert.match(seat, MECHANISM, "the fix-applier prompt dropped the mechanism");
  assert.match(seat, PORTABILITY, "the fix-applier prompt dropped the zsh-only-array note");
});

// --- the discriminating half -------------------------------------------------
// A pin that reddens on any edit is not a pin. Every REJECT row below is derived
// from the LIVE text and deletes exactly one clause; the ACCEPT row rewraps the
// same live text and must stay green. Without the ACCEPT row these would be
// satisfied by a whole-file-text assertion, which reddens on everything and
// discriminates nothing — the failure the fix-applier prompt's own mutant rule
// names.
const rewrap = (text, width = 34) => {
  const out = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line && (line + " " + word).length > width) {
      out.push(line);
      line = word;
    } else {
      line = line ? line + " " + word : word;
    }
  }
  if (line) out.push(line);
  return out.join("\n");
};

const REJECTS = [
  [
    "the control requirement is deleted",
    REFUTER_CONTROL,
    (t) => t.replace(phrase("A failure injection with no positive control has produced NO result, never a negative one."), ""),
  ],
  [
    "the control stays but what it IS is deleted",
    REFUTER_CONTROL,
    (t) =>
      t.replace(
        phrase("prove the injection reached the child: one run whose output differs with it present versus absent, or the child echoing the injected value back"),
        "be careful",
      ),
  ],
  [
    "the unquoted-scalar prohibition is deleted",
    SAFE_FORM,
    (t) => t.replace(phrase('NEVER from an unquoted scalar — `cfg="SETB=1 BADJ=1"; env $cfg sh ./probe.sh`'), ""),
  ],
  [
    "the prescribed array expansion loses its braces",
    SAFE_FORM,
    (t) => t.replace(phrase('env "${cfg[@]}" sh ./probe.sh`'), "env $cfg[@] sh ./probe.sh`"),
  ],
  [
    "the zsh-only-array note is deleted",
    PORTABILITY,
    (t) => t.replace(phrase("`env $cfg[@]` is not the portable spelling either: measured, bash word-splits it into `SETB=1` and `BADJ=1[@]`, so the injection variable is set to a corrupted value, while zsh behaves exactly as with the bare `$cfg` — `BADJ` never set, exit 0"), ""),
  ],
  [
    "a sentence is spliced INSIDE the prescription",
    SAFE_FORM,
    (t) => t.replace(phrase("or inline the assignments literally"), "or, where the harness is short enough to read at a glance and nobody is watching, inline the assignments literally"),
  ],
];

for (const [name, getSeat] of SEATS) {
  test(`${name}: the pins refuse each mutation and accept a reflow`, () => {
    const live = getSeat();
    for (const [what, pin, mutate] of REJECTS) {
      const mutant = mutate(live);
      assert.notEqual(mutant, live, `the "${what}" mutation did not change ${name} — the pin is measured against text that is no longer there`);
      assert.doesNotMatch(mutant, pin, `${name} still matches with ${what} — that pin does not pin`);
    }
    assert.match(rewrap(live), REFUTER_CONTROL, `${name}: a reflow reds the control pin — these refuse drift, not layout`);
    assert.match(rewrap(live), SAFE_FORM, `${name}: a reflow reds the invocation-form pin`);
    assert.match(rewrap(live), PORTABILITY, `${name}: a reflow reds the portability pin`);
  });
}

test("the fix-applier seat's pins refuse the same mutations and accept a reflow", () => {
  const live = fixApplierMutationRule();
  for (const [what, pin, mutate] of REJECTS) {
    if (pin === REFUTER_CONTROL) continue; // that wording is the refuters'; this seat states the rule in its own voice
    const mutant = mutate(live);
    assert.notEqual(mutant, live, `the "${what}" mutation did not change the fix-applier seat`);
    assert.doesNotMatch(mutant, pin, `the fix-applier seat still matches with ${what} — that pin does not pin`);
  }
  assert.match(rewrap(live), SAFE_FORM, "the fix-applier seat: a reflow reds the invocation-form pin");
});

test("the controller's justification pins refuse a stripped reproduction and accept a reflow", () => {
  const live = justification();
  const repro = span(
    `zsh  -c 'cfg="SETB=1 BADJ=1"; env $cfg sh ./probe.sh'   # BADJ=[unset] SETB=[1 BADJ=1]`,
    4,
    `bash -c 'cfg="SETB=1 BADJ=1"; env $cfg sh ./probe.sh'   # BADJ=[1]     SETB=[1]`,
  );
  const controlLineDeleted = live.replace(phrase(`bash -c 'cfg="SETB=1 BADJ=1"; env $cfg sh ./probe.sh'   # BADJ=[1]     SETB=[1]`), "");
  assert.notEqual(controlLineDeleted, live, "the reproduction's bash line is no longer where this mutation looks for it");
  assert.doesNotMatch(controlLineDeleted, repro, "the reproduction still matches with its control line deleted — a one-shell transcript proves nothing about word-splitting");
  const gate = span(
    "a negative result is admitted only together with its **positive control**",
    200,
    "the child's output differing with the injection present versus absent or the child echoing the injected value back",
    120,
    "No control → the cell is unrun: re-run it, and never record it as a negative",
  );
  assert.doesNotMatch(
    live.replace(phrase("No control → the cell is unrun: re-run it, and never record it as a negative"), "Prefer a control."),
    gate,
    "the admission gate still matches once the refusal is softened to a preference — a gate that only recommends is not the gate #990 asked for",
  );
  // The reproduction is a fenced block whose alignment is load-bearing to the
  // eye but not to the pin, so the reflow row here rewraps the PROSE pins only.
  assert.match(rewrap(live), gate, "a reflow reds the admission-gate pin");
});
