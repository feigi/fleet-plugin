import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

// The Cell evidence tab is not in the strip yet, so its routes are unknown
// ones here: they land on Board's top rather than naming a tab with no pane.
test("routeHash: a tab the strip does not carry yet lands on Board's top", () => {
  for (const h of ["#cells", "#cells/smol-high@2", "#cells/row/cost/heavy"]) {
    assert.deepEqual(routeHash(h), { tab: "board", target: null }, h);
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

test("the tab strip reads Board · Tokens, in that order, and nothing else", () => {
  assert.ok(strip, "board.html no longer carries <nav id=\"tabs\"> — update this test");
  assert.deepEqual(tabLinks.map((t) => t.text), ["Board", "Tokens"]);
  assert.deepEqual(tabLinks.map((t) => t.href), ["#board", "#tokens"]);
});

test("every tab link routes to its own tab, and none opens a new window", () => {
  for (const t of tabLinks) {
    assert.equal(routeHash(t.href).tab, t.text.toLowerCase(), t.href);
    assert.doesNotMatch(t.attrs, /target\s*=/, `${t.href} must not open a new window`);
  }
});

test("a bare URL opens Board: its tab is marked and its pane is the one not hidden", () => {
  assert.match(HTML, /<a id="tab-board" class="on" href="#board" aria-current="page">/);
  assert.doesNotMatch(HTML, /<a id="tab-tokens"[^>]*class="on"/);
  assert.match(HTML, /<div id="board"><\/div>/, "Board's pane must open visible");
  assert.match(HTML, /<div id="spend" hidden><\/div>/, "Tokens' pane must open closed");
});

// Above the tabs: header, banner, attention strip. Below every tab: the footer.
// Each is a sibling of the two panes, never inside one, so hiding a pane
// hides none of them.
test("header, banner and attention strip sit above the tabs, the footer below both panes", () => {
  const at = (needle) => {
    const i = HTML.indexOf(needle);
    assert.notEqual(i, -1, `board.html no longer carries ${needle} — update this test`);
    return i;
  };
  const order = ["<header>", 'id="stale-banner"', 'id="attention"', 'id="tabs"', 'id="board"', 'id="spend"', 'id="footer"'].map(at);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "the page's top-level order changed");
  // Both panes are closed in the same breath they open, so nothing may nest in them.
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

const STATIC_IDS = new Set(["heading", "age", "stale-banner", "attention", "tabs", "tab-board", "tab-tokens", "board", "spend", "footer"]);

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

  for (const h of ["", "#board", "#nope", "#cells"]) {
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
