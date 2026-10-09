import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// README's `## Installation` code block is what a fresh consumer types, top to
// bottom. The Resolver (`~/.fleet/bin/fleet-run`) exists only once
// `fleet-bootstrap` has placed it, so the block must run the bootstrap — from
// the install root, where it needs no flag — before its first Resolver call.
const README = readFileSync(join(import.meta.dirname, "..", "README.md"), "utf8");
const BOOTSTRAP = "~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-bootstrap";
const RESOLVER = "~/.fleet/bin/fleet-run";

function installationCommands(readmeText) {
  const section = /## Installation\n([\s\S]*?)(?=\n## )/.exec(readmeText);
  if (!section) throw new Error("README has no \"## Installation\" section");
  const block = /```\n([\s\S]*?)\n```/.exec(section[1]);
  if (!block) throw new Error("README's \"## Installation\" section has no code block");
  return block[1].split("\n");
}

function bootstrapPrecedesResolver(lines) {
  const firstResolver = lines.findIndex((l) => l.startsWith(RESOLVER));
  const bootstrap = lines.indexOf(BOOTSTRAP);
  return firstResolver !== -1 && bootstrap !== -1 && bootstrap < firstResolver;
}

test("README's Installation block runs fleet-bootstrap from the install root before its first Resolver call", () => {
  const lines = installationCommands(README);
  assert.ok(bootstrapPrecedesResolver(lines), `Installation block does not run ${BOOTSTRAP} before ${RESOLVER}:\n${lines.join("\n")}`);
  assert.ok(!lines.some((l) => l.includes("--from-checkout")), "--from-checkout is for a source checkout, never the consumer install");
});

test("the ordering check accepts bootstrap-then-Resolver and refuses a missing or late bootstrap", () => {
  const install = "omp plugin install @feigi/fleet-ctl";
  const check = `${RESOLVER} tier-roles.mjs --check`;
  assert.equal(bootstrapPrecedesResolver([install, BOOTSTRAP, check]), true);
  assert.equal(bootstrapPrecedesResolver([install, check]), false);
  assert.equal(bootstrapPrecedesResolver([install, check, BOOTSTRAP]), false);
});
