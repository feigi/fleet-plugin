// The fix-applier, finisher and merge-bot agent definitions carry the text that
// never varies between dispatches of the role, and each role's brief template
// carries only what varies. Three things are pinned:
//
//   (1) none of the three bodies is the one-line "follow your brief" it used
//       to be, and the fix-applier's definition is a tier route the checkers
//       accept;
//   (2) the body and the rendered brief TOGETHER hold every sentence of the
//       text the controller used to paste into the dispatch prompt — nothing
//       lost, nothing duplicated across the pair;
//   (3) the pre-change text is a fixture this test owns
//       (fixtures/pre-split-blocks/), never read off SKILL.md, so deleting
//       the blocks there cannot loosen the check.
//
// THE CEILING. (2) counts sentences, split after terminal punctuation (`.`,
// `!` or `?`) and whitespace, before a capital, an opening backtick, bold
// marker, bracket, quote or `<`, after folding every run of whitespace — so a
// re-wrap of the text passes and a reworded sentence does not. A sentence the
// pre-change text states twice (the nested refuter prompt repeats the kill
// rules) is expected twice, not once.
// Text ADDED to a body or a brief is not seen: this is a no-loss, no-duplicate
// check, not a check that nothing new was written.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkFields, parseAllowlist, parseFrontmatter } from "../plugin/scripts/frontmatter-check.mjs";
import { checkRoutes, parseModelRoute } from "../plugin/scripts/tier-roles.mjs";

const PLUGIN = fileURLToPath(new URL("../plugin/", import.meta.url));
const AGENTS = join(PLUGIN, "agents");
const FIXTURES = fileURLToPath(new URL("./fixtures/pre-split-blocks/", import.meta.url));

const TMP = realpathSync(mkdtempSync(join(tmpdir(), "member-bodies-split-")));
after(() => rmSync(TMP, { recursive: true, force: true }));

const agentText = (name) => readFileSync(join(AGENTS, `${name}.agent.md`), "utf8");
const bodyOf = (text) => text.slice(text.indexOf("\n---\n", 4) + "\n---\n".length);

// --- (1) the bodies ---------------------------------------------------------

// A phrase only each role's own invariant text holds, so a body that is long
// but about something else is not a pass.
const BODIES = [
  { name: "fleet-fix-applier", marker: "resolve a bare relative path against the SESSION ROOT" },
  { name: "fleet-finisher", marker: "finisher-audit.mjs" },
  { name: "fleet-merge-bot", marker: "`status` is a READ-ONLY variable in zsh" },
];

for (const { name, marker } of BODIES) {
  test(`${name}: the body is no one-liner and carries its role's invariant text`, () => {
    const body = bodyOf(agentText(name));
    assert.ok(!body.includes("Follow the dispatch brief you were given"), "the retired one-line body is back");
    assert.ok(body.split("\n").filter((l) => l.trim() !== "").length > 10, "the body is a handful of lines");
    assert.ok(body.includes(marker), `the body does not carry ${JSON.stringify(marker)}`);
  });
}

test("fleet-finisher: the body names finisher-audit.mjs at duty 1 and finisher-label.mjs at duty 3", () => {
  const body = bodyOf(agentText("fleet-finisher"));
  const at = (s) => body.indexOf(s);
  assert.ok(at("**Duty 1 is one script") !== -1 && at("fleet-run finisher-audit.mjs") > at("**Duty 1 is one script"));
  assert.ok(at("**Duty 3 is one script") !== -1 && at("fleet-run finisher-label.mjs") > at("**Duty 3 is one script"));
});

const ROLES = { slow: "anthropic/claude-opus-5:auto", task: "anthropic/claude-sonnet-5:auto", smol: "anthropic/claude-haiku-4-5:auto" };
const ADAPTIVE = ["low", "medium", "high", "xhigh", "max"];
const CATALOG = {
  models: [
    { provider: "anthropic", id: "claude-opus-5", selector: "anthropic/claude-opus-5", thinking: ADAPTIVE },
    { provider: "anthropic", id: "claude-sonnet-5", selector: "anthropic/claude-sonnet-5", thinking: ADAPTIVE },
    { provider: "anthropic", id: "claude-haiku-4-5", selector: "anthropic/claude-haiku-4-5", thinking: ["minimal", "low", "medium", "high", "xhigh"] },
  ],
};

