#!/usr/bin/env node
// Bind a CI run to a PR's head and report whether it is genuinely green.
//
// Replaces the four-way run-binding check restated in three fleet documents.
// The failure it prevents: `gh pr checks` aggregates conclusions ACROSS runs and
// reports a `pass` inherited from a cancelled run on a superseded SHA. Head-SHA
// binding alone misses it, because the head is right and only the conclusions
// belong elsewhere.
//
// Nothing here is cached. A rerun rewrites a run in place, so a conclusion can
// invert under a fixed run id with nothing pushed. The only safe design is to
// re-query at the moment of decision, which is what this script is for.

import { execFileSync } from "node:child_process";
import { gitEnv } from "./git-env.mjs";
import { makeDie, defineFlags, writeAll } from "./arg.mjs";

const NAME = "ci-state";

// die()/arg()/numArg()/has() shared with the other fleet scripts — see
// arg.mjs for the fail-open and pipe-safety rationale.
// `base`/`workflow`/`workflow-file` below all fall back with `||`, so a
// trailing `--base` (nothing after it) used to read as omitted and silently
// compare against the DEFAULT base — `ci-state.mjs --pr 5 --base` gave a
// real, wrong verdict at exit 0/1 with no refusal, reached here because THIS
// is the verdict the fleet gates on. die() also has to survive --quiet,
// which is the mode the controller's CI Monitor polls in.
const die = makeDie(NAME);
const { arg, numArg, has, sweep, stray } = defineFlags(die, {
  flags: {
    pr: "value",
    base: "value",
    workflow: "value",
    "workflow-file": "value",
    "declare-no-ci": "bool",
    quiet: "bool",
  },
});

// `--quiet` suppresses the diagnostic stream (command echoes, per-job/per-field
// lines) and drops `jobs`, `missing` and `dropped` from the payload. The controller's CI
// Monitor (and, standalone, the reviewer's own watch loop) polls this hot, and
// none of that stream is acted on — `reasons` already names every failing job,
// and the exit code already encodes green/not-green. die() and the one-line
// verdict summary still print, so a caller loses nothing it decides on.
const quiet = has("quiet");
const vlog = (...a) => {
  if (!quiet) console.error(...a);
};

// A refusal from an exhausted REST quota reached the same arm as every
// other gh read failure, so a caller could not tell an outage that clears on
// its own from a repo or token that will still be unreadable after any wait.
// The cause is only ever in gh's own stderr, which execFileSync BOTH forwards
// to our fd 2 and captures on the thrown error (measured) — so it is matched
// here without being reprinted, for the reason run() gives below: interpolating
// it emits every byte twice.
//
// Matched on the quota wording rather than on the 403 status, because 403 also
// carries refusals no amount of waiting clears. One expression spans the
// spellings a quota is refused with: the primary limit, the secondary one, and
// the abuse-detection wording GitHub used for that same secondary limit before
// renaming it — which a GitHub Enterprise Server predating the rename still
// emits, and this script does reach GHE (the behind probe passes --hostname).
//
// `abuse detection` in full, never a bare `abuse`: "disabled for abuse of
// GitHub's terms of service" is a permanent refusal, and the short form
// relabels it a blip that clears itself (measured).
const RATE_LIMITED = /rate limit|abuse detection/i;

// The outage payload, on stdout at the unchanged exit 2 — where this arm
// printed nothing at all. A caller reading only the exit code is unaffected;
// one parsing stdout gets a named cause instead of the empty capture
// `merge-gate.mjs` reads as `ci-unreadable` there: a probe that could not
// look, never a reading about the PR.
//
// It reports the refused query and nothing else. A quota refusal is a probe
// that could not look, so every field this script would otherwise observe is
// ABSENT rather than null. A null is a reading, and nothing here was read.
//
// Absence is what a direct reader needs: `merge-gate.mjs` gates every merge
// on this payload's own fields — `verdict`, `behind`, `missing`, the per-job
// conclusions, and `prHead == runHeadSha` — and an absent `missing` refuses
// that gate where an empty array would have told it nothing was missing.
// board.mjs is not that reader — it takes exit 2 as a failed read whatever
// was printed on the way out, and carries its previous CI value for the PR
// forward instead.
//
// Every write this script makes on its way out goes through arg.mjs's
// writeAll(), for die()'s reason in that file: on a pipe, console.log and
// console.error hand the bytes to an ASYNC stream, and process.exit()
// discards whatever is still queued rather than draining it. The kernel takes
// one pipe buffer synchronously and the rest is dropped, so a payload past
// that size is cut mid-JSON while the exit code arrives intact — the caller
// reading the code sees a normal verdict and the caller parsing stdout gets
// bytes it cannot parse. writeSync goes straight to the fd, which is what
// survives process.exit(). It also takes no newline of its own, which is why
// every call site below embeds its own trailing newline in the string it passes to writeAll().
//
// This file used to carry its own copy of that write loop, called
// emit(), and the copy had DRIFTED — of the three hand-mirrored copies it was
// the only one that never grew the retry cap, so a reader that stayed open
// but never drained left it spinning forever. That is what a comment reading
// "mirrors emit()" buys and what shared code buys instead. The loop, its cap
// and its 1ms Atomics.wait are arg.mjs's now.
//
// What stays this file's own is the exit-code contract those writes protect,
// and it is why writeAll's false return is ignored at every call site here.
// Once the bytes are lost they are lost; this script reserves exit 1 for
// not-green and 2 for could-not-answer, so a verdict that failed to WRITE
// must not also take the process down a different exit path and turn a
// missing answer into a wrong one. Losing a green verdict's bytes is bad;
// reporting green as not-green because the write failed is worse, and that is
// the trade this file made before the extraction and keeps after it.

function emitRateLimited(query) {
  const payload = {
    pr,
    verdict: "rate-limited",
    reasons: [`${query} was refused by the GitHub API rate limit — no CI state was read. A quota refusal clears on its own: re-probe rather than reading this as a CI verdict`],
  };
  writeAll(1, `${JSON.stringify(payload)}\n`);
}

