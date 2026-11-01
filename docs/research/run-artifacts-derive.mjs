#!/usr/bin/env node
// run-artifacts-derive.mjs — measure what a fleet-ctl run leaves on disk.
//
//   node run-artifacts-derive.mjs [--fleet <.fleet dir>] [--home-fleet <~/.fleet dir>]
//                                 [--sessions <harness session dir>] [--json]
//                                 [--merged-json <gh pr list -s merged -L 3000 --json number,mergedAt>]
//                                 [--tier <committed tier-outcomes.tsv>] [--working-tier <working-tree copy>]
//
// With --merged-json and --tier it also prints, per rotated ledger archive,
// the merged implementer PRs (`impl-<N>=PR#<M>` on a `## Rows` line) that have
// no row in the committed tier-outcomes.tsv, and whether a close-out receipt
// exists for that archive's stamp. It opens each `ledger.<stamp>.md` for that
// token only. With --working-tier it counts the data rows the working-tree
// file holds that the committed one does not.
//
// READ-ONLY. It lstat()s and readdir()s; the only file contents it opens are
// the `.fleet/phase0*.json` receipts (from them only the `session` field, a
// path), and — only with --merged-json and --tier — the rotated ledgers, for
// the `impl-<N>=PR#<M>` tokens, and the two TSVs named. It never opens a
// harness transcript, a brief, a log or a scratch file.
// Sizes are APPARENT bytes (st_size) and ALLOCATED bytes (st_blocks * 512, what
// `du` reports); a symlink is counted as the link, never followed.
//
// Zero deps: node builtins only.

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const argv = process.argv.slice(2);
const flag = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i === -1 ? dflt : argv[i + 1]; };
const FLEET = flag("fleet", join(process.cwd(), ".fleet"));
const HOME_FLEET = flag("home-fleet", join(homedir(), ".fleet"));
const SESSIONS = flag("sessions", join(homedir(), ".omp", "agent", "sessions", "-dev-fleet-plugin"));
const JSON_OUT = argv.includes("--json");
const MERGED_JSON = flag("merged-json", null);
const TIER = flag("tier", null);
const WORKING_TIER = flag("working-tier", null);

// ---- measuring -------------------------------------------------------------

/** {files, dirs, apparent, allocated} for a path, recursively, not following links. */
function measure(path) {
  const t = { files: 0, dirs: 0, apparent: 0, allocated: 0 };
  const walk = (p) => {
    let st;
    try { st = lstatSync(p); } catch { return; }
    t.apparent += st.size;
    t.allocated += st.blocks * 512;
    if (st.isDirectory()) {
      t.dirs += 1;
      let names;
      try { names = readdirSync(p); } catch { return; }
      for (const n of names) walk(join(p, n));
    } else t.files += 1;
  };
  walk(path);
  return t;
}

const add = (a, b) => { for (const k of ["files", "dirs", "apparent", "allocated"]) a[k] += b[k]; return a; };
const zero = () => ({ n: 0, files: 0, dirs: 0, apparent: 0, allocated: 0 });
const kib = (b) => `${Math.round(b / 1024).toLocaleString("en-US")} KiB`;
const human = (b) => (b >= 2 ** 30 ? `${(b / 2 ** 30).toFixed(2)} GiB` : b >= 2 ** 20 ? `${(b / 2 ** 20).toFixed(1)} MiB` : `${(b / 1024).toFixed(1)} KiB`);

/** Group the direct children of `dir` by the first matching rule; `ls` entries only. */
function byKind(dir, rules) {
  const kinds = new Map(rules.map(([name]) => [name, zero()]));
  const other = new Map();
  let names = [];
  try { names = readdirSync(dir); } catch { return { kinds, other }; }
  for (const name of names) {
    const rule = rules.find(([, re]) => re.test(name));
    const m = measure(join(dir, name));
    const into = rule ? kinds.get(rule[0]) : (other.has(name) ? other.get(name) : other.set(name, zero()).get(name));
    into.n += 1;
    add(into, { files: m.files, dirs: m.dirs, apparent: m.apparent, allocated: m.allocated });
  }
  return { kinds, other };
}

// ---- classification of this checkout's `.fleet/` --------------------------------