test("fleet-fix-applier: model is a @<role>:<level> route, and tier-roles accepts the shipped agents directory with it", () => {
  const fm = parseFrontmatter(agentText("fleet-fix-applier"));
  assert.equal(fm.error, undefined);
  const model = fm.fields.find((f) => f.key === "model")?.value;
  assert.deepEqual(parseModelRoute(model), { role: "slow", level: "high" });
  const r = checkRoutes({ agentsDir: AGENTS, modelRoles: ROLES, overrides: {}, catalog: CATALOG });
  assert.deepEqual(r.violations, []);
});

// omp gives a definition that declares no `spawns` the empty spawn policy, so a fix-applier
// without one cannot dispatch the refuters its own body tells it to dispatch.
test("fleet-fix-applier: its spawn policy allows the task agent its body tells it to dispatch refuters through", () => {
  const text = agentText("fleet-fix-applier");
  const fm = parseFrontmatter(text);
  assert.equal(fm.error, undefined);
  const spawns = fm.fields.find((f) => f.key === "spawns")?.value;
  assert.ok(spawns, "fleet-fix-applier.agent.md declares no spawns field");
  assert.ok(spawns.split(",").map((s) => s.trim()).includes("task"), `spawns is ${spawns}`);
  assert.match(bodyOf(text), /dispatch ONE refuter/);
});

test("tier-roles refuses a fix-applier definition whose model is not a route (the control for the accepting case above)", () => {
  const dir = join(TMP, "bad-route");
  mkdirSync(dir);
  writeFileSync(join(dir, "fleet-fix-applier.agent.md"), agentText("fleet-fix-applier").replace('model: "@slow:high"', "model: opus"));
  const r = checkRoutes({ agentsDir: dir, modelRoles: ROLES, overrides: {}, catalog: CATALOG });
  assert.equal(r.violations.length, 1);
  assert.match(r.violations[0], /fleet-fix-applier\.agent\.md/);
});