// The one spawn both primitives below go through. Its child's env drops
// GIT_DIR and GIT_WORK_TREE (gitEnv()), and every child here is `gh`, which
// runs git itself to resolve the repository — `{owner}`/`{repo}` and, through
// `gh repo view`, the host — from the cwd's remotes. Either variable outranks
// that cwd: measured, `gh repo view` and `gh api repos/{owner}/{repo}` under
// an ambient GIT_DIR both answer for the repository it names, silently, at
// exit 0.
//
// `maxBuffer` defaults to execFileSync's own 1 MiB; only the workflow-tree
// reads pass a larger one (see graphql() below). `capture` keeps the child's
// stderr instead of forwarding it, for the one read whose failure can still
// turn out to be an answer (see graphql()).
function spawn(cmd, args, { maxBuffer, capture = false } = {}) {
  vlog(`$ ${cmd} ${args.join(" ")}`);
  return execFileSync(cmd, args, { encoding: "utf8", env: gitEnv(), ...(maxBuffer ? { maxBuffer } : {}), ...(capture ? { stdio: "pipe" } : {}) });
}

// Three disjoint shapes — Node-aborted (ENOENT/ENOBUFS), signal, exit.
const failureOf = (e) => e.code ?? (e.signal ? `killed by ${e.signal}` : `exit ${e.status}`);

// `recover(e)`, given, is handed a failed child and returns the stdout to use
// instead, or null when the failure stands. `why`, given, says what the
// failure leaves unanswerable.
function run(cmd, args, { maxBuffer, recover, why } = {}) {
  try {
    return spawn(cmd, args, { maxBuffer, capture: !!recover });
  } catch (e) {
    const recovered = recover?.(e);
    if (recovered != null) return recovered;
    // Names the cause, never the child's stderr — execFileSync forwarded it
    // already, so interpolating it emits every byte twice. A recoverable read
    // captured it instead, so that one is forwarded here, once, now that the
    // failure stands. `e.message` is the same string, not a fallback: Node
    // builds it as `Command failed: <cmd>\n<stderr>`.
    if (recover && e.stderr) writeAll(2, e.stderr);
    // A quota refusal names itself first; every other cause reports
    // exactly as it always has, on this same line and this same exit code.
    // `?? ""` stays — RegExp.test would coerce an absent stderr to the string
    // "undefined", which a future looser pattern could match. String() around
    // it does nothing: encoding: "utf8" above makes e.stderr a string whenever
    // a child ran, and test() ToString-coerces anything else regardless.
    if (RATE_LIMITED.test(e.stderr ?? "")) emitRateLimited(`${cmd} ${args[0]} ${args[1]}`);
    die(`${cmd} failed: ${failureOf(e)}${why ? ` — ${why}` : ""}`);
  }
}

// One truncation rule for every raw gh value this script quotes into a
// refusal: cut at n chars behind a visible marker, shared by the non-JSON
// die below and by `saw` further down. An unmarked cut reads as the whole
// value — the length quoted is gh's, not this script's — so a bare
// `raw.trim().slice(0, n)` here would be exactly the lie `saw`'s own
// comment (below) declares unacceptable one screen away.
const cut = (s, n = 120) => (s.length > n ? `${s.slice(0, n)}… (truncated)` : s);

// Every gh read in this file is JSON, and a bare JSON.parse of a child's stdout
// fails OPEN: gh can exit 0 with a non-JSON body (a proxy's HTML error page is
// the measured case) and the uncaught SyntaxError exits 1 — which in THIS
// script is the code for not-green, so a crash renders as a CI verdict.
//
// The parse succeeding is not the shape succeeding: an error object where an
// array of runs is expected, a run view missing its jobs, parse cleanly and
// flow on unchecked until the first dereference throws — same exit-1-as-
// verdict failure, one layer further in. `shape`, given, is
// `(parsed) => string | null` — a reason the payload isn't what the caller
// is about to read, or null when it's fine — checked here so each call site
// declares what it expects instead of hand-rolling its own, the way the two
// siblings do: candidates.mjs's `!Array.isArray(rows)` and its per-row field
// check, ledger.mjs's "gh returned JSON that is not an issue list". Named
// rather than cited by line, since both files move. Parity with them is
// partial on purpose: those check the discriminating field of every row, the
// row-level checks here refuse on object-ness alone — see the next comment.
function runJson(cmd, args, shape, opts) {
  const raw = run(cmd, args, opts);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    die(`${cmd} ${args[0]} ${args[1]} returned no JSON — ${cut(raw.trim())}`);
  }
  const problem = shape?.(parsed);
  if (problem) die(`${cmd} ${args[0]} ${args[1]} returned JSON but not the expected shape — ${problem}`);
  return parsed;
}

// Shared by every shape check below. The fields actually read off a row
// (r.headSha, j.name, ...) are bare property reads, safe on any object even
// one missing that field — undefined flows into a comparison or a String(),
// never a throw. Only a `null` throws on that first read — an array, string,
// number or boolean reads back `undefined` like any other missing field
// (measured). Refusing all of them is still right: none is a row, and the
// silent ones are the same failure one notch quieter, a wrong-shape reply
// read as a field-less one. Object-ness is the refusal, not each field's
// type — checking e.g. that a job's `conclusion` were a string would wrongly
// refuse a legitimate in-progress job, whose conclusion is `null`.
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// What a shape refusal is FOR is telling a reader what gh actually sent, and
// "missing <field>" told them the opposite of it. The two `gh pr view` field
// guards below each cover three faults at once — the key absent, the value an
// empty string, the value not a string — and the `jobs` guard two of the same
// kind, and every one of them printed a single identical "missing" line
// (measured), so a reader went hunting for a key gh had in fact
// returned as `""`, `42` or `null`. `saw` reports the value instead, and
// claims absence only when the key really is absent.
//
// `Object.hasOwn`, not `key in obj`: `in` answers for the prototype chain
// too, and throws outright on a non-object (measured: TypeError, "Cannot use
// 'in' operator"). Every call site refuses a non-object ahead of any field
// check, so `in` would work there today — but a field guard reordered past
// that refusal would turn this diagnostic into the very exit-1-as-verdict
// crash the shape checks exist to prevent, where `hasOwn` just answers
// `false`.
//
// JSON.stringify, not the raw value: it is what makes `""` visible at all and
// what tells the string `"42"` from the number 42. It always returns a string
// here — the value came from JSON.parse, and no JSON value stringifies to
// `undefined`. Cut through the shared `cut()` above — the same visible-
// marker rule the non-JSON die uses, because the length quoted here is
// gh's, not this script's, same as there.
const saw = (obj, key) => {
  if (!Object.hasOwn(obj, key)) return "the key is absent";
  const shown = JSON.stringify(obj[key]);
  return `got ${cut(shown)}`;
};

