// run-records.mjs: the allowlist of run records and review evidence the
// Close-out PR commits, and where each file in `.fleet/` and the scratch root
// is committed under docs/metrics/. Zero deps:
// `node --test tests/run-records.test.mjs`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./support/temp-dir.mjs";
import { gather, isRunRecord, recordChanges, RECIPE_WITHHELD, reviewEvidence, reviewTargets, runArchives, unclosedRecords } from "../plugin/scripts/run-records.mjs";

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
    `docs/metrics/reviews/4175/${RUN}/dispositions-fix-pr-4175-bb.json`,
    "docs/metrics/runs/2026-11-01-02T172207Z/ledger.md",
    `docs/metrics/runs/${STAMP}/plugin-version.txt`,
    `docs/metrics/runs/${STAMP}/plugin-versions`,
  ]) assert.equal(isRunRecord(path), false, path);
});

test("runArchives maps each stamped archive to its run directory, withholds the phase-0 receipt's Recipe commands, and writes the version it recorded", () => {
  const fleet = tempDir("run-records-fleet-");
  const recipe = { status: "ok", at: "2026-11-01T17:22:07.000Z", output: "Recipe cache valid: true ; true ; API_TOKEN=s3cret-value ./run-tests.sh" };
  writeFileSync(join(fleet, `ledger.${STAMP}.md`), "ledger\n");
  writeFileSync(join(fleet, `phase0.${STAMP}.json`), JSON.stringify({ pluginVersion: "3.136.10", steps: { pin: { status: "ok", output: "pinned" }, recipe } }));
  writeFileSync(join(fleet, "closeout.2026-10-31T202750Z.json"), "{}");
  writeFileSync(join(fleet, "phase0.2026-10-30T083515Z.json"), JSON.stringify({ steps: {} }));
  writeFileSync(join(fleet, "phase0.2026-10-29T093307Z.json"), "{not json API_TOKEN=s3cret-value");
  writeFileSync(join(fleet, "ledger.2026-08-13-run442.md"), "old\n");
  writeFileSync(join(fleet, "ledger.2026-11-01-02T172207Z.md"), "not a stamp\n");
  writeFileSync(join(fleet, "ledger.md"), "live\n");
  writeFileSync(join(fleet, "recipe.json"), "{}");
  mkdirSync(join(fleet, `briefs.${STAMP}`));
  const got = runArchives(fleet);
  assert.deepEqual(got.copies.map((c) => [c.from.slice(fleet.length + 1), c.to]), [
    ["closeout.2026-10-31T202750Z.json", "docs/metrics/runs/2026-10-31T202750Z/closeout.json"],
    [`ledger.${STAMP}.md`, `docs/metrics/runs/${STAMP}/ledger.md`],
  ]);
  assert.deepEqual(got.writes.map((w) => w.to), [
    "docs/metrics/runs/2026-10-30T083515Z/phase0.json",
    `docs/metrics/runs/${STAMP}/phase0.json`,
    `docs/metrics/runs/${STAMP}/plugin-version`,
  ]);
  const [, receipt, version] = got.writes;
  assert.equal(receipt.text.includes("s3cret"), false, "no Recipe command reaches the committed receipt");
  assert.deepEqual(JSON.parse(receipt.text), { pluginVersion: "3.136.10", steps: { pin: { status: "ok", output: "pinned" }, recipe: { ...recipe, output: RECIPE_WITHHELD } } }, "everything else in the receipt is kept");
  assert.equal(version.text, "3.136.10\n");
  assert.equal(got.notes.length, 1);
  assert.match(got.notes[0], /phase0\.2026-10-29T093307Z\.json not committed: /);
  assert.equal(got.notes[0].includes("s3cret"), false, "the note quotes no byte of the unreadable receipt");
});

test("reviewTargets puts each review.json under its run and each Charges file under the run it names, and names one that names none", () => {
  const scratch = tempDir("run-records-scratch-");
  for (const dir of [RUN, "run-b2C3d4E5", "run-short", "run-a1B2c3D4extra", "merge-bot-3"]) {
    mkdirSync(join(scratch, "pr41", dir), { recursive: true });
    writeFileSync(join(scratch, "pr41", dir, "review.json"), "{}");
  }
  for (const entry of ["pr0", "pr041"]) {
    mkdirSync(join(scratch, entry, RUN), { recursive: true });
    writeFileSync(join(scratch, entry, RUN, "review.json"), "{}");
  }
  writeFileSync(join(scratch, "dispositions-fix-pr-41.json"), JSON.stringify({ run: RUN }));
  writeFileSync(join(scratch, "dispositions-fix-pr-41-bb.json"), JSON.stringify({ run: RUN }));
  writeFileSync(join(scratch, "dispositions-fix-pr-41-b.json"), JSON.stringify({ run: "elsewhere" }));
  writeFileSync(join(scratch, "dispositions-fix-pr-41-c.json"), "{not json");
  assert.deepEqual(reviewTargets(join(scratch, "pr41"), "pr41").targets.map((t) => t.to), [`docs/metrics/reviews/41/${RUN}/review.json`, "docs/metrics/reviews/41/run-b2C3d4E5/review.json"]);
  assert.deepEqual(reviewTargets(join(scratch, "dispositions-fix-pr-41.json"), "dispositions-fix-pr-41.json").targets.map((t) => t.to), [`docs/metrics/reviews/41/${RUN}/dispositions-fix-pr-41.json`]);
  const got = reviewEvidence(scratch);
  assert.deepEqual(got.copies.map((c) => c.to).sort(), [`docs/metrics/reviews/41/${RUN}/dispositions-fix-pr-41.json`, `docs/metrics/reviews/41/${RUN}/review.json`, "docs/metrics/reviews/41/run-b2C3d4E5/review.json"]);
  assert.equal(got.notes.length, 2);
  assert.ok(got.notes.every((n) => /names no review run/.test(n)), got.notes.join("\n"));
  assert.deepEqual(reviewEvidence(join(scratch, "absent")), { copies: [], notes: [] });
});

