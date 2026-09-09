# 0004 — One tree speaks two dialects: neutral prose, the dialect on marked lines

**Status:** Accepted. Ruled 2026-09-09 on #1297, #1299, #1315, #1316, against the measurements below.

## Context

Four candidate authoring strategies were open for how skill and command bodies
name harness-specific tools — dual-dialect inline, neutral vocabulary plus a
per-harness dialect card, shared core plus thin per-harness shells behind two
marketplace manifests, or two hand-maintained trees (#1297). Measured
2026-09-09 on Claude Code 2.1.265 and omp 18.1.14/15:

- **Two manifests is unavailable.** With `.claude-plugin/plugin.json` and
  `.omp-plugin/plugin.json` both present and remapping `commands`/`skills`/
  `agents` to harness-named directories, omp served the **Claude-remapped
  content**: `/dialectprobe-plugin:probe` printed `CLAUDE-COMMAND-MARKER` on
  omp, and the skill listing showed `probe-skill-claude`, never
  `probe-skill-omp`. omp's own doc: content is loaded by
  `listClaudePluginRoots(...)` reading only `.claude-plugin/plugin.json`;
  `.omp-plugin/plugin.json` steers only the marketplace catalog description.
- **A per-harness dialect card has no loading path.** Neither `claude-plugins`
  nor `omp-plugins` injects a plugin-shipped context file; `claude plugin
  validate` says so directly — "CLAUDE.md at the plugin root is not loaded as
  project context." A card would need an explicit tool call per session,
  moving the mapping out of sight of the pin guarding the instruction that
  uses it.
- **Two trees doubles maintenance by definition** — ruled out by the map's own
  destination.
- **Dual-dialect inline, counted.** Claude-dialect executed-instruction tokens
  across `skills/ commands/ agents/ workflows/`: 23 occurrences in three
  files — `skills/run-team/SKILL.md` 16 (152KB, 0.68/100 lines),
  `references/member-lifecycle.md` 5, `commands/review-and-fix.md` 2.
  Everything else is dialect-free; omp tokens: 0. Naming both tools at every
  site costs ~1,380 bytes, 0.6% of the largest file.

Two further rulings bound what the marked lines must carry. #1316 measured
that the controller-to-member channel is not one shared surface with two
spellings: of five coordination mechanics, two (grandchild reachability,
result consumption) do not apply on omp at all rather than merely reword, and
one (killed/idle/truncated state) is a different state machine — a single
prose with a dialect card would state a false rule on one harness. #1315
measured that a fleet member is never dispatched `isolated` on omp —
isolation builds a workspace outside the claimed worktree and patch-applies
into the controller's checkout on completion, the exact spill hazard
`run-team`'s claim/release model exists to prevent — so that prohibition is
itself a per-harness fact the tree must carry.

## Decision

1. **One tree, one manifest, one set of bodies.** No shells, no second
   manifest, no card.
2. **Bodies are written in the harness-neutral vocabulary fixed on #1316** —
   *dispatch*, *send*, *wake*, *settle*, *consume* — and every rule true on
   both harnesses is stated once.
3. **At each of the ~23 dispatch sites, the dialect is stated inline, marked
   by harness**, as two adjacent lines: the Claude form and the omp form,
   each carrying the harness's own agent-name convention. The marker is a
   fixed, greppable token so a pin can address exactly one line.
4. **Rules that do not apply on one harness are marked, never paraphrased** —
   #1316's result-consumption and grandchild-reachability mechanics, and
   #1315's "isolated is never used for a fleet member," are the first
   instances.
5. **Frontmatter carries both dialects keyed by field name** — `effort:` plus
   `thinking-level:` (#1302), model spelling per #1298. Unknown keys are
   preserved on both harnesses, so this is the one place two dialects
   legitimately share a file without a marker: the harness selects by key.
6. **The pin discipline for marked lines is #1299's**: each marked line is
   pinned as its own one-line slice — not a section — and mutation-tested
   against the *other* harness's line, so an inversion in one copy cannot
   pass on the other.

## Rejected alternatives

- **Two marketplace manifests (candidate 3).** Measured to not route content
  per harness at all — omp reads only `.claude-plugin/plugin.json` for
  commands, skills, and agents; the second manifest steers only the catalog
  description.
- **Neutral prose plus a per-harness dialect card (candidate 2).** No harness
  injects a plugin-shipped context file; `claude plugin validate` confirms it
  in its own text. A card is a round trip per session and moves the mapping
  out of the pin's reach.
- **Two hand-maintained trees (candidate 4).** Doubles maintenance by
  definition; rejected by the map's stated destination without needing
  measurement.
- **Neutral-only, no inline dialect.** Rejected on the ticket's own caution:
  this prose is executed as instructions, and "dispatch a member" without the
  tool's name is a reliability trade a fleet controller should not make.

## Consequences

- The token-efficiency objection to dual-dialect inline is real in principle
  and negligible in measurement: ~1,380 bytes, 0.6% of the largest file,
  concentrated in three files.
- `agent(` appears 16 times as Claude's *workflow-script* builtin inside
  `review-pr.js` and its callers, not omp's `eval` helper — no dialect
  rewrite may substitute on that spelling alone.
- #1298's "declared intent" is the agent file's own frontmatter, harness-keyed
  — there are no per-harness shells for it to live in.
- #1299's shared core is every sentence that is not a marked line; the
  per-harness copies are exactly the marked lines; the divergence check
  operates on pairs of adjacent marked lines.
- #1314's allow-list is one set per artefact kind, admitting both harnesses'
  keys and requiring one of each harness's required keys — not two
  allow-lists.
- #1341 and #1344 (the member-lifecycle rewrite and the run-team
  worktree-model prose) are containered as sections in the existing files
  with marked lines, not per-harness files.
- `omp://skills/authoring-marketplaces.md`'s claim that omp reads
  `.omp-plugin/plugin.json` before `.claude-plugin/plugin.json` holds for MCP
  servers only, measured; corrected for the record.