// `pr` was once validated for truthiness alone, so `--pr abc` survived to
// every payload site — each built `pr: Number(pr)`, and `JSON.stringify(NaN)`
// is `null`. The normal path is the worse of them: an unidentifiable payload
// at exit 0 with `verdict: "green"`, which is the verdict the fleet gates on.
// `pr` is that payload's only identifying field, and the fleet polls this
// script for several PRs at once — so a null there is not a cosmetic gap, it is
// a report that cannot be attributed to the PR it answered for. Reaching gh at
// all is the other harm: `gh pr view` resolves a non-numeric ref as a BRANCH,
// so `--pr abc` could return a genuine verdict for whatever PR that branch
// belongs to.
//
// The rule itself lives in arg.mjs's numArg(), because the identical
// shape was still live in diff-stats.mjs and pr-overlap.mjs and a fourth
// spelling of it here is what the fix had to stop. What stays this file's own
// is the usage line below — absent and malformed are different mistakes, and
// numArg() refuses only the second.
//
// `=== null`, not `!pr`: numArg() returns a NUMBER, so `--pr 0` — a value the
// caller did give — would otherwise be answered with a usage line claiming
// `--pr` is required. `gh` answers it truthfully instead, as no such PR.
// numArg() also no longer needs the placement the old regex check did: that one had
// to sit below this die because test() coerces `null` to the string "null",
// and numArg() never tests a value it did not read. It still lands above
// sweep(), per arg.mjs — where both would refuse, the more specific wording
// wins — and still before the first gh read.
const pr = numArg("pr");
if (pr === null) {
  die(
    "usage: ci-state.mjs --pr <number> [--base main] [--workflow CI] " +
      "[--workflow-file <path>] [--declare-no-ci] [--quiet]",
  );
}

const base = arg("base") || "main";
const workflow = arg("workflow") || "CI";
// --declare-no-ci is the caller's opt-out, never inferred: without it, a repo
// with no workflow file yields verdict=no-ci but still exits non-zero,
// so absence never silently reads as pass. Fits the argv-flag surface every
// other option here already uses, rather than a repo-committed marker file
// that would sit uncommitted or drift stale.
const declareNoCi = has("declare-no-ci");

// Every flag above is read by looking for its own name, so a name
// nothing reads was never looked for — `--basee main` left `base` on its
// default and this file returned a real, wrong verdict at exit 0/1. That is
// the verdict the fleet gates PR-green on. Placed below the reads, per
// arg.mjs, so `--base --quiet` keeps "--base needs a value"; still
// above the first gh call, which is the next statement.
//
// `--workflow-file` is read here rather than where its value is first needed,
// which is the whole reason the read is a statement of its own: measured,
// with it below the guards `--pr 42 --workflow-file --base main` refused with
// `unexpected argument 'main'` — naming --base's innocent value instead of
// the flag actually given wrong. Immediately above the sweep, not higher, so
// it cannot take the `--declare-no-ci=` refusal off the boolean guard that
// words it better.
const workflowFileArg = arg("workflow-file");

sweep();

// sweep() above only ever refuses a `--`-prefixed token, so a bare or
// single-dash stray rode along in silence — `--pr 42 basee main` ignored
// `basee`/`main` and still compared against the default base, the same
// fail-open harm sweep() closes for a misspelled FLAG name. This file takes no
// positional of its own, so any leftover token is one.
stray();

// The spawn primitive for the reads allowed to fail — the behind-count's own
// probes — answering null where run() would die.
function tryRun(cmd, args) {
  try {
    return spawn(cmd, args);
  } catch (e) {
    // Same discipline as run(), and it matters more here: --quiet suppresses
    // vlog entirely, so under the controller's Monitor this line is discarded
    // and the interpolated stderr would have been paid for and then thrown
    // away. Name the cause; the child's own bytes already reached the caller.
    vlog(`    ${NAME}: ${cmd} failed: ${failureOf(e)}`);
    return null;
  }
}

const WORKFLOWS_DIR = ".github/workflows";

// `--workflow-file` names a repo-relative path, read at both commits like a
// discovered one. It is split into the directory read and the entry picked
// out of it, so it travels the same tree shape discovery does. A path that
// could leave the repository, or that names no directory, is refused before
// any read.
let wfDir = WORKFLOWS_DIR;
let wfEntry = null;
if (workflowFileArg) {
  const segs = workflowFileArg.replace(/^(?:\.\/)+/, "").split("/");
  if (workflowFileArg.startsWith("/") || segs.length < 2 || segs.some((s) => s === "" || s === "." || s === "..")) {
    die(`--workflow-file takes a repo-relative path such as ${WORKFLOWS_DIR}/ci.yml, read at the PR's head and base commits — got '${workflowFileArg}'`);
  }
  wfEntry = segs.pop();
  wfDir = segs.join("/");
}

// --- The repository and its host -------------------------------------------
// Every read up to the run query is `gh api`, and `gh api` does NOT infer the
// host from the local remote the way `gh pr` and `gh run` do — on a GitHub
// Enterprise repo it silently 404s against github.com. So the host is named on
// every `gh api` call, and it is taken from gh's own resolution of the cwd's
// repository — the same resolution that fills `{owner}`/`{repo}` in those
// calls — never parsed out of a remote URL. gh already handles what a URL
// parse gets wrong: credentials in the URL (`https://x-access-token:…@host/`),
// ssh host aliases, and a repository whose remote is not named `origin`.
// A cwd gh resolves no repository from is exit 2: the question cannot be asked.
const repoView = runJson(
  "gh",
  ["repo", "view", "--json", "nameWithOwner,url"],
  (v) => {
    if (!isObject(v)) return "expected an object";
    if (typeof v.nameWithOwner !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(v.nameWithOwner)) return `nameWithOwner is not owner/name (${saw(v, "nameWithOwner")})`;
    if (typeof v.url !== "string" || !URL.canParse(v.url) || !new URL(v.url).hostname) return `url carries no host (${saw(v, "url")})`;
    return null;
  },
  { why: "no GitHub repository resolves from this cwd's git remotes, so neither the PR nor its workflows can be read" },
);
const host = new URL(repoView.url).hostname;

