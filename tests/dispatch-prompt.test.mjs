import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const SCRIPT = "plugin/scripts/dispatch-prompt.mjs";
const REPO_ROOT = join(import.meta.dirname, "..");

function run(args, opts = {}) {
  const cmd = `node ${SCRIPT} ${args}`;
  try {
    const output = execSync(cmd, { cwd: REPO_ROOT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...opts });
    return { stdout: output, stderr: "", exitCode: 0 };
  } catch (err) {
    return { stdout: err.stdout || "", stderr: err.stderr || "", exitCode: err.status || 1 };
  }
}

function withScratchDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-prompt-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("render implementer with all arguments outputs brief to stdout", () => {
  const result = run('render implementer --abs-path /tmp/wt --branch main');
  assert.equal(result.exitCode, 0, `Expected exit 0, got ${result.exitCode}: ${result.stderr}`);
  assert.ok(result.stdout.includes("unattended fleet member"), "Output should contain implementer role text");
});

test("render implementer with --json outputs JSON with role, kind, args, sha256", () => {
  const result = run('render implementer --abs-path /tmp/wt --branch main --json');
  assert.equal(result.exitCode, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.role, "implementer");
  assert.equal(output.kind, null);
  assert.ok(output.args);
  assert.equal(typeof output.sha256, "string");
  assert.match(output.sha256, /^[a-f0-9]{64}$/);
});

test("render finisher --kind fresh with required arguments outputs brief", () => {
  const result = run('render finisher --kind fresh --abs-path /tmp/wt --branch main --testCmd "npm test" --pr 123');
  assert.equal(result.exitCode, 0, `Expected exit 0, got ${result.exitCode}: ${result.stderr}`);
  assert.ok(result.stdout.includes("finisher"), "Output should contain finisher role text");
});

test("render finisher --kind repair", () => {
  const result = run('render finisher --kind repair --abs-path /tmp/wt --branch main --testCmd "npm test"');
  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.includes("repair"), "Output should contain repair role text");
});

test("render fix-applier --kind review with required arguments", () => {
  const result = run('render fix-applier --kind review --abs-path /tmp/wt --branch main --scratch /tmp/scratch --pr 123 --run run-abc');
  assert.equal(result.exitCode, 0, `Expected exit 0, got ${result.exitCode}: ${result.stderr}`);
});

test("render fix-applier --kind conflict", () => {
  const result = run('render fix-applier --kind conflict --abs-path /tmp/wt --branch main');
  assert.equal(result.exitCode, 0);
});

test("render fix-applier --kind dispositions-retry", () => {
  const result = run('render fix-applier --kind dispositions-retry --abs-path /tmp/wt --branch main');
  assert.equal(result.exitCode, 0);
});

test("render review-runner --kind fresh with required arguments", () => {
  const result = run('render review-runner --kind fresh --abs-path /tmp/wt --branch main --testCmd "npm test" --pr 123 --scratch /tmp/scratch --run run-abc');
  assert.equal(result.exitCode, 0, `Expected exit 0, got ${result.exitCode}: ${result.stderr}`);
});

test("render merge-bot with required arguments", () => {
  const result = run('render merge-bot --ready-list "123,124,125"');
  assert.equal(result.exitCode, 0, `Expected exit 0, got ${result.exitCode}: ${result.stderr}`);
});

test("render tier-check with required arguments", () => {
  const result = run('render tier-check --member impl-123 --pr 456 --scratch /tmp/scratch');
  assert.equal(result.exitCode, 0, `Expected exit 0, got ${result.exitCode}: ${result.stderr}`);
});

// Omitted argument tests for implementer
test("render implementer omitting --abs-path exits 2", () => {
  const result = run('render implementer --branch main');
  assert.equal(result.exitCode, 2);
  assert.ok(result.stderr.includes("abs-path"), "Error should name the missing argument");
});

test("render implementer omitting --branch exits 2", () => {
  const result = run('render implementer --abs-path /tmp/wt');
  assert.equal(result.exitCode, 2);
  assert.ok(result.stderr.includes("branch"), "Error should name the missing argument");
});

// Omitted argument tests for finisher --kind fresh
test("render finisher fresh omitting --abs-path exits 2", () => {
  const result = run('render finisher --kind fresh --branch main --testCmd "npm test" --pr 123');
  assert.equal(result.exitCode, 2);
  assert.ok(result.stderr.includes("abs-path"), "Error should name the missing argument");
});

test("render finisher fresh omitting --branch exits 2", () => {
  const result = run('render finisher --kind fresh --abs-path /tmp/wt --testCmd "npm test" --pr 123');
  assert.equal(result.exitCode, 2);
  assert.ok(result.stderr.includes("branch"), "Error should name the missing argument");
});