const FLEET_RULES = [
  ["ledger.md (live)", /^ledger\.md$/],
  ["ledger.<stamp>.md (rotated archive)", /^ledger\.\d{4}-\d{2}-\d{2}T\d{6}Z\.md$/],
  ["ledger.<date>-<run|prev>.md (pre-stamp archive, Aug-Sep)", /^ledger\.\d{4}-\d{2}-\d{2}-[^.]+\.md$/],
  ["ledger.prev-run.md", /^ledger\.prev-run\.md$/],
  ["phase0.json (live receipt)", /^phase0\.json$/],
  ["phase0.<stamp>.json (rotated receipt)", /^phase0\.\d{4}-\d{2}-\d{2}T\d{6}Z\.json$/],
  ["phase0.*crash*/precrash (hand-named)", /^phase0\..*(crash|precrash).*\.json$/],
  ["closeout.<stamp>.json (rotated receipt)", /^closeout\.\d{4}-\d{2}-\d{2}T\d{6}Z\.json$/],
  ["briefs/ (live)", /^briefs$/],
  ["briefs.<stamp>/ (rotated)", /^briefs\.\d{4}-\d{2}-\d{2}T\d{6}Z$/],
  ["heartbeat.json", /^heartbeat\.json$/],
  ["cost-guard.json", /^cost-guard\.json$/],
  ["router-preview.json", /^router-preview\.json$/],
  ["ticket-features.pending.tsv", /^ticket-features\.pending\.tsv$/],
  ["shortlist.json", /^shortlist\.json$/],
  ["recipe.json", /^recipe\.json$/],
  ["preflight.json", /^preflight\.json$/],
  ["labels.json", /^labels\.json$/],
  ["board.json / board.html", /^board\.(json|html)$/],
  ["instruments.sha*", /^instruments\.sha/],
  ["main-checkout.sha", /^main-checkout\.sha$/],
  ["merge-bot-*/ (pre-scratch-root layout)", /^merge-bot-/],
  ["pr<N>/ (pre-scratch-root layout)", /^pr\d+$/],
  ["pr<N>-findings.* (hand-saved, Aug)", /^pr\d+-findings/],
  ["scratch/ (empty)", /^scratch$/],
  ["caps.txt, batch.json (no writer under plugin/ or a one-off)", /^(caps\.txt|batch\.json)$/],
];

// ---- classification of `~/.fleet/` and the keyed scratch root ---------------------

const SCRATCH_RULES = [
  ["pr<N>/ (review run roots, fix clones, merge-bot scratch)", /^pr\d+$/],
  ["pr<N>-*.{md,log} loose", /^pr\d+-/],
  ["impl-<N>/ (implementer partitions)", /^impl-\d+$/],
  ["merge-bot-<n>/", /^merge-bot-\d+$/],
  ["reports/ (member report files)", /^reports$/],
  ["logs/", /^logs$/],
  ["pr/ (unnumbered)", /^pr$/],
  ["dispositions-fix-pr-*.json", /^dispositions-/],
  ["issue<N>.{md,txt}", /^issue\d+\./],
  ["batch-*.json", /^batch-/],
  ["review-<N>.json loose (reviewer output copies)", /^review-\d+\.json$/],
  ["fix*-<N>.* loose (fix-applier working files)", /^fix\d*-/],
  ["brief*-3050.md / raf-folded (hand-folded briefs)", /^(brief|raf)/],
  ["maingain-<N>/", /^maingain-/],
  ["*.log / *.txt / *.out / *.err loose", /\.(log|txt|out|err)$/],
];

// ---- sessions -----------------------------------------------------------------

/** One entry per `<stamp>_<uuid>` session: the root `.jsonl` plus the sibling directory. */
function sessions(dir) {
  const out = new Map();
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    const m = /^\.?(\d{4}-\d{2}-\d{2}T[\d-]+Z_[0-9a-f-]+)(\.jsonl(\.lock\.os)?)?$/.exec(name);
    if (!m) continue;
    const id = m[1];
    const s = out.get(id) ?? { id, rootJsonl: 0, rootLock: 0, dir: null, kinds: {} };
    out.set(id, s);
    const p = join(dir, name);
    if (name.endsWith(".jsonl.lock.os")) { s.rootLock += lstatSync(p).size; continue; }
    if (name.endsWith(".jsonl")) { s.rootJsonl = lstatSync(p).size; continue; }
    // the sibling directory: sub-agent transcripts, bash logs, agent outputs, locks
    const d = zero();
    const kinds = {};
    const walk = (q) => {
      let st;
      try { st = lstatSync(q); } catch { return; }
      if (st.isDirectory()) { let c = []; try { c = readdirSync(q); } catch { return; } for (const x of c) walk(join(q, x)); return; }
      d.files += 1; d.apparent += st.size; d.allocated += st.blocks * 512;
      const b = basename(q);
      const k = b.endsWith(".bash.log") ? "bash.log" : b.endsWith(".lock.os") ? "lock.os" : b.endsWith(".jsonl") ? "subagent .jsonl" : b.endsWith(".md") ? "agent .md" : b.endsWith(".tombstone") ? "tombstone" : (b.match(/\.([a-z]+)$/)?.[1] ?? "other");
      (kinds[k] ??= { files: 0, apparent: 0 });
      kinds[k].files += 1; kinds[k].apparent += st.size;
    };
    walk(p);
    s.dir = d; s.kinds = kinds;
  }
  return out;
}

