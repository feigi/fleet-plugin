// Prose runs the Resolver where the package holds it — `scripts/fleet-run`
// under the Package entry, `~/.omp/plugins/node_modules/@feigi/fleet-ctl` —
// and nothing places a copy of it anywhere. So nothing the plugin ships names
// the old placed copy's directory, `~/.fleet/bin`, or the script that placed
// it, `fleet-bootstrap`; and README's `## Installation` code block, what a
// fresh consumer types top to bottom, is the install and the tier check run
// through the Package entry's own `fleet-run`, nothing else.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const PLUGIN = join(ROOT, "plugin");
const README = readFileSync(join(ROOT, "README.md"), "utf8");
const RESOLVER = "~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run";
const RETIRED = [".fleet/bin", "fleet-bootstrap"];

// Each [file, retired name] pair where `text` names a retired name.
function retiredHits(files) {
  return files.flatMap(([file, text]) => RETIRED.filter((name) => text.includes(name)).map((name) => [file, name]));
}

// README's `## Installation` code block, one command per line.
function installationCommands(readmeText) {
  const section = /## Installation\n([\s\S]*?)(?=\n## )/.exec(readmeText);
  if (!section) throw new Error("README has no \"## Installation\" section");
  const block = /```\n([\s\S]*?)\n```/.exec(section[1]);
  if (!block) throw new Error("README's \"## Installation\" section has no code block");
  return block[1].split("\n");
}

const shipped = () =>
  readdirSync(PLUGIN, { recursive: true })
    .map((rel) => join(PLUGIN, rel))
    .filter((path) => statSync(path).isFile())
    .map((path) => [relative(ROOT, path), readFileSync(path, "utf8")]);

test("no file under plugin/ names ~/.fleet/bin or fleet-bootstrap", () => {
  const files = shipped();
  // Not vacuous: the same read finds the Package entry's Resolver, which the
  // plugin's prose runs at every callsite.
  assert.ok(files.some(([, text]) => text.includes(RESOLVER)), `no file under plugin/ names ${RESOLVER} — this read reads nothing`);
  assert.deepEqual(retiredHits(files), []);
});

test("the retired-name check refuses each retired name and passes the Package entry and other ~/.fleet paths", () => {
  assert.deepEqual(retiredHits([["a.md", "run `~/.fleet/bin/fleet-run x.mjs`"]]), [["a.md", ".fleet/bin"]]);
  assert.deepEqual(retiredHits([["b.sh", "node plugin/scripts/fleet-bootstrap"]]), [["b.sh", "fleet-bootstrap"]]);
  assert.deepEqual(
    retiredHits([
      ["c.md", `run \`${RESOLVER} x.mjs\``],
      ["d.md", "`~/.omp/plugins/node_modules/@feigi/fleet-ctl/commands/run-merge-bot.md`"],
      ["e.md", "`~/.fleet/suite-slots/<i>.lock` and `~/.fleet/scratch/<repo-key>/`"],
    ]),
    [],
  );
});

test("README's Installation block is the install and the tier check through the Package entry's fleet-run", () => {
  const lines = installationCommands(README);
  assert.deepEqual(lines, ["omp plugin install @feigi/fleet-ctl", `${RESOLVER} tier-roles.mjs --check`]);
  assert.deepEqual(retiredHits([["README.md Installation block", lines.join("\n")]]), []);
});
