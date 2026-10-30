// Regression gate for label-map.mjs: the Label map's cache format, its
// reader, the `show` verb, the `ensure` derivation step and `set`. Zero deps:
//   node --test tests/label-map.test.mjs
//
// The CLI runs as a child process in a real temporary git repository, the
// cache seeded through tests/support/label-map-seed.mjs or, for a cache the
// writer would never be handed, written raw.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./support/temp-dir.mjs";
import { seedLabelMap } from "./support/label-map-seed.mjs";
import { writeExecStub } from "./support/exec-stub.mjs";
import { LABEL_MAP_FILE, LABEL_ROLES, LabelMapUnreadable, TRIAGE_TABLE_FILE, labelStringFaults, readLabelMap, writeLabelMap } from "../plugin/scripts/label-map.mjs";
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

// Every cache the reader must refuse, as a function that leaves it in `ws`,
// and for a cache with no usable `roles` object the refusal the reader names.
const NO_ROLES = /holds no `roles` object/;
const FS_FAULT = /filesystem fault/;
const INVALID = [
  ["nothing at all, not even the file", () => {}],
  ["unparsable JSON", (ws) => writeRaw(ws, "{not json")],
  ["no roles object", (ws) => writeRaw(ws, JSON.stringify({ derivedAt: "2026-10-27T00:00:00.000Z" })), NO_ROLES],
  ["roles an array", (ws) => writeRaw(ws, JSON.stringify({ roles: LABEL_ROLES })), NO_ROLES],
  ["roles null", (ws) => writeRaw(ws, JSON.stringify({ roles: null })), NO_ROLES],
  ["a role missing", (ws) => seedLabelMap(ws, { roles: { "in-progress": undefined } })],
  ["a role not a string", (ws) => seedLabelMap(ws, { roles: { onhold: 7 } })],
  ["a string containing a double quote", (ws) => seedLabelMap(ws, { roles: { onhold: 'on"hold' } })],
  ["a string containing a backslash", (ws) => seedLabelMap(ws, { roles: { onhold: "on\\hold" } })],
  ["a string over 50 characters", (ws) => seedLabelMap(ws, { roles: { onhold: long } })],
  ["a string of 51 astral emoji", (ws) => seedLabelMap(ws, { roles: { onhold: "\u{1F41B}".repeat(51) } }), /longer than 50 code points \(51\)/],
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

for (const [name, leave, refusal] of INVALID) {
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
    assert.throws(
      () => readLabelMap({ cwd: ws }),
      (e) => e instanceof LabelMapUnreadable && /\bensure\b/.test(e.message) && (!refusal || refusal.test(e.message)) && !FS_FAULT.test(e.message),
    );
  });
}

test("the reader returns the roles of a valid seeded cache", () => {
  const ws = repo();
  seedLabelMap(ws, { roles: { "ready-for-agent": "agent-ready" } });
  assert.deepEqual(readLabelMap({ cwd: ws }), { ...identity(), "ready-for-agent": "agent-ready" });
});

test("the reader throws LabelMapUnreadable naming ensure and the error code when the cache cannot be read", () => {
  const ws = repo();
  mkdirSync(join(ws, ".fleet", LABEL_MAP_FILE), { recursive: true });
  assert.throws(
    () => readLabelMap({ cwd: ws }),
    (e) => e instanceof LabelMapUnreadable && /\bensure\b/.test(e.message) && /\(EISDIR\)/.test(e.message),
  );
});

// A cache that exists and cannot be read, as a function that leaves it in `ws`,
// and the error code the read fails with. Nothing reads a fixture again after
// its refusal, so none is restored: tempDir's own cleanup removes it.
const UNREADABLE = [
  ["a directory at labels.json", "EISDIR", (ws) => mkdirSync(join(ws, ".fleet", LABEL_MAP_FILE), { recursive: true })],
  ["a labels.json chmod 000", "EACCES", (ws) => chmodSync(seedLabelMap(ws), 0o000)],
  ["a .fleet/ chmod 000", "EACCES", (ws) => { seedLabelMap(ws); chmodSync(join(ws, ".fleet"), 0o000); }],
  ["a regular file at .fleet", "ENOTDIR", (ws) => writeFileSync(join(ws, ".fleet"), "x")],
];

// The refusal for a cache that cannot be read: a filesystem fault, its repair,
// then `ensure` as the following step.
const unreadableRefusal = (code) => new RegExp(
  `cannot read the Label map at .*labels\\.json \\(${code}\\): a filesystem fault, not a map fault — `
  + "make that path a readable file \\(check its and \\.fleet/'s permissions, and that \\.fleet/ is a directory\\) "
  + "or remove what is in the way, then run `label-map\\.mjs ensure`, the Label map derivation step",
);

// `ensure`'s and `set`'s refusal of that cache: the reader's own message, then
// `nothing written`.
const unreadableDerivation = (code) => new RegExp(`${unreadableRefusal(code).source}; nothing written\\n`);

for (const [name, code, leave] of UNREADABLE) {
  test(`the reader throws LabelMapUnreadable for ${name}, naming ${code} as a filesystem fault, its repair, then ensure`, (t) => {
    if (code === "EACCES" && process.getuid?.() === 0) return t.skip("root reads every file");
    const ws = repo();
    leave(ws);
    assert.throws(
      () => readLabelMap({ cwd: ws }),
      (e) => e instanceof LabelMapUnreadable && unreadableRefusal(code).test(e.message) && e.cause?.code === code,
    );
  });

  test(`show refuses ${name}: exit 1, naming ${code} as a filesystem fault, its repair, then ensure`, (t) => {
    if (code === "EACCES" && process.getuid?.() === 0) return t.skip("root reads every file");
    const ws = repo();
    leave(ws);
    for (const args of [["show"], ["show", "needs-triage"]]) {
      const r = cli(ws, ...args);
      assert.equal(r.status, 1, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
      assert.equal(r.stdout, "");
      assert.match(r.stderr, unreadableRefusal(code));
    }
  });
}

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

test("D8 counts code points: 50 astral emoji are accepted by the reader and show, 51 are refused", () => {
  const ws = repo();
  const fifty = "\u{1F41B}".repeat(50);
  seedLabelMap(ws, { roles: { onhold: fifty } });
  assert.equal(readLabelMap({ cwd: ws }).onhold, fifty);
  const r = cli(ws, "show", "onhold");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${fifty}\n`);
  assert.deepEqual(labelStringFaults({ ...identity(), onhold: fifty }), []);
  const faults = labelStringFaults({ ...identity(), onhold: `${fifty}\u{1F41B}` });
  assert.equal(faults.length, 1);
  assert.equal(faults[0].role, "onhold");
  assert.match(faults[0].rule, /longer than 50 code points \(51\)/);
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

test("an unknown verb, no verb, or a second role is a usage refusal, exit 2, naming ensure, set and show", () => {
  const ws = repo();
  seedLabelMap(ws);
  for (const args of [["bogus"], [], ["show", "onhold", "wontfix"], ["ensure", "onhold"]]) {
    const r = cli(ws, ...args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /usage: label-map\.mjs ensure \| set \[--accept-suggestions\] \[--create\] \[<role>=<label> …\] \| show \[<role>\]/);
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
  assert.equal(dup[0].role, "onhold");
  assert.match(dup[0].rule, /\bwontfix\b.*case/);
});

const PAUSED = { derivedAt: "2026-10-27T00:00:00.000Z", table: { present: false, rows: {} }, roles: { ...identity(), onhold: "paused" }, origin: {} };

test("the writer replaces the cache and leaves no temp file behind", () => {
  const ws = repo();
  seedLabelMap(ws);
  const file = writeLabelMap(PAUSED, { cwd: ws });
  assert.equal(file, join(ws, ".fleet", LABEL_MAP_FILE));
  assert.equal(JSON.parse(readFileSync(file, "utf8")).roles.onhold, "paused");
  assert.deepEqual(readdirSync(join(ws, ".fleet")), [LABEL_MAP_FILE]);
});

// The writer's temp file is `<cache>.<pid>.tmp`; a directory there makes the
// write to it fail, which a writer writing the cache in place never meets.
test("the writer writes through a temp file beside the cache: with that path blocked it throws the write's own error and the cache keeps its bytes", () => {
  const ws = repo();
  const file = seedLabelMap(ws);
  const before = readFileSync(file, "utf8");
  mkdirSync(`${file}.${process.pid}.tmp`);
  assert.throws(() => writeLabelMap(PAUSED, { cwd: ws }), { code: "EISDIR" });
  assert.equal(readFileSync(file, "utf8"), before);
});

test("a write that fails at the rename throws and leaves no temp file behind", () => {
  const ws = repo();
  mkdirSync(join(ws, ".fleet", LABEL_MAP_FILE), { recursive: true });
  assert.throws(() => writeLabelMap(PAUSED, { cwd: ws }));
  assert.deepEqual(readdirSync(join(ws, ".fleet")), [LABEL_MAP_FILE]);
});

// ---------------------------------------------------------------------------
// `ensure`: the Label map derivation step. A fake `gh` on PATH answers
// `label list` from a fixture list and records every call it gets.
// ---------------------------------------------------------------------------

const LIST = "label list --limit 1000 --json name";
const TABLE_FILE = ["docs", "agents", "triage-labels.md"];

// `gh` answering `label list` with `live` (names), recording every argv, one
// line per call, and the GH_REPO each call saw. `fail` makes every call exit 1
// with a message; `answer`, a shell snippet, replaces the reply outright.
function rig(live, { fail = false, answer } = {}) {
  const bin = realpathSync(tempDir("label-map-bin-"));
  const log = join(bin, "gh.log");
  const repoLog = join(bin, "gh.repo");
  const fixture = join(bin, "labels.json");
  writeFileSync(log, "");
  writeFileSync(repoLog, "");
  writeFileSync(fixture, JSON.stringify(live.map((name) => ({ name }))));
  const reply = answer ?? (fail ? `echo "gh: boom" >&2\nexit 1\n` : `case "$1 $2" in\n"label list") cat "${fixture}" ;;\n*) exit 1 ;;\nesac\n`);
  writeExecStub(join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nprintf '[%s]\\n' "\${GH_REPO-unset}" >> "${repoLog}"\n${reply}`);
  return {
    env: { ...ENV, PATH: `${bin}:${process.env.PATH}` },
    calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean),
    repos: () => readFileSync(repoLog, "utf8").split("\n").filter(Boolean),
  };
}

