#!/usr/bin/env node
// The finisher's labelling duty as one command, so its two halves cannot be
// read as one: the release-label check is a precondition, and a finisher that
// stopped after it reported `labelled` on a PR that never got the label.
//
//   finisher-label.mjs --pr <M> --pin <sha> [--repo <dir>]
//
// `--pin` is the full 40-hex head the finisher audited; `--repo` is the
// directory `gh` runs in (it resolves the repository from there), the cwd when
// omitted. Reached through the Resolver: `~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run
// finisher-label.mjs ...`.
//
// Steps, in this order, each one only if every earlier one held:
//
//   0  ask ticketless.mjs whether the PR is a Ticketless PR: one that closes no
//      issue in its own repository and that no settled implementer token
//      names. A test that could not look is exit 2.
//   1  read the PR's labels and comments and count the release labels,
//      `patch`/`minor`/`major`. Exactly one passes. Several is exit 3 and
//      nothing is written. Zero is exit 3 and nothing is written, except on a
//      Ticketless PR, which gets `patch` added and passes. A repo whose label
//      list defines none of the three has nothing to count: the count is
//      skipped and the receipt says `releaseLabels: "undefined-in-repo"`. That
//      list is read only when the PR carries none of them — one on the PR
//      proves it is defined — and a list that fills the limit it was read with
//      proves nothing, so it is exit 2 rather than a skipped count.
//   1b on a Ticketless PR, finisher-scope.mjs's Inert diff verdict at `--pin`,
//      run in-process. A diff that is not inert, or a verdict that could not
//      look, stops after step 2: the head record is posted, the label is not
//      added, and the exit is 5.
//   2  comment `ready-to-merge-head: <pin>`, the record the merge bot reads as
//      the head the label was applied to — skipped when the newest such
//      comment already names this pin.
//   3  add the `ready-to-merge` label.
//   4  read the labels back. Exit 0 only when the read-back carries
//      `ready-to-merge`; `gh pr edit` returning 0 is not that.
//
// Idempotent: a PR that already carries `ready-to-merge` and whose newest
// head record names this pin is left as it is — no comment, no label write —
// and still answers 0 off the read-back, `added: false`.
//
// `ready-to-merge` above is a Label role (label-map.mjs): the label written,
// and the one the idempotence check and the read-back look for, is the Label
// map's string for it, read once from the repository `--repo` names (the cwd
// when omitted) before step 0. The head record is not a label: its prefix is
// `ready-to-merge-head:` whatever the map says, the grammar the merge bot
// parses back.
//
// Stdout is always one JSON line, the receipt:
//
//   {pr, pin, ticketless, releaseLabels, patchAdded, inert, commented, added,
//    readBack, exit, firstRead [, step, error]}
//
//   ticketless     the Ticketless test's answer, null when it never got one
//   releaseLabels  the release labels the PR carried (`patch` once added to a
//                  Ticketless PR), or "undefined-in-repo", or null when step 1
//                  never got an answer
//   patchAdded     this run added `patch`
//   inert          the Inert diff verdict object, null when it never ran
//   commented      this run posted the head record
//   added          this run wrote the label
//   readBack       every label name the step 4 read carried, null if it never ran
//   firstRead      every label name step 1 read carried, null if it never ran
//   step           on exit 2 only, the step that failed: `pin`, `repo`,
//                  `label-map`, or the step whose `gh` call failed
//   error          on exit 2 only, what `gh` (or the invocation) said
//
// A usage error that never reaches `gh` — a missing or unknown flag — is a
// refusal on stderr with no receipt, as in every other script's `die()`.
//
// Exit vocabulary:
//
//   0  the read-back carries `ready-to-merge`
//   2  the invocation or a `gh` call failed, the Label map could not be read
//      (an absent or invalid map's error names `label-map.mjs ensure`), or the
//      Ticketless test could not look — its stderr is in the receipt and on
//      stderr, and no later step ran
//   3  the PR does not carry exactly one release label — nothing was written
//   4  every write returned 0 and the read-back does not carry the label
//   5  a Ticketless PR whose diff is not inert, or whose verdict could not
//      look: the head record is posted and the label is not added, so the
//      maintainer's `ready-to-merge` is the merge