// --- PR facts and both workflow trees, read at explicit commits -------------
// The workflow the expected jobs come from is read at the PR's own commits —
// the head the run is bound to and the base it merges into — never from the
// caller's working tree. A working tree answers for whatever is checked out
// in it: a PR worktree with the head's job set, a `main` checkout with the
// base's, stale or dirty, so one PR and one run used to read differently
// depending on who asked.
//
// One GraphQL query carries the PR fields and both trees. The head is
// addressed as `refs/pull/N/head`, which outlives the head branch (the PR's
// `headRef` reads null once the branch is deleted), and must resolve to
// `headRefOid` — any other commit means the head moved between the halves of
// one read, which is exit 2 rather than one commit's workflow judged against
// another's run.
//
// The base is the commit at `baseRefOid`. `baseRef.target` is the base
// branch's TIP, which is that commit only until the base advances: an open
// PR whose base moved on since its last push carries a `baseRefOid` behind
// the tip. When the two agree, the tree already read is the right one;
// otherwise a second read addresses `baseRefOid` itself and must answer for
// exactly that commit, or exit 2 — never the tip's tree in its place.

// Every commit's workflow directory is read as `file(path:)` — the tree entry
// at that path — because the entry's `type` is what tells a directory from
// anything else standing there: a file, or a submodule (`commit`), whose
// `object` reads back null exactly as a missing path's would.
const TREE_FRAGMENT =
  "fragment wf on GitObject { __typename ... on Tree { entries { name type object { __typename ... on Blob { text isTruncated } } } } }";
const DIR_ENTRY = "file(path: $dir) { type object { ...wf } }";
const PR_QUERY = `${TREE_FRAGMENT}
query($owner: String!, $name: String!, $pr: Int!, $dir: String!, $headExpr: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      headRefName headRefOid baseRefName baseRefOid state mergeStateStatus
      baseRef { target { oid ... on Commit { ${DIR_ENTRY} } } }
    }
    head: object(expression: $headExpr) { oid ... on Commit { ${DIR_ENTRY} } }
  }
}`;
const BASE_QUERY = `${TREE_FRAGMENT}
query($owner: String!, $name: String!, $dir: String!, $baseExpr: String!) {
  repository(owner: $owner, name: $name) {
    base: object(expression: $baseExpr) { oid ... on Commit { ${DIR_ENTRY} } }
  }
}`;
// Where in each reply a `file` field sits, as GraphQL error paths spell it.
const HEAD_DIR = "repository.head.file";
const TIP_DIR = "repository.pullRequest.baseRef.target.file";
const BASE_DIR = "repository.base.file";

// `shape` here receives `data.repository`, the one object every query above
// answers inside; a reply without it is refused before `shape` runs. The
// query goes out on one line so its command echo stays one line too.
//
// A path that does not exist is not answered with a quiet null: `file(path:)`
// returns null AND a top-level `NOT_FOUND` error for it, and gh exits 1 on any
// reply carrying errors, printing that reply on stdout all the same
// (measured). That failure is the one that can be an answer: when every error
// in the reply is a NOT_FOUND on one of the `file` fields named in
// `absentAt`, the reply stands, and those paths come back in `notFound` — the
// only way a workflow directory is ever read as absent. Any other error, or a
// NOT_FOUND anywhere else (no such PR, no such repository), fails the read.
//
// The reply carries the text of every workflow file at up to two commits, so
// it gets a buffer sized for that rather than execFileSync's 1 MiB default:
// past the default the read dies ENOBUFS, and a repo whose workflows are
// merely large would get exit 2 where reading them off disk never did.
const TREE_READ_BYTES = 64 * 1024 * 1024;
function graphql(query, vars, absentAt, shape) {
  const fields = Object.entries(vars).flatMap(([k, v]) => [typeof v === "number" ? "-F" : "-f", `${k}=${v}`]);
  let notFound = [];
  const recover = (e) => {
    if (e.status !== 1) return null;
    let reply;
    try {
      reply = JSON.parse(e.stdout);
    } catch {
      return null;
    }
    const errors = isObject(reply) ? reply.errors : undefined;
    if (!Array.isArray(errors) || errors.length === 0) return null;
    const paths = errors.map((err) => (isObject(err) && err.type === "NOT_FOUND" && Array.isArray(err.path) ? err.path.join(".") : null));
    if (paths.some((p) => !absentAt.includes(p))) return null;
    notFound = paths;
    return e.stdout;
  };
  const repo = runJson(
    "gh",
    ["api", "graphql", "--hostname", host, "-F", "owner={owner}", "-F", "name={repo}", ...fields, "-f", `query=${query.replace(/\s+/g, " ")}`],
    (v) => {
      if (!isObject(v) || !isObject(v.data) || !isObject(v.data.repository)) return "expected an object carrying data.repository";
      return shape?.(v.data.repository) ?? null;
    },
    { maxBuffer: TREE_READ_BYTES, recover },
  ).data.repository;
  return { repo, notFound };
}

// One commit's workflow directory, from the `file` entry `commit` carries:
// the Tree, or null ONLY where GitHub said NOT_FOUND for exactly that path. A
// null with no such error is a reply this script does not understand, and an
// entry that is there but is not a directory is not an absence either.
function dirAt(commit, side, at, notFound) {
  const entry = isObject(commit) ? commit.file : undefined;
  if (entry === null && notFound.includes(at)) return null;
  if (!isObject(entry) || entry.type !== "tree") {
    die(`${wfDir} at the ${side} commit is not a readable directory (got ${cut(JSON.stringify(entry) ?? "nothing")})`);
  }
  return entry.object;
}

const headExpr = `refs/pull/${pr}/head`;
const prRead = graphql(PR_QUERY, { pr, dir: wfDir, headExpr }, [HEAD_DIR, TIP_DIR], (repo) => {
  const v = repo.pullRequest;
  if (!isObject(v)) return `pullRequest is not an object (${saw(repo, "pullRequest")})`;
  for (const [key, what] of [["headRefName", "the branch"], ["headRefOid", "the head sha"], ["baseRefName", "the base branch"], ["baseRefOid", "the base sha"]]) {
    if (typeof v[key] !== "string" || !v[key]) return `${key} (${what}) is not a non-empty string (${saw(v, key)})`;
  }
  return null;
});
const prInfo = prRead.repo.pullRequest;
const branch = prInfo.headRefName;
const prHead = prInfo.headRefOid;
const baseOid = prInfo.baseRefOid;
vlog(`    branch=${branch} head=${prHead} base=${prInfo.baseRefName}@${baseOid} state=${prInfo.state} mergeState=${prInfo.mergeStateStatus}`);

