#!/usr/bin/env node
// The merge bot's "labelled head" step as one read-only command, so the bot
// never compares two SHAs by eye: a recorded head printed beside a different
// current head was read as "no record" and sent down the timeline fallback,
// which refuses a moved head without ever calling merge-gate.mjs.
//
//   labelled-head.mjs --pr <N> [--repo <dir>]
//
// `--repo` is the directory `gh` runs in (it resolves the repository from
// there), the cwd when omitted. Reached through the Resolver:
// `~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run labelled-head.mjs ...`.
//
// One `gh pr view <N> --json comments,headRefOid` read gives the newest head
// record (ready-to-merge-head.mjs owns its grammar, the one finisher-label.mjs
// writes) and the current head together. The route follows from those two
// alone:
//
//   current   a record exists and names the current head: proceed untouched.
//   gate      a record exists and names another head: not refused on sight, it
//             may be a rebase-carry. Run merge-gate.mjs with `--pre <record>`
//             and no `--post`; its `rebaseCarry` decides.
//   timeline  no record: a hand-added label, or one applied before its labeller
//             recorded a head. The timeline is read here and its verdict
//             printed. A recorded head is never routed to `timeline`.
//
// The timeline read is the only one that needs the Label map's string for
// `ready-to-merge`, so the map is read only on that route. The `timeline`
// object holds `verdict`, `moved` when a `committed` or `head_ref_force_pushed`
// event follows the last `labeled` event for that string (every such event, if
// none names it), else `clean`; and `after`, those events as `<event> <sha>`.
// The label is left where it is on every verdict: this command writes nothing.
//
// Stdout is always one JSON line:
//
//   {pr, record, head, route, timeline [, step, error], exit}
//
//   record    the newest record's SHA, null when none
//   head      the PR's current head
//   route     `current`, `gate` or `timeline`; null on exit 2
//   timeline  null off the `timeline` route, else {label, verdict, after}
//   step      on exit 2 only, the read that failed: `read-pr`, `label-map`,
//             or `read-timeline`
//   error     on exit 2 only, what `gh` (or the invocation) said
//
// Exit vocabulary:
//
//   0  a route was decided
//   2  the invocation or a read failed — a missing or unknown flag is a refusal
//      on stderr with no receipt, as in every other script's `die()`

import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { makeDie, defineFlags, writeAll } from "./arg.mjs";
import { gitEnv } from "./git-env.mjs";
import { readLabelMap } from "./label-map.mjs";
import { newestHeadRecord } from "./ready-to-merge-head.mjs";

const NAME = "labelled-head";
const USAGE = "usage: labelled-head.mjs --pr <N> [--repo <dir>]";

const MOVING = new Set(["committed", "head_ref_force_pushed"]);

const die = makeDie(NAME);
const { arg, numArg, sweep, stray } = defineFlags(die, {
  flags: { pr: "value", repo: "value" },
});

// The sweep runs before the required-flag check so a misspelt flag is named
// as that, not buried under a missing-flag usage line.
sweep();
stray();
const pr = numArg("pr");
const repo = arg("repo");
if (pr === null) die(USAGE);

const receipt = { pr, record: null, head: null, route: null, timeline: null, exit: 0 };

function finish(exit, extra = {}, message = null) {
  Object.assign(receipt, extra, { exit });
  writeAll(1, `${JSON.stringify(receipt)}\n`);
  if (message !== null) writeAll(2, `${NAME}: ${message}\n`);
  process.exit(exit);
}

function fail(step, error) {
  finish(2, { step, error }, `${step}: ${error}`);
}

if (repo !== null && !statSync(repo, { throwIfNoEntry: false })?.isDirectory()) {
  fail("read-pr", `--repo is not a directory: ${repo}`);
}

// `gh` resolves its repository from the cwd's git remotes, so an ambient
// GIT_DIR would retarget every call at another repository.
const GH_ENV = gitEnv();

function gh(step, args) {
  const r = spawnSync("gh", args, { encoding: "utf8", env: GH_ENV, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, ...(repo === null ? {} : { cwd: repo }) });
  if (r.error) fail(step, `could not run gh: ${r.error.message}`);
  if (r.signal) fail(step, `gh was killed by ${r.signal}`);
  if (r.status !== 0) fail(step, (r.stderr ?? "").trim() || `gh exited ${r.status}`);
  return r.stdout;
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// The route the record and the head decide. A record is never routed to
// `timeline`: that is the whole of this function.
function routeOf(record, head) {
  if (record === null) return "timeline";
  return record === head ? "current" : "gate";
}

// The verdict the timeline events give, `events` as `{event, sha, label}` in
// timeline order, `label` the string the `ready-to-merge` role maps to.
function timelineVerdict(events, label) {
  let last = -1;
  events.forEach((e, i) => {
    if (e.event === "labeled" && e.label === label) last = i;
  });
  const after = events.slice(last + 1).filter((e) => MOVING.has(e.event)).map((e) => `${e.event} ${e.sha ?? ""}`.trimEnd());
  return { label, verdict: after.length > 0 ? "moved" : "clean", after };
}

const out = gh("read-pr", ["pr", "view", String(pr), "--json", "comments,headRefOid"]);
let view;
try {
  view = JSON.parse(out);
} catch {
  fail("read-pr", `gh printed no JSON: ${out.slice(0, 200)}`);
}
if (
  !isObject(view) ||
  !/^[0-9a-f]{40}$/.test(view.headRefOid) ||
  !Array.isArray(view.comments) ||
  !view.comments.every((c) => isObject(c) && typeof c.body === "string" && typeof c.createdAt === "string")
) {
  fail("read-pr", `gh printed an unexpected shape: ${out.slice(0, 200)}`);
}

const record = newestHeadRecord(view.comments);
const head = view.headRefOid;
const route = routeOf(record, head);
receipt.record = record;
receipt.head = head;
if (route !== "timeline") finish(0, { route });

let label;
try {
  label = readLabelMap({ cwd: resolve(repo ?? ".") })["ready-to-merge"];
} catch (e) {
  fail("label-map", e.message);
}
// `-q` runs per page, so a paginated timeline answers one JSON value per
// line however many pages it took.
const lines = gh("read-timeline", [
  "api",
  `repos/{owner}/{repo}/issues/${pr}/timeline?per_page=100`,
  "--paginate",
  "-q",
  '.[] | select(.event == "labeled" or .event == "committed" or .event == "head_ref_force_pushed") | {event, sha, label: .label.name} | tojson',
]);
let events;
try {
  events = lines.split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
} catch {
  fail("read-timeline", `gh printed no JSON: ${lines.slice(0, 200)}`);
}
finish(0, { route, timeline: timelineVerdict(events, label) });
