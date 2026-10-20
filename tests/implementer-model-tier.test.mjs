import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Pin } from "./support/prose-pin.mjs";
import { CELL_DEF } from "../plugin/scripts/ledger-grammar.mjs";

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
const REPO = join(import.meta.dirname, "..", "plugin");
const RUN_TEAM = Pin.file(join(REPO, "skills", "run-team", "SKILL.md"));

// The first two slices each run from a named paragraph to the next anchor named
// here, several paragraphs on, so a neighbouring paragraph can satisfy a pin
// read over them. A failure here means the text was deleted OR relocated —
// check the rest of the file before assuming deletion.
const MEMBER_LIFECYCLE = Pin.file(join(REPO, "skills", "run-team", "references", "member-lifecycle.md"));
const TICK_ROWS = Pin.file(join(REPO, "skills", "run-team", "references", "tick-rows.md"));
const dispatch = () =>
  RUN_TEAM.section("### Dispatching the Pull's member", "run-team dispatch section").text;
const memberLifecycleTier = () =>
  MEMBER_LIFECYCLE.between("## The implementer's tier is the definition's", "## The merge bot's tier", "member-lifecycle implementer-tier section").text;
const memberTickRows = () => TICK_ROWS.text;
const guard = () =>
  RUN_TEAM.between("**Guard: accumulate per PR", "**A verdict is a measurement only if it post-dates", "run-team tier outcomes guard").text;
// Why the unit is the PR moved with the guard's rationale to references/pull.md.
const PULL_MD = Pin.file(join(REPO, "skills", "run-team", "references", "pull.md"));
const guardRationale = () =>
  PULL_MD.section("## Accumulate per PR, never conclude a tier result inside one run", "references/pull.md tier-outcomes section").text;
// Paragraph-tight: the implementer bullet alone, ending where the tier check opens.
// The paragraphs past it recount historical rows by vendor model name, so an
// absence pin read over `dispatch()` would refuse the file as it stands.
const dispatchRule = () =>
  RUN_TEAM.bullet("- **The implementer.**", "- **The tier check.**", "run-team implementer dispatch bullet").text;

test("the dispatch section dispatches every implementer at its definition's tier, and says so with a mechanism", () => {
  const slice = dispatch();
  const tier = memberLifecycleTier();

  // Anchored to the omission, not the word "inherit": the tier is obtained by
  // NOT passing `model`, and "implementers run at the session tier" with no
  // mechanism is exactly the instruction-names-no-mechanism defect the skill's
  // own tooling-fix triggers list calls out. The mechanism is explained in
  // references/member-lifecycle.md; the retained dispatch rule keeps the omission.
  assert.match(
    slice,
    /omit `model`/,
    "the dispatch section no longer says HOW the declared tier is obtained — omitting `model` is still the mechanism",
  );
  assert.match(
    tier,
    /dispatched with `model` set does not get the declared\s+tier back/,
    "member-lifecycle no longer says a `model` value overrides the declared tier",
  );
  // The omission resolves to the DEFINITION's tier first and the session's only
  // after. Stated without that ordering, "omit `model`" reads as "inherit the
  // session", which is what the declaration was written to stop being true.
  assert.match(
    tier,
    /session's tier applies only when the definition\s+names none/,
    "member-lifecycle states the omission mechanism without saying the definition's tier wins first",
  );
  // The dispatch rule has to name WHERE the definition comes from, or the
  // tier is declared somewhere the reader of this section can neither find nor
  // audit. That is the `agent` `ledger.mjs dispatch` prints — a name recalled
  // from this prose is exactly what a compaction dropped (#2208 counts 11
  // implementers dispatched as generic `task`).
  assert.match(
    slice,
    /Dispatch with the printed `agent`/,
    "the dispatch section no longer dispatches the agent ledger.mjs dispatch printed",
  );
  assert.match(
    tier,
    /agents\/fleet-implementer-<cell>\.agent\.md/,
    "member-lifecycle no longer says WHERE the declared tier lives",
  );
  // `name` is orthogonal to `agent` and is what confers team membership —
  // the ledger token and the hub address; both the spend classifier and
  // member-outcomes.mjs read it. A rewrite that swaps the name for the
  // agent silently unmakes the member.
  assert.match(
    tier,
    /Keep `name: impl-<N>`/,
    "member-lifecycle no longer keeps the impl-<N> name alongside the dispatched agent",
  );
  assert.match(slice, /keep `name: impl-<N>`/, "the dispatch section no longer keeps the impl-<N> name");
  // `row` REPLACES the line (ledger.mjs's `data.rows = after`, `line` in place
  // of the old row). The `token` addition is the script's own behaviour, pinned
  // in tests/ledger.test.mjs ("token appends to the row and keeps every token
  // already there, in order"); the replace-not-append rule is in tick-rows.md,
  // and the controller's rule sending a token addition to `token` is the wake section's.
  assert.match(
    memberTickRows(),
    /replaces the whole line/,
    "tick-rows.md no longer says `row` replaces the whole line rather than appending",
  );
  assert.match(
    RUN_TEAM.section("### What a wake owes beyond its call", "run-team wake section").text,
    Pin.phrase("`ledger.mjs token <key> <token>…` adds a token and keeps every token already on the row"),
    "The wake section no longer sends a token addition to `token`, so a controller re-types the row with `row` and drops its tokens",
  );
});

