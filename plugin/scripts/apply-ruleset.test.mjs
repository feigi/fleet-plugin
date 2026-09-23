// #164 / ADR 0007. Gate for `.github/scripts/apply-ruleset.sh`, the only
// sanctioned path for changing this repo's merge gate.
//
// The script's own header calls the post-write readback "the whole point of the
// script", and every branch it has is an error branch: the happy path is one
// line. Nothing executed it before this file — it was reachable only through
// prose. So what is pinned here is the behaviour an operator reads off it:
// the exit status, the message, and whether a PUT was issued at all.
//
// Three defects this file was written against, all reproduced before the fix:
//   - the name lookup did not filter `source_type == "Repository"`, so an
//     inherited org ruleset sharing the name either blocked the applier or sent
//     the PUT to the parent's id (which the repo token cannot write);
//   - the post-PUT readback was an unguarded command substitution, so the one
//     state that matters — write landed, cannot be proven — exited with `gh`'s
//     raw status and no message naming the unverified write;
//   - `norm` compared `rules` positionally, so a server-side reorder turned a
//     correct gate into a permanent refusal.
//
// Nothing here executes a workflow or reaches the network: `gh` is a stub on
// PATH and the script under test is the real file at the repo root, never a
// copy. `t_applies_a_genuine_difference` is the harness's positive control — if
// the stub or the PATH were wrong, every "exits 2" assertion below would pass
// for the wrong reason, and that one would fail.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCRIPT = join(ROOT, ".github/scripts/apply-ruleset.sh");
const SHIPPED_SPEC = join(ROOT, ".github/rulesets/main.json");
// Resolved once from the ambient PATH: the missing-tool tests below hand the
// script a PATH with one entry, and a relative `bash` would then fail to spawn
// at all — an error indistinguishable from the refusal being asserted.
const BASH = which("bash");

function which(name) {
  const found = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
  assert.equal(found.status, 0, `${name} must be on PATH for this file to test anything`);
  return found.stdout.trim();
}

assert.ok(existsSync(SCRIPT), "apply-ruleset.sh is missing — this file tests nothing");

// Canned `gh`. Logs every invocation so a test can assert a PUT did or did not
// happen, which no exit status reports. Reads are numbered: the pre-PUT read
// and the post-PUT readback hit the same URL and have to be answerable apart.
// The listing is paged the way the real endpoint is — the second page exists
// only for a caller that asked for all of them.
const GH_STUB = [
  "#!/bin/sh",
  'printf "%s\\n" "$*" >> "$GH_LOG"',
  'if [ "$1" = "repo" ]; then',
  '  if [ -f "$GH_FIX/repo.fail" ]; then echo "gh: HTTP 401: Bad credentials" >&2; exit 1; fi',
  '  printf "%s\\n" "acme/widget"; exit 0',
  "fi",
  'shift                       # drop the `api` verb',
  "method=GET; path=; paginate=0",
  "while [ $# -gt 0 ]; do",
  "  case $1 in",
  "    -X|--method) method=$2; shift 2 ;;",
  "    --input|--jq) shift 2 ;;",
  "    --paginate) paginate=1; shift ;;",
  "    -*) shift ;;",
  "    *) path=$1; shift ;;",
  "  esac",
  "done",
  'if [ "$method" = PUT ]; then',
  '  if [ -f "$GH_FIX/put.fail" ]; then echo "gh: HTTP 422: Validation Failed" >&2; exit 1; fi',
  '  echo "{}"; exit 0',
  "fi",
  'case "$path" in',
  "  */rulesets)",
  '    if [ -f "$GH_FIX/list.fail" ]; then echo "gh: HTTP 503: Service Unavailable" >&2; exit 1; fi',
  '    cat "$GH_FIX/list.json"',
  '    if [ "$paginate" = 1 ] && [ -f "$GH_FIX/list2.json" ]; then cat "$GH_FIX/list2.json"; fi ;;',
  "  */rulesets/*)",
  '    n=$(cat "$GH_FIX/reads" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$GH_FIX/reads"',
  '    if [ -f "$GH_FIX/read$n.fail" ]; then echo "gh: HTTP 502 (post-PUT read)" >&2; exit 1; fi',
  '    if [ -f "$GH_FIX/read$n.json" ]; then cat "$GH_FIX/read$n.json"; else cat "$GH_FIX/read.json"; fi ;;',
  "  *)",
  '    echo "gh stub: unexpected path [$path]" >&2; exit 91 ;;',
  "esac",
].join("\n");

