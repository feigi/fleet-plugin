// gitEnv() is the one place the scrub #1599 asks every `.mjs` git caller to
// route through lives — see git-env.mjs's own header for why a helper rather
// than a fourth hand-spelled copy. What matters here is observable: the two
// names are gone from what it returns, everything else survives, an override
// cannot smuggle either name back in, and the input is never mutated — a
// caller passing `process.env` itself must not have it silently rewritten
// out from under every OTHER thing in this process that reads it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gitEnv } from "./git-env.mjs";

test("GIT_DIR and GIT_WORK_TREE are absent from the result, even when the base carries them", () => {
  const base = { GIT_DIR: "/somewhere/.git", GIT_WORK_TREE: "/somewhere", PATH: "/bin" };
  const env = gitEnv({}, base);
  assert.equal("GIT_DIR" in env, false);
  assert.equal("GIT_WORK_TREE" in env, false);
  assert.equal(env.PATH, "/bin", "an unrelated var must survive the scrub");
});

test("a base carrying neither name is unaffected beyond the copy", () => {
  const base = { PATH: "/bin", LANG: "C" };
  assert.deepEqual(gitEnv({}, base), { PATH: "/bin", LANG: "C" });
});

test("overrides are merged in, alongside the scrub", () => {
  const base = { GIT_DIR: "/somewhere/.git", PATH: "/bin" };
  const env = gitEnv({ LC_ALL: "C", GH_REPO: "" }, base);
  assert.equal(env.LC_ALL, "C");
  assert.equal(env.GH_REPO, "");
  assert.equal(env.PATH, "/bin");
  assert.equal("GIT_DIR" in env, false, "an override alongside the scrub must not resurrect it");
});

test("an override that itself names GIT_DIR or GIT_WORK_TREE cannot smuggle either back in", () => {
  // The deletes run AFTER the merge, precisely so a caller cannot defeat the
  // scrub by accident — an override map built from some other source that
  // happens to carry either key must not undo what this function exists to
  // do.
  const env = gitEnv({ GIT_DIR: "/attacker/.git", GIT_WORK_TREE: "/attacker" }, { PATH: "/bin" });
  assert.equal("GIT_DIR" in env, false);
  assert.equal("GIT_WORK_TREE" in env, false);
});

test("the base object passed in is never mutated", () => {
  const base = { GIT_DIR: "/somewhere/.git", GIT_WORK_TREE: "/somewhere", PATH: "/bin" };
  const before = { ...base };
  gitEnv({}, base);
  assert.deepEqual(base, before, "a caller passing its own long-lived object must get it back unchanged");
});

test("with no base given, process.env itself is read — not a frozen or empty stand-in", () => {
  const hadDir = "GIT_DIR" in process.env;
  const prevDir = process.env.GIT_DIR;
  process.env.GIT_DIR = "/ambient/.git";
  process.env.FLEET_GIT_ENV_PROBE = "present";
  try {
    const env = gitEnv();
    assert.equal("GIT_DIR" in env, false, "the real ambient GIT_DIR must be scrubbed, not merely a fixture's stand-in for it");
    assert.equal(env.FLEET_GIT_ENV_PROBE, "present", "an unrelated real process.env var must still come through by default");
  } finally {
    if (hadDir) process.env.GIT_DIR = prevDir; else delete process.env.GIT_DIR;
    delete process.env.FLEET_GIT_ENV_PROBE;
  }
});
