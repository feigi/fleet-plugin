// Regression gate for the diff-sizing classifier and profile ladder that scale a
// review's fan-out. Zero deps: `node --test plugin/scripts/diff-stats.test.mjs`.
// Locks the load-bearing behaviours a "simplification" could silently break —
// especially that code under docs/ or .github/ keeps `src`, and that a mixed
// docs+src PR is NOT docsOnly (so it keeps the fuller review).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { classify, computeStats } from "./diff-stats.mjs";

// `main()` runs only when this file is executed directly, so the CLI wiring is
// unreachable from a unit test. Pinned as source text instead — see the
// truncation test at the bottom for why it needs pinning at all.
const SCRIPT = join(import.meta.dirname, "diff-stats.mjs");
const CLI = readFileSync(SCRIPT, "utf8");

test("classifier priority: test > code-ext > docs/config-dir", () => {
  // src is the residue
  assert.equal(classify("src/a.ts"), "src");
  assert.equal(classify("workflows/review-pr.js"), "src");
  // test wins even though a .test.ts is also a .ts
  assert.equal(classify("a.test.ts"), "test");
  assert.equal(classify("pkg/__tests__/a.ts"), "test");
  // prose
  assert.equal(classify("README.md"), "docs");
  assert.equal(classify("docs/guide.md"), "docs");
  // config by extension / location / naming convention
  assert.equal(classify(".github/workflows/ci.yml"), "config");
  assert.equal(classify("package.json"), "config");
  assert.equal(classify("vite.config.ts"), "config");
  assert.equal(classify(".eslintrc"), "config");
  // M1: a code file stays `src` even under docs/ or .github/, so the src-gated
  // dimensions (types, silent-failure, simplify) are not silently dropped on it.
  assert.equal(classify("docs/examples/deploy.ts"), "src");
  assert.equal(classify(".github/scripts/action.mjs"), "src");
  assert.equal(classify("packages/x/docs/gen.mjs"), "src");
});

test("computeStats: profile ladder", () => {
  assert.equal(computeStats([]).profile, "empty");
  assert.equal(computeStats([{ path: "a.md", additions: 3, deletions: 1 }]).profile, "docs");
  assert.equal(computeStats([{ path: "a.test.ts", additions: 5, deletions: 0 }]).profile, "tests-only");
  assert.equal(computeStats([{ path: "a.ts", additions: 1, deletions: 0 }]).profile, "single-file");
  assert.equal(
    computeStats([
      { path: "a.ts", additions: 2, deletions: 0 },
      { path: "b.ts", additions: 2, deletions: 0 },
    ]).profile,
    "small",
  );
  assert.equal(
    computeStats([
      { path: "a.ts", additions: 20, deletions: 0 },
      { path: "b.ts", additions: 20, deletions: 0 },
    ]).profile,
    "production",
  );
});

test("computeStats: docsOnly is strict — docs+src keeps the fuller review", () => {
  const docs = computeStats([{ path: "a.md", additions: 3, deletions: 1 }]);
  assert.equal(docs.docsOnly, true);
  assert.equal(docs.hasSrc, false);
  assert.equal(docs.loc, 4);

  const mixed = computeStats([
    { path: "a.md", additions: 2, deletions: 0 },
    { path: "b.ts", additions: 2, deletions: 0 },
  ]);
  assert.equal(mixed.docsOnly, false, "docs+src must not be docsOnly");
  assert.equal(mixed.hasSrc, true);

  // docs + a CI workflow is also not docsOnly (config present)
  const docsPlusCi = computeStats([
    { path: "a.md", additions: 2, deletions: 0 },
    { path: ".github/workflows/ci.yml", additions: 1, deletions: 0 },
  ]);
  assert.equal(docsPlusCi.docsOnly, false);
  assert.equal(docsPlusCi.hasConfig, true);
});

test("computeStats: the four routing booleans are pinned together on a production PR", () => {
  // review-pr.js selectDimensions routes on exactly hasSrc/hasTests/hasConfig/
  // docsOnly. Assert all four at once so any single one flipping is caught here,
  // not only transitively via the profile-ladder test.
  const prod = computeStats([
    { path: "src/a.ts", additions: 5, deletions: 0 },
    { path: "a.test.ts", additions: 5, deletions: 0 },
    { path: "package.json", additions: 1, deletions: 0 },
  ]);
  assert.deepEqual(
    { hasSrc: prod.hasSrc, hasTests: prod.hasTests, hasConfig: prod.hasConfig, docsOnly: prod.docsOnly },
    { hasSrc: true, hasTests: true, hasConfig: true, docsOnly: false },
  );
});

