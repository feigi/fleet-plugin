// #4431. Every `gh` a plugin/scripts/*.mjs script spawns carries a finite
// timeout, so a GitHub call that stalls is a failed read on that script's own
// failure path, never a caller that hangs until someone kills the pid by hand.
// The `.sh` scripts beside them are not read here.
// The suites of the scripts #4431 bounded drive each bound against a `gh` stub
// that sleeps past it; this sweep pins the next spawn, the one no suite drives.
//
// A `gh` spawn is a call that names "gh" as its command, to a node:child_process
// function or to a FUNNEL: a function, here or in a module it imports, that
// hands one of its own parameters on as the command of another such call
// (ci-state.mjs's spawn()/run()/runJson()/tryRun(), board-common.mjs's
// execRead(), board-gather.mjs's tryRun(), diff-stats.mjs's run()). So is a
// spawn whose command or argument is a shell line that runs gh — `execSync("gh
// pr view 1")`, `spawnSync("sh", ["-c", "gh pr view 1"])`. The spawn is bounded
// when its own arguments carry a `timeout` key at the top level of an options
// object — written inline, as a shorthand, or in an object declared in the same
// file — or when the funnel it goes through bounds every call it makes. A
// `timeoutMs` key is no bound, since child_process ignores it; neither is a
// `timeout` nested inside another key's value, nor one of 0, null, undefined or
// Infinity, written out or as a constant this file declares as one of them.
//
// Read on each file with its comments blanked, so a bound written in a comment
// is no bound, and with string and regex bodies blanked for the bracket
// matching, so a `)` inside a string closes nothing. A child_process reach
// this cannot follow — a namespace import, a `require`, a dynamic import — and
// an unbounded spawn of a command it cannot tell from "gh" fail the sweep by
// name rather than passing it unread.
//
// #4446, #4460. The bound must also be one the environment cannot lengthen,
// under any variable name: each gh spawn's timeout expression is traced
// (tracer(), below), and the spawn refused when it reaches `process.env`
// other than through arg.mjs's ghBudget() or a Math.min() it can only
// shorten, or reaches a name the tracer cannot resolve. A read that reaches
// no gh timeout (HOME, GH_REPO, `env: { ...process.env }`, a git bound) is
// not looked at. Four rules say what the environment may still do:
//   1. A Math.min() the environment reaches keeps its exemption only with a
//      ceiling: an argument clear of the environment that works out, from
//      literals, + - * / ** and the names the tracer resolves, to a number
//      from 1 to CEILING_CAP (at its largest, when it has several values).
//      A name, or a name's key (`x.key`, `x["key"]`), that a compound
//      assignment, `++` or `--` writes works out to no number.
//   2. Every argument of that Math.min() the environment reaches is floored:
//      each value it can take is a Math.max() with an argument clear of the
//      environment that is at least 1 (at its smallest), since a timeout of
//      0 is no timeout. A floor written around the Math.min() is no floor,
//      and neither is a name that a compound assignment, `++` or `--` writes.
//   3. A member read (x.key, x["key"], x.a.b, x.key(), f().key) is followed,
//      key by key, only into a plain value of the object literals that x, or
//      f's return, resolves to. `this`, a `new` expression, Object.create(),
//      a class, a function and a call the tracer cannot open are refused as
//      receivers; a getter, a setter and a method are refused as the key, and
//      so is a `[…]` holding anything but a string or integer literal.
//   4. Wherever a key is read out of an object (a member read, a gh spawn's
//      own options, an Object.assign() source), the read is refused when the
//      literal holds a computed key, a `__proto__:` entry, or a getter, setter
//      or method of that key; or the object is handed, in parentheses or not,
//      to an Object.* or Reflect.* call other than Object.assign(), the call
//      written as a member or computed; or `__proto__`, `__defineGetter__` or
//      `__defineSetter__` is written or called on it.
//
// #4484. Whatever the environment does, each gh spawn's timeout must also work
// out to a number from 1 to CEILING_CAP: Node reads a timeout of 0 as none,
// and one of 1e12 ms never fires. numbers() is run on every value the
// child_process call's `timeout` can take, once the funnels around it have
// bound their arguments, and the spawn is refused when any value is below 1 or
// above the cap, when a value does not work out to a number, and when there is
// no value at all: a `timeout` left out, or a funnel parameter no call hands
// one. Failing closed, as rule 1 does for a ceiling, refuses a value
// numbers() cannot reduce, such as a ternary, whatever it chooses between.
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
const BOUND = /(?:^|[{,\s])timeout\s*(?::\s*(?!(?:0|null|undefined|Infinity)\s*[,}]|0\s*$)(\S[^,}]*)|[,}]|$)/;

// `s` with everything nested inside its own outermost brackets blanked, so a
// key read off it is a top-level key of the object `s` opens.
function topLevel(s) {
  let d = 0;
  let out = "";
  for (const ch of s) {
    if (OPEN.includes(ch)) d++;
    out += d <= 1 ? ch : " ";
    if (CLOSE.includes(ch)) d--;
  }
  return out;
}

// Where the expression starting at `from` ends: at a `;`, or at a closing
// bracket that closes nothing opened inside it, or, with `comma`, at a `,`
// between its own pieces.
function exprEnd(skel, from, comma = false) {
  let d = 0;
  let end;
  for (end = from; end < skel.length; end++) {
    if (OPEN.includes(skel[end])) d++;
    else if (CLOSE.includes(skel[end])) { if (d === 0) break; d--; }
    else if (d === 0 && (skel[end] === ";" || (comma && skel[end] === ","))) break;
  }
  return end;
}

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

  // The names an import of node:process binds here, each to what it reads:
  // a default or namespace import to `process`, `env` (renamed or not) to
  // `process.env`.
  const processAliases = new Map();
  for (const m of code.matchAll(/^import\s*([^;"'`]*?)\s*from\s*["'](?:node:)?process["']/gm)) {
    const braces = m[1].match(/\{([^}]*)\}/);
    for (const spec of m[1].replace(/\{[^}]*\}/, "").split(",").map((s) => s.trim()).filter(Boolean)) {
      processAliases.set(spec.replace(/^\*\s*as\s+/, ""), "process");
    }
    for (const spec of (braces?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
      const [orig, local = orig] = spec.split(/\s+as\s+/);
      if (orig === "env") processAliases.set(local, "process.env");
      else if (orig === "default") processAliases.set(local, "process");
    }
  }

  // Every named function: `function f(…) {…}` and `const f = (…) => …`.
  const fns = new Map();
  const add = (name, paramsOpen, bodyFrom) => {
    const paramPieces = pieces(skel, code, paramsOpen);
    const params = paramPieces.map((p) => p.code.replace(/=.*$/s, "").trim());
    let start = bodyFrom;
    while (/\s/.test(skel[start])) start++;
    const end = skel[start] === "{" ? closing(skel, start) : exprEnd(skel, start);
    fns.set(name, { name, params, paramPieces, start, end });
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

  // A `timeout` key at the top level of `s` with a value that can bound
  // something: not an identifier this file declares as one of the four that
  // bound nothing (a shorthand's value is the identifier `timeout`).
  const nothing = (id) => new RegExp(`\\b(?:const|let|var)\\s+${id.replace(/\$/g, "\\$")}\\s*=\\s*(?:0|null|undefined|Infinity)\\s*[;\\n]`).test(skel);
  const bounds = (s) => {
    const m = topLevel(s).match(BOUND);
    if (!m) return false;
    const value = m[1] === undefined ? "timeout" : m[1].trim();
    return !(/^[\w$]+$/.test(value) && nothing(value));
  };

  // A call carries a bound when an argument other than its command names one
  // inline, or is an identifier (bare or spread) declared in this file as an
  // object that carries one.
  const declared = (id) => {
    for (const m of skel.matchAll(new RegExp(`\\b(?:const|let)\\s+${id.replace(/\$/g, "\\$")}\\s*=\\s*\\{`, "g"))) {
      const open = m.index + m[0].length - 1;
      if (bounds(skel.slice(open, closing(skel, open) + 1))) return true;
    }
    return false;
  };
  const carries = (c, cmdAt) => c.args.some(({ skel: a }, i) => i !== cmdAt
    && (bounds(a) || [...topLevel(a).matchAll(/(?:^|\.\.\.)([\w$]+)/g)].some((m) => declared(m[1]))));

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

  // The named functions whose body holds `at`, innermost first.
  const encl = (at) => [...fns.values()].filter((f) => f.start <= at && at <= f.end).sort((x, y) => y.start - x.start);

  // The classes this file declares: `class C` and `const C = class`.
  const classes = new Set([...skel.matchAll(/\bclass\s+([\w$]+)/g)].map((m) => m[1]));
  for (const m of skel.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*=\s*class\b/g)) classes.add(m[1]);

  return { file, code, skel, primitives, imports, processAliases, fns, classes, calls, carries, within, encl, loopLiterals, problems };
}

// The longest, in ms, a Math.min() ceiling may be: rule 1 of the file header.
const CEILING_CAP = 300_000;

