// Regression gate for label-map.mjs: the Label map's cache format, its
// reader, and the `show` verb. Zero deps:
//   node --test tests/label-map.test.mjs
//
// The CLI runs as a child process in a real temporary git repository, the
// cache seeded through tests/support/label-map-seed.mjs or, for a cache the
// writer would never be handed, written raw.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./support/temp-dir.mjs";
import { seedLabelMap } from "./support/label-map-seed.mjs";
import { LABEL_MAP_FILE, LABEL_ROLES, LabelMapUnreadable, labelStringFaults, readLabelMap, writeLabelMap } from "../plugin/scripts/label-map.mjs";
import { FleetDirUnresolvable } from "../plugin/scripts/fleet-dir.mjs";
import { gitEnv } from "../plugin/scripts/git-env.mjs";

const SCRIPT = fileURLToPath(new URL("../plugin/scripts/label-map.mjs", import.meta.url));
const ENV = gitEnv({}, process.env);

const git = (cwd, ...args) => {
  const r = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8", env: ENV });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};

function repo() {
  const ws = realpathSync(tempDir("label-map-"));
  git(ws, "init", "-q");
  git(ws, "commit", "-q", "--allow-empty", "-m", "init");
  return ws;
}

const identity = () => Object.fromEntries(LABEL_ROLES.map((r) => [r, r]));

// A cache the writer is never handed: the raw text lands as-is.
function writeRaw(ws, text) {
  mkdirSync(join(ws, ".fleet"), { recursive: true });
  writeFileSync(join(ws, ".fleet", LABEL_MAP_FILE), text);
}

const cli = (cwd, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, env: ENV, encoding: "utf8" });

const long = "x".repeat(51);

// Every cache the reader must refuse, as a function that leaves it in `ws`.
const INVALID = [
  ["unparsable JSON", (ws) => writeRaw(ws, "{not json")],
  ["no roles object", (ws) => writeRaw(ws, JSON.stringify({ derivedAt: "2026-10-27T00:00:00.000Z" }))],
  ["roles an array", (ws) => writeRaw(ws, JSON.stringify({ roles: LABEL_ROLES }))],
  ["a role missing", (ws) => seedLabelMap(ws, { roles: { "in-progress": undefined } })],
  ["a role not a string", (ws) => seedLabelMap(ws, { roles: { onhold: 7 } })],
  ["a string containing a double quote", (ws) => seedLabelMap(ws, { roles: { onhold: 'on"hold' } })],
  ["a string containing a backslash", (ws) => seedLabelMap(ws, { roles: { onhold: "on\\hold" } })],
  ["a string over 50 characters", (ws) => seedLabelMap(ws, { roles: { onhold: long } })],
  ["an empty string", (ws) => seedLabelMap(ws, { roles: { onhold: "" } })],
  ["a string blank after trimming", (ws) => seedLabelMap(ws, { roles: { onhold: "   " } })],
  ["two roles sharing one string", (ws) => seedLabelMap(ws, { roles: { onhold: "wontfix" } })],
  ["two roles sharing one string differing only in case", (ws) => seedLabelMap(ws, { roles: { onhold: "WontFix" } })],
];

test("show <role> prints the mapped string from a seeded identity map", () => {
  const ws = repo();
  seedLabelMap(ws);
  const r = cli(ws, "show", "in-progress");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "in-progress\n");
});

test("show with no role prints the whole roles object as JSON", () => {
  const ws = repo();
  seedLabelMap(ws);
  const r = cli(ws, "show");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), identity());
});

test("the seeder's roles override remaps a role, and show reads the remapped string", () => {
  const ws = repo();
  seedLabelMap(ws, { roles: { "ready-for-agent": "agent-ready" } });
  const one = cli(ws, "show", "ready-for-agent");
  assert.equal(one.status, 0, one.stderr);
  assert.equal(one.stdout, "agent-ready\n");
  const all = cli(ws, "show");
  assert.equal(all.status, 0, all.stderr);
  assert.deepEqual(JSON.parse(all.stdout), { ...identity(), "ready-for-agent": "agent-ready" });
});

test("the seeder with no overrides writes the identity map, origin default, an absent table and an ISO derivedAt", () => {
  const ws = repo();
  const file = seedLabelMap(ws);
  assert.equal(file, join(ws, ".fleet", LABEL_MAP_FILE));
  const cache = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(cache.roles, identity());
  assert.deepEqual(cache.origin, Object.fromEntries(LABEL_ROLES.map((r) => [r, "default"])));
  assert.deepEqual(cache.table, { present: false, rows: {} });
  assert.equal(new Date(cache.derivedAt).toISOString(), cache.derivedAt);
});

test("the seeder passes origin, table and derivedAt overrides through to the cache", () => {
  const ws = repo();
  const table = { present: true, rows: { "ready-for-agent": "agent-ready" } };
  const file = seedLabelMap(ws, {
    roles: { "ready-for-agent": "agent-ready" },
    origin: { "ready-for-agent": "table" },
    table,
    derivedAt: "2026-10-01T00:00:00.000Z",
  });
  const cache = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(cache.origin["ready-for-agent"], "table");
  assert.equal(cache.origin.onhold, "default");
  assert.deepEqual(cache.table, table);
  assert.equal(cache.derivedAt, "2026-10-01T00:00:00.000Z");
});