// ---- run join: each phase-0 receipt names its controller's session ------------

function receipts() {
  const rows = [];
  let names = [];
  try { names = readdirSync(FLEET); } catch { return rows; }
  for (const name of names.filter((n) => /^phase0\..*\.json$|^phase0\.json$/.test(n)).sort()) {
    let session = null;
    try { session = JSON.parse(readFileSync(join(FLEET, name), "utf8")).session ?? null; } catch { /* unreadable: no session */ }
    rows.push({ receipt: name, session: session === null ? null : basename(session) });
  }
  return rows;
}

const stampOf = (receipt) => /^phase0\.(\d{4}-\d{2}-\d{2}T\d{6}Z)\.json$/.exec(receipt)?.[1] ?? null;
const exists = (p) => { try { lstatSync(p); return true; } catch { return false; } };

// ---- assemble ---------------------------------------------------------------------

const fleetKinds = byKind(FLEET, FLEET_RULES);
const fleetTotal = measure(FLEET);

const homeKinds = [];
let homeNames = [];
try { homeNames = readdirSync(HOME_FLEET); } catch { /* none */ }
for (const name of homeNames.sort()) homeKinds.push({ name, ...measure(join(HOME_FLEET, name)) });

const keyedRoots = [];
try {
  for (const name of readdirSync(join(HOME_FLEET, "scratch"))) {
    if (/-[0-9a-f]{8}$/.test(name)) keyedRoots.push(name);
  }
} catch { /* none */ }
const keyed = keyedRoots.map((name) => ({ name, total: measure(join(HOME_FLEET, "scratch", name)), ...byKind(join(HOME_FLEET, "scratch", name), SCRATCH_RULES) }));
const unkeyed = byKind(join(HOME_FLEET, "scratch"), [["keyed roots", /-[0-9a-f]{8}$/], ...SCRATCH_RULES]);

const sess = sessions(SESSIONS);
const sessTotal = measure(SESSIONS);
const rec = receipts();
const receiptsPerSession = new Map();
for (const r of rec) if (r.session) receiptsPerSession.set(r.session, (receiptsPerSession.get(r.session) ?? 0) + 1);
const runRows = rec.map((r) => {
  const s = r.session === null ? null : sess.get(r.session) ?? null;
  const stamp = stampOf(r.receipt);
  const sz = (name) => (exists(join(FLEET, name)) ? measure(join(FLEET, name)).apparent : null);
  return {
    receipt: r.receipt,
    stamp,
    session: r.session,
    sessionRootJsonl: s?.rootJsonl ?? null,
    sessionDirBytes: s?.dir?.apparent ?? null,
    sessionDirFiles: s?.dir?.files ?? null,
    sessionSubagentJsonl: s?.kinds?.["subagent .jsonl"]?.files ?? null,
    sessionBytes: s === null ? null : s.rootJsonl + (s.dir?.apparent ?? 0),
    briefsBytes: stamp === null ? null : sz(`briefs.${stamp}`),
    ledgerBytes: stamp === null ? null : sz(`ledger.${stamp}.md`),
    closeoutReceipt: stamp === null ? null : exists(join(FLEET, `closeout.${stamp}.json`)),
    receiptsInSession: r.session === null ? null : receiptsPerSession.get(r.session),
  };
});
const referenced = new Set(rec.map((r) => r.session).filter(Boolean));
const uniqueControllerBytes = [...referenced].reduce((a, id) => { const s = sess.get(id); return a + (s ? s.rootJsonl + (s.dir?.apparent ?? 0) : 0); }, 0);
const orphanSessions = [...sess.values()].filter((s) => !referenced.has(s.id));

const sessionKinds = {};
for (const s of sess.values()) for (const [k, v] of Object.entries(s.kinds)) {
  const into = (sessionKinds[k] ??= { files: 0, apparent: 0 });
  into.files += v.files; into.apparent += v.apparent;
}

// ---- Ruling coverage per rotated ledger archive -----------------------------------

