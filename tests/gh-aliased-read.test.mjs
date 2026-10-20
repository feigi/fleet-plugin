// `gh-aliased-read.mjs`: the batched GraphQL read fleet-tick.mjs and
// reclaim-scratch.mjs share. Their own suites drive it through a stub that
// answers the way GitHub does; these cases call it directly against a `gh`
// stub on PATH that prints a per-case body verbatim, for the replies those
// stubs never give: a repository that is not an object, an `errors` that is
// not an array, an alias the body leaves out, a reply past node's default
// spawnSync buffer, and the argv the read hands gh.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeExecStub } from "./support/exec-stub.mjs";
import { ghAliasedRead } from "../plugin/scripts/gh-aliased-read.mjs";

// Prints STUB_BODY's file to stdout, logs its argv to STUB_ARGV, and exits
// STUB_EXIT. exitCode, not exit(): a large body on a pipe must drain first.
const GH_STUB = `#!${process.execPath}
const fs = require("fs");
fs.writeFileSync(process.env.STUB_ARGV, JSON.stringify(process.argv.slice(2)));
process.stdout.write(fs.readFileSync(process.env.STUB_BODY, "utf8"));
process.exitCode = Number(process.env.STUB_EXIT);
`;

const dir = realpathSync(mkdtempSync(join(tmpdir(), "gh-aliased-read-")));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
writeExecStub(join(dir, "gh"), GH_STUB);
process.env.PATH = `${dir}:${process.env.PATH}`;
process.env.STUB_ARGV = join(dir, "argv.json");
process.env.STUB_BODY = join(dir, "body.json");

const read = (numbers, body, exit = 0) => {
  writeFileSync(process.env.STUB_BODY, typeof body === "string" ? body : JSON.stringify(body));
  process.env.STUB_EXIT = String(exit);
  return ghAliasedRead(numbers, { field: "pullRequest", selection: "{state}", timeoutMs: 10_000 });
};

test("a repository that is an array answers nothing, though an error names the alias", () => {
  const r = read([1], { data: { repository: [] }, errors: [{ type: "FORBIDDEN", path: ["repository", "n1"], message: "no" }] }, 1);
  assert.deepEqual(r.get(1), { unreachable: "exit 1" });
});

test("an `errors` that is not an array answers nothing and throws nothing", () => {
  const r = read([1], { data: { repository: { n1: { state: "OPEN" } } }, errors: { message: "boom" } });
  assert.deepEqual(r.get(1), { unreachable: "exit 0" });
});

test("an alias the body leaves out is unreachable while its sibling is answered", () => {
  const r = read([1, 2], { data: { repository: { n2: { state: "OPEN" } } } });
  assert.deepEqual(r.get(1), { unreachable: "exit 0" });
  assert.deepEqual(r.get(2), { node: { state: "OPEN" } });
});

test("a reply past spawnSync's default 1 MiB buffer is still read", () => {
  const r = read([1], { data: { repository: { n1: { state: "MERGED", pad: "x".repeat(2 * 1024 * 1024) } } } });
  assert.equal(r.get(1).node?.state, "MERGED", JSON.stringify(r.get(1)).slice(0, 200));
});

test("gh is asked for the cwd's repository by owner and name, one alias per number in the order given", () => {
  read([3, 1], { data: { repository: { n3: { state: "OPEN" }, n1: { state: "OPEN" } } } });
  const argv = JSON.parse(readFileSync(process.env.STUB_ARGV, "utf8"));
  assert.deepEqual(argv.slice(0, 7), ["api", "graphql", "-F", "owner={owner}", "-F", "name={repo}", "-f"]);
  assert.equal(argv[7],
    "query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){n3:pullRequest(number:3){state} n1:pullRequest(number:1){state}}}");
});
