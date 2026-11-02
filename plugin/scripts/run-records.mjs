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
// `phase0.<stamp>.json` and `closeout.<stamp>.json`. The phase-0 receipt is
// committed with its `recipe` step's output withheld: that output is the
// Recipe's command lines, and a command can carry an environment assignment,
// a secret among them. A phase-0 archive that cannot be read as JSON cannot be
// withheld from, so it is not committed. `plugin-version` is one line, the
// `pluginVersion` that run's phase-0 receipt recorded from the instruments
// pin; a receipt that records none gets no file. `<run>` is the review's run
// root (`run-` and eight characters), `<scratch>/pr<pr>/<run>/`, and a Charges
// file goes into the run its own `run` field names.
//
// isRunRecord() is the allowlist: the commit step stages only paths it
// accepts, as isPlainFile() files, finisher-scope.mjs classifies only those as
// data beside the metrics TSVs, and main-checkout.mjs leaves the plain files
// among them out of its snapshot as the run's own bookkeeping. A file of any
// other name under those directories — a recipe, a transcript, a brief — is
// never staged. reviewTargets() is the one mapping from a scratch entry to the
// paths its evidence is committed under: gather() copies along it, and
// reclaim-scratch.mjs keeps a merged PR's evidence until origin/main holds
// every one of them.
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
const RUN_DIR = new RegExp(`^${RUNS_DIR}/(${STAMP})/`);
const REVIEW_RECORD = new RegExp(`^${REVIEWS_DIR}/([1-9][0-9]*)/run-[A-Za-z0-9]{8}/(?:review\\.json|dispositions-fix-pr-\\1(?:-[a-z])?\\.json)$`);
// The archives `ledger.mjs rotate` leaves beside the ledger, by stamp, and the
// name each takes under docs/metrics/runs/<stamp>/.
const ARCHIVE = new RegExp(`^(?:ledger\\.(${STAMP})\\.md|phase0\\.(${STAMP})\\.json|closeout\\.(${STAMP})\\.json)$`);
const PR_ENTRY = /^pr([1-9][0-9]*)$/;
const DISPOSITIONS_ENTRY = /^dispositions-fix-pr-([1-9][0-9]*)(?:-[a-z])?\.json$/;

/** Whether `path` (repository-relative, `/`-separated) is a run record or review evidence file the Close-out PR may commit. */
export const isRunRecord = (path) => RUN_RECORD.test(path) || REVIEW_RECORD.test(path);

// The lstat of `path` when it is a regular file — never a symlink's target —
// else null; an absent path is null, any other failure throws.
const fileStat = (path) => {
  try {
    const st = lstatSync(path);
    return st.isFile() ? st : null;
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
};

const isFile = (path) => fileStat(path) !== null;

/** Whether `path` is a regular file with no executable bit: the only kind of run record a commit carries. */
export const isPlainFile = (path) => {
  const st = fileStat(path);
  return st !== null && (st.mode & 0o111) === 0;
};

/** What the committed phase-0 receipt holds in place of its `recipe` step's output. */
export const RECIPE_WITHHELD = "withheld: the Recipe's command lines can carry environment assignments";

/**
 * The run records `fleetDir` holds: `{copies: [{from, to}], writes: [{to,
 * text}], notes}`, `to` repository-relative. A phase-0 archive is written with
 * its `recipe` step's output withheld, and one that cannot be read as JSON is
 * left out, with a note. Throws when `fleetDir` cannot be listed or a phase-0
 * archive cannot be read.
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
    if (file !== "phase0.json") {
      copies.push({ from, to: `${dir}/${file}` });
      continue;
    }
    const text = readFileSync(from, "utf8");
    let receipt;
    try {
      receipt = JSON.parse(text);
    } catch {
      // Not the parser's message: it can quote the receipt's own bytes.
      notes.push(`${from} not committed: it is not JSON, so its recipe step cannot be withheld`);
      continue;
    }
    const recipe = receipt?.steps?.recipe;
    if (recipe !== null && typeof recipe === "object" && "output" in recipe) recipe.output = RECIPE_WITHHELD;
    writes.push({ to: `${dir}/phase0.json`, text: `${JSON.stringify(receipt, null, 2)}\n` });
    const version = receipt?.pluginVersion;
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
 * there is replaced rather than written through. The lines it returns say
 * what was gathered; it throws on a directory it cannot list or a file it
 * cannot copy.
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
  return [
    `${runs.copies.length + runs.writes.length} run record file(s) from ${fleetDir}`,
    `${reviews.copies.length} review evidence file(s) from ${scratch}`,
    ...runs.notes,
    ...reviews.notes,
  ];
}

/**
 * The run records among `paths` whose run left no close-out receipt
 * (`closeout.<stamp>.json`) in `fleetDir`. A run that closed out leaves its
 * records to the next run's close-out; phase 0's catch-up commits for the
 * others.
 */
export function unclosedRecords(fleetDir, paths) {
  return paths.filter((path) => {
    const m = RUN_DIR.exec(path);
    return m !== null && !isFile(join(fleetDir, `closeout.${m[1]}.json`));
  });
}

/** The output line naming a path recordChanges() refused. */
export const refusedLine = (path) => `not staged, not a run record isRunRecord() allows: ${path}`;

/**
 * What the commit may stage under RECORD_DIRS in the checkout at `cwd`, which
 * `git` runs in: `{allowed, refused}`, each a list of repository-relative
 * paths, or `{error}`. The candidates are what `git ls-files --others
 * --modified --exclude-standard` lists there, and what the index already
 * holds staged there, as a commit that failed after its `git add` leaves it.
 * Only a regular file isRunRecord() accepts, with no executable bit, is
 * allowed; anything else — another name, a symlink, an executable, a
 * deletion — is refused, so a commit never carries it.
 */
export function recordChanges(git, cwd) {
  const paths = [];
  for (const args of [["ls-files", "-z", "--others", "--modified", "--exclude-standard"], ["diff", "--cached", "--name-only", "--no-renames", "-z"]]) {
    const r = git([...args, "--", ...RECORD_DIRS]);
    if (r.status !== 0) return { error: `git ${args[0]} -- ${RECORD_DIRS.join(" ")} failed: ${[r.stdout, r.stderr].filter(Boolean).join("\n") || r.how}` };
    paths.push(...r.stdout.split("\0").filter(Boolean));
  }
  const allowed = [];
  const refused = [];
  for (const path of new Set(paths)) {
    (isRunRecord(path) && isPlainFile(join(cwd, path)) ? allowed : refused).push(path);
  }
  return { allowed, refused };
}