import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { makeDie, defineFlags, writeAll } from "./arg.mjs";
import { inertVerdict } from "./finisher-scope.mjs";
import { gitEnv } from "./git-env.mjs";
import { LABEL_LIST_ARGS, LABEL_LIST_LIMIT, releaseLabelsDefined, releaseLabelsIn } from "./release-labels.mjs";
import { readLabelMap } from "./label-map.mjs";
import { ticketlessVerdict } from "./ticketless.mjs";

const NAME = "finisher-label";

const die = makeDie(NAME);
const { arg, numArg, sweep, stray } = defineFlags(die, {
  flags: { pr: "value", pin: "value", repo: "value" },
});

const USAGE = "usage: finisher-label.mjs --pr <M> --pin <sha> [--repo <dir>]";

// The sweep runs before the required-flag check so a misspelt flag is named
// as that, not buried under a missing-flag usage line.
sweep();
stray();
const pr = numArg("pr");
const pinArg = arg("pin");
const repo = arg("repo");
if (pr === null || pinArg === null) die(USAGE);

const receipt = {
  pr,
  pin: pinArg,
  ticketless: null,
  releaseLabels: null,
  patchAdded: false,
  inert: null,
  commented: false,
  added: false,
  readBack: null,
  exit: 0,
  firstRead: null,
};

function finish(exit, extra = {}, message = null) {
  Object.assign(receipt, extra, { exit });
  writeAll(1, `${JSON.stringify(receipt)}\n`);
  if (message !== null) writeAll(2, `${NAME}: ${message}\n`);
  process.exit(exit);
}

function fail(step, error) {
  finish(2, { step, error }, `${step}: ${error}`);
}

// Full SHAs only: the bot's record grammar is exactly 40 lowercase hex, so a
// shorter or uppercase pin would be a record it cannot read. Case is folded
// rather than refused — `ABC…` names the same commit.
const pin = pinArg.toLowerCase();
if (!/^[0-9a-f]{40}$/.test(pin)) {
  fail("pin", `--pin needs a full 40-character commit SHA, got ${pinArg}`);
}
receipt.pin = pin;

// A missing directory makes spawn report ENOENT for `gh` itself, which would
// blame the binary for a bad --repo.
if (repo !== null && !statSync(repo, { throwIfNoEntry: false })?.isDirectory()) {
  fail("repo", `--repo is not a directory: ${repo}`);
}

// The tracker's string for the `ready-to-merge` role, in the repository `gh`
// runs in.
let LABEL;
try {
  LABEL = readLabelMap({ cwd: resolve(repo ?? ".") })["ready-to-merge"];
} catch (e) {
  fail("label-map", e.message);
}

// `gh` resolves its repository from the cwd's git remotes, so an ambient
// GIT_DIR would retarget every call at another repository.
const GH_ENV = gitEnv();

