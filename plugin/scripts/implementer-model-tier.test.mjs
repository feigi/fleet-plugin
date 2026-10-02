import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between as section } from "./prose-pin.mjs";

// Implementers dispatch at the tier their DEFINITION declares, never one the
// controller passes: the dispatch rule omits `model` and names the definition
// `ledger.mjs dispatch` printed. Nothing outside this file pins either half of
// that rule. A dispatch that breaks it is caught only after the fact, at run
// time: tier-check.mjs compares the agent the member ran as, and the model and
// level the harness resolved, against the definition its ledger row names.
//
// Slice by named anchors and fail loudly when one moves; slice SIZE is what
// does the work. One slice per paragraph, never per phase: widen a slice to its
// phase and a neighbouring paragraph satisfies the pin on its own.
const REPO = join(import.meta.dirname, "..");
const RUN_TEAM = readFileSync(join(REPO, "skills", "run-team", "SKILL.md"), "utf8");

// The first two slices each run from a named paragraph to the next anchor named
// here, several paragraphs on, so a neighbouring paragraph can satisfy a pin
// read over them. A failure here means the text was deleted OR relocated —
// check the rest of the file before assuming deletion.
const dispatch = () =>
  section(RUN_TEAM, "**Dispatch every implementer", "**Guard: accumulate per PR", "run-team phase 2 dispatch rule");
const guard = () =>
  section(RUN_TEAM, "**Guard: accumulate per PR", "Why the agent body carries what it does", "run-team phase 2 tier guard");
// Paragraph-tight: the dispatch rule alone, ending where the tier check opens.
// The paragraphs past it recount historical rows by vendor model name, so an
// absence pin read over `dispatch()` would refuse the file as it stands.
const dispatchRule = () =>
  section(RUN_TEAM, "**Dispatch every implementer", "**After every Pull's dispatch", "run-team phase 2 dispatch rule paragraph");

test("phase 2 dispatches every implementer at its definition's tier, and says so with a mechanism", () => {
  const slice = dispatch();

  // Anchored to the omission, not the word "inherit": the tier is obtained by
  // NOT passing `model`, and "implementers run at the session tier" with no
  // mechanism is exactly the instruction-names-no-mechanism defect the skill's
  // own tooling-fix triggers list calls out.
  assert.match(
    slice,
    /dispatched with `model` set does not get the declared\s+tier back/,
    "phase 2 no longer says HOW the declared tier is obtained — omitting `model` is still the mechanism",
  );
  // The omission resolves to the DEFINITION's tier first and the session's only
  // after. Stated without that ordering, "omit `model`" reads as "inherit the
  // session", which is what the declaration was written to stop being true.
  assert.match(
    slice,
    /session's tier applies only when the definition\s+names none/,
    "phase 2 states the omission mechanism without saying the definition's tier wins first",
  );
  // The dispatch rule has to name WHERE the definition comes from, or the
  // tier is declared somewhere the reader of this phase can neither find nor
  // audit. Since #2208 that is the `agent` `ledger.mjs dispatch` prints — a
  // name recalled from this prose is exactly what a compaction dropped (#2208
  // counts 11 implementers dispatched as generic `task`).
  assert.match(
    slice,
    /Dispatch every implementer with the `agent` that `ledger\.mjs dispatch`\s+printed/,
    "phase 2 no longer dispatches the agent ledger.mjs dispatch printed",
  );
  assert.match(
    slice,
    /agents\/fleet-implementer\.agent\.md/,
    "phase 2 no longer says WHERE the declared tier lives",
  );
  // `name` is orthogonal to `agent` and is what confers team membership —
  // the ledger token and the hub address; both the spend classifier and
  // member-outcomes.mjs read it. A rewrite that swaps the name for the
  // agent silently unmakes the member.
  assert.match(
    slice,
    /Keep `name: impl-<N>`/,
    "phase 2 no longer keeps the impl-<N> name alongside the dispatched agent",
  );
  // `row` REPLACES the line (ledger.mjs's `data.rows[i] = line`). Replaying a
  // two-token literal over a row carrying KILLED or → PR# drops those tokens with
  // only `rewrote row #N` on stderr.
  assert.match(
    slice,
    /replaces the whole line/,
    "phase 2 shows a ledger literal without saying `row` replaces rather than appends",
  );
});

