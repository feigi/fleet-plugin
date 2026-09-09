// The allow-list checker's own tests (#1314, #1347). Two halves:
//
//   (1) a pure-core unit/mutation suite over `parseAllowlist`, `kindForPath`,
//       `parseFrontmatter`, `checkFields`, `formatViolation` — fixture-driven,
//       independent of what happens to be checked into the tree right now.
//   (2) a CLI/end-to-end suite driving the script as a child process, over
//       fixture files on disk, proving the exit-code contract (0/1/2) and the
//       exact `file:line: key — reason` line shape.
//
// The MUTATION PROOF #1314's own acceptance criterion asks for — "a
// disallowed key -> red, revert -> green; repeat for a missing required key"
// — is done directly against the CLI (not simulated): a fixture agent file is
// mutated in place, the checker is run, the run is asserted red, the mutation
// is reverted, the checker is run again, the run is asserted green. Three
// mutations covered: a forbidden key, a missing required key, an unknown key
// — plus the real-tree run at the bottom, which is the checker's own first
// real green (#1345 having landed `thinking-level` beside `effort` on both
// fleet agents; #1298/#1314/ADR 0005 name this as the gate's first real red
// until then, and green after).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  parseAllowlist, kindForPath, parseFrontmatter, checkFields, formatViolation,
} from "./frontmatter-check.mjs";

const SCRIPT = fileURLToPath(new URL("./frontmatter-check.mjs", import.meta.url));
const REAL_ALLOWLIST_PATH = fileURLToPath(new URL("./frontmatter-allowlist.json", import.meta.url));
const REPO = fileURLToPath(new URL("..", import.meta.url));

function dir() {
  return mkdtempSync(join(tmpdir(), "frontmatter-check-"));
}

function runCli(argv, cwd) {
  return spawnSync(process.execPath, [SCRIPT, ...argv], { cwd, encoding: "utf8" });
}

// A minimal but real three-kind allow-list, standing in for the real one so
// these fixtures are not coupled to #1314's exact recorded content.
const FIXTURE_ALLOWLIST = {
  agents: {
    required: ["name", "description", "model"],
    allowed: ["tools"],
    forbidden: { hooks: "Claude: documented as ignored for plugin subagents" },
    values: { model: ["opus", "sonnet", "haiku"] },
  },
  skills: {
    required: ["name", "description"],
    allowed: ["argument-hint"],
    forbidden: { model: "Claude-only per-skill tier override — silent on omp" },
  },
  commands: {
    required: ["description"],
    allowed: ["argument-hint"],
    forbidden: { model: "Claude-only per-skill tier override — silent on omp" },
  },
};

function writeFixtureAllowlist(d) {
  const p = join(d, "allowlist.json");
  writeFileSync(p, JSON.stringify(FIXTURE_ALLOWLIST));
  return p;
}

// ---------------------------------------------------------------------------
// parseAllowlist
// ---------------------------------------------------------------------------

test("parseAllowlist: the real allow-list on disk is well-shaped", () => {
  const raw = readFileSync(REAL_ALLOWLIST_PATH, "utf8");
  const { allowlist, error } = parseAllowlist(raw);
  assert.equal(error, undefined);
  for (const kind of ["agents", "skills", "commands"]) {
    assert.ok(Array.isArray(allowlist[kind].required), `${kind}.required is an array`);
    assert.ok(Array.isArray(allowlist[kind].allowed), `${kind}.allowed is an array`);
    assert.equal(typeof allowlist[kind].forbidden, "object", `${kind}.forbidden is an object`);
  }
});

test("parseAllowlist: malformed JSON is an error, not a thrown exception", () => {
  const { allowlist, error } = parseAllowlist("{not json");
  assert.equal(allowlist, undefined);
  assert.match(error, /not valid JSON/);
});

