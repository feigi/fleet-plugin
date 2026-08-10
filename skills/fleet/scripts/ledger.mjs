#!/usr/bin/env node
// The run ledger. A controller's context is the least durable thing in a fleet
// run: it compacts, and a controller that has lost the pool or the dispatch map
// redoes finished work. Two duplicate tickets shipped in one run from exactly
// that.
//
// Rows are rewritten in place, one per ticket. `filed` and `ruled` are
// append-only, because their whole purpose is to outlive the reasoning that
// produced them.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";

const NAME = "ledger";

function die(msg) {
  console.error(`${NAME}: ${msg}`);
  process.exit(2);
}

// There is ONE ledger per run, and it lives in the main checkout. Members run
// from their own worktrees, where a cwd-relative `.fleet/ledger.md` does not
// exist — `check` then warns and reports every subject as safe to file, which
// is precisely the duplicate-filing guard failing open. Resolve against the
// git COMMON dir (shared by every worktree) rather than the cwd.
function defaultLedgerPath() {
  const r = spawnSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout.trim()) {
    // Could not resolve the shared git dir → fall back to a cwd-relative path.
    // That re-opens the worktree fail-open this resolution exists to close (a
    // member reads a cwd-local ledger, not the run's), so say so rather than
    // degrading the duplicate-filing guard in silence.
    console.error(`${NAME}: WARNING could not resolve --git-common-dir; using cwd-relative .fleet/ledger.md (duplicate-filing guard may be degraded)`);
    return ".fleet/ledger.md";
  }
  return join(dirname(resolve(r.stdout.trim())), ".fleet", "ledger.md");
}

const argv = process.argv.slice(2);
const fileIdx = argv.indexOf("--file");
const file = fileIdx === -1 ? defaultLedgerPath() : argv[fileIdx + 1];
if (fileIdx !== -1) argv.splice(fileIdx, 2);
if (!file) die("--file given with no path");
const requireFileIdx = argv.indexOf("--require-file");
const requireFile = requireFileIdx !== -1;
if (requireFileIdx !== -1) argv.splice(requireFileIdx, 1);

const [cmd, ...rest] = argv;
if (!cmd) die("usage: ledger.mjs [--file <path>] [--require-file] row|filed|ruled|check|read [args]");

const ROWS = "## Rows";
const FILED = "## Filed";
const RULED = "## Ruled";

// One entry is always exactly one physical line on disk. Escape backslash
// first, then newline, so a `\` in entry text can never be mistaken for the
// start of an escape sequence introduced by this encoding. Without this, an
// entry containing a real newline — or a line that happens to look like
// `## Filed` or `- #999 ...` — gets misparsed on reload: real records
// silently drop, or phantom ones get injected.
function escapeText(s) {
  return s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}
function unescapeText(s) {
  return s.replace(/\\(\\|n)/g, (_, c) => (c === "n" ? "\n" : "\\"));
}

function load() {
  if (!existsSync(file)) return { rows: [], filed: [], ruled: [] };
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    die(`cannot read ${file}: ${e.message}`);
  }
  const section = (name) => {
    // Anchored to a real line start (or string start), not a bare substring
    // search — otherwise an escaped entry that merely CONTAINS the text
    // "## Filed" (never a physical line, just a run of characters inside a
    // one-line entry) is found by indexOf() before the genuine header and
    // the whole section is sliced from the wrong offset.
    const headerRe = new RegExp(`(^|\\n)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\n|$)`);
    const m = headerRe.exec(text);
    if (!m) return [];
    const start = m.index + m[1].length + name.length;
    const after = text.slice(start);
    const end = after.search(/\n## /);
    return (end === -1 ? after : after.slice(0, end))
      .split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- "))
      .map((l) => unescapeText(l.slice(2)));
  };
  return { rows: section(ROWS), filed: section(FILED), ruled: section(RULED) };
}

function save(d) {
  const out =
    `# Fleet run ledger\n\n${ROWS}\n\n` + d.rows.map((r) => `- ${escapeText(r)}`).join("\n") +
    `\n\n${FILED}\n\n` + d.filed.map((r) => `- ${escapeText(r)}`).join("\n") +
    `\n\n${RULED}\n\n` + d.ruled.map((r) => `- ${escapeText(r)}`).join("\n") + "\n";
  try {
    mkdirSync(dirname(file), { recursive: true });
    // Write to a sibling temp file and rename over the target. rename is
    // atomic on a POSIX filesystem — a crash mid-write leaves the temp file
    // corrupt but never truncates the durability file itself.
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, out);
    renameSync(tmp, file);
  } catch (e) {
    die(`cannot write ${file}: ${e.message}`);
  }
  console.error(`    wrote ${file}`);
}