test("classify: extensionless files fall to src (fail-open residue)", () => {
  // The residue default keeps the src-gated dimensions (types/silent-failure/
  // simplify) running on unknown files — the safe direction. Pin it so a future
  // "tidy the residue" edit can't silently reroute unknowns to docs/config.
  assert.equal(classify("Dockerfile"), "src");
  assert.equal(classify("Makefile"), "src");
  assert.equal(classify("bin/deploy"), "src");
  assert.equal(classify("foo.config.mjs"), "config"); // config-by-name still wins
});

test("computeStats: loc tolerates a file missing additions/deletions", () => {
  assert.equal(computeStats([{ path: "a.ts" }]).loc, 0);
  assert.equal(computeStats([{ path: "a.ts", additions: 3 }]).loc, 3);
});

// `gh pr view --json files` pages at 100 and exits 0, so a 124-file PR arrives
// as a fully-formed 100-file measurement with nothing contradicting it —
// measured on microsoft/vscode#329568. `changedFiles` from the same query is the
// only disagreement available. Absent on every normal PR: `review-pr.js` reads
// its PRESENCE as "widen the fan-out, this list is short", so a flag set when
// the counts agree would widen every review.
test("computeStats: truncated is set only when gh's file list is short", () => {
  const files = Array.from({ length: 100 }, (_, i) => ({ path: `src/f${i}.ts`, additions: 1 }));
  assert.equal(computeStats(files, 124).truncated, 124);
  assert.equal(computeStats(files, 100).truncated, undefined, "counts agree — a complete list is not truncated");
  assert.equal(computeStats(files).truncated, undefined, "gh omitted changedFiles — no cap can be inferred");
  // A short list under-reports `files` too, so nothing else in the blob can
  // stand in for the flag.
  assert.equal(computeStats(files, 124).files, 100);
});

// `truncated` is computed from an argument, and nothing above proves the CLI
// ever passes one. Both tokens are needed and each disconnects the whole cap
// detection alone: drop `changedFiles` from the query and `info.changedFiles` is
// undefined, drop the second argument and the value never reaches computeStats.
// Either way every PR reports as complete, `review-pr.js` keeps stamping its
// file list "and no others", and the tests above stay green against a copy
// nothing calls.
test("the CLI actually asks gh for changedFiles and passes it through", () => {
  assert.match(
    CLI,
    /"pr", "view", String\(pr\), "--json", "files,changedFiles"/,
    "the gh query no longer requests changedFiles — nothing can reveal the 100-file cap",
  );
  assert.match(
    CLI,
    /computeStats\(info\.files, info\.changedFiles\)/,
    "the CLI computes stats without the uncapped count — `truncated` is never set in production",
  );
});

// #169: `--pr` given with no value was already caught by `if (!pr) die(...)`
// below — `undefined` is falsy — so this was never a silent-widening site.
// Pin that it now refuses explicitly, by name, instead of falling through to
// the generic usage message; and that `--pr=5` (invisible to `indexOf`) is
// rejected the same way rather than reading as absent.
test("CLI: trailing --pr (no value) dies (exit 2) naming the flag", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--pr"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--pr needs a value/);
});

test("CLI: --pr=5 form dies by name, not silently read as absent", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--pr=5"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--pr needs a space-separated value/);
});

// The other two branches of the same guard. `--pr` is this script's only flag,
// so the next-flag case needs an unknown one to collide with — the guard is on
// the value's shape, not on the following flag being real.
test("CLI: --pr followed by another flag is rejected, not consumed as the PR ref", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--pr", "--json"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--pr needs a value/);
});

test("CLI: --pr given an empty value dies naming the flag", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--pr", ""], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--pr needs a value/);
});