// Run `ensure` in `ws` against `live`, with `env` over the process's own.
// Whatever the outcome, `gh` was asked for the label list once and for
// nothing else: never a `label create`.
function ensure(ws, live, { env = {}, ...opts } = {}) {
  const g = rig(live, opts);
  const r = spawnSync(process.execPath, [SCRIPT, "ensure"], { cwd: ws, env: { ...g.env, ...env }, encoding: "utf8" });
  const calls = g.calls();
  assert.deepEqual(calls, [LIST], `gh calls: ${JSON.stringify(calls)}`);
  r.repos = g.repos();
  return r;
}

const asked = (r) => {
  assert.equal(r.status, 3, `${r.stdout}${r.stderr}`);
  return JSON.parse(r.stdout);
};
const mapOf = (r) => {
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  return JSON.parse(r.stdout);
};
const cacheOf = (ws) => JSON.parse(readFileSync(join(ws, ".fleet", LABEL_MAP_FILE), "utf8"));
const noCache = (ws) => assert.equal(readdirSync(ws).includes(".fleet") && readdirSync(join(ws, ".fleet")).includes(LABEL_MAP_FILE), false);
const without = (list, ...names) => list.filter((name) => !names.includes(name));
const entry = (payload, role) => payload.uncertain.find((u) => u.role === role);

// A triage-label table as /setup-matt-pocock-skills seeds it, from [role, string] pairs.
function writeTable(ws, pairs, { header = "Label in our tracker", before = "", after = "" } = {}) {
  const rows = pairs.map(([role, string]) => `| \`${role}\` | ${string} | meaning |`);
  const text = `${before}| Label in mattpocock/skills | ${header} | Meaning |\n| --- | --- | --- |\n${rows.join("\n")}\n${after}`;
  mkdirSync(join(ws, ...TABLE_FILE.slice(0, -1)), { recursive: true });
  writeFileSync(join(ws, ...TABLE_FILE), text);
}

const FIVE = ["needs-triage", "needs-info", "ready-for-agent", "ready-for-human", "wontfix"];
const fiveRows = (over = {}) => FIVE.map((role) => [role, `\`${over[role] ?? role}\``]);
const tableOf = (rows) => ({ present: true, rows });