const data = load();

if (cmd === "read") {
  console.log(JSON.stringify(data));
  process.exit(0);
}

if (cmd === "row") {
  const [ticket, ...textParts] = rest;
  if (!ticket || textParts.length === 0) die("usage: ledger.mjs row <ticket> <text>");
  const key = ticket.startsWith("#") ? ticket : `#${ticket}`;
  const line = `${key} ${textParts.join(" ")}`;
  const i = data.rows.findIndex((r) => r.split(/\s/)[0] === key);
  const created = i === -1;
  if (created) {
    data.rows.push(line);
  } else {
    data.rows[i] = line;
  }
  // Logged only after save() returns — a failed write must not claim a row
  // was recorded when it never made it to disk.
  save(data);
  console.error(created ? `    new row ${key}` : `    rewrote row ${key}`);
  console.log(JSON.stringify({ ticket: key, line, created }));
  process.exit(0);
}

if (cmd === "filed") {
  const [issue, ...subjectParts] = rest;
  if (!issue || subjectParts.length === 0) die("usage: ledger.mjs filed <issue> <subject>");
  const subject = subjectParts.join(" ");
  data.filed.push(`#${issue.replace(/^#/, "")} ${subject}`);
  save(data);
  console.log(JSON.stringify({ issue, subject, total: data.filed.length }));
  process.exit(0);
}

if (cmd === "ruled") {
  const [pr, ...decisionParts] = rest;
  if (!pr || decisionParts.length === 0) die("usage: ledger.mjs ruled <pr> <decision>");
  const decision = decisionParts.join(" ");
  data.ruled.push(`#${pr.replace(/^#/, "")} ${decision}`);
  save(data);
  console.log(JSON.stringify({ pr, decision, total: data.ruled.length }));
  process.exit(0);
}