// The other half of arg()'s guard: every case above is a value it must
// REFUSE. Nothing above ever hands main() a well-formed value, so #367's
// shared arg() could return `undefined` for every accepted input and this
// file would stay green. `--pr 5` must reach gh and succeed.
// The fail-closed guard this file never exercised: `gh pr view --json
// files,changedFiles` can exit 0 with a body holding no `files` key at all
// (an unexpected `gh` output shape, or a proxy's JSON error envelope). Before
// this guard, `info.files` read as `undefined` and computeStats([]) silently
// reported `profile: "empty"` — exit 0, indistinguishable from a real empty
// PR, review-pr.js WIDENS that to the full specialist set on the strength of
// a lie. The guard must refuse instead.
test("CLI: gh returning no files array dies (exit 2) rather than reporting a fabricated empty PR", () => {
  const bin = mkdtempSync(join(tmpdir(), "diff-stats-bin-"));
  const gh = join(bin, "gh");
  writeFileSync(gh, '#!/bin/sh\necho \'{"changedFiles":1}\'\n');
  chmodSync(gh, 0o755);
  const r = spawnSync(process.execPath, [SCRIPT, "--pr", "5"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  rmSync(bin, { recursive: true, force: true });
  assert.equal(r.status, 2, `a missing files array must refuse, not report an empty PR; got ${r.status} ${r.stdout}${r.stderr}`);
  assert.equal(r.stdout.trim(), "", "exit 2 emits no payload — a payload here would be the fabricated measurement this guard exists to prevent");
  assert.match(r.stderr, /gh returned no files array/);
});

// The one case the guard above still missed: `JSON.parse("null")` succeeds
// and returns `null`, not an object — so `info.files` threw a TypeError
// before `!Array.isArray(info.files)` ever ran, crashing at exit 1 with a raw
// stack trace instead of refusing at the named exit 2 this file's own
// comment says the guard exists to produce (#1307). The message is worded
// "no body" rather than reusing "no files array", so a reader chasing a
// missing key is not sent looking for a key that was never the problem —
// nothing came back at all.
test("CLI: gh returning a null body dies (exit 2) naming the missing body, not a TypeError", () => {
  const bin = mkdtempSync(join(tmpdir(), "diff-stats-bin-"));
  const gh = join(bin, "gh");
  writeFileSync(gh, "#!/bin/sh\necho null\n");
  chmodSync(gh, 0o755);
  const r = spawnSync(process.execPath, [SCRIPT, "--pr", "5"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  rmSync(bin, { recursive: true, force: true });
  assert.equal(r.status, 2, `a null body must refuse, not crash; got ${r.status} ${r.stdout}${r.stderr}`);
  assert.equal(r.stdout.trim(), "", "exit 2 emits no payload");
  assert.match(r.stderr, /gh returned no body/);
  assert.doesNotMatch(r.stderr, /TypeError/, "a null body must not reach the raw TypeError this guard exists to prevent");
});

test("CLI: a well-formed --pr value is accepted and the CLI succeeds", () => {
  const bin = mkdtempSync(join(tmpdir(), "diff-stats-bin-"));
  const gh = join(bin, "gh");
  writeFileSync(gh, '#!/bin/sh\necho \'{"files":[{"path":"a.ts","additions":1,"deletions":0}],"changedFiles":1}\'\n');
  chmodSync(gh, 0o755);
  const r = spawnSync(process.execPath, [SCRIPT, "--pr", "5"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  rmSync(bin, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.pr, 5);
  assert.equal(payload.profile, "single-file");
});

// #932: the non-JSON die above quoted `raw.trim().slice(0, 120)` with NO
// marker, so a 269 KB portal page and a 90-character one rendered identically —
// a reader could not tell gh's whole output from this script's clip of it. The
// length quoted is gh's, not this script's, which is the lie the marker closes.
// Nothing in this file reached that path at all before these four tests: the
// guards above cover a missing `files` key and a `null` body, both of which
// PARSE. A suite that never enters the mode cannot see the defect in it.
//
// DIRECTION, measured here rather than inherited (#638/PR #931 fixed the same
// unmarked clip in ledger.mjs by keeping the TAIL, and copying that here would
// keep the noise and discard the cause):
//   - `run()` passes no `stdio`, so execFileSync forwards the child's stderr to
//     this process's stderr and returns stdout ALONE. `raw` is gh's stdout, not
//     its stderr — the stream-check below pins exactly that, and it is the whole
//     of why ledger.mjs's tail rationale (a FATAL line behind seven warnings)
//     does not transfer.
//   - Real gh 2.100.0 never puts non-JSON on stdout: a missing PR, bad
//     credentials and an intercepting proxy all report on stderr at exit 1,
//     which `run()`'s catch takes, and stdout stays empty. Forcing a TTY, a
//     pager and `GH_DEBUG=api` each left stdout pure JSON. A payload past
//     execFileSync's 1 MiB maxBuffer throws ENOBUFS rather than returning a
//     mid-JSON cut, so the one shape whose cause would sit at the tail cannot
//     reach `raw` either.
//   - So this path is only ever reached when something OTHER than gh owns that
//     stdout — a wrapper, shim or portal interposed on it — and such a producer
//     leads with its own message. Measured on real bytes: github.com's 404 body
//     ends `</div>\n  </body>\n</html>`, boilerplate every HTML page on earth
//     shares, while its first 120 characters carry `<!DOCTYPE html>`; a wrapper
//     that prints a notice and then delegates ends in `"changeType":"MODIFIED"}]}`,
//     which reads as gh having answered perfectly and the parser being at fault.
//     The head carries the cause on both, and the tail actively misleads on one.
const runWithGhStdout = (body) => {
  const bin = mkdtempSync(join(tmpdir(), "diff-stats-bin-"));
  const payload = join(bin, "payload");
  writeFileSync(payload, body);
  // `cat` of a file, not `echo` of an inlined string: the payloads below are
  // real captured bytes, quotes and all, and must reach stdout unmangled.
  writeFileSync(join(bin, "gh"), `#!/bin/sh\ncat "${payload}"\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const r = spawnSync(process.execPath, [SCRIPT, "--pr", "5"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  rmSync(bin, { recursive: true, force: true });
  return r;
};

// What the refusal actually quoted: everything after the em-dash to the end of
// that line. `.` excludes `\n`, so a multi-line payload is read to its first
// newline only — which is why the cap case below uses a single-line payload.
const quoted = (stderr) => {
  const m = /returned no JSON — (.*)/.exec(stderr);
  assert.ok(m, `no non-JSON refusal on stderr: ${stderr}`);
  return m[1];
};

// A real intercepting-proxy body: nginx's 502 template, the measured shape of
// what a corporate portal hands back in place of api.github.com's JSON.
const PORTAL = '<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1></center><center>corp-proxy-7 could not reach api.github.com: upstream refused</center><hr><center>nginx/1.24.0</center></body></html>';

test("CLI: an over-long non-JSON payload is quoted behind a visible truncation marker", () => {
  const r = runWithGhStdout(PORTAL);
  assert.equal(r.status, 2, `a non-JSON body must refuse; got ${r.status} ${r.stdout}${r.stderr}`);
  assert.equal(r.stdout.trim(), "", "exit 2 emits no payload");
  assert.match(
    quoted(r.stderr),
    /… \(truncated\)$/,
    "a clipped diagnostic must say it was clipped — unmarked, the reader takes this script's 120 characters for the whole of gh's output",
  );
});

// The other half of the guard. A marker appended unconditionally would make
// every complete diagnostic read as a cut one — the same lie inverted, and a
// suite that only ever feeds this path an over-long payload pins neither half.
// 88 characters, the measured length of a real portal's 403 body, is a payload
// it must ACCEPT and quote whole.
test("CLI: a non-JSON payload that fits is quoted whole, with no marker", () => {
  const short = '<!DOCTYPE html><html><head><title>403 Forbidden</title></head><body>portal</body></html>';
  assert.ok(short.length <= 120, "this fixture only tests the accept path while it fits the cap");
  const r = runWithGhStdout(short);
  assert.equal(r.status, 2);
  assert.equal(quoted(r.stderr), short, "a payload that fits must be quoted exactly, not reshaped");
  assert.doesNotMatch(quoted(r.stderr), /truncated/, "nothing was cut, so nothing may claim it was");
});

test("CLI: the clip keeps the HEAD of gh's stdout, where this path's cause sits", () => {
  const q = quoted(runWithGhStdout(PORTAL).stderr);
  assert.match(q, /^<!DOCTYPE html>/, "the head identifies the payload as an HTML page — the one fact this refusal exists to deliver");
  assert.match(q, /502 Bad Gateway/, "and carries the proxy's own status line");
  assert.doesNotMatch(
    q,
    /<\/html>/,
    "keeping the tail here would quote `</body></html>` — boilerplate shared by every HTML error page, naming no cause at all",
  );
});

// #931's remedy for the sibling site was measured wrong in exactly this way:
// `…${raw.slice(-500)}` produces a 501-character payload, so the marker pushed
// the value past the cap the comment above it argued for. This script's stderr
// is read by review-pr.js's snapshot agent — markdown fed to a model, the same
// context budget `run()`'s comment measures in bytes — so the cap is the
// contract and the marker is part of what it bounds.
test("CLI: the marker lives inside the 120-char cap, not past it", () => {
  const q = quoted(runWithGhStdout(PORTAL).stderr);
  assert.ok(
    q.length <= 120,
    `the quoted payload including its marker must fit the 120-char cap; got ${q.length}: ${JSON.stringify(q)}`,
  );
});

// The premise the direction above rests on, pinned so it cannot rot silently:
// `raw` is gh's stdout ALONE. If a future edit added `stdio: ["ignore","pipe","pipe"]`
// to run() and folded stderr in, the cause would move to the tail and the head
// clip would start discarding it — the inversion this ticket exists to avoid.
test("CLI: the quoted payload is gh's stdout alone — stderr never enters it", () => {
  const bin = mkdtempSync(join(tmpdir(), "diff-stats-bin-"));
  writeFileSync(join(bin, "gh"), '#!/bin/sh\necho "STDERR-ONLY-LINE" >&2\necho "<html>not json</html>"\n');
  chmodSync(join(bin, "gh"), 0o755);
  const r = spawnSync(process.execPath, [SCRIPT, "--pr", "5"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  rmSync(bin, { recursive: true, force: true });
  assert.equal(r.status, 2);
  assert.equal(quoted(r.stderr), "<html>not json</html>", "the payload is stdout");
  assert.match(r.stderr, /STDERR-ONLY-LINE/, "the child's stderr is still forwarded — it is not swallowed, just not quoted");
});