// Whether the environment can reach a gh spawn's timeout, decided on the
// expression that supplies it and never on the name of anything it reads.
//
// A bound is lengthened from the environment when `process.env` (dot form,
// bracket form, a bare `process`, `globalThis.process`, or a name an import
// of node:process binds) is reached from the timeout expression: directly,
// through a variable this file declares, assigns (`=`, or a compound `+=`,
// `??=` and the rest) or imports, wherever the read can see that binding,
// through a local helper's return, through a funnel parameter, where every
// value a call hands the funnel is judged the same way, or through an options
// object, a key written into it after its declaration (`opts.timeout = …`,
// `Object.assign(opts, …)`) included. A name none of those resolves — an
// undeclared name, or a parameter of a function handed on as a callback,
// whose calls the sweep cannot see — is refused as unknown, never read as
// clear, and a spread none of those opens is judged whole. Two shapes cannot
// lengthen a bound whatever they read, and are not entered: arg.mjs's
// `ghBudget(defaultSeconds, override)`, imported from ./arg.mjs and not
// declared here, whose `override` only ever shortens it (its first argument
// is still judged), and a `Math.min(…)` that passes rules 1 and 2 of the
// file header, as closeout.mjs's remaining-time budget() does: numbers()
// works its ceiling out, floored() checks each argument the environment
// reaches. A member read goes to keyValues() in read mode, which follows it
// into plain values only and answers rules 3 and 4 with a refusal: a ref
// that carries `refuse`, which judge() reports as its reason.
//
// A value is a "ref": source text in both views, the module it was read in,
// and an offset inside it, from which the functions around it are found.
function tracer(mods, resolve, spawner) {
  const escape = (id) => id.replace(/\$/g, "\\$");
  const refOf = (mod, a, b) => ({ mod, skel: mod.skel.slice(a, b).trim(), code: mod.code.slice(a, b).trim(), at: a });
  const argRef = (mod, c, i) => (c.args[i] === undefined || c.args[i].skel.startsWith("...") ? null
    : { mod, skel: c.args[i].skel, code: c.args[i].code, at: c.at });
  // `s` before and after its first top-level `=`: a pattern and its default.
  const splitDefault = (s, c) => {
    let d = 0;
    for (let k = 0; k < s.length; k++) {
      if (OPEN.includes(s[k])) d++;
      else if (CLOSE.includes(s[k])) d--;
      else if (d === 0 && s[k] === "=" && s[k + 1] !== "=" && s[k + 1] !== ">" && !"=!<>".includes(s[k - 1] ?? "")) {
        return [{ skel: s.slice(0, k).trim(), code: c.slice(0, k).trim() }, { skel: s.slice(k + 1).trim(), code: c.slice(k + 1).trim() }];
      }
    }
    return [{ skel: s.trim(), code: c.trim() }, null];
  };
  // A function's parameters: a name, or a destructured object's keys and the
  // names they are bound to, each with its default.
  const paramsOf = (fn) => fn.parsed ??= fn.paramPieces.map((p, index) => {
    if (p.skel.startsWith("...")) return { index, rest: true };
    const [pat, def] = splitDefault(p.skel, p.code);
    if (!pat.skel.startsWith("{")) return { index, name: pat.code, def };
    const props = pieces(pat.skel, pat.code, 0).filter((q) => !q.skel.startsWith("...")).map((q) => {
      const [target, d] = splitDefault(q.skel, q.code);
      const colon = target.skel.indexOf(":");
      const key = (colon < 0 ? target.code : target.code.slice(0, colon)).trim().replace(/^["']|["']$/g, "");
      return { key, local: colon < 0 ? key : target.code.slice(colon + 1).trim(), def: d };
    });
    return { index, props, def };
  });
  const paramBinding = (fn, id) => {
    for (const p of paramsOf(fn)) {
      if (p.name === id) return { p };
      const prop = p.props?.find((q) => q.local === id);
      if (prop) return { p, prop };
    }
    return null;
  };
  const callersOf = (mod, fn) => [...mods.values()].flatMap((m) => m.calls.flatMap((c) => {
    const t = resolve(m, c.callee);
    return t !== null && t.mod === mod && t.name === fn.name ? [{ mod: m, c }] : [];
  }));
  // What a function returns: its expression body, or each `return`.
  const returnsOf = (mod, fn) => {
    if (mod.skel[fn.start] !== "{") return [refOf(mod, fn.start, fn.end)];
    return [...mod.skel.slice(fn.start, fn.end).matchAll(/\breturn\b/g)].map((m) => {
      const a = fn.start + m.index + m[0].length;
      return refOf(mod, a, exprEnd(mod.skel, a));
    });
  };
  // Every expression this file gives `id` where a read at `at` can see it:
  // `id = …` or a compound `id += …` (a declaration, a reassignment, a
  // destructuring default) and `const { id } = …`; beside one of those, an
  // `id++` or `--id` is a compound write with nothing to read. A declaration
  // binds `id` in the innermost named function holding it, or else in the
  // module, so the read sees the binding of the innermost such scope around
  // it, and an assignment counts where it lands on that binding. `at` of -1
  // reads at module scope.
  const OPERATOR = "(?:[-+*/%&|^]|\\*\\*|<<|>>>?|&&|\\|\\||\\?\\?)";
  const ASSIGN = `${OPERATOR}?=(?![=>])`;
  // What a match of ASSIGN ends in, when it is a compound assignment.
  const COMPOUND = /[-+*/%&|^<>?]=\s*$/;
  // `id++`, `id--`, `++id` or `--id` of the escaped name `e`, never of a
  // member of it.
  const UPDATE = (e) => `(?<![\\w$.])${e}\\s*(?:\\+\\+|--)|(?:\\+\\+|--)\\s*${e}(?![\\w$]|\\s*(?:\\?\\.|\\.|\\[))`;
  const declRefs = (mod, id, at) => {
    const e = escape(id);
    const found = [];
    const forms = [
      [`(?<![\\w$.])${e}\\s*${ASSIGN}\\s*`, "assign"],
      [`\\b(?:const|let|var)\\s*(?:\\{[^{}]*(?<![\\w$.])${e}\\b[^{}]*\\}|\\[[^\\[\\]]*(?<![\\w$.])${e}\\b[^\\[\\]]*\\])\\s*=(?![=>])\\s*`, "destructuring"],
      [UPDATE(e), "update"],
    ];
    for (const [form, kind] of forms) {
      for (const m of mod.skel.matchAll(new RegExp(form, "g"))) {
        const declares = kind === "destructuring" || (kind === "assign" && /\b(?:const|let|var)\s*$/.test(mod.skel.slice(Math.max(0, m.index - 8), m.index)));
        found.push({ m, declares, kind });
      }
    }
    const scopes = new Set(found.filter((f) => f.declares).map((f) => mod.encl(f.m.index)[0] ?? null));
    const scopeOf = (pos) => mod.encl(pos).find((fn) => scopes.has(fn)) ?? null;
    const scope = scopeOf(at);
    const visible = found.filter((f) => scopeOf(f.m.index) === scope);
    const refs = visible.every((f) => f.kind === "update") ? [] : visible.map(({ m, kind }) => {
      if (kind === "update") return { ...refOf(mod, m.index, m.index), compound: true };
      const a = m.index + m[0].length;
      return { ...refOf(mod, a, exprEnd(mod.skel, a, true)), compound: kind === "assign" && COMPOUND.test(m[0]), destructured: kind === "destructuring" };
    });
    return { refs, key: `${mod.file}=${id}@${scope?.start ?? 0}` };
  };
  // Run `visit` on every value `id` can hold where `ref` reads it, once per
  // name along a path so a variable that feeds itself ends the walk; and
  // `unknown` when nothing here resolves `id`, or when it is a parameter of a
  // function this file hands on as a value (a callback), whose calls the sweep
  // cannot see.
  const viaId = (ref, id, bind, seen, visit, unknown) => {
    const { mod } = ref;
    const once = (key, refs) => {
      if (seen.has(key)) return [];
      seen.add(key);
      try { return refs().flatMap(visit); } finally { seen.delete(key); }
    };
    for (const fn of mod.encl(ref.at)) {
      const b = paramBinding(fn, id);
      if (b === null) continue;
      let handedOn = false;
      const out = once(`${mod.file}#${fn.name}#${id}`, () => {
        const local = b.prop ? b.prop.local : b.p.name;
        const provided = bind.get(fn)?.get(local);
        const refs = [];
        if (provided !== undefined) refs.push(...provided);
        else {
          handedOn = new RegExp(`(?<=[(,[]\\s*)${escape(fn.name)}(?=\\s*[,)\\]])`).test(mod.skel);
          for (const { mod: m, c } of callersOf(mod, fn)) {
            const arg = argRef(m, c, b.p.index);
            if (arg !== null) refs.push(...(b.prop ? keyValues(arg, b.prop.key, bind, seen) : [arg]));
          }
        }
        const own = b.prop ? b.prop.def : b.p.def;
        if (own !== null && (provided === undefined || provided.length === 0)) refs.push({ mod, ...own, at: fn.start });
        if (b.prop && b.p.def !== null && (provided === undefined || provided.length === 0)) refs.push(...keyValues({ mod, ...b.p.def, at: fn.start }, b.prop.key, bind, seen));
        return refs;
      });
      return handedOn ? [...out, ...unknown()] : out;
    }
    const helper = resolve(mod, id);
    if (helper !== null) return once(`${helper.mod.file}#${helper.name}`, () => returnsOf(helper.mod, helper.mod.fns.get(helper.name)));
    const own = declRefs(mod, id, ref.at);
    if (own.refs.length > 0) return once(own.key, () => own.refs);
    const imp = mod.imports.get(id);
    const from = imp && mods.get(imp.module.slice(2));
    if (from) {
      const theirs = declRefs(from, imp.name, -1);
      if (theirs.refs.length > 0) return once(theirs.key, () => theirs.refs);
    }
    return unknown();
  };
  // Every expression an assignment after its declaration writes to `key` of
  // the object `id` names: `id.key = …`, `id["key"] = …`, and each source of
  // an `Object.assign(id, …)`. An `id.key++` or `--id.key` is a compound
  // write with nothing to read.
  const writes = (ref, id, key, bind, seen) => {
    const { mod } = ref;
    const once = `${mod.file}#${id}.${key}=`;
    if (seen.has(once)) return [];
    seen.add(once);
    try {
      const e = escape(id);
      const out = [];
      const member = (group) => `${e}\\s*(?:\\.\\s*${escape(key)}\\b|\\[\\s*(["'\`])${escape(key)}\\${group}\\s*\\])`;
      const visible = (m) => mod.skel[m.index] === mod.code[m.index];
      for (const m of mod.code.matchAll(new RegExp(`(?<![\\w$.])${member(1)}\\s*${ASSIGN}\\s*`, "g"))) {
        if (!visible(m)) continue;
        const a = m.index + m[0].length;
        out.push({ ...refOf(mod, a, exprEnd(mod.skel, a, true)), compound: COMPOUND.test(m[0]) });
      }
      for (const m of mod.code.matchAll(new RegExp(`(?<![\\w$.])${member(1)}\\s*(?:\\+\\+|--)|(?:\\+\\+|--)\\s*${member(2)}`, "g"))) {
        if (visible(m)) out.push({ ...refOf(mod, m.index, m.index), compound: true });
      }
      for (const m of mod.skel.matchAll(/(?<![\w$.])Object\s*\.\s*assign\s*\(/g)) {
        const [first, ...sources] = pieces(mod.skel, mod.code, m.index + m[0].length - 1);
        if (first?.code !== id) continue;
        for (const s of sources) out.push(...keyValues({ mod, skel: s.skel, code: s.code, at: m.index }, key, bind, seen, true));
      }
      return out;
    } finally { seen.delete(once); }
  };
  // The values an expression can take as a whole, where it picks between
  // others: the inside of its parentheses, the branches of a top-level
  // ternary, each side of `||` and `??`, the right of `&&`. null for any other
  // expression.
  const branches = (ref) => {
    const s = ref.skel;
    const cut = (a, b) => ({ ...ref, skel: s.slice(a, b).trim(), code: ref.code.slice(a, b).trim() });
    if (s.startsWith("(") && closing(s, 0) === s.length - 1) return [cut(1, s.length - 1)];
    const ops = [];
    let d = 0;
    for (let k = 0; k < s.length; k++) {
      if (OPEN.includes(s[k])) d++;
      else if (CLOSE.includes(s[k])) d--;
      else if (d === 0 && s.startsWith("?.", k)) k++;
      else if (d === 0 && /^(?:\?\?|\|\||&&)/.test(s.slice(k, k + 2))) { ops.push([k, s.slice(k, k + 2)]); k++; }
      else if (d === 0 && (s[k] === "?" || s[k] === ":")) ops.push([k, s[k]]);
    }
    const q = ops.findIndex(([, op]) => op === "?");
    if (q >= 0) {
      let open = 0;
      for (const [k, op] of ops.slice(q + 1)) {
        if (op === "?") open++;
        else if (op === ":" && open-- === 0) return [cut(ops[q][0] + 1, k), cut(k + 1, s.length)];
      }
      return null;
    }
    const either = ops.filter(([, op]) => op === "||" || op === "??").map(([k]) => k);
    if (either.length > 0) return [-2, ...either].map((k, j) => cut(k + 2, either[j] ?? s.length));
    const and = ops.filter(([, op]) => op === "&&").at(-1);
    return and === undefined ? null : [cut(and[0] + 2, s.length)];
  };
  // A read the sweep refuses to follow: a ref that judge() answers with `why`.
  const refuse = (ref, why) => ({ mod: ref.mod, skel: "", code: "", at: ref.at, refuse: why });
  const shadowedBy = (ref, id) => ref.mod.encl(ref.at).some((fn) => paramBinding(fn, id) !== null);
  const isClass = (mod, id) => {
    const imp = mod.imports.get(id);
    return mod.classes.has(id) || (imp !== undefined && (mods.get(imp.module.slice(2))?.classes.has(imp.name) ?? false));
  };
  // Why the object `id` names, read at `where`, may have a key this sweep
  // does not see: it is handed, in parentheses or not, to an Object.* or
  // Reflect.* call other than Object.assign() (whose target writes()
  // follows), the call's name written as a member or computed, or
  // `__proto__`, `__defineGetter__` or `__defineSetter__` is written or called
  // on it, in the file that reads it or the one it is imported from.
  const unwrapped = (s) => (s.startsWith("(") && closing(s, 0) === s.length - 1 ? unwrapped(s.slice(1, -1).trim()) : s);
  const reshapes = (ref, id, where) => {
    const imp = ref.mod.imports.get(id);
    const from = imp && mods.get(imp.module.slice(2));
    const out = [];
    for (const [mod, name] of from ? [[ref.mod, id], [from, imp.name]] : [[ref.mod, id]]) {
      for (const m of mod.skel.matchAll(/(?<![\w$.])(Object|Reflect)\s*(?:\.\s*([\w$]+)|\[[^\]]*\])\s*\(/g)) {
        if (m[1] === "Object" && m[2] === "assign") continue;
        if (pieces(mod.skel, mod.code, m.index + m[0].length - 1).some((p) => unwrapped(p.skel) === name)) {
          out.push(`reads ${where}: ${name} is handed to ${m[1]}${m[2] === undefined ? "[…]" : `.${m[2]}`}(…), which this sweep does not follow`);
        }
      }
      const e = escape(name);
      const has = (pattern) => [...mod.code.matchAll(new RegExp(pattern, "g"))].some((m) => mod.skel[m.index] === mod.code[m.index]);
      if (has(`(?<![\\w$.])${e}\\s*(?:\\.\\s*__proto__\\b|\\[\\s*(["'])__proto__\\1\\s*\\])\\s*${ASSIGN}`)) {
        out.push(`reads ${where}: ${name}.__proto__ is written, a prototype this sweep does not follow`);
      }
      if (has(`(?<![\\w$.])${e}\\s*\\.\\s*__define(?:Getter|Setter)__\\s*\\(`)) {
        out.push(`reads ${where}: ${name}.__defineGetter__ or __defineSetter__ is called, which this sweep does not follow`);
      }
    }
    return out.map((why) => refuse(ref, why));
  };
  // One entry of an object literal, read off its source text `c`: its kind
  // (`plain`, `shorthand`, `accessor`, `method`, or `computed` for any key
  // not spelled out), its key (a number literal's as the number it is), and
  // for a plain entry where its value starts.
  const MODIFIER = /^(?:(async|get|set)\s+(?=[\w$"'[*])|\*\s*(?=[\w$"'[]))/;
  const entryOf = (c) => {
    let rest = c;
    let at = 0;
    let accessor = false;
    let method = false;
    for (let m = rest.match(MODIFIER); m !== null; m = rest.match(MODIFIER)) {
      if (m[1] === "get" || m[1] === "set") accessor = true;
      else method = true;
      rest = rest.slice(m[0].length);
      at += m[0].length;
    }
    const number = rest.match(NUMBER);
    const k = number ?? (rest.startsWith("[") ? null : rest.match(/^(?:(["'])((?:\\.|(?!\1)[^\\])*)\1|([\w$]+))/));
    if (k === null) return { kind: "computed" };
    const key = number !== null ? String(Number(number[0].replace(/_/g, ""))) : k[2] ?? k[3];
    const tail = rest.slice(k[0].length);
    if (accessor) return { kind: "accessor", key };
    if (method || /^\s*\(/.test(tail)) return { kind: "method", key };
    const colon = tail.match(/^\s*:\s*/);
    if (colon !== null) return { kind: "plain", key, at: at + k[0].length + colon[0].length };
    return /^\s*$/.test(tail) ? { kind: "shorthand", key } : { kind: "computed" };
  };
  // The expressions `key` can be given in the options object `ref` reads as:
  // an object literal, its spreads, a variable or parameter holding one, a
  // key written into that variable later, a local helper's return, either
  // value a choice between objects can take. `whole` is set inside a spread
  // or an Object.assign(), where an expression none of those opens is handed
  // back to be judged whole rather than read as carrying no `key`. `read` is
  // the member read being traced, as written (`CFG.ms`), when there is one:
  // the receivers rule 3 refuses are refused, and an expression none of those
  // opens is handed back to be judged whole. A literal's entries are
  // refused as rule 4 says, whoever reads them.
  const keyValues = (ref, key, bind, seen, whole = false, read = null) => {
    if (ref.refuse) return [ref];
    const s = ref.skel;
    const where = read ?? key;
    const opaque = whole || read !== null ? [ref] : [];
    const not = (what) => [refuse(ref, `reads ${where}: ${what}, whose members this sweep does not follow`)];
    if (read !== null) {
      if (/^new\b/.test(s)) return not("it is a new expression");
      if (/^Object\s*\.\s*create\s*\(/.test(s)) return not("it is an Object.create(…) object");
      if (/^class\b/.test(s)) return not("it is a class");
      if (/^(?:async\b\s*)?(?:function\b|(?:[\w$]+|\([^()]*\))\s*=>)/.test(s)) return not("it is a function");
    }
    if (s.startsWith("{")) {
      if (closing(s, 0) !== s.length - 1) return opaque;
      const out = [];
      for (const p of pieces(s, ref.code, 0)) {
        if (p.skel.startsWith("...")) {
          out.push(...keyValues({ ...ref, skel: p.skel.slice(3).trim(), code: p.code.slice(3).trim() }, key, bind, seen, true, read));
          continue;
        }
        const e = entryOf(p.code);
        if (e.kind === "computed") out.push(refuse(ref, `reads ${where}: its object holds a computed key, which can be ${key}`));
        else if (e.key === "__proto__" && e.kind === "plain") out.push(refuse(ref, `reads ${where}: its object holds a __proto__ entry, a prototype this sweep does not follow`));
        else if (e.key !== key) continue;
        else if (e.kind === "accessor" || e.kind === "method") out.push(refuse(ref, `reads ${where}: its object holds ${key} as a getter, setter or method, not a plain value`));
        else out.push(e.kind === "shorthand" ? { ...ref, skel: key, code: key } : { ...ref, skel: p.skel.slice(e.at).trim(), code: p.code.slice(e.at).trim() });
      }
      return out;
    }
    const inner = (r) => keyValues(r, key, bind, seen, whole, read);
    if (/^[\w$]+$/.test(s)) {
      if (read !== null) {
        if (s === "this") return [refuse(ref, `reads ${where}: this holds no object this sweep can follow`)];
        if (!shadowedBy(ref, s) && isClass(ref.mod, s)) return not(`${s} is a class`);
        if (!shadowedBy(ref, s) && resolve(ref.mod, s) !== null) return not(`${s} is a function`);
      }
      return [...reshapes(ref, s, where), ...viaId(ref, s, bind, seen, inner, () => opaque), ...writes(ref, s, key, bind, seen)];
    }
    const call = s.match(/^([\w$]+)\s*\(/);
    if (call !== null && closing(s, call[0].length - 1) === s.length - 1) {
      const unopened = read !== null && !GLOBALS.has(call[1]) ? not(`${call[1]}(…) returns a value this sweep cannot open`) : opaque;
      return viaId(ref, call[1], bind, seen, inner, () => unopened);
    }
    const alternatives = branches(ref);
    if (alternatives !== null) return alternatives.flatMap(inner);
    return opaque;
  };
  // JavaScript's own names: a read of one reaches no environment.
  const GLOBALS = new Set(["Number", "Math", "Date", "String", "Boolean", "BigInt", "JSON", "Object", "Array",
    "parseInt", "parseFloat", "isFinite", "isNaN", "Infinity", "NaN", "undefined", "null", "true", "false",
    "typeof", "void", "await", "instanceof", "in", "of"]);
  // ghBudget() is arg.mjs's only where this file imports it from there and
  // declares no ghBudget of its own.
  const isGhBudget = (mod) => !mod.fns.has("ghBudget") && mod.imports.get("ghBudget")?.module === "./arg.mjs"
    && mod.imports.get("ghBudget").name === "ghBudget";
  // The member reads written in `text` from offset `at` on, one after
  // another: `.key`, `?.key`, and a `[…]` or `?.[…]` whose key is a string
  // or an integer literal, read off `code`, `text` with its strings in place.
  // Each comes with the offset just past it and its text as written. A `[…]`
  // holding anything else ends them, as a read whose key is null.
  const DOT = /^\s*(?:\?\.|\.)\s*([\w$]+)/;
  const BRACKET = /^\s*(?:\?\.\s*)?\[/;
  const members = (text, code, at) => {
    const out = [];
    for (;;) {
      const dot = text.slice(at).match(DOT);
      if (dot !== null) {
        at += dot[0].length;
        out.push({ key: dot[1], end: at, written: `.${dot[1]}` });
        continue;
      }
      const open = text.slice(at).match(BRACKET);
      if (open === null) return out;
      const from = at + open[0].length - 1;
      at = closing(text, from) + 1;
      const literal = code.slice(from, at).match(/^\[\s*(?:(["'`])((?:(?!\1)[^\\$])*)\1|(\d+))\s*\]$/);
      out.push({ key: literal === null ? null : literal[2] ?? literal[3], end: at, written: code.slice(from, at).replace(/\s+/g, "") });
      if (literal === null) return out;
    }
  };
  // How the environment reaches the value `ref` reads: one reason per read.
  const judge = (ref, bind, seen) => {
    if (ref.refuse) return [ref.refuse];
    const hide = ref.skel.split("");
    const reasons = [];
    const part = (p) => ({ ...ref, skel: p.skel, code: p.code });
    for (const m of ref.skel.matchAll(/(?<![\w$.])(ghBudget|Math\s*\.\s*min)\s*\(/g)) {
      if (hide[m.index] === " ") continue;
      const open = m.index + m[0].length - 1;
      const args = pieces(ref.skel, ref.code, open);
      if (m[1] === "ghBudget") {
        if (!isGhBudget(ref.mod)) continue;
        if (args.length > 0) reasons.push(...judge(part(args[0]), bind, seen));
      } else {
        const parts = args.map(part);
        const per = parts.map((p) => judge(p, bind, seen));
        const env = parts.filter((_, k) => per[k].length > 0);
        if (env.length > 0) {
          const ceiling = parts.some((p, k) => per[k].length === 0 && inRange(numbers(p, bind, seen)));
          const unfloored = env.filter((p) => !floored(p, bind, seen));
          if (!ceiling) reasons.push(`Math.min(…) has no ceiling clear of the environment that works out to a number from 1 to ${CEILING_CAP}`);
          for (const p of unfloored) reasons.push(`Math.min(…) takes ${p.code.replace(/\s+/g, " ")}, which the environment reaches, with no Math.max(…) floor of at least 1`);
          if (!ceiling || unfloored.length > 0) continue;
        }
      }
      for (let k = m.index; k <= closing(ref.skel, open); k++) hide[k] = " ";
    }
    const rest = hide.join("");
    let skipTo = 0;
    for (const m of rest.matchAll(/(?<![\w$.])[A-Za-z_$][\w$]*/g)) {
      if (m.index < skipTo) continue;
      const id = m[0];
      let after = m.index + id.length;
      if (/[{,]\s*$/.test(rest.slice(0, m.index)) && /^\s*:/.test(rest.slice(after))) continue;
      let reads = id === "process" ? "process" : shadowedBy(ref, id) ? undefined : ref.mod.processAliases.get(id);
      if (id === "globalThis") {
        const via = rest.slice(after).match(/^\s*(?:\?\.|\.)\s*process\b/);
        if (via === null) continue;
        after += via[0].length;
        reads = "process";
      }
      if (reads === undefined) {
        const follow = rest.slice(after);
        // A member read on a `new` expression or an Object.create() call.
        const create = id === "Object" ? follow.match(/^\s*\.\s*create\s*\(/) : null;
        const made = id === "new" ? follow.match(/^\s*[\w$.]+\s*/) : create;
        if (made !== null) {
          let end = after + made[0].length;
          if (id === "new" && rest[end] === "(") end = closing(rest, end) + 1;
          else if (id === "Object") end = closing(rest, end - 1) + 1;
          const [mem] = members(rest, ref.code, end);
          if (mem !== undefined) {
            const label = `${ref.code.slice(m.index, end).replace(/\s+/g, " ")}${mem.written}`;
            reasons.push(`reads ${label}: it is ${id === "new" ? "a new expression" : "an Object.create(…) object"}, whose members this sweep does not follow`);
            skipTo = mem.end;
            continue;
          }
        }
        // A member read, `x.a.b` or `x["a"]` or `f(…).a`: each key is read out
        // of the values the one before it holds.
        let end = after;
        let chain = GLOBALS.has(id) ? [] : members(rest, ref.code, end);
        const open = follow.match(/^\s*\(/);
        if (chain.length === 0 && open !== null && !GLOBALS.has(id)) {
          end = closing(rest, after + open[0].length - 1) + 1;
          chain = members(rest, ref.code, end);
        }
        if (chain.length > 0) {
          let label = end === after ? id : `${id}(…)`;
          let values = [{ ...ref, skel: ref.skel.slice(m.index, end), code: ref.code.slice(m.index, end) }];
          for (const { key, written } of chain) {
            label += written;
            values = key === null
              ? [refuse(ref, `reads ${label}: its key is computed, which this sweep does not follow`)]
              : values.flatMap((v) => keyValues(v, key, bind, seen, false, label));
          }
          for (const v of values) reasons.push(...judge(v, bind, seen));
          continue;
        }
        const unknown = () => (GLOBALS.has(id) ? [] : [`reaches ${id}, which this sweep cannot resolve`]);
        reasons.push(...viaId(ref, id, bind, seen, (r) => judge(r, bind, seen), unknown));
        continue;
      }
      if (reads === "process") {
        const next = rest.slice(after).match(/^\s*(?:\?\.|\.)\s*([\w$]+)/);
        if (next !== null && next[1] !== "env") continue;
      }
      const tail = reads === "process"
        ? /^(?:\s*(?:\?\.|\.)\s*env(?:\s*\??\.?\s*(?:[\w$]+|\[[^\]]*\]))?|\s*\[[^\]]*\])?/
        : /^(?:\s*\??\.?\s*(?:[\w$]+|\[[^\]]*\]))?/;
      reasons.push(`reads ${ref.code.slice(m.index, after)}${ref.code.slice(after).match(tail)[0]}`);
    }
    return reasons;
  };
  const inRange = (n) => n !== null && Math.max(...n) >= 1 && Math.max(...n) <= CEILING_CAP;
  // The numbers `ref` can work out to, from literals, unary + and -, + - * /
  // **, parentheses, names and member reads resolved as the tracer resolves
  // them, and three calls: arg.mjs's ghBudget(), a Math.min() and a local
  // helper handed nothing, each as the functions below say; null when any
  // value of it does not work out, or it is written by a compound assignment
  // or a `++` or `--`.
  const NUMBER = /^(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)/;
  const MAX_VALUES = 64;
  // ghBudget(seconds, override) in ms: at least a second, and at most
  // `seconds` seconds, which is why `seconds` must work out to at least 1. The
  // override is never read: it can only pick a number of seconds from 1 to
  // `seconds`, which is no lengthening.
  const ghBudgetOf = (args, bind, seen) => {
    if (args.length < 1 || args.length > 2) return null;
    const seconds = numbers(args[0], bind, seen);
    return seconds !== null && Math.min(...seconds) >= 1 ? [1000, Math.max(...seconds) * 1000] : null;
  };
  // Math.min(…) in ms, from 1 to its ceiling: the least of the largest values
  // its arguments work out to, which must be at most CEILING_CAP. Every
  // argument must be at least 1: it works out to numbers none of which is
  // below 1 (above CEILING_CAP is no matter, another argument is the
  // ceiling), or it is floored(), as the arguments the environment reaches
  // are. An argument that is neither, `0` among them, works out to nothing.
  const minOf = (args, bind, seen) => {
    if (args.length === 0) return null;
    let ceiling = Infinity;
    for (const arg of args) {
      const n = numbers(arg, bind, seen);
      if (n === null) {
        if (!floored(arg, bind, seen)) return null;
      } else if (Math.min(...n) < 1) return null;
      else ceiling = Math.min(ceiling, Math.max(...n));
    }
    return ceiling <= CEILING_CAP ? [1, ceiling] : null;
  };
  const numbers = (ref, bind, seen) => {
    if (ref.refuse || ref.compound || ref.destructured) return null;
    const s = ref.skel;
    let i = 0;
    const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
    const fail = () => { i = s.length + 1; return null; };
    const lift = (a, b, f) => {
      if (a === null || b === null) return null;
      const out = [...new Set(a.flatMap((x) => b.map((y) => f(x, y))))];
      return out.length > MAX_VALUES ? null : out;
    };
    const sum = () => {
      let v = prod();
      for (;;) {
        ws();
        if (s[i] !== "+" && s[i] !== "-") return v;
        const op = s[i++];
        v = lift(v, prod(), op === "+" ? (a, b) => a + b : (a, b) => a - b);
      }
    };
    const prod = () => {
      let v = pow();
      for (;;) {
        ws();
        if (s[i] !== "*" && s[i] !== "/") return v;
        const op = s[i++];
        v = lift(v, pow(), op === "*" ? (a, b) => a * b : (a, b) => a / b);
      }
    };
    const pow = () => {
      const base = unary();
      ws();
      if (s[i] === "*" && s[i + 1] === "*") { i += 2; return lift(base, pow(), (a, b) => a ** b); }
      return base;
    };
    const unary = () => {
      ws();
      if (s[i] !== "+" && s[i] !== "-") return primary();
      if (s[i + 1] === s[i]) return fail();
      const negate = s[i++] === "-";
      const v = unary();
      return v !== null && negate ? v.map((x) => -x) : v;
    };
    const primary = () => {
      ws();
      if (s[i] === "(") {
        i++;
        const v = sum();
        ws();
        if (s[i] !== ")") return fail();
        i++;
        return v;
      }
      const num = s.slice(i).match(NUMBER);
      if (num !== null) { i += num[0].length; return [Number(num[0].replace(/_/g, ""))]; }
      const name = s.slice(i).match(/^[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*/);
      if (name === null) return fail();
      i += name[0].length;
      ws();
      const id = name[0].replace(/\s+/g, "");
      if (s[i] === "(") return call(id);
      if (s[i] === "[") return fail();
      return named(ref, id.split("."), bind, seen);
    };
    // The three calls that work out to a number: arg.mjs's ghBudget(), a
    // Math.min(), and a local helper handed nothing. Any other call does not.
    const call = (id) => {
      const open = i;
      const args = pieces(s, ref.code, open).map((p) => ({ ...ref, skel: p.skel, code: p.code }));
      i = closing(s, open) + 1;
      if (args.some((a) => a.skel.startsWith("..."))) return null;
      if (id === "ghBudget" && isGhBudget(ref.mod)) return ghBudgetOf(args, bind, seen);
      if (id === "Math.min") return minOf(args, bind, seen);
      if (args.length > 0 || !/^[\w$]+$/.test(id) || shadowedBy(ref, id)) return null;
      const helper = resolve(ref.mod, id);
      if (helper === null || helper.mod.fns.get(helper.name).params.length > 0) return null;
      const each = viaId(ref, id, bind, seen, (r) => numbers(r, bind, seen) ?? [null], () => [null]);
      return each.length === 0 || each.includes(null) ? null : [...new Set(each)];
    };
    const v = sum();
    ws();
    return i === s.length && v !== null && v.length > 0 ? v : null;
  };
  // Whether a compound assignment, `++` or `--` writes the name `id` anywhere
  // in its module, a parameter of that name included.
  const updated = (mod, id) => {
    const e = escape(id);
    return new RegExp(`${UPDATE(e)}|(?<![\\w$.])${e}\\s*${OPERATOR}=(?![=>])`).test(mod.skel);
  };
  // The numbers a name, or a member read `a.b.c`, can hold.
  const named = (ref, [id, ...keys], bind, seen) => {
    const all = (vals) => (vals.length === 0 || vals.includes(null) ? null : [...new Set(vals)]);
    if (keys.length === 0) {
      if (!shadowedBy(ref, id) && (isClass(ref.mod, id) || resolve(ref.mod, id) !== null)) return null;
      if (updated(ref.mod, id)) return null;
      return all(viaId(ref, id, bind, seen, (r) => numbers(r, bind, seen) ?? [null], () => [null]));
    }
    let objects = [{ ...ref, skel: id, code: id }];
    let label = id;
    for (const key of keys) {
      label += `.${key}`;
      objects = objects.flatMap((o) => keyValues(o, key, bind, seen, false, label));
      if (objects.length === 0) return null;
    }
    return all(objects.flatMap((o) => numbers(o, bind, seen) ?? [null]));
  };
  // Whether every value `ref` can take is a Math.max(…) call with an argument
  // clear of the environment that is at least 1 at its smallest. A name a
  // compound assignment, `++` or `--` writes is no floor.
  const floored = (ref, bind, seen) => {
    if (ref.refuse || ref.compound) return false;
    const s = ref.skel;
    const max = s.match(/^Math\s*\.\s*max\s*\(/);
    if (max !== null) {
      const open = max[0].length - 1;
      return closing(s, open) === s.length - 1 && pieces(s, ref.code, open).some((a) => {
        const arg = { ...ref, skel: a.skel, code: a.code };
        const n = judge(arg, bind, seen).length === 0 ? numbers(arg, bind, seen) : null;
        return n !== null && Math.min(...n) >= 1;
      });
    }
    const alternatives = branches(ref);
    if (alternatives !== null) return alternatives.every((r) => floored(r, bind, seen));
    if (!/^[\w$]+$/.test(s) || updated(ref.mod, s)) return false;
    const each = viaId(ref, s, bind, seen, (r) => [floored(r, bind, seen)], () => [false]);
    return each.length > 0 && each.every(Boolean);
  };
  // Every way the timeouts of a child_process call, the refs `timeouts`, are
  // no number from 1 to CEILING_CAP: none at all, or one that works out to no
  // number, or to one outside that range, 0 and 1e12 among them. `bind` is
  // what the funnels around the call were handed.
  const sizes = (timeouts, bind) => {
    if (timeouts.length === 0) return ["takes no timeout value"];
    return timeouts.flatMap((v) => {
      const n = numbers(v, bind, new Set());
      if (n === null) return [`takes a timeout that does not work out to a number: ${v.refuse ?? v.code.replace(/\s+/g, " ")}`];
      const [least, most] = [Math.min(...n), Math.max(...n)];
      return least >= 1 && most <= CEILING_CAP ? [] : [`takes a timeout that can be ${least < 1 ? least : most}, outside 1 to ${CEILING_CAP}`];
    });
  };
  // Every reason the environment reaches the timeout of the spawn call `c`
  // whose command is argument `cmdAt`: its own `timeout` (and, to a funnel,
  // `timeoutMs`), then the calls the funnel makes in turn, each with the
  // funnel's parameters bound to what `c` handed it; and, at the child_process
  // call itself, every way its timeout works out to no number from 1 to
  // CEILING_CAP, in `range`.
  const walk = (mod, c, cmdAt, bind, range) => {
    const reasons = [];
    const primitive = mod.primitives.has(c.callee);
    const timeouts = [];
    c.args.forEach((_, i) => {
      const arg = argRef(mod, c, i);
      if (i === cmdAt || arg === null) return;
      for (const key of primitive ? ["timeout"] : ["timeout", "timeoutMs"]) {
        for (const v of keyValues(arg, key, bind, new Set())) {
          reasons.push(...judge(v, bind, new Set()));
          if (primitive) timeouts.push(v);
        }
      }
    });
    if (primitive) {
      range.push(...sizes(timeouts, bind));
      return reasons;
    }
    const target = resolve(mod, c.callee);
    const fn = target.mod.fns.get(target.name);
    if (bind.has(fn)) return reasons;
    const bound = new Map();
    for (const p of paramsOf(fn)) {
      if (p.rest) continue;
      const arg = argRef(mod, c, p.index);
      if (p.name !== undefined) bound.set(p.name, arg === null ? [] : [arg]);
      else for (const prop of p.props) bound.set(prop.local, arg === null ? [] : keyValues(arg, prop.key, bind, new Set()));
    }
    const inside = new Map(bind).set(fn, bound);
    for (const ic of target.mod.calls) {
      if (ic.at < fn.start || ic.at > fn.end) continue;
      const inner = spawner(target.mod, ic);
      if (inner === null || fn.params.indexOf(ic.args[inner.index]?.code) !== cmdAt) continue;
      reasons.push(...walk(target.mod, ic, inner.index, inside, range));
    }
    return reasons;
  };
  return (mod, c, cmdAt) => {
    const range = [];
    const reasons = walk(mod, c, cmdAt, new Map(), range);
    return { reaches: [...new Set(reasons)], range: [...new Set(range)] };
  };
}

// A shell line that runs gh: gh heading the line, or heading a command after
// `;`, `&`, `|` or `(`. Read off the string literals of a spawn's command, and
// off those of its other arguments with a word after gh, so an argument that
// is only "gh" (a search term, an author) runs nothing.
const SHELL_GH = /(?:^|[;&|(]\s*)gh(?:\s|$)/;
const ARG_GH = /(?:^|[;&|(]\s*)gh\s/;
const STRINGS = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
const runsGh = (c, cmdAt) => c.args.some(({ code }, i) => [...code.matchAll(STRINGS)].some((s) => (i === cmdAt ? SHELL_GH : ARG_GH).test(s[2])));

// Whole-directory sweep: every gh spawn, whether it is bounded, and how the
// environment reaches its bound.
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

  const reaches = tracer(mods, resolve, spawner);
  const spawns = [];
  for (const mod of mods.values()) {
    for (const c of mod.calls) {
      const spawn = spawner(mod, c);
      if (spawn === null) continue;
      const cmd = c.args[spawn.index]?.code ?? "";
      const where = `${mod.file}:${c.line}`;
      if (/^["']gh["']$/.test(cmd) || runsGh(c, spawn.index)) {
        spawns.push({ where, bounded: spawn.bounded, ...reaches(mod, c, spawn.index) });
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

// #4446. A bound no environment variable can lengthen, whatever the variable
// is called: every gh spawn's timeout expression is traced, and refused when
// it reaches `process.env` other than through a shortening budget.
test("no gh spawn's timeout is reachable from the environment", () => {
  const { spawns } = sweep(readScripts());
  assert.deepEqual(spawns.flatMap((s) => s.reaches.map((why) => `${s.where} bounds a gh call by the environment: ${why}`)), []);
});

// The name-based pin that predates the tracer, kept as a tightening: every
// `process.env.*_GH_TIMEOUT` read is ghBudget()'s second argument and nothing
// else, and each script #4431 bounded declares its bound that way.
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
const reaching = (sources) => sweep(sources).spawns.map((s) => s.reaches.length > 0);
const outside = (sources) => sweep(sources).spawns.map((s) => s.range.length > 0);

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
    "timeoutMs, which child_process ignores": MOD(`spawnSync("gh", ["x"], { encoding: "utf8", timeoutMs: 5000 });`),
    "timeout nested in another key": MOD(`spawnSync("gh", ["x"], { env: { ...process.env, timeout: "5" } });`),
    "constant that bounds nothing": MOD(`const T = 0;\nspawnSync("gh", ["x"], { timeout: T });`),
    "shell line": MOD(`execSync("gh pr view 1", { encoding: "utf8" });`, "execSync"),
    "shell: true": MOD(`spawnSync("gh pr list", { shell: true });`),
    "sh -c": MOD(`spawnSync("sh", ["-c", "git fetch && gh pr view 1"]);`),
  };
  for (const [name, src] of Object.entries(refused)) assert.deepEqual(verdicts({ "x.mjs": src }), [false], name);
  // The shell-line shapes are refused for the bound they lack: each, given
  // one, is a bounded gh spawn.
  const shellBounded = {
    "shell line": MOD(`execSync("gh pr view 1", { encoding: "utf8", timeout: 5_000 });`, "execSync"),
    "shell: true": MOD(`spawnSync("gh pr list", { shell: true, timeout: 5_000 });`),
    "sh -c": MOD(`spawnSync("sh", ["-c", "git fetch && gh pr view 1"], { timeout: 5_000 });`),
  };
  for (const [name, src] of Object.entries(shellBounded)) assert.deepEqual(verdicts({ "x.mjs": src }), [true], name);
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
    "timeoutMs parameter": MOD(`export function read(n, { timeoutMs }) { return spawnSync("gh", ["x"], { timeout: timeoutMs }); }\nread(1, { timeoutMs: 20_000 });`),
    shorthand: MOD(`function f(timeout) { return spawnSync("gh", ["x"], { encoding: "utf8", timeout }); }\nf(20_000);`),
    "options object with one": MOD(`const READ_TIMEOUT_MS = 60_000;\nfunction f() { const opts = { encoding: "utf8", timeout: READ_TIMEOUT_MS };\nreturn execFileSync("gh", ["x"], opts); }`),
    "spread plus a bound": MOD(`const CHILD = { encoding: "utf8" };\nspawnSync("gh", ["x"], { ...CHILD, timeout: 30_000 });`),
    "bounded funnel": MOD(`const T = 20_000;\nfunction spawn(cmd, args) { return execFileSync(cmd, args, { timeout: T }); }\nfunction run(cmd, args) { return spawn(cmd, args); }\nrun(\n  "gh",\n  ["x"],\n);`),
    "funnel bounded at the call": MOD(`const T = 20_000;\nasync function tryRun(cmd, args, opts = {}) { return execFile(cmd, args, { ...opts }); }\nawait tryRun("gh", ["x"], { timeout: T });`, "execFile"),
  };
  for (const [name, src] of Object.entries(accepted)) assert.deepEqual(verdicts({ "x.mjs": src }), [true], name);
  for (const [name, src] of Object.entries(accepted)) assert.deepEqual(reaching({ "x.mjs": src }), [false], name);
  for (const [name, src] of Object.entries(accepted)) assert.deepEqual(outside({ "x.mjs": src }), [false], name);
  // Not gh, so nothing to bound: a sibling script, node itself, git, a funnel
  // only ever handed another command.
  const notGh = MOD(`spawnSync(process.execPath, [join(SCRIPT_DIR, "x.mjs")]);\nspawnSync("git", ["status"]);\nspawnSync("git", ["log", "--author", "gh"]);\nspawnSync(join(SCRIPT_DIR, "x.sh"));\nfunction run(cmd, a) { return spawnSync(cmd, a); }\nrun("sh", ["y"]);`);
  assert.deepEqual(sweep({ "x.mjs": notGh }), { spawns: [], problems: [] });
});

// #4446. A timeout the environment can lengthen is refused whatever the
// variable is called, wherever the read sits on the way to the spawn.
const FUNNEL = `function run(cmd, args, timeoutMs) { return spawnSync(cmd, args, { timeout: timeoutMs }); }`;
const ENV_MS = "Number(process.env.TICKETLESS_TIMEOUT ?? 60) * 1000";
// arg.mjs's ghBudget() as a script imports it; the sweep exempts no other.
const GH_BUDGET = `import { ghBudget } from "./arg.mjs";\n`;
// #4460. A gh spawn timed by `Math.min(ceiling, env)`, and one timed by the
// expression `expr`; `decls` are the lines written before the spawn.
const FLOORED = "Math.max(1, Number(process.env.X))";
const MIN = (ceiling, env = FLOORED, decls = "") => MOD(`${GH_BUDGET}${decls}spawnSync("gh", ["x"], { timeout: Math.min(${ceiling}, ${env}) });`);
const READ = (expr, decls = "") => MOD(`${decls}spawnSync("gh", ["x"], { timeout: ${expr} });`);
const ENV_GETTER = "get ms() { return Number(process.env.X); }";
const ENV_PROTO = "function B() {}\nB.prototype.ms = function () { return Number(process.env.X); };\n";
const imports = (decls, line) => ({ "common.mjs": decls, "x.mjs": line });
// `lets(name, n)` sets `name` to each of 1 to `n` in turn, so the ceiling
// COMBINED, under `combinations(a)`, takes a × 4 × 4 distinct values.
const lets = (name, n) => Array.from({ length: n }, (_, k) => (k === 0 ? `let ${name} = 1;\n` : `${name} = ${k + 1};\n`)).join("");
const COMBINED = "A + B * 10 + C * 100";
const combinations = (a) => `${lets("A", a)}${lets("B", 4)}${lets("C", 4)}`;

test("the sweep refuses a gh spawn whose timeout the environment can reach", () => {
  const refused = {
    "constant fed by an env read": MOD(`const READ_TIMEOUT_MS = ${ENV_MS};\nspawnSync("gh", ["x"], { timeout: READ_TIMEOUT_MS });`),
    "env read written inline": MOD(`spawnSync("gh", ["x"], { encoding: "utf8", timeout: ${ENV_MS} });`),
    "bracket form": MOD(`spawnSync("gh", ["x"], { timeout: Number(process.env["X"]) * 1000 });`),
    "bracket on process": MOD(`spawnSync("gh", ["x"], { timeout: Number(process["env"].X) * 1000 });`),
    "optional chain": MOD(`spawnSync("gh", ["x"], { timeout: Number(process.env?.X) * 1000 });`),
    "env destructured out of process": MOD(`const { env } = process;\nspawnSync("gh", ["x"], { timeout: Number(env.X) });`),
    "env imported from node:process": MOD(`import { env } from "node:process";\nspawnSync("gh", ["x"], { timeout: Number(env.X) });`),
    "variable destructured out of the env": MOD(`const { SLOW } = process.env;\nspawnSync("gh", ["x"], { timeout: Number(SLOW) });`),
    "reassigned from an env read": MOD(`let T = 5_000;\nT = ${ENV_MS};\nspawnSync("gh", ["x"], { timeout: T });`),
    "compound assignment from an env read": MOD(`let T = 20_000;\nT += Number(process.env.EXTRA ?? 0) * 1000;\nspawnSync("gh", ["x"], { timeout: T });`),
    "logical assignment from an env read": MOD(`let T;\nT ??= ${ENV_MS};\nspawnSync("gh", ["x"], { timeout: T });`),
    "a variable that feeds itself and the env": MOD(`let T = 20_000;\nT = T + ${ENV_MS};\nspawnSync("gh", ["x"], { timeout: T });`),
    "env imported under another name": MOD(`import { env as ENV } from "node:process";\nspawnSync("gh", ["x"], { timeout: Number(ENV.X) });`),
    "process imported as a default": MOD(`import proc from "node:process";\nspawnSync("gh", ["x"], { timeout: Number(proc.env.X) });`),
    "process imported as a namespace": MOD(`import * as proc from "process";\nspawnSync("gh", ["x"], { timeout: Number(proc.env.X) });`),
    "process through globalThis": MOD(`spawnSync("gh", ["x"], { timeout: Number(globalThis.process.env.X) });`),
    "constant through a local helper": MOD(`function seconds() { return Number(process.env.X); }\nconst T = seconds() * 1000;\nspawnSync("gh", ["x"], { timeout: T });`),
    "arrow helper": MOD(`const ms = () => Number(process.env.X);\nspawnSync("gh", ["x"], { timeout: ms() });`),
    "options object declared in the file": MOD(`const OPTS = { timeout: ${ENV_MS} };\nspawnSync("gh", ["x"], OPTS);`),
    "options object spread": MOD(`const OPTS = { timeout: ${ENV_MS} };\nspawnSync("gh", ["x"], { ...OPTS });`),
    "timeout written into the options object later": MOD(`const opts = { encoding: "utf8", timeout: 20_000 };\nopts.timeout = ${ENV_MS};\nexecFileSync("gh", ["x"], opts);`),
    "timeout written in bracket form later": MOD(`const opts = { timeout: 20_000 };\nopts["timeout"] = ${ENV_MS};\nspawnSync("gh", ["x"], opts);`),
    "timeout assigned into the options object": MOD(`const opts = { timeout: 20_000 };\nObject.assign(opts, { timeout: ${ENV_MS} });\nspawnSync("gh", ["x"], opts);`),
    "spread of a helper's return": MOD(`const extra = () => ({ timeout: ${ENV_MS} });\nspawnSync("gh", ["x"], { timeout: 20_000, ...extra() });`),
    "spread the sweep cannot open": MOD(`spawnSync("gh", ["x"], { timeout: 20_000, ...load() });`),
    "spread of a choice between objects": MOD(`function f(slow) { return spawnSync("gh", ["x"], { timeout: 20_000, ...(slow ? { timeout: ${ENV_MS} } : {}) }); }\nf(true);`),
    "options object a helper returns": MOD(`function opts() { return { timeout: ${ENV_MS} }; }\nspawnSync("gh", ["x"], opts());`),
    "ghBudget whose ceiling is an env read": MOD(`${GH_BUDGET}const T = ghBudget(Number(process.env.X), process.env.X_GH_TIMEOUT);\nspawnSync("gh", ["x"], { timeout: T });`),
    "ghBudget the script declares itself": MOD(`function ghBudget(s, o) { return Number(o) * 1000; }\nspawnSync("gh", ["x"], { timeout: ghBudget(20, process.env.SLOW) });`),
    "ghBudget imported from elsewhere": {
      "common.mjs": `export function ghBudget(s, o) { return Number(o) * 1000; }\n`,
      "x.mjs": MOD(`import { ghBudget } from "./common.mjs";\nspawnSync("gh", ["x"], { timeout: ghBudget(20, process.env.SLOW) });`),
    },
    "a member call named ghBudget": MOD(`${GH_BUDGET}const cfg = { ghBudget: Math.max };\nspawnSync("gh", ["x"], { timeout: cfg.ghBudget(20_000, Number(process.env.X)) });`),
    "a member call named Math.min": MOD(`const obj = { Math: { min: Math.max } };\nspawnSync("gh", ["x"], { timeout: obj.Math.min(20_000, Number(process.env.X)) });`),
    "Math.min with no ceiling clear of the env": MOD(`spawnSync("gh", ["x"], { timeout: Math.min(Number(process.env.A), Number(process.env.B)) });`),
    "Math.min whose ceiling is Infinity": MOD(`spawnSync("gh", ["x"], { timeout: Math.min(Infinity, ${ENV_MS}) });`),
    "Math.min whose ceiling is an undeclared name": MOD(`spawnSync("gh", ["x"], { timeout: Math.min(CAP, ${ENV_MS}) });`),
    "Math.min whose env read is also read beside it": MOD(`const t = ${ENV_MS};\nspawnSync("gh", ["x"], { timeout: Math.min(t, 5_000) + t });`),
    "Math.max, which can only lengthen": MOD(`spawnSync("gh", ["x"], { timeout: Math.max(20_000, Number(process.env.X)) });`),
    "ternary on the env": MOD(`spawnSync("gh", ["x"], { timeout: process.env.SLOW ? 600_000 : 20_000 });`),
    "env-derived value to a funnel parameter": MOD(`${FUNNEL}\nrun("gh", ["x"], ${ENV_MS});`),
    "env-derived constant to a funnel parameter": MOD(`${FUNNEL}\nconst T = ${ENV_MS};\nrun("gh", ["x"], T);`),
    "env-derived value as a funnel's timeoutMs key": MOD(`function run(cmd, args, { timeoutMs } = {}) { return spawnSync(cmd, args, { timeout: timeoutMs }); }\nrun("gh", ["x"], { timeoutMs: ${ENV_MS} });`),
    "env-derived value in a funnel's opts": MOD(`async function tryRun(cmd, args, opts = {}) { return execFile(cmd, args, { ...opts }); }\nawait tryRun("gh", ["x"], { timeout: ${ENV_MS} });`, "execFile"),
    "funnel of a funnel": MOD(`${FUNNEL}\nfunction go(cmd, args, t) { return run(cmd, args, t); }\ngo("gh", ["x"], ${ENV_MS});`),
    "funnel default": MOD(`function run(cmd, args, timeoutMs = ${ENV_MS}) { return spawnSync(cmd, args, { timeout: timeoutMs }); }\nrun("gh", ["x"]);`),
    "parameter of the function holding the spawn": MOD(`function f(t) { return spawnSync("gh", ["x"], { timeout: t }); }\nf(${ENV_MS});`),
    "parameter of a function handed on as a callback": MOD(`function f(t) { return spawnSync("gh", ["x"], { timeout: t }); }\n[${ENV_MS}].forEach(f);`),
    "constant imported from another file": {
      "common.mjs": `export const SLOW_MS = ${ENV_MS};\n`,
      "x.mjs": MOD(`import { SLOW_MS } from "./common.mjs";\nspawnSync("gh", ["x"], { timeout: SLOW_MS });`),
    },
    "funnel imported from another file": {
      "common.mjs": MOD(FUNNEL).replace("function run", "export function run"),
      "x.mjs": `import { run } from "./common.mjs";\nrun("gh", ["x"], ${ENV_MS});\n`,
    },
  };
  for (const [name, src] of Object.entries(refused)) {
    assert.deepEqual(reaching(typeof src === "string" ? { "x.mjs": src } : src), [true], name);
  }
  // #4460. Each shape below is refused for one rule, and says so: its reason
  // holds `why`. A ceiling case floors its environment argument, a floor case
  // has the ceiling 20_000, so the other rule cannot be what refuses it.
  const reasoned = [
    // Rule 1: the ceiling.
    ["ceiling 1e12 written inline", MIN("1e12"), "ceiling"],
    ["ceiling 1e12 as a const", MIN("C", FLOORED, "const C = 1e12;\n"), "ceiling"],
    ["ceiling 1e12 imported", imports("export const C = 1e12;\n", MIN("C", FLOORED, `import { C } from "./common.mjs";\n`)), "ceiling"],
    ["Number.MAX_SAFE_INTEGER as the ceiling", MIN("Number.MAX_SAFE_INTEGER"), "ceiling"],
    ["Number.MAX_VALUE as the ceiling", MIN("Number.MAX_VALUE"), "ceiling"],
    ["Number.POSITIVE_INFINITY as the ceiling", MIN("Number.POSITIVE_INFINITY"), "ceiling"],
    ["2 ** 40 as the ceiling", MIN("2 ** 40"), "ceiling"],
    ["1e6 * 1e6 as the ceiling", MIN("1e6 * 1e6"), "ceiling"],
    ["Date.now() as the ceiling", MIN("Date.now()"), "ceiling"],
    ["a let set to 20_000 and later to 1e12", MIN("C", FLOORED, "let C = 20_000;\nC = 1e12;\n"), "ceiling"],
    ["a ceiling a compound assignment writes", MIN("C", FLOORED, "let C = 20_000;\nC += 1;\n"), "ceiling"],
    ["a funnel parameter one caller hands 1e12", MOD(`function ceil(cap) { return Math.min(cap, ${FLOORED}); }\nspawnSync("gh", ["a"], { timeout: ceil(20_000) });\nspawnSync("gh", ["b"], { timeout: ceil(1e12) });`), "ceiling"],
    ["ceiling 0", MIN("0"), "ceiling"],
    ["ceiling -1", MIN("-1"), "ceiling"],
    ["ceiling 300_001", MIN("300_001"), "ceiling"],
    ["a ceiling of more than 64 values", MIN(COMBINED, FLOORED, combinations(5)), "ceiling"],
    ["a ceiling key a ++ writes", MIN("L.gh", FLOORED, "const L = { gh: 60_000 };\nfor (let i = 0; i < 1e9; i++) L.gh++;\n"), "ceiling"],
    ["a ceiling key a prefix -- writes in bracket form", MIN("L.gh", FLOORED, "const L = { gh: 60_000 };\n--L[\"gh\"];\n"), "ceiling"],
    // Rule 2: the floor.
    ["Math.min of a literal ceiling and an env read", MIN("20_000", "Number(process.env.X)"), "floor"],
    ["ghBudget inside a Math.min ceiling", MIN("20_000", "ghBudget(Number(process.env.X), process.env.Y)"), "floor"],
    ["a Math.max(0, …) floor", MIN("20_000", "Math.max(0, Number(process.env.X))"), "floor"],
    ["a floor the environment feeds", MIN("20_000", "Math.max(F, Number(process.env.X))", "const F = Number(process.env.F);\n"), "floor"],
    ["a floor that is 0 at its smallest value", MIN("20_000", "Math.max(F, Number(process.env.X))", "let F = 1;\nF = 0;\n"), "floor"],
    ["a floor reassigned after its Math.max", MIN("20_000", "G", "let G = Math.max(1, Number(process.env.X));\nG = 0;\n"), "floor"],
    ["a ternary with one unfloored branch", MIN("20_000", "(process.env.Z ? Math.max(1, Number(process.env.X)) : Number(process.env.X))"), "floor"],
    ["a floor a -- writes", MIN("20_000", "F", "let F = Math.max(1, Number(process.env.X));\nF--;\n"), "floor"],
    ["a floor a compound assignment writes", MIN("20_000", "F", "let F = Math.max(1, Number(process.env.X));\nF -= Math.max(1, 2);\n"), "floor"],
    ["a floored parameter a -- writes", MOD(`function f(t) { t--; return spawnSync("gh", ["x"], { timeout: Math.min(20_000, t) }); }\nf(${FLOORED});`), "floor"],
    ["an imported floor a ++ writes", imports("export let F = Math.max(1, Number(process.env.X));\nexport function bump() { F++; }\n", MIN("20_000", "F", `import { F } from "./common.mjs";\n`)), "floor"],
    ["a floored parameter a compound assignment writes", MOD(`function f(t) { t -= 5; return spawnSync("gh", ["x"], { timeout: Math.min(20_000, t) }); }\nf(${FLOORED});`), "floor"],
    ["an imported floor a compound assignment writes", imports("export let F = Math.max(1, Number(process.env.X));\nconst G = Math.max(1, 2);\nexport function cut() { F -= G; }\n", MIN("20_000", "F", `import { F } from "./common.mjs";\n`)), "floor"],
    ["a floor written around the Math.min", READ("Math.max(1, Math.min(20_000, Number(process.env.X)))"), "floor"],
    // Rule 3: member reads.
    ["this.ms() in an object literal's method", MOD(`const CFG = { ms() { return 20_000; }, run() { return spawnSync("gh", ["x"], { timeout: this.ms() }); } };`), "this.ms"],
    ["this.ms() in a class method", MOD(`class C { ms() { return 20_000; } run() { return spawnSync("gh", ["x"], { timeout: this.ms() }); } }`), "this.ms"],
    ["a getter on an object literal", READ("CFG.ms", `const CFG = { ${ENV_GETTER} };\n`), "CFG.ms"],
    ["a getter on an imported object literal", imports(`export const CFG = { ${ENV_GETTER} };\n`, READ("CFG.ms", `import { CFG } from "./common.mjs";\n`)), "CFG.ms"],
    ["a getter added by Object.defineProperty", READ("CFG.ms", `const CFG = {};\nObject.defineProperty(CFG, "ms", { get() { return Number(process.env.X); } });\n`), "Object.defineProperty"],
    ["a prototype method, as new B().ms()", READ("new B().ms()", ENV_PROTO), "new B().ms"],
    ["a prototype method, through a name holding new B()", READ("b.ms()", `${ENV_PROTO}const b = new B();\n`), "b.ms"],
    ["Object.create(B.prototype).ms()", READ("Object.create(B.prototype).ms()", ENV_PROTO), "Object.create"],
    ["a name holding Object.create(B.prototype)", READ("o.ms()", `${ENV_PROTO}const o = Object.create(B.prototype);\n`), "o.ms"],
    ["an object literal's method beside an outer const of its name", READ("CFG.ms()", `const ms = 20_000;\nconst CFG = { ms() { return 1; } };\n`), "CFG.ms"],
    ["an imported object's method", imports(`export const CFG = { ms() { return 20_000; } };\n`, READ("CFG.ms()", `import { CFG } from "./common.mjs";\n`)), "CFG.ms"],
    ["a class's static method", READ("C.ms()", `class C { static ms() { return 20_000; } }\n`), "C.ms"],
    ["a class's instance method", READ("new C().ms()", `class C { ms() { return 20_000; } }\n`), "new C().ms"],
    ["a class's getter", READ("new C().ms", `class C { get ms() { return 20_000; } }\n`), "new C().ms"],
    ["a class's static getter", READ("C.ms", `class C { static get ms() { return 20_000; } }\n`), "C.ms"],
    ["a function's property", READ("f.ms", `function f() {}\nf.ms = 20_000;\n`), "f.ms"],
    ["a call result the sweep cannot open", READ("load().ms"), "load(…).ms"],
    ["a class expression handed to a parameter", MOD(`function f(C) { return spawnSync("gh", ["x"], { timeout: C.ms }); }\nf(class { static get ms() { return Number(process.env.X); } });`), "is a class"],
    ["a getter two keys down", READ("CFG.inner.ms", `const CFG = { inner: { ${ENV_GETTER} } };\n`), "CFG.inner.ms"],
    ["a getter added by Object.defineProperty two keys down", READ("CFG.inner.ms", `const IN = {};\nObject.defineProperty(IN, "ms", { get() { return Number(process.env.X); } });\nconst CFG = { inner: IN };\n`), "Object.defineProperty"],
    ["a getter read in bracket form", READ(`CFG["ms"]`, `const CFG = { ${ENV_GETTER} };\n`), `CFG["ms"]`],
    ["a prototype read in bracket form", READ(`CFG["ms"]`, `const P = { ${ENV_GETTER} };\nconst CFG = {};\nObject.setPrototypeOf(CFG, P);\n`), "Object.setPrototypeOf"],
    ["a bracket read of a computed key", READ("CFG[K]", `const K = "ms";\nconst CFG = { ms: 20_000 };\n`), "its key is computed"],
    // Rule 4: object entries, on a member read.
    ["a computed key", READ("CFG.ms", `const K = "ms";\nconst CFG = { [K]: Number(process.env.X) };\n`), "computed key"],
    ["a computed string key", READ("CFG.ms", `const CFG = { ["ms"]: Number(process.env.X) };\n`), "computed key"],
    ["a computed key after a plain one", READ("CFG.ms", `const CFG = { ms: 20_000, ["ms"]: Number(process.env.X) };\n`), "computed key"],
    ["a __proto__ entry", READ("CFG.ms", `const P = { ${ENV_GETTER} };\nconst CFG = { __proto__: P };\n`), "__proto__"],
    ["Object.setPrototypeOf", READ("CFG.ms", `const P = { ${ENV_GETTER} };\nconst CFG = {};\nObject.setPrototypeOf(CFG, P);\n`), "Object.setPrototypeOf"],
    ["CFG.__proto__ written", READ("CFG.ms", `const P = { ${ENV_GETTER} };\nconst CFG = { ms: 20_000 };\nCFG.__proto__ = P;\n`), "__proto__"],
    ["Object.defineProperty with a value", READ("CFG.ms", `const CFG = { ms: 20_000 };\nObject.defineProperty(CFG, "ms", { value: Number(process.env.X) });\n`), "Object.defineProperty"],
    ["Object.defineProperties", READ("CFG.ms", `const CFG = { ms: 20_000 };\nObject.defineProperties(CFG, { ms: { value: Number(process.env.X) } });\n`), "Object.defineProperties"],
    ["Reflect.defineProperty", READ("CFG.ms", `const CFG = { ms: 20_000 };\nReflect.defineProperty(CFG, "ms", { value: Number(process.env.X) });\n`), "Reflect.defineProperty"],
    ["Reflect.set", READ("CFG.ms", `const CFG = { ms: 20_000 };\nReflect.set(CFG, "ms", Number(process.env.X));\n`), "Reflect.set"],
    ["CFG.__defineGetter__", READ("CFG.ms", `const CFG = { ms: 20_000 };\nCFG.__defineGetter__("ms", () => Number(process.env.X));\n`), "__defineGetter__"],
    ["Object.assign of a getter", READ("CFG.ms", `const CFG = { ms: 20_000 };\nObject.assign(CFG, { ${ENV_GETTER} });\n`), "getter, setter or method"],
    ["Object.defineProperty on a parenthesised target", READ("CFG.ms", `const CFG = { ms: 20_000 };\nObject.defineProperty((CFG), "ms", { value: Number(process.env.X) });\n`), "Object.defineProperty"],
    ["Object.defineProperty called computed", READ("CFG.ms", `const CFG = { ms: 20_000 };\nObject["defineProperty"](CFG, "ms", { value: Number(process.env.X) });\n`), "Object[…]"],
    ["Reflect.set called computed", READ("CFG.ms", `const CFG = { ms: 20_000 };\nReflect["set"](CFG, "ms", Number(process.env.X));\n`), "Reflect[…]"],
    // Rule 4: object entries, in a gh spawn's own options.
    ["options holding a timeout and a getter of it", MOD(`spawnSync("gh", ["x"], { timeout: 20_000, get timeout() { return Number(process.env.X); } });`), "getter, setter or method"],
    ["options holding only a getter", MOD(`spawnSync("gh", ["x"], { get timeout() { return Number(process.env.X); } });`), "getter, setter or method"],
    ["options holding a timeout and a computed key", MOD(`spawnSync("gh", ["x"], { timeout: 20_000, ["timeout"]: Number(process.env.X) });`), "computed key"],
    ["options given a getter by Object.defineProperty", MOD(`const opts = { timeout: 20_000 };\nObject.defineProperty(opts, "timeout", { get() { return Number(process.env.X); } });\nspawnSync("gh", ["x"], opts);`), "Object.defineProperty"],
  ];
  for (const [name, src, why] of reasoned) {
    const { spawns } = sweep(typeof src === "string" ? { "x.mjs": src } : src);
    assert.ok(spawns.length > 0, name);
    for (const s of spawns) assert.ok(s.reaches.some((r) => r.includes(why)), `${name}: ${JSON.stringify(s.reaches)}`);
    // One rule per case: a ceiling case is no floor case, nor the reverse.
    for (const s of spawns) for (const other of ["ceiling", "floor"]) if (why !== other) assert.ok(!s.reaches.some((r) => r.includes(other)), `${name}: ${JSON.stringify(s.reaches)}`);
  }
  // A script that bounds one spawn through ghBudget() and another through a
  // differently named variable: only the second is refused.
  const beside = MOD(`${GH_BUDGET}const GH_TIMEOUT_MS = ghBudget(20, process.env.X_GH_TIMEOUT);\nspawnSync("gh", ["a"], { timeout: GH_TIMEOUT_MS });\nspawnSync("gh", ["b"], { timeout: Number(process.env.OTHER) * 1000 });`);
  assert.deepEqual(reaching({ "x.mjs": beside }), [false, true]);
  // The refusal names the spawn's file and line, and the read.
  const [spawn] = sweep({ "x.mjs": refused["constant fed by an env read"] }).spawns;
  assert.equal(spawn.where, "x.mjs:3");
  assert.deepEqual(spawn.reaches, ["reads process.env.TICKETLESS_TIMEOUT"]);
  // A name an import of node:process binds is a read of the env, not a name
  // the sweep cannot resolve.
  assert.deepEqual(sweep({ "x.mjs": refused["env imported under another name"] }).spawns[0].reaches, ["reads ENV.X"]);
});

test("the sweep accepts a gh timeout the environment can only shorten, and env reads that bound no gh call", () => {
  const accepted = {
    literal: MOD(`spawnSync("gh", ["x"], { timeout: 60_000 });`),
    "named literal constant": MOD(`const T = 20_000;\nspawnSync("gh", ["x"], { timeout: T });`),
    "arithmetic on literals": MOD(`const SECONDS = 20;\nspawnSync("gh", ["x"], { timeout: SECONDS * 1000 + 500 });`),
    "ghBudget with its env override": MOD(`${GH_BUDGET}const GH_TIMEOUT_MS = ghBudget(20, process.env.X_GH_TIMEOUT);\nspawnSync("gh", ["x"], { timeout: GH_TIMEOUT_MS });`),
    "ghBudget under any variable name": MOD(`${GH_BUDGET}const T = ghBudget(20, process.env.ANYTHING);\nspawnSync("gh", ["x"], { timeout: T });`),
    "ghBudget inline": MOD(`${GH_BUDGET}spawnSync("gh", ["x"], { timeout: ghBudget(20, process.env["X"]) });`),
    "a same-named env read in another function": MOD(`function wait() { const ms = Number(process.env.POLL_MS); return ms; }\nfunction read() { const ms = 20_000; return spawnSync("gh", ["x"], { timeout: ms }); }`),
    "an env read beside the bound in one object": MOD(`const CFG = { home: process.env.HOME, timeoutMs: 20_000 };\nspawnSync("gh", ["x"], { timeout: CFG.timeoutMs });`),
    "an options key the env feeds, other than the timeout": MOD(`const opts = { timeout: 20_000 };\nopts.cwd = process.env.HOME;\nspawnSync("gh", ["x"], opts);`),
    "a spread choosing an env-fed cwd": MOD(`function f(dir) { return spawnSync("gh", ["x"], { timeout: 20_000, ...(dir === null ? {} : { cwd: dir }) }); }\nf(process.env.HOME);`),
    "Math.min of a constant ceiling and an env deadline": MOD([
      `const NETWORK_TIMEOUT_MS = 120_000;`,
      `const deadline = Date.now() + Number(process.env.CALL_MS ?? 600_000);`,
      `const budget = () => Math.min(NETWORK_TIMEOUT_MS, Math.max(1, Math.floor(deadline - Date.now())));`,
      `function run(cmd, args, { cwd, env, timeoutMs } = {}) { return spawnSync(cmd, args, { cwd, env, timeout: timeoutMs }); }`,
      `run("gh", ["x"], { cwd: "/", env: { ...process.env, GH_REPO: "" }, timeoutMs: budget() });`,
    ].join("\n")),
    "env spread next to a literal timeout": MOD(`spawnSync("gh", ["x"], { env: { ...process.env, GH_REPO: "" }, timeout: 20_000 });`),
    "env reads that feed nothing the timeout reads": MOD(`const home = process.env.HOME;\nconst repo = process.env["GH_REPO"];\nspawnSync("gh", ["x"], { cwd: home, env: process.env, timeout: 20_000 });`),
    "funnel handed a literal": MOD(`${FUNNEL}\nrun("gh", ["x"], 20_000);`),
    "funnel handed a ghBudget": MOD(`${GH_BUDGET}${FUNNEL}\nrun("gh", ["x"], ghBudget(20, process.env.X_GH_TIMEOUT));`),
    "funnel timeoutMs key, literal": MOD(`function run(cmd, args, { timeoutMs } = {}) { return spawnSync(cmd, args, { timeout: timeoutMs }); }\nrun("gh", ["x"], { timeoutMs: 20_000 });`),
    "funnel opts, literal": MOD(`async function tryRun(cmd, args, opts = {}) { return execFile(cmd, args, { ...opts }); }\nawait tryRun("gh", ["x"], { timeout: 20_000 });`, "execFile"),
    "funnel with a literal default": MOD(`function run(cmd, args, timeoutMs = 20_000) { return spawnSync(cmd, args, { timeout: timeoutMs }); }\nrun("gh", ["x"]);`),
    "funnel whose env-fed default is overridden": MOD(`function run(cmd, args, timeoutMs = ${ENV_MS}) { return spawnSync(cmd, args, { timeout: timeoutMs }); }\nrun("gh", ["x"], 20_000);`),
    "constant imported from another file": {
      "common.mjs": `export const T = 20_000;\n`,
      "x.mjs": MOD(`import { T } from "./common.mjs";\nspawnSync("gh", ["x"], { timeout: T });`),
    },
    // #4460.
    "Math.min of a ceiling and a floored env read": MIN("20_000"),
    "Math.min of a ceiling and a floored ghBudget": MIN("20_000", "Math.max(1, ghBudget(Number(process.env.X), process.env.Y))"),
    "Math.min of a ceiling and a ghBudget": MOD(`${GH_BUDGET}spawnSync("gh", ["x"], { timeout: Math.min(20_000, ghBudget(20, process.env.Y)) });`),
    "Math.min with a huge ceiling beside an in-range one": MIN("1e12, 20_000"),
    "Math.min with its ceiling exactly at the cap": MIN("300_000"),
    "a floor with several values, each at least 1": MIN("20_000", "Math.max(F, Number(process.env.X))", "let F = 1;\nF = 5;\n"),
    "a ceiling given as arithmetic on literals": MIN("CEIL", FLOORED, "const CEIL = 2 * 60_000;\n"),
    "a ceiling imported": imports("export const CEIL = 2 * 60_000;\n", MIN("CEIL", FLOORED, `import { CEIL } from "./common.mjs";\n`)),
    "a ceiling an object literal holds": MIN("LIMITS.gh", FLOORED, "const LIMITS = { gh: 20_000 };\n"),
    "a member read through a funnel parameter": MOD(`function f(o) { return spawnSync("gh", ["x"], { timeout: o.t }); }\nf({ t: 20_000 });`),
    "Object.assign with the options only a source": MOD(`const opts = { timeout: 20_000 };\nconst copy = Object.assign({}, opts);\nspawnSync("gh", ["x"], opts);`),
    "a getter on another key of the object read": READ("CFG.ms", `const CFG = { ms: 20_000, get other() { return Number(process.env.X); } };\n`),
    "an unrelated object handed to Object.freeze": READ("CFG.ms", `const OTHER = { a: 1 };\nObject.freeze(OTHER);\nconst CFG = { ms: 20_000 };\n`),
    "a ceiling of exactly 64 values": MIN(COMBINED, FLOORED, combinations(4)),
    "a ++ on another key of the ceiling's object": MIN("L.gh", FLOORED, "const L = { gh: 60_000, n: 0 };\nL.n++;\n"),
    "a -- on another name than the floor": MIN("20_000", "F", "let F = Math.max(1, Number(process.env.X));\nlet G = 1;\nG--;\n"),
    "a getter two keys down beside the plain value read": READ("CFG.inner.ms", `const CFG = { inner: { ms: 20_000 }, other: { ${ENV_GETTER} } };\n`),
    "a number-literal key beside the one read": READ("CFG.ms", `const CFG = { 1.5: 2, ms: 20_000 };\n`),
    "a shorthand __proto__, an own key and no prototype": READ("CFG.ms", `const __proto__ = { a: 1 };\nconst CFG = { __proto__, ms: 20_000 };\n`),
    // #4484: each works out to a number from 1 to the cap.
    "ghBudget(30, env)": MOD(`${GH_BUDGET}spawnSync("gh", ["x"], { timeout: ghBudget(30, process.env.X_GH_TIMEOUT) });`),
    "ghBudget at the cap": MOD(`${GH_BUDGET}spawnSync("gh", ["x"], { timeout: ghBudget(300, process.env.X) });`),
    "ghBudget seconds from a constant": MOD(`${GH_BUDGET}const SECONDS = 2 * 15;\nconst T = ghBudget(SECONDS, process.env.X);\nspawnSync("gh", ["x"], { timeout: T });`),
    "ghBudget with arithmetic beside it": MOD(`${GH_BUDGET}spawnSync("gh", ["x"], { timeout: ghBudget(20, process.env.X) + 500 });`),
    "ghBudget with no override": MOD(`${GH_BUDGET}spawnSync("gh", ["x"], { timeout: ghBudget(20) });`),
    "ghBudget as a Math.min ceiling": MIN("ghBudget(20, process.env.Y)"),
    "Math.min of two literals": READ("Math.min(20_000, 5_000)"),
    "Math.min with a value above the cap beside a ceiling": READ("Math.min(1e12, 20_000)"),
    "Math.min of a Math.min": READ("Math.min(Math.min(20_000, 5_000), 30_000)"),
    "a helper handed nothing": READ("ms()", "const ms = () => 20_000;\n"),
    "a helper with a return in each branch": READ("ms()", "function ms() { if (process.platform === \"win32\") { return 60_000; } return 20_000; }\n"),
    "a helper in another file": imports("export const ms = () => 20_000;\n", READ("ms()", `import { ms } from "./common.mjs";\n`)),
    "a helper returning a ghBudget": READ("ms()", `${GH_BUDGET}const ms = () => ghBudget(20, process.env.X);\n`),
    "a helper returning a closeout-style budget": MOD([
      `const CEIL = 120_000;`,
      `const deadline = Date.now() + Number(process.env.CALL_MS ?? 600_000);`,
      `const budget = () => Math.min(CEIL, Math.max(1, Math.floor(deadline - Date.now())));`,
      `spawnSync("gh", ["x"], { timeout: budget() });`,
    ].join("\n")),
  };
  for (const [name, src] of Object.entries(accepted)) {
    const sources = typeof src === "string" ? { "x.mjs": src } : src;
    assert.deepEqual(reaching(sources), [false], name);
    assert.deepEqual(outside(sources), [false], name);
  }
  // A funnel handed a ghBudget at one call and a literal at another.
  const funnelled = MOD(`${GH_BUDGET}${FUNNEL}\nrun("gh", ["a"], ghBudget(30, process.env.X));\nrun("gh", ["b"], 20_000);`);
  assert.deepEqual(outside({ "x.mjs": funnelled }), [false, false]);
  // An env-fed bound on a git call, through the funnel a literal-bound gh call
  // shares, is no gh bound.
  const git = MOD(`${FUNNEL}\nrun("git", ["x"], ${ENV_MS});\nrun("gh", ["x"], 20_000);`);
  assert.deepEqual(reaching({ "x.mjs": git }), [false]);
  const ledger = MOD(`const LEDGER_LOCK_TIMEOUT_MS = ${ENV_MS};\nspawnSync("git", ["x"], { timeout: LEDGER_LOCK_TIMEOUT_MS });\nspawnSync("gh", ["x"], { timeout: 20_000 });`);
  assert.deepEqual(reaching({ "x.mjs": ledger }), [false]);
});

// #4484. A gh timeout works out to a number from 1 to CEILING_CAP even where
// the environment plays no part: Node reads a timeout of 0 as none, and one of
// 1e12 ms never fires. A value the evaluator cannot work out is refused, as is
// a spawn with no timeout value at all.
test("every gh spawn's timeout works out to a number from 1 to the cap", () => {
  const { spawns } = sweep(readScripts());
  assert.ok(spawns.length > 0);
  assert.deepEqual(spawns.flatMap((s) => s.range.map((why) => `${s.where} ${why}`)), []);
});

test("a gh timeout of 1e12 or 0 in a script turns the sweep red", () => {
  const scripts = readScripts();
  const decl = "const READ_TIMEOUT_MS = 60_000;";
  assert.ok(scripts["ticketless.mjs"].includes(decl), "ticketless.mjs no longer declares READ_TIMEOUT_MS as 60_000");
  // Every other test here sweeps the script as it stands; this one sweeps it
  // changed.
  const ours = (files) => sweep(files).spawns.filter((s) => s.where.startsWith("ticketless.mjs:"));
  for (const ms of ["1e12", "0"]) {
    const changed = { ...scripts, "ticketless.mjs": scripts["ticketless.mjs"].replace(decl, `const READ_TIMEOUT_MS = ${ms};`) };
    assert.ok(ours(changed).some((s) => s.range.length > 0), `READ_TIMEOUT_MS = ${ms}`);
  }
});

test("the sweep refuses a gh timeout that works out to no number from 1 to the cap, the environment aside", () => {
  const refused = {
    "timeout 1e12": READ("1e12"),
    "timeout one above the cap": READ("300_001"),
    "timeout 0": READ("0"),
    "timeout -1": READ("-1"),
    "timeout null": READ("null"),
    "timeout undefined": READ("undefined"),
    "timeout Infinity": READ("Infinity"),
    "a constant of 1e12": READ("T", "const T = 1e12;\n"),
    "a constant of 0": READ("T", "const T = 0;\n"),
    "a constant imported as 1e12": imports("export const T = 1e12;\n", READ("T", `import { T } from "./common.mjs";\n`)),
    "a timeout of 0 chosen by a condition": READ(`process.platform === "win32" ? 20_000 : 0`),
    "ghBudget(1e9, env), a default of 1e9 s": MOD(`${GH_BUDGET}spawnSync("gh", ["x"], { timeout: ghBudget(1e9, process.env.X) });`),
    "ghBudget(301, env), one second above the cap": MOD(`${GH_BUDGET}spawnSync("gh", ["x"], { timeout: ghBudget(301, process.env.X) });`),
    "ghBudget(0, env)": MOD(`${GH_BUDGET}spawnSync("gh", ["x"], { timeout: ghBudget(0, process.env.X) });`),
    "ghBudget seconds that can be 0": MOD(`${GH_BUDGET}let S = 0;\nS = 20;\nspawnSync("gh", ["x"], { timeout: ghBudget(S, process.env.X) });`),
    "ghBudget handed no seconds": MOD(`${GH_BUDGET}spawnSync("gh", ["x"], { timeout: ghBudget() });`),
    "ghBudget the script declares itself": MOD(`function ghBudget(s) { return 0; }\nspawnSync("gh", ["x"], { timeout: ghBudget(20) });`),
    "Math.min(20_000, 0)": READ("Math.min(20_000, 0)"),
    "Math.min(20_000, -1)": READ("Math.min(20_000, -1)"),
    "Math.min of two values above the cap": READ("Math.min(1e12, 2e12)"),
    "Math.min of no arguments": READ("Math.min()"),
    "Math.min beside a value that works out to nothing": READ("Math.min(20_000, Date.now())"),
    "a helper that returns 0": READ("ms()", "const ms = () => 0;\n"),
    "a helper that returns 20_000 or 0": READ("ms()", "function ms() { if (process.platform === \"win32\") { return 20_000; } return 0; }\n"),
    "a helper that returns 1e12": READ("ms()", "function ms() { return 1e12; }\n"),
    "a helper handed an argument": READ("ms(20_000)", "const ms = (n) => n;\n"),
    "a helper with a parameter, handed nothing": READ("ms()", "const ms = (n = 20_000) => n;\n"),
    "a helper that returns nothing": READ("ms()", "function ms() {}\n"),
    "funnel handed 0": MOD(`${FUNNEL}\nrun("gh", ["x"], 0);`),
    "funnel handed null": MOD(`${FUNNEL}\nrun("gh", ["x"], null);`),
    "funnel handed undefined": MOD(`${FUNNEL}\nrun("gh", ["x"], undefined);`),
    "funnel handed Infinity": MOD(`${FUNNEL}\nrun("gh", ["x"], Infinity);`),
    "funnel handed 1e12": MOD(`${FUNNEL}\nrun("gh", ["x"], 1e12);`),
    "funnel handed no timeout": MOD(`${FUNNEL}\nrun("gh", ["x"]);`),
    "funnel of a funnel handed 0": MOD(`${FUNNEL}\nfunction go(cmd, args, t) { return run(cmd, args, t); }\ngo("gh", ["x"], 0);`),
    "funnel whose default is 1e12": MOD(`function run(cmd, args, timeoutMs = 1e12) { return spawnSync(cmd, args, { timeout: timeoutMs }); }\nrun("gh", ["x"]);`),
    "funnel whose default is 0": MOD(`function run(cmd, args, timeoutMs = 0) { return spawnSync(cmd, args, { timeout: timeoutMs }); }\nrun("gh", ["x"]);`),
    "funnel options without a timeoutMs key": MOD(`function run(cmd, args, { timeoutMs } = {}) { return spawnSync(cmd, args, { timeout: timeoutMs }); }\nrun("gh", ["x"], { cwd: "/" });`),
    "funnel options left out": MOD(`function run(cmd, args, { timeoutMs } = {}) { return spawnSync(cmd, args, { timeout: timeoutMs }); }\nrun("gh", ["x"]);`),
    "funnel timeoutMs key of 0": MOD(`function run(cmd, args, { timeoutMs } = {}) { return spawnSync(cmd, args, { timeout: timeoutMs }); }\nrun("gh", ["x"], { timeoutMs: 0 });`),
    "funnel opts without a timeout": MOD(`async function tryRun(cmd, args, opts = {}) { return execFile(cmd, args, { ...opts }); }\nawait tryRun("gh", ["x"], { encoding: "utf8" });`, "execFile"),
    "funnel opts with a timeout of 1e12": MOD(`async function tryRun(cmd, args, opts = {}) { return execFile(cmd, args, { ...opts }); }\nawait tryRun("gh", ["x"], { timeout: 1e12 });`, "execFile"),
    "funnel imported from another file, handed 0": {
      "common.mjs": MOD(FUNNEL).replace("function run", "export function run"),
      "x.mjs": `import { run } from "./common.mjs";\nrun("gh", ["x"], 0);\n`,
    },
  };
  for (const [name, src] of Object.entries(refused)) {
    const sources = typeof src === "string" ? { "x.mjs": src } : src;
    assert.deepEqual(reaching(sources), [false], `${name}: the environment plays no part`);
    assert.deepEqual(outside(sources), [true], name);
  }
  // Every value is refused, not only the first: one caller handing 0 is
  // refused beside another handing 20_000, the other call is not.
  const two = MOD(`${FUNNEL}\nrun("gh", ["a"], 20_000);\nrun("gh", ["b"], 0);`);
  assert.deepEqual(outside({ "x.mjs": two }), [false, true]);
  const one = MOD(`function f(t) { return spawnSync("gh", ["x"], { timeout: t }); }\nf(20_000);\nf(0);`);
  assert.deepEqual(outside({ "x.mjs": one }), [true]);
  // The refusal says which: no value, one that works out to nothing, or one
  // outside the range, the value named.
  const why = (src) => sweep({ "x.mjs": src }).spawns[0].range;
  assert.deepEqual(why(refused["timeout 1e12"]), [`takes a timeout that can be 1000000000000, outside 1 to ${CEILING_CAP}`]);
  assert.deepEqual(why(refused["timeout 0"]), [`takes a timeout that can be 0, outside 1 to ${CEILING_CAP}`]);
  assert.deepEqual(why(refused["Math.min(20_000, 0)"]), ["takes a timeout that does not work out to a number: Math.min(20_000, 0)"]);
  assert.deepEqual(why(refused["funnel opts without a timeout"]), ["takes no timeout value"]);
});

// A value the evaluator cannot reduce counts as no number: the sweep fails
// closed, as #4460 ruled for a ceiling. Each shape below is in range whatever
// it chooses, and refused all the same until numbers() learns it.
test("the sweep refuses a gh timeout it cannot work out to a number, though every value of it is in range", () => {
  const unreduced = {
    "a ternary of two numbers in range": MOD(`spawnSync("gh", ["x"], { timeout: process.platform === "win32" ? 60_000 : 20_000 });`),
    "a ternary on an imported process": MOD(`import proc from "node:process";\nspawnSync("gh", ["x"], { timeout: proc.platform === "win32" ? 60_000 : 20_000 });`),
    "a helper that calls itself": MOD(`function s() { return s() + 1; }\nspawnSync("gh", ["x"], { timeout: s() });`),
    "a member read of a helper's returned literal": READ("cfg().ms", `const cfg = () => ({ ms: 20_000 });\n`),
    "a plain value read in bracket form": READ(`CFG["ms"]`, `const CFG = { ms: 20_000 };\n`),
    "a ceiling that is 0 in one of its values": MIN("CEIL", FLOORED, "let CEIL = 0;\nCEIL = 20_000;\n"),
    "a parameter nobody hands a value": MOD(`export function read(n, { timeoutMs }) { return spawnSync("gh", ["x"], { timeout: timeoutMs }); }`),
    "a shorthand parameter nobody hands a value": MOD(`function f(timeout) { return spawnSync("gh", ["x"], { encoding: "utf8", timeout }); }`),
  };
  for (const [name, src] of Object.entries(unreduced)) {
    assert.deepEqual(reaching({ "x.mjs": src }), [false], `${name}: the environment plays no part`);
    assert.deepEqual(outside({ "x.mjs": src }), [true], name);
  }
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
