// Regression gate for ticketless.mjs, the Ticketless PR test as one command.
// Zero deps: `node --test tests/ticketless.test.mjs`.
//
// `gh` is stubbed on PATH and answers `gh pr view <n> --json
// closingIssuesReferences,url` from `pr.json` in its own directory, or fails
// when `pr.fail` exists. The ledger is a file the case writes and names with
// `--ledger`, so no case reads a real run's ledger. Each case holds every input
// at the baseline — a PR in the own repository closing nothing, a ledger with
// no token naming it — except the one under test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isTicketless } from "../plugin/scripts/ticketless.mjs";
import { writeExecStub } from "./support/exec-stub.mjs";
import { tempDir } from "./support/temp-dir.mjs";
import { prUrl, ref } from "./support/queue-gh.mjs";

const SCRIPT = fileURLToPath(new URL("../plugin/scripts/ticketless.mjs", import.meta.url));

const STUB = `#!/bin/sh
d="\${0%/*}"
printf '%s\\n' "$*" >> "$d/calls.log"
[ "$1 $2 $4 $5" = "pr view --json closingIssuesReferences,url" ] || { echo "stub gh: unexpected $*" >&2; exit 99; }
if [ -f "$d/pr.fail" ]; then cat "$d/pr.fail" >&2; exit 1; fi
cat "$d/pr.json"
`;

const ledgerText = (rows) => `# Fleet run ledger\n\n## Rows\n\n${rows.map((r) => `- ${r}`).join("\n")}\n\n## Dispatched\n\n\n\n## Filed\n\n\n\n## Ruled\n\n`;

// A rig for one case. `closes` are the issue references the PR carries (numbers
// in the own repository, or reference objects as they stand), `rows` the
// ledger's rows.
function rig({ closes = [], rows = [], view = null, fail = null } = {}) {
  const dir = tempDir("ticketless-");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeExecStub(join(bin, "gh"), STUB);
  const body = view ?? { closingIssuesReferences: closes.map((r) => (typeof r === "number" ? ref(r) : r)), url: prUrl(42) };
  writeFileSync(join(bin, "pr.json"), JSON.stringify(body));
  if (fail !== null) writeFileSync(join(bin, "pr.fail"), fail);
  const ledger = join(dir, "ledger.md");
  writeFileSync(ledger, ledgerText(rows));
  const run = (args = ["--pr", "42", "--ledger", ledger], env = {}) => {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env } });
    let out = null;
    try {
      out = JSON.parse(r.stdout);
    } catch {
      // a refusal before any read prints no verdict
    }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, out };
  };
  return { dir, ledger, run };
}

test("isTicketless: no own-repository closing issue and no settled implementer ticket", () => {
  assert.equal(isTicketless([], []), true);
  assert.equal(isTicketless([3], []), false);
  assert.equal(isTicketless([], [12]), false);
  assert.equal(isTicketless([3], [12]), false);
});

test("exit 0: a PR closing no issue that no settled impl token names is Ticketless", () => {
  const t = rig();
  const r = t.run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out, { verdict: "ticketless", exit: 0, pr: 42, closing: [], tickets: [], reason: null });
  assert.equal(r.stdout.trim().split("\n").length, 1, "one JSON line");
});

test("exit 0: another repository's closing reference, and a token naming another PR, leave a PR Ticketless", () => {
  const t = rig({
    closes: [ref(7, "other-org/other-repo")],
    rows: ["#12 impl-12=PR#43 → PR#43", "#13 impl-13 · tier-ok=impl-13:fleet-implementer"],
  });
  const r = t.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.verdict, "ticketless");
  assert.deepEqual(r.out.closing, []);
});

test("exit 1: a PR closing an issue in its own repository is not Ticketless", () => {
  const t = rig({ closes: [3, 5] });
  const r = t.run();
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(r.out, { verdict: "ticketed", exit: 1, pr: 42, closing: [3, 5], tickets: [], reason: null });
});

test("exit 1: a PR closing none that a settled impl token names is not Ticketless", () => {
  const t = rig({ rows: ["#12 impl-12=PR#42 → PR#42"] });
  const r = t.run();
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(r.out, { verdict: "ticketed", exit: 1, pr: 42, closing: [], tickets: [12], reason: null });
});

test("exit 2: a gh read that fails, prints no JSON, or names another PR's url could not look", () => {
  const failing = rig({ fail: "gh: HTTP 502" });
  const a = failing.run();
  assert.equal(a.status, 2);
  assert.equal(a.out.verdict, "unknown");
  assert.match(a.out.reason, /gh pr view 42 --json closingIssuesReferences,url: gh: HTTP 502/);

  const noArray = rig({ view: { url: prUrl(42) } });
  const b = noArray.run();
  assert.equal(b.status, 2);
  assert.match(b.out.reason, /no closingIssuesReferences array/);

  const foreignUrl = rig({ view: { closingIssuesReferences: [], url: prUrl(43) } });
  const c = foreignUrl.run();
  assert.equal(c.status, 2);
  assert.match(c.out.reason, /not PR #42's/);
  for (const r of [a, b, c]) assert.deepEqual([r.out.closing, r.out.tickets], [null, null]);
});

test("exit 2: a ledger that cannot be read could not look — never read as no token", () => {
  const t = rig();
  // A ledger path that is a directory: `ledger.mjs read` cannot answer for it.
  const dir = join(t.dir, "ledger-dir");
  mkdirSync(dir);
  const r = t.run(["--pr", "42", "--ledger", dir]);
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.out.verdict, "unknown");
  assert.match(r.out.reason, /^could not read the ledger/);
});

// With no --ledger, the run ledger is resolved from --repo against the git
// common dir. Where there is none to resolve, `ledger.mjs read`'s own
// cwd-relative fallback would read an empty ledger as no token at all.
test("exit 2: a run ledger that cannot be resolved could not look — never read off a cwd-relative ledger", () => {
  const t = rig();
  // Not a repository, and the ceiling keeps git from finding one above it.
  const bare = join(t.dir, "not-a-repo");
  mkdirSync(join(bare, ".fleet"), { recursive: true });
  writeFileSync(join(bare, ".fleet", "ledger.md"), ledgerText([]));
  const ceiling = { GIT_CEILING_DIRECTORIES: `${t.dir}:${realpathSync(t.dir)}` };
  const r = t.run(["--pr", "42", "--repo", bare], ceiling);
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.out.verdict, "unknown");
  assert.match(r.out.reason, /^could not resolve the run ledger: could not resolve --git-common-dir/);

  // In a repository, the run ledger is the one under its .fleet/, and read.
  const repo = join(t.dir, "repo");
  mkdirSync(join(repo, ".fleet"), { recursive: true });
  assert.equal(spawnSync("git", ["init", "-q", repo]).status, 0);
  writeFileSync(join(repo, ".fleet", "ledger.md"), ledgerText(["#12 impl-12=PR#42 → PR#42"]));
  const named = t.run(["--pr", "42", "--repo", repo], ceiling);
  assert.equal(named.status, 1, named.stderr);
  assert.deepEqual(named.out.tickets, [12]);
});

test("a usage error is a refusal on stderr with no verdict, exit 2", () => {
  const t = rig();
  for (const args of [[], ["--pr", "x"], ["--pr", "42", "--bogus", "1"], ["--pr", "42", "--repo", join(t.dir, "missing")]]) {
    const r = t.run(args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.equal(r.stdout, "", args.join(" "));
    assert.match(r.stderr, /^\nticketless: /, args.join(" "));
  }
});