test("ensure: the identity table with every label live is certain: the map printed, the cache written, origin table for the rows", () => {
  const ws = repo();
  writeTable(ws, fiveRows());
  const map = mapOf(ensure(ws, LABEL_ROLES));
  assert.deepEqual(map, identity());
  const cache = cacheOf(ws);
  assert.deepEqual(cache.roles, identity());
  assert.deepEqual(cache.table, tableOf(Object.fromEntries(FIVE.map((role) => [role, role]))));
  assert.deepEqual(cache.origin, Object.fromEntries(LABEL_ROLES.map((role) => [role, FIVE.includes(role) ? "table" : "default"])));
  assert.match(cache.derivedAt, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(readLabelMap({ cwd: ws }), identity());
});

test("ensure: a table with a second table whose onhold row's second cell is a description reads that row as no row and asks nothing", () => {
  const ws = repo();
  writeTable(ws, fiveRows(), {
    after: "\n## Labels that are not triage roles\n\n| Label | Meaning |\n| --- | --- |\n| `onhold` | Deferred: specified and agent-ready, but not actionable here yet |\n",
  });
  assert.deepEqual(mapOf(ensure(ws, LABEL_ROLES)), identity());
  assert.equal(cacheOf(ws).origin.onhold, "default");
  assert.equal(cacheOf(ws).table.rows.onhold, undefined);
});

// `gh label list --json name` on this repository, 2026-10-28.
const THIS_REPO_LIVE = [
  "bug", "documentation", "duplicate", "enhancement", "good first issue", "help wanted", "invalid", "question", "wontfix",
  "ready-for-agent", "in-progress", "ready-to-merge", "minor", "patch", "ready-for-human", "major", "needs-info",
  "needs-triage", "onhold", "wayfinder:map", "wayfinder:grilling", "wayfinder:prototype", "wayfinder:research", "wayfinder:task",
];

test("ensure: this repository's own triage-label file and live label set derive the identity map with no question", () => {
  const ws = repo();
  mkdirSync(join(ws, "docs", "agents"), { recursive: true });
  writeFileSync(join(ws, ...TABLE_FILE), readFileSync(fileURLToPath(new URL(`../${TABLE_FILE.join("/")}`, import.meta.url))));
  assert.deepEqual(mapOf(ensure(ws, THIS_REPO_LIVE)), identity());
});

test("ensure: no table and every default live is certain, origin default, the table recorded absent", () => {
  const ws = repo();
  assert.deepEqual(mapOf(ensure(ws, LABEL_ROLES)), identity());
  const cache = cacheOf(ws);
  assert.deepEqual(cache.table, { present: false, rows: {} });
  assert.deepEqual(Object.values(cache.origin), LABEL_ROLES.map(() => "default"));
});

test("ensure: a file with no `Label in our tracker` table is a present table with no rows; backticks round the header and an empty second cell change nothing", () => {
  const ws = repo();
  mkdirSync(join(ws, "docs", "agents"), { recursive: true });
  writeFileSync(join(ws, ...TABLE_FILE), "| Label | Meaning |\n| --- | --- |\n| `onhold` | x |\n");
  assert.deepEqual(mapOf(ensure(ws, LABEL_ROLES)), identity());
  assert.deepEqual(cacheOf(ws).table, tableOf({}));

  const ws2 = repo();
  writeTable(ws2, [["needs-triage", ""], ["bug", "`bug`"], ["wontfix", "`declined`"]], { header: "`Label in our tracker`" });
  const payload = asked(ensure(ws2, without(LABEL_ROLES, "wontfix")));
  assert.equal(payload.certain["needs-triage"], "needs-triage");
  assert.equal(payload.uncertain.length, 1);
  assert.equal(entry(payload, "wontfix").suggestion, "declined");
});

test("ensure: a table written without leading and trailing pipes is read the same as one with them", () => {
  const ws = repo();
  mkdirSync(join(ws, ...TABLE_FILE.slice(0, -1)), { recursive: true });
  writeFileSync(join(ws, ...TABLE_FILE), "Role | Label in our tracker\n--- | ---\n`ready-for-agent` | `agent-ready`\nwontfix | declined |\n");
  const map = mapOf(ensure(ws, [...without(LABEL_ROLES, "ready-for-agent", "wontfix"), "agent-ready", "declined"]));
  assert.deepEqual(map, { ...identity(), "ready-for-agent": "agent-ready", wontfix: "declined" });
  assert.deepEqual(cacheOf(ws).table, tableOf({ "ready-for-agent": "agent-ready", wontfix: "declined" }));
});

test("ensure: an escaped pipe inside a cell is part of the string, a trailing one included", () => {
  const ws = repo();
  writeTable(ws, [["wontfix", "a\\|b"]], { after: "| `needs-info` | info\\|\n" });
  const map = mapOf(ensure(ws, [...without(LABEL_ROLES, "wontfix", "needs-info"), "a|b", "info|"]));
  assert.deepEqual(map, { ...identity(), wontfix: "a|b", "needs-info": "info|" });
  assert.deepEqual(cacheOf(ws).table, tableOf({ "needs-info": "info|", wontfix: "a|b" }));
});

test("ensure: only a `Label in our tracker` header of two or more cells with a separator beneath starts the table, and only the first such table is read", () => {
  const live = [...LABEL_ROLES, "declined"];
  const decline = "| `needs-info` | `x` | m |\n| `wontfix` | `declined` | m |\n";

  const noSeparator = repo();
  mkdirSync(join(noSeparator, ...TABLE_FILE.slice(0, -1)), { recursive: true });
  writeFileSync(join(noSeparator, ...TABLE_FILE), `| Role | Label in our tracker | Meaning |\n${decline}`);
  assert.deepEqual(mapOf(ensure(noSeparator, live)), identity());
  assert.deepEqual(cacheOf(noSeparator).table, tableOf({}));

  const oneCell = repo();
  mkdirSync(join(oneCell, ...TABLE_FILE.slice(0, -1)), { recursive: true });
  writeFileSync(join(oneCell, ...TABLE_FILE), "| Label in our tracker |\n| --- |\n| `wontfix` | `declined` |\n");
  assert.deepEqual(mapOf(ensure(oneCell, live)), identity());
  assert.deepEqual(cacheOf(oneCell).table, tableOf({}));

  const twoTables = repo();
  writeTable(twoTables, fiveRows(), { after: `\n| Role | Label in our tracker | Meaning |\n| --- | --- | --- |\n${decline}` });
  assert.deepEqual(mapOf(ensure(twoTables, live)), identity());
  assert.deepEqual(cacheOf(twoTables).table, tableOf(Object.fromEntries(FIVE.map((role) => [role, role]))));
});

test("ensure: no table and nothing live asks about every role, each suggested as its own name, none existing; nothing written", () => {
  const ws = repo();
  const payload = asked(ensure(ws, []));
  assert.deepEqual(payload.certain, {});
  assert.deepEqual(payload.uncertain.map((u) => u.role), LABEL_ROLES);
  for (const u of payload.uncertain) {
    assert.deepEqual(u, { role: u.role, suggestion: u.role, origin: "default", candidates: [], exists: false });
  }
  noCache(ws);
});

test("ensure: a table string the tracker lacks is asked, suggested as the table's own string, origin table; the other roles stay certain", () => {
  const ws = repo();
  writeTable(ws, fiveRows({ "ready-for-agent": "agent-ready" }));
  const payload = asked(ensure(ws, without(LABEL_ROLES, "ready-for-agent")));
  assert.deepEqual(payload.uncertain, [{ role: "ready-for-agent", suggestion: "agent-ready", origin: "table", candidates: [], exists: false }]);
  assert.deepEqual(payload.certain, Object.fromEntries(without(LABEL_ROLES, "ready-for-agent").map((role) => [role, role])));
  noCache(ws);
});

test("ensure: the exit-3 payload names the table file, whatever the origin of the uncertainty, beside certain and uncertain only", () => {
  const ws = repo();
  writeTable(ws, fiveRows({ "ready-for-agent": "agent-ready" }));
  const fromTable = asked(ensure(ws, without(LABEL_ROLES, "ready-for-agent")));
  assert.equal(fromTable.tableFile, TRIAGE_TABLE_FILE);
  assert.deepEqual(Object.keys(fromTable).sort(), ["certain", "tableFile", "uncertain"]);
  assert.deepEqual(fromTable.uncertain, [{ role: "ready-for-agent", suggestion: "agent-ready", origin: "table", candidates: [], exists: false }]);
  // Every other origin an uncertain role can have names it too: no table at all (each role a default), a near match, and a cached string gone from the tracker.
  const fromDefault = asked(ensure(repo(), []));
  const fromNear = asked(ensure(repo(), [...without(LABEL_ROLES, "onhold"), "on-hold"]));
  const goneWs = repo();
  seedFrom(goneWs, {});
  const fromGone = asked(ensure(goneWs, [...without(LABEL_ROLES, "ready-for-agent"), "agent-ready"]));
  for (const [origin, payload] of [["default", fromDefault], ["near-match", fromNear], ["gone", fromGone]]) {
    assert.deepEqual([...new Set(payload.uncertain.map((u) => u.origin))], [origin], `the ${origin} case asks about ${origin} roles only`);
    assert.equal(payload.tableFile, TRIAGE_TABLE_FILE, `a ${origin} question names the table file`);
  }
});

test("ensure: a near match is the suggestion and a candidate; several suggest the alphabetically first and all are candidates", () => {
  const ws = repo();
  const one = asked(ensure(ws, [...without(LABEL_ROLES, "onhold"), "on-hold"]));
  assert.deepEqual(one.uncertain, [{ role: "onhold", suggestion: "on-hold", origin: "near-match", candidates: ["on-hold"], exists: true }]);

  const ws2 = repo();
  const two = asked(ensure(ws2, [...without(LABEL_ROLES, "onhold"), "on-hold", "On Hold"]));
  assert.deepEqual(two.uncertain, [{ role: "onhold", suggestion: "On Hold", origin: "near-match", candidates: ["On Hold", "on-hold"], exists: true }]);
  noCache(ws);
  noCache(ws2);
});

test("ensure: near matches equal ignoring case are ordered by code point, whatever the live order; a letter outside ASCII counts when matching, punctuation outside ASCII does not", () => {
  const ws = repo();
  const tied = asked(ensure(ws, [...without(LABEL_ROLES, "onhold"), "on-hold", "On-Hold"]));
  assert.deepEqual(tied.uncertain, [{ role: "onhold", suggestion: "On-Hold", origin: "near-match", candidates: ["On-Hold", "on-hold"], exists: true }]);

  const ws2 = repo();
  const accented = asked(ensure(ws2, [...without(LABEL_ROLES, "onhold"), "onholdé", "on–hold"]));
  assert.deepEqual(accented.uncertain, [{ role: "onhold", suggestion: "on–hold", origin: "near-match", candidates: ["on–hold"], exists: true }]);
});

test("ensure: the default beside a near match is asked, the default suggested, the near match a candidate", () => {
  const ws = repo();
  const payload = asked(ensure(ws, [...LABEL_ROLES, "on-hold"]));
  assert.deepEqual(payload.uncertain, [{ role: "onhold", suggestion: "onhold", origin: "default", candidates: ["on-hold"], exists: true }]);
  noCache(ws);
});

test("ensure: a table row's string differing from the tracker's only in case is certain and the map holds the tracker's spelling; so is a default", () => {
  const ws = repo();
  writeTable(ws, fiveRows({ "ready-for-agent": "Ready-For-Agent" }));
  const map = mapOf(ensure(ws, LABEL_ROLES));
  assert.equal(map["ready-for-agent"], "ready-for-agent");
  assert.equal(cacheOf(ws).origin["ready-for-agent"], "table");

  const ws2 = repo();
  writeTable(ws2, fiveRows({ "ready-for-agent": "ready-for-agent" }));
  const map2 = mapOf(ensure(ws2, [...without(LABEL_ROLES, "ready-for-agent", "onhold"), "Ready-For-Agent", "OnHold"]));
  assert.equal(map2["ready-for-agent"], "Ready-For-Agent");
  assert.equal(map2.onhold, "OnHold");
  assert.equal(cacheOf(ws2).origin.onhold, "default");
});

test("ensure: two rows for one role with different strings are asked, the first suggested, origin table", () => {
  const ws = repo();
  writeTable(ws, [...fiveRows(), ["ready-for-agent", "`agent-ready`"]]);
  const payload = asked(ensure(ws, [...LABEL_ROLES, "agent-ready"]));
  assert.deepEqual(payload.uncertain, [{ role: "ready-for-agent", suggestion: "ready-for-agent", origin: "table", candidates: [], exists: true }]);
  noCache(ws);
});

test("ensure: two rows for one role with the same string are one row: certain, and the cached table holds the string, not an array", () => {
  const ws = repo();
  writeTable(ws, [...fiveRows(), ["onhold", "`paused`"], ["onhold", "`paused`"]]);
  const map = mapOf(ensure(ws, [...LABEL_ROLES, "paused"]));
  assert.equal(map.onhold, "paused");
  assert.equal(cacheOf(ws).table.rows.onhold, "paused");
  assert.equal(cacheOf(ws).origin.onhold, "table");
});

// A cache `ensure` would have written, for the cases that start from one.
function seedFrom(ws, { roles = {}, origin = {}, rows = null }) {
  seedLabelMap(ws, { roles, origin, table: rows === null ? { present: false, rows: {} } : tableOf(rows) });
}

test("ensure gone: a cached table-origin string deleted from the tracker is asked, suggestion null, was set", () => {
  const ws = repo();
  writeTable(ws, fiveRows({ "ready-for-agent": "agent-ready" }));
  seedFrom(ws, { roles: { "ready-for-agent": "agent-ready" }, origin: { "ready-for-agent": "table" }, rows: Object.fromEntries(FIVE.map((r) => [r, r === "ready-for-agent" ? "agent-ready" : r])) });
  const before = readFileSync(join(ws, ".fleet", LABEL_MAP_FILE), "utf8");
  const payload = asked(ensure(ws, without(LABEL_ROLES, "ready-for-agent")));
  assert.deepEqual(payload.uncertain, [{ role: "ready-for-agent", suggestion: null, origin: "gone", candidates: [], exists: false, was: "agent-ready" }]);
  assert.equal(readFileSync(join(ws, ".fleet", LABEL_MAP_FILE), "utf8"), before);
});

test("ensure gone: a cached default renamed in the tracker is asked, suggestion null; with a near match live it is the suggestion, was set; a table row changed to another string not live is the suggestion", () => {
  const ws = repo();
  seedFrom(ws, {});
  const gone = asked(ensure(ws, [...without(LABEL_ROLES, "ready-for-agent"), "agent-ready"]));
  assert.deepEqual(gone.uncertain, [{ role: "ready-for-agent", suggestion: null, origin: "gone", candidates: [], exists: false, was: "ready-for-agent" }]);

  const ws2 = repo();
  seedFrom(ws2, {});
  const near = asked(ensure(ws2, [...without(LABEL_ROLES, "ready-for-agent"), "Ready For Agent"]));
  assert.deepEqual(near.uncertain, [
    { role: "ready-for-agent", suggestion: "Ready For Agent", origin: "near-match", candidates: ["Ready For Agent"], exists: true, was: "ready-for-agent" },
  ]);

  const ws3 = repo();
  writeTable(ws3, fiveRows({ "ready-for-agent": "ready-agent" }));
  seedFrom(ws3, { roles: { "ready-for-agent": "agent-ready" }, origin: { "ready-for-agent": "table" }, rows: Object.fromEntries(FIVE.map((r) => [r, r === "ready-for-agent" ? "agent-ready" : r])) });
  const moved = asked(ensure(ws3, without(LABEL_ROLES, "ready-for-agent")));
  assert.deepEqual(moved.uncertain, [{ role: "ready-for-agent", suggestion: "ready-agent", origin: "table", candidates: [], exists: false, was: "agent-ready" }]);
});

test("ensure gone: a vanished maintainer answer is asked with the default suggested when the default is live", () => {
  const ws = repo();
  seedFrom(ws, { roles: { onhold: "on-hold" }, origin: { onhold: "maintainer" } });
  const payload = asked(ensure(ws, LABEL_ROLES));
  assert.deepEqual(payload.uncertain, [{ role: "onhold", suggestion: "onhold", origin: "default", candidates: [], exists: true, was: "on-hold" }]);
});

test("ensure carry-over: a maintainer answer survives a table edit to another role while its label exists; a row for its own role overrides it", () => {
  const ws = repo();
  seedFrom(ws, { roles: { onhold: "on-hold" }, origin: { onhold: "maintainer" } });
  writeTable(ws, [["needs-triage", "needs-triage"]]);
  const map = mapOf(ensure(ws, [...LABEL_ROLES, "on-hold"]));
  assert.equal(map.onhold, "on-hold");
  assert.equal(cacheOf(ws).origin.onhold, "maintainer");
  assert.equal(cacheOf(ws).origin["needs-triage"], "table");

  const ws2 = repo();
  seedFrom(ws2, { roles: { onhold: "on-hold" }, origin: { onhold: "maintainer" } });
  writeTable(ws2, [["onhold", "onhold"]]);
  assert.equal(mapOf(ensure(ws2, [...LABEL_ROLES, "on-hold"])).onhold, "onhold");
  assert.equal(cacheOf(ws2).origin.onhold, "table");
});

test("ensure carry-over: an answer claimed by a table row is asked again, suggested its default, claimedBy the row's role, and it is not exit 1", () => {
  const ws = repo();
  seedFrom(ws, { roles: { onhold: "paused" }, origin: { onhold: "maintainer" } });
  writeTable(ws, [["wontfix", "paused"]]);
  const payload = asked(ensure(ws, [...LABEL_ROLES, "paused"]));
  assert.equal(payload.certain.wontfix, "paused");
  assert.deepEqual(payload.uncertain, [
    { role: "onhold", suggestion: "onhold", origin: "default", candidates: [], exists: true, claimedBy: { role: "wontfix", string: "paused", by: "table" } },
  ]);
});

test("ensure carry-over: an answer claimed by another role's default is asked again, claimedBy by default; with a different near match of that role live the role is asked too", () => {
  const seed = (ws) => seedFrom(ws, {
    roles: { onhold: "wontfix", wontfix: "declined" },
    origin: { onhold: "maintainer", wontfix: "table" },
    rows: { wontfix: "declined" },
  });
  const ws = repo();
  seed(ws);
  const payload = asked(ensure(ws, [...LABEL_ROLES, "declined"]));
  assert.equal(payload.certain.wontfix, "wontfix");
  assert.deepEqual(payload.uncertain, [
    { role: "onhold", suggestion: "onhold", origin: "default", candidates: [], exists: true, claimedBy: { role: "wontfix", string: "wontfix", by: "default" } },
  ]);

  const ws2 = repo();
  seed(ws2);
  const both = asked(ensure(ws2, [...LABEL_ROLES, "declined", "Wont-Fix"]));
  assert.deepEqual(both.uncertain, [
    { role: "wontfix", suggestion: "wontfix", origin: "default", candidates: ["Wont-Fix"], exists: true },
    { role: "onhold", suggestion: "onhold", origin: "default", candidates: [], exists: true, claimedBy: { role: "wontfix", string: "wontfix", by: "default" } },
  ]);
});

test("ensure carry-over: answers that name each other's defaults in a ring all carry, since none resolves to its default", () => {
  const ws = repo();
  const ring = { "needs-triage": "ready-for-human", "ready-for-human": "wontfix", wontfix: "needs-triage" };
  seedFrom(ws, { roles: ring, origin: Object.fromEntries(Object.keys(ring).map((r) => [r, "maintainer"])) });
  writeTable(ws, [["in-progress", "in-progress"]]);
  const map = mapOf(ensure(ws, LABEL_ROLES));
  assert.deepEqual(map, { ...identity(), ...ring });
  const cache = cacheOf(ws);
  assert.deepEqual(Object.keys(ring).map((r) => cache.origin[r]), ["maintainer", "maintainer", "maintainer"]);
  assert.equal(cache.origin["in-progress"], "table");
});

test("ensure carry-over: a cache that breaks the string rules carries no answer, so two answers naming one label are both asked", () => {
  const ws = repo();
  writeRaw(ws, JSON.stringify({
    derivedAt: "2026-10-27T00:00:00.000Z",
    table: { present: false, rows: {} },
    roles: { ...identity(), onhold: "paused", wontfix: "paused" },
    origin: { onhold: "maintainer", wontfix: "maintainer" },
  }));
  const payload = asked(ensure(ws, [...without(LABEL_ROLES, "onhold", "wontfix"), "paused"]));
  assert.deepEqual(payload.uncertain.map((u) => [u.role, u.suggestion, u.origin, u.exists]), [
    ["wontfix", "wontfix", "default", false],
    ["onhold", "onhold", "default", false],
  ]);
});

test("ensure carry-over: a cache that lacks a role but breaks no string rule still carries its answers; the role it lacks carries none", () => {
  const ws = repo();
  const { "ready-to-merge": _, ...seven } = identity();
  writeRaw(ws, JSON.stringify({
    derivedAt: "2026-10-27T00:00:00.000Z",
    table: { present: false, rows: {} },
    roles: { ...seven, onhold: "paused" },
    origin: { onhold: "maintainer", "ready-to-merge": "maintainer" },
  }));
  assert.deepEqual(mapOf(ensure(ws, [...without(LABEL_ROLES, "onhold"), "paused"])), { ...identity(), onhold: "paused" });
  assert.equal(cacheOf(ws).origin.onhold, "maintainer");
  assert.equal(cacheOf(ws).origin["ready-to-merge"], "default");
});

const wrongRows = (extra = []) => [["ready-for-human", "needs-triage"], ...extra];

test("ensure D8: two table rows naming one live label are exit 1 naming both roles; nothing written, nothing else asked of gh", () => {
  const ws = repo();
  writeTable(ws, [["ready-for-agent", "agent-ready"], ["wontfix", "AGENT-READY"]]);
  const r = ensure(ws, [...LABEL_ROLES, "agent-ready"]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /wontfix: .*ready-for-agent row/);
  noCache(ws);
});

test("ensure D8: a row naming another role's default is exit 1 naming the row and the `set` fix, live or not, and with a near match of it live", () => {
  for (const live of [LABEL_ROLES, without(LABEL_ROLES, "needs-triage"), [...LABEL_ROLES, "Needs Triage"]]) {
    const ws = repo();
    writeTable(ws, wrongRows());
    const r = ensure(ws, live);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /ready-for-human: its row names "needs-triage"/);
    assert.match(r.stderr, /set needs-triage=<label>/);
    noCache(ws);
  }
});