test("parseAllowlist: a JSON file missing a kind section is an error naming it", () => {
  const { error } = parseAllowlist(JSON.stringify({ agents: FIXTURE_ALLOWLIST.agents, skills: FIXTURE_ALLOWLIST.skills }));
  assert.match(error, /"commands"/);
});

test("parseAllowlist: a kind section with forbidden as an array (wrong shape) is an error", () => {
  const bad = JSON.parse(JSON.stringify(FIXTURE_ALLOWLIST));
  bad.agents.forbidden = ["hooks"];
  const { error } = parseAllowlist(JSON.stringify(bad));
  assert.match(error, /agents\.forbidden/);
});

// ---------------------------------------------------------------------------
// kindForPath
// ---------------------------------------------------------------------------

test("kindForPath: classifies agents, skills, commands under a plugin/ prefix", () => {
  assert.equal(kindForPath("plugin/agents/fleet-implementer.agent.md"), "agents");
  assert.equal(kindForPath("plugin/skills/run-team/SKILL.md"), "skills");
  assert.equal(kindForPath("plugin/commands/review-and-fix.md"), "commands");
});

test("kindForPath: classifies the same shapes with no plugin/ prefix (bare repo-relative)", () => {
  assert.equal(kindForPath("agents/x.md"), "agents");
  assert.equal(kindForPath("skills/foo/SKILL.md"), "skills");
  assert.equal(kindForPath("commands/y.md"), "commands");
});

test("kindForPath: a file one level too deep or too shallow does not classify", () => {
  assert.equal(kindForPath("plugin/agents/nested/x.md"), null);
  assert.equal(kindForPath("plugin/skills/SKILL.md"), null);
  assert.equal(kindForPath("plugin/skills/foo/bar/SKILL.md"), null);
});

test("kindForPath: an unrelated path classifies as null", () => {
  assert.equal(kindForPath("plugin/scripts/frontmatter-check.mjs"), null);
});

// ---------------------------------------------------------------------------
// parseFrontmatter
// ---------------------------------------------------------------------------

test("parseFrontmatter: reads flat key: value fields with 1-based source lines", () => {
  const { fields, error } = parseFrontmatter("---\nname: fleet-x\ndescription: does a thing\n---\nbody\n");
  assert.equal(error, undefined);
  assert.deepEqual(fields, [
    { key: "name", value: "fleet-x", line: 2 },
    { key: "description", value: "does a thing", line: 3 },
  ]);
});

test("parseFrontmatter: a blank line inside the block is skipped, not a parse error", () => {
  const { fields, error } = parseFrontmatter("---\nname: x\n\ndescription: y\n---\n");
  assert.equal(error, undefined);
  assert.equal(fields.length, 2);
  assert.equal(fields[1].line, 4);
});

test("parseFrontmatter: no opening fence is a parse error", () => {
  const { error } = parseFrontmatter("name: x\ndescription: y\n");
  assert.match(error, /opening --- fence/);
});

test("parseFrontmatter: no closing fence is a parse error", () => {
  const { error } = parseFrontmatter("---\nname: x\ndescription: y\n");
  assert.match(error, /closing --- fence/);
});

test("parseFrontmatter: a line that is neither blank nor key: value is a parse error naming the line", () => {
  const { error } = parseFrontmatter("---\nname: x\nnot a field at all\n---\n");
  assert.match(error, /unparseable frontmatter at line 3/);
});

test("parseFrontmatter: an empty value (key: with nothing after it) parses as an empty string, not an error", () => {
  const { fields, error } = parseFrontmatter("---\nargument-hint:\n---\n");
  assert.equal(error, undefined);
  assert.equal(fields[0].value, "");
});

// ---------------------------------------------------------------------------
// checkFields — the both-directions contract plus value rules
// ---------------------------------------------------------------------------

test("checkFields: a clean agent file (every required key, no forbidden/unknown) has zero violations", () => {
  const fields = [
    { key: "name", value: "fleet-x", line: 2 },
    { key: "description", value: "d", line: 3 },
    { key: "model", value: "opus", line: 4 },
  ];
  assert.deepEqual(checkFields("agents", FIXTURE_ALLOWLIST, fields), []);
});

