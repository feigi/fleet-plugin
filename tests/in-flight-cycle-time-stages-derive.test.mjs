// docs/research/in-flight-cycle-time-stages-derive.mjs — the population block's
// two span-scoped counts and the listing fetch time it prints.
//
// The script is a CLI with no exports, so each case runs it as a child process
// over a fixture. GitHub is a stub `curl` on PATH that serves canned REST pages
// from a JSON map and logs every request, so nothing here touches the network.
// Its --cache is a temp directory: a second run on that cache must make no
// request, and its open listing is dated by the mtimes of its cache files.
//
// Zero deps: `node --test tests/in-flight-cycle-time-stages-derive.test.mjs`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./support/temp-dir.mjs";
import { writeExecStub } from "./support/exec-stub.mjs";

const SCRIPT = new URL("../docs/research/in-flight-cycle-time-stages-derive.mjs", import.meta.url).pathname;
const REPO = "feigi/fleet-plugin";
const PER_PAGE = 100;
const DAY = 86_400_000;
const T0 = Date.parse("2026-09-01T00:00:00Z");
const iso = (ms) => new Date(ms).toISOString();

// Request paths as the script builds them (api() and pagedList()).
const CLOSED_PAGE = (n) => `pulls?state=closed&sort=created&direction=desc&per_page=${PER_PAGE}&page=${n}`;
const CLOSED = CLOSED_PAGE(1);
const OPEN_1 = `pulls?state=open&per_page=${PER_PAGE}&page=1`;
const OPEN_2 = `pulls?state=open&per_page=${PER_PAGE}&page=2`;
// cacheFile() in the script: the repo, then the request path with every character
// outside [A-Za-z0-9._-] turned into `_`.
const cachePath = (s, q) => join(s.cache, `${REPO.replace("/", "__")}__${q.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);

const OPEN_PREFIX = "- Open PRs created inside the population's span";
const QUERY_PREFIX = "- Query: ";

// The stub: prints the mapped body (or `[]`) and the 200 status curl's `-w` would
// add, and appends the request URL to STUB_DIR/requests.log.
const CURL_BODY = [
  `#!${process.execPath}`,
  `const fs = require("node:fs");`,
  `const path = require("node:path");`,
  `const dir = process.env.STUB_DIR;`,
  `const url = process.argv[process.argv.length - 1];`,
  `fs.appendFileSync(path.join(dir, "requests.log"), url + "\\n");`,
  `const map = JSON.parse(fs.readFileSync(path.join(dir, "responses.json"), "utf8"));`,
  `const key = url.replace(/^https:\\/\\/api\\.github\\.com\\/repos\\/[^/]+\\/[^/]+\\//, "");`,
  `process.stdout.write(JSON.stringify(key in map ? map[key] : []) + "\\n200");`,
  ``,
].join("\n");

// The 12 population PRs 1101–1112, created a day apart (T0 + i days). Their
// merges are shaped for the stage regressions: PR i+2 is created an hour after
// PR i merges (so a merge sits in the two hours before most later opens), and
// the last two merge two days after opening. Each one carries a commit two
// hours after opening, a `ready-to-merge` label a day after opening, and a
// comment every 29 minutes until it merges, so no two-hour window before a PR's
// open is dormant. Every other per-PR endpoint is absent from the map: `[]`.
const POP_MERGED_AT = (i) => (i < 10 ? T0 + (i + 2) * DAY - 3600_000 : T0 + i * DAY + 2 * DAY);
const merged = (i) => ({ number: 1101 + i, created_at: iso(T0 + i * DAY), merged_at: iso(POP_MERGED_AT(i)), body: "" });
function perPr() {
  const out = {};
  for (let i = 0; i < 12; i++) {
    const n = 1101 + i, created = T0 + i * DAY, mergedAt = POP_MERGED_AT(i);
    out[`issues/${n}/events?per_page=${PER_PAGE}&page=1`] = [{ event: "labeled", created_at: iso(created + DAY), label: { name: "ready-to-merge" } }];
    out[`pulls/${n}/commits?per_page=${PER_PAGE}&page=1`] = [{ sha: String(n), commit: { author: { date: iso(created + 2 * 3600_000) }, committer: { date: iso(created + 2 * 3600_000) } } }];
    const comments = [];
    for (let t = created; t < mergedAt; t += 29 * 60_000) comments.push({ body: "checking in", created_at: iso(t) });
    out[`issues/${n}/comments?per_page=${PER_PAGE}&page=1`] = comments;
  }
  return out;
}
const unmerged = (number, created) => ({ number, created_at: iso(created), merged_at: null, body: "" });
const open = (number, created) => ({ number, created_at: iso(created), merged_at: null, body: "" });

