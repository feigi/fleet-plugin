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
  constructor() { this.children = []; this.style = {}; this.className = ""; this.attrs = {}; this.listeners = {}; this.scrollTop = 0; this.offsetWidth = 0; }
  get classList() {
    const set = () => new Set(this.className.split(/\s+/).filter(Boolean));
    const write = (s) => { this.className = [...s].join(" "); };
    return {
      add: (c) => write(set().add(c)),
      remove: (c) => { const s = set(); s.delete(c); write(s); },
      toggle: (c, on) => { const s = set(); if (on) s.add(c); else s.delete(c); write(s); },
      contains: (c) => set().has(c),
    };
  }
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
  const document = {
    title: "",
    createElement: () => { const n = new Node(); n.log = log; return n; },
    createTextNode: (text) => ({ text }),
    getElementById(id) {
      if (statics.has(id)) return statics.get(id);
      if (STATIC_IDS.has(id)) { const n = this.createElement(); n.id = id; statics.set(id, n); return n; }
      for (const s of statics.values()) { const hit = find(s, id); if (hit) return hit; }
      return null; // a real document answers null for an id nothing carries
    },
  };
  const location = { hash: "" };
  const window = { scrollTo: (x, y) => log.push(["scrollTo", x, y]) };
  const { render, applyHash } = new Function("document", "location", "window",
    `${SCRIPT_SRC}\nreturn { render, applyHash };`)(document, location, window);
  const model = (o = {}) => ({
    interval: 15, repoUrl: null, generatedAt: Date.now(),
    attention: [], tickets: [], spend: null, queue: {}, filed: [], ...o,
  });
  const open = (hash) => { location.hash = hash; applyHash(); };
  const scrolls = () => log.filter((e) => e[0] === "scrollIntoView").map((e) => e[1]);
  const tops = () => log.filter((e) => e[0] === "scrollTo");
  return { document, render, open, model, log, scrolls, tops };
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
  const { document, render, model, open, scrolls } = harness();
  render(model({ tickets: [{ issue: 12, column: "POOL" }, { issue: 13, column: "REVIEW" }] }));
  open("#board/13");
  assert.deepEqual(scrolls(), ["card-13"]);
  const card = document.getElementById("card-13");
  assert.ok(card.classList.contains("flash"));
  assert.ok(!document.getElementById("card-12").classList.contains("flash"), "only the target flashes");
  // The animation ends once; the class must come off with it so a later arrival can flash again.
  for (const fn of card.listeners.animationend) fn();
  assert.ok(!card.classList.contains("flash"));
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

test("opening the same link again scrolls again", () => {
  const { render, model, open, scrolls } = harness();
  render(model({ tickets: [{ issue: 13, column: "REVIEW" }] }));
  open("#board/13");
  open("#board/13");
  assert.deepEqual(scrolls(), ["card-13", "card-13"]);
});

test("a target no card carries lands on the tab's top, drawn or not yet", () => {
  const { render, model, open, scrolls, tops } = harness();
  open("#board/999");
  render(model({ tickets: [{ issue: 13, column: "REVIEW" }] }));
  assert.deepEqual(scrolls(), []);
  assert.deepEqual(tops(), [["scrollTo", 0, 0]]);
  open("#tokens");
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