if (cmd === "check") {
  // The first check of a run legitimately has no file yet, so absence alone
  // cannot be an error — but a silent "safe to file" for every check when
  // the path is simply wrong (typo'd --file) is a fail-open that no caller
  // would notice. Warn loudly by default; --require-file makes absence a
  // hard failure for callers that know the file must already exist.
  if (!existsSync(file)) {
    if (requireFile) die(`--require-file given but ledger file does not exist: ${file}`);
    console.error(
      `${NAME}: WARNING — ledger file not found: ${file}. Every check will read "safe to file" until it exists.`,
    );
  }
  const subject = rest.join(" ");
  if (!subject) die("usage: ledger.mjs check <subject>");
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const tokenSet = (s) => new Set(norm(s).split(/\s+/).filter(Boolean));
  const target = tokenSet(subject);
  if (target.size === 0) die(`normalised subject is empty — '${subject}' has no alphanumeric tokens to check`);
  // Substring matching collides both ways: a short generic subject ("line")
  // matches everything (false "already filed" silently loses a finding),
  // while an all-punctuation subject normalises to "" and matches anything
  // too. Token-set matching fixes both, with a deliberate asymmetric bias —
  // a false "already filed" is invisible and bad, a false "not filed" just
  // creates a duplicate someone closes — so equal sets OR a >=4-token subset
  // both count as a match, catching real near-duplicate rewordings without
  // matching short generic overlaps.
  const isMatch = (filedTokens) => {
    if (filedTokens.size === target.size && [...filedTokens].every((t) => target.has(t))) return true;
    const [small, big] = filedTokens.size <= target.size ? [filedTokens, target] : [target, filedTokens];
    return small.size >= 4 && [...small].every((t) => big.has(t));
  };
  // Strip the leading `#NNN ` issue number: it is metadata, not part of the
  // finding's subject. Left in, it becomes a stray token the checked subject
  // never carries, so a filed row can never be a subset of a longer check
  // subject — the >=4-token rule silently never fires and duplicates get filed.
  const subjectOf = (filedRow) => filedRow.replace(/^#\d+\s+/, "");
  const match = data.filed.find((f) => isMatch(tokenSet(subjectOf(f))));
  if (match) {
    console.error(`${NAME}: ALREADY FILED — ${match}`);
    console.log(JSON.stringify({ subject, found: true, match, verdict: "already-filed" }));
    // Exit 1 means "do not file this again" — the strong signal. Exit 3 is also
    // non-zero but weaker: tracker rows to review, not a ruling. A caller that
    // checks only the exit status stops on both, which errs toward not
    // duplicating.
    process.exit(1);
  }

  // Near-miss reporting. The subset match above answers exactly one question —
  // "was this near-verbatim wording already filed" — and answers it well. It
  // says nothing about the same finding described in DIFFERENT words, which is
  // how a second discoverer actually words it: one measured run rediscovered
  // #114 five times, each in its own phrasing, and the check caught none of
  // them. Rank the filed list by token overlap and hand the top rows back with
  // a score, instead of collapsing all of that into `found: false`.
  //
  // Scored on its own token set, deliberately not the exact path's. Stopwords
  // and the singular fold only sharpen a ranking, but folding them into
  // isMatch() would widen what counts as ALREADY FILED — the one behaviour
  // here that callers gate on and that must not move.
  const STOP = new Set("the a an of to in is it its and or for on with that this from at by".split(" "));
  const scoreTokens = (s) =>
    new Set(
      norm(s).split(/\s+/)
        .filter((t) => t.length >= 3 && !STOP.has(t))
        .map((t) => t.replace(/s$/, "")),
    );
  // Overlap coefficient (shared / smaller set), not Jaccard. A filed row carries
  // a source tag like `(review-pr-108)` and other metadata the checked subject
  // can never contain, so the union is dominated by tokens with no chance of
  // matching: Jaccard drives every row to a similar small number and the
  // ranking stops discriminating. Dividing by the smaller set also keeps the
  // score indifferent to which side is more verbose.
  const overlap = (a, b) => {
    if (a.size === 0 || b.size === 0) return 0;
    let shared = 0;
    for (const t of a) if (b.has(t)) shared++;
    return shared / Math.min(a.size, b.size);
  };
  const round2 = (n) => Math.round(n * 100) / 100;
  const scored = scoreTokens(subject);
  // Floor is "shares at least one content word", not a score threshold: the
  // measured #114 rewording shares exactly one, and a threshold tuned to look
  // tidy would drop the very case this exists for. The top-3 cap, not the
  // floor, is what keeps the output short.
  const near = data.filed
    .map((row) => ({ row, score: round2(overlap(scored, scoreTokens(subjectOf(row)))) }))
    .filter((n) => n.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  // The ledger can only see what THIS run recorded. An issue that already
  // exists on the tracker but never reached this `filed` list — filed by an
  // earlier run, by the maintainer, by hand — is structurally invisible to
  // every match above, and that is the measured failure: #114 was rediscovered
  // five times in one run and `check` reported it safe to file every time. Ask
  // the tracker.
  //
  // gh ANDs the search terms, so every extra term can only narrow the result —
  // keep the query SHORT: three of the subject's most distinctive words.
  // Measured against the live tracker, "candidates opposite states" returns
  // #114. Whether a fourth term helps or hurts turns on whether it happens to
  // occur in the target issue's text — gh searches bodies, not just titles —
  // which the subject cannot know: "code" leaves #114 in, "open" drops it. So
  // three is a recall-preserving floor, not a measured optimum. Longest-first is a crude stand-in for distinctiveness (no
  // corpus to weigh terms against) and the >= 3 filter erases short but
  // distinctive identifiers like `CI` or `gh`; upgrade to a real frequency
  // weighting if the query starts missing.
  //
  // norm() has already stripped punctuation, which is also what keeps a subject
  // containing `is:open` or `file.mjs:164` from smuggling a qualifier into the
  // search and silently changing what was searched for.
  const terms = [...new Set(norm(subject).split(/\s+/).filter((t) => t.length >= 3 && !STOP.has(t)))]
    .sort((a, b) => b.length - a.length)
    .slice(0, 3);
  const query = terms.join(" ");
  let tracker;
  if (terms.length === 0) {
    // An empty --search matches every issue in the repo, which would report
    // every subject as a tracker hit. Not searching is the honest answer.
    // `hits` is omitted, not `[]` — the tracker was never read, so an empty
    // list here would be a claim of cleanliness this branch never earned
    // (issue #152: a consumer testing `.length` must not read this as clean).
    tracker = { ok: false, query: null, error: "subject has no distinctive terms to search for" };
  } else {
    try {
      const out = execFileSync(
        "gh",
        ["issue", "list", "--search", query, "--state", "all", "--limit", "5",
          "--json", "number,title,state,url"],
        { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"] },
      );
      // Parsing inside the try on purpose: gh can exit 0 and still print
      // something that is not the JSON asked for. A parse failure is a failed
      // tracker read, not a clean tracker.
      const parsed = JSON.parse(out);
      // Parseable is not the same as the shape asked for. Without this, a gh
      // printing a JSON array that is not an issue list escalates to exit 3 and
      // prints "TRACKER HIT — #undefined" — a confident hit blocking a filing
      // that is in fact unverified. Throw into the catch below: an unreadable
      // answer is a failed tracker read, exactly like unparseable output.
      if (!Array.isArray(parsed) || parsed.some((h) => !h || typeof h.number !== "number")) {
        throw new Error("gh returned JSON that is not an issue list");
      }
      const hits = parsed
        .map((h) => ({
          number: h.number, title: h.title || "", state: h.state, url: h.url,
          score: round2(overlap(scored, scoreTokens(h.title || ""))),
        }))
        .sort((a, b) => b.score - a.score);
      tracker = { ok: true, query, hits };
    } catch (e) {
      // Every gh failure lands here — no network, no auth, rate limit, gh not
      // installed (ENOENT), a timeout, unparseable output. None of them may
      // produce a bare "safe to file": that is the same fail-open class the
      // --git-common-dir resolution above already closed once. Degrade to the
      // ledger-only answer and say so.
      // Capped, and deliberately still carrying the stderr — the opposite call
      // from the fleet's other gh catches (#176). Those omit it because
      // execFileSync forwarded the child's bytes to our stderr already, so
      // interpolating emits them twice; this call sets `stdio`, which turns
      // that forwarding OFF, so this string is the only place the cause is
      // ever seen. What it must not be is unbounded: it lands in
      // `tracker.error`, which ships on stdout as part of a machine-parsed
      // contract, and a megabyte of gh stderr inside a JSON field is a payload
      // problem wherever the forwarding argument lands.
      // `hits` omitted here too, same reason as the no-terms branch above:
      // the search never ran, so there is no empty result to report.
      tracker = { ok: false, query, error: String(e.stderr || e.message).trim().slice(0, 500) };
    }
  }

  for (const n of near) console.error(`${NAME}: near-miss ${n.score.toFixed(2)} — ${n.row}`);
  // `tracker.hits` is absent on both failure arms now — only iterate when the
  // search actually ran.
  for (const h of tracker.hits ?? []) {
    console.error(`${NAME}: TRACKER HIT — #${h.number} (${h.state}) ${h.title} — ${h.url}`);
  }
  if (!tracker.ok) {
    console.error(`${NAME}: WARNING — TRACKER NOT CHECKED (${tracker.error}). An issue that exists on the tracker but was never recorded in this run is invisible to the answer below.`);
    console.error(`${NAME}: not previously filed in this run's ledger — ledger-only answer, tracker unchecked`);
  } else if (tracker.hits.length) {
    console.error(`${NAME}: not in this run's filed list, but ${tracker.hits.length} tracker issue(s) match '${query}' — review before filing`);
  } else {
    console.error(`${NAME}: not previously filed; tracker search '${query}' found no related issues`);
  }
  // Named explicitly so a consumer does not have to reconstruct it from
  // `tracker.ok` plus `tracker.hits` — issue #152. `!tracker.ok` short-circuits
  // before `tracker.hits` is read, which is required: hits is absent, not `[]`,
  // on that branch.
  const verdict = !tracker.ok ? "unverified" : tracker.hits.length ? "tracker-hit" : "clean";
  console.log(JSON.stringify({ subject, found: false, match: null, near, tracker, verdict }));
  // Exit 3 — a new code — for "the ledger is clean but the tracker is not".
  // 1 would mean ALREADY FILED in this run, which a tracker hit does not
  // establish; 2 is taken by die(). Near-misses stay exit 0: they are a ranked
  // suggestion, not a finding of duplication. Exit 0 covers two states —
  // "clean" and "unverified" — which `verdict` now names explicitly but the
  // exit code deliberately still does not: minting a code for unverified would
  // break `check "$s" && gh issue create` on every offline run (ruled against
  // in #152). A hit scoring 0.00 still forces 3: gh matched the issue body,
  // which the title-based score cannot see.
  process.exit(tracker.hits?.length ? 3 : 0);
}

die(`unknown subcommand '${cmd}' — expected row, filed, ruled, check or read`);
