// A command in shipped prose that takes a Label map string carries it inside
// double quotes, `"<role string>"`. The label-map string rules refuse `"`, `\`,
// `$`, the backtick and `,` — everything double quotes expand — but `'` stays
// valid, so a string holding one must still parse: `won't fix` is how trackers
// spell the `wontfix` role. This test splices that string into every command
// in a shipped `.md` that holds a role placeholder and asks `bash -n` to parse
// it. A placeholder inside single quotes, or bare, does not survive.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { LABEL_ROLES } from "../plugin/scripts/label-map.mjs";

const PLUGIN = join(import.meta.dirname, "..", "plugin");
const STRING = "won't fix";
const ROLE_PLACEHOLDER = new RegExp(`<(?:${LABEL_ROLES.join("|")}) string>`, "g");

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

// The command bash is asked to parse: the role placeholder becomes the
// apostrophe-bearing string, every other `<…>` placeholder a plain word.
const spliced = (text) => text.replace(ROLE_PLACEHOLDER, () => STRING).replace(/<[^<>\n]+>/g, () => "word");

const parses = (text) => spawnSync("bash", ["-n"], { input: text, encoding: "utf8" }).status === 0;

function sites() {
  const out = [];
  for (const file of markdownUnder(PLUGIN)) {
    for (const { text, kind } of codeOf(readFileSync(file, "utf8"))) {
      if (!new RegExp(ROLE_PLACEHOLDER.source).test(text)) continue;
      // A span that is only the placeholder is a mention, not a command.
      if (kind === "span" && new RegExp(`^${ROLE_PLACEHOLDER.source}$`).test(text.trim())) continue;
      out.push({ file: relative(PLUGIN, file), text });
    }
  }
  return out;
}

test("every command in shipped prose that takes a role string parses with an apostrophe-bearing string spliced in", () => {
  const all = sites();
  assert.ok(all.length >= 11, `found only ${all.length} commands holding a role placeholder`);
  const broken = all.filter(({ text }) => !parses(spliced(text)));
  assert.deepEqual(broken.map(({ file, text }) => `${file}: ${text.split("\n")[0]}`), []);
});

test("negative control: a role placeholder inside single quotes, or bare, does not parse once the string holds an apostrophe", () => {
  assert.equal(parses(spliced("gh api x -q '.name == \"<ready-to-merge string>\"'")), false);
  assert.equal(parses(spliced("gh pr edit <pr> --remove-label '<ready-to-merge string>'")), false);
  assert.equal(parses(spliced('gh pr edit <pr> --remove-label "<ready-to-merge string>"')), true);
  assert.equal(parses(spliced('label="<ready-to-merge string>" gh api x -q \'.[] | env.label\'')), true);
});

test("a span that is only a placeholder is a mention and is skipped; a span holding a command is found", () => {
  const md = "The `<wontfix string>` is printed by `show`. Run `gh issue create --label \"<wontfix string>\"` then:\n\n```bash\nx=\"<ready-to-merge string>\"\n```\n";
  const code = codeOf(md).map((c) => c.text.trim());
  assert.deepEqual(code.sort(), ['<wontfix string>', 'gh issue create --label "<wontfix string>"', 'show', 'x="<ready-to-merge string>"'].sort());
});
