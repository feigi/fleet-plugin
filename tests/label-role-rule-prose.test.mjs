// The role rule, pinned over every shipped runbook, command, agent and brief that names a label.
//
// The eight Label roles are names; the string a consumer repo's tracker uses for each comes from the Label map.
// Every shipped markdown file whose body names a role as a whole word states that once, above its first role
// name: a rule stated after the first `gh` command it governs has already lost. This is the repository-wide
// scan; the per-slice pins in label-map-solo-prose.test.mjs and label-map-member-prose.test.mjs pin the same
// sentence on their own slices and what each slice does with it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Pin } from "./support/prose-pin.mjs";

const REPO = join(import.meta.dirname, "..");
const PLUGIN = join(REPO, "plugin");
const ROOTS = ["skills", "commands", "agents"];

const ROLE_RULE = "Label names in this file are roles; the Label map gives the string to type; a member never derives the map.";
const ROLE = /\b(needs-triage|needs-info|ready-for-agent|ready-for-human|wontfix|in-progress|onhold|ready-to-merge)\b/;

// A file whose whole body is filed on the tracker as written cannot carry the rule: the sentence would be
// posted with it. `briefs/relabel.md` is that file - `dispatch-prompt.mjs render relabel` prints its sections,
// `pull.mjs` and `fleet-event.mjs` file them, and tests/pull.test.mjs pins the one against the other byte for
// byte - so the rule for the comments it renders is stated in references/pull.md, beside the command that
// files them (pinned below).
const FILED_AS_WRITTEN = new Map([
  ["plugin/skills/run-team/briefs/relabel.md", "its text is the comment filed on the ticket"],
]);

const markdown = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return markdown(path);
    return e.name.endsWith(".md") ? [path] : [];
  });

// A markdown file's body: what follows the frontmatter fence.
const bodyOf = (text) => (text.startsWith("---\n") ? text.slice(text.indexOf("\n---\n", 4) + "\n---\n".length) : text);

// A fresh regex per use: a global one shared across assertions carries `lastIndex` from one into the next.
const rulePattern = () => new RegExp(Pin.phrase(ROLE_RULE).source, "g");

// What is wrong with a body's role rule, or null: a body naming no role needs none; one naming a role states
// the rule exactly once, above the first role name.
function ruleProblem(body) {
  const role = body.search(ROLE);
  if (role === -1) return null;
  const rules = [...body.matchAll(rulePattern())];
  if (rules.length === 0) return "names a role and does not carry the role rule";
  if (rules.length > 1) return "states the role rule more than once";
  if (rules[0].index > role) return "names a role before it states the role rule";
  return null;
}

const SHIPPED = ROOTS.flatMap((root) => markdown(join(PLUGIN, root)))
  .map((path) => ({ path, name: relative(REPO, path), body: bodyOf(readFileSync(path, "utf8")) }))
  .sort((a, b) => a.name.localeCompare(b.name));

test("every shipped markdown file that names a role carries the role rule above its first role name", () => {
  const naming = SHIPPED.filter((f) => ROLE.test(f.body));
  // Positive control: the scan reaches the files the rule is for, so a zero below is a measurement.
  for (const name of [
    "plugin/skills/run-team/SKILL.md",
    "plugin/skills/run-team/references/pull.md",
    "plugin/skills/run-team/briefs/finisher.md",
    "plugin/skills/next-ticket/SKILL.md",
    "plugin/commands/review-and-fix.md",
    "plugin/agents/fleet-finisher.agent.md",
  ]) {
    assert.ok(naming.some((f) => f.name === name), `the scan no longer finds a role name in ${name}`);
  }
  const failures = naming
    .filter((f) => !FILED_AS_WRITTEN.has(f.name))
    .flatMap((f) => {
      const problem = ruleProblem(f.body);
      return problem === null ? [] : [`${f.name} ${problem}`];
    });
  assert.deepEqual(failures, []);
});