/** A minimal but shaped-like-the-real-thing ruleset spec. */
const spec = (over = {}) => ({
  name: "main",
  target: "branch",
  enforcement: "active",
  bypass_actors: [],
  conditions: { ref_name: { exclude: [], include: ["~DEFAULT_BRANCH"] } },
  rules: [
    { type: "deletion" },
    { type: "pull_request", parameters: { allowed_merge_methods: ["merge"], required_approving_review_count: 0 } },
    { type: "required_status_checks", parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: "check", integration_id: 15368 }] } },
  ],
  ...over,
});

/**
 * The server's view of a ruleset: the spec's writable fields plus the
 * server-only ones the projection has to ignore.
 */
const served = (obj, id = 42) => ({
  id,
  source_type: "Repository",
  created_at: "2026-07-31T14:10:14Z",
  updated_at: "2026-07-31T16:37:01Z",
  _links: { self: { href: "https://api.github.com/..." } },
  ...obj,
});

const listed = (...entries) => entries.map(([id, name, source_type]) => ({ id, name, source_type }));

/**
 * Run the shipped script against `fixtures`.
 *
 * `spec` is the spec file's content (an object, or a raw string for the
 * malformed cases). `list` is the listing's first page and `list2` its second,
 * which only a paginating caller ever sees. `reads` are the successive answers
 * to the by-id GET; `readFails` names the 1-based read that should fail
 * instead. `args` are options placed before the spec path. `path` overrides
 * PATH for the missing-tool cases.
 */
function run(t, { spec: specObj, list = listed([42, "main", "Repository"]), list2, reads = [], readFails = [], repoFails = false, putFails = false, listFails = false, specPath, args = [], path } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "apply-ruleset-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fix = join(dir, "fix");
  const bin = join(dir, "bin");
  mkdirSync(fix);
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), GH_STUB, { mode: 0o755 });

  const specFile = join(dir, "spec.json");
  if (specObj !== undefined) {
    writeFileSync(specFile, typeof specObj === "string" ? specObj : JSON.stringify(specObj, null, 2));
  }
  writeFileSync(join(fix, "list.json"), JSON.stringify(list));
  if (list2) writeFileSync(join(fix, "list2.json"), JSON.stringify(list2));
  reads.forEach((r, i) => writeFileSync(join(fix, `read${i + 1}.json`), JSON.stringify(r)));
  if (reads.length > 0) writeFileSync(join(fix, "read.json"), JSON.stringify(reads[reads.length - 1]));
  for (const n of readFails) writeFileSync(join(fix, `read${n}.fail`), "");
  if (repoFails) writeFileSync(join(fix, "repo.fail"), "");
  if (putFails) writeFileSync(join(fix, "put.fail"), "");
  if (listFails) writeFileSync(join(fix, "list.fail"), "");

  const log = join(dir, "gh.log");
  writeFileSync(log, "");

  const r = spawnSync(BASH, [SCRIPT, ...args, specPath ?? specFile], {
    cwd: dir,
    encoding: "utf8",
    env: { PATH: path ?? `${bin}:${process.env.PATH}`, HOME: dir, GH_FIX: fix, GH_LOG: log },
  });

  const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
  return {
    status: r.status,
    out: `${r.stdout}${r.stderr}`,
    calls,
    puts: calls.filter((c) => c.includes("-X PUT")),
  };
}

/** A PATH holding only the named real tools, for the "not on PATH" branches. */
function pathWith(t, names) {
  const dir = mkdtempSync(join(tmpdir(), "apply-ruleset-path-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const n of names) {
    // `gh` is the stub even here: this PATH exists to make one tool missing,
    // never to let a real API call out.
    if (n === "gh") writeFileSync(join(dir, n), GH_STUB, { mode: 0o755 });
    else writeFileSync(join(dir, n), `#!/bin/sh\nexec ${which(n)} "$@"\n`, { mode: 0o755 });
  }
  return dir;
}

// ---- the positive control ------------------------------------------------

test("applies a genuine difference and re-reads it", (t) => {
  const want = spec();
  const r = run(t, { spec: want, reads: [served({ ...want, enforcement: "disabled" }), served(want)] });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.puts.length, 1, r.out);
  assert.match(r.out, /applied and verified/);
});