function coverage() {
  if (MERGED_JSON === null || TIER === null) return null;
  const merged = new Map(JSON.parse(readFileSync(MERGED_JSON, "utf8")).map((p) => [String(p.number), p.mergedAt]));
  const dataRows = (path) => readFileSync(path, "utf8").split("\n").filter((l) => l !== "" && !l.startsWith("#")).map((l) => l.split("\t"));
  const ruled = new Set(dataRows(TIER).map((r) => r[1]));
  const rows = [];
  const allMerged = new Set();
  const allUnruled = new Set();
  for (const name of readdirSync(FLEET).filter((n) => /^ledger\.\d{4}-\d{2}-\d{2}T\d{6}Z\.md$/.test(n)).sort()) {
    const stamp = name.slice("ledger.".length, -".md".length);
    const text = readFileSync(join(FLEET, name), "utf8").split("## Dispatched")[0];
    const impl = new Set([...text.matchAll(/impl-\d+=PR#(\d+)/g)].map((m) => m[1]));
    const mergedPrs = [...impl].filter((p) => merged.has(p));
    const unruled = mergedPrs.filter((p) => !ruled.has(p));
    for (const p of mergedPrs) allMerged.add(p);
    for (const p of unruled) allUnruled.add(p);
    const dates = unruled.map((p) => merged.get(p)).sort();
    rows.push({
      stamp, ledgerRows: (text.match(/^- #/gm) ?? []).length, implPrs: impl.size, merged: mergedPrs.length, unruled: unruled.length,
      unruledMergedRange: dates.length ? `${dates[0].slice(0, 10)}..${dates[dates.length - 1].slice(0, 10)}` : "",
      phase0Receipt: exists(join(FLEET, `phase0.${stamp}.json`)), closeoutReceipt: exists(join(FLEET, `closeout.${stamp}.json`)),
    });
  }
  let uncommitted = null;
  if (WORKING_TIER !== null) {
    const committed = new Set(readFileSync(TIER, "utf8").split("\n"));
    uncommitted = readFileSync(WORKING_TIER, "utf8").split("\n").filter((l) => l !== "" && !l.startsWith("#") && !committed.has(l)).length;
  }
  return { rows, distinctMerged: allMerged.size, distinctUnruled: allUnruled.size, workingTreeRowsNotCommitted: uncommitted };
}
const cov = coverage();

const result = {
  fleet: { dir: FLEET, total: fleetTotal, kinds: Object.fromEntries([...fleetKinds.kinds]), other: Object.fromEntries([...fleetKinds.other]) },
  homeFleet: { dir: HOME_FLEET, children: homeKinds },
  keyedScratch: keyed.map((k) => ({ name: k.name, total: k.total, kinds: Object.fromEntries([...k.kinds]), other: Object.fromEntries([...k.other]) })),
  scratchParentLoose: { kinds: Object.fromEntries([...unkeyed.kinds]), other: Object.fromEntries([...unkeyed.other]) },
  sessions: {
    dir: SESSIONS,
    total: sessTotal,
    sessionCount: sess.size,
    sessionsWithDir: [...sess.values()].filter((s) => s.dir !== null).length,
    kinds: sessionKinds,
    referencedByAReceipt: referenced.size,
    controllerSessionBytes: uniqueControllerBytes,
    notReferenced: orphanSessions.length,
    notReferencedBytes: orphanSessions.reduce((a, s) => a + s.rootJsonl + (s.dir?.apparent ?? 0), 0),
  },
  runs: runRows,
  coverage: cov,
};

if (JSON_OUT) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

// ---- markdown ---------------------------------------------------------------------

const row = (...c) => `| ${c.join(" | ")} |`;
const out = [];
out.push(`## \`.fleet/\` (${FLEET}) — ${fleetTotal.files} files, ${human(fleetTotal.apparent)} apparent, ${human(fleetTotal.allocated)} allocated`, "");
out.push(row("kind", "entries", "files", "apparent", "allocated"), row("---", "---:", "---:", "---:", "---:"));
for (const [name, v] of fleetKinds.kinds) if (v.n > 0) out.push(row(name, v.n, v.files, kib(v.apparent), kib(v.allocated)));
for (const [name, v] of fleetKinds.other) out.push(row(`UNCLASSIFIED ${name}`, v.n, v.files, kib(v.apparent), kib(v.allocated)));
out.push("", `## \`~/.fleet/\` children`, "", row("child", "files", "apparent", "allocated"), row("---", "---:", "---:", "---:"));
for (const c of homeKinds) out.push(row(c.name, c.files, human(c.apparent), human(c.allocated)));
for (const k of keyed) {
  out.push("", `## keyed scratch root \`~/.fleet/scratch/${k.name}\` — ${k.total.files} files, ${human(k.total.apparent)} apparent, ${human(k.total.allocated)} allocated`, "");
  out.push(row("kind", "entries", "files", "apparent", "allocated"), row("---", "---:", "---:", "---:", "---:"));
  for (const [name, v] of k.kinds) if (v.n > 0) out.push(row(name, v.n, v.files, kib(v.apparent), kib(v.allocated)));
  for (const [name, v] of k.other) out.push(row(`UNCLASSIFIED ${name}`, v.n, v.files, kib(v.apparent), kib(v.allocated)));
}
out.push("", `## loose entries directly under \`~/.fleet/scratch/\` (no repo key)`, "", row("kind", "entries", "files", "apparent", "allocated"), row("---", "---:", "---:", "---:", "---:"));
for (const [name, v] of unkeyed.kinds) if (v.n > 0) out.push(row(name, v.n, v.files, kib(v.apparent), kib(v.allocated)));
for (const [name, v] of unkeyed.other) out.push(row(`UNCLASSIFIED ${name}`, v.n, v.files, kib(v.apparent), kib(v.allocated)));
out.push("", `## harness sessions (${SESSIONS}) — ${sess.size} sessions, ${sessTotal.files} files, ${human(sessTotal.apparent)} apparent, ${human(sessTotal.allocated)} allocated`, "");
out.push(row("file kind inside session dirs", "files", "apparent"), row("---", "---:", "---:"));
for (const [k, v] of Object.entries(sessionKinds).sort((a, b) => b[1].apparent - a[1].apparent)) out.push(row(k, v.files, human(v.apparent)));
out.push("", `Sessions named by a phase-0 receipt: ${referenced.size}; not named by one: ${orphanSessions.length} (${human(result.sessions.notReferencedBytes)}).`);
out.push("", `## per run (one phase-0 receipt each; session = the controller's)`, "");
out.push(row("receipt", "session root .jsonl", "session dir", "dir files", "sub-agent .jsonl", "session total", "receipts in this session", "briefs.<stamp>/", "ledger.<stamp>.md", "closeout receipt"), row("---", "---:", "---:", "---:", "---:", "---:", "---:", "---:", "---:", "---"));
const f = (b) => (b === null ? "—" : human(b));
for (const r of runRows) out.push(row(r.receipt, f(r.sessionRootJsonl), f(r.sessionDirBytes), r.sessionDirFiles ?? "—", r.sessionSubagentJsonl ?? "—", f(r.sessionBytes), r.receiptsInSession ?? "—", f(r.briefsBytes), f(r.ledgerBytes), r.closeoutReceipt === null ? "n/a (no stamp)" : r.closeoutReceipt ? "yes" : "NO"));
const sizes = runRows.map((r) => r.sessionBytes).filter((b) => b !== null).sort((a, b) => a - b);
out.push("", `Distinct controller sessions: ${referenced.size}, ${human(uniqueControllerBytes)} together (a session named by 2+ receipts is counted once here and once per receipt in the column above).`);
if (sizes.length) out.push("", `Session bytes per receipt row: min ${human(sizes[0])}, median ${human(sizes[Math.floor(sizes.length / 2)])}, max ${human(sizes[sizes.length - 1])}, sum ${human(sizes.reduce((a, b) => a + b, 0))} over ${sizes.length} rows (double-counts shared sessions).`);
if (cov !== null) {
  out.push("", `## Ruling coverage per rotated ledger archive (${cov.distinctMerged} distinct merged implementer PRs named; ${cov.distinctUnruled} have no row in ${TIER})`, "");
  out.push(row("ledger archive", "ledger rows", "impl PRs", "merged", "merged, no Ruling row", "their merge dates", "phase0 receipt", "close-out receipt"), row("---", "---:", "---:", "---:", "---:", "---", "---", "---"));
  for (const r of cov.rows) out.push(row(r.stamp, r.ledgerRows, r.implPrs, r.merged, r.unruled, r.unruledMergedRange || "—", r.phase0Receipt ? "yes" : "NO", r.closeoutReceipt ? "yes" : "NO"));
  if (cov.workingTreeRowsNotCommitted !== null) out.push("", `Data rows in ${WORKING_TIER} that ${TIER} does not hold: ${cov.workingTreeRowsNotCommitted}.`);
}
console.log(out.join("\n"));