// The rule is "omit `model`", so the paragraph that states it names no value
// for `model` and no vendor model at all. The pins above assert the mechanism
// is present and stay green beside an appended sentence that contradicts it —
// measured: `Pass `model: "sonnet"` when the ticket is class=routine.` added
// before `Keep `name: impl-<N>``, full suite green. The paragraph's own
// "`model` set" and "omit `model`" are what these must accept: neither puts a
// colon after the word.
test("the dispatch section's implementer rule binds no model value to any ticket", () => {
  const slice = dispatchRule();
  assert.doesNotMatch(
    slice,
    /\bmodel\b`?:\s*\S/,
    "the dispatch section's implementer rule now passes a `model` value — the declared tier is obtained by omitting it",
  );
  assert.doesNotMatch(
    slice,
    /\b(?:sonnet|opus|haiku)\b/i,
    "the dispatch section's implementer rule now names a vendor model — the tier lives in the definition's frontmatter, as a route",
  );
});

test("the tier outcomes guard's append duty is mandatory and per PR", () => {
  const slice = guard();

  // The unit. Supply is one Pull per free slot (ADR 0013), so no batch of
  // implementers exists to compare — the original rule compared one staged set
  // of implementers against the set before it, two sets nobody can enumerate.
  assert.match(guardRationale(), /unit is the PR/, "the guard's unit is no longer the PR");
  assert.match(
    guardRationale(),
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
  // `node --test tests/*.test.mjs`: the suite stays green and
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
// an `agents/fleet-implementer-<cell>.agent.md` leaves all of them green while
// the dispatched tier flips — the same silent drift they exist to catch,
// routed around the document they read. That hazard is why the declaration
// arrived with these pins, and why they walk every implementer definition on
// disk rather than a list of names: a cell added tomorrow is pinned the day it
// lands (spec 2026-09-28 § 2).
const AGENTS = join(REPO, "agents");
const PREFIX = "fleet-implementer-";
const implementers = () =>
  readdirSync(AGENTS).filter((f) => f.startsWith("fleet-implementer") && f.endsWith(".agent.md")).map((f) => f.slice(0, -".agent.md".length)).sort();
const fileOf = (name) => readFileSync(join(AGENTS, `${name}.agent.md`), "utf8");
const frontmatterOf = (name) => fileOf(name).split("---")[1] ?? "";

test("every implementer definition is named for a cell and declares exactly the route its name derives", () => {
  // The declaration is one key, `model: "@<role>:<level>"` — the level rides
  // on the model's own suffix (ADR 0014), so there is no second key to omit
  // independently and leave the level inherited from whatever session
  // dispatched the member. A route, never a vendor id: a vendor id rots into
  // a superseded generation that is weaker AND dearer, while the role alias
  // tracks whatever `modelRoles` currently points it at. And the route is the
  // NAME's: tier-check judges a `tier=<cell>` row against the definition that
  // cell names, so a file whose route disagrees with its name runs every row
  // at a cell nobody drew.
  const names = implementers();
  assert.ok(names.includes(`${PREFIX}slow-high`), `the policy cell's definition is missing: ${names.join(", ")}`);
  for (const name of names) {
    assert.ok(CELL_DEF.test(name), `${name}.agent.md is not named fleet-implementer-<cell> — nothing is named fleet-implementer alone`);
    const [role, level] = name.slice(PREFIX.length).split("-");
    const fm = frontmatterOf(name);
    assert.match(fm, new RegExp(`^model: "@${role}:${level}"$`, "m"), `${name}.agent.md does not declare model: "@${role}:${level}"`);
    assert.match(fm, new RegExp(`^name: ${name}$`, "m"), `${name}.agent.md's name: is not its file name`);
  }
});

test("every implementer definition lists no tools — a list would drop dispatch capability", () => {
  // references/member-lifecycle.md's "Every member is named" section: the
  // name is the ledger token and the hub address — a `tools:` list that
  // narrows what the member can call costs it silently, with no error.
  // Omit the key.
  for (const name of implementers()) assert.doesNotMatch(frontmatterOf(name), /^tools:/m, name);
});

// ADR 0014's ruling records the layer-1 (#1314) key set for every fleet
// agent file: `name`, `description`, `model` — the level no longer rides a
// separate key. This file only pins the implementer definitions #1345's
// dispatch-time tier check reads — #1314 owns the general checker over
// every agent file in the tree.
test("every implementer definition carries all three required keys", () => {
  for (const name of implementers()) {
    const fm = frontmatterOf(name);
    for (const key of ["name", "description", "model"]) {
      assert.match(fm, new RegExp(`^${key}:\\s*\\S`, "m"), `${name}.agent.md declares no ${key}`);
    }
  }
});

test("every implementer definition's body is byte-identical (#1801)", () => {
  // #1801 moved the shared implementer background into the definitions'
  // BODIES, on the premise that a member reads its own agent.md body as
  // `§ Role` whichever prompt dispatched it (measured on #1777: omp injects
  // the body verbatim). A body that drifts between cells dispatches
  // differently-briefed implementers under one label, and a cell comparison
  // then measures the brief as well as the model — silently: the frontmatter
  // pins above read one line each. Exact string equality over the whole body
  // is the tightest pin this claim admits; nothing benign satisfies it by
  // accident.
  const body = (name) => fileOf(name).split("---").slice(2).join("---");
  const [first, ...rest] = implementers();
  assert.ok(rest.length > 0, "fewer than two implementer definitions — nothing to compare");
  for (const name of rest) {
    assert.equal(body(name), body(first), `${name}'s body has diverged from ${first}'s — the shared background must be pasted identically into every cell`);
  }
});
