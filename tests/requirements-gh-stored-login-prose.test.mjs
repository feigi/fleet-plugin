// docs/requirements.md § 1.2 must require a STORED gh login. Phase 0 runs from
// an omp eval cell, and omp starts eval kernels with a reduced environment
// that keeps `HOME` and `XDG_CONFIG_HOME` (which locate gh's default config
// directory) but none of gh's variables, so a login held only in `GH_TOKEN`
// and its siblings, or kept in a directory only `GH_CONFIG_DIR` names, passes
// `gh auth status` in a terminal and fails every gh call phase 0 makes. The
// Check therefore unsets those variables before asking gh, and leaves
// `XDG_CONFIG_HOME` set, since the kernel keeps it.
//
// THE CEILING: PRESENCE pins over the § 1.2 slice. A reflow stays green by
// design — the words are pinned, not their layout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Pin } from "./support/prose-pin.mjs";

const REQUIREMENTS = Pin.file(join(import.meta.dirname, "..", "docs", "requirements.md"));
const SECTION = REQUIREMENTS.section("### 1.2 `gh` authentication — HARD", "requirements.md section 1.2").text;
const TOKEN_VARIABLES = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];
const UNSET_VARIABLES = [...TOKEN_VARIABLES, "GH_CONFIG_DIR"];

test("requirements 1.2 requires a login stored by `gh auth login` in gh's default config directory", () => {
  assert.match(SECTION, Pin.phrase("stored by `gh auth login` in gh's default config directory (`$XDG_CONFIG_HOME/gh`, else `~/.config/gh`"));
  assert.match(SECTION, Pin.phrase("gh keeps the token there or in the system credential store"));
});

test("requirements 1.2 says an environment-only token or a GH_CONFIG_DIR-only login does not satisfy it", () => {
  const bullet = Pin.of(SECTION, "section").bullet("- The login must be stored", "\n- All members", "requirements.md 1.2 stored-login bullet").text;
  assert.match(bullet, Pin.phrase("not supplied only through an environment variable"));
  for (const name of TOKEN_VARIABLES) assert.ok(bullet.includes(`\`${name}\``), `1.2's stored-login bullet names ${name}`);
  assert.match(bullet, Pin.phrase("neither does a login kept in a directory only `GH_CONFIG_DIR` names"));
});

test("requirements 1.2 gives the reason: phase 0 runs from an omp eval cell that keeps HOME and XDG_CONFIG_HOME and drops gh's variables", () => {
  assert.match(
    SECTION,
    Pin.phrase("phase 0 runs from an omp eval cell, and omp starts eval kernels with a reduced environment that keeps `HOME` and `XDG_CONFIG_HOME` but none of gh's variables"),
  );
});

test("requirements 1.2's Check runs `gh auth status` under env with gh's variables unset and XDG_CONFIG_HOME kept", () => {
  const check = Pin.of(SECTION, "section").between("\nCheck:", "\n", "requirements.md 1.2 Check line").text;
  const command = check.match(/`env ((?:-u \S+ )+)gh auth status`/);
  assert.ok(command, "the Check is one `env -u … gh auth status` command");
  const unset = command[1].trim().split(/\s+/).filter((word) => word !== "-u");
  for (const name of UNSET_VARIABLES) assert.ok(unset.includes(name), `the Check unsets ${name}`);
  assert.ok(!unset.includes("XDG_CONFIG_HOME"), "the Check leaves XDG_CONFIG_HOME set, as the eval kernel does");
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