test("checkFields: a forbidden key is a violation carrying the allow-list's own reason", () => {
  const fields = [
    { key: "name", value: "fleet-x", line: 2 },
    { key: "description", value: "d", line: 3 },
    { key: "model", value: "opus", line: 4 },
    { key: "hooks", value: "{}", line: 5 },
  ];
  const violations = checkFields("agents", FIXTURE_ALLOWLIST, fields);
  assert.deepEqual(violations, [{ line: 5, key: "hooks", reason: FIXTURE_ALLOWLIST.agents.forbidden.hooks }]);
});

test("checkFields: an unrecognised key (neither required, allowed, nor forbidden) is its own violation class", () => {
  const fields = [
    { key: "name", value: "fleet-x", line: 2 },
    { key: "description", value: "d", line: 3 },
    { key: "model", value: "opus", line: 4 },
    { key: "totallyUnknownKey", value: "1", line: 5 },
  ];
  const violations = checkFields("agents", FIXTURE_ALLOWLIST, fields);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].key, "totallyUnknownKey");
  assert.match(violations[0].reason, /unrecognised key/);
});

test("checkFields: a missing required key is a violation reported at line 1, not silently dropped", () => {
  const fields = [
    { key: "name", value: "fleet-x", line: 2 },
    { key: "model", value: "opus", line: 3 },
  ];
  const violations = checkFields("agents", FIXTURE_ALLOWLIST, fields);
  assert.deepEqual(violations, [{ line: 1, key: "description", reason: "required key missing" }]);
});

test("checkFields: an allowed key with no value rule at all never becomes a violation on its value", () => {
  const fields = [
    { key: "name", value: "fleet-x", line: 2 },
    { key: "description", value: "d", line: 3 },
    { key: "model", value: "opus", line: 4 },
    { key: "tools", value: "Bash,Read,Write,AnythingGoes", line: 5 },
  ];
  assert.deepEqual(checkFields("agents", FIXTURE_ALLOWLIST, fields), []);
});

test("checkFields: a value outside its enum is a violation naming the legal set", () => {
  const fields = [
    { key: "name", value: "fleet-x", line: 2 },
    { key: "description", value: "d", line: 3 },
    { key: "model", value: "claude-opus-5", line: 4 },
  ];
  const violations = checkFields("agents", FIXTURE_ALLOWLIST, fields);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].key, "model");
  assert.match(violations[0].reason, /not one of \{opus, sonnet, haiku\}/);
});

test("checkFields: forbidden is checked before the required/allowed membership test — a forbidden required-looking key still reports its forbidden reason", () => {
  const allowlist = {
    agents: {
      required: ["name"],
      allowed: [],
      forbidden: { name: "shadowed on purpose for this fixture" },
    },
  };
  const violations = checkFields("agents", allowlist, [{ key: "name", value: "x", line: 2 }]);
  assert.deepEqual(violations, [{ line: 2, key: "name", reason: "shadowed on purpose for this fixture" }]);
});

// ---------------------------------------------------------------------------
// formatViolation
// ---------------------------------------------------------------------------

test("formatViolation: the ticket's exact file:line: key — reason shape", () => {
  assert.equal(
    formatViolation("plugin/agents/x.agent.md", { line: 5, key: "hooks", reason: "ignored for plugin subagents" }),
    "plugin/agents/x.agent.md:5: hooks — ignored for plugin subagents",
  );
});

// ---------------------------------------------------------------------------
// CLI — exit codes, output shape, over real files on disk
// ---------------------------------------------------------------------------
// A fixture agent file lives under a real agents/ subdirectory, so
// kindForPath classifies it the same way it would a real repo-relative path.

