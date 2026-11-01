// Every markdown file this repository ships under plugin/ is a prompt the
// harness loads, so the Inert diff verdict must never call one prose: a diff
// editing it would skip the acceptance mutation. The prompt-surface rule names
// skills, agents and commands directories, not plugin/ itself, so a prompt
// file added under plugin/ outside those three turns this test red rather
// than passing as prose. Zero deps:
// `node --test tests/finisher-scope-shipped-prompts.test.mjs`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { classifyEntry } from "../plugin/scripts/finisher-scope.mjs";
import { repoRoot, skipWithoutRepo, trackedPaths } from "../plugin/scripts/repo-root.mjs";

const ROOT = repoRoot(fileURLToPath(new URL(".", import.meta.url)));
const SKIP_WITHOUT_REPO = skipWithoutRepo(ROOT, "the check over plugin/'s shipped markdown");
const MARKDOWN = /\.(md|markdown)$/i;
const PROMPTS = ROOT === null ? [] : trackedPaths(ROOT, ["plugin"]).filter((p) => MARKDOWN.test(p));

test("the check sees plugin/'s shipped markdown", { skip: SKIP_WITHOUT_REPO }, () => {
  assert.notEqual(PROMPTS.length, 0, "no tracked .md or .markdown file under plugin/, so the check below would pass over nothing");
});

test("every tracked markdown file under plugin/ is the prompt surface, never prose", { skip: SKIP_WITHOUT_REPO }, () => {
  const prose = PROMPTS.filter((p) => classifyEntry(p, "M", "100644", "100644").class !== null);
  assert.deepEqual(prose, [], "shipped prompts the Inert diff verdict would call prose");
});