test("gather replaces a symlink at a destination rather than writing through it", () => {
  const fleet = tempDir("run-records-fleet-");
  const cwd = tempDir("run-records-cwd-");
  writeFileSync(join(fleet, `ledger.${STAMP}.md`), "ledger\n");
  writeFileSync(join(cwd, "outside"), "keep\n");
  const dest = join(cwd, "docs/metrics/runs", STAMP, "ledger.md");
  mkdirSync(join(dest, ".."), { recursive: true });
  symlinkSync("../../../../outside", dest);
  gather({ cwd, fleetDir: fleet, scratch: join(cwd, "no-scratch") });
  assert.equal(readFileSync(join(cwd, "outside"), "utf8"), "keep\n", "the symlink's target is untouched");
  assert.equal(lstatSync(dest).isFile(), true, "the destination is a regular file");
  assert.equal(readFileSync(dest, "utf8"), "ledger\n");
});

test("gather leaves every file mode 0644, whatever the source's mode or the umask", (t) => {
  const fleet = tempDir("run-records-fleet-");
  const cwd = tempDir("run-records-cwd-");
  writeFileSync(join(fleet, `ledger.${STAMP}.md`), "ledger\n", { mode: 0o755 });
  writeFileSync(join(fleet, `phase0.${STAMP}.json`), JSON.stringify({ pluginVersion: "3.136.10" }));
  const umask = process.umask(0);
  t.after(() => process.umask(umask));
  gather({ cwd, fleetDir: fleet, scratch: join(cwd, "no-scratch") });
  for (const file of ["ledger.md", "phase0.json", "plugin-version"]) {
    assert.equal(lstatSync(join(cwd, "docs/metrics/runs", STAMP, file)).mode & 0o777, 0o644, file);
  }
});

test("unclosedRecords keeps the run records of a run that left no close-out receipt", () => {
  const fleet = tempDir("run-records-fleet-");
  const closed = "2026-10-31T202750Z";
  writeFileSync(join(fleet, `closeout.${closed}.json`), "{}");
  assert.deepEqual(unclosedRecords(fleet, [
    `docs/metrics/runs/${closed}/ledger.md`,
    `docs/metrics/runs/${STAMP}/ledger.md`,
    `docs/metrics/runs/${STAMP}/phase0.json`,
    `docs/metrics/reviews/41/${RUN}/review.json`,
  ]), [`docs/metrics/runs/${STAMP}/ledger.md`, `docs/metrics/runs/${STAMP}/phase0.json`]);
});

// recordChanges() over a real repository, through the `git` shape closeout.mjs hands it.
test("recordChanges allows a new record, a changed tracked one, and one a failed commit left staged", () => {
  const cwd = tempDir("run-records-repo-");
  const git = (args) => {
    const r = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, how: `exit ${r.status}` };
  };
  const dir = `docs/metrics/runs/${STAMP}`;
  mkdirSync(join(cwd, dir), { recursive: true });
  writeFileSync(join(cwd, dir, "ledger.md"), "old\n");
  for (const args of [["init", "-q"], ["add", "-A"], ["commit", "-qm", "main"]]) assert.equal(git(args).status, 0, args.join(" "));
  writeFileSync(join(cwd, dir, "ledger.md"), "new\n");
  writeFileSync(join(cwd, dir, "phase0.json"), "{}\n");
  assert.equal(git(["add", "--", `${dir}/phase0.json`]).status, 0);
  writeFileSync(join(cwd, dir, "plugin-version"), "3.136.10\n");
  writeFileSync(join(cwd, dir, "recipe.json"), "{}\n");
  const got = recordChanges(git, cwd);
  assert.deepEqual(got.allowed.sort(), [`${dir}/ledger.md`, `${dir}/phase0.json`, `${dir}/plugin-version`]);
  assert.deepEqual(got.refused, [`${dir}/recipe.json`]);
});