const headOid = prRead.repo.head?.oid;
if (headOid !== prHead) {
  die(`${headExpr} resolves to ${headOid ?? "nothing"}, not the PR head ${prHead} — the head moved mid-read; re-query rather than judge one commit's workflow against another's run`);
}

let baseTree;
const baseTip = prInfo.baseRef?.target;
if (isObject(baseTip) && baseTip.oid === baseOid && Object.hasOwn(baseTip, "file")) {
  baseTree = dirAt(baseTip, "base", TIP_DIR, prRead.notFound);
} else {
  const baseRead = graphql(BASE_QUERY, { dir: wfDir, baseExpr: baseOid }, [BASE_DIR]);
  const got = baseRead.repo.base?.oid;
  if (got !== baseOid) die(`the PR's base commit ${baseOid} reads back as ${got ?? "nothing"} — its workflow cannot be bound to it`);
  baseTree = dirAt(baseRead.repo.base, "base", BASE_DIR, baseRead.notFound);
}

// One tree entry's YAML text, or null when the blob cannot be read whole:
// absent, binary, or truncated by the API. A truncated text is not a shorter
// workflow, so it is never parsed.
const blobText = (entry) => {
  const o = entry.object;
  return isObject(o) && o.__typename === "Blob" && typeof o.text === "string" && o.isTruncated === false ? o.text : null;
};

