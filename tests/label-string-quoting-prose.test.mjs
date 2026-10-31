// A command in shipped prose that takes a Label map string carries it inside
// double quotes, `"<role string>"`. The label-map string rules refuse `"`, `\`,
// `$`, the backtick and `,` — everything double quotes expand — but `'` stays
// valid, so a string holding one must still parse: `won't fix` is how trackers
// spell the `wontfix` role. This test takes every command in a shipped `.md`
// that holds a role placeholder, splices that string into one placeholder at a
// time, and asks `bash -n` to parse it. A placeholder inside single quotes, or
// bare, does not survive.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { LABEL_ROLES, labelStringFaults } from "../plugin/scripts/label-map.mjs";

const PLUGIN = join(import.meta.dirname, "..", "plugin");
const STRING = "won't fix";
// `won't fix` alone can be masked: inside single quotes, or bare, its
// apostrophe pairs with any later quote in the block, which can still parse.
// This string's apostrophes leave an unquoted `&& &&` in either case, a syntax
// error no later quote reaches back to undo; inside double quotes it is literal.
const UNMASKABLE = "it's && && won't && && fix";
const ROLE_PLACEHOLDER = new RegExp(`<(?:${LABEL_ROLES.join("|")}|label) string>`, "g");
const HAS_PLACEHOLDER = new RegExp(ROLE_PLACEHOLDER.source);
const ONLY_PLACEHOLDER = new RegExp(`^${ROLE_PLACEHOLDER.source}$`);

const markdownUnder = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return markdownUnder(path);
    return entry.name.endsWith(".md") ? [path] : [];
  });