test("ensure D8: the same row is no break when the claimed role has a carried maintainer answer; ready-for-human maps to needs-triage", () => {
  const ws = repo();
  seedFrom(ws, { roles: { "needs-triage": "triage" }, origin: { "needs-triage": "maintainer" } });
  writeTable(ws, wrongRows());
  const map = mapOf(ensure(ws, [...LABEL_ROLES, "triage"]));
  assert.equal(map["ready-for-human"], "needs-triage");
  assert.equal(map["needs-triage"], "triage");
  assert.equal(cacheOf(ws).origin["needs-triage"], "maintainer");
});

test("ensure D8: a table string containing a double quote, live or not, or longer than 50 characters is exit 1; so is a backslash", () => {
  for (const [bad, live] of [['a"b', []], ['a"b', ['a"b']], ["x".repeat(51), []], ["a\\b", ["a\\b"]]]) {
    const ws = repo();
    writeTable(ws, [["wontfix", bad]]);
    const r = ensure(ws, [...LABEL_ROLES, ...live]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /wontfix: its row names/);
    noCache(ws);
  }
});

test("ensure D8: a live near match containing a double quote is neither suggestion nor candidate; one a table row names is neither either", () => {
  const ws = repo();
  const payload = asked(ensure(ws, [...without(LABEL_ROLES, "onhold"), 'on"hold']));
  assert.deepEqual(payload.uncertain, [{ role: "onhold", suggestion: "onhold", origin: "default", candidates: [], exists: false }]);

  const ws2 = repo();
  writeTable(ws2, [["wontfix", "on-hold"]]);
  const held = asked(ensure(ws2, [...without(LABEL_ROLES, "onhold"), "on-hold"]));
  assert.equal(held.certain.wontfix, "on-hold");
  assert.deepEqual(held.uncertain, [{ role: "onhold", suggestion: "onhold", origin: "default", candidates: [], exists: false }]);
});