// Population: the 12 merged PRs 1101–1112, created a day apart, so the span is
// T0 (#1101) … T0 + 11 days (#1112). Two closed-unmerged PRs share the window:
// #1150 inside the span, #1160 after its newest PR.
const closedListing = [
  ...Array.from({ length: 12 }, (_, i) => merged(i)),
  unmerged(1150, T0 + 5.5 * DAY),
  unmerged(1160, T0 + 12 * DAY),
].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));

// Open listing, two pages. Page 1 is full (100 PRs, all created after the span),
// so the script must read page 2 too. Page 2 holds the boundary cases: #1903
// created at the span's first PR and #1902 at its last (both inside, the span is
// inclusive), #1901 inside, #1900 before it and #1904 after it.
function fixture({ inSpan }) {
  const page2 = inSpan
    ? [open(1900, T0 - 2 * DAY), open(1903, T0), open(1901, T0 + 4 * DAY), open(1902, T0 + 11 * DAY), open(1904, T0 + 11 * DAY + 1)]
    : [open(1900, T0 - 2 * DAY), open(1904, T0 + 11 * DAY + 1)];
  return {
    ...perPr(),
    [CLOSED]: closedListing,
    [OPEN_1]: Array.from({ length: PER_PAGE }, (_, i) => open(2000 + i, T0 + 20 * DAY + i * 60_000)),
    [OPEN_2]: page2,
  };
}

function setup({ inSpan }) {
  const dir = tempDir("in-flight-cycle-time-");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeExecStub(join(bin, "curl"), CURL_BODY);
  writeFileSync(join(dir, "responses.json"), JSON.stringify(fixture({ inSpan })));
  return { dir, bin, cache: join(dir, "cache") };
}