test("a live object equal to the spec is left alone", (t) => {
  const want = spec();
  const r = run(t, { spec: want, reads: [served(want)] });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.puts, [], "nothing to apply must not write");
  assert.match(r.out, /already matches/);
});

// ---- resolving the ruleset ----------------------------------------------

test("an inherited org ruleset sharing the name does not shadow the repo's own", (t) => {
  const want = spec();
  const r = run(t, {
    spec: want,
    list: listed([42, "main", "Repository"], [7777777, "main", "Organization"]),
    reads: [served(want)],
  });
  assert.equal(r.status, 0, r.out);
  assert.ok(
    r.calls.some((c) => c.includes("rulesets/42")),
    `must resolve the repository-level id, got: ${r.calls.join(" | ")}`,
  );
  assert.ok(!r.calls.some((c) => c.includes("7777777")), "must never address the parent's id");
});

test("an inherited org ruleset alone is not a repository ruleset", (t) => {
  const r = run(t, { spec: spec(), list: listed([7777777, "main", "Organization"]) });
  assert.equal(r.status, 2);
  assert.match(r.out, /no repository-level ruleset named 'main'/);
  assert.deepEqual(r.puts, [], "must not write to a ruleset it cannot own");
});

test("two repository rulesets sharing the name are refused, not guessed between", (t) => {
  const r = run(t, { spec: spec(), list: listed([42, "main", "Repository"], [43, "main", "Repository"]) });
  assert.equal(r.status, 2);
  assert.match(r.out, /more than one ruleset named 'main'/);
  assert.deepEqual(r.puts, []);
});

test("a quote in the ruleset name resolves instead of breaking the lookup", (t) => {
  const want = spec({ name: 'ma"in' });
  const r = run(t, { spec: want, list: listed([42, 'ma"in', "Repository"]), reads: [served(want)] });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /already matches/);
});

test("a ruleset past the listing's first page is still found", (t) => {
  const want = spec();
  const filler = Array.from({ length: 30 }, (_, i) => [100 + i, `other-${i}`, "Repository"]);
  const r = run(t, {
    spec: want,
    list: listed(...filler),
    list2: listed([42, "main", "Repository"]),
    reads: [served(want)],
  });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /already matches/);
});

// ---- the comparable projection ------------------------------------------

test("a server-side reorder of rules is not a difference", (t) => {
  const want = spec();
  const r = run(t, { spec: want, reads: [served({ ...want, rules: [...want.rules].reverse() })] });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.puts, [], "a pure reorder must not provoke a write");
});

test("a changed top-level field is a difference", (t) => {
  const want = spec();
  const live = served({ ...want, enforcement: "evaluate" });
  const r = run(t, { spec: want, reads: [live, live] });
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /refusing to report success/);
});

test("a field changed deep inside a rule's parameters is a difference", (t) => {
  const want = spec();
  const drift = want.rules.map((x) => (x.type === "pull_request" ? { ...x, parameters: { ...x.parameters, allowed_merge_methods: ["squash"] } } : x));
  const live = served({ ...want, rules: drift });
  const r = run(t, { spec: want, reads: [live, live] });
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /still differs from/);
  assert.match(r.out, /squash/, "the refusal must show what differs");
});

// ---- the failures an operator has to be able to read ---------------------

test("a write that cannot be proven says so, rather than exiting on gh's status", (t) => {
  const want = spec();
  const r = run(t, { spec: want, reads: [served({ ...want, enforcement: "disabled" })], readFails: [2] });
  assert.equal(r.puts.length, 1, "the PUT must have been attempted for this to be the unprovable case");
  assert.equal(r.status, 2, "a status the script itself never produces reads as a crash");
  assert.match(r.out, /UNVERIFIED/);
});

