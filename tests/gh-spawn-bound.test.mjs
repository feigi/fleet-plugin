// #4431. Every `gh` a script in plugin/scripts/ spawns carries a finite
// timeout, so a GitHub call that stalls is a failed read on that script's own
// failure path, never a caller that hangs until someone kills the pid by hand.
// The suites of the scripts #4431 bounded drive each bound against a `gh` stub
// that sleeps past it; this sweep pins the next spawn, the one no suite drives.
//
// A `gh` spawn is a call that names "gh" as its command, to a node:child_process
// function or to a FUNNEL: a function, here or in a module it imports, that
// hands one of its own parameters on as the command of another such call
// (ci-state.mjs's spawn()/run()/runJson()/tryRun(), board-common.mjs's
// execRead(), board-gather.mjs's tryRun(), diff-stats.mjs's run()). The
// spawn is bounded when its own arguments carry a `timeout`/`timeoutMs` — a
// key, a shorthand, or an options object declared in the same file that
// carries one — or when the funnel it goes through bounds every call it makes.
// A `timeout` of 0, null, undefined or Infinity is no bound.
//
// Read on each file with its comments blanked, so a bound written in a comment
// is no bound, and with string and regex bodies blanked for the bracket
// matching, so a `)` inside a string closes nothing. A child_process reach
// this cannot follow — a namespace import, a `require`, a dynamic import — and
// an unbounded spawn of a command it cannot tell from "gh" fail the sweep by
// name rather than passing it unread.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ghBudget } from "../plugin/scripts/arg.mjs";

const SCRIPTS = fileURLToPath(new URL("../plugin/scripts/", import.meta.url));

// Two views of `src`, both offset-aligned with it: `code` with every comment
// blanked, `skel` with string, template and regex bodies blanked as well.
// Newlines survive in both, so a line number read off either is the file's.
function lex(src) {
  const code = src.split("");
  const skel = src.split("");
  const blank = (arr, a, b) => { for (let k = a; k < b; k++) if (arr[k] !== "\n") arr[k] = " "; };
  let i = 0;
  let prev = "";
  let depth = 0;
  const templates = [];
  // A `/` opens a regex where an operand is due: after an operator or an
  // opening bracket, at the start, or after a keyword that takes one.
  const regexAllowed = () => prev === "" || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev)
    || /(?:^|[^\w$])(?:return|typeof|case|of|in|void|yield|await)$/.test(src.slice(Math.max(0, i - 8), i).trimEnd());
  const template = () => {
    let j = i;
    while (j < src.length) {
      if (src[j] === "\\") { j += 2; continue; }
      if (src[j] === "`") { blank(skel, i, j); i = j + 1; prev = "`"; return; }
      if (src[j] === "$" && src[j + 1] === "{") { blank(skel, i, j); templates.push(depth); depth++; i = j + 2; prev = "{"; return; }
      j++;
    }
    throw new Error("unterminated template literal");
  };
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      const end = nl < 0 ? src.length : nl;
      blank(code, i, end); blank(skel, i, end); i = end;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2) + 2;
      blank(code, i, end); blank(skel, i, end); i = end;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      blank(skel, i + 1, j); i = j + 1; prev = c;
    } else if (c === "`") {
      i++; template();
    } else if (c === "/" && regexAllowed()) {
      let j = i + 1;
      let cls = false;
      while (j < src.length && (cls || src[j] !== "/")) {
        if (src[j] === "\\") j++;
        else if (src[j] === "[") cls = true;
        else if (src[j] === "]") cls = false;
        j++;
      }
      blank(skel, i + 1, j); i = j + 1; prev = "/";
    } else {
      if (c === "{") depth++;
      if (c === "}") {
        depth--;
        if (templates.at(-1) === depth) { templates.pop(); i++; template(); continue; }
      }
      if (!/\s/.test(c)) prev = c;
      i++;
    }
  }
  return { code: code.join(""), skel: skel.join("") };
}

const OPEN = "([{";
const CLOSE = ")]}";

function closing(skel, open) {
  let d = 0;
  for (let k = open; k < skel.length; k++) {
    if (OPEN.includes(skel[k])) d++;
    else if (CLOSE.includes(skel[k]) && --d === 0) return k;
  }
  throw new Error(`unbalanced bracket at offset ${open}`);
}