test("ensure: a cached, matching, fully live map is printed, exit 0, one `gh label list`, the cache's bytes and mtime untouched", () => {
  const ws = repo();
  writeTable(ws, fiveRows());
  mapOf(ensure(ws, LABEL_ROLES));
  const file = join(ws, ".fleet", LABEL_MAP_FILE);
  const before = readFileSync(file, "utf8");
  const mtime = statSync(file).mtimeMs;
  assert.deepEqual(mapOf(ensure(ws, [...LABEL_ROLES, "bug"])), identity());
  assert.equal(readFileSync(file, "utf8"), before);
  assert.equal(statSync(file).mtimeMs, mtime);
  assert.deepEqual(readdirSync(join(ws, ".fleet")), [LABEL_MAP_FILE]);
});

test("ensure: a cached remapped map whose labels are all live is printed as cached", () => {
  const ws = repo();
  writeTable(ws, fiveRows({ "ready-for-agent": "agent-ready" }));
  seedFrom(ws, { roles: { "ready-for-agent": "agent-ready" }, origin: { "ready-for-agent": "table" }, rows: Object.fromEntries(FIVE.map((r) => [r, r === "ready-for-agent" ? "agent-ready" : r])) });
  assert.deepEqual(mapOf(ensure(ws, [...without(LABEL_ROLES, "ready-for-agent"), "agent-ready"])), { ...identity(), "ready-for-agent": "agent-ready" });
});

test("ensure: an edited table is derived again and the cache replaced; a cached string whose case changed in the tracker is derived again to the tracker's spelling", () => {
  const ws = repo();
  writeTable(ws, fiveRows());
  mapOf(ensure(ws, LABEL_ROLES));
  writeTable(ws, [...fiveRows(), ["in-progress", "in-progress"]]);
  mapOf(ensure(ws, LABEL_ROLES));
  assert.equal(cacheOf(ws).table.rows["in-progress"], "in-progress");
  assert.equal(cacheOf(ws).origin["in-progress"], "table");

  const ws2 = repo();
  mapOf(ensure(ws2, LABEL_ROLES));
  const map = mapOf(ensure(ws2, [...without(LABEL_ROLES, "needs-info"), "Needs-Info"]));
  assert.equal(map["needs-info"], "Needs-Info");
  assert.equal(cacheOf(ws2).roles["needs-info"], "Needs-Info");
});

test("ensure: a cache missing a live string, or not parsing, is derived again; a vanished label with a valid cache is asked, not printed", () => {
  const ws = repo();
  writeRaw(ws, "not json");
  assert.deepEqual(mapOf(ensure(ws, LABEL_ROLES)), identity());
  assert.deepEqual(cacheOf(ws).roles, identity());

  const ws2 = repo();
  seedLabelMap(ws2);
  assert.equal(asked(ensure(ws2, without(LABEL_ROLES, "wontfix"))).uncertain[0].was, "wontfix");
});

test("ensure: gh failing is exit 2 with a valid cache and without, the cache untouched; a list the size of the limit is exit 2 too", () => {
  const ws = repo();
  const file = seedLabelMap(ws);
  const before = readFileSync(file, "utf8");
  const failed = ensure(ws, LABEL_ROLES, { fail: true });
  assert.equal(failed.status, 2, failed.stdout + failed.stderr);
  assert.equal(failed.stdout, "");
  assert.match(failed.stderr, /gh label list failed: gh: boom/);
  assert.equal(readFileSync(file, "utf8"), before);

  const ws2 = repo();
  assert.equal(ensure(ws2, LABEL_ROLES, { fail: true }).status, 2);

  const capped = ensure(ws, [...LABEL_ROLES, ...Array.from({ length: 1000 - LABEL_ROLES.length }, (_, i) => `l${i}`)]);
  assert.equal(capped.status, 2, capped.stdout + capped.stderr);
  assert.match(capped.stderr, /capped/);
  assert.equal(readFileSync(file, "utf8"), before);
  const under = ensure(ws, [...LABEL_ROLES, ...Array.from({ length: 999 - LABEL_ROLES.length }, (_, i) => `l${i}`)]);
  assert.equal(under.status, 0, under.stdout + under.stderr);
});

test("ensure: a gh killed by a signal, or naming a label with something other than a string, is exit 2 with the cache untouched", () => {
  const ws = repo();
  const file = seedLabelMap(ws);
  const before = readFileSync(file, "utf8");
  const killed = ensure(ws, LABEL_ROLES, { answer: "kill -TERM $$\n" });
  assert.equal(killed.status, 2, killed.stdout + killed.stderr);
  assert.match(killed.stderr, /gh was killed by SIGTERM/);
  const numbered = ensure(ws, [...LABEL_ROLES, 5]);
  assert.equal(numbered.status, 2, numbered.stdout + numbered.stderr);
  assert.match(numbered.stderr, /gh label list did not answer a list of \{ name \}/);
  assert.equal(readFileSync(file, "utf8"), before);
});

test("ensure: a cached table with a key that is no Label role is not the table now in the repo, so the map is derived again and the cache rewritten", () => {
  const ws = repo();
  writeTable(ws, fiveRows());
  const rows = Object.fromEntries(FIVE.map((role) => [role, role]));
  seedLabelMap(ws, { origin: Object.fromEntries(FIVE.map((role) => [role, "table"])), table: tableOf({ ...rows, bogus: "x" }) });
  assert.deepEqual(mapOf(ensure(ws, LABEL_ROLES)), identity());
  assert.deepEqual(cacheOf(ws).table, tableOf(rows));
});

test("ensure: a cache that exists and cannot be read is exit 2 and never written over, so its maintainer answers survive", (t) => {
  if (process.getuid?.() === 0) return t.skip("root reads every file");
  const ws = repo();
  const file = seedLabelMap(ws, { roles: { "in-progress": "mine" }, origin: { "in-progress": "maintainer" } });
  const before = readFileSync(file, "utf8");
  chmodSync(file, 0o000);
  let r;
  try {
    r = ensure(ws, [...LABEL_ROLES, "mine"]);
  } finally {
    chmodSync(file, 0o600);
  }
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, unreadableDerivation("EACCES"));
  assert.equal(readFileSync(file, "utf8"), before);
});

