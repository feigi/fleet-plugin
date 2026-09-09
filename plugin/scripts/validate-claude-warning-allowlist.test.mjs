// #1347's third routed comment: `claude plugin validate --strict` fails the
// real install on exactly one warning — missing `version` in
// `plugin/.claude-plugin/plugin.json`, which #1336 removed per ADR 0003 (a
// version marker would reintroduce the update no-op trap). `validate-claude.sh`
// therefore runs `--json` and allow-lists that ONE warning's exact message
// text, held in `.github/scripts/validate-claude-warning-allowlist.json`.
//
// "add a test that the allow-list still matches the CLI's wording" — the
// ticket's own words, because a stale allow-list string is the vacuous-gate
// failure shape this repo already knows (#1314's own citation: `--strict`
// fooled its own documentation). This test is that check: it runs the real
// `claude` binary against this repo's own `plugin/` manifest and asserts the
// warning text it prints is BYTE-IDENTICAL to the allow-listed string.
//
// Skips (never fails) where no `claude` binary is on PATH — the same
// external-tool-absent shape `candidates.test.mjs` uses for gojq: a gate that
// cannot resolve its dependency skips rather than reporting a false failure
// unrelated to this repo's own code. CI's `validate-claude` job always has a
// pinned `claude` on PATH; local runs without one skip this one test and
// nothing else in the suite depends on it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO = fileURLToPath(new URL("..", import.meta.url)); // plugin/
const WORKTREE_ROOT = fileURLToPath(new URL("../..", import.meta.url)); // repo root, above plugin/
const ALLOWLIST_PATH = join(WORKTREE_ROOT, ".github", "scripts", "validate-claude-warning-allowlist.json");

function claudeAvailable() {
  const r = spawnSync("claude", ["--version"], { encoding: "utf8" });
  return r.status === 0;
}

const SKIP = claudeAvailable() ? false : "no 'claude' binary on PATH — cannot verify the CLI's own wording here";

test(
  "the allow-listed missing-version warning text matches claude plugin validate's real wording",
  { skip: SKIP },
  () => {
    assert.ok(existsSync(ALLOWLIST_PATH), `${ALLOWLIST_PATH} exists`);
    const allowlisted = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8")).missingVersionWarning;
    assert.equal(typeof allowlisted, "string");
    assert.notEqual(allowlisted, "");

    const r = spawnSync("claude", ["plugin", "validate", "--json", "."], { cwd: REPO, encoding: "utf8" });
    assert.equal(r.status, 0, `claude plugin validate exits 0 (non-strict) on this repo's own plugin manifest: ${r.stdout}${r.stderr}`);
    const report = JSON.parse(r.stdout);
    const messages = (report.manifest?.warnings ?? []).map((w) => w.message);
    assert.equal(messages.length, 1, `plugin/.claude-plugin/plugin.json carries exactly one warning today (missing version): got ${JSON.stringify(messages)}`);
    assert.equal(messages[0], allowlisted, "the allow-listed string must be byte-identical to the CLI's own wording");
  },
);

test(
  "claude plugin validate --strict fails on that same warning — the reason --strict cannot be used verbatim",
  { skip: SKIP },
  () => {
    const r = spawnSync("claude", ["plugin", "validate", "--strict", "."], { cwd: REPO, encoding: "utf8" });
    assert.notEqual(r.status, 0, "strict mode turns the version warning into a failure");
  },
);