// The CI workflow in one commit's tree: `{ path, text }`, or null ONLY where
// that commit genuinely has none — no workflows directory (GitHub's NOT_FOUND
// for that path, see graphql()), a directory holding no YAML at all, or
// (explicit route) no entry at the named path. Every other
// outcome is die() (exit 2, "could not be answered"): the path not a
// directory, a YAML blob that cannot be read whole, two files sharing the
// workflow's name. Absence must be established, never inferred from a read
// that failed: a repo whose CI is merely misconfigured must never read as one
// with no CI.
//
// `side` settles the remaining case, YAML present but none of it carrying the
// workflow's name. At the base that is a --workflow/--workflow-file mismatch,
// not an absence — saying "no CI configured" of a directory full of workflows
// is false, and under --declare-no-ci it would exit 0 for a repo whose CI was
// never looked at. At the head it is a PR that removed or renamed its CI
// workflow, which contributes no jobs of its own.
function findWorkflow(tree, side) {
  if (tree === null) return null;
  if (!isObject(tree) || tree.__typename !== "Tree" || !Array.isArray(tree.entries) || tree.entries.some((e) => !isObject(e))) {
    die(`${wfDir} at the ${side} commit is not a readable directory (got ${cut(JSON.stringify(tree) ?? "nothing")})`);
  }
  if (wfEntry !== null) {
    const entry = tree.entries.find((e) => e.name === wfEntry);
    if (!entry) return null;
    const text = blobText(entry);
    if (text === null) die(`cannot read ${wfDir}/${wfEntry} at the ${side} commit — not a file whose text came back whole`);
    return { path: `${wfDir}/${wfEntry}`, text };
  }
  const yamls = tree.entries
    .filter((e) => e.type === "blob" && /\.ya?ml$/.test(String(e.name)))
    .map((e) => ({ name: e.name, path: `${wfDir}/${e.name}`, text: blobText(e) }));
  const unreadable = yamls.filter((y) => y.text === null).map((y) => y.path);
  if (unreadable.length) {
    die(`cannot read ${unreadable.join(", ")} at the ${side} commit — the text came back absent, binary or truncated, so which workflow it is cannot be settled`);
  }
  const candidates = [];
  for (const e of yamls) {
    // Top-level `name:` only (column 0) — a job's own `name:` step is indented
    // and expectedJobs() below already treats that as a different concern. The
    // optional ` #…` tail is a YAML comment, not part of the name: without it
    // `name: CI  # main pipeline` parsed as a workflow called `CI  # main
    // pipeline`, so a correctly configured repo reported no-ci. ` #` with the
    // space is what makes it a comment in YAML, so `name: CI#1` stays `CI#1`.
    const m = e.text.match(/^name:\s*(.+?)(?:\s+#.*)?\s*$/m);
    const name = m ? m[1].replace(/^['"]|['"]$/g, "") : null;
    if (name === workflow) candidates.push({ path: e.path, text: e.text });
  }
  if (candidates.length > 1) {
    die(
      `${candidates.length} workflow files under ${wfDir}/ at the ${side} commit are named '${workflow}' (${candidates.map((c) => c.path).join(", ")}) — pass --workflow-file to pick one`,
    );
  }
  if (candidates.length === 1) return candidates[0];
  if (yamls.length && side === "base") {
    die(
      `${yamls.length} workflow file(s) under ${wfDir}/ at the ${side} commit (${yamls.map((e) => e.name).join(", ")}), none named '${workflow}' — pass --workflow <name> or --workflow-file <path>`,
    );
  }
  return null;
}

// Whether the repo has CI at all is the base's to say: a PR adding a repo's
// first CI workflow still reads no-ci until that workflow is on the base.
const baseWf = findWorkflow(baseTree, "base");
if (baseWf === null && wfEntry !== null) {
  die(`${wfDir}/${wfEntry} does not exist at the base commit ${baseOid} — an explicit --workflow-file is never read as no CI`);
}
// No workflows at all, so this repo has no CI configured for ci-state to read.
// That is its own verdict (`no-ci`), never the exit code reserved for "the
// question could not be answered" — every way of failing to READ a workflow
// (a path that is not a directory, a blob not read whole, a malformed file)
// dies with exit 2 instead, above or via expectedJobs() below.
const noCi = baseWf === null;
if (noCi) {
  vlog(`    no workflow files under ${WORKFLOWS_DIR}/ at the base commit — no-ci verdict`);
}

// --- Expected jobs ----------------------------------------------------------
// Never hardcoded: the expected set is derived from the CI workflow's `jobs:`
// block as it stands at the PR's two commits, read above — H, the job ids at
// the head, and B, the job ids at the base. The run must carry every job in
//
//   expected = H ∪ (D ∩ required), where D = B − H
//
// D is what the PR's own diff drops, and `required` is every status-check
// context the base branch's rules still require — its rulesets and classic
// branch protection together. So a PR may drop a CI job only once no rule a
// human owns still requires it: deleting a failing job is not a way to read
// green while the base still demands that job. A job the PR adds needs no
// clause of its own, since every job the run reports must succeed anyway.
// The rules are read only when some dropped job is also absent from the run;
// otherwise the answer cannot depend on them.
//
// A reader asking whether an empty `missing` is real should read that
// workflow at both commits for the current sets. They are deliberately not
// restated here: a set written into this comment is wrong the moment a job is
// added.
//
// Not built from the fleet's own prose instead: `integration-docker` — a job in
// the agent-brain repo's CI workflow, which is on an internal GHE host and so
// cannot be settled from this repo — is named nowhere under the plugin's own
// component dirs but here (`git grep -l integration-docker -- commands scripts
// skills` matches only this file), so a
// list built from those documents would have accepted a run missing it.
function expectedJobs(text, label) {
  const ids = [];
  let inJobs = false;
  let sawNameOverride = false;
  for (const line of text.split("\n")) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (inJobs && /^[A-Za-z]/.test(line)) break; // next top-level key ends the section
    if (!inJobs) continue;
    const m = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (m) ids.push(m[1]);
    if (/^ {4}name:/.test(line)) sawNameOverride = true;
  }
  // Fail closed on the assumption this derivation rests on. If a job's
  // reported name diverges from its YAML key, ids no longer equal the names
  // `gh run view` reports, and every comparison below would silently compare
  // the wrong strings.
  //
  // The reader most likely to cause that divergence is standing in the
  // workflow, not here, so the same constraint is written at that end too:
  // the NOTE heading the `rebase-check:` job in this repo's
  // `.github/workflows/ci.yml`. It names this derivation as a live reader of
  // that job's name, alongside the `main` ruleset, which requires a
  // status-check context by the name the API reports — and records that a
  // YAML job key and an API-reported display name coincide only while every
  // job's reported name is its own key. This guard only catches one of the
  // ways that can break: the canonical `    name:` spelling. A
  // `strategy.matrix` block, or `name:` written as `name :` or `"name":`, sets
  // (or changes) the reported name just as validly and slips past unnoticed —
  // `sawNameOverride` stays false, and this function returns a verdict built
  // on an id the API no longer reports under.
  if (sawNameOverride) {
    die(`${label} sets a job-level 'name:' — job ids no longer match reported job names, derivation invalid`);
  }
  if (ids.length === 0) die(`derived zero jobs from ${label} — refusing to answer`);
  return ids;
}

// The status-check contexts the base branch's rules require: every active
// ruleset's `required_status_checks` rule, plus classic branch protection's
// own list. Both are read because either alone can miss a requirement — a
// branch protected the classic way shows nothing under its rulesets. A
// dropped job counts as required when its id equals a context exactly; the
// app a context is pinned to plays no part. Either read failing is exit 2,
// never an empty set: an empty set would let every dropped job go.
function requiredContexts(branchName) {
  const rulesPath = `repos/{owner}/{repo}/rules/branches/${branchName}`;
  const pages = runJson("gh", ["api", rulesPath, "--hostname", host, "--paginate", "--slurp"], (v) => {
    if (!Array.isArray(v) || v.some((page) => !Array.isArray(page))) return "expected pages of rules";
    const rules = v.flat();
    const bad = rules.findIndex(
      (r) =>
        !isObject(r) ||
        (r.type === "required_status_checks" &&
          (!Array.isArray(r.parameters?.required_status_checks) ||
            r.parameters.required_status_checks.some((c) => !isObject(c) || typeof c.context !== "string"))),
    );
    return bad === -1 ? null : `rule ${bad} is not an object, or a required_status_checks rule without a list of contexts`;
  });
  const required = new Set();
  for (const rule of pages.flat()) {
    if (rule.type !== "required_status_checks") continue;
    for (const c of rule.parameters.required_status_checks) required.add(c.context);
  }
  const protection = runJson("gh", ["api", `repos/{owner}/{repo}/branches/${branchName}`, "--hostname", host], (v) => {
    if (!isObject(v) || !isObject(v.protection)) return `expected a branch carrying a protection object (${isObject(v) ? saw(v, "protection") : "not an object"})`;
    const checks = v.protection.required_status_checks;
    if (checks === undefined) return null;
    if (!isObject(checks) || !Array.isArray(checks.contexts) || checks.contexts.some((c) => typeof c !== "string")) {
      return `protection.required_status_checks.contexts is not a list of strings (${saw(v.protection, "required_status_checks")})`;
    }
    return null;
  }).protection;
  for (const c of protection.required_status_checks?.contexts ?? []) required.add(c);
  vlog(`    required by ${branchName}'s rules (${required.size}): ${[...required].join(", ")}`);
  return required;
}

// --- Find the run bound to this head --------------------------------------
// `--limit 1` is wrong: the newest run on a branch is frequently a label or
// policy workflow, which hides the CI result entirely. Filter by workflow, then
// match the head, then take the newest survivor.
//
// Skipped entirely under no-ci: there is no workflow to bind a run to, and
// asking anyway would spend the already-tight REST budget on a
// question this repo cannot answer either way.
const reasons = [];
let jobs = [];
let missing = [];
let dropped = [];
let runId = null;
let attempt = null;
let runHeadSha = null;
let status = null;
let conclusion = null;

if (noCi) {
  reasons.push(
    declareNoCi
      ? `no workflows configured under ${WORKFLOWS_DIR}/ — --declare-no-ci passed, gating on the caller's verified suite run instead`
      : `no workflows configured under ${WORKFLOWS_DIR}/ — pass --declare-no-ci once this repo is verified to gate on the reviewer's own suite run instead; absence never means pass`,
  );
} else {
  // Derived here rather than above the no-ci fork: the job sets are read on
  // this arm alone. Kept as this arm's first statements — expectedJobs()
  // refuses on an underivable workflow at either commit, and that refusal
  // belongs before the run query rather than after it.
  const baseJobs = expectedJobs(baseWf.text, `${baseWf.path} at the base commit`);
  const headWf = findWorkflow(dirAt(prRead.repo.head, "head", HEAD_DIR, prRead.notFound), "head");
  const headJobs = headWf === null ? [] : expectedJobs(headWf.text, `${headWf.path} at the head commit`);
  const droppedByHead = baseJobs.filter((j) => !headJobs.includes(j));
  vlog(`    head jobs (${headJobs.length}): ${headJobs.join(", ") || `none — no '${workflow}' workflow at the head`}`);
  if (droppedByHead.length) vlog(`    dropped by the head (${droppedByHead.length}): ${droppedByHead.join(", ")} — still expected where a base rule requires them`);
  const runs = runJson(
    "gh",
    ["run", "list", "--branch", branch, "--workflow", workflow, "--limit", "30", "--json", "databaseId,headSha,status,conclusion,event,createdAt"],
    (v) => {
      if (!Array.isArray(v)) return "expected an array of runs";
      const bad = v.findIndex((r) => !isObject(r));
      return bad === -1 ? null : `run list row ${bad} is not an object`;
    },
  );
  const bySecond = (createdAt) => {
    // GitHub's createdAt is already whole-second precision; this guards
    // against any future sub-second drift silently hiding a genuine tie.
    const s = String(createdAt);
    const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/.exec(s);
    return m ? m[1] : s;
  };
  // Recency is the primary key — a newer run always outranks an older one,
  // tied or not. The tie-break below fires ONLY when createdAt is equal to
  // the second: two runs GitHub started in the same instant (measured: both
  // 6 jobs green — one `cancelled`, one `completed`, and the
  // stable sort below previously let API order pick the loser). Ranking
  // conclusion ahead of createdAt here would let an older completed run beat
  // a newer in-progress one on an unrelated, untied pair — a fresh
  // regression, not a fix — so conclusion only ever compares
  // within a tie.
  const compareRuns = (x, y) => {
    const byCreatedAt = bySecond(y.createdAt).localeCompare(bySecond(x.createdAt));
    if (byCreatedAt !== 0) return byCreatedAt;
    // `status` is the run's LIFECYCLE (queued/in_progress/completed) and is
    // NOT the outcome — a cancelled run reports status:"completed",
    // conclusion:"cancelled", same as a successful one. Ranking a completed
    // run's success against its cancellation on status here (as an earlier
    // draft of this fix did) could never actually prefer the successful one
    // over the cancelled sibling, because both share status:"completed".
    // Rank a completed run's outcome on `conclusion` instead — see below
    // for why the still-running middle tier ranks on `status` instead.
    const rank = (r) => {
      if (r.conclusion === "success" || r.conclusion === "skipped") return 0;
      // Still running: no conclusion yet. `status` is this run's lifecycle
      // field (queued/in_progress/completed) and is authoritative for "not
      // done yet" — checked alone, not paired with a conclusion check.
      // An earlier version additionally required `r.conclusion === null`,
      // but live `gh run list --json conclusion` reports an empty string
      // `""` for a non-completed run, never `null` — that extra
      // check silently never matched, so a still-running run fell through
      // to the bottom tier below, indistinguishable from a failed/
      // cancelled one. `status !== "completed"` alone is both sufficient
      // (only a completed run has a real conclusion to rank on) and
      // immune to whichever falsy shape gh chooses for "no conclusion yet".
      if (r.status !== "completed") return 1;
      return 2;
    };
    const byConclusion = rank(x) - rank(y);
    if (byConclusion !== 0) return byConclusion;
    // Last resort once createdAt (to the second) and conclusion rank both
    // agree — total determinism, never expected to matter in practice.
    // Numeric, not string, compare: "9" sorts ahead of "10" lexicographically
    // but the higher/most-recent id is 10.
    return Number(y.databaseId) - Number(x.databaseId);
  };
  const matching = runs.filter((r) => r.headSha === prHead).sort(compareRuns);

  if (matching.length === 0) {
    reasons.push(`no ${workflow} run whose headSha equals the PR head ${prHead}`);
  } else {
    const chosen = matching[0];
    // A tie-break note is NOT pushed into `reasons` — reasons drives the
    // green/not-green verdict below, and disambiguating between otherwise-
    // identical candidates must never turn a green board red on its own.
    // It goes to stderr unconditionally, like the verdict summary further
    // down, rather than behind `vlog`/`--quiet`: the callers most likely to
    // hit this — hot pollers that pass `--quiet` — are exactly the ones who
    // need to know the pick required disambiguation rather than being the
    // one unambiguous match.
    const tiedAtCreatedAt = matching.filter((r) => bySecond(r.createdAt) === bySecond(chosen.createdAt));
    if (tiedAtCreatedAt.length > 1) {
      const others = tiedAtCreatedAt
        .filter((r) => r.databaseId !== chosen.databaseId)
        .map((r) => `#${r.databaseId} (${r.status}/${r.conclusion ?? "null"})`)
        .join(", ");
      writeAll(
        2,
        `${NAME}: run selection tie-break — ${tiedAtCreatedAt.length} runs share head ${prHead} and createdAt ${bySecond(chosen.createdAt)}; chose #${chosen.databaseId} (${chosen.status}/${chosen.conclusion ?? "null"}) over ${others}\n`,
      );
    }
    runId = chosen.databaseId;
    // Re-query the run itself. The list's conclusion is a second read from a
    // different moment; the authoritative job list is this one.
    const view = runJson(
      "gh",
      ["run", "view", String(runId), "--json", "jobs,attempt,status,conclusion,headSha"],
      (v) => {
        if (!isObject(v)) return "expected an object";
        if (!Array.isArray(v.jobs)) return `jobs is not an array (${saw(v, "jobs")})`;
        const bad = v.jobs.findIndex((j) => !isObject(j));
        return bad === -1 ? null : `job entry ${bad} is not an object`;
      },
    );
    attempt = view.attempt;
    runHeadSha = view.headSha;
    status = view.status;
    conclusion = view.conclusion;
    jobs = view.jobs.map((j) => ({
      name: j.name,
      status: j.status,
      conclusion: j.conclusion ?? null,
    }));
    for (const j of jobs) vlog(`    ${j.name}: ${j.status}/${j.conclusion ?? "-"}`);
    vlog(`    attempt=${attempt} runHeadSha=${runHeadSha} status=${status} conclusion=${conclusion}`);

    if (runHeadSha !== prHead) reasons.push(`run headSha ${runHeadSha} != PR head ${prHead}`);
    if (status !== "completed") reasons.push(`run status is ${status}, not completed`);

    const present = new Set(jobs.map((j) => j.name));
    // A job the head dropped and the run lacks is excused only where no base
    // rule still requires it, and only that case pays for reading the rules.
    const absentDropped = droppedByHead.filter((j) => !present.has(j));
    const required = absentDropped.length ? requiredContexts(prInfo.baseRefName) : new Set();
    const stillRequired = absentDropped.filter((j) => required.has(j));
    dropped = absentDropped.filter((j) => !required.has(j));
    missing = [...headJobs.filter((e) => !present.has(e)), ...stillRequired];
    // An absent job reads as pending and is invisible in a checks summary. This is
    // the case a force-push creates: the run is cancelled, finished jobs keep their
    // conclusions, and the missing ones simply never appear.
    if (missing.length) {
      reasons.push(`expected jobs absent from the run: ${missing.map((j) => (stillRequired.includes(j) ? `${j} (dropped by the head's workflow, still required by the base ruleset)` : j)).join(", ")}`);
    }

    // `skipped` is NOT `passed`. When the currency check fails, the heavy suites
    // report skipped — they did not execute.
    for (const j of jobs) {
      // `??` only falls through on null/undefined; gh reports an empty
      // string `""` for an in-progress job's conclusion (same shape as the
      // rank() tie-break bug above), so `??` alone
      // would print the unreadable "job check is , not success". `||`
      // treats the empty string as absent too and falls through to status.
      if (j.conclusion !== "success") reasons.push(`job ${j.name} is ${j.conclusion || j.status}, not success`);
    }
  }
}

// --- Behind-count ---------------------------------------------------------
// Uses the repository and host resolved above, so it reads neither again here.
//
// This block MUST NOT use run(): run()'s failure path calls die(), which calls
// process.exit(2) and terminates before any surrounding catch can see it. An
// earlier version wrapped run() in a try/catch here, which made the catch
// unreachable — a transient failure on this purely informational side channel
// hard-exited the tool and discarded a fully computed CI verdict. tryRun()
// returns null instead, so the behind-count can be unknown without costing
// the caller the answer it actually asked for.

let behind = null;
try {
  const cmpJson = tryRun("gh", ["api", "--hostname", host, `repos/${repoView.nameWithOwner}/compare/${base}...${prHead}`]);
  if (cmpJson !== null) {
    const cmp = JSON.parse(cmpJson);
    // Shaped like every other gh read here, but fail-SOFT: a compare
    // reply without a numeric `behind_by` — a 404 body from the wrong host
    // or base is the live case — leaves `behind` null, this block's
    // documented unknown, instead of `undefined`, which JSON.stringify drops
    // from the payload entirely, taking the contract below and its
    // unknown-vlog with it. Still never dies: the probe stays advisory.
    behind = typeof cmp?.behind_by === "number" ? cmp.behind_by : null;
    vlog(`    behind_by=${behind} (status=${cmp?.status})`);
  }
} catch (e) {
  // JSON.parse of a malformed payload lands here; the subprocess failures are
  // already handled by tryRun returning null.
  vlog(`    ${NAME}: behind-count unusable: ${e.message}`);
}

// `behind` stays null when unknown, and null NEVER enters `reasons`. The
// behind-count is context for the caller, not part of the green verdict:
// reviewers label without requiring currency, and only the merge bot
// establishes it. An earlier version pushed "behind-count unavailable" into
// reasons, which silently turned a fully green board into not-green over a
// number the verdict is not supposed to depend on.
//
// null is deliberately not 0 — 0 would read as "current", which is the one
// wrong answer that matters here.
if (behind === null) {
  vlog(`    ${NAME}: behind-count unknown (reported as null; verdict unaffected)`);
}

// no-ci is its own verdict, distinguishable from both green and not-green —
// board.mjs's mapCi() and any other caller that reads `verdict` by string
// value sees "no-ci" rather than either, so it cannot be silently folded into
// a pass or a red. reasons.length is never 0 here: the no-ci branch above
// always pushes exactly one, whichever way --declare-no-ci went.
const verdict = noCi ? "no-ci" : reasons.length === 0 ? "green" : "not-green";
writeAll(2, `\n${NAME}: verdict=${verdict}${reasons.length ? ` — ${reasons.join("; ")}` : ""}\n`);

// Compact, single-line: the consumer is an agent/script parsing JSON, and the
// pretty view already went to stderr. On the quiet hot path drop `jobs`,
// `missing` and `dropped` too — `reasons` already states every failing/absent
// job, so they are pure duplication in the two longest-lived contexts that
// poll this.
//
// no-ci drops them unconditionally, quiet or not — never folded into the
// `!quiet` check above, which is about duplication, not about what was read.
// They stay at their `let … = []` initialisers on this path (the no-ci branch
// never reaches the run-binding arm that assigns them), so shipping them read
// as "checked, nothing missing" to a caller gating on `missing.length` when no
// workflow was ever read to check against. `emitRateLimited()` above already
// answers the same "nothing was read" question by omitting them rather than
// emitting them empty; this is the no-ci arm agreeing with it, one
// convention for both places in this file that never bind a run.
const payload = { pr, branch, prHead, runId, attempt, runHeadSha, status, conclusion, behind, verdict, reasons };
if (!quiet && !noCi) Object.assign(payload, { jobs, missing, dropped });
writeAll(1, `${JSON.stringify(payload)}\n`);

// Exit vocabulary unchanged: 0 only when the gate is satisfied, 1 when it is
// not, 2 (via die(), above) only when the question could not be answered at
// all. no-ci without --declare-no-ci is a satisfiable question with an
// unsatisfied gate — exit 1, same bucket as not-green, so absence never reads
// as pass to a caller that checks only the exit code. no-ci WITH the
// declaration is the caller saying the gate is satisfied elsewhere (their own
// verified suite run) — exit 0.
const gateSatisfied = verdict === "green" || (verdict === "no-ci" && declareNoCi);
process.exit(gateSatisfied ? 0 : 1);
