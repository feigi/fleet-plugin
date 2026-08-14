import { test } from "node:test";
import assert from "node:assert";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripComments } from "./strip-comments.mjs";

const ARG_MODULE = fileURLToPath(new URL("./arg.mjs", import.meta.url));

// #367 replaced seven private copies of die() with arg.mjs's makeDie(), and
// that migration is the load-bearing half of the change: board.mjs and
// ledger.mjs were still on the async console.error shape #176/#328/#363 exist
// to kill, and the other five on writeSync variants that had drifted apart.
// Nothing pinned the wiring. Reverting board.mjs and ledger.mjs to their
// pre-#367 console.error die() left the whole suite green at 640/640
// (measured), so the bug this refactor closes could walk straight back in on
// the next edit or merge resolution.
//
// THREE assertions per consumer, because each alone is vacuous:
//   - the WIRING line alone pins a NAME, not a module. candidates.mjs can
//     declare its own local console.error makeDie(), keep the wiring line
//     byte-identical, and the suite stays green at 640/640 (measured).
//   - the IMPORT alone leaves a script free to import makeDie and then bind
//     die to something else entirely.
//   - both together still miss a wrong NAME CONSTANT: `const NAME =
//     "wrongname"` makes every refusal claim to come from another script, and
//     the full suite stays green for six of the seven (measured — only
//     candidates is covered, by its own `/^candidates: …/m` assertions).
//
// The SHAPE makeDie() itself must have (try/catch around writeSync) is pinned
// in candidates.test.mjs, next to the EAGAIN race that motivates it. This file
// pins that every consumer actually reaches it — a source text-lift pin tests
// a COPY, so the call site is what makes the lifted shape load-bearing.
//
// Line-anchored under /m where an anchor helps, but deliberately WITHOUT `$`
// terminators: a trailing comment on a pinned line is a legitimate edit and
// must not turn these red (measured).
//
// The list is spelled out rather than discovered by globbing for files that
// import arg.mjs: a discovered set silently SHRINKS when a consumer drops the
// import, which is precisely the regression being pinned. A consumer added
// later has to be added here deliberately.
const CONSUMERS = ["board", "candidates", "ci-state", "diff-stats", "fleet-tick", "ledger", "pr-overlap"];

test("every fleet script wires die() to arg.mjs's makeDie under its own NAME — the #367 migration, pinned", () => {
  for (const name of CONSUMERS) {
    const src = stripComments(readFileSync(fileURLToPath(new URL(`./${name}.mjs`, import.meta.url)), "utf8"));
    assert.match(
      src,
      /^import \{[^}]*\bmakeDie\b[^}]*\} from "\.\/arg\.mjs";/m,
      `${name}.mjs must import makeDie from ./arg.mjs, not define its own die()`,
    );
    assert.match(
      src,
      /^const die = makeDie\(NAME\);/m,
      `${name}.mjs must bind die to makeDie(NAME) at module scope`,
    );
    assert.match(
      src,
      new RegExp(`const NAME = "${name}";`),
      `${name}.mjs's NAME must be its own script name, or its refusals misidentify themselves`,
    );
  }
});

// The leading newline in makeDie()'s writeSync is documented there as
// "load-bearing, not formatting", and nothing pinned it: dropping it left all
// 640 tests green (measured). Every existing refusal assertion matches
// line-anchored against stderr that carries no concurrently-draining child
// output — which is the exact condition the newline exists for, so none of
// them can see it.
//
// Pinned behaviourally rather than as another source regex: the harm is a
// runtime property (the refusal landing mid-line behind a partial line already
// on fd 2), and a regex over the template literal would pin the spelling while
// still proving nothing about what reaches the fd.
test("die()'s refusal starts its own line even when a partial line is already on fd 2", () => {
  const dir = mkdtempSync(join(tmpdir(), "arg-die-"));
  writeFileSync(join(dir, "arg.mjs"), readFileSync(ARG_MODULE));
  writeFileSync(join(dir, "run.mjs"), [
    'import { writeSync } from "node:fs";',
    'import { makeDie } from "./arg.mjs";',
    'writeSync(2, "forwarded child stderr with no trailing newline");',
    'makeDie("probe")("refused");',
    "",
  ].join("\n"));

  const r = spawnSync(process.execPath, [join(dir, "run.mjs")], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /^probe: refused$/m);
});
