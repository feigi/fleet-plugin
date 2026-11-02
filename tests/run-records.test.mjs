// run-records.mjs: the allowlist of run records and review evidence the
// Close-out PR commits, and where each file in `.fleet/` and the scratch root
// is committed under docs/metrics/. Zero deps:
// `node --test tests/run-records.test.mjs`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./support/temp-dir.mjs";
import { isRunRecord, reviewEvidence, reviewTargets, runArchives } from "../plugin/scripts/run-records.mjs";

const STAMP = "2026-11-01T172207Z";
const RUN = "run-a1B2c3D4";

test("isRunRecord accepts every run record and review evidence name gather() writes", () => {
  for (const path of [
    `docs/metrics/runs/${STAMP}/ledger.md`,
    `docs/metrics/runs/${STAMP}/phase0.json`,
    `docs/metrics/runs/${STAMP}/closeout.json`,
    `docs/metrics/runs/${STAMP}/plugin-version`,
    `docs/metrics/reviews/4175/${RUN}/review.json`,
    `docs/metrics/reviews/4175/${RUN}/dispositions-fix-pr-4175.json`,
    `docs/metrics/reviews/4175/${RUN}/dispositions-fix-pr-4175-b.json`,
  ]) assert.equal(isRunRecord(path), true, path);
});

test("isRunRecord refuses a recipe, a transcript, a brief and every other name or shape", () => {
  for (const path of [
    `docs/metrics/runs/${STAMP}/recipe.json`,
    "recipe.json",
    ".fleet/recipe.json",
    `docs/metrics/runs/${STAMP}/session.jsonl`,
    `docs/metrics/runs/${STAMP}/transcript.jsonl`,
    `docs/metrics/runs/${STAMP}/briefs/impl-4175.md`,
    `docs/metrics/runs/briefs.${STAMP}/impl-4175.md`,
    `docs/metrics/reviews/4175/${RUN}/brief.md`,
    `docs/metrics/reviews/4175/${RUN}/snapshot/x.mjs`,
    `docs/metrics/reviews/4175/${RUN}/dispositions-fix-pr-4176.json`,
    "docs/metrics/reviews/4175/run-short/review.json",
    "docs/metrics/reviews/0/run-a1B2c3D4/review.json",
    "docs/metrics/reviews/4175/review.json",
    "docs/metrics/runs/2026-11-01/ledger.md",
    `docs/metrics/runs/${STAMP}/nested/ledger.md`,
    `docs/metrics/runs/${STAMP}/`,
    `docs/runs/${STAMP}/ledger.md`,
    "docs/metrics/tier-outcomes.tsv",
  ]) assert.equal(isRunRecord(path), false, path);
});

test("runArchives maps each stamped archive to its run directory and writes the version the phase-0 receipt recorded", () => {
  const fleet = tempDir("run-records-fleet-");
  writeFileSync(join(fleet, `ledger.${STAMP}.md`), "ledger\n");
  writeFileSync(join(fleet, `phase0.${STAMP}.json`), JSON.stringify({ pluginVersion: "3.136.10" }));
  writeFileSync(join(fleet, "closeout.2026-10-31T202750Z.json"), "{}");
  writeFileSync(join(fleet, "phase0.2026-10-30T083515Z.json"), JSON.stringify({ steps: {} }));
  writeFileSync(join(fleet, "phase0.2026-10-29T093307Z.json"), "{not json");
  writeFileSync(join(fleet, "ledger.2026-08-13-run442.md"), "old\n");
  writeFileSync(join(fleet, "ledger.md"), "live\n");
  writeFileSync(join(fleet, "recipe.json"), "{}");
  mkdirSync(join(fleet, `briefs.${STAMP}`));
  const got = runArchives(fleet);
  assert.deepEqual(got.copies.map((c) => [c.from.slice(fleet.length + 1), c.to]), [
    ["closeout.2026-10-31T202750Z.json", "docs/metrics/runs/2026-10-31T202750Z/closeout.json"],
    [`ledger.${STAMP}.md`, `docs/metrics/runs/${STAMP}/ledger.md`],
    ["phase0.2026-10-29T093307Z.json", "docs/metrics/runs/2026-10-29T093307Z/phase0.json"],
    ["phase0.2026-10-30T083515Z.json", "docs/metrics/runs/2026-10-30T083515Z/phase0.json"],
    [`phase0.${STAMP}.json`, `docs/metrics/runs/${STAMP}/phase0.json`],
  ]);
  assert.deepEqual(got.writes, [{ to: `docs/metrics/runs/${STAMP}/plugin-version`, text: "3.136.10\n" }]);
  assert.equal(got.notes.length, 1);
  assert.match(got.notes[0], /phase0\.2026-10-29T093307Z\.json gives no plugin version/);
});

test("reviewTargets puts each review.json under its run and each Charges file under the run it names, and names one that names none", () => {
  const scratch = tempDir("run-records-scratch-");
  mkdirSync(join(scratch, "pr41", RUN), { recursive: true });
  mkdirSync(join(scratch, "pr41", "run-b2C3d4E5"), { recursive: true });
  mkdirSync(join(scratch, "pr41", "merge-bot-3"), { recursive: true });
  writeFileSync(join(scratch, "pr41", RUN, "review.json"), "{}");
  writeFileSync(join(scratch, "pr41", "merge-bot-3", "review.json"), "{}");
  writeFileSync(join(scratch, "dispositions-fix-pr-41.json"), JSON.stringify({ run: RUN }));
  writeFileSync(join(scratch, "dispositions-fix-pr-41-b.json"), JSON.stringify({ run: "elsewhere" }));
  writeFileSync(join(scratch, "dispositions-fix-pr-41-c.json"), "{not json");
  assert.deepEqual(reviewTargets(join(scratch, "pr41"), "pr41").targets.map((t) => t.to), [`docs/metrics/reviews/41/${RUN}/review.json`]);
  assert.deepEqual(reviewTargets(join(scratch, "dispositions-fix-pr-41.json"), "dispositions-fix-pr-41.json").targets.map((t) => t.to), [`docs/metrics/reviews/41/${RUN}/dispositions-fix-pr-41.json`]);
  const got = reviewEvidence(scratch);
  assert.deepEqual(got.copies.map((c) => c.to).sort(), [`docs/metrics/reviews/41/${RUN}/dispositions-fix-pr-41.json`, `docs/metrics/reviews/41/${RUN}/review.json`]);
  assert.equal(got.notes.length, 2);
  assert.ok(got.notes.every((n) => /names no review run/.test(n)), got.notes.join("\n"));
  assert.deepEqual(reviewEvidence(join(scratch, "absent")), { copies: [], notes: [] });
});
