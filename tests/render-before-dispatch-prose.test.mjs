// `ledger.mjs dispatch` refuses a member whose brief `dispatch-prompt.mjs
// render --member <name>` never rendered for its role, so every place
// run-team's SKILL.md dispatches a ledger-family member states the render
// first. These pins hold that order, one per dispatch sentence, and that
// every `--kind` a render command names is a kind of its template.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pin } from "./support/prose-pin.mjs";

const PLUGIN = join(import.meta.dirname, "..", "plugin");
const RUN_TEAM = Pin.file(join(PLUGIN, "skills", "run-team", "SKILL.md"));
// The tick rows' full text moved into references/tick-rows.md; SKILL.md keeps one line for each.
const TICK_ROWS = Pin.file(join(PLUGIN, "skills", "run-team", "references", "tick-rows.md"));
// Phase 2's record-the-dispatch paragraph moved into references/pull.md.
const PULL_MD = Pin.file(join(PLUGIN, "skills", "run-team", "references", "pull.md"));

test("phase 2 renders the implementer's brief, then records the dispatch, and the call is handed the printed brief", () => {
  const p = PULL_MD.paragraph("**Record the dispatch before you make it.**", "references/pull.md record-the-dispatch paragraph", "**The prompt carries only what varies.**").text;
  assert.match(p, Pin.phrase("`~/.fleet/bin/fleet-run dispatch-prompt.mjs render implementer --member impl-<N> …` then renders its brief, and `~/.fleet/bin/fleet-run ledger.mjs dispatch <N> impl-<N>` marks `impl-<N>` live on it and in `## Dispatched`, and the call follows."));
  assert.match(p, Pin.phrase("Its JSON carries `agent`, the definition that call names, and `brief.path`, the rendered brief whose content is that call's prompt — read both off that output, never recall them."));
  assert.match(p, Pin.phrase("`dispatch` refuses a member with no brief rendered for its role, naming the `render` command to run first"));
});

test("each fix-applier kind renders its brief before ledger.mjs dispatch records it", () => {
  const review = RUN_TEAM.bullet("- **The fix-applier.**", "- **The conflict hold.**", "review fix-applier bullet").text;
  assert.match(review, Pin.phrase("render with `dispatch-prompt.mjs render fix-applier --kind review --member fix-pr-<pr#> …`, then record `ledger.mjs dispatch <pr#> fix-pr-<pr#>` before the call."));
  const conflict = RUN_TEAM.bullet("- **The conflict hold.**", "- **Then dispatch a red-check fixer**", "conflict fix-applier bullet").text;
  assert.match(conflict, Pin.phrase("render with `dispatch-prompt.mjs render fix-applier --kind conflict --member <name> …`; dispatch with the `agent` `ledger.mjs dispatch` printed"));
  const red = RUN_TEAM.bullet("- **Then dispatch a red-check fixer**", "- **The merge bot.**", "red-check fixer bullet").text;
  assert.match(red, Pin.phrase("render with `dispatch-prompt.mjs render fix-applier --kind red-check --member <name> …`, record with `ledger.mjs dispatch <pr#> <name>` before the call"));
  const retry = RUN_TEAM.paragraph("**A `DISPATCH fix-pr PR#<M>` on a dispositions mismatch**", "dispositions retry paragraph", "### The main-gain hit").text;
  assert.match(retry, Pin.phrase("dispatched like the first, its brief rendered with `--kind dispositions-retry`."));
});

test("the finisher renders its brief, then is recorded, then dispatched", () => {
  const p = RUN_TEAM.paragraph("**The fix-applier pushes and exits", "finisher dispatch paragraph", "**That `dispatch` refuses a finisher").text;
  assert.match(p, Pin.phrase("Render its brief with `dispatch-prompt.mjs render finisher --kind fresh --member finisher-pr-<pr#> …` (`--kind repair` once an earlier finisher reported `labelled` without the label landing), record it with `ledger.mjs dispatch <pr#> finisher-pr-<pr#>` before the call, then"));
});

test("a replacement finisher's brief is rendered before ledger.mjs dispatch records it", () => {
  const moved = TICK_ROWS.bullet("- `DISPATCH finisher PR#<M> …`", "- `ESCALATE unlabelled PR#<M> …`", "DISPATCH finisher tick-line bullet").text;
  assert.match(moved, Pin.phrase("render its brief with `dispatch-prompt.mjs render finisher --kind repair --member finisher-pr-<M>-<x> …`, then `ledger.mjs dispatch <M> finisher-pr-<M>-<x>`."));
  const died = RUN_TEAM.paragraph("**Resolving a finisher that died.**", "finisher-died paragraph", "### Dispositions escalation").text;
  assert.match(died, Pin.phrase("render its brief with `dispatch-prompt.mjs render finisher --kind fresh --member finisher-pr-<M>-<x> …` (`--kind repair` once an earlier finisher reported `labelled` without the label landing), then `ledger.mjs dispatch <M> finisher-pr-<M>-<x>`."));
});

test("the ledger reference says what dispatch records of the brief, prints, and refuses", () => {
  const b = RUN_TEAM.bullet("- **`ledger.mjs dispatch <ticket|pr> <member>`**", "- **`ledger.mjs settle <member> <outcome>`**", "ledger.mjs dispatch reference bullet").text;
  assert.match(b, Pin.phrase("appends it to `## Dispatched` with `brief=<first 8 hex of its brief's sha256>`."));
  assert.match(b, Pin.phrase("It prints `{member, agent, ticket, line, created, total, brief}`, `brief` the `{path, sha256}` of the rendered brief the `task` call is handed;"));
  assert.match(b, Pin.phrase("refuses a member whose `briefs/<member>.json` beside the ledger is missing, names another role or carries no sha256, a brief file beside it that is missing or does not hash to that sha256,"));
});

// The kinds a template carries, off its `## kind:` lines — the renderer's own
// grammar for them, so a render command naming a kind the template lacks is
// one the controller could not run.
const kindsOf = (role) => new Set(readFileSync(join(PLUGIN, "skills", "run-team", "briefs", `${role}.md`), "utf8")
  .split("\n").flatMap((l) => /^## kind: (.+)$/.exec(l)?.[1].split(",").map((k) => k.trim()) ?? []));

test("every --kind SKILL.md's render commands name is a kind of that role's template", () => {
  const text = RUN_TEAM.text.replace(/\s+/g, " ");
  const named = [...text.matchAll(/dispatch-prompt\.mjs render ([a-z-]+) --kind ([a-z-]+)/g)].map(([, role, kind]) => [role, kind]);
  assert.deepEqual([...new Set(named.map(([role]) => role))].sort(), ["finisher", "fix-applier"], "the render commands this pins are the kinded roles'");
  for (const [role, kind] of named) assert.ok(kindsOf(role).has(kind), `${role}.md has no kind ${kind}`);
  // Every fix-applier kind has a dispatch sentence that renders it.
  for (const kind of kindsOf("fix-applier")) {
    assert.ok(named.some(([r, k]) => r === "fix-applier" && k === kind) || text.includes(`its brief rendered with \`--kind ${kind}\``), `no SKILL.md render command names fix-applier --kind ${kind}`);
  }
});
