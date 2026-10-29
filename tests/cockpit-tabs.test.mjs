import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeCellEvidence } from "../plugin/scripts/compute-cell-evidence.mjs";
import { computeBoard } from "../plugin/scripts/compute-board.mjs";
import { formatRouting } from "../plugin/scripts/ledger-grammar.mjs";
import { identityRoles } from "./support/label-map-seed.mjs";

// The cockpit page's tab strip and hash router. `board.html` is one
// self-contained file, so the decision is lifted out of its source text and
// evaluated — the technique spend-view.test.mjs uses for `spendView` — and the
// DOM around it is driven through a stub document just capable enough to hold
// the writes. Shape tests come first and are named, so a changed spelling
// reports the claim that stopped holding instead of dropping this file's total
// in one opaque load-time error.
const HTML = readFileSync(join(import.meta.dirname, "..", "plugin", "scripts", "board.html"), "utf8");

test("board.html declares routeHash exactly once at top level", () => {
  assert.equal(HTML.match(/^function\s+routeHash\s*\(/gm)?.length, 1,
    "a second top-level declaration wins at runtime and the lift below would still read the first");
});

const ROUTE_SRC = HTML.match(/^function\s+routeHash\s*\(\w+\)\s*\{[\s\S]*?^\}$/m);

test("board.html still declares routeHash in the shape this file lifts", () => {
  assert.ok(ROUTE_SRC, "board.html no longer declares routeHash as a top-level function — update this test");
});

const routeHash = ROUTE_SRC
  ? new Function(`${ROUTE_SRC[0]}\nreturn routeHash;`)()
  : () => { throw new Error("routeHash could not be lifted from board.html — see the shape test above"); };

// -- routeHash: hash -> tab and target ---------------------------------------

test("routeHash: each tab the strip draws opens itself, with no target", () => {
  assert.deepEqual(routeHash("#board"), { tab: "board", target: null });
  assert.deepEqual(routeHash("#tokens"), { tab: "tokens", target: null });
});

test("routeHash: a bare URL opens Board's top", () => {
  for (const h of ["", "#", undefined, null]) {
    assert.deepEqual(routeHash(h), { tab: "board", target: null }, `hash ${JSON.stringify(h)}`);
  }
});

test("routeHash: #board/<issue> opens Board with that issue as the target", () => {
  assert.deepEqual(routeHash("#board/3891"), { tab: "board", target: "3891" });
  assert.deepEqual(routeHash("#board/1"), { tab: "board", target: "1" });
  assert.deepEqual(routeHash("#board/10"), { tab: "board", target: "10" });
});

test("routeHash: an unknown tab lands on Board's top, whatever follows it", () => {
  for (const h of ["#nope", "#Tokens", "#TOKENS", "#nope/12", "#board2", "#/board", "#tokens2"]) {
    assert.deepEqual(routeHash(h), { tab: "board", target: null }, h);
  }
});

test("routeHash: #cells opens Cell evidence, a section, a Cell or a generation of it the target", () => {
  assert.deepEqual(routeHash("#cells"), { tab: "cells", target: null });
  for (const t of ["rows", "guard", "declared", "slow-high", "task-max", "slow-high@claude-opus-5", "smol-high@claude-haiku-5-5", "task-high@claude-opus-5.5"]) {
    assert.deepEqual(routeHash(`#cells/${t}`), { tab: "cells", target: t }, t);
  }
});

test("routeHash: #cells/row/<objective>/<stratum> opens Cell evidence at that policy row, `*` and each Stratum, under both Objectives", () => {
  for (const o of ["cost", "speed"]) {
    for (const s of ["*", "light", "heavy", "unknown"]) {
      assert.deepEqual(routeHash(`#cells/row/${o}/${s}`), { tab: "cells", target: `row/${o}/${s}` }, `${o}/${s}`);
    }
  }
});

test("routeHash: a Cell evidence target nothing draws lands on the tab's top, and the tab still opens", () => {
  for (const h of ["#cells/", "#cells/nope", "#cells/slow-huge", "#cells/slow-high@", "#cells/slow-high@a@b", "#cells/slow-high@a/b",
    "#cells/guard/x", "#cells/Guard", "#cells/ guard", "#cells//guard", "#cells/rows/x",
    "#cells/row", "#cells/row/", "#cells/row/cost", "#cells/row/cost/", "#cells/row/cost/heavy/x", "#cells/row/size/heavy", "#cells/row/cost/huge",
    "#cells/row/Cost/heavy", "#cells/row//heavy", "#cells/row/cost/**", "#cells/row/cost/Heavy"]) {
    assert.deepEqual(routeHash(h), { tab: "cells", target: null }, h);
  }
});

test("routeHash: a target the tab does not have lands on that tab's top", () => {
  for (const h of ["#board/", "#board/abc", "#board/0", "#board/012", "#board/-1", "#board/1.5",
    "#board/12/3", "#board/12/", "#board//12", "#board/ 12"]) {
    assert.deepEqual(routeHash(h), { tab: "board", target: null }, h);
  }
  // Tokens has no card to target: the tab still opens.
  for (const h of ["#tokens/12", "#tokens/", "#tokens/a/b"]) {
    assert.deepEqual(routeHash(h), { tab: "tokens", target: null }, h);
  }
});

// -- the markup --------------------------------------------------------------

const strip = HTML.match(/<nav id="tabs">([\s\S]*?)<\/nav>/);
const tabLinks = strip
  ? [...strip[1].matchAll(/<a\b([^>]*)>([^<]*)<\/a>/g)].map((m) => ({
    attrs: m[1], href: m[1].match(/href="([^"]*)"/)?.[1], text: m[2] }))
  : [];

test("the tab strip reads Board · Cell evidence · Tokens, in that order, and nothing else", () => {
  assert.ok(strip, "board.html no longer carries <nav id=\"tabs\"> — update this test");
  assert.deepEqual(tabLinks.map((t) => t.text), ["Board", "Cell evidence", "Tokens"]);
  assert.deepEqual(tabLinks.map((t) => t.href), ["#board", "#cells", "#tokens"]);
});

test("every tab link routes to its own tab, and none opens a new window", () => {
  const tabOf = { Board: "board", "Cell evidence": "cells", Tokens: "tokens" };
  for (const t of tabLinks) {
    assert.equal(routeHash(t.href).tab, tabOf[t.text], t.href);
    assert.doesNotMatch(t.attrs, /target\s*=/, `${t.href} must not open a new window`);
  }
});

test("a bare URL opens Board: its tab is marked and its pane is the one not hidden", () => {
  assert.match(HTML, /<a id="tab-board" class="on" href="#board" aria-current="page">/);
  assert.doesNotMatch(HTML, /<a id="tab-(cells|tokens)"[^>]*class="on"/);
  assert.match(HTML, /<div id="board"><\/div>/, "Board's pane must open visible");
  assert.match(HTML, /<div id="cells" hidden><\/div>/, "Cell evidence's pane must open closed");
  assert.match(HTML, /<div id="spend" hidden><\/div>/, "Tokens' pane must open closed");
});

// Above the tabs: header, banner, attention strip. Below every tab: the footer.
// Each is a sibling of every pane, never inside one, so hiding a pane
// hides none of them.
test("header, banner and attention strip sit above the tabs, the footer below every pane", () => {
  const at = (needle) => {
    const i = HTML.indexOf(needle);
    assert.notEqual(i, -1, `board.html no longer carries ${needle} — update this test`);
    return i;
  };
  const order = ["<header>", 'id="stale-banner"', 'id="attention"', 'id="tabs"', 'id="board"', 'id="cells"', 'id="spend"', 'id="footer"'].map(at);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "the page's top-level order changed");
  // Every pane is closed in the same breath it opens, so nothing may nest in one.
  assert.match(HTML, /<div id="attention"><\/div>\n<nav id="tabs">/);
  assert.match(HTML, /<div id="spend" hidden><\/div>\n<footer id="footer"><\/footer>/);
});

test("a closed pane stays closed: [hidden] outranks the panes' own display", () => {
  assert.match(HTML, /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
});

// -- the page, driven --------------------------------------------------------

const SCRIPT_SRC = HTML.match(/<script>([\s\S]*)<\/script>/)?.[1]?.replace(/\bboot\(\);\s*$/, "");

test("board.html's <script> still ends in a boot() call this file strips", () => {
  assert.ok(SCRIPT_SRC);
  assert.match(HTML, /^boot\(\);\n<\/script>/m);
});

const STATIC_IDS = new Set(["heading", "age", "stale-banner", "attention", "tabs", "tab-board", "tab-cells", "tab-tokens", "board", "cells", "spend", "footer"]);

class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.style = {}; this.className = ""; this.attrs = {}; this.listeners = {}; this.scrollTop = 0; }
  get classList() {
    const set = () => new Set(this.className.split(/\s+/).filter(Boolean));
    const write = (s) => { this.className = [...s].join(" "); };
    const op = (name, c) => this.log?.push(["class", this.id, name, c]);
    return {
      add: (c) => { op("add", c); write(set().add(c)); },
      remove: (c) => { op("remove", c); const s = set(); s.delete(c); write(s); },
      toggle: (c, on) => { const s = set(); if (on) s.add(c); else s.delete(c); write(s); },
      contains: (c) => set().has(c),
    };
  }
  // Reading it is a reflow, which is what restarts a CSS animation.
  get offsetWidth() { this.log?.push(["reflow", this.id]); return 0; }
  set innerHTML(_) { this.children = []; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(k, v) { this.attrs[k] = v; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  scrollIntoView(opts) { this.log.push(["scrollIntoView", this.id, opts]); }
}

function harness() {
  const log = [];
  const statics = new Map();
  const find = (node, id) => {
    for (const c of node.children ?? []) {
      if (c.id === id) return c;
      const hit = find(c, id);
      if (hit) return hit;
    }
    return null;
  };
  const listen = (target) => Object.assign(target, {
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
  });
  const document = listen({
    title: "",
    createElement: (tag) => { const n = new Node(tag); n.log = log; return n; },
    createTextNode: (text) => ({ text }),
    getElementById(id) {
      if (statics.has(id)) return statics.get(id);
      if (STATIC_IDS.has(id)) { const n = this.createElement("div"); n.id = id; statics.set(id, n); return n; }
      for (const s of statics.values()) { const hit = find(s, id); if (hit) return hit; }
      return null; // a real document answers null for an id nothing carries
    },
  });
  const location = { hash: "" };
  const window = listen({ scrollTo: (x, y) => log.push(["scrollTo", x, y]) });
  // poll()'s fetch never answers, so a boot() here starts one poll and no more.
  const fetches = [];
  const fetch = (url) => { fetches.push(url); return new Promise(() => {}); };
  const clock = { now: Date.now() };
  const { render, applyHash, boot } = new Function("document", "location", "window", "fetch", "setTimeout", "Date",
    `${SCRIPT_SRC}\nreturn { render, applyHash, boot };`)(document, location, window, fetch, () => {}, { now: () => clock.now });
  const model = (o = {}) => ({
    interval: 15, repoUrl: null, generatedAt: Date.now(),
    attention: [], tickets: [], spend: null, queue: {}, filed: [], ...o,
  });
  const open = (hash) => { location.hash = hash; applyHash(); };
  const scrolls = () => log.filter((e) => e[0] === "scrollIntoView").map((e) => e[1]);
  const tops = () => log.filter((e) => e[0] === "scrollTo");
  return { document, location, window, render, boot, open, model, log, scrolls, tops, fetches, clock };
}

const paneState = (document) => ({
  boardHidden: !!document.getElementById("board").hidden,
  tokensHidden: !!document.getElementById("spend").hidden,
  boardTab: document.getElementById("tab-board").classList.contains("on"),
  tokensTab: document.getElementById("tab-tokens").classList.contains("on"),
});

test("#tokens opens Tokens and closes Board; a bare hash or an unknown one opens Board", () => {
  const { document, open } = harness();
  open("#tokens");
  assert.deepEqual(paneState(document), { boardHidden: true, tokensHidden: false, boardTab: false, tokensTab: true });
  assert.equal(document.getElementById("tab-tokens").attrs["aria-current"], "page");
  assert.equal(document.getElementById("tab-board").attrs["aria-current"], undefined);

  for (const h of ["", "#board", "#nope"]) {
    open("#tokens");
    open(h);
    assert.deepEqual(paneState(document), { boardHidden: false, tokensHidden: true, boardTab: true, tokensTab: false }, `hash ${JSON.stringify(h)}`);
    assert.equal(document.getElementById("tab-board").attrs["aria-current"], "page");
    assert.equal(document.getElementById("tab-tokens").attrs["aria-current"], undefined);
  }
});

test("an attention-strip ticket links #board/<issue>, to a route routeHash resolves, and opens no new window", () => {
  const { document, render, model } = harness();
  render(model({ attention: [{ issue: 3891, flags: ["stale"] }, { issue: 7, flags: ["red-ci", "stall"] }] }));
  const links = document.getElementById("attention").children;
  assert.deepEqual(links.map((a) => a.tag), ["a", "a"], "each entry is a link");
  assert.deepEqual(links.map((a) => a.href), ["#board/3891", "#board/7"]);
  for (const a of links) {
    assert.equal(a.target, undefined, "a hash link must not open a new window");
    assert.deepEqual(routeHash(a.href), { tab: "board", target: a.href.slice("#board/".length) });
  }
  assert.equal(links[1].children[2].textContent, "red-ci stall");
});

test("a card is the target of its own link: its id is the one settle looks for", () => {
  const { document, render, model } = harness();
  render(model({ tickets: [{ issue: 12, column: "POOL" }, { issue: 13, column: "REVIEW" }] }));
  assert.equal(document.getElementById("card-12")?.id, "card-12");
  assert.equal(document.getElementById("card-13")?.id, "card-13");
  assert.equal(document.getElementById("card-14"), null);
});

test("#board/<issue> scrolls its card into view and flashes it once, when the card is already drawn", () => {
  const { document, render, model, open, scrolls, log } = harness();
  render(model({ tickets: [{ issue: 12, column: "POOL" }, { issue: 13, column: "REVIEW" }] }));
  open("#board/13");
  assert.deepEqual(scrolls(), ["card-13"]);
  assert.deepEqual(log.find((e) => e[0] === "scrollIntoView")[2], { block: "center" }, "the card lands mid-column, not at an edge");
  const card = document.getElementById("card-13");
  assert.ok(card.classList.contains("flash"));
  assert.ok(!document.getElementById("card-12").classList.contains("flash"), "only the target flashes");
  // The animation ends once; the class must come off with it so a later arrival can flash again.
  for (const fn of card.listeners.animationend) fn();
  assert.ok(!card.classList.contains("flash"));
});

test("the flash runs once, for FLASH_MS", () => {
  const css = HTML.match(/\.card\.flash\s*\{\s*animation:\s*flash\s+([\d.]+)s\s+[\w-]+\s+(\S+?);?\s*\}/);
  const ms = HTML.match(/^const FLASH_MS = (\d+);$/m);
  assert.ok(css && ms, "board.html no longer declares the flash in the shape this test reads — update it");
  assert.equal(css[2], "1", "the flash plays once, never on a loop");
  assert.equal(Number(css[1]) * 1000, Number(ms[1]), "FLASH_MS is the CSS duration");
});

// A tick rebuilds every card. The flash belongs to the issue, not to the node
// the arrival found, so a tick inside the flash must not cut it short.
test("a tick that rebuilds a card mid-flash keeps the flash where it was; a tick after it does not", () => {
  const { document, render, model, open, clock } = harness();
  const m = model({ tickets: [{ issue: 12, column: "POOL" }, { issue: 13, column: "REVIEW" }] });
  render(m);
  open("#board/13");
  const first = document.getElementById("card-13");
  clock.now += 500;
  render(m);
  const rebuilt = document.getElementById("card-13");
  assert.notEqual(rebuilt, first, "the tick rebuilt the card");
  assert.ok(rebuilt.classList.contains("flash"));
  assert.equal(rebuilt.style.animationDelay, "-500ms", "picked up 500ms in, not restarted");
  assert.ok(!document.getElementById("card-12").classList.contains("flash"));
  clock.now += 800;
  render(m);
  assert.ok(!document.getElementById("card-13").classList.contains("flash"), "past FLASH_MS the flash is over");
});

test("a hash that arrives before the first render waits for the cards, then scrolls once", () => {
  const { render, model, open, scrolls, tops } = harness();
  open("#board/13");
  assert.deepEqual(scrolls(), [], "nothing is drawn yet");
  assert.deepEqual(tops(), [], "and a wait is not a landing on the top");
  const m = model({ tickets: [{ issue: 13, column: "REVIEW" }] });
  render(m);
  assert.deepEqual(scrolls(), ["card-13"]);
  render(m);
  render(m);
  assert.deepEqual(scrolls(), ["card-13"], "a later tick must not scroll the page out from under the operator");
});

// The board is fully written before the scroll runs, so a scroll that throws
// is banner'd as what it is, and never as the render that already succeeded.
test("a scroll that fails after the board is drawn is reported as a failed scroll, not a failed render", (t) => {
  t.mock.method(Node.prototype, "scrollIntoView", () => { throw new Error("boom"); });
  const { document, render, model, open } = harness();
  open("#board/13");
  assert.doesNotThrow(() => render(model({ tickets: [{ issue: 13, column: "REVIEW" }] })));
  assert.ok(document.getElementById("card-13"), "the board was drawn");
  const banner = document.getElementById("stale-banner");
  assert.equal(banner.style.display, "block");
  assert.equal(banner.textContent, "⚠ scroll to card failed: boom");
});

test("opening the same link again scrolls again, and restarts the flash", () => {
  const { render, model, open, scrolls, log } = harness();
  render(model({ tickets: [{ issue: 13, column: "REVIEW" }] }));
  open("#board/13");
  const mark = log.length;
  open("#board/13");
  assert.deepEqual(scrolls(), ["card-13", "card-13"]);
  const flashOps = log.slice(mark).filter((e) => e[1] === "card-13" && (e[0] === "reflow" || (e[0] === "class" && e[3] === "flash")));
  assert.deepEqual(flashOps.map((e) => e[0] === "reflow" ? "reflow" : e[2]), ["remove", "reflow", "add"],
    "the class comes off and a reflow lands before it goes back on, or the running animation never restarts");
});

test("a target no card carries lands on the tab's top, drawn or not yet", () => {
  const { document, render, model, open, scrolls, tops } = harness();
  open("#board/999");
  render(model({ tickets: [{ issue: 13, column: "REVIEW" }] }));
  assert.deepEqual(scrolls(), []);
  assert.deepEqual(tops(), [["scrollTo", 0, 0]]);
  const spend = document.getElementById("spend");
  spend.scrollTop = 40;
  open("#tokens");
  assert.equal(spend.scrollTop, 0, "Tokens scrolls on its own; landing on its top resets it");
  open("#board");
  assert.deepEqual(scrolls(), []);
  assert.equal(tops().length, 3, "every landing without a target goes to the top");
});

// What the router must ACCEPT, driven end to end: a pasted link to a card on
// the Board is not refused for being a link into a tab with a pane.
test("a pasted #board/<issue> link reaches its card whatever tab was open before it", () => {
  const { render, model, open, scrolls } = harness();
  render(model({ tickets: [{ issue: 5, column: "MERGED" }] }));
  open("#tokens");
  open("#board/5");
  assert.deepEqual(scrolls(), ["card-5"]);
});

// -- boot(): the listeners and the first route ---------------------------------

test("boot() routes the hash the page opens on and starts polling", () => {
  const { document, location, boot, fetches } = harness();
  location.hash = "#tokens";
  boot();
  assert.deepEqual(paneState(document), { boardHidden: true, tokensHidden: false, boardTab: false, tokensTab: true });
  assert.deepEqual(fetches, ["/board.json"]);
});

test("after boot(), a hashchange routes the new hash", () => {
  const { document, location, window, boot } = harness();
  boot();
  location.hash = "#tokens";
  for (const fn of window.listeners.hashchange ?? []) fn();
  assert.deepEqual(paneState(document), { boardHidden: true, tokensHidden: false, boardTab: false, tokensTab: true });
});

// A browser fires no hashchange for a link to the hash already open, so the
// click routes it by hand. A modified click is the browser's (a new tab, a new
// window, a download), and a link to another hash is hashchange's.
test("after boot(), a plain click on the link to the open hash routes it again; no other click is taken", () => {
  const { document, location, render, model, boot, scrolls } = harness();
  render(model({ tickets: [{ issue: 13, column: "REVIEW" }] }));
  location.hash = "#board/13";
  boot();
  assert.deepEqual(scrolls(), ["card-13"]);
  const click = (href, mods = {}) => {
    const e = { button: 0, defaultPrevented: false, ...mods,
      target: { closest: () => ({ getAttribute: () => href }) },
      preventDefault() { this.defaultPrevented = true; } };
    for (const fn of document.listeners.click ?? []) fn(e);
    return e.defaultPrevented;
  };
  assert.equal(click("#board/13"), true);
  assert.deepEqual(scrolls(), ["card-13", "card-13"]);
  assert.equal(click("#board/12"), false, "another hash is left to the browser and hashchange");
  for (const mods of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
    assert.equal(click("#board/13", mods), false, JSON.stringify(mods));
  }
  assert.deepEqual(scrolls(), ["card-13", "card-13"], "none of those routed the page");
});

// -- global above the tabs, below every tab ----------------------------------

test("the banner, the attention strip and the footer are written on every tick whichever tab is open", () => {
  for (const hash of ["", "#board", "#tokens"]) {
    const { document, render, model, open } = harness();
    open(hash);
    render(model({
      generatedAt: Date.now() - 10 * 60 * 1000,
      attention: [{ issue: 9, flags: ["stalled"] }],
      queue: { pool: 4, supply: 2, reviewBacklog: 1 },
      capNotice: "the open-PR read hit its --limit",
      filed: [{ issue: 100 }],
    }));
    const banner = document.getElementById("stale-banner");
    assert.equal(banner.style.display, "block", hash);
    assert.match(banner.textContent, /data stale/, hash);
    assert.equal(document.getElementById("attention").children.length, 1, hash);
    const foot = document.getElementById("footer").children.map((c) => c.textContent);
    assert.deepEqual(foot, [
      "pool 4 · supply 2 · review-backlog 1",
      "⚠ the open-PR read hit its --limit",
      "filed follow-ups (1): #100",
    ], hash);
    // None of the three is a pane: opening a tab never hides them.
    for (const id of ["stale-banner", "attention", "footer", "tabs"]) {
      assert.ok(!document.getElementById(id).hidden, `${id} on ${JSON.stringify(hash)}`);
    }
  }
});

// -- Tokens: every spendView outcome, under the renamed headings -------------

const okSpend = (o = {}) => ({
  ok: true, skipped: 0, damaged: 0, attributedPct: 80, reviewPct: 25,
  totals: { cacheWrite: 2_000_000, cacheRead: 9_000_000, output: 50_000, agents: 3 },
  roles: [{ role: "implementer", agents: 2, cacheWrite: 1_500_000, pct: 75 }, { role: "reviewer", agents: 1, cacheWrite: 500_000, pct: 25 }],
  tools: [{ tool: "Bash", calls: 4, cacheWrite: 800_000, pct: 40 }],
  ...o,
});

const tokensHost = (spend) => {
  const { document, render, model, open } = harness();
  open("#tokens");
  render(model({ spend }));
  return document.getElementById("spend");
};

test("Tokens: no spend yet draws nothing", () => {
  assert.deepEqual(tokensHost(null).children, []);
  assert.deepEqual(tokensHost(okSpend({ totals: { cacheWrite: 0 } })).children, []);
});

test("Tokens: an error is drawn as its own box, never hidden", () => {
  const host = tokensHost({ ok: false, error: "no transcripts dir" });
  assert.equal(host.children.length, 1);
  assert.equal(host.children[0].className, "spend-wrap");
  assert.equal(host.children[0].textContent, "spend unavailable: no transcripts dir");
});

test("Tokens: a skipped-only run draws its note, not a panel", () => {
  const host = tokensHost(okSpend({ skipped: 2, totals: { cacheWrite: 0 } }));
  assert.equal(host.children.length, 1);
  assert.equal(host.children[0].className, "spend-wrap");
  assert.equal(host.children[0].textContent, "2 transcripts skipped; no spend recorded yet");
});

test("Tokens: a funded run draws the panel under \"tokens\" and \"by member role\"", () => {
  const host = tokensHost(okSpend());
  const wrap = host.children[0];
  assert.equal(wrap.className, "spend-wrap");
  const [hd, cols] = wrap.children;
  assert.equal(hd.children[0].textContent, "tokens");
  assert.match(hd.children[1].textContent, /2\.0M cache-write · 9\.0M cache-read/);
  const [byRole, byTool] = cols.children;
  assert.equal(byRole.children[0].textContent, "by member role");
  assert.equal(byTool.children[0].textContent, "by tool — 80% of cache-write attributed");
  assert.equal(byRole.children.length, 3, "heading and one row per role");
});

test("Tokens: the old headings are gone from the page", () => {
  assert.doesNotMatch(HTML, /el\("h2", null, "spend"\)/);
  assert.doesNotMatch(HTML, /el\("h3", null, "by role"\)/);
});

// -- Cell evidence: the page lays out the model, and every anchor is there --------------

const cellEntry = (cell, o = {}) => ({
  cell, generation: "claude-opus-5", n: 69, n_merged: 69, n_claims: 69, n_failed: 8, fail_rate: 0.1159, mean_usd: 14.9,
  by_hand: 56, pending: 0, left_out: 0, unpriced: 0, untimed: 0, excluded: 0, older: [], ...o,
});
const ceGuard = (cells = [cellEntry("slow-high"), cellEntry("task-high", { generation: "claude-sonnet-5-5", n_failed: 15, mean_usd: 10.2, excluded: 1,
  older: [{ generation: "claude-sonnet-5-4", n_merged: 8, n_claims: 8, n_failed: 1, fail_rate: 0.125, mean_usd: 9 }] })]) => ({
  status: "ok",
  guard: { computed_at: "2026-10-26T19:17:33.000Z", window_start: "2026-10-03", min_n: 20, trip_points: 15, verdict: "ok", tripped: [], retire: false,
    baseline: { cell: "slow-high", generation: "claude-opus-5", n: 69, mean_usd: 14.9, fail_rate: 0.1159 }, cells },
});
const ceRoles = { value: { slow: "anthropic/claude-opus-5:high", task: "anthropic/claude-sonnet-5-5:high", smol: "anthropic/claude-haiku-5-5:auto" }, readAt: 1, error: null };
const ceAgents = { list: [{ file: "fleet-finisher.agent.md", model: '"@slow:high"' }], error: null };
const evidence = (o = {}) => computeCellEvidence({ guard: ceGuard(), receipts: { phase0: null, closeout: null }, agents: ceAgents, modelRoles: ceRoles, ...o });

const textOf = (n) => [n.textContent ?? n.text ?? "", ...(n.children ?? []).map(textOf)].join(" ");
const idsOf = (n) => [n.id, ...(n.children ?? []).flatMap(idsOf)].filter(Boolean);
const anchorsOf = (ce) => [
  "cells-rows", "cells-guard", "cells-declared",
  ...ce.policy.objectives.flatMap((o) => o.lines.map((l) => l.anchor)),
  ...ce.guard.cells.flatMap((c) => [c.anchor, c.figures?.anchor, c.none?.anchor, ...c.older.map((o) => o.anchor)]),
].filter(Boolean);

test("Cell evidence: opening #cells opens its pane and its tab, and closes the others", () => {
  const { document, open } = harness();
  open("#cells");
  assert.equal(document.getElementById("cells").hidden, false);
  assert.equal(document.getElementById("board").hidden, true);
  assert.equal(document.getElementById("spend").hidden, true);
  assert.ok(document.getElementById("tab-cells").classList.contains("on"));
  assert.equal(document.getElementById("tab-cells").attrs["aria-current"], "page");
  assert.ok(!document.getElementById("tab-board").classList.contains("on"));
});

test("Cell evidence: the pane draws the model's words, the guard section first and Declared, not measured collapsed after it", () => {
  const { document, render, model, open } = harness();
  open("#cells");
  const ce = evidence();
  render(model({ cellEvidence: ce }));
  const host = document.getElementById("cells");
  const text = textOf(host);
  for (const words of [ce.guard.heading, ce.guard.source, "The guard: what it holds each Cell to", "baseline", "judged on claude-opus-5",
    "Tier route: anthropic/claude-opus-5 · high", "69 ≥ 20 ✓", "11.6% · the floor is 26.6%", "21.7% · +10.1 pts on slow-high · 4.9 pts inside the floor",
    "56 of 69 Rulings given by hand", "$10.20 · −31.5% on slow-high", "no figures yet for claude-opus-5", "claude-sonnet-5-4 · not judged",
    ce.guard.footnotes[0].text, ce.declared.heading, "fleet-finisher", "@slow:high", "anthropic/claude-opus-5 · high"]) {
    assert.ok(text.includes(words), `the tab does not draw ${JSON.stringify(words)}`);
  }
  const [links, rows, guard, declared] = host.children;
  assert.deepEqual(links.children.filter((c) => c.tag === "a").map((a) => a.href), ["#cells/rows", "#cells/guard", "#cells/declared"]);
  assert.equal(rows.id, "cells-rows");
  assert.equal(guard.id, "cells-guard");
  assert.equal(declared.tag, "details");
  assert.equal(declared.open, false, "collapsed until it is opened");
  const order = guard.children.filter((c) => /^cell-/.test(c.id ?? "")).map((c) => c.id);
  assert.deepEqual(order, ["cell-slow-high", "cell-task-high", "cell-smol-high", "cell-slow-medium", "cell-task-max"]);
});

test("Cell evidence: every anchor the model names is an element the page draws, in every state", () => {
  const states = {
    "today's guard": evidence(),
    "no cost guard": evidence({ guard: { status: "missing" } }),
    "no modelRoles": evidence({ modelRoles: null }),
    "holds nothing back": evidence({ guard: { status: "ok", guard: { ...ceGuard().guard, verdict: "none", cells: [cellEntry("slow-high", { n: 3, n_merged: 3 })],
      baseline: { cell: "slow-high", generation: "claude-opus-5", n: 3, mean_usd: 14.9, fail_rate: 0.1 } } } }),
  };
  for (const [name, ce] of Object.entries(states)) {
    const { document, render, model, open } = harness();
    open("#cells");
    render(model({ cellEvidence: ce }));
    const drawn = new Set(idsOf(document.getElementById("cells")));
    for (const a of anchorsOf(ce)) assert.ok(drawn.has(a), `${name}: ${a} is not drawn`);
    // and the route a link to each would take lands on that element.
    for (const a of anchorsOf(ce).filter((x) => /^cell-/.test(x))) {
      const r = routeHash(`#cells/${a.slice("cell-".length)}`);
      assert.equal(r.tab, "cells", a);
      assert.equal(r.target, a.slice("cell-".length), a);
    }
    for (const [o, s] of ce.policy.objectives.flatMap((x) => x.lines.map((l) => [x.objective, l.stratum]))) {
      const r = routeHash(`#cells/row/${o}/${s}`);
      assert.equal(`cells-${r.target.replace(/\//g, "-")}`, `cells-row-${o}-${s}`);
    }
  }
});

test("Cell evidence: #cells/<cell>@<generation> scrolls its generation into view and flashes it once; a nested older one too", () => {
  const { document, render, model, open, scrolls, tops } = harness();
  render(model({ cellEvidence: evidence() }));
  open("#cells/task-high@claude-sonnet-5-5");
  assert.deepEqual(scrolls(), ["cell-task-high@claude-sonnet-5-5"]);
  assert.ok(document.getElementById("cell-task-high@claude-sonnet-5-5").classList.contains("flash"));
  open("#cells/task-high@claude-sonnet-5-4");
  assert.deepEqual(scrolls().at(-1), "cell-task-high@claude-sonnet-5-4");
  open("#cells/slow-medium");
  assert.equal(scrolls().at(-1), "cell-slow-medium", "a Cell with no figures is still a place to land");
  assert.deepEqual(tops(), []);
});

test("Cell evidence: a target the page does not draw lands on the tab's top, and the tab still opens", () => {
  const { document, render, model, open, scrolls, tops } = harness();
  render(model({ cellEvidence: evidence() }));
  const pane = document.getElementById("cells");
  pane.scrollTop = 120;
  open("#cells/task-high@claude-never-ran");
  assert.deepEqual(scrolls(), []);
  assert.equal(tops().length, 1);
  assert.equal(pane.scrollTop, 0);
  assert.equal(pane.hidden, false);
});

test("Cell evidence: a pasted link reaches its place before the first render, then scrolls once", () => {
  const { render, model, open, scrolls } = harness();
  open("#cells/guard");
  assert.deepEqual(scrolls(), []);
  render(model({ cellEvidence: evidence() }));
  render(model({ cellEvidence: evidence() }));
  assert.deepEqual(scrolls(), ["cells-guard"]);
});

test("Cell evidence: Declared, not measured opens on a link to it, and a tick does not shut it", () => {
  const { document, render, model, open } = harness();
  render(model({ cellEvidence: evidence() }));
  open("#cells/declared");
  const first = document.getElementById("cells-declared");
  assert.equal(first.open, true);
  render(model({ cellEvidence: evidence() }));
  const rebuilt = document.getElementById("cells-declared");
  assert.notEqual(rebuilt, first, "the tick rebuilt it");
  assert.equal(rebuilt.open, true, "and it stayed open");
  // An operator closing it keeps it closed.
  rebuilt.open = false;
  for (const fn of rebuilt.listeners.toggle) fn();
  render(model({ cellEvidence: evidence() }));
  assert.equal(document.getElementById("cells-declared").open, false);
});

test("Cell evidence: a tick that rebuilds an entry mid-flash keeps the flash where it was", () => {
  const { document, render, model, open, clock } = harness();
  render(model({ cellEvidence: evidence() }));
  open("#cells/smol-high");
  clock.now += 400;
  render(model({ cellEvidence: evidence() }));
  const entry = document.getElementById("cell-smol-high");
  assert.ok(entry.classList.contains("flash"));
  assert.equal(entry.style.animationDelay, "-400ms");
});

test("Cell evidence: a board.json from before the tab draws a line, not a thrown render", () => {
  const { document, render, model, open } = harness();
  open("#cells");
  assert.doesNotThrow(() => render(model()));
  assert.equal(textOf(document.getElementById("cells")).trim(), "no Cell evidence in this board yet");
});

test("Cell evidence: the Board and Tokens panes are still filled on a tick while Cell evidence is open", () => {
  const { document, render, model, open } = harness();
  open("#cells");
  render(model({ cellEvidence: evidence(), tickets: [{ issue: 12, column: "POOL" }], spend: null }));
  assert.ok(document.getElementById("card-12"), "the Board is drawn behind the open tab");
});

// -- the card's Cell line, and links both ways ----------------------------------------

const routed = (member, o) => `${member} ${formatRouting({
  policy: "slow-high", cell: "slow-high", draw: null, by: null, stratum: "heavy", brief: 9658, criteria: 8, parent: null,
  sized: null, objective: "cost", tripped: [], reason: "ok", ...o,
})}`;
const implRec = (member, cell, model) => ({ member, model, resolvedModelIdentity: `anthropic/${model}`, thinking: cell.split("-")[1], subagent_type: `fleet-implementer-${cell}` });

// A board whose cards link to every kind of place on the guard section: the
// newest generation (#21), an older one (#22), a generation the guard has no
// figures for (#23), a Cell the guard does not hold (#24), a Pull with no
// transcript (#25), a rescue at another Cell (#26) and a Pull with no
// Admissible row (#27).
const linkedBoard = ({ guard, modelRoles }) => computeBoard({
  roles: identityRoles(),
  ledger: {
    rows: [
      "#21 impl-21=PR#121", "#22 impl-22", "#23 impl-23", "#24 impl-24 · tier=smol-high", "#25 impl-25",
      "#26 impl-26=killed impl-26-b · tier=task-max", "#27 impl-27", "#28 excluded · behind-pr:#121",
    ],
    routed: [
      routed("impl-21", { cell: "task-high", draw: { k: 1, K: 2 }, by: "burn-in" }), routed("impl-22", { cell: "task-high", draw: { k: 1, K: 2 }, by: "burn-in" }),
      routed("impl-23", {}), routed("impl-24", { cell: "smol-high", draw: { k: 2, K: 2 }, by: "burn-in" }),
      routed("impl-25", { cell: "slow-medium", draw: { k: 1, K: 4 }, by: "burn-in" }), routed("impl-26", { cell: "smol-high", draw: { k: 2, K: 2 }, by: "burn-in" }),
      routed("impl-27", { cell: "task-high", policy: "task-high" }),
    ],
    agents: { "impl-26-b": "fleet-implementer-task-max", "impl-27": "fleet-implementer-slow-high" },
    filed: [], ruled: [],
  },
  issues: [], prs: [{ number: 121, state: "OPEN", labels: [], title: "t" }], ci: {}, prev: null, now: Date.now(),
  implementers: [
    implRec("impl-21", "task-high", "claude-sonnet-5-5"), implRec("impl-22", "task-high", "claude-sonnet-5-4"),
    implRec("impl-23", "slow-high", "claude-opus-6"), implRec("impl-24", "smol-high", "claude-haiku-5-5"),
    implRec("impl-26", "smol-high", "claude-haiku-5-4"), implRec("impl-26-b", "task-max", "claude-sonnet-6"),
    implRec("impl-27", "slow-high", "claude-opus-5"),
  ],
  guard, modelRoles, receipts: { phase0: null, closeout: null }, agents: ceAgents,
});

const linksIn = (n) => [...(n.tag === "a" ? [n.href] : []), ...(n.children ?? []).flatMap(linksIn)];

test("a card draws its Cell line under the meta line: Cell · why, Stratum · model · level, then the mark", () => {
  const { document, render } = harness();
  render(linkedBoard({ guard: ceGuard(), modelRoles: ceRoles }));
  const [, , why, stratum] = document.getElementById("card-21").children;
  assert.deepEqual([why.className, stratum.className], ["cl", "cl"]);
  assert.equal(textOf(why).replace(/\s+/g, " ").trim(), "task-high · drawn 1 of 2: burn-in");
  assert.equal(textOf(stratum).replace(/\s+/g, " ").trim(), "heavy: 9,658 chars (past 3,483), 8 criteria (past 5) · claude-sonnet-5-5 · high");
  const cell = why.children.find((c) => c.tag === "a");
  assert.equal(cell.href, "#cells/task-high@claude-sonnet-5-5");
  assert.equal(cell.target, undefined, "a hash link must not open a new window");

  const red = document.getElementById("card-27").children.at(-1);
  assert.equal(red.className, "cl mark red");
  assert.equal(red.textContent, "⚑ ran as fleet-implementer-slow-high: no Admissible row, so it counts in no Cell's figures");

  const hole = document.getElementById("card-25").children[3].children.find((c) => c.textContent === "not on record");
  assert.equal(hole.className, "nr", "not on record is drawn dim and italic in its place");
  assert.equal(document.getElementById("card-28").children.length, 2, "an Exclusion's POOL card carries no Cell line");
});

test("card → guard entry and guard entry → card links land in every state, a generation with no figures included", () => {
  const states = {
    "today's guard": { guard: ceGuard(), modelRoles: ceRoles },
    "today's guard, no modelRoles": { guard: ceGuard(), modelRoles: null },
    "no cost guard": { guard: { status: "missing" }, modelRoles: ceRoles },
    "no cost guard, no modelRoles": { guard: { status: "missing" }, modelRoles: null },
  };
  for (const [name, state] of Object.entries(states)) {
    const { document, render, open, scrolls, tops } = harness();
    const board = linkedBoard(state);
    render(board);
    const toCells = linksIn(document.getElementById("board")).filter((h) => h.startsWith("#cells/"));
    const landsOn = (h) => (h.startsWith("#cells/row/") ? `cells-${h.slice("#cells/".length).replace(/\//g, "-")}` : `cell-${h.slice("#cells/".length)}`);
    assert.ok(toCells.includes("#cells/slow-high@claude-opus-6"), `${name}: the fixture links a generation with no figures`);
    assert.ok(toCells.includes("#cells/task-max@claude-sonnet-6"), `${name}: the fixture links a rescue`);
    for (const href of toCells) {
      open(href);
      assert.equal(scrolls().at(-1), landsOn(href), `${name}: ${href} does not land`);
    }
    const toCards = linksIn(document.getElementById("cells")).filter((h) => h.startsWith("#board/"));
    assert.deepEqual(toCards.sort(), ["#board/21", "#board/22", "#board/23", "#board/24", "#board/25", "#board/26", "#board/27"], name);
    for (const href of toCards) {
      open(href);
      assert.equal(scrolls().at(-1), `card-${href.slice("#board/".length)}`, `${name}: ${href} does not land`);
    }
    assert.deepEqual(tops(), [], `${name}: a link fell to a tab's top`);
  }
});

test("a guard entry lists this run's Pulls booked to it, each with its mark", () => {
  const { document, render } = harness();
  render(linkedBoard({ guard: ceGuard(), modelRoles: ceRoles }));
  const task = document.getElementById("cell-task-high");
  const pulls = task.children.find((c) => c.className === "ce-pulls");
  assert.equal(pulls.children[0].textContent, "this run's Pulls");
  assert.deepEqual(pulls.children.filter((c) => c.tag === "a").map((a) => a.textContent), ["#21", "#22", "#27"]);
  assert.equal(pulls.children.at(-1).textContent, "⚑ ran as fleet-implementer-slow-high: no Admissible row, so it counts in no Cell's figures");
  assert.ok(textOf(document.getElementById("cell-slow-high@claude-opus-6")).includes("no figures yet for claude-opus-6"));
});

// -- the policy rows: routes now, row by row ------------------------------------------------------

const SHIPPED_TABLE = JSON.parse(readFileSync(join(import.meta.dirname, "..", "plugin", "scripts", "router-table.json"), "utf8"));
const rowsInstall = { name: "@feigi/fleet-ctl", version: "3.104.0", repository: "git+https://github.com/feigi/fleet-plugin.git", error: null };
const policyEvidence = (o = {}) => evidence({ table: SHIPPED_TABLE, install: rowsInstall, repoUrl: "https://github.com/feigi/fleet-plugin", ...o });
const FITTED_ROWS = {
  ...SHIPPED_TABLE, fitted_commit: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d", n_rows: 198, window_start: "2026-10-03",
  rows: { cost: { "*": "slow-high", heavy: "task-high" }, speed: { "*": "slow-high", heavy: "task-high" } },
  reasons: {
    cost: { "*": { cell: "slow-high", reason: "no-qualifier", cells: { "task-high": { verdict: "not-reliably-cheaper", range: [-1.25, 0.5] } }, pairs: [] }, heavy: { cell: "task-high", reason: "sole-qualifier", cells: {}, pairs: [] } },
    speed: { "*": { cell: "slow-high", reason: "unjudged", cells: {}, pairs: [] }, heavy: { cell: "task-high", reason: "unjudged", cells: {}, pairs: [] } },
  },
  estimates: { "*": { "task-high": { generation: "claude-sonnet-5-5", merged: 60 } } },
};

test("the policy rows come first on Cell evidence and draw each side's words and every row", () => {
  const { document, render, model, open } = harness();
  open("#cells");
  render(model({ cellEvidence: policyEvidence({ objective: "speed" }) }));
  const host = document.getElementById("cells");
  assert.deepEqual(host.children.map((c) => c.id).filter(Boolean), ["cells-rows", "cells-guard", "cells-declared"]);
  const text = textOf(document.getElementById("cells-rows")).replace(/\s+/g, " ");
  for (const words of ["Policy rows: Objective × Stratum", "routes now", "this repository's runs · never fitted · @feigi/fleet-ctl 3.104.0",
    "never fitted: every Pull drawn over 3 Cells", "dispatch: drawn over 3 Cells: slow-high, task-high, smol-high", "slow-high", "unjudged",
    "light: no row, follows *", "heavy: no row, follows *", "unknown: no row, follows *"]) {
    assert.ok(text.includes(words), `the rows do not draw ${JSON.stringify(words)}`);
  }
  assert.equal(text.includes("this run's Objective"), true);
  const ids = idsOf(document.getElementById("cells-rows"));
  for (const o of ["cost", "speed"]) for (const s of ["*", "light", "heavy", "unknown"]) assert.ok(ids.includes(`cells-row-${o}-${s}`), `${o} ${s}`);
});

test("only the live run's Objective is marked, and between runs nothing is", () => {
  const marks = (ce) => {
    const { document, render, model } = harness();
    render(model({ cellEvidence: ce }));
    const objectives = document.getElementById("cells-rows").children.filter((c) => c.className === "ce-hd ce-obj");
    return objectives.map((hd) => [hd.children[0].textContent, hd.children.length === 2]);
  };
  assert.deepEqual(marks(policyEvidence({ objective: "cost" })), [["cost", true], ["speed", false]]);
  assert.deepEqual(marks(policyEvidence({ objective: "speed" })), [["cost", false], ["speed", true]]);
  assert.deepEqual(marks(policyEvidence()), [["cost", false], ["speed", false]]);
});

test("a reason link #cells/row/<objective>/<stratum> lands on its row, in every state, collapsed or not", () => {
  const states = {
    "unfitted": policyEvidence(), "fitted, heavy has a row": policyEvidence({ table: FITTED_ROWS }),
    "no cost guard": policyEvidence({ guard: { status: "missing" } }), "no table": policyEvidence({ table: null }),
  };
  for (const [name, ce] of Object.entries(states)) {
    const { document, render, model, open, scrolls, tops } = harness();
    render(model({ cellEvidence: ce }));
    for (const o of ["cost", "speed"]) {
      for (const s of ["*", "light", "heavy", "unknown"]) {
        open(`#cells/row/${o}/${s}`);
        assert.equal(scrolls().at(-1), `cells-row-${o}-${s}`, `${name}: ${o}/${s}`);
        assert.ok(document.getElementById(`cells-row-${o}-${s}`).classList.contains("flash"), `${name}: ${o}/${s} flashes once`);
      }
    }
    assert.deepEqual(tops(), [], `${name}: a row link fell to the tab's top`);
  }
});

test("a row's own reason is a link to it, and a row of its own draws its Cell, reason and each candidate", () => {
  const { document, render, model } = harness();
  render(model({ cellEvidence: policyEvidence({ table: FITTED_ROWS }) }));
  const row = document.getElementById("cells-row-cost-*");
  const link = linksIn(row);
  assert.deepEqual(link, ["#cells/row/cost/*"]);
  const text = textOf(row).replace(/\s+/g, " ");
  for (const words of ["slow-high", "no-qualifier", "task-high · n 60 · not-reliably-cheaper · 95% interval [−$1.25, $0.50]"]) assert.ok(text.includes(words), words);
  assert.equal(document.getElementById("cells-row-cost-light").children.length, 1, "a collapsed Stratum is one line");
  assert.equal(textOf(document.getElementById("cells-row-cost-light")).trim(), "light: no row, follows *");
  assert.ok(textOf(document.getElementById("cells-row-cost-heavy")).includes("task-high"), "a Stratum with a row of its own keeps it");
});

test("a consumer's rows read <owner/name>'s runs and carry the footnote under the section", () => {
  const { document, render, model } = harness();
  render(model({ cellEvidence: policyEvidence({ repoUrl: "https://ghe.example.com/acme/widgets" }) }));
  const rows = document.getElementById("cells-rows");
  const text = textOf(rows).replace(/\s+/g, " ");
  assert.ok(text.includes("feigi/fleet-plugin's runs · never fitted · @feigi/fleet-ctl 3.104.0 ¹"));
  assert.equal(rows.children.at(-1).className, "ce-foot");
  assert.equal(rows.children.at(-1).textContent, "¹ this repository's runs reach routing only through its cost guard, which can hold a Cell back but never picks one");
});

test("an install naming no repository draws 'another repository's runs' and 'not checked'", () => {
  const { document, render, model } = harness();
  render(model({ cellEvidence: policyEvidence({ install: { ...rowsInstall, repository: null } }) }));
  const text = textOf(document.getElementById("cells-rows")).replace(/\s+/g, " ");
  assert.ok(text.includes("another repository's runs · never fitted"));
  assert.ok(text.includes("not checked: the install names no repository"));
});

test("a model name label is drawn where a candidate's judged generation differs from its Cell's Tier route model", () => {
  const { document, render, model } = harness();
  const roles = { ...ceRoles, value: { ...ceRoles.value, task: "anthropic/claude-sonnet-5-6:high" } };
  render(model({ cellEvidence: policyEvidence({ table: FITTED_ROWS, modelRoles: roles }) }));
  const text = textOf(document.getElementById("cells-rows")).replace(/\s+/g, " ");
  assert.ok(text.includes("judged on claude-sonnet-5-5; task-high runs anthropic/claude-sonnet-5-6 here"));
});

test("a board.json from before the policy rows draws the tab without them, and no link to them", () => {
  const { document, render, model } = harness();
  const { policy, ...old } = policyEvidence();
  assert.doesNotThrow(() => render(model({ cellEvidence: old })));
  const host = document.getElementById("cells");
  assert.deepEqual(host.children.map((c) => c.id).filter(Boolean), ["cells-guard", "cells-declared"]);
  assert.deepEqual(host.children[0].children.filter((c) => c.tag === "a").map((a) => a.href), ["#cells/guard", "#cells/declared"]);
});
