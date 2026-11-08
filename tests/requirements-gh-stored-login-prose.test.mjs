// docs/requirements.md § 1.2 must require a STORED gh login. Phase 0 runs from
// an omp eval cell, and omp starts eval kernels with a reduced environment
// that keeps `HOME` (where `gh auth login` stores its login) but none of gh's
// token variables, so a login held only in `GH_TOKEN` and its siblings passes
// `gh auth status` in a terminal and fails every gh call phase 0 makes. The
// Check therefore unsets those variables before asking gh.
//
// THE CEILING: PRESENCE pins over the § 1.2 slice. A reflow stays green by
// design — the words are pinned, not their layout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Pin } from "./support/prose-pin.mjs";

const REQUIREMENTS = Pin.file(join(import.meta.dirname, "..", "docs", "requirements.md"));
const SECTION = REQUIREMENTS.section("### 1.2 `gh` authentication — HARD", "requirements.md section 1.2").text;
const VARIABLES = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];

test("requirements 1.2 requires a login stored by `gh auth login`", () => {
  assert.match(SECTION, Pin.phrase("stored by `gh auth login` (kept by gh under `HOME`)"));
});

test("requirements 1.2 says an environment-only token does not satisfy it, naming all four variables", () => {
  const bullet = Pin.of(SECTION, "section").bullet("- The login must be stored", "\n- All members", "requirements.md 1.2 stored-login bullet").text;
  assert.match(bullet, Pin.phrase("not supplied only through an environment variable"));
  for (const name of VARIABLES) assert.ok(bullet.includes(`\`${name}\``), `1.2's stored-login bullet names ${name}`);
});

test("requirements 1.2 gives the reason: phase 0 runs from an omp eval cell that keeps HOME and drops gh's variables", () => {
  assert.match(
    SECTION,
    Pin.phrase("phase 0 runs from an omp eval cell, and omp starts eval kernels with a reduced environment that keeps `HOME` but none of gh's variables"),
  );
});

test("requirements 1.2's Check unsets the four variables before `gh auth status`", () => {
  const check = Pin.of(SECTION, "section").between("\nCheck:", "\n", "requirements.md 1.2 Check line").text;
  const unset = VARIABLES.map((name) => `-u ${name}`).join(" ");
  assert.ok(check.includes(`env ${unset} gh auth status`), "the Check runs gh auth status under env -u for each of the four variables");
  assert.match(check, Pin.phrase("exits 0"));
});

test("requirements 1.2 keeps its repo-scope, shared-identity and Enterprise bullets", () => {
  assert.match(SECTION, Pin.phrase("`repo` scope to the GitHub host that owns your repo"));
  assert.match(SECTION, Pin.phrase("All members and the controller share this identity; no per-actor attribution."));
  assert.match(SECTION, Pin.phrase("GitHub Enterprise: works; `ci-state.mjs` takes `--hostname` from `gh repo view`'s resolution of the cwd's repository."));
});

test("requirements still lists the pre-flight gh-auth row as `gh auth status` citing § 1.2", () => {
  assert.match(REQUIREMENTS.text, Pin.phrase("| `gh-auth` | `gh auth status` (§1.2) | exit 0 |"));
});