test("render finisher fresh omitting --testCmd exits 2", () => {
  const result = run('render finisher --kind fresh --abs-path /tmp/wt --branch main --pr 123');
  assert.equal(result.exitCode, 2);
  assert.ok(result.stderr.includes("testCmd"), "Error should name the missing argument");
});

test("render finisher fresh omitting --pr exits 2", () => {
  const result = run('render finisher --kind fresh --abs-path /tmp/wt --branch main --testCmd "npm test"');
  assert.equal(result.exitCode, 2);
  assert.ok(result.stderr.includes("pr"), "Error should name the missing argument");
});

// Omitted argument tests for fix-applier --kind review
test("render fix-applier review omitting --abs-path exits 2", () => {
  const result = run('render fix-applier --kind review --branch main --scratch /tmp/scratch --pr 123 --run run-abc');
  assert.equal(result.exitCode, 2);
  assert.ok(result.stderr.includes("abs-path"));
});

test("render fix-applier review omitting --scratch exits 2", () => {
  const result = run('render fix-applier --kind review --abs-path /tmp/wt --branch main --pr 123 --run run-abc');
  assert.equal(result.exitCode, 2);
  assert.ok(result.stderr.includes("scratch"));
});

// Omitted argument tests for review-runner --kind fresh
test("render review-runner fresh omitting --testCmd exits 2", () => {
  const result = run('render review-runner --kind fresh --abs-path /tmp/wt --branch main --pr 123 --scratch /tmp/scratch --run run-abc');
  assert.equal(result.exitCode, 2);
  assert.ok(result.stderr.includes("testCmd"));
});

// Omitted argument tests for merge-bot
test("render merge-bot omitting --ready-list exits 2", () => {
  const result = run('render merge-bot');
  assert.equal(result.exitCode, 2);
  assert.ok(result.stderr.includes("ready-list"));
});

// Omitted argument tests for tier-check
test("render tier-check omitting --member exits 2", () => {
  const result = run('render tier-check --pr 456 --scratch /tmp/scratch');
  assert.equal(result.exitCode, 2);
  assert.ok(result.stderr.includes("member"));
});

test("render tier-check omitting --pr exits 2", () => {
  const result = run('render tier-check --member impl-123 --scratch /tmp/scratch');
  assert.equal(result.exitCode, 2);
  assert.ok(result.stderr.includes("pr"));
});

test("render tier-check omitting --scratch exits 2", () => {
  const result = run('render tier-check --member impl-123 --pr 456');
  assert.equal(result.exitCode, 2);
  assert.ok(result.stderr.includes("scratch"));
});

// Path validation tests
test("render implementer with relative --abs-path exits 2", () => {
  const result = run('render implementer --abs-path ./relative --branch main');
  assert.equal(result.exitCode, 2);
  assert.ok(result.stderr.includes("must be absolute"));
});

test("render finisher fresh with relative --scratch exits 2", () => {
  const result = run('render finisher --kind fresh --abs-path /tmp/wt --branch main --testCmd "npm test" --pr 123 --scratch ./scratch');
  assert.equal(result.exitCode, 2);
  assert.ok(result.stderr.includes("must be absolute"));
});

// kind requirement tests
test("render fix-applier without --kind exits 2", () => {
  const result = run('render fix-applier --abs-path /tmp/wt --branch main');
  assert.equal(result.exitCode, 2);
  assert.ok(result.stderr.includes("requires --kind"));
});

test("render finisher without --kind exits 2", () => {
  const result = run('render finisher --abs-path /tmp/wt --branch main');
  assert.equal(result.exitCode, 2);
  assert.ok(result.stderr.includes("requires --kind"));
});

test("render review-runner without --kind exits 2", () => {
  const result = run('render review-runner --abs-path /tmp/wt --branch main --testCmd "npm test"');
  assert.equal(result.exitCode, 2);
  assert.ok(result.stderr.includes("requires --kind"));
});

test("render fix-applier with invalid --kind exits 2", () => {
  const result = run('render fix-applier --kind invalid --abs-path /tmp/wt --branch main');
  assert.equal(result.exitCode, 2);
  assert.ok(result.stderr.includes("Invalid kind"));
});

// --member file writing tests
test("render implementer with --member creates .md file", () => {
  withScratchDir((scratchDir) => {
    const result = run(`render implementer --abs-path /tmp/wt --branch main --scratch ${scratchDir} --member test-impl`);
    assert.equal(result.exitCode, 0);
    const mdFile = join(scratchDir, "test-impl", "test-impl.md");
    assert.ok(require("fs").existsSync(mdFile), `File ${mdFile} should exist`);
    const content = readFileSync(mdFile, "utf8");
    assert.ok(content.includes("unattended fleet member"));
  });
});

