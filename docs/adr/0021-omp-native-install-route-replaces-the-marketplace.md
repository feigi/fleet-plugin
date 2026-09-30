# 0021 — The native omp install route replaces the marketplace distribution

**Status:** Accepted. Ruled 2026-09-30 on #1430 by the maintainer, from a
grilling session against fresh measurements on omp 18.4.4.

## Context

#1430 opened 2026-09-11 with a two-part defect on the marketplace install
(`omp plugin marketplace add feigi/fleet-plugin` + `omp plugin install
fleet-ctl@fleet-plugin`):

1. **Discovery**: plugin `agents/` loaded only with
   `enabledProviders: ["claude-plugins"]` — upstream `can1357/oh-my-pi#11362`.
   Fixed upstream in v18.2.1 (an origin exemption for omp's own installs);
   re-measured 2026-09-30 on this box: a fresh process with
   `enabledProviders: []` dispatches the marketplace-installed
   `fleet-finisher` fine.
2. **Tier**: the same install discards each agent's frontmatter `model:`
   before anything resolves it — deliberate upstream design
   (`can1357/oh-my-pi#7966` → PR #7967, "ignore Claude marketplace model
   aliases"). Re-measured 2026-09-30 on 18.4.4 and still alive:
   `fleet-finisher` (`model: "@smol:low"`) dispatched from a parent at
   `:high` ran at `high`, its `resolvedModel` a bare base id with no suffix.
   The discard is unconditional: the `before_subagent_spawn` hook fires for
   these dispatches but sees no alias to restore — `event.modelRole` is
   undefined; only the parent's pattern survives.

Claude-marketplace plugin directories are **foreign-model sources**: the
format exists to import Claude Code plugins, whose bare `model: opus`
aliases fuzzy-resolved wrongly (#7966), so omp drops the field for the whole
route. This plugin's dual-harness history (ADR 0004/0011/0014) is why the
distribution stayed on that format after ADR 0014 made omp the only harness.

The 2026-09-30 measurements of the alternative — omp's native extension
package route, the same `plugin/package.json` this repo already ships for
ADR 0020:

| Probe | Result |
| --- | --- |
| `omp plugin link <checkout>/plugin`, dispatch `fleet-review-correctness` (`@slow:high`) and `fleet-finisher` (`@smol:low`) from a `:medium` parent | both honored: child effort `high` / `low`, suffixed `resolvedModel` |
| commands on the link route | **registered, under bare filenames**: `/run-team-help` substitutes its body (the CI probe shape); the `/fleet-ctl:` prefix is a marketplace-provider artifact; a colon inside a command file's frontmatter `name:` does not restore it |
| skills on the link route | surfaced (`omp skill list` → bare `run-team`, source `omp-plugins:user`); the hidden entry skill remains `/skill:run-team`-invocable (`skills.enableSkillCommands`, default true) |
| `member-write-guard` on the link route | loads and refuses (verbatim guard text observed) |
| `plugin/.claude-plugin/plugin.json` on the link route | not load-bearing (removing it from a copy changes nothing) — but `scripts/repo-root.mjs` keys its self-identity read on that path, so the file stays |
| `omp plugin install <name>@<marketplace>` vs native | native installs (`link`, npm) register in `~/.omp/plugins/node_modules/<name>` (+ `omp-plugins.lock.json` for the version, written by marketplace/npm installs, not by link); `installed_plugins.json` is marketplace-only |
| `omp plugin doctor` on either route | never imports/validates `omp.extensions`: a syntax-error module links and doctors clean, failing open at runtime |
| unmapped role alias | hard child-spawn failure ("No model selected.", exit 1), never a silent parent fall-through — the #1430 silent-wrong-tier shape cannot recur through a missing role |
| npm registry | `fleet-ctl` free (404), kept so by the `npm-name-gate` since #1347 |

## Decision

1. **The marketplace install route is retired.** The tracked catalog
   `.omp-plugin/marketplace.json` is deleted. The consumer install is the
   npm package: `omp plugin install fleet-ctl`. The dev loop is the link:
   `omp plugin link <checkout>/plugin` — edits to agent definitions reach
   the next session with no reinstall, which is what the deleted
   `~/.omp/agent/agents/` mirror (#1430's original workaround) was
   compensating for by hand.
2. **No compensation shim ships for the marketplace route.** The
   `before_subagent_spawn` model-restoring hook — measured feasible,
   returning `{model}` expands role+effort fully — was the leading fix
   under the approved "zero operator config" bar. It is dropped: choosing
   the route that honors `model:` natively beats permanently compensating
   for the one that discards it, and a shim the extension loader can fail
   to load silently (the `doctor` row above; ADR 0020 §7's own silent-load
   finding) would re-open the disease it treats.
3. **The command surface becomes bare names.** `/run-team-help`,
   `/review-and-fix`, `/run-merge-bot`; the entry point is
   `/skill:run-team [implementers] [reviewers]` (unchanged mechanism — a
   hidden invoke-only skill — renamed only by dropping the prefix). Every
   shipped prose reference follows in the same change; `run-team-help`'s
   body prints the new exact invocation. Chosen over an extension-registered
   `fleet-ctl:`-prefix bridge (measured to work, with a frame-hold latch):
   a second dispatch path beside the native file-command path is a
   divergence kept only for a prefix.
4. **One resolution point.** `fleet-run`, `fleet-provenance`, and
   `fleet-bootstrap` resolve the Install root as the realpath of
   `~/.omp/plugins/node_modules/fleet-ctl` — the single path every omp
   install kind places (link: symlink to the checkout; marketplace:
   symlink into the cache; npm: a real directory) — and nothing else. The
   multi-entry `installed_plugins.json` selection and its scope-ambiguity
   refusal retire with the file they parsed. The recorded version comes
   from `omp-plugins.lock.json`, which every install kind writes — a link
   records the manifest's `package.json` version, so the number never
   distinguishes kinds; the Provenance check's `kind:` classification (its
   symlink+realpath test) carries that job and prints a NOTICE for a
   `linked-checkout`, because on such a box every fleet-run answer comes
   from the dev tree, not an installed release.
5. **`enabledProviders` is retired as a precondition, everywhere**: README,
   CONTEXT § Install, `docs/requirements.md`, the Provenance check's
   assertion (and with it its `--omp-config` flag and YAML reader), and
   both CI scripts' setup. It refused correct setups since 18.2.1 (point 1
   of Context) and never applied to the native route. `modelRoles.slow|task|smol`
   is the only operator setting a run depends on; `tier-roles.mjs --check`
   remains its read.
6. **Publishing joins the release flow.** `plugin/package.json` carries
   publish metadata (description, license, `repository.directory: plugin`,
   and a `files` list shipping `agents/ commands/ skills/ scripts/
   .claude-plugin/ LICENSE NOTICE`); `release.yml` publishes the minted tag
   as that version, treating "already published" as success. The
   `npm-name-gate` job is deleted: a name we publish is collision-proofed
   by the publish itself — a squatted name fails the release job loudly
   (403), which is a stronger gate than a pre-occupancy 404 check, and the
   old check goes permanently red the moment its own premise ends (200
   once published).
7. **`plugin/.claude-plugin/plugin.json` stays, with its purpose changed.**
   No harness reads it on the native route; it is repo-internal identity
   for `repo-root.mjs`'s self-check (an npm-installed payload keeps it at
   the same relative path). Its missing-`version` warning history was a
   Claude Code concern and is moot.

## Rejected alternatives

- **Ship the model-restoring `before_subagent_spawn` extension and keep
  the marketplace route.** Rejected by the maintainer's route choice; see
  Decision 2. It also leaves consumers on an install the extension loader
  cannot self-certify.
- **A `fleet-ctl:`-prefix command bridge so zero prose churns.** Rejected:
  measured to reproduce marketplace substitution, but it registers a second
  command path whose dispatch semantics must match omp's own file-command
  path forever. The 17-line prose rename is one commit; the bridge is a
  permanent parallel surface.
- **`git-subdir`-style native install from a git URL.** Measured to exist
  (`omp plugin install https://github.com/…`) but it reads the manifest at
  the **repo root**, which forces the shipped package out of `plugin/` —
  the opposite of ADR 0019's single shipped surface. npm reaches the same
  node_modules layout without moving anything.
- **Waiting on upstream to honor qualified selectors on marketplace
  agents.** The feature request remains unfiled by choice (#1430 round-1):
  #7967's rationale argues it, but its landing cannot be scheduled, and
  the route we now ship needs it for nothing.

## Consequences

- ADR 0003 point 8, ADR 0012's amendment note, and ADR 0014 §5/§7 carry
  retirement notes; ADR 0006's "qualified id is canonical" and ADR 0010's
  "installs track the branch" sentences are superseded here; ADR 0019's
  mechanism note (`git-subdir` ships `plugin/`) becomes "the package
  `files` list ships `plugin/`" — its rule stands untouched.
- **Existing marketplace installs keep serving their cached copy** with
  the wrong tier until the operator switches (`marketplace add` of this
  repo now fails — no catalog). README's Installation is the migration
  text; nothing here detects-and-refuses a stale marketplace install,
  because after the Provenance retarget such an install resolves like any
  other node_modules entry (`kind: marketplace-install`, version from the
  lock) — the NOTICE/`kind` line tells a reader which shape a box holds.
- **Version semantics change**: installs track published semver, not the
  `main` branch tip; every merged PR still mints a release, and now also
  a package version. `marketplace.autoUpdate` is gone with the route.
- CI retargets: `smoke-omp.sh` links the checkout instead of building a
  dev catalog, asserts the three bare commands by the same `--no-tools`
  substitution probe (measured live on the link route), and adds the
  tier-honor assertion — a mocked-provider parent turn dispatches
  `fleet-finisher` and the child session record must show the smol
  target and `low` effort (the credential-less readback shape measured
  possible 2026-09-30; the subagent default effort is `high`, so an
  unmapped/dropped tier cannot masquerade as a pass). The omp pin moves
  `18.1.15` → `18.4.4` (the version this ADR's table measures; the native
  route's command discovery must not regress under CI's feet without a
  red job). `install-and-smoke.sh` swaps catalog+install for link, keeps
  the resolve-every-callsite and one-real-exec spine, and expects
  `kind: linked-checkout`.
- The `docs/research/external-assumptions/` rows naming
  `enabledProviders`, the git-subdir marketplace, or the
  `installed_plugins.json` read are re-pointed at the node_modules/lock
  shapes this ADR installs.
- #1430 closes on ship with a fresh discovery-route matrix recorded in
  the issue: the two-tier dispatch readbacks this ADR was ruled on.