// Runs the script with a PATH holding only the stub, so `gh` is absent and every
// request goes to curl. The child's cwd is the fixture directory, outside any repo.
// PYTHONDONTWRITEBYTECODE is set as for every child in this suite; the script is
// Node, so it has no effect here.
function run(s, extra = []) {
  const r = spawnSync(process.execPath, [SCRIPT, "--population", "12", "--cache", s.cache, ...extra], {
    encoding: "utf8",
    cwd: s.dir,
    env: { PATH: s.bin, STUB_DIR: s.dir, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(r.status, 0, `derive exited ${r.status}: ${r.stderr}`);
  return r;
}
function derive(s, extra = []) {
  return run(s, extra).stdout;
}

function requests(s) {
  const f = join(s.dir, "requests.log");
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : [];
}

function line(out, prefix) {
  const l = out.split("\n").find((x) => x.startsWith(prefix));
  assert.ok(l, `no output line starts with ${prefix}`);
  return l;
}

const setFetched = (s, q, ms) => utimesSync(cachePath(s, q), new Date(ms), new Date(ms));
const T_LATE = Date.parse("2026-10-10T08:00:00Z");
const T_EARLY = Date.parse("2026-10-03T06:30:00Z");

test("the Open PRs line lists the in-span open PRs, and dates them by the earliest mtime of the listing's pages", () => {
  const s = setup({ inSpan: true });
  const fresh = derive(s);
  const fetchedLive = requests(s).length;
  assert.ok(fetchedLive > 0, "the first run fetches every page");

  const warm = derive(s);
  assert.equal(requests(s).length, fetchedLive, "a second run on the same cache makes no request");
  assert.equal(line(warm, OPEN_PREFIX), line(fresh, OPEN_PREFIX), "two runs on one cache print the same listing fetched time");

  // Page 1 was fetched later than page 2: the listing is as old as its earliest page.
  setFetched(s, OPEN_1, T_LATE);
  setFetched(s, OPEN_2, T_EARLY);
  assert.equal(
    line(derive(s), OPEN_PREFIX),
    `${OPEN_PREFIX} (\`GET /pulls?state=open\`, listing fetched 2026-10-03T06:30:00.000Z): 3 (#1903, #1901, #1902).`,
  );
  assert.equal(requests(s).length, fetchedLive, "still no request: the listing comes from the cache");
});

test("a run with --refresh re-fetches the listing and prints a later fetch time", () => {
  const s = setup({ inSpan: true });
  derive(s);
  setFetched(s, OPEN_1, T_EARLY);
  setFetched(s, OPEN_2, T_EARLY);
  const before = Date.now();
  const refreshed = derive(s, ["--refresh"]);
  assert.ok(requests(s).some((u) => u.includes(OPEN_1)), "--refresh asks for page 1 again");
  assert.ok(requests(s).some((u) => u.includes(OPEN_2)), "--refresh asks for page 2 again");
  const stamp = line(refreshed, OPEN_PREFIX).match(/listing fetched (\S+?)\):/)[1];
  assert.notEqual(stamp, iso(T_EARLY));
  assert.ok(Date.parse(stamp) >= before - 1000, `fetch time ${stamp} is from this run`);
});

test("with no still-open PR from the window inside the span, the line says none is missing", () => {
  const s = setup({ inSpan: false });
  derive(s);
  setFetched(s, OPEN_1, T_LATE);
  setFetched(s, OPEN_2, T_EARLY);
  assert.equal(
    line(derive(s), OPEN_PREFIX),
    `${OPEN_PREFIX} (\`GET /pulls?state=open\`, listing fetched 2026-10-03T06:30:00.000Z): 0 — no still-open PR from the window is missing from the depth count.`,
  );
});

test("the Query line counts closed-unmerged PRs inside the span apart from those outside it", () => {
  const s = setup({ inSpan: true });
  assert.equal(
    line(derive(s), QUERY_PREFIX),
    "- Query: `GET /repos/feigi/fleet-plugin/pulls?state=closed&sort=created&direction=desc&per_page=100&page=1..1` → 14 closed PRs, 12 merged, 1 closed-unmerged dropped inside the population's span, 1 outside it; population = the first 12 merged.",
  );
});

// ---- a closed listing filled from two cache fills -------------------------------
// A deeper run takes closed pages 1..k from an earlier fill and later pages live.
// If the listing shifted between the fills, a PR ends a cached page and starts the
// next live one. Page 1 is pre-seeded into the cache, as that earlier fill left it;
// page 2 is served by the stub, as the live fill. The --refresh case serves both
// pages live, as a listing that shifted while one run read it.
const filler = (count) => Array.from({ length: count }, (_, i) => unmerged(3000 + i, T0 + 30 * DAY - i * 60_000));
const olderMerged = (number, daysBefore) => ({ number, created_at: iso(T0 - daysBefore * DAY), merged_at: iso(T0 - daysBefore * DAY + 3600_000), body: "" });
const requested = (s, needle) => requests(s).filter((u) => u.includes(needle)).length;

function setupPages(page1, page2) {
  assert.equal(page1.length, PER_PAGE, "page 1 must be full, or the listing ends there");
  const s = setup({ inSpan: false });
  writeFileSync(join(s.dir, "responses.json"), JSON.stringify({ ...perPr(), [CLOSED_PAGE(2)]: page2 }));
  mkdirSync(s.cache, { recursive: true });
  writeFileSync(cachePath(s, CLOSED_PAGE(1)), JSON.stringify(page1));
  return s;
}
const withoutOpenLine = (out) => out.split("\n").filter((l) => !l.startsWith(OPEN_PREFIX)).join("\n");
const rowCount = (out, n) => out.split("\n").filter((l) => l.startsWith(`| #${n} |`)).length;
const DUP_NOTICE = /dropped 1 duplicate PR from the closed listing: it shifted between page reads \(pages from different cache fills, or a PR created mid-run\); re-run with --refresh/;
// Page 1 holds #1112…#1106 (with closed-unmerged #1150 between #1107 and #1106);
// the rest of the listing is #1105…#1101.
const PAGE1_ENDS_1106 = [...filler(92), ...[11, 10, 9, 8, 7, 6].map(merged), unmerged(1150, T0 + 5.5 * DAY), merged(5)];
const REST_1105 = [4, 3, 2, 1, 0].map(merged);

test("a PR ending a cached closed page and starting the next live one is counted once in the population, the Query line and the per-PR rows", () => {
  // Page 2 starts with #1106 again.
  const s = setupPages(PAGE1_ENDS_1106, [merged(5), ...REST_1105]);
  const r = run(s);
  assert.equal(
    line(r.stdout, QUERY_PREFIX),
    "- Query: `GET /repos/feigi/fleet-plugin/pulls?state=closed&sort=created&direction=desc&per_page=100&page=1..2` → 105 closed PRs, 12 merged, 1 closed-unmerged dropped inside the population's span, 92 outside it; population = the first 12 merged.",
  );
  assert.equal(rowCount(r.stdout, 1106), 1, "#1106 has one per-PR row");
  assert.equal(rowCount(r.stdout, 1101), 1, "the duplicate did not push #1101 out of the population");
  assert.equal(requested(s, "issues/1106/events"), 1, "#1106 is read once");
  assert.equal(requested(s, CLOSED_PAGE(1)), 0, "closed page 1 came from the cache");
  assert.match(r.stderr, DUP_NOTICE);
  assert.ok(line(r.stdout, "- Buffer (").startsWith("- Buffer (0 merged PRs older than the population"), "no population PR is in the buffer");

  // The same listing from a single fill: no notice, and a report equal but for the listing's fetch time.
  const rc = run(setupPages(PAGE1_ENDS_1106, REST_1105));
  assert.ok(!/duplicate/.test(rc.stderr), `no notice without a duplicate: ${rc.stderr}`);
  assert.equal(withoutOpenLine(r.stdout), withoutOpenLine(rc.stdout));
});

test("when the two copies of a duplicate differ, the first in listing order is the one counted", () => {
  // The live copy of #1106 merged a day later than the cached one says. The cached
  // copy comes first in the listing, so the report is the one the cached copy alone gives.
  const later = { ...merged(5), merged_at: iso(POP_MERGED_AT(5) + DAY) };
  const r = run(setupPages(PAGE1_ENDS_1106, [later, ...REST_1105]));
  const rc = run(setupPages(PAGE1_ENDS_1106, REST_1105));
  assert.equal(withoutOpenLine(r.stdout), withoutOpenLine(rc.stdout));
});

test("with --refresh, a duplicate across two live page reads is reported as a mid-run shift", () => {
  const s = setupPages(PAGE1_ENDS_1106, [merged(5), ...REST_1105]);
  const live = JSON.parse(readFileSync(join(s.dir, "responses.json"), "utf8"));
  writeFileSync(join(s.dir, "responses.json"), JSON.stringify({ ...live, [CLOSED_PAGE(1)]: PAGE1_ENDS_1106 }));
  const r = run(s, ["--refresh"]);
  assert.equal(requested(s, CLOSED_PAGE(1)), 1, "closed page 1 was read live");
  assert.equal(rowCount(r.stdout, 1106), 1, "#1106 has one per-PR row");
  assert.match(r.stderr, /dropped 1 duplicate PR from the closed listing: it shifted while its pages were read live \(a PR created mid-run\); re-run with --refresh/);
});

test("two duplicates are counted in a plural notice", () => {
  // Page 1 ends with #1106 and #1105; page 2 starts with both again.
  const page1 = [...filler(92), ...[11, 10, 9, 8, 7, 6, 5, 4].map(merged)];
  const r = run(setupPages(page1, [5, 4, 3, 2, 1, 0].map(merged)));
  assert.equal(rowCount(r.stdout, 1106), 1, "#1106 has one per-PR row");
  assert.equal(rowCount(r.stdout, 1105), 1, "#1105 has one per-PR row");
  assert.match(r.stderr, /dropped 2 duplicate PRs from the closed listing: /);
});

test("a duplicate that lands only in the buffer pages is counted once in the buffer", () => {
  // Page 1: 86 closed-unmerged, the 12 population PRs, then older merged #1096 and #1095
  // (the buffer's left-over). The live buffer page starts with #1095 again.
  const page1 = [...filler(86), ...[11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map(merged), olderMerged(1096, 2), olderMerged(1095, 3)];
  const rest = [olderMerged(1094, 4), olderMerged(1093, 5)];
  const s = setupPages(page1, [olderMerged(1095, 3), ...rest]);
  const r = run(s);
  assert.equal(
    line(r.stdout, "- Buffer (").split(":")[0],
    "- Buffer (4 merged PRs older than the population, #1093–#1096",
  );
  assert.match(line(r.stdout, "- Buffer ("), /: 2 left over past the population on its last listing page, 1 older page read\)/);
  assert.match(r.stderr, DUP_NOTICE);
  const rc = run(setupPages(page1, rest));
  assert.equal(rc.stderr.split("\n").filter((l) => !l.startsWith("transport:") && l.trim()).length, 0, `stderr is only the transport line: ${rc.stderr}`);
  assert.equal(withoutOpenLine(r.stdout), withoutOpenLine(rc.stdout));
});

test("a population PR repeated at the start of a buffer page is not added to the buffer", () => {
  // Page 1 ends with #1101, the population's oldest PR; the live buffer page starts with it again.
  const page1 = [...filler(88), ...[11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map(merged)];
  const rest = [olderMerged(1095, 3), olderMerged(1094, 4)];
  const s = setupPages(page1, [merged(0), ...rest]);
  const r = run(s);
  assert.ok(
    line(r.stdout, "- Buffer (").startsWith("- Buffer (2 merged PRs older than the population, #1094–#1095: 0 left over"),
    line(r.stdout, "- Buffer ("),
  );
  assert.equal(rowCount(r.stdout, 1101), 1);
  assert.equal(requested(s, "issues/1101/events"), 1, "#1101 is read once");
  assert.match(r.stderr, DUP_NOTICE);
});
