// A run's records and each reviewed PR's review evidence, as files the
// Close-out PR commits under docs/metrics/ — the one place that names them.
//
//   docs/metrics/runs/<stamp>/ledger.md, phase0.json, closeout.json,
//                             plugin-version
//   docs/metrics/reviews/<pr>/<run>/review.json,
//                                   dispositions-fix-pr-<pr>[-x].json
//
// `<stamp>` is the ledger archive's own (`ledger.<stamp>.md`, archiveStamp()
// in ledger-grammar.mjs), and the three files under it are the archives
// `ledger.mjs rotate` leaves beside the ledger: `ledger.<stamp>.md`,
// `phase0.<stamp>.json` and `closeout.<stamp>.json`. `plugin-version` is one
// line, the `pluginVersion` that run's phase-0 receipt recorded from the
// instruments pin; a receipt that records none gets no file. `<run>` is the
// review's run root (`run-` and eight characters), `<scratch>/pr<pr>/<run>/`,
// and a Charges file goes into the run its own `run` field names.
//
// isRunRecord() is the allowlist: the commit step stages only paths it
// accepts, finisher-scope.mjs classifies only those as data beside the
// metrics TSVs, and main-checkout.mjs leaves them out of its snapshot as the
// run's own bookkeeping. A file of any other name under those directories —
// a recipe, a transcript, a brief — is never staged. reviewTargets() is the
// one mapping from a scratch entry to the paths its evidence is committed
// under: gather() copies along it, and reclaim-scratch.mjs keeps a merged
// PR's evidence until origin/main holds every one of them.
//
// Zero deps: node builtins and sibling scripts only.