// Every fenced block, then every inline code span outside one, as { text, kind }.
function codeOf(markdown) {
  const found = [];
  const prose = markdown.replace(/^(`{3,})[^\n]*\n([\s\S]*?)^\1[ \t]*$/gm, (_, _fence, body) => {
    found.push({ text: body, kind: "block" });
    return "";
  });
  for (const m of prose.matchAll(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g)) found.push({ text: m[2], kind: "span" });
  return found;
}

// The command bash is asked to parse: role placeholder number `at` becomes
// `string`, every other `<…>` placeholder a plain word.
const spliced = (text, at, string) => {
  let index = 0;
  return text.replace(ROLE_PLACEHOLDER, () => (index++ === at ? string : "word")).replace(/<[^<>\n]+>/g, () => "word");
};

const parses = (text) => spawnSync("bash", ["-n"], { input: text, encoding: "utf8" }).status === 0;

const lineAt = (text, offset) => {
  const end = text.indexOf("\n", offset);
  return text.slice(text.lastIndexOf("\n", offset) + 1, end === -1 ? text.length : end).trim();
};

// The line holding each role placeholder in `text` that does not parse with
// either string spliced into it alone.
const brokenPlaceholders = (text) =>
  [...text.matchAll(ROLE_PLACEHOLDER)]
    .map((m, at) => ({ at, line: lineAt(text, m.index) }))
    .filter(({ at }) => [STRING, UNMASKABLE].some((string) => !parses(spliced(text, at, string))))
    .map(({ line }) => line);

const holds = (text) => brokenPlaceholders(text).length === 0;

// What the guard reports: `<file>: <line>` for every broken placeholder.
const report = (found) => found.flatMap(({ file, text }) => brokenPlaceholders(text).map((line) => `${file}: ${line}`));

function sites() {
  const out = [];
  for (const file of markdownUnder(PLUGIN)) {
    for (const { text, kind } of codeOf(readFileSync(file, "utf8"))) {
      if (!HAS_PLACEHOLDER.test(text)) continue;
      // A span that is only the placeholder is a mention, not a command.
      if (kind === "span" && ONLY_PLACEHOLDER.test(text.trim())) continue;
      out.push({ file: relative(PLUGIN, file), text });
    }
  }
  return out;
}

test("every command in shipped prose that takes a role string parses with an apostrophe-bearing string spliced in", () => {
  const all = sites();
  assert.ok(all.length >= 11, `found only ${all.length} commands holding a role placeholder`);
  assert.deepEqual(report(all), []);
});

test("both spliced strings are valid label strings", () => {
  for (const string of [STRING, UNMASKABLE]) {
    const roles = Object.fromEntries(LABEL_ROLES.map((role) => [role, role === "wontfix" ? string : role]));
    assert.deepEqual(labelStringFaults(roles), [], string);
  }
});

test("negative control: a role placeholder inside single quotes, or bare, does not parse once the string holds an apostrophe", () => {
  assert.equal(holds("gh api x -q '.name == \"<ready-to-merge string>\"'"), false);
  assert.equal(holds("gh pr edit <pr> --remove-label '<ready-to-merge string>'"), false);
  assert.equal(holds("gh pr edit <pr> --remove-label <ready-to-merge string>"), false);
  assert.equal(holds('gh pr edit <pr> --remove-label "<ready-to-merge string>"'), true);
  assert.equal(holds('label="<ready-to-merge string>" gh api x -q \'.[] | env.label\''), true);
  // Only `won't fix` catches this one: `bash -n` does not parse arithmetic, so
  // the unquoted `&& &&` is no error there and UNMASKABLE's quotes pair up.
  assert.equal(holds("(( '<ready-to-merge string>' ))\necho 'z'"), false);
  assert.equal(holds('(( "<ready-to-merge string>" ))\necho \'z\''), true);
});

test("negative control: a single-quoted placeholder fails even when a later quote in the same text could pair with its apostrophe", () => {
  assert.deepEqual(brokenPlaceholders("label='<ready-to-merge string>'  # the label's string\ngh api x -q '.[] | env.label'"), [
    "label='<ready-to-merge string>'  # the label's string",
  ]);
  assert.deepEqual(brokenPlaceholders("gh pr edit <pr> --remove-label '<ready-to-merge string>' --add-label '<wontfix string>'"), [
    "gh pr edit <pr> --remove-label '<ready-to-merge string>' --add-label '<wontfix string>'",
    "gh pr edit <pr> --remove-label '<ready-to-merge string>' --add-label '<wontfix string>'",
  ]);
  assert.deepEqual(brokenPlaceholders("gh pr edit <pr> --remove-label \"<ready-to-merge string>\" --add-label '<wontfix string>'  # don't"), [
    "gh pr edit <pr> --remove-label \"<ready-to-merge string>\" --add-label '<wontfix string>'  # don't",
  ]);
});

test("a block whose double-quoted placeholders sit among other quotes, comments and a heredoc passes", () => {
  const block = [
    "label=\"<ready-to-merge string>\"   # it's the string `show` printed",
    "n=$(gh pr list --label \"<wontfix string>\" --json number --jq '.[].number' | wc -l)",
    "cat <<EOF",
    "won't <label string>",
    "EOF",
  ].join("\n");
  assert.deepEqual(brokenPlaceholders(block), []);
});

test("the merge-bot runbook's monitor block, its label assignment single-quoted, fails and is named", () => {
  const file = join("commands", "run-merge-bot.md");
  const monitor = sites().filter((site) => site.file === file && site.text.includes("ready-to-merge monitor"));
  assert.equal(monitor.length, 1);
  const assignment = 'label="<ready-to-merge string>"';
  assert.ok(monitor[0].text.includes(assignment));
  const text = monitor[0].text.replace(assignment, "label='<ready-to-merge string>'");
  const named = text.split("\n").find((line) => line.startsWith("label='<ready-to-merge string>'")).trim();
  assert.deepEqual(report([{ file, text }]), [`${file}: ${named}`]);
  // The unmodified block passes.
  assert.deepEqual(report(monitor), []);
});

test("a span that is only a placeholder is a mention and is skipped; a span holding a command is found", () => {
  const md = "The `<wontfix string>` is printed by `show`. Run `gh issue create --label \"<wontfix string>\"` then:\n\n```bash\nx=\"<ready-to-merge string>\"\n```\n";
  const code = codeOf(md).map((c) => c.text.trim());
  assert.deepEqual(code.sort(), ['<wontfix string>', 'gh issue create --label "<wontfix string>"', 'show', 'x="<ready-to-merge string>"'].sort());
});