test("ensure outside a repository is exit 2 and never calls gh; a triage-label path that is not a file is exit 2", () => {
  const dir = realpathSync(tempDir("label-map-norepo-"));
  const g = rig(LABEL_ROLES);
  const r = spawnSync(process.execPath, [SCRIPT, "ensure"], { cwd: dir, env: g.env, encoding: "utf8" });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.deepEqual(g.calls(), []);

  const ws = repo();
  mkdirSync(join(ws, ...TABLE_FILE), { recursive: true });
  const bad = spawnSync(process.execPath, [SCRIPT, "ensure"], { cwd: ws, env: g.env, encoding: "utf8" });
  assert.equal(bad.status, 2, bad.stdout + bad.stderr);
  assert.match(bad.stderr, /cannot read .*triage-labels\.md/);
  assert.deepEqual(g.calls(), []);
});

test("ensure from a linked worktree reads the main checkout's cache and the worktree's table", () => {
  const ws = repo();
  const wt = join(realpathSync(tempDir("label-map-wt-")), "wt");
  git(ws, "worktree", "add", "-q", wt, "-b", "side");
  mapOf(ensure(wt, LABEL_ROLES));
  assert.deepEqual(cacheOf(ws).roles, identity());
});

test("ensure: an ambient GIT_DIR or GH_REPO naming another repository does not change what it reads: the table comes from the checkout it runs in, and gh is run with GH_REPO empty", () => {
  const ws = repo();
  writeTable(ws, fiveRows({ "ready-for-agent": "agent-ready" }));
  const other = repo();
  writeTable(other, fiveRows());
  const r = ensure(join(ws, "docs"), [...LABEL_ROLES, "agent-ready"], { env: { GIT_DIR: join(other, ".git"), GH_REPO: "other/repo" } });
  assert.equal(mapOf(r)["ready-for-agent"], "agent-ready");
  assert.deepEqual(r.repos, ["[]"]);
  assert.equal(cacheOf(ws).origin["ready-for-agent"], "table");
});

// ---------------------------------------------------------------------------
// `set`: the map written from a derivation plus the maintainer's answer. The
// fake `gh` keeps the live list in a file: `label list` answers from it and
// `label create` appends to it, so the list read again after a create holds
// what was created. Every argv is recorded.
// ---------------------------------------------------------------------------

// `create` is a function of the list file's path returning the shell the stub
// runs for `label create`; by default it appends the created string. `list`,
// a function of that path and the default listing shell, replaces the shell
// the stub runs for `label list`.
function setRig(live, { create, list } = {}) {
  const dir = realpathSync(tempDir("label-map-set-"));
  const names = join(dir, "names");
  writeFileSync(names, live.map((name) => `${name}\n`).join(""));
  const onCreate = create?.(names) ?? `shift 2; [ "$1" = -- ] && shift; printf '%s\\n' "$1" >> "${names}"`;
  const listing = `printf '['; sep=''; while IFS= read -r n; do printf '%s{"name":"%s"}' "$sep" "$n"; sep=,; done < "${names}"; printf ']\\n'`;
  const answer = [
    `case "$1 $2" in`,
    `"label list") ${list?.(names, listing) ?? listing} ;;`,
    `"label create") ${onCreate} ;;`,
    `*) exit 1 ;;`,
    `esac`,
    ``,
  ].join("\n");
  return rig([], { answer });
}

const setRun = (ws, g, ...args) => spawnSync(process.execPath, [SCRIPT, "set", ...args], { cwd: ws, env: g.env, encoding: "utf8" });
const ensureRun = (ws, g) => spawnSync(process.execPath, [SCRIPT, "ensure"], { cwd: ws, env: g.env, encoding: "utf8" });
const created = (...names) => names.map((name) => `label create ${name}`);

// `ensure` run next on the same stub: exit 0 and exactly one `gh label list`, no other call.
function ensureThenReads(ws, g) {
  const before = g.calls().length;
  const r = ensureRun(ws, g);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(g.calls().slice(before), [LIST]);
  return JSON.parse(r.stdout);
}

test("set --accept-suggestions --create creates exactly the missing strings with no colour, writes the cache, and ensure then exits 0 with one gh label list and no other gh call", () => {
  const ws = repo();
  const g = setRig(["needs-triage", "wontfix"]);
  const r = setRun(ws, g, "--accept-suggestions", "--create");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), identity());
  assert.deepEqual(g.calls(), [LIST, ...created(...without(LABEL_ROLES, "needs-triage", "wontfix")), LIST]);
  const cache = cacheOf(ws);
  assert.deepEqual(cache.roles, identity());
  assert.deepEqual(cache.origin, Object.fromEntries(LABEL_ROLES.map((role) => [role, ["needs-triage", "wontfix"].includes(role) ? "default" : "maintainer"])));
  assert.deepEqual(cache.table, { present: false, rows: {} });
  assert.deepEqual(readLabelMap({ cwd: ws }), identity());
  const bytes = readFileSync(join(ws, ".fleet", LABEL_MAP_FILE), "utf8");
  assert.deepEqual(ensureThenReads(ws, g), identity());
  assert.equal(readFileSync(join(ws, ".fleet", LABEL_MAP_FILE), "utf8"), bytes);
});

test("set without --create refuses every missing string by name and role: exit 1, nothing created, nothing written", () => {
  const ws = repo();
  const g = setRig(["needs-triage", "wontfix"]);
  const r = setRun(ws, g, "--accept-suggestions");
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(r.stdout, "");
  for (const role of without(LABEL_ROLES, "needs-triage", "wontfix")) assert.match(r.stderr, new RegExp(`${role}: "${role}" does not exist in the tracker; pass --create`));
  assert.doesNotMatch(r.stderr, /needs-triage: /);
  assert.deepEqual(g.calls(), [LIST]);
  noCache(ws);

  const ws2 = repo();
  const g2 = setRig(LABEL_ROLES);
  const pair = setRun(ws2, g2, "onhold=paused");
  assert.equal(pair.status, 1, pair.stdout + pair.stderr);
  assert.match(pair.stderr, /onhold: "paused" does not exist in the tracker/);
  assert.deepEqual(g2.calls(), [LIST]);
  noCache(ws2);
});