import { chmodSync, copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const RUNS_DIR = "docs/metrics/runs";
export const REVIEWS_DIR = "docs/metrics/reviews";
export const RECORD_DIRS = Object.freeze([RUNS_DIR, REVIEWS_DIR]);
export const PLUGIN_VERSION = "plugin-version";

const STAMP = "[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}Z";
const RUN_ROOT = /^run-[A-Za-z0-9]{8}$/;
const RUN_RECORD = new RegExp(`^${RUNS_DIR}/${STAMP}/(?:ledger\\.md|phase0\\.json|closeout\\.json|${PLUGIN_VERSION})$`);
const REVIEW_RECORD = new RegExp(`^${REVIEWS_DIR}/([1-9][0-9]*)/run-[A-Za-z0-9]{8}/(?:review\\.json|dispositions-fix-pr-\\1(?:-[a-z])?\\.json)$`);
// The archives `ledger.mjs rotate` leaves beside the ledger, by stamp, and the
// name each takes under docs/metrics/runs/<stamp>/.
const ARCHIVE = new RegExp(`^(?:ledger\\.(${STAMP})\\.md|phase0\\.(${STAMP})\\.json|closeout\\.(${STAMP})\\.json)$`);
const PR_ENTRY = /^pr([1-9][0-9]*)$/;
const DISPOSITIONS_ENTRY = /^dispositions-fix-pr-([1-9][0-9]*)(?:-[a-z])?\.json$/;

/** Whether `path` (repository-relative, `/`-separated) is a run record or review evidence file the Close-out PR may commit. */
export const isRunRecord = (path) => RUN_RECORD.test(path) || REVIEW_RECORD.test(path);

const isFile = (path) => {
  try {
    return lstatSync(path).isFile();
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
};

const isPlainFile = (path) => {
  try {
    const st = lstatSync(path);
    return st.isFile() && (st.mode & 0o111) === 0;
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
};

/**
 * The run records `fleetDir` holds: `{copies: [{from, to}], writes: [{to,
 * text}], notes}`, `to` repository-relative. A phase-0 archive that cannot be
 * read as JSON is still copied, and a note says it gave no plugin version.
 * Throws when `fleetDir` cannot be listed.
 */
export function runArchives(fleetDir) {
  const copies = [];
  const writes = [];
  const notes = [];
  for (const name of readdirSync(fleetDir).sort()) {
    const m = ARCHIVE.exec(name);
    if (m === null) continue;
    const from = join(fleetDir, name);
    if (!isFile(from)) continue;
    const [stamp, file] = m[1] ? [m[1], "ledger.md"] : m[2] ? [m[2], "phase0.json"] : [m[3], "closeout.json"];
    const dir = `${RUNS_DIR}/${stamp}`;
    copies.push({ from, to: `${dir}/${file}` });
    if (file !== "phase0.json") continue;
    let version;
    try {
      version = JSON.parse(readFileSync(from, "utf8")).pluginVersion;
    } catch (e) {
      notes.push(`${from} gives no plugin version: ${e.message}`);
      continue;
    }
    if (typeof version === "string" && /^[^\s]+$/.test(version)) writes.push({ to: `${dir}/${PLUGIN_VERSION}`, text: `${version}\n` });
  }
  return { copies, writes, notes };
}

/**
 * The paths a scratch entry's review evidence is committed under, as
 * `{targets: [{from, to}], notes}`. `pr<M>/` gives each `<run>/review.json`
 * under it; `dispositions-fix-pr-<M>[-x].json` gives itself, in the run its
 * `run` field names, or a note when it names none. Any other entry gives
 * nothing. Throws when the entry cannot be read.
 */
export function reviewTargets(path, name) {
  const pr = PR_ENTRY.exec(name);
  if (pr !== null) {
    let runs;
    try {
      runs = readdirSync(path, { withFileTypes: true });
    } catch (e) {
      if (e.code === "ENOTDIR") return { targets: [], notes: [] };
      throw e;
    }
    const targets = runs
      .filter((d) => d.isDirectory() && RUN_ROOT.test(d.name) && isFile(join(path, d.name, "review.json")))
      .map((d) => ({ from: join(path, d.name, "review.json"), to: `${REVIEWS_DIR}/${pr[1]}/${d.name}/review.json` }))
      .sort((a, b) => (a.to < b.to ? -1 : 1));
    return { targets, notes: [] };
  }
  const d = DISPOSITIONS_ENTRY.exec(name);
  if (d === null || !isFile(path)) return { targets: [], notes: [] };
  let run;
  try {
    run = JSON.parse(readFileSync(path, "utf8")).run;
  } catch (e) {
    return { targets: [], notes: [`${path} names no review run: ${e.message}`] };
  }
  if (typeof run !== "string" || !RUN_ROOT.test(run)) return { targets: [], notes: [`${path} names no review run: run is ${JSON.stringify(run ?? null)}`] };
  return { targets: [{ from: path, to: `${REVIEWS_DIR}/${d[1]}/${run}/${name}` }], notes: [] };
}

/**
 * Every review evidence file under `scratch`, as reviewTargets() maps it.
 * An absent scratch root holds none; one that cannot be listed throws.
 */
export function reviewEvidence(scratch) {
  let names;
  try {
    names = readdirSync(scratch).sort();
  } catch (e) {
    if (e.code === "ENOENT") return { copies: [], notes: [] };
    throw e;
  }
  const copies = [];
  const notes = [];
  for (const name of names) {
    const found = reviewTargets(join(scratch, name), name);
    copies.push(...found.targets);
    notes.push(...found.notes);
  }
  return { copies, notes };
}

/**
 * Copies every run archive in `fleetDir` and every review evidence file under
 * `scratch` into the checkout at `cwd`, plain mode 0644, replacing what is
 * there: a file already committed comes back byte for byte, so git sees only
 * what is new. What stood at a destination is removed first, so a symlink
 * there is replaced rather than written through. `{lines}` says what was
 * gathered; it throws on a directory it cannot list or a file it cannot copy.
 */
export function gather({ cwd, fleetDir, scratch }) {
  const runs = runArchives(fleetDir);
  const reviews = reviewEvidence(scratch);
  const place = (to) => {
    const abs = join(cwd, to);
    mkdirSync(dirname(abs), { recursive: true });
    rmSync(abs, { force: true });
    return abs;
  };
  for (const { from, to } of [...runs.copies, ...reviews.copies]) {
    const abs = place(to);
    copyFileSync(from, abs);
    chmodSync(abs, 0o644);
  }
  for (const { to, text } of runs.writes) {
    const abs = place(to);
    writeFileSync(abs, text);
    chmodSync(abs, 0o644);
  }
  return {
    lines: [
      `${runs.copies.length + runs.writes.length} run record file(s) from ${fleetDir}`,
      `${reviews.copies.length} review evidence file(s) from ${scratch}`,
      ...runs.notes,
      ...reviews.notes,
    ],
  };
}

/**
 * What the commit may stage under RECORD_DIRS in the checkout at `cwd`, which
 * `git` runs in: `{allowed, refused}`, each a list of repository-relative
 * paths, or `{error}`. The candidates are what `git ls-files --others
 * --modified --exclude-standard` lists there. Only a regular file
 * isRunRecord() accepts, with no executable bit, is allowed; anything else —
 * another name, a symlink, an executable, a deletion — is refused, so a
 * commit never carries it.
 */
export function recordChanges(git, cwd) {
  const r = git(["ls-files", "-z", "--others", "--modified", "--exclude-standard", "--", ...RECORD_DIRS]);
  if (r.status !== 0) return { error: `git ls-files -- ${RECORD_DIRS.join(" ")} failed: ${[r.stdout, r.stderr].filter(Boolean).join("\n") || r.how}` };
  const allowed = [];
  const refused = [];
  for (const path of new Set(r.stdout.split("\0").filter(Boolean))) {
    (isRunRecord(path) && isPlainFile(join(cwd, path)) ? allowed : refused).push(path);
  }
  return { allowed, refused };
}