test("frontmatter-check accepts the fix-applier definition against the shipped allow-list, and refuses a forbidden key on it", () => {
  const { allowlist, error } = parseAllowlist(readFileSync(join(PLUGIN, "scripts", "frontmatter-allowlist.json"), "utf8"));
  assert.equal(error, undefined);
  const { fields } = parseFrontmatter(agentText("fleet-fix-applier"));
  assert.deepEqual(checkFields("agents", allowlist, fields), []);
  const withEffort = [...fields, { key: "effort", value: "high", line: 9 }];
  assert.equal(checkFields("agents", allowlist, withEffort).length, 1);
  // And through the CLI, from the plugin directory, as CI runs it.
  const r = spawnSync(process.execPath, [join(PLUGIN, "scripts", "frontmatter-check.mjs"), "agents/fleet-fix-applier.agent.md"], { cwd: PLUGIN, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // The control: the same file with a forbidden key is refused by the same command.
  const bad = join(TMP, "fm-bad", "agents");
  mkdirSync(bad, { recursive: true });
  writeFileSync(join(bad, "fleet-fix-applier.agent.md"), agentText("fleet-fix-applier").replace('model: "@slow:high"', 'model: "@slow:high"\neffort: high'));
  const refused = spawnSync(process.execPath, [join(PLUGIN, "scripts", "frontmatter-check.mjs"), "--allowlist", join(PLUGIN, "scripts", "frontmatter-allowlist.json"), "agents/fleet-fix-applier.agent.md"], { cwd: join(TMP, "fm-bad"), encoding: "utf8" });
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stdout + refused.stderr, /effort/);
});

// --- (2) the pair -----------------------------------------------------------

// The rendered brief is the golden dispatch-prompt.test.mjs pins byte-for-byte
// against render output for the same arguments, so it is read, not rendered again.
const GOLDEN = fileURLToPath(new URL("./fixtures/briefs/", import.meta.url));

const PIN = "0123456789abcdef0123456789abcdef01234567";
// The fix-applier's report became a file in the shape report-schema.mjs gives
// its family, and its final message one line pointing at it: the pre-change
// sentences that spelled the report as free-text lines are replaced, not lost.
const REPORT_FILE_RETIRED = [
  "There is no cap on these refuters: count the ones you dispatch against out-of-scope suggestions, since your report names that count.",
  "Then report to the controller the pushed SHA, your apply/defer split, how many refuters you dispatched against out-of-scope suggestions, and the deferral issue numbers — a `filed: #N <subject>` line for every issue step 5 created, and `unrecorded: #N <subject>` for one whose `ledger.mjs filed` failed twice — and exit.",
  "**Deferring everything is a normal outcome, not a stall:** nothing is then staged, `git commit` refuses an empty index, `git push origin HEAD:<branch>` prints `Everything up-to-date`, and you report `no-op, HEAD unchanged at <sha>` in place of a new SHA.",
];
// The digest projection gained `suiteVerdict` (#3048), so the sentence that
// spelled the old projection is replaced, not lost.
const DIGEST_PROJECTION_RETIRED = [
  "**The review's result is `<scratch>/pr<pr>/<run>/review.json`** — the digest first (`jq '{pr, head, resume, testEnvironment, dimensionsRun, dimensionsUnrun, cwdAudit, counts}'`), then every finding (`jq '.survived'`, `jq '.unverified'`, `jq '.refuted'`).",
];
// The finisher's duty 3 moved to its agent body, so the repair kind's pointer
// to it "as above" pointed at nothing in the brief: the sentence now points
// at the agent definition instead.
const DUTY3_POINTER_RETIRED = ["Duty 3's script decides whether the label is on, as above."];
// Duty 3's script gained a Ticketless PR's path: `patch` added, exit 5 and its
// halt cause, so the three sentences that described the old exits are replaced,
// not lost.
const DUTY3_TICKETLESS_RETIRED = [
  "It confirms exactly one of `patch`/`minor`/`major` is on the PR, records the head you audited, adds `ready-to-merge`, and reads the labels back.",
  "Exit 3 means the PR carries zero or more than one release label: you are halted before the label, and the receipt names which it found.",
  "Every non-zero exit halts you with cause `other`, with the receipt as evidence, and you do not run any of its steps by hand to get past it.",
];
// Every detached push goes through push-sync.mjs, which also moves the
// worktree holding the branch, so the conflict kind's bare refspec push is
// replaced, not lost.
const PUSH_HELPER_RETIRED = ["Run `<testCmd>` from the worktree before you push, then push with `git push origin HEAD:<branch>`."];
// The fix commit's test run goes through recipe-check.mjs, which records the
// run the controller's settle requires, so the sentence that had the
// fix-applier run `<testCmd>` by hand is replaced, not lost.
const RECIPE_CHECK_RETIRED = ["**Run `<testCmd>` from the worktree before committing**, copied verbatim."];
// The suggestion-band record is named by its title, never as a "closed" one,
// so the three fix-applier sentences that said "closed suggestion-band record"
// are replaced, not lost.
const CLOSED_RECORD_RETIRED = [
  "**Out of scope → defer and file, never apply** — but the claim bar runs first: an out-of-scope suggestion whose claim is about shape (`claimKind: shape`) gets no refuter and goes to the closed suggestion-band record, and every other one gets the same refuter an in-scope one does, dispatched the same way, before it is filed.",
  "**Out of scope, the refuter decides only where the suggestion is filed — it defers either way, never applied.** Refuted → the closed suggestion-band record, never an open issue.",
  "`disposition` has no `dismiss`: an in-scope `survived` finding verified correct, needing no change, is deferred with `reason` `false-rationale` and filed on the closed suggestion-band record.",
];
// `## Phase 3 — event loop` left run-team's SKILL.md (#3540), so the merge
// bot's copy of the shell traps names **Own the CI waits**, the section that
// now holds the watcher block and the probe rule, instead of Phase 3.
const PHASE_3_POINTERS_RETIRED = [
  "The inline `$(printf '%s\\n' \"$prs\")` form splits correctly too and is what Phase 3's block uses, but it splits on *every* whitespace character, so it is safe only for values that cannot contain one — PR numbers cannot, branch names and paths can.",
  "**A probe that could not look emits an event; it never `continue`s.** Stated in full at *A probe that cannot read is a transition event, not silence* in Phase 3, and it binds every watcher in this file rather than that one block: the third value beside pass and fail is what turns a broken loop into a loud failure instead of a quiet one.",
];
// The instrument check certifies the Install root, never a tree the baseline
// names (#3845), so the finisher's two sentences about an audited checkout
// are replaced, not lost.
const INSTALL_ROOT_RETIRED = [
  "`--repo` is required and the spelling is the point — the run's baseline lives in the audited checkout's gitignored `.fleet/`, which the scratch worktree you take at duty 2 does not carry, so a bare invocation from there exits 2 on a missing baseline instead of comparing anything.",
  "The baseline itself names the tree to audit: a cross-workspace run pinned it once at phase 0, and your `--repo` only locates that baseline, never the audited tree — so an exit 2 naming a moved or unreadable audited tree is a halt like every other, not a spelling for you to correct.",
];
// Duty 1's audit exits 0 on a worktree that holds nothing the pin lacks and
// names `stray` beside the other causes, so the three sentences that stated
// exit 0 as a clean tree at the pin, listed the causes without it and said a
// commit past the pin always halts are replaced, not lost.
const AUDIT_EXIT_RETIRED = [
  "Exit 0, with `cause` null, is the only code that means the worktree is clean at your pin.",
  "Exit 1 means `cause` is non-null: you are halted, and `cause` is the word you name — `live-editor`, `rebase`, `past-pin`, `unreadable`, `missing`, `absent` or `other`, and `other` is a cause too, not a gap.",
  "Every cause halts, always — named or not, you never verify the dirt is harmless and label over it, a rebase is not a fast-forward you get to accept, a commit past the pin is not one either, and a cause you could not name is the least settled of the lot.",
];
// The placeholder each argument fills, per role — the arguments are values no
// other argument shares, so a swapped substitution cannot pass.
const PAIRS = [
  { role: "fix-applier", kind: "review", fixture: "fix-applier-review.md", retired: [...REPORT_FILE_RETIRED, ...DIGEST_PROJECTION_RETIRED, ...RECIPE_CHECK_RETIRED, ...CLOSED_RECORD_RETIRED],
    args: { worktree: "/abs/wt-fix", branch: "fix-branch", testCmd: "TESTCMD-1", scratch: "/abs/scratch-fix", pr: "3293", run: "run-AbCd1234" },
    fills: { "abs-path": "worktree", branch: "branch", testCmd: "testCmd", scratch: "scratch", pr: "pr", run: "run" } },
  { role: "fix-applier", kind: "conflict", fixture: "fix-applier-conflict.md", retired: PUSH_HELPER_RETIRED,
    args: { worktree: "/abs/wt-conflict", branch: "conflict-branch", testCmd: "TESTCMD-2", scratch: "/abs/scratch-conflict" },
    fills: { "abs-path": "worktree", branch: "branch", testCmd: "testCmd", scratch: "scratch" } },
  { role: "fix-applier", kind: "dispositions-retry", fixture: "fix-applier-dispositions-retry.md", retired: [...REPORT_FILE_RETIRED, ...DIGEST_PROJECTION_RETIRED, ...RECIPE_CHECK_RETIRED, ...CLOSED_RECORD_RETIRED],
    args: { worktree: "/abs/wt-retry", branch: "retry-branch", testCmd: "TESTCMD-3", scratch: "/abs/scratch-retry", pr: "3294", run: "run-ZyXw9876", "mismatched-record": "/abs/scratch-retry/dispositions-fix-pr-3294.json", violations: "VIOLATION-LIST-1" },
    fills: { "abs-path": "worktree", branch: "branch", testCmd: "testCmd", scratch: "scratch", pr: "pr", run: "run", "mismatched record": "mismatched-record", violations: "violations" } },
  { role: "finisher", kind: "fresh", fixture: "finisher-fresh.md", retired: [...DUTY3_TICKETLESS_RETIRED, ...INSTALL_ROOT_RETIRED, ...AUDIT_EXIT_RETIRED],
    args: { worktree: "/abs/wt-fin", pin: PIN, pr: "3295", testCmd: "TESTCMD-4", scratch: "/abs/scratch-fin" },
    fills: { "abs-path": "worktree", "your dispatch pin": "pin", M: "pr", testCmd: "testCmd", scratch: "scratch" } },
  { role: "finisher", kind: "repair", fixture: "finisher-repair.md", retired: [...DUTY3_POINTER_RETIRED, ...DUTY3_TICKETLESS_RETIRED, ...INSTALL_ROOT_RETIRED, ...AUDIT_EXIT_RETIRED],
    args: { worktree: "/abs/wt-fin-r", pin: PIN, pr: "3296", testCmd: "TESTCMD-5", scratch: "/abs/scratch-fin-r" },
    fills: { "abs-path": "worktree", "your dispatch pin": "pin", M: "pr", testCmd: "testCmd", scratch: "scratch" } },
  { role: "merge-bot", kind: null, fixture: "merge-bot.md", retired: PHASE_3_POINTERS_RETIRED,
    args: { n: "17", scratch: "/abs/scratch-bot" },
    fills: { n: "n", scratch: "scratch" } },
];

const fold = (s) => s.replace(/\s+/g, " ").trim();
const count = (haystack, needle) => haystack.split(needle).length - 1;

// The sentences of a text, paragraph by paragraph so none spans a blank line.
function sentencesOf(text) {
  return text
    .split(/\n[ \t]*\n/)
    .map(fold)
    .filter((p) => p !== "")
    .flatMap((p) => p.split(/(?<=[.!?])\s+(?=[A-Z*`"(\[<])/))
    .filter((s) => s !== "");
}

const label = ({ role, kind }) => (kind ? `${role} ${kind}` : role);

for (const p of PAIRS) {
  test(`${label(p)}: its body and its rendered brief hold every sentence of the pre-change text, each as often as it stood`, () => {
    const fixture = readFileSync(join(FIXTURES, p.fixture), "utf8");
    const body = fold(bodyOf(agentText(`fleet-${p.role}`)));
    const brief = fold(readFileSync(join(GOLDEN, p.fixture), "utf8"));
    const fillValues = Object.fromEntries(Object.entries(p.fills).map(([inner, flag]) => [inner, p.args[flag]]));
    const fill = (s) => s.replace(/<([A-Za-z][^<>\n]*)>/g, (whole, inner) => (inner in fillValues ? fillValues[inner] : whole));

    const sentences = sentencesOf(fixture);
    assert.ok(sentences.length >= 3, "the fixture reads as a few sentences at least");
    const fixtureText = fold(fixture);

    // A retired sentence is one a later change replaced on purpose: it must
    // still be a sentence of the pre-change text, so the list cannot name
    // nothing, and gone from both halves, so it is not carried on unseen.
    const retired = new Set(p.retired ?? []);
    for (const s of retired) {
      assert.ok(sentences.includes(s), `retired sentence is not in the pre-change text: ${JSON.stringify(s.slice(0, 90))}`);
      assert.equal(count(body, s) + count(brief, fill(s)), 0, `retired sentence is still stated: ${JSON.stringify(s.slice(0, 90))}`);
    }

    const lost = [];
    const duplicated = [];
    for (const s of new Set(sentences)) {
      if (retired.has(s)) continue;
      const expected = count(fixtureText, s);
      // The body names a value by its placeholder; the brief carries it filled.
      const found = count(body, s) + count(brief, fill(s));
      if (found < expected) lost.push(s);
      if (found > expected) duplicated.push(s);
    }
    const show = (list) => list.slice(0, 3).map((s) => JSON.stringify(s.slice(0, 90))).join("\n  ");
    assert.deepEqual(lost, [], `${lost.length} pre-change sentence(s) in neither the body nor the brief:\n  ${show(lost)}`);
    assert.deepEqual(duplicated, [], `${duplicated.length} sentence(s) stated in both, or twice over:\n  ${show(duplicated)}`);
  });
}

test("the sentence counter sees a lost sentence and a duplicated one, and passes a re-wrapped one", () => {
  const text = "First rule here. Second rule here.\n\nThird rule `x`. Fourth rule.";
  assert.deepEqual(sentencesOf(text), ["First rule here.", "Second rule here.", "Third rule `x`.", "Fourth rule."]);
  // A re-wrap folds to the same sentences.
  assert.deepEqual(sentencesOf("First rule\nhere. Second rule\nhere.\n\nThird rule `x`. Fourth\nrule."), sentencesOf(text));
  // A paragraph break is never inside a sentence.
  assert.deepEqual(sentencesOf("An unfinished\n\nthought. Next one."), ["An unfinished", "thought.", "Next one."]);
});
