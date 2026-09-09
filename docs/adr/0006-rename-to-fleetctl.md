# 0006 — The plugin is `fleetctl`: a bare name that fails loud

**Status:** Accepted. Ruled 2026-09-09 on #1319, against the measurements below.

## Context

Measured 2026-09-09 on Claude Code 2.1.265 and omp 18.1.15 (moved from
18.1.14 during the day), with this repo registered as a directory marketplace
under its declared bare name `fleet`:

- **`omp plugin install fleet` resolved to `substack/fleet@0.1.6`**, an
  unrelated npm package, and dropped 13 `fleet-*` binaries into omp's plugin
  `node_modules/.bin` — only the version digit (`0.1.6` vs this repo's
  `0.1.1`) distinguished it, with a success line indistinguishable from a
  correct install. The qualified form resolved correctly:
  `omp plugin install fleet@fleet-plugin` → `Installed fleet from
  fleet-plugin (0.1.1)`.
- **omp's unqualified install path never consults a registered marketplace at
  all.** A bare name is always resolved as an npm specifier. The bare form is
  therefore a wrong-package install forever, unless the name itself is freed.
- **Claude Code has no npm fallback.** A bare install on Claude resolves to
  the sole marketplace offering the name and succeeds — the collision never
  existed on that harness.
- **Scoped names are unusable on both harnesses**, and fail for unrelated
  reasons rather than a grammar rejection: `claude plugin install
  "@feigi/fleet@mkt"` tokenises the leading `@` as the `name@marketplace`
  separator, producing `Plugin "" not found in marketplace "feigi/fleet"`;
  omp treats `@scope/pkg` as an npm specifier even for a local directory
  plugin, producing a registry 404.
- **All six candidate kebab-case names were free on npm** at measurement
  time — `fleet-plugin`, `fleet-agent`, `agent-fleet`, `omp-fleet`,
  `claude-fleet` (404 each) — and `plugin name == marketplace name` was
  measured safe on both harnesses (`nameprobe-same@nameprobe-same` installed
  and `/nameprobe-same:ping` resolved on both).
- **The namespace surface differs by harness.** Claude registers plugin
  agents as `<plugin>:<agent>` and rejects the bare name; omp registers
  agents by bare frontmatter `name` and rejects the namespaced form —
  confirmed three times across candidates. Slash commands are
  `/<plugin>:<command>` on both. A rename therefore changes
  `subagent_type: "fleet:fleet-implementer"` on Claude only; on omp the
  dispatch name was never namespaced — the same collision surface #1303's
  gap 4 already named, now confirmed at the registry level.
- **Blast radius, exact:** three manifest sites (`.claude-plugin/
  plugin.json:3`, `marketplace.json:11`), six namespace callsites
  (`skills/run-team/SKILL.md:511,527,1130`, `commands/review-and-fix.md:37`,
  `commands/run-merge-bot.md:248`, `workflows/review-pr.js:6`), two test pins
  (`scripts/implementer-model-tier.test.mjs:245`,
  `scripts/review-path-default.test.mjs:156`), one spec citation, and both
  harnesses' cached installs and registry keys. The Resolver ruled on #1294
  reads the registry key `fleet@fleet-plugin` by name, so the rename must
  land before #1335 builds against it.

## Decision

1. **Rename the plugin off the collision entirely**, to a free kebab-case
   name — the only option that converts the bare form from *silent-wrong* to
   either harmless (Claude) or *loud-wrong* (omp: a 404, rc=1, rather than a
   wrong install).
2. **Name picked by the maintainer: `fleetctl`.** Registry id
   `fleetctl@fleet-plugin`; commands `/fleetctl:<name>` on both harnesses;
   agents `fleetctl:fleet-implementer` on Claude, bare `fleet-implementer` on
   omp.
3. **The qualified id stays canonical in every install instruction**, on both
   harnesses, regardless of the rename — the rename removes the
   silent-wrong exposure, it does not license dropping the qualifier.
4. **The rename lands as one commit** covering every site in the blast
   radius above, followed by uninstall/reinstall on both harnesses.
5. **The map's silent-drop hazard list keeps its standing instruction to look
   for a fifth instance** — this closes the fourth (after
   preserved-not-rejected frontmatter keys, dropped per-call `model`/
   `effort`, and unrecoverable `effort` under `auto`), not the class.

## Rejected alternatives

- **Mandate the qualified id in prose only (no rename).** Documents the
  footgun and leaves it armed: omp's unqualified install path never consults
  a registered marketplace, so the bare form stays a wrong-package install
  forever, guarded by prose alone — the exact silent shape the map forbids.
- **A CI registry gate querying npm for the plugin name.** Has a false
  negative the gate cannot see: a name free at CI time can be taken by a
  third party before the next install, and nothing in the repo would
  notice. It also proves the wrong thing — it would guard against a *future*
  collision while the current one is already live and unaddressed.
- **A scoped name (`@feigi/fleet`).** Measured unusable on both harnesses for
  tokenizer/npm-specifier reasons, not a documented grammar rejection either
  harness's docs would predict.

## Consequences

- The residual exposure after the rename is the same third-party-
  publishes-later case the CI-gate alternative worried about — but with a
  free name that exposure is loud: a 404 becomes a wrong install only if
  someone later publishes the exact string `fleetctl` to npm.
- #1314's `smoke-omp` job derives the plugin id from the manifest at job time
  rather than a hardcoded literal, so the qualified path cannot regress
  behind this rename.
- The rename changes Claude's dispatch namespace
  (`fleet:fleet-implementer` → `fleetctl:fleet-implementer`) but not omp's,
  which was never namespaced — the two harnesses' namespace surfaces stay
  asymmetric after the rename, not by omission but because omp's registry
  has no namespace to change.
- Rename work is filed as #1348, which now blocks #1335 so the Resolver is
  built against the new registry key `fleetctl@fleet-plugin` rather than the
  old one.