test("show with no cache exits 1 and names ensure as the derivation step", () => {
  const ws = repo();
  const r = cli(ws, "show", "in-progress");
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /\bensure\b/);
});

for (const [name, leave] of INVALID) {
  test(`show refuses a cache with ${name}: exit 1 naming ensure, with or without a role`, () => {
    const ws = repo();
    leave(ws);
    for (const args of [["show"], ["show", "needs-triage"]]) {
      const r = cli(ws, ...args);
      assert.equal(r.status, 1, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
      assert.equal(r.stdout, "");
      assert.match(r.stderr, /\bensure\b/);
    }
  });

  test(`the reader throws LabelMapUnreadable naming ensure for a cache with ${name}`, () => {
    const ws = repo();
    leave(ws);
    assert.throws(() => readLabelMap({ cwd: ws }), (e) => e instanceof LabelMapUnreadable && /\bensure\b/.test(e.message));
  });
}

test("the reader throws LabelMapUnreadable naming ensure when there is no cache", () => {
  const ws = repo();
  assert.throws(() => readLabelMap({ cwd: ws }), (e) => e instanceof LabelMapUnreadable && /\bensure\b/.test(e.message));
});

test("the reader returns the roles of a valid seeded cache", () => {
  const ws = repo();
  seedLabelMap(ws, { roles: { "ready-for-agent": "agent-ready" } });
  assert.deepEqual(readLabelMap({ cwd: ws }), { ...identity(), "ready-for-agent": "agent-ready" });
});

test("the reader outside a repository throws FleetDirUnresolvable, not LabelMapUnreadable", () => {
  const dir = realpathSync(tempDir("label-map-norepo-"));
  assert.throws(() => readLabelMap({ cwd: dir }), FleetDirUnresolvable);
});

test("strings D8 allows are accepted: exactly 50 characters, spaces, punctuation, a case-distinct unrelated string", () => {
  const ws = repo();
  const roles = { "ready-for-agent": "y".repeat(50), "needs-info": "Needs Info: waiting", onhold: "on-hold" };
  seedLabelMap(ws, { roles });
  const r = cli(ws, "show");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { ...identity(), ...roles });
});

test("a linked worktree's show reads the main checkout's cache", () => {
  const ws = repo();
  seedLabelMap(ws, { roles: { "in-progress": "wip" } });
  const wt = join(ws, ".worktrees", "w1");
  git(ws, "worktree", "add", "-q", "--detach", wt);
  const r = cli(wt, "show", "in-progress");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "wip\n");
});

test("show for an unknown role exits 2, with a valid cache and with none", () => {
  for (const seeded of [true, false]) {
    const ws = repo();
    if (seeded) seedLabelMap(ws);
    const r = cli(ws, "show", "ready-for-robot");
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /ready-for-robot/);
  }
});

test("show outside a repository exits 2", () => {
  const dir = realpathSync(tempDir("label-map-norepo-"));
  for (const args of [["show"], ["show", "in-progress"]]) {
    const r = cli(dir, ...args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.equal(r.stdout, "");
  }
});

test("an unknown verb, no verb, or a second role is a usage refusal, exit 2, naming only show", () => {
  const ws = repo();
  seedLabelMap(ws);
  for (const args of [["ensure"], ["set", "onhold=paused"], ["bogus"], [], ["show", "onhold", "wontfix"]]) {
    const r = cli(ws, ...args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /usage: label-map\.mjs show \[<role>\]/);
    assert.doesNotMatch(r.stderr, /usage:.*\b(ensure|set)\b/);
  }
});

test("labelStringFaults names the role and the rule for each D8 break, and nothing for a valid map", () => {
  assert.deepEqual(labelStringFaults(identity()), []);
  const faults = labelStringFaults({ ...identity(), onhold: "WONTFIX", "needs-info": 'a"b', wontfix: "" });
  const byRole = Object.fromEntries(faults.map((f) => [f.role, f.rule]));
  assert.match(byRole["needs-info"], /"/);
  assert.match(byRole.wontfix, /empty/);
  // `wontfix` is empty, so `onhold`'s WONTFIX shares no string with it.
  assert.equal(byRole.onhold, undefined);
  const dup = labelStringFaults({ ...identity(), onhold: "WONTFIX" });
  assert.equal(dup.length, 1);
  assert.match(dup[0].role, /^(onhold|wontfix)$/);
  assert.match(dup[0].rule, /onhold|wontfix/);
  assert.match(dup[0].rule, /case/);
});

test("the writer replaces the cache through a temp file beside it, leaving no temp file behind", () => {
  const ws = repo();
  seedLabelMap(ws);
  const file = writeLabelMap({ derivedAt: "2026-10-27T00:00:00.000Z", table: { present: false, rows: {} }, roles: { ...identity(), onhold: "paused" }, origin: {} }, { cwd: ws });
  assert.equal(file, join(ws, ".fleet", LABEL_MAP_FILE));
  assert.equal(JSON.parse(readFileSync(file, "utf8")).roles.onhold, "paused");
  assert.deepEqual(readdirSync(join(ws, ".fleet")), [LABEL_MAP_FILE]);
});
