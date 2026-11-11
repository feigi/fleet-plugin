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
// #4446. The bound must also be one the environment cannot lengthen, under
// any variable name: each gh spawn's timeout expression is traced (tracer(),
// below), and the spawn refused when it reaches `process.env` other than
// through ghBudget() or a Math.min() with a ceiling the environment does not
// feed. A read that reaches no gh timeout (HOME, GH_REPO, `env: { ...process.env }`,
// a git bound) is not looked at.
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

  return { file, code, skel, primitives, imports, fns, calls, carries, within, encl, loopLiterals, problems };
}

// Whether the environment can reach a gh spawn's timeout, decided on the
// expression that supplies it and never on the name of anything it reads.
//
// A bound is lengthened from the environment when `process.env` (dot form,
// bracket form, a bare `process`) is reached from the timeout expression:
// directly, through a constant or reassigned variable this file declares or
// imports, through a local helper's return, or through a funnel parameter,
// where every value a call hands the funnel is judged the same way. Two
// shapes cannot lengthen a bound whatever they read, and are not entered:
// arg.mjs's `ghBudget(seconds, override)`, whose `override` only ever
// shortens it (its `seconds` is still judged), and a `Math.min(…)` with an
// argument that is itself clear of the environment, a ceiling the rest can
// only shorten, as closeout.mjs's remaining-time budget() is.
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
  // Every expression this file gives `id`: `id = …` (a declaration, a
  // reassignment, a destructuring default) and `const { id } = …`.
  const declRefs = (mod, id) => {
    const e = escape(id);
    const out = [];
    const forms = [
      `(?<![\\w$.])${e}\\s*=(?![=>])\\s*`,
      `\\b(?:const|let|var)\\s*(?:\\{[^{}]*(?<![\\w$.])${e}\\b[^{}]*\\}|\\[[^\\[\\]]*(?<![\\w$.])${e}\\b[^\\[\\]]*\\])\\s*=(?![=>])\\s*`,
    ];
    for (const form of forms) {
      for (const m of mod.skel.matchAll(new RegExp(form, "g"))) {
        const a = m.index + m[0].length;
        out.push(refOf(mod, a, exprEnd(mod.skel, a, true)));
      }
    }
    return out;
  };
  // Run `visit` on every value `id` can hold where `ref` reads it, once per
  // name along a path so a variable that feeds itself ends the walk.
  const viaId = (ref, id, bind, seen, visit) => {
    const { mod } = ref;
    const once = (key, refs) => {
      if (seen.has(key)) return [];
      seen.add(key);
      try { return refs().flatMap(visit); } finally { seen.delete(key); }
    };
    for (const fn of mod.encl(ref.at)) {
      const b = paramBinding(fn, id);
      if (b === null) continue;
      return once(`${mod.file}#${fn.name}#${id}`, () => {
        const local = b.prop ? b.prop.local : b.p.name;
        const provided = bind.get(fn)?.get(local);
        const refs = [];
        if (provided !== undefined) refs.push(...provided);
        else {
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
    }
    const helper = resolve(mod, id);
    if (helper !== null) return once(`${helper.mod.file}#${helper.name}`, () => returnsOf(helper.mod, helper.mod.fns.get(helper.name)));
    const own = declRefs(mod, id);
    if (own.length > 0) return once(`${mod.file}=${id}`, () => own);
    const imp = mod.imports.get(id);
    const from = imp && mods.get(imp.module.slice(2));
    if (from) return once(`${from.file}=${imp.name}`, () => declRefs(from, imp.name));
    if (id === "env" && /\bfrom\s*["'](?:node:)?process["']/.test(mod.code)) return visit({ ...ref, skel: "process.env", code: "process.env" });
    return [];
  };
  // The expressions `key` can be given in the options object `ref` reads as:
  // an object literal, its spreads, a variable or parameter holding one.
  const keyValues = (ref, key, bind, seen) => {
    const s = ref.skel;
    if (s.startsWith("{")) {
      if (closing(s, 0) !== s.length - 1) return [];
      const out = [];
      for (const p of pieces(s, ref.code, 0)) {
        if (p.skel.startsWith("...")) {
          out.push(...keyValues({ ...ref, skel: p.skel.slice(3).trim(), code: p.code.slice(3).trim() }, key, bind, seen));
          continue;
        }
        const m = p.code.match(/^(["']?)([\w$]+)\1\s*(:?)/);
        if (m === null || m[2] !== key) continue;
        out.push(m[3] === "" ? { ...ref, skel: key, code: key } : { ...ref, skel: p.skel.slice(m[0].length).trim(), code: p.code.slice(m[0].length).trim() });
      }
      return out;
    }
    if (/^[\w$]+$/.test(s)) return viaId(ref, s, bind, seen, (r) => keyValues(r, key, bind, seen));
    return [];
  };
  // How the environment reaches the value `ref` reads: one reason per read.
  const judge = (ref, bind, seen) => {
    const hide = ref.skel.split("");
    const reasons = [];
    const part = (p) => ({ ...ref, skel: p.skel, code: p.code });
    for (const m of ref.skel.matchAll(/(?<![\w$.])(ghBudget|Math\s*\.\s*min)\s*\(/g)) {
      if (hide[m.index] === " ") continue;
      const open = m.index + m[0].length - 1;
      const args = pieces(ref.skel, ref.code, open);
      if (m[1] === "ghBudget") {
        if (args.length > 0) reasons.push(...judge(part(args[0]), bind, seen));
      } else if (!args.some((a) => judge(part(a), bind, seen).length === 0)) continue;
      for (let k = m.index; k <= closing(ref.skel, open); k++) hide[k] = " ";
    }
    const rest = hide.join("");
    for (const m of rest.matchAll(/(?<![\w$.])[A-Za-z_$][\w$]*/g)) {
      if (m[0] !== "process") {
        reasons.push(...viaId(ref, m[0], bind, seen, (r) => judge(r, bind, seen)));
        continue;
      }
      const next = rest.slice(m.index + m[0].length).match(/^\s*(?:\?\.|\.)\s*([\w$]+)/);
      if (next !== null && next[1] !== "env") continue;
      reasons.push(`reads ${ref.code.slice(m.index).match(/^process(?:\s*(?:\?\.|\.)\s*env(?:\s*\??\.?\s*(?:[\w$]+|\[[^\]]*\]))?|\s*\[[^\]]*\])?/)[0]}`);
    }
    return reasons;
  };
  // Every reason the environment reaches the timeout of the spawn call `c`
  // whose command is argument `cmdAt`: its own `timeout` (and, to a funnel,
  // `timeoutMs`), then the calls the funnel makes in turn, each with the
  // funnel's parameters bound to what `c` handed it.
  const walk = (mod, c, cmdAt, bind) => {
    const reasons = [];
    const primitive = mod.primitives.has(c.callee);
    c.args.forEach((_, i) => {
      const arg = argRef(mod, c, i);
      if (i === cmdAt || arg === null) return;
      for (const key of primitive ? ["timeout"] : ["timeout", "timeoutMs"]) {
        for (const v of keyValues(arg, key, bind, new Set())) reasons.push(...judge(v, bind, new Set()));
      }
    });
    if (primitive) return reasons;
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
      reasons.push(...walk(target.mod, ic, inner.index, inside));
    }
    return reasons;
  };
  return (mod, c, cmdAt) => [...new Set(walk(mod, c, cmdAt, new Map()))];
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
        spawns.push({ where, bounded: spawn.bounded, reaches: reaches(mod, c, spawn.index) });
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
    "timeoutMs parameter": MOD(`export function read(n, { timeoutMs }) { return spawnSync("gh", ["x"], { timeout: timeoutMs }); }`),
    shorthand: MOD(`function f(timeout) { return spawnSync("gh", ["x"], { encoding: "utf8", timeout }); }`),
    "options object with one": MOD(`function f() { const opts = { encoding: "utf8", timeout: READ_TIMEOUT_MS };\nreturn execFileSync("gh", ["x"], opts); }`),
    "spread plus a bound": MOD(`const CHILD = { encoding: "utf8" };\nspawnSync("gh", ["x"], { ...CHILD, timeout: 30_000 });`),
    "bounded funnel": MOD(`function spawn(cmd, args) { return execFileSync(cmd, args, { timeout: T }); }\nfunction run(cmd, args) { return spawn(cmd, args); }\nrun(\n  "gh",\n  ["x"],\n);`),
    "funnel bounded at the call": MOD(`async function tryRun(cmd, args, opts = {}) { return execFile(cmd, args, { ...opts }); }\nawait tryRun("gh", ["x"], { timeout: T });`, "execFile"),
  };
  for (const [name, src] of Object.entries(accepted)) assert.deepEqual(verdicts({ "x.mjs": src }), [true], name);
  for (const [name, src] of Object.entries(accepted)) assert.deepEqual(reaching({ "x.mjs": src }), [false], name);
  // Not gh, so nothing to bound: a sibling script, node itself, git, a funnel
  // only ever handed another command.
  const notGh = MOD(`spawnSync(process.execPath, [join(SCRIPT_DIR, "x.mjs")]);\nspawnSync("git", ["status"]);\nspawnSync("git", ["log", "--author", "gh"]);\nspawnSync(join(SCRIPT_DIR, "x.sh"));\nfunction run(cmd, a) { return spawnSync(cmd, a); }\nrun("sh", ["y"]);`);
  assert.deepEqual(sweep({ "x.mjs": notGh }), { spawns: [], problems: [] });
});

// #4446. A timeout the environment can lengthen is refused whatever the
// variable is called, wherever the read sits on the way to the spawn.
const FUNNEL = `function run(cmd, args, timeoutMs) { return spawnSync(cmd, args, { timeout: timeoutMs }); }`;
const ENV_MS = "Number(process.env.TICKETLESS_TIMEOUT ?? 60) * 1000";

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
    "constant through a local helper": MOD(`function seconds() { return Number(process.env.X); }\nconst T = seconds() * 1000;\nspawnSync("gh", ["x"], { timeout: T });`),
    "arrow helper": MOD(`const ms = () => Number(process.env.X);\nspawnSync("gh", ["x"], { timeout: ms() });`),
    "options object declared in the file": MOD(`const OPTS = { timeout: ${ENV_MS} };\nspawnSync("gh", ["x"], OPTS);`),
    "options object spread": MOD(`const OPTS = { timeout: ${ENV_MS} };\nspawnSync("gh", ["x"], { ...OPTS });`),
    "ghBudget whose ceiling is an env read": MOD(`const T = ghBudget(Number(process.env.X), process.env.X_GH_TIMEOUT);\nspawnSync("gh", ["x"], { timeout: T });`),
    "Math.min with no ceiling clear of the env": MOD(`spawnSync("gh", ["x"], { timeout: Math.min(Number(process.env.A), Number(process.env.B)) });`),
    "Math.max, which can only lengthen": MOD(`spawnSync("gh", ["x"], { timeout: Math.max(20_000, Number(process.env.X)) });`),
    "ternary on the env": MOD(`spawnSync("gh", ["x"], { timeout: process.env.SLOW ? 600_000 : 20_000 });`),
    "env-derived value to a funnel parameter": MOD(`${FUNNEL}\nrun("gh", ["x"], ${ENV_MS});`),
    "env-derived constant to a funnel parameter": MOD(`${FUNNEL}\nconst T = ${ENV_MS};\nrun("gh", ["x"], T);`),
    "env-derived value as a funnel's timeoutMs key": MOD(`function run(cmd, args, { timeoutMs } = {}) { return spawnSync(cmd, args, { timeout: timeoutMs }); }\nrun("gh", ["x"], { timeoutMs: ${ENV_MS} });`),
    "env-derived value in a funnel's opts": MOD(`async function tryRun(cmd, args, opts = {}) { return execFile(cmd, args, { ...opts }); }\nawait tryRun("gh", ["x"], { timeout: ${ENV_MS} });`, "execFile"),
    "funnel of a funnel": MOD(`${FUNNEL}\nfunction go(cmd, args, t) { return run(cmd, args, t); }\ngo("gh", ["x"], ${ENV_MS});`),
    "funnel default": MOD(`function run(cmd, args, timeoutMs = ${ENV_MS}) { return spawnSync(cmd, args, { timeout: timeoutMs }); }\nrun("gh", ["x"]);`),
    "parameter of the function holding the spawn": MOD(`function f(t) { return spawnSync("gh", ["x"], { timeout: t }); }\nf(${ENV_MS});`),
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
  // A script that bounds one spawn through ghBudget() and another through a
  // differently named variable: only the second is refused.
  const beside = MOD(`const GH_TIMEOUT_MS = ghBudget(20, process.env.X_GH_TIMEOUT);\nspawnSync("gh", ["a"], { timeout: GH_TIMEOUT_MS });\nspawnSync("gh", ["b"], { timeout: Number(process.env.OTHER) * 1000 });`);
  assert.deepEqual(reaching({ "x.mjs": beside }), [false, true]);
  // The refusal names the spawn's file and line, and the read.
  const [spawn] = sweep({ "x.mjs": refused["constant fed by an env read"] }).spawns;
  assert.equal(spawn.where, "x.mjs:3");
  assert.deepEqual(spawn.reaches, ["reads process.env.TICKETLESS_TIMEOUT"]);
});

test("the sweep accepts a gh timeout the environment can only shorten, and env reads that bound no gh call", () => {
  const accepted = {
    literal: MOD(`spawnSync("gh", ["x"], { timeout: 60_000 });`),
    "named literal constant": MOD(`const T = 20_000;\nspawnSync("gh", ["x"], { timeout: T });`),
    "arithmetic on literals": MOD(`const SECONDS = 20;\nspawnSync("gh", ["x"], { timeout: SECONDS * 1000 + 500 });`),
    "ghBudget with its env override": MOD(`const GH_TIMEOUT_MS = ghBudget(20, process.env.X_GH_TIMEOUT);\nspawnSync("gh", ["x"], { timeout: GH_TIMEOUT_MS });`),
    "ghBudget under any variable name": MOD(`const T = ghBudget(20, process.env.ANYTHING);\nspawnSync("gh", ["x"], { timeout: T });`),
    "ghBudget inline": MOD(`spawnSync("gh", ["x"], { timeout: ghBudget(20, process.env["X"]) });`),
    "Math.min of a literal ceiling and an env read": MOD(`spawnSync("gh", ["x"], { timeout: Math.min(20_000, Number(process.env.X)) });`),
    "Math.min of a constant ceiling and an env deadline": MOD([
      `const NETWORK_TIMEOUT_MS = 120_000;`,
      `const deadline = Date.now() + Number(process.env.CALL_MS ?? 600_000);`,
      `const budget = () => Math.min(NETWORK_TIMEOUT_MS, Math.max(1, Math.floor(deadline - Date.now())));`,
      `function run(cmd, args, { cwd, env, timeoutMs } = {}) { return spawnSync(cmd, args, { cwd, env, timeout: timeoutMs }); }`,
      `run("gh", ["x"], { cwd: "/", env: { ...process.env, GH_REPO: "" }, timeoutMs: budget() });`,
    ].join("\n")),
    "env spread next to a literal timeout": MOD(`spawnSync("gh", ["x"], { env: { ...process.env, GH_REPO: "" }, timeout: 20_000 });`),
    "env reads that feed nothing the timeout reads": MOD(`const home = process.env.HOME;\nconst repo = process.env["GH_REPO"];\nspawnSync("gh", ["x"], { cwd: home, env: process.env, timeout: 20_000 });`),
    "process members that are not the env": MOD(`spawnSync("gh", ["x"], { timeout: process.platform === "win32" ? 60_000 : 20_000 });`),
    "funnel handed a literal": MOD(`${FUNNEL}\nrun("gh", ["x"], 20_000);`),
    "funnel handed a ghBudget": MOD(`${FUNNEL}\nrun("gh", ["x"], ghBudget(20, process.env.X_GH_TIMEOUT));`),
    "funnel timeoutMs key, literal": MOD(`function run(cmd, args, { timeoutMs } = {}) { return spawnSync(cmd, args, { timeout: timeoutMs }); }\nrun("gh", ["x"], { timeoutMs: 20_000 });`),
    "funnel opts, literal": MOD(`async function tryRun(cmd, args, opts = {}) { return execFile(cmd, args, { ...opts }); }\nawait tryRun("gh", ["x"], { timeout: 20_000 });`, "execFile"),
    "funnel with a literal default": MOD(`function run(cmd, args, timeoutMs = 20_000) { return spawnSync(cmd, args, { timeout: timeoutMs }); }\nrun("gh", ["x"]);`),
    "funnel whose env-fed default is overridden": MOD(`function run(cmd, args, timeoutMs = ${ENV_MS}) { return spawnSync(cmd, args, { timeout: timeoutMs }); }\nrun("gh", ["x"], 20_000);`),
    "constant imported from another file": {
      "common.mjs": `export const T = 20_000;\n`,
      "x.mjs": MOD(`import { T } from "./common.mjs";\nspawnSync("gh", ["x"], { timeout: T });`),
    },
  };
  for (const [name, src] of Object.entries(accepted)) {
    assert.deepEqual(reaching(typeof src === "string" ? { "x.mjs": src } : src), [false], name);
  }
  // An env-fed bound on a git call, through the funnel a literal-bound gh call
  // shares, is no gh bound.
  const git = MOD(`${FUNNEL}\nrun("git", ["x"], ${ENV_MS});\nrun("gh", ["x"], 20_000);`);
  assert.deepEqual(reaching({ "x.mjs": git }), [false]);
  const ledger = MOD(`const LEDGER_LOCK_TIMEOUT_MS = ${ENV_MS};\nspawnSync("git", ["x"], { timeout: LEDGER_LOCK_TIMEOUT_MS });\nspawnSync("gh", ["x"], { timeout: 20_000 });`);
  assert.deepEqual(reaching({ "x.mjs": ledger }), [false]);
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
