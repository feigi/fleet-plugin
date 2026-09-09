import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// Review finding on #1349's PR (#1361): `fleet-run scriptPathFor` joins
// `path.join(installPath, "scripts", script)` — the Resolver ALREADY places
// the caller under `scripts/`, and does no existence check on the result
// (`--path` "print the resolved path; do not exec"). Every prose site that
// told a caller to run `fleet-run --path scripts/review-eval.mjs` therefore
// resolved to `<installPath>/scripts/scripts/review-eval.mjs` — a path one
// level too deep that would only fail LOUDLY once something tried to
// `import()` it, never at the Resolver call itself. The correct invocation
// is `--path review-eval.mjs`, bare — `scripts/` is implicit.
//
// This is the existence check the Resolver itself does not perform: pin it
// here, against this repo's own `plugin/` tree standing in for an install
// root (`scriptPathFor`'s own join, replicated rather than imported — the
// Resolver is a standalone file placed outside the plugin by hand, per its
// own header, and importing it would need it to travel with a module it
// does not carry).
const REPO = join(import.meta.dirname, "..");

function scriptPathFor(installPath, script) {
  return join(installPath, "scripts", script);
}

test("the correct --path form resolves to a file that actually exists", () => {
  const correct = scriptPathFor(REPO, "review-eval.mjs");
  assert.ok(existsSync(correct), `${correct} does not exist — review-eval.mjs moved or was renamed`);
});

test("the double-scripts/ form (the mistake this pins against) does not exist", () => {
  const wrong = scriptPathFor(REPO, "scripts/review-eval.mjs");
  assert.ok(
    !existsSync(wrong),
    `${wrong} exists — either a stray directory was created, or scriptPathFor's join changed and the prose sites need re-checking`,
  );
});

// The prose sites: review-eval.mjs's own usage comment, plus every doc site
// that tells a caller how to load it. All three must spell the bare form.
const SITES = [
  { path: ["scripts", "review-eval.mjs"], what: "review-eval.mjs's own usage comment" },
  { path: ["commands", "review-and-fix.md"], what: "review-and-fix.md's OMP invocation line" },
  { path: ["skills", "run-team", "SKILL.md"], what: "SKILL.md's OMP invocation line" },
];

for (const { path, what } of SITES) {
  test(`${what} spells the bare --path form, never the doubled scripts/ one`, () => {
    const text = readFileSync(join(REPO, ...path), "utf8");
    assert.match(text, /--path review-eval\.mjs\b/, `${what} no longer names the correct --path invocation`);
    assert.doesNotMatch(text, /--path scripts\/review-eval\.mjs/, `${what} regressed to the doubled scripts/ form`);
  });
}