test("render implementer with --member creates .json file with sha256", () => {
  withScratchDir((scratchDir) => {
    const result = run(`render implementer --abs-path /tmp/wt --branch main --scratch ${scratchDir} --member test-impl`);
    assert.equal(result.exitCode, 0);
    const jsonFile = join(scratchDir, "test-impl", "test-impl.json");
    assert.ok(require("fs").existsSync(jsonFile), `File ${jsonFile} should exist`);
    const content = readFileSync(jsonFile, "utf8");
    const data = JSON.parse(content);
    assert.equal(data.role, "implementer");
    assert.equal(typeof data.sha256, "string");
    assert.match(data.sha256, /^[a-f0-9]{64}$/);
  });
});

test("render implementer with --member .json sha256 matches .md file sha256", () => {
  withScratchDir((scratchDir) => {
    run(`render implementer --abs-path /tmp/wt --branch main --scratch ${scratchDir} --member test-impl`);
    const mdFile = join(scratchDir, "test-impl", "test-impl.md");
    const jsonFile = join(scratchDir, "test-impl", "test-impl.json");
    const mdContent = readFileSync(mdFile, "utf8");
    const jsonData = JSON.parse(readFileSync(jsonFile, "utf8"));
    const expectedSha = createHash("sha256").update(mdContent).digest("hex");
    assert.equal(jsonData.sha256, expectedSha, "JSON sha256 should match .md file sha256");
  });
});

// JSON output with --member
test("render implementer --json --member outputs JSON and creates files", () => {
  withScratchDir((scratchDir) => {
    const result = run(`render implementer --abs-path /tmp/wt --branch main --scratch ${scratchDir} --member test-impl --json`);
    assert.equal(result.exitCode, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.role, "implementer");
    const mdFile = join(scratchDir, "test-impl", "test-impl.md");
    assert.ok(require("fs").existsSync(mdFile));
  });
});

// Invalid role tests
test("render invalid-role exits 2", () => {
  const result = run('render invalid-role');
  assert.equal(result.exitCode, 2);
  assert.ok(result.stderr.includes("Invalid role"));
});

// Missing subcommand tests
test("missing render subcommand exits 2", () => {
  const result = run('');
  assert.equal(result.exitCode, 2);
});

test("dispatch-prompt render without role exits 2", () => {
  const result = run('render');
  assert.equal(result.exitCode, 2);
});

// Template validation tests
test("placeholder rendering works correctly", () => {
  const result = run('render implementer --abs-path /tmp/my-wt --branch feature-branch');
  assert.equal(result.exitCode, 0);
  const output = result.stdout;
  assert.ok(output.includes("/tmp/my-wt"), "abs-path placeholder should be rendered");
  assert.ok(output.includes("feature-branch"), "branch placeholder should be rendered");
});

// Mutation test: verify that missing placeholder validation works
test("Mutation: removing placeholder validation should fail", () => {
  // This test verifies the implementation correctly detects when required placeholders are missing
  const result = run('render implementer --branch main');
  assert.equal(result.exitCode, 2, "Should fail when --abs-path is missing");
  assert.ok(result.stderr.includes("abs-path"), "Should report the missing placeholder");
});

// Mutation test: verify path absolute validation
test("Mutation: relative path validation", () => {
  const result = run('render implementer --abs-path relative/path --branch main');
  assert.equal(result.exitCode, 2, "Should reject relative paths");
  assert.ok(result.stderr.includes("absolute"), "Error should mention absolute paths");
});

// Mutation test: verify kind extraction works
test("Mutation: kind section extraction", () => {
  const resultFresh = run('render finisher --kind fresh --abs-path /tmp/wt --branch main --testCmd "npm test" --pr 123');
  const resultRepair = run('render finisher --kind repair --abs-path /tmp/wt --branch main --testCmd "npm test" --pr 123');
  assert.notEqual(resultFresh.stdout, resultRepair.stdout, "Different kinds should produce different output");
});

// Mutation test: verify sha256 computation
test("Mutation: sha256 computation", () => {
  const result1 = run('render implementer --abs-path /tmp/wt1 --branch main --json');
  const result2 = run('render implementer --abs-path /tmp/wt2 --branch main --json');
  const output1 = JSON.parse(result1.stdout);
  const output2 = JSON.parse(result2.stdout);
  assert.notEqual(output1.sha256, output2.sha256, "Different content should produce different sha256");
});