// The fixture above needs a real agents/ subdirectory for kindForPath to
// classify it — build that directly rather than via the throwaway probe.
function agentFixtureDir() {
  const d = dir();
  const allowlistPath = writeFixtureAllowlist(d);
  const agentsDir = join(d, "agents");
  mkdirSync(agentsDir, { recursive: true });
  return { d, allowlistPath, agentsDir, file: join(agentsDir, "x.agent.md") };
}

test("CLI: a clean agent file under agents/ exits 0 with no stdout", () => {
  const { allowlistPath, agentsDir, file, d } = agentFixtureDir();
  writeFileSync(file, "---\nname: fleet-x\ndescription: d\nmodel: opus\n---\nbody\n");
  const r = runCli(["--allowlist", allowlistPath, "agents/x.agent.md"], d);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  void agentsDir;
});

test("CLI: a forbidden key exits 1 and prints file:line: key — reason", () => {
  const { allowlistPath, file, d } = agentFixtureDir();
  writeFileSync(file, "---\nname: fleet-x\ndescription: d\nmodel: opus\nhooks: {}\n---\nbody\n");
  const r = runCli(["--allowlist", allowlistPath, "agents/x.agent.md"], d);
  assert.equal(r.status, 1);
  assert.equal(r.stdout.trim(), `agents/x.agent.md:5: hooks — ${FIXTURE_ALLOWLIST.agents.forbidden.hooks}`);
});

test("CLI: a missing allow-list exits 2, never 0 or 1 — a missing list must fail loudly, not pass with an empty ruleset", () => {
  const { file, d } = agentFixtureDir();
  writeFileSync(file, "---\nname: fleet-x\ndescription: d\nmodel: opus\n---\n");
  const r = runCli(["--allowlist", join(d, "does-not-exist.json"), "agents/x.agent.md"], d);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /allow-list unreadable/);
});

test("CLI: unparseable frontmatter exits 2, distinct from a violation's exit 1", () => {
  const { allowlistPath, file, d } = agentFixtureDir();
  writeFileSync(file, "no fence at all\n");
  const r = runCli(["--allowlist", allowlistPath, "agents/x.agent.md"], d);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /opening --- fence/);
});

test("CLI: a file that classifies as none of agents/skills/commands exits 2 naming why", () => {
  const { allowlistPath, d } = agentFixtureDir();
  const stray = join(d, "stray.md");
  writeFileSync(stray, "---\nname: x\n---\n");
  const r = runCli(["--allowlist", allowlistPath, "stray.md"], d);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /cannot classify/);
});

test("CLI: multiple files in one invocation report every violation across all of them before exiting", () => {
  const { allowlistPath, agentsDir, d } = agentFixtureDir();
  writeFileSync(join(agentsDir, "a.agent.md"), "---\nname: fleet-a\ndescription: d\nmodel: opus\nhooks: {}\n---\n");
  writeFileSync(join(agentsDir, "b.agent.md"), "---\nname: fleet-b\ndescription: d\nmodel: sonnet\n---\n");
  const r = runCli(["--allowlist", allowlistPath, "agents/a.agent.md", "agents/b.agent.md"], d);
  assert.equal(r.status, 1);
  assert.equal(r.stdout.trim(), "agents/a.agent.md:5: hooks — " + FIXTURE_ALLOWLIST.agents.forbidden.hooks);
});

// ---------------------------------------------------------------------------
// #1314's mutation proof, done literally: mutate a fixture in place, run the
// CLI, assert red; revert; run again; assert green. Three shapes: forbidden
// key, missing required key, unknown key.
// ---------------------------------------------------------------------------