test("set refuses a string D8 rejects, exit 1 naming the role and the rule, with --create too: nothing created, nothing written", () => {
  const cases = [
    [["onhold=on\"hold"], /onhold: its answer names "on\\"hold".*contains `"`\)\. Fix: change the onhold=<label> pair\n/],
    [["onhold=on\\hold"], /onhold: its answer names .*contains `\\`/],
    [[`onhold=${long}`], /onhold: its answer names .*longer than 50 code points \(51\)/],
    [["onhold="], /onhold: its answer names "".*empty after trimming/],
    [["onhold=   "], /onhold: its answer names "   ".*empty after trimming/],
    [["onhold=WONTFIX"], /onhold: its answer names "WONTFIX".*wontfix resolves to as its default.*\. Fix: change the onhold=<label> pair, or run `label-map\.mjs set wontfix=<label>`/],
    [["needs-info=Same", "onhold=same"], /onhold: its answer names "same", the same string as the needs-info=<label> pair \(compared ignoring case\)\. Fix: change the onhold=<label> pair or the needs-info=<label> pair\n/],
  ];
  for (const [args, expected] of cases) {
    const ws = repo();
    const g = setRig(LABEL_ROLES);
    const r = setRun(ws, g, "--accept-suggestions", "--create", ...args);
    assert.equal(r.status, 1, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, expected);
    assert.deepEqual(g.calls(), [LIST], args.join(" "));
    noCache(ws);
  }
});

test("set refuses a table row that breaks D8 on a role no pair covers, as ensure does: exit 1 naming the row, nothing written", () => {
  const ws = repo();
  writeTable(ws, [["wontfix", "a\"b"]]);
  const g = setRig(LABEL_ROLES);
  const r = setRun(ws, g, "--accept-suggestions", "--create", "onhold=on-hold");
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /wontfix: its row names/);
  assert.deepEqual(g.calls(), [LIST]);
  noCache(ws);
});

test("set: an unknown role, a malformed pair, an unknown flag or a role answered twice is a usage refusal, exit 2, and gh is never called", () => {
  const cases = [
    [["ready-for-robot=x"], /unknown role "ready-for-robot"/],
    [["=x"], /unknown role ""/],
    [["onhold"], /malformed pair "onhold"/],
    [["--force"], /unknown flag "--force"/],
    [["--create=1"], /unknown flag "--create=1"/],
    [["-c"], /unknown flag "-c"/],
    [["onhold=a", "onhold=b"], /onhold is answered twice/],
  ];
  for (const [args, expected] of cases) {
    const ws = repo();
    const g = setRig(LABEL_ROLES);
    const r = setRun(ws, g, ...args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, expected);
    if (!/unknown role/.test(expected.source)) assert.match(r.stderr, /usage: label-map\.mjs ensure \| set /);
    assert.deepEqual(g.calls(), [], args.join(" "));
    noCache(ws);
  }
});

test("set refuses an uncertain role no answer covers, naming it: exit 1, nothing created, nothing written", () => {
  const ws = repo();
  const g = setRig([]);
  const none = setRun(ws, g, "--create");
  assert.equal(none.status, 1, none.stdout + none.stderr);
  for (const role of LABEL_ROLES) assert.match(none.stderr, new RegExp(`${role}: uncovered; answer ${role}=<label>, or pass --accept-suggestions to take "${role}"`));
  assert.deepEqual(g.calls(), [LIST]);

  const some = setRun(ws, g, "--create", "needs-triage=a");
  assert.equal(some.status, 1, some.stdout + some.stderr);
  assert.match(some.stderr, /needs-info: uncovered/);
  assert.doesNotMatch(some.stderr, /needs-triage: /);
  assert.deepEqual(g.calls(), [LIST, LIST]);
  noCache(ws);
});

test("set --accept-suggestions refuses a gone role as uncovered, it having no suggestion; a pair for it settles it", () => {
  const ws = repo();
  const rows = Object.fromEntries(FIVE.map((r) => [r, r === "ready-for-agent" ? "agent-ready" : r]));
  writeTable(ws, fiveRows({ "ready-for-agent": "agent-ready" }));
  seedFrom(ws, { roles: { "ready-for-agent": "agent-ready" }, origin: { "ready-for-agent": "table" }, rows });
  const before = readFileSync(join(ws, ".fleet", LABEL_MAP_FILE), "utf8");
  const g = setRig(without(LABEL_ROLES, "ready-for-agent"));
  const refused = setRun(ws, g, "--accept-suggestions", "--create");
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /ready-for-agent: uncovered, and it has no suggestion \(its label "agent-ready" is gone from the tracker\); answer ready-for-agent=<label>/);
  assert.deepEqual(g.calls(), [LIST]);
  assert.equal(readFileSync(join(ws, ".fleet", LABEL_MAP_FILE), "utf8"), before);

  const answered = setRun(ws, g, "--accept-suggestions", "--create", "ready-for-agent=agent-ready");
  assert.equal(answered.status, 0, answered.stdout + answered.stderr);
  assert.deepEqual(g.calls().slice(1), [LIST, ...created("agent-ready"), LIST]);
  assert.equal(cacheOf(ws).roles["ready-for-agent"], "agent-ready");
  assert.equal(cacheOf(ws).origin["ready-for-agent"], "maintainer");
  ensureThenReads(ws, g);
});

test("set case rule: a pair differing from the live label only in case stores the live spelling and creates nothing", () => {
  const ws = repo();
  const g = setRig(LABEL_ROLES);
  const r = setRun(ws, g, "--create", "ready-for-agent=READY-FOR-AGENT");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), identity());
  assert.deepEqual(g.calls(), [LIST]);
  assert.equal(cacheOf(ws).roles["ready-for-agent"], "ready-for-agent");
  assert.equal(cacheOf(ws).origin["ready-for-agent"], "maintainer");
});

test("set case rule: a label create answered 'already exists' for a case variant counts as existing, and the live list read again gives the spelling stored", () => {
  const ws = repo();
  const g = setRig(without(LABEL_ROLES, "ready-for-agent"), {
    create: (names) => `echo 'label with name "agent-ready" already exists; use \`--force\` to update its color and description' >&2; printf '%s\\n' Agent-Ready >> "${names}"; exit 1`,
  });
  const r = setRun(ws, g, "--create", "ready-for-agent=agent-ready");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(g.calls(), [LIST, ...created("agent-ready"), LIST]);
  assert.deepEqual(JSON.parse(r.stdout), { ...identity(), "ready-for-agent": "Agent-Ready" });
  assert.equal(cacheOf(ws).roles["ready-for-agent"], "Agent-Ready");
  assert.deepEqual(ensureThenReads(ws, g), { ...identity(), "ready-for-agent": "Agent-Ready" });
});

test("set case rule: an 'Already exists' answer in capitals on stdout counts as existing too", () => {
  const ws = repo();
  const g = setRig(without(LABEL_ROLES, "ready-for-agent"), {
    create: (names) => `echo 'Label "agent-ready" Already Exists'; printf '%s\\n' Agent-Ready >> "${names}"; exit 1`,
  });
  const r = setRun(ws, g, "--create", "ready-for-agent=agent-ready");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(g.calls(), [LIST, ...created("agent-ready"), LIST]);
  assert.equal(cacheOf(ws).roles["ready-for-agent"], "Agent-Ready");
});

test("set: a label create that fails for another reason is exit 2 naming the labels created before it; nothing is written", () => {
  const ws = repo();
  const g = setRig(without(LABEL_ROLES, "needs-info", "onhold"), {
    create: (names) => `shift 2; if [ "$1" = onhold ]; then echo "gh: HTTP 403" >&2; exit 1; fi; printf '%s\\n' "$1" >> "${names}"`,
  });
  const r = setRun(ws, g, "--accept-suggestions", "--create");
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /gh label create "onhold" failed: gh: HTTP 403; created before it: "needs-info"; nothing written/);
  assert.deepEqual(g.calls(), [LIST, ...created("needs-info", "onhold")]);
  noCache(ws);
});

test("set: a gh killed by a signal while creating is exit 2 naming the labels created before it; nothing is written", () => {
  const ws = repo();
  const g = setRig(without(LABEL_ROLES, "needs-info", "onhold"), {
    create: (names) => `shift 2; if [ "$1" = onhold ]; then kill -TERM $$; fi; printf '%s\\n' "$1" >> "${names}"`,
  });
  const r = setRun(ws, g, "--accept-suggestions", "--create");
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /gh was killed by SIGTERM creating "onhold"; created before it: "needs-info"; nothing written/);
  assert.deepEqual(g.calls(), [LIST, ...created("needs-info", "onhold")]);
  noCache(ws);
});

test("set: a gh that cannot be run for a create is exit 2 naming the labels created before it; nothing is written", () => {
  const ws = repo();
  // The stub removes itself after the first create, and PATH holds only its
  // directory, so the next create finds no gh at all.
  const g = setRig(without(LABEL_ROLES, "needs-info", "onhold"), {
    create: (names) => `shift 2; printf '%s\\n' "$1" >> "${names}"; rm -f "$0"`,
  });
  const bin = g.env.PATH.split(":")[0];
  for (const tool of ["git", "rm"]) {
    symlinkSync(spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim(), join(bin, tool));
  }
  const r = spawnSync(process.execPath, [SCRIPT, "set", "--accept-suggestions", "--create"], { cwd: ws, env: { ...g.env, PATH: bin }, encoding: "utf8" });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /could not run gh: .*ENOENT; created before it: "needs-info"; nothing written/);
  assert.deepEqual(g.calls(), [LIST, ...created("needs-info")]);
  noCache(ws);
});

test("set: a label create that answers success but leaves the label out of the list read again is exit 2, nothing written", () => {
  const ws = repo();
  const g = setRig(without(LABEL_ROLES, "onhold"), { create: () => "exit 0" });
  const r = setRun(ws, g, "--accept-suggestions", "--create");
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /onhold: "onhold" is not in the tracker's label list after gh label create; created: "onhold"; nothing written/);
  noCache(ws);
});

test("set: the label list read again failing after a create is exit 2 naming the labels created; nothing written", () => {
  const ws = repo();
  const g = setRig(without(LABEL_ROLES, "onhold"), {
    create: (names) => `shift 2; printf '%s\\n' "$1" >> "${names}"; : > "${names}.made"`,
    list: (names, listing) => `if [ -e "${names}.made" ]; then echo "gh: HTTP 502" >&2; exit 1; fi; ${listing}`,
  });
  const r = setRun(ws, g, "--accept-suggestions", "--create");
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /gh label list failed: gh: HTTP 502; created: "onhold"; nothing written/);
  assert.deepEqual(g.calls(), [LIST, ...created("onhold"), LIST]);
  noCache(ws);
});

test("set: a Label map that cannot be written is exit 2 naming the labels created, the cache untouched", (t) => {
  if (process.getuid?.() === 0) return t.skip("root writes every directory");
  const ws = repo();
  const fleet = join(ws, ".fleet");
  mkdirSync(fleet);
  chmodSync(fleet, 0o555);
  const g = setRig(without(LABEL_ROLES, "onhold"));
  let r;
  try {
    r = setRun(ws, g, "--accept-suggestions", "--create");
  } finally {
    chmodSync(fleet, 0o755);
  }
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /cannot write the Label map: EACCES\b.*; created: "onhold"\n/);
  assert.deepEqual(readdirSync(fleet), []);
});

test("set run from a subdirectory creates the labels at the repository's top", () => {
  const ws = repo();
  const sub = join(ws, "sub", "dir");
  mkdirSync(sub, { recursive: true });
  let where;
  const g = setRig(without(LABEL_ROLES, "onhold"), {
    create: (names) => {
      where = `${names}.pwd`;
      return `pwd -P >> "${where}"; shift 2; printf '%s\\n' "$1" >> "${names}"`;
    },
  });
  const r = setRun(sub, g, "--accept-suggestions", "--create");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(g.calls(), [LIST, ...created("onhold"), LIST]);
  assert.equal(readFileSync(where, "utf8"), `${ws}\n`);
  assert.deepEqual(cacheOf(ws).roles, identity());
});

test("set needs-triage=triage clears the break a ready-for-human row naming needs-triage causes: the map is written and ensure then exits 0; a break left standing is exit 1", () => {
  const live = [...without(LABEL_ROLES, "ready-for-human"), "triage"];
  const ws = repo();
  writeTable(ws, wrongRows());
  const g = setRig(live);
  const first = ensureRun(ws, g);
  assert.equal(first.status, 1, first.stdout + first.stderr);

  const r = setRun(ws, g, "needs-triage=triage");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const expected = { ...identity(), "ready-for-human": "needs-triage", "needs-triage": "triage" };
  assert.deepEqual(JSON.parse(r.stdout), expected);
  assert.deepEqual(cacheOf(ws).roles, expected);
  assert.equal(cacheOf(ws).origin["needs-triage"], "maintainer");
  assert.equal(cacheOf(ws).origin["ready-for-human"], "table");
  assert.deepEqual(ensureThenReads(ws, g), expected);

  const ws2 = repo();
  writeTable(ws2, wrongRows());
  const g2 = setRig(live);
  const left = setRun(ws2, g2, "--accept-suggestions", "--create", "needs-info=needs-info");
  assert.equal(left.status, 1, left.stdout + left.stderr);
  assert.match(left.stderr, /ready-for-human: its row names "needs-triage"/);
  assert.match(left.stderr, /set needs-triage=<label>/);
  assert.deepEqual(g2.calls(), [LIST]);
  noCache(ws2);
});

test("set: a pair for a role beats that role's table row, and the answer carries over the next ensure; a table edit to another role's row keeps it", () => {
  const ws = repo();
  writeTable(ws, [["ready-for-agent", "agent-ready"]]);
  const g = setRig([...LABEL_ROLES, "agent-ready", "ready"]);
  const r = setRun(ws, g, "ready-for-agent=ready");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(g.calls(), [LIST]);
  assert.equal(cacheOf(ws).roles["ready-for-agent"], "ready");
  assert.equal(cacheOf(ws).origin["ready-for-agent"], "maintainer");
  assert.equal(ensureThenReads(ws, g)["ready-for-agent"], "ready");

  const ws2 = repo();
  const g2 = setRig([...LABEL_ROLES, "on-hold"]);
  assert.equal(setRun(ws2, g2, "onhold=on-hold").status, 0);
  writeTable(ws2, [["needs-info", "needs-info"]]);
  const map = ensureThenReads(ws2, g2);
  assert.equal(map.onhold, "on-hold");
  assert.equal(cacheOf(ws2).origin.onhold, "maintainer");
});

test("set --accept-suggestions takes a near match that exists as it is: no label created, origin maintainer", () => {
  const ws = repo();
  const g = setRig([...without(LABEL_ROLES, "onhold"), "on-hold"]);
  const r = setRun(ws, g, "--accept-suggestions");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(g.calls(), [LIST]);
  assert.equal(cacheOf(ws).roles.onhold, "on-hold");
  assert.equal(cacheOf(ws).origin.onhold, "maintainer");
});

test("set with nothing uncertain and no flag writes the derived map, origin default for every role", () => {
  const ws = repo();
  const g = setRig(LABEL_ROLES);
  const r = setRun(ws, g);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), identity());
  assert.deepEqual(Object.values(cacheOf(ws).origin), LABEL_ROLES.map(() => "default"));
  assert.deepEqual(g.calls(), [LIST]);
});

test("set accepts what D8 allows: exactly 50 characters, spaces and punctuation, and a leading dash passed after `--`", () => {
  const ws = repo();
  const g = setRig(LABEL_ROLES);
  const fifty = "y".repeat(50);
  const r = setRun(ws, g, "--create", "needs-info=Needs Info: waiting", `ready-for-agent=${fifty}`, "onhold=-paused");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { ...identity(), "needs-info": "Needs Info: waiting", "ready-for-agent": fifty, onhold: "-paused" });
  assert.deepEqual(g.calls(), [LIST, "label create Needs Info: waiting", `label create ${fifty}`, "label create -- -paused", LIST]);
});

test("set: an ambient GH_REPO does not move the label create; gh is run with GH_REPO empty", () => {
  const ws = repo();
  const g = setRig([]);
  const r = spawnSync(process.execPath, [SCRIPT, "set", "--accept-suggestions", "--create"], { cwd: ws, env: { ...g.env, GH_REPO: "other/repo" }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(g.repos(), LABEL_ROLES.flatMap(() => ["[]"]).concat(["[]", "[]"]));
});

test("set: gh failing, no repository or an unreadable cache is exit 2, nothing written", (t) => {
  const ws = repo();
  const failing = rig(LABEL_ROLES, { fail: true });
  const r = setRun(ws, failing, "--accept-suggestions", "--create");
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /gh label list failed: gh: boom/);
  assert.deepEqual(failing.calls(), [LIST]);
  noCache(ws);

  const dir = realpathSync(tempDir("label-map-norepo-"));
  const g = setRig(LABEL_ROLES);
  const norepo = setRun(dir, g, "--accept-suggestions");
  assert.equal(norepo.status, 2, norepo.stdout + norepo.stderr);
  assert.deepEqual(g.calls(), []);

  if (process.getuid?.() === 0) return t.skip("root reads every file");
  const ws3 = repo();
  const file = seedLabelMap(ws3, { roles: { "in-progress": "mine" }, origin: { "in-progress": "maintainer" } });
  const bytes = readFileSync(file, "utf8");
  chmodSync(file, 0o000);
  let unreadable;
  try {
    unreadable = setRun(ws3, setRig([...LABEL_ROLES, "mine"]), "--accept-suggestions");
  } finally {
    chmodSync(file, 0o600);
  }
  assert.equal(unreadable.status, 2, unreadable.stdout + unreadable.stderr);
  assert.match(unreadable.stderr, unreadableDerivation("EACCES"));
  assert.equal(readFileSync(file, "utf8"), bytes);
});

// `ensure` and `set` refuse every cache that exists and cannot be read with
// the reader's own refusal — the resolved path, the errno, the filesystem
// fault and its repair — then `nothing written`, before any label is created.
for (const [name, code, leave] of UNREADABLE) {
  for (const verb of ["ensure", "set"]) {
    test(`${verb} refuses ${name}: exit 2, naming the cache path, ${code} as a filesystem fault and its repair; nothing written`, (t) => {
      if (code === "EACCES" && process.getuid?.() === 0) return t.skip("root reads every file");
      const ws = repo();
      leave(ws);
      const g = setRig([...LABEL_ROLES]);
      const r = verb === "ensure" ? ensureRun(ws, g) : setRun(ws, g, "--accept-suggestions", "--create");
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.equal(r.stdout, "");
      assert.match(r.stderr, unreadableDerivation(code));
      assert.ok(r.stderr.includes(join(ws, ".fleet", LABEL_MAP_FILE)), r.stderr);
      assert.doesNotMatch(r.stderr, /undefined/);
      assert.deepEqual(g.calls(), [LIST]);
      if (code === "EISDIR") assert.deepEqual(readdirSync(join(ws, ".fleet", LABEL_MAP_FILE)), []);
    });
  }
}

test("set: a pair naming the string another role's cached answer holds drops that answer, and the role is asked again like a table row claiming it", () => {
  const ws = repo();
  seedFrom(ws, { roles: { onhold: "paused" }, origin: { onhold: "maintainer" } });
  const live = [...LABEL_ROLES, "paused"];
  const g = setRig(live);
  const refused = setRun(ws, g, "wontfix=paused");
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /onhold: uncovered; answer onhold=<label>, or pass --accept-suggestions to take "onhold"/);

  const r = setRun(ws, g, "--accept-suggestions", "wontfix=paused");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { ...identity(), wontfix: "paused" });
  assert.equal(cacheOf(ws).origin.onhold, "maintainer");
});