test("a failing PUT is not diagnosed as a scope problem", (t) => {
  const want = spec();
  const r = run(t, { spec: want, reads: [served({ ...want, enforcement: "disabled" })], putFails: true });
  assert.equal(r.status, 2);
  assert.match(r.out, /PUT failed/);
  assert.doesNotMatch(r.out, /repo-admin scope/, "422 is not a permissions failure");
});

test("a failing listing is not diagnosed as a scope problem", (t) => {
  const r = run(t, { spec: spec(), listFails: true });
  assert.equal(r.status, 2);
  assert.match(r.out, /cannot list rulesets/);
  assert.doesNotMatch(r.out, /repo-admin scope/, "503 is not a permissions failure");
});

test("a failing repo lookup is not diagnosed as being outside a checkout", (t) => {
  const r = run(t, { spec: spec(), repoFails: true });
  assert.equal(r.status, 2);
  assert.doesNotMatch(r.out, /run this inside the checkout/, "401 has nothing to do with cwd");
});

// ---- refusing before it touches anything ---------------------------------

test("a missing spec file is refused before any API call", (t) => {
  const r = run(t, { specPath: "/nonexistent/ruleset.json" });
  assert.equal(r.status, 2);
  assert.match(r.out, /no ruleset spec at/);
  assert.deepEqual(r.calls, [], "must not reach for gh before it has a spec");
});

test("a malformed spec is named by the script, not left to jq's exit code", (t) => {
  const r = run(t, { spec: '{ "name": "main",' });
  assert.equal(r.status, 2, "jq's own exit status escaping would be 5");
  assert.match(r.out, /apply-ruleset: .*is not valid JSON/);
});

test("a spec without a name cannot resolve a target", (t) => {
  const r = run(t, { spec: { target: "branch" } });
  assert.equal(r.status, 2);
  assert.match(r.out, /has no \.name/);
});

test("a missing gh is refused by name", (t) => {
  const r = run(t, { spec: spec(), path: pathWith(t, ["jq"]) });
  assert.equal(r.status, 2);
  assert.match(r.out, /gh is not on PATH/);
});

test("a missing jq is refused by name", (t) => {
  const r = run(t, { spec: spec(), path: pathWith(t, ["gh"]) });
  assert.equal(r.status, 2);
  assert.match(r.out, /jq is not on PATH/);
});

// ---- --check: the same comparison, asked by something that cannot write ----
//
// #1710. The four contexts ADR 0007 selected sat in the spec and not in the
// live gate for five days, because nothing reads the gate unless a person
// decides to. What makes the flag worth its branch is the third status: an
// unattended caller holds no admin, and a read it was never allowed to make
// must not reach it as "the gate has drifted".

test("--check reports a difference and writes nothing", (t) => {
  const want = spec();
  const r = run(t, { args: ["--check"], spec: want, reads: [served({ ...want, enforcement: "disabled" })] });
  assert.equal(r.status, 3, r.out);
  assert.deepEqual(r.puts, [], "--check must never write");
  assert.match(r.out, /does NOT match/);
  assert.match(r.out, /disabled/, "the diff itself has to reach the caller, not just the verdict");
});

test("--check on a gate that matches its spec is an ordinary success", (t) => {
  const want = spec();
  const r = run(t, { args: ["--check"], spec: want, reads: [served(want)] });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.puts, [], "--check must never write");
});

test("--check cannot read the gate at all is not reported as drift", (t) => {
  const want = spec();
  const r = run(t, { args: ["--check"], spec: want, readFails: [1] });
  assert.equal(r.status, 2, "a caller without admin reads this, and 3 would claim a difference nobody saw");
  assert.match(r.out, /cannot read/);
});

test("an unknown option is refused rather than read as a spec path", (t) => {
  const r = run(t, { args: ["--dry-run"], spec: spec(), reads: [served(spec())] });
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /unknown option --dry-run/);
  assert.deepEqual(r.calls, [], "refused before it reaches the API");
});

// ---- the shipped spec ----------------------------------------------------

test("the shipped ruleset spec is one this script can compare", (t) => {
  const shipped = JSON.parse(readFileSync(SHIPPED_SPEC, "utf8"));
  const r = run(t, { spec: shipped, list: listed([20119969, shipped.name, "Repository"]), reads: [served(shipped, 20119969)] });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /already matches/);
});