test("a file filed as written is still a file that names a role, so its exemption is not stale", () => {
  for (const name of FILED_AS_WRITTEN.keys()) {
    const file = SHIPPED.find((f) => f.name === name);
    assert.ok(file, `${name} is gone: drop it from FILED_AS_WRITTEN`);
    assert.match(file.body, ROLE, `${name} names no role: drop it from FILED_AS_WRITTEN`);
    assert.doesNotMatch(file.body, rulePattern(), `${name} carries the role rule, which the tracker would be filed: drop the rule or the exemption`);
  }
});

test("the scan proves its own sensitivity on a fixture, and accepts what it must accept", () => {
  const carried = `# Runbook\n\n${ROLE_RULE}\n\nPull a ready-for-agent ticket.\n`;
  assert.equal(ruleProblem(carried), null, "a file with the rule above its first role name is refused");
  // Reflowed: the rule wrapped over lines is the same sentence.
  assert.equal(ruleProblem(carried.replace("; the Label map", ";\nthe Label map")), null, "a reflowed rule is refused");
  // The sentence removed.
  assert.match(ruleProblem(carried.replace(ROLE_RULE, "")), /does not carry the role rule/);
  // Every role, one at a time, is a role name.
  for (const role of ["needs-triage", "needs-info", "ready-for-agent", "ready-for-human", "wontfix", "in-progress", "onhold", "ready-to-merge"]) {
    assert.match(ruleProblem(`# T\n\nType ${role} here.\n`), /does not carry the role rule/, `${role} is not seen as a role name`);
  }
  // The rule after the first role name.
  assert.match(ruleProblem(`# T\n\nPull a ready-for-agent ticket.\n\n${ROLE_RULE}\n`), /before it states the role rule/);
  // The rule twice.
  assert.match(ruleProblem(`${ROLE_RULE}\n${ROLE_RULE}\nready-for-agent\n`), /more than once/);
  // Accepted: no role named, with or without the rule; a role-like word that is no whole word.
  assert.equal(ruleProblem("# T\n\nNothing about labels here.\n"), null, "a body naming no role is refused");
  assert.equal(ruleProblem("# T\n\nin-progressive onholdings\n"), null, "a longer word is taken for a role name");
  // The frontmatter is no body: a role named only there needs no rule in the body.
  assert.equal(ruleProblem(bodyOf("---\ndescription: pulls ready-for-agent tickets\n---\n# T\n\nNo label here.\n")), null);
  assert.match(ruleProblem(bodyOf(`---\ndescription: x\n---\n# T\n\nready-for-agent\n`)), /does not carry/);
});

const PULL = readFileSync(join(PLUGIN, "skills", "run-team", "references", "pull.md"), "utf8");

test("pull.md has the controller type what `show` prints, in the relabel command and in the comment it files", () => {
  const section = PULL.slice(PULL.indexOf("**Relabel by cause.**"), PULL.indexOf("Neither label invokes anything"));
  assert.ok(section.length > 0, "pull.md no longer has the relabel-by-cause paragraph");
  assert.match(
    section,
    Pin.phrase('`gh issue edit <N> --remove-label "<ready-for-agent string>" --add-label "<label string>"`'),
    "the relabel command no longer types the mapped strings",
  );
  assert.match(
    section,
    Pin.phrase("Each `<… string>` is what `~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run label-map.mjs show <role>` prints for that role"),
    "pull.md no longer says where the relabel command's strings come from",
  );
  assert.match(
    section,
    Pin.phrase("where the rendered comment names `ready-for-agent`, file the string `~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run label-map.mjs show ready-for-agent` prints in its place"),
    "pull.md no longer has the controller file the mapped string in the comment text",
  );
  assert.doesNotMatch(section, /--remove-label ready-for-agent/, "the relabel command types the role name");
});

test("pull.md keeps `--label ready-for-agent` only as an illustration of a needle, and says it is not a string to type", () => {
  assert.match(
    PULL,
    Pin.phrase("`--label ready-for-agent` is an illustration of one, a role name and not a string to type"),
    "pull.md no longer says the needle example is no string to type",
  );
  assert.doesNotMatch(PULL, /is one this backlog carries/, "pull.md still says the backlog carries that needle");
});