test("MUTATION PROOF: a forbidden key introduced -> red; reverted -> green", () => {
  const { allowlistPath, file, d } = agentFixtureDir();
  const clean = "---\nname: fleet-x\ndescription: d\nmodel: opus\n---\nbody\n";
  writeFileSync(file, clean);
  const green1 = runCli(["--allowlist", allowlistPath, "agents/x.agent.md"], d);
  assert.equal(green1.status, 0, "clean fixture starts green");

  const mutated = "---\nname: fleet-x\ndescription: d\nmodel: opus\nhooks: {}\n---\nbody\n";
  writeFileSync(file, mutated);
  const red = runCli(["--allowlist", allowlistPath, "agents/x.agent.md"], d);
  assert.equal(red.status, 1, "forbidden key introduced -> red");
  assert.match(red.stdout, /hooks — /);

  writeFileSync(file, clean);
  const green2 = runCli(["--allowlist", allowlistPath, "agents/x.agent.md"], d);
  assert.equal(green2.status, 0, "reverted -> green again");
});

test("MUTATION PROOF: a required key removed -> red; reverted -> green", () => {
  const { allowlistPath, file, d } = agentFixtureDir();
  const clean = "---\nname: fleet-x\ndescription: d\nmodel: opus\n---\nbody\n";
  writeFileSync(file, clean);
  assert.equal(runCli(["--allowlist", allowlistPath, "agents/x.agent.md"], d).status, 0);

  const mutated = "---\nname: fleet-x\nmodel: opus\n---\nbody\n"; // description removed
  writeFileSync(file, mutated);
  const red = runCli(["--allowlist", allowlistPath, "agents/x.agent.md"], d);
  assert.equal(red.status, 1, "missing required key -> red");
  assert.match(red.stdout, /description — required key missing/);

  writeFileSync(file, clean);
  const green = runCli(["--allowlist", allowlistPath, "agents/x.agent.md"], d);
  assert.equal(green.status, 0, "reverted -> green again");
});

test("MUTATION PROOF: an unknown key introduced -> red; reverted -> green", () => {
  const { allowlistPath, file, d } = agentFixtureDir();
  const clean = "---\nname: fleet-x\ndescription: d\nmodel: opus\n---\nbody\n";
  writeFileSync(file, clean);
  assert.equal(runCli(["--allowlist", allowlistPath, "agents/x.agent.md"], d).status, 0);

  const mutated = "---\nname: fleet-x\ndescription: d\nmodel: opus\nomp-only-experimental-flag: yes\n---\nbody\n";
  writeFileSync(file, mutated);
  const red = runCli(["--allowlist", allowlistPath, "agents/x.agent.md"], d);
  assert.equal(red.status, 1, "unknown key -> red");
  assert.match(red.stdout, /omp-only-experimental-flag — unrecognised key/);

  writeFileSync(file, clean);
  const green = runCli(["--allowlist", allowlistPath, "agents/x.agent.md"], d);
  assert.equal(green.status, 0, "reverted -> green again");
});

// ---------------------------------------------------------------------------
// The real tree, with the real allow-list: today's own first real green
// (#1298/ADR 0005's own prediction — red on missing thinking-level until
// #1343, green after; #1343 is on main, so this is the gate's first real
// green, run here rather than merely asserted).
// ---------------------------------------------------------------------------

test("REAL TREE: every tracked agents/skills/commands frontmatter file in this checkout passes the real allow-list", () => {
  const agentFiles = ["fleet-implementer.agent.md", "fleet-implementer-alt.agent.md"]
    .map((f) => `agents/${f}`);
  const skillFiles = ["next-ticket", "run-team", "sizing-a-ticket"].map((s) => `skills/${s}/SKILL.md`);
  const commandFiles = ["review-and-fix.md", "run-merge-bot.md"].map((f) => `commands/${f}`);
  const all = [...agentFiles, ...skillFiles, ...commandFiles];
  for (const f of all) {
    assert.ok(existsSync(join(REPO, f)), `${f} exists in the real tree`);
  }
  const r = runCli(["--allowlist", REAL_ALLOWLIST_PATH, ...all], REPO);
  assert.equal(r.status, 0, `real tree is clean against the real allow-list:\n${r.stdout}${r.stderr}`);
  assert.equal(r.stdout, "");
});