// The top-level comma-separated pieces of the bracket pair opening at `open`,
// each in both views: `code` to read a command off, `skel` to look for a bound
// in, where a `timeout:` inside a string is no bound.
function pieces(skel, code, open) {
  const close = closing(skel, open);
  const out = [];
  const piece = (a, b) => ({ code: code.slice(a, b).trim(), skel: skel.slice(a, b).trim() });
  let d = 0;
  let from = open + 1;
  for (let k = open + 1; k < close; k++) {
    if (OPEN.includes(skel[k])) d++;
    else if (CLOSE.includes(skel[k])) d--;
    else if (skel[k] === "," && d === 0) { out.push(piece(from, k)); from = k + 1; }
  }
  const last = piece(from, close);
  if (last.code !== "") out.push(last);
  return out;
}

// A `timeout` that can bound something: a key with any value but the four that
// bound nothing, or a shorthand property.
const BOUND = /(?:^|[{,\s])timeout(?:Ms)?\s*(?::\s*(?!(?:0|null|undefined|Infinity)\s*[,}]|0\s*$)\S|[,}]|$)/;

// What a source file offers the sweep: its child_process names, its functions
// and the funnels among them.
function analyse(src, file) {
  const { code, skel } = lex(src);
  const problems = [];
  const starts = [...code.matchAll(/\n/g)].map((m) => m.index);
  const lineOf = (i) => { let n = 0; while (n < starts.length && starts[n] < i) n++; return n + 1; };

  const primitives = new Set();
  for (const m of code.matchAll(/\bchild_process\b/g)) {
    const stmt = code.slice(code.lastIndexOf("\n", m.index) + 1, code.indexOf("\n", m.index));
    const named = stmt.match(/^import\s*\{([^}]*)\}\s*from\s*["']node:child_process["'];?\s*$/);
    if (!named) { problems.push(`${file}:${lineOf(m.index)} reaches child_process in a form this sweep cannot follow`); continue; }
    for (const spec of named[1].split(",").map((s) => s.trim()).filter(Boolean)) primitives.add(spec.split(/\s+as\s+/).at(-1));
  }

  const imports = new Map();
  for (const m of code.matchAll(/^import\s*\{([^}]*)\}\s*from\s*["'](\.\/[^"']+\.mjs)["']/gm)) {
    for (const spec of m[1].split(",").map((s) => s.trim()).filter(Boolean)) {
      const [orig, local = orig] = spec.split(/\s+as\s+/);
      imports.set(local, { module: m[2], name: orig });
    }
  }

  // Every named function: `function f(…) {…}` and `const f = (…) => …`.
  const fns = new Map();
  const add = (name, paramsOpen, bodyFrom) => {
    const params = pieces(skel, code, paramsOpen).map((p) => p.code.replace(/=.*$/s, "").trim());
    let start = bodyFrom;
    while (/\s/.test(skel[start])) start++;
    let end;
    if (skel[start] === "{") end = closing(skel, start);
    else {
      let d = 0;
      for (end = start; end < skel.length; end++) {
        if (OPEN.includes(skel[end])) d++;
        else if (CLOSE.includes(skel[end])) { if (d === 0) break; d--; }
        else if (d === 0 && skel[end] === ";") break;
      }
    }
    fns.set(name, { params, start, end });
  };
  for (const m of skel.matchAll(/\bfunction\s+([\w$]+)\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    add(m[1], open, closing(skel, open) + 1);
  }
  for (const m of skel.matchAll(/\b(?:const|let)\s+([\w$]+)\s*=\s*(?:async\s*)?\(/g)) {
    const open = m.index + m[0].length - 1;
    const after = closing(skel, open) + 1;
    const arrow = skel.slice(after).match(/^\s*=>/);
    if (arrow) add(m[1], open, after + arrow[0].length);
  }

  // Every call whose callee is named: offset, callee, its arguments.
  const calls = [];
  for (const m of skel.matchAll(/(?<![\w$.])([\w$]+)\s*\(/g)) {
    if (/\bfunction\s*$/.test(skel.slice(Math.max(0, m.index - 12), m.index))) continue;
    const open = m.index + m[0].length - 1;
    calls.push({ at: m.index, callee: m[1], args: pieces(skel, code, open), line: lineOf(m.index) });
  }

  // A call carries a bound when an argument other than its command names one
  // inline, or is an identifier (bare or spread) declared in this file as an
  // object that carries one.
  const declared = (id) => {
    for (const m of skel.matchAll(new RegExp(`\\b(?:const|let)\\s+${id.replace(/\$/g, "\\$")}\\s*=\\s*\\{`, "g"))) {
      const open = m.index + m[0].length - 1;
      if (BOUND.test(skel.slice(open, closing(skel, open) + 1))) return true;
    }
    return false;
  };
  const carries = (c, cmdAt) => c.args.some(({ skel: a }, i) => i !== cmdAt
    && (BOUND.test(a) || [...a.matchAll(/(?:^|\.\.\.)([\w$]+)/g)].some((m) => declared(m[1]))));

  const within = (at) => [...fns.values()].filter((f) => f.start <= at && at <= f.end).sort((x, y) => x.start - y.start).at(-1);

  // The values a `for (const id of …)` loop can give `id`, when its iterable is
  // string literals in array brackets and nothing else but a platform test;
  // null for any other binding.
  const loopLiterals = (id) => {
    const m = skel.match(new RegExp(`\\bfor\\s*\\(\\s*(?:const|let)\\s+${id.replace(/\$/g, "\\$")}\\s+of\\b`));
    if (!m) return null;
    const open = skel.indexOf("(", m.index);
    const from = m.index + m[0].length;
    const iterable = code.slice(from, closing(skel, open));
    const str = /(["'])((?:\\.|(?!\1).)*)\1/g;
    const rest = iterable.replace(str, "").replace(/process\.platform|[=!]==|[?:[\],\s]/g, "");
    const values = [...iterable.matchAll(str)].map((s) => s[2]);
    return rest === "" && values.length > 0 ? values : null;
  };

  return { file, primitives, imports, fns, calls, carries, within, loopLiterals, problems };
}

// Whole-directory sweep: every gh spawn, and whether it is bounded.
function sweep(sources) {
  const mods = new Map(Object.entries(sources).map(([file, src]) => [file, analyse(src, file)]));
  const problems = [...mods.values()].flatMap((m) => m.problems);
  const resolve = (mod, name) => {
    if (mod.fns.has(name)) return { mod, name };
    const imp = mod.imports.get(name);
    const target = imp && mods.get(imp.module.slice(2));
    return target?.fns.has(imp.name) ? { mod: target, name: imp.name } : null;
  };
  // A funnel's verdict: null when the function is no funnel, else which of its
  // parameters it hands on as a command, and whether every call it hands that
  // command to is bounded.
  const memo = new Map();
  const funnel = (mod, name) => {
    const key = `${mod.file}#${name}`;
    if (memo.has(key)) return memo.get(key);
    memo.set(key, null);
    const f = mod.fns.get(name);
    let verdict = null;
    for (const c of mod.calls) {
      if (c.at < f.start || c.at > f.end) continue;
      const inner = spawner(mod, c);
      const index = inner === null ? -1 : f.params.indexOf(c.args[inner.index]?.code);
      if (index < 0) continue;
      verdict = { index: verdict?.index ?? index, bounded: (verdict?.bounded ?? true) && inner.bounded };
    }
    memo.set(key, verdict);
    return verdict;
  };
  // For a call: null when it spawns nothing, else which argument is its
  // command, and whether it is bounded.
  const spawner = (mod, c) => {
    if (mod.primitives.has(c.callee)) return { index: 0, bounded: mod.carries(c, 0) };
    const target = resolve(mod, c.callee);
    const v = target === null ? null : funnel(target.mod, target.name);
    return v === null ? null : { index: v.index, bounded: v.bounded || mod.carries(c, v.index) };
  };

  const spawns = [];
  for (const mod of mods.values()) {
    for (const c of mod.calls) {
      const spawn = spawner(mod, c);
      if (spawn === null) continue;
      const cmd = c.args[spawn.index]?.code ?? "";
      const where = `${mod.file}:${c.line}`;
      if (/^["']gh["']$/.test(cmd)) {
        spawns.push({ where, bounded: spawn.bounded });
      } else if (/^(["'])[^"']*\1$/.test(cmd) || cmd === "process.execPath" || /^join\(/.test(cmd)) {
        continue;
      } else {
        // Any other command is bounded here whatever it names, or is a
        // funnel's own parameter, whose callers are what is swept, or is drawn
        // from a loop over string literals none of which is gh.
        if (spawn.bounded) continue;
        if (mod.within(c.at)?.params.includes(cmd)) continue;
        const values = /^[\w$]+$/.test(cmd) ? mod.loopLiterals(cmd) : null;
        if (values !== null && !values.includes("gh")) continue;
        problems.push(`${where} spawns \`${cmd}\`, a command this sweep cannot tell from gh, with no bound`);
      }
    }
  }
  return { spawns, problems };
}

function readScripts() {
  return Object.fromEntries(readdirSync(SCRIPTS).filter((n) => n.endsWith(".mjs")).sort().map((n) => [n, readFileSync(join(SCRIPTS, n), "utf8")]));
}

test("every gh spawn in plugin/scripts/*.mjs carries a finite timeout", () => {
  const { spawns, problems } = sweep(readScripts());
  assert.deepEqual(problems, []);
  // Not vacuous: each script #4431 bounded is one the sweep reaches, through
  // its own spawn shape — a direct call, ci-state's spawn() funnel,
  // diff-stats's run(), board-gather's tryRun() and execRead().
  const files = new Set(spawns.map((s) => s.where.split(":")[0]));
  for (const f of ["ci-state.mjs", "candidates.mjs", "finisher-label.mjs", "labelled-head.mjs", "merge-gate.mjs",
    "pr-cost.mjs", "diff-stats.mjs", "board-gather.mjs", "fleet-tick.mjs", "ticketless.mjs", "gh-aliased-read.mjs"]) {
    assert.ok(files.has(f), `the sweep found no gh spawn in ${f}`);
  }
  assert.deepEqual(spawns.filter((s) => !s.bounded).map((s) => s.where), []);
});

// A script's gh bound is overridable only through ghBudget(), which can only
// shorten it: every `process.env.*_GH_TIMEOUT` read is ghBudget()'s second
// argument and nothing else, and each script #4431 bounded declares its bound
// that way.
test("no environment variable can lengthen a script's gh bound", () => {
  const scripts = readScripts();
  const declared = new Set();
  for (const [file, src] of Object.entries(scripts)) {
    const { code } = lex(src);
    for (const m of code.matchAll(/process\.env\.([A-Z_]*_GH_TIMEOUT)\b/g)) {
      const line = code.slice(code.lastIndexOf("\n", m.index) + 1, code.indexOf("\n", m.index));
      assert.match(line, new RegExp(`^const GH_TIMEOUT_MS = ghBudget\\(\\d+, process\\.env\\.${m[1]}\\);$`), `${file}: ${line.trim()}`);
      declared.add(file);
    }
  }
  for (const f of ["ci-state.mjs", "candidates.mjs", "finisher-label.mjs", "labelled-head.mjs", "merge-gate.mjs", "pr-cost.mjs", "diff-stats.mjs", "board-gather.mjs"]) {
    assert.ok(declared.has(f), `${f} declares no ghBudget() bound`);
  }
});

// What the sweep must refuse, each the shape a new unbounded spawn would take,
// and what it must accept, each a bound shape already in the repository.
const MOD = (body, imports = "spawnSync, execFileSync") => `import { ${imports} } from "node:child_process";\n${body}\n`;
const verdicts = (sources) => sweep(sources).spawns.map((s) => s.bounded);

test("the sweep refuses an unbounded gh spawn in each shape it follows", () => {
  const refused = {
    direct: MOD(`const r = spawnSync("gh", ["pr", "view"], { encoding: "utf8" });`),
    "no options": MOD(`execFileSync("gh", ["pr", "view"]);`),
    "timeout in a comment": MOD(`spawnSync("gh", ["x"], { encoding: "utf8" /* timeout: 5 */ });\n// timeout: GH_TIMEOUT_MS`),
    "zero timeout": MOD(`spawnSync("gh", ["x"], { timeout: 0 });`),
    "undefined timeout": MOD(`spawnSync("gh", ["x"], { timeout: undefined, encoding: "utf8" });`),
    "Infinity timeout": MOD(`spawnSync("gh", ["x"], { timeout: Infinity });`),
    "timeout in a string": MOD(`spawnSync("gh", ["timeout: 5"], { encoding: "utf8" });`),
    "unbounded funnel": MOD(`function run(cmd, args) { return execFileSync(cmd, args, { encoding: "utf8" }); }\nrun("gh", ["pr", "view"]);`),
    "funnel of a funnel": MOD(`function spawn(cmd, args) { return execFileSync(cmd, args, {}); }\nfunction run(cmd, args) { return spawn(cmd, args); }\nrun("gh", ["x"]);`),
    "arrow funnel": MOD(`const run = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8" });\nrun("gh", ["x"]);`),
    "options object without one": MOD(`const OPTS = { encoding: "utf8" };\nspawnSync("gh", ["x"], OPTS);`),
    "spread options without one": MOD(`const CHILD = { encoding: "utf8" };\nspawnSync("gh", ["x"], { ...CHILD });`),
  };
  for (const [name, src] of Object.entries(refused)) assert.deepEqual(verdicts({ "x.mjs": src }), [false], name);
  const imported = {
    "common.mjs": MOD(`export function execRead(cmd, args, opts = {}) { return execFile(cmd, args, { ...opts }); }`, "execFile"),
    "x.mjs": `import { execRead } from "./common.mjs";\nawait execRead("gh", ["x"]);\n`,
  };
  assert.deepEqual(verdicts(imported), [false], "an imported funnel that forwards no bound");
});

test("the sweep accepts the bound shapes already in the repository", () => {
  const accepted = {
    "named constant": MOD(`const GH_TIMEOUT_MS = 20_000;\nspawnSync("gh", ["x"], { encoding: "utf8", timeout: GH_TIMEOUT_MS });`),
    literal: MOD(`execFileSync("gh", ["x"], { encoding: "utf8", timeout: 60_000 });`),
    "timeoutMs parameter": MOD(`export function read(n, { timeoutMs }) { return spawnSync("gh", ["x"], { timeout: timeoutMs }); }`),
    shorthand: MOD(`function f(timeout) { return spawnSync("gh", ["x"], { encoding: "utf8", timeout }); }`),
    "options object with one": MOD(`function f() { const opts = { encoding: "utf8", timeout: READ_TIMEOUT_MS };\nreturn execFileSync("gh", ["x"], opts); }`),
    "spread plus a bound": MOD(`const CHILD = { encoding: "utf8" };\nspawnSync("gh", ["x"], { ...CHILD, timeout: 30_000 });`),
    "bounded funnel": MOD(`function spawn(cmd, args) { return execFileSync(cmd, args, { timeout: T }); }\nfunction run(cmd, args) { return spawn(cmd, args); }\nrun(\n  "gh",\n  ["x"],\n);`),
    "funnel bounded at the call": MOD(`async function tryRun(cmd, args, opts = {}) { return execFile(cmd, args, { ...opts }); }\nawait tryRun("gh", ["x"], { timeout: T });`, "execFile"),
  };
  for (const [name, src] of Object.entries(accepted)) assert.deepEqual(verdicts({ "x.mjs": src }), [true], name);
  // Not gh, so nothing to bound: a sibling script, node itself, git, a funnel
  // only ever handed another command.
  const notGh = MOD(`spawnSync(process.execPath, [join(SCRIPT_DIR, "x.mjs")]);\nspawnSync("git", ["status"]);\nspawnSync(join(SCRIPT_DIR, "x.sh"));\nfunction run(cmd, a) { return spawnSync(cmd, a); }\nrun("sh", ["y"]);`);
  assert.deepEqual(sweep({ "x.mjs": notGh }), { spawns: [], problems: [] });
});

test("the sweep names a child_process reach it cannot follow", () => {
  const cases = {
    "namespace import": `import * as cp from "node:child_process";\ncp.spawnSync("gh", ["x"]);\n`,
    "command it cannot tell from gh": MOD(`const GH = "gh";\nspawnSync(GH, ["x"], {});`),
  };
  for (const [name, src] of Object.entries(cases)) assert.equal(sweep({ "x.mjs": src }).problems.length, 1, name);
});

test("ghBudget: the override only ever shortens, and anything but digits leaves the default", () => {
  const cases = [
    [undefined, 20_000], ["", 20_000], ["5", 5_000], ["1", 1_000], ["19", 19_000],
    ["20", 20_000], ["600", 20_000], ["0", 20_000], ["-1", 20_000], ["3.5", 20_000], ["1e1", 20_000], [" 5", 20_000], ["abc", 20_000],
  ];
  for (const [override, ms] of cases) assert.equal(ghBudget(20, override), ms, JSON.stringify(override));
});