// stdout parsed, stderr captured: what `gh` said is the receipt's `error`.
function gh(step, args) {
  const r = spawnSync("gh", args, { encoding: "utf8", env: GH_ENV, stdio: ["ignore", "pipe", "pipe"], ...(repo === null ? {} : { cwd: repo }) });
  if (r.error) fail(step, `could not run gh: ${r.error.message}`);
  if (r.signal) fail(step, `gh was killed by ${r.signal}`);
  if (r.status !== 0) fail(step, (r.stderr ?? "").trim() || `gh exited ${r.status}`);
  return r.stdout;
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function ghJson(step, args, shape) {
  const out = gh(step, args);
  let v;
  try {
    v = JSON.parse(out);
  } catch {
    return fail(step, `gh printed no JSON: ${out.slice(0, 200)}`);
  }
  if (!shape(v)) fail(step, `gh printed an unexpected shape: ${out.slice(0, 200)}`);
  return v;
}

const namedList = (v) => Array.isArray(v) && v.every((l) => isObject(l) && typeof l.name === "string");

const labelNames = (v) => v.labels.map((l) => l.name);

// --- 0: the Ticketless test ------------------------------------------------
const test = await ticketlessVerdict({ pr, repo: repo === null ? null : resolve(repo) });
if (test.exit === 2) fail("ticketless", test.reason);
const ticketless = test.exit === 0;
receipt.ticketless = ticketless;

// --- 1: the release-label count -------------------------------------------
const first = ghJson("read-labels", ["pr", "view", String(pr), "--json", "labels,comments"], (v) =>
  isObject(v) && namedList(v.labels) && Array.isArray(v.comments) && v.comments.every((c) => isObject(c) && typeof c.body === "string" && typeof c.createdAt === "string"));
const firstLabels = labelNames(first);
receipt.firstRead = firstLabels;
const found = releaseLabelsIn(firstLabels);

if (found.length === 0) {
  const defined = ghJson("list-labels", LABEL_LIST_ARGS, namedList).map((l) => l.name);
  const state = releaseLabelsDefined(defined);
  if (state === "cut-off") {
    fail("list-labels", `the repository has ${LABEL_LIST_LIMIT} or more labels, so the list may be cut off before patch, minor or major`);
  }
  if (state === "undefined") {
    receipt.releaseLabels = "undefined-in-repo";
  } else if (!ticketless) {
    finish(3, { releaseLabels: found }, "the PR carries no release label (patch, minor or major); nothing was written");
  } else {
    // No ticket picks the bump of a Ticketless PR, so it gets the smallest.
    gh("add-patch", ["pr", "edit", String(pr), "--add-label", "patch"]);
    receipt.patchAdded = true;
    receipt.releaseLabels = ["patch"];
  }
} else if (found.length > 1) {
  finish(3, { releaseLabels: found }, `the PR carries more than one release label (${found.join(", ")}); nothing was written`);
} else {
  receipt.releaseLabels = found;
}

// --- 1b: the Inert diff verdict, on a Ticketless PR ------------------------
// No ticket gives a Ticketless PR its ruling or its acceptance mutation, so it
// merges unattended only when its whole diff is inert; otherwise the head is
// recorded and the maintainer's label is the merge.
if (ticketless) receipt.inert = inertVerdict({ worktree: resolve(repo ?? "."), pin });

// --- 2: the head record ----------------------------------------------------
// The newest record wins, the way the merge bot reads it: a matching record
// older than one naming another head is not the record the bot will act on.
const RECORD = /^ready-to-merge-head: ([0-9a-f]{40})\s*$/;
const records = first.comments
  .map((c, i) => ({ i, at: c.createdAt, m: RECORD.exec(c.body) }))
  .filter((c) => c.m !== null)
  .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.i - b.i));
const recorded = records.length > 0 && records[records.length - 1].m[1] === pin;
const labelled = firstLabels.includes(LABEL);

if (!recorded) {
  gh("comment", ["pr", "comment", String(pr), "--body", `ready-to-merge-head: ${pin}`]);
  receipt.commented = true;
}

if (ticketless && receipt.inert.exit !== 0) {
  const why = receipt.inert.verdict === "unknown" ? `its diff could not be read (${receipt.inert.reason})` : "its diff is not inert";
  finish(5, {}, `the PR is a Ticketless PR and ${why}: the head is recorded and ${LABEL} is left to the maintainer`);
}

// --- 3: the label ----------------------------------------------------------
if (!(recorded && labelled)) {
  gh("add-label", ["pr", "edit", String(pr), "--add-label", LABEL]);
  receipt.added = true;
}

// --- 4: the read-back ------------------------------------------------------
const back = ghJson("read-back", ["pr", "view", String(pr), "--json", "labels"], (v) => isObject(v) && namedList(v.labels));
receipt.readBack = labelNames(back);
if (!receipt.readBack.includes(LABEL)) {
  finish(4, {}, `the read-back does not carry ${LABEL}`);
}
finish(0);