// The rule is "omit `model`", so the paragraph that states it names no value
// for `model` and no vendor model at all. The pins above assert the mechanism
// is present and stay green beside an appended sentence that contradicts it —
// measured: `Pass `model: "sonnet"` when the ticket is class=routine.` added
// before `Keep `name: impl-<N>``, full suite green. The paragraph's own
// "`model` set" and "omit `model`" are what these must accept: neither puts a
// colon after the word.
test("phase 2's dispatch rule binds no model value to any ticket", () => {
  const slice = dispatchRule();
  assert.doesNotMatch(
    slice,
    /\bmodel\b`?:\s*\S/,
    "phase 2's dispatch rule now passes a `model` value — the declared tier is obtained by omitting it",
  );
  assert.doesNotMatch(
    slice,
    /\b(?:sonnet|opus|haiku)\b/i,
    "phase 2's dispatch rule now names a vendor model — the tier lives in the definition's frontmatter, as a route",
  );
});

test("phase 2's append duty is mandatory and per PR", () => {
  const slice = guard();

  // The unit. Supply is one Pull per free slot (ADR 0013), so no batch of
  // implementers exists to compare — the original rule compared one staged set
  // of implementers against the set before it, two sets nobody can enumerate.
  assert.match(slice, /unit is the PR/, "the guard's unit is no longer the PR");
  assert.match(
    slice,
    /no implementer batches/,
    "the guard no longer says why a batch is not a usable unit — it comes back otherwise",
  );

  // Normative, not advisory. This repo runs prose-compression passes that hedge
  // exactly that way.
  //
  // A `/^\*\*Guard: /` pin sat here and was DELETED as a tautology (#529) — do
  // not restore it on finding the guard heading unpinned. `section()` returns
  // `source.slice(indexOf(startAnchor), end)`, so the slice opens with this
  // block's start anchor whatever the end anchor is, and that regex carried no
  // `m` flag: the start anchor alone satisfied it. A lead that breaks it breaks
  // the anchor too, so `section()` reds first, under its own message.
  //
  // Settled by mutation, not argument. Replace the guard lead's
  // `never conclude inside one run.**` with `never conclude inside one run —
  // advisory, at your discretion, skip when time is short.**` in
  // run-team/SKILL.md — the start anchor survives — then run
  // `node --test plugin/scripts/*.test.mjs`: the suite stays green and
  // the deleted pin's message appears nowhere in the output. Quote that whole
  // span, not the `one run.**` tail: the tail is not unique in that SKILL, and
  // its other hit is the `**Why not decide inside one run.**` heading that
  // member-outcomes-prose.test.mjs uses as a `section()` end anchor — a global
  // replace on the tail reds THAT suite, which reads as the deleted pin
  // catching the hedge. Restore with `cp`, never `git checkout --`.
  //
  // That green is a recorded gap, not an open question:
  // docs/adr/0017-prose-pins-pin-content-not-modality.md rules that prose
  // pins pin content, never modality, and that this guard's obligation gets
  // a code carrier — a script verdict surfaced as a fleet-tick row — with
  // #2037's successor guard, not a stronger pin here. Until that lands, the
  // mutation above stays green. The list below is a literal-word tripwire
  // ONLY: it catches `Optional` and `you may` and nothing else, and the
  // reworded lead uses neither. Widening it is ruled out by the same ADR,
  // because that instrument was measured failing (#476).
  assert.doesNotMatch(
    slice,
    /\bOptional\b|\byou may\b/i,
    "the guard has been downgraded to advice — an optional guard is not a guard",
  );
});

// ---------------------------------------------------------------------------
// THE DECLARATION ITSELF. Every pin above reads SKILL.md, so a tier changed in
// `agents/fleet-implementer.agent.md` leaves all of them green while the
// dispatched tier flips — the same silent drift they exist to catch, routed
// around the document they read. That hazard is why the declaration arrived
// with these three.
const frontmatterOf = (name) =>
  readFileSync(join(REPO, "agents", `${name}.agent.md`), "utf8").split("---")[1] ?? "";

test("the implementer definition declares a model carrying both a role and a level", () => {
  // The declaration is one key, `model: "@<role>:<level>"` — the level rides
  // on the model's own suffix (ADR 0014), so there is no second key to omit
  // independently and leave the level inherited from whatever session
  // dispatched the member.
  const fm = frontmatterOf("fleet-implementer");
  assert.match(fm, /^model:\s*"@(slow|task|smol):(minimal|low|medium|high|xhigh|max)"$/m, "the implementer definition declares no tier route");
});

test("the declared model is a fleet tier route, never a vendor id — both definitions", () => {
  // A vendor id rots into a superseded generation that is weaker AND
  // dearer: pricing falls with each generation. The role alias tracks
  // whatever model the operator's `modelRoles` currently points it at.
  // Both definitions, not just the default: #1345's dispatch-time tier
  // check compares this same field on fleet-implementer-alt, and a vendor
  // id there would fail the role-target comparison silently reading as a
  // real mismatch rather than a declaration defect.
  for (const name of ["fleet-implementer", "fleet-implementer-alt"]) {
    const model = /^model:\s*"?(\S+?)"?$/m.exec(frontmatterOf(name))?.[1];
    assert.match(model, /^@(slow|task|smol):(minimal|low|medium|high|xhigh|max)$/, `${name}: not a tier route: ${model}`);
  }
});

test("the definition lists no tools — a list would drop dispatch capability", () => {
  // references/member-lifecycle.md's "Every member is named" section: the
  // name is the ledger token and the hub address — a `tools:` list that
  // narrows what the member can call costs it silently, with no error.
  // Omit the key.
  assert.doesNotMatch(frontmatterOf("fleet-implementer"), /^tools:/m);
});

// ADR 0014's ruling records the layer-1 (#1314) key set for every fleet
// agent file: `name`, `description`, `model` — the level no longer rides a
// separate key. This file only pins the two implementer definitions #1345's
// dispatch-time tier check reads — #1314 owns the general checker over
// every agent file in the tree.
test("both implementer definitions carry all three required keys", () => {
  for (const name of ["fleet-implementer", "fleet-implementer-alt"]) {
    const fm = frontmatterOf(name);
    for (const key of ["name", "description", "model"]) {
      assert.match(fm, new RegExp(`^${key}:\\s*\\S`, "m"), `${name}.agent.md declares no ${key}`);
    }
  }
});

// The alt definition differing from the default in ROLE ONLY is pinned in
// within-run-pair-prose.test.mjs's "the alternate definition differs from
// the default in ROLE ONLY, the level stays shared" — not repeated here.
// That test already asserts the level suffix is shared and the role alone
// diverges; duplicating it here would just be a second copy to keep in
// sync with the same two files.
