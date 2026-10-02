import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./strip-comments.mjs";
import { between } from "./prose-pin.mjs";
import { usableDiff, readRules, SNAPSHOT_SCHEMA } from "./review-core.mjs";

const REPO = join(import.meta.dirname, "..");
const SOURCE = readFileSync(join(REPO, "scripts", "review-core.mjs"), "utf8");

// Every pin below runs against CODE, not SOURCE: a declaration or a paragraph a
// reader's eye skips must not satisfy an assertion. Stripping once closes the
// class for every assertion in this file, including ones added later — see
// strip-comments.mjs for the two escapes measured green without it, and for why
// the stripper is shared rather than copied into each test file.
const CODE = stripComments(SOURCE);

// #1129: `usableDiff` no longer returns the reported `diffPath`, it REBUILDS
// the path from the run root the caller already checked — the redirect that
// wrote the file is `> "$RUN"/pr.diff` inside the snapshot block, so the path is
// the caller's to derive. What the reported field still decides is whether the
// capture happened at all, which is why every fixture below varies `diffPath`
// while the accepted RESULT is always derived from `runRoot`.
const ROOT = "/s/pr7/run-ab12cd34";

// A diff that is empty, or whose line count was never measured, is worse than
// no diff: the specialist reads it as authoritative.
test("usableDiff rejects a diff that would lie about the snapshot", () => {
  assert.equal(usableDiff({}), null, "no diffPath");
  assert.equal(
    usableDiff({ diffLines: 40 }),
    null,
    "diffPath absent but diffLines truthy — isolates the diffPath guard from the diffLines guard",
  );
  assert.equal(
    usableDiff({ diffPath: "/s/pr.diff", diffLines: 0 }),
    null,
    "0-byte diff — `gh pr diff` exits 1 and still leaves the file",
  );
  // The one guard where ABSENT and 0 mean the same thing. Deliberate: the count
  // is not a cross-check, it is the only thing that rules out that 0-byte file,
  // so an unreported count leaves "usable" a guess. Pinned because it reads like
  // the inversion bug.
  assert.equal(
    usableDiff({ diffPath: "/s/pr.diff" }),
    null,
    "diffLines absent — no count means the 0-byte case cannot be ruled out",
  );
});

// The accept half. Heads are `snapshotMissing`'s to judge, before this runs, so
// a present `refHead` — matching or not — must not cost a counted diff here.
test("usableDiff accepts a counted diff and derives its path from runRoot", () => {
  assert.equal(usableDiff({ runRoot: ROOT, head: "aaa", diffPath: "/s/pr.diff", diffLines: 40 }), `${ROOT}/pr.diff`);
  assert.equal(
    usableDiff({ runRoot: ROOT, head: "aaa", diffPath: "/s/pr.diff", diffLines: 40, refHead: "bbb" }),
    `${ROOT}/pr.diff`,
    "usableDiff judged the heads again — the compare belongs to snapshotMissing alone",
  );
  assert.equal(
    usableDiff({ runRoot: ROOT, head: "a".repeat(40), diffPath: "/s/pr.diff", diffLines: 40, refHead: "z".repeat(7) }),
    `${ROOT}/pr.diff`,
    "unconditionally blind to refHead, not merely permissive of one mismatch shape — an abbreviated mismatch must not cost the diff either",
  );
});

const PATHS = {
  paths: [
    { path: "scripts/review-core.mjs", kind: "src", loc: 115 },
    { path: "docs/specs/a.md", kind: "docs", loc: 393 },
  ],
};

// Emitting both the diff pointer and the file list doubles the block on exactly
// the PRs where prompt size matters most. The branches are exclusive.
test("readRules names the diff and does not also list files", () => {
  const out = readRules("/s/pr.diff", PATHS);
  assert.match(out, /\/s\/pr\.diff/);
  assert.doesNotMatch(out, /touched exactly these files/);
  // The IMPERATIVE, not just the path. Reducing this branch to `The PR's whole
  // diff is at ${diffPath}.` left the suite green — and a path with no order to
  // read it first is pre-fix behaviour plus tokens, which is the entire defect
  // this branch exists to fix. `\s+` per the file's reflow convention.
  assert.match(
    out,
    /Read\s+it\s+FIRST,\s+bounded/,
    "the diff is named but not ordered read first — a specialist keeps reading whole files",
  );
});

// The unit is stated INLINE, per file. A bare `(115)` under a header is read as
// the file's length — "small, take it whole" on a 900-line file — which is the
// unbounded read the block exists to stop.
test("readRules falls back to the changed-file list with each file's loc", () => {
  const out = readRules(null, PATHS);
  assert.match(out, /No diff file was captured/);
  assert.match(out, /scripts\/review-core\.mjs \(115 changed\)/);
  assert.match(out, /docs\/specs\/a\.md \(393 changed\)/);
  // The POSITIVE companion the four `doesNotMatch(/touched exactly these files/)`
  // assertions in this file need. Without it, renaming the phrase makes all four
  // pass forever against a branch 2 that no longer says anything of the kind —
  // a `doesNotMatch` over an unverified baseline passes trivially.
  assert.match(
    out,
    /touched exactly these files and no others/,
    "branch 2 no longer emits the closure phrase the negative assertions are written against",
  );
});

// `stats` is null whenever diff-stats.mjs errored or its blob was unparseable
// (where the caller parses `snap.diffStats`). Saying so beats emitting an empty
// list, which reads as "the PR touched no files".
test("readRules says so when it has neither a diff nor a file list", () => {
  const out = readRules(null, null);
  assert.match(out, /No diff file and no file list were captured/);
  assert.doesNotMatch(out, /touched exactly these files/);
  // This branch is ONE failure away, not two: diff-stats.mjs shells out to
  // `gh pr view <pr> --json files`, so a single broken `gh` takes the diff and
  // the file list together. It is also the branch a specialist cannot fall back
  // on anything else from — its "review request" is a dimension prompt naming no
  // file. So it has to name a discovery move. The wording it replaces
  // ("do not survey the snapshot") forbade the only one left.
  // `\s+` spans every word gap, not just the one where the source happens to
  // wrap today — the same reflow-tolerance convention the FIX-3 pins below
  // use. An anchor tied to one wrap point reds on a routine rewrap with a
  // message claiming the discovery move is missing, which it is not.
  assert.match(out, /Locate\s+the\s+files\s+your\s+dimension\s+covers/);
  assert.doesNotMatch(out, /do not survey/i);
  // The blacklist above plus the sentence pin are both evadable together:
  // rewriting this branch to "ONLY from the names your review request already
  // gives you. Never explore the snapshot" passes both — and that is verbatim
  // the regression 830bddb exists to prevent, since this branch's review request
  // names no file. Pin the AFFIRMATIVE moves instead: a synonym walks around a
  // blacklist, but it cannot supply a command that does the discovery.
  assert.match(out, /'grep -rn'/, "the discovery move is not given as a runnable command");
  assert.match(out, /'ls -R'/, "the discovery move is not given as a runnable command");
});

// A `stats` object whose `paths` is empty must NOT fall into branch 2 — that
// would print the header with nothing under it. `.length` is the guard.
test("readRules treats an empty paths array as no file list", () => {
  const out = readRules(null, { paths: [] });
  assert.match(out, /No diff file and no file list were captured/);
  assert.doesNotMatch(out, /touched exactly these files/);
});

// A `stats` object that is truthy but carries no `paths` key at all (distinct
// from an empty array) must hit the same fallback. `stats.paths` is its own
// conjunct in the guard, separate from `.length`, and nothing above isolates
// it: every other test's `stats` either has a real `paths` array or is `null`
// outright, so a middle-conjunct deletion (`stats && stats.paths.length`,
// dropping `stats.paths &&`) reads `undefined.length` — a real production
// crash if diff-stats.mjs ever returns a blob without `paths` — and every
// existing test still passes around it.
test("readRules treats a stats object with no paths key as no file list", () => {
  const out = readRules(null, {});
  assert.match(out, /No diff file and no file list were captured/);
  assert.doesNotMatch(out, /touched exactly these files/);
});

// `gh pr view --json files` pages at 100 and exits 0 — measured 100 listed
// against `changedFiles` 124. Branch 2 is the first consumer to put that list in
// front of an agent, and it did so under a closure clause. The files that fell
// off the end vanish undetectably: `stats.files` is short too, so nothing in the
// blob contradicts the sentence.
test("readRules does not claim closure over a list gh truncated", () => {
  const out = readRules(null, { ...PATHS, truncated: 124 });
  assert.doesNotMatch(
    out,
    /touched exactly these files and no others/,
    "a capped file list is still presented as the complete set of changed files",
  );
  assert.match(out, /at\s+least\s+these\s+files/);
  assert.match(out, /capped\s+the\s+list\s+at\s+2\s+of\s+124/, "the cap is not quantified, so it cannot be acted on");
  // Still a usable list — the fix is to stop overclaiming, not to withhold.
  assert.match(out, /scripts\/review-core\.mjs \(115 changed\)/);
});

// `gh pr diff > pr.diff` is a shell REDIRECT: the file exists in every run, in
// the same ${scratch} tree the specialist is pointed at for its own work. A
// rejected diff is still on disk — non-empty when only `wc -l` failed — and "No
// diff file was captured" is then false in the one way that matters: the
// specialist can find the file and has been given no reason not to trust it.
test("readRules names a rejected diff rather than denying a file that exists", () => {
  const out = readRules(null, PATHS, { diffPath: "/s/pr.diff" });
  assert.doesNotMatch(out, /No diff file was captured/, "the diff file exists — the redirect always creates it");
  assert.match(out, /REJECTED/);
  assert.match(out, /\/s\/pr\.diff/, "the rejected file is not named, so the specialist cannot know which one to skip");
  assert.match(out, /Do not read it/);
});

// #1132 review: readRules() lost its `skew` binding, but nothing above
// proves it BY BEHAVIOR — reinserting the deleted head-skew branch verbatim
// passes every test in this file unchanged, because none of them call
// readRules() with a rejected diff AND a present refHead together. Pin the
// combination directly, not just the absence of `refHead` from the source.
test("readRules ignores refHead even when a rejected diff and a head mismatch are both present", () => {
  const out = readRules(null, PATHS, { diffPath: "/s/pr.diff", head: "aaa", diffLines: 40, refHead: "bbb" });
  assert.match(out, /REJECTED — its\s+line\s+count\s+was\s+never\s+reported/);
  assert.doesNotMatch(
    out,
    /describes\s+the\s+PR's\s+head/i,
    "readRules must not attribute the rejection to a head mismatch — that compare belongs to snapshotMissing alone",
  );
  assert.doesNotMatch(out, /\bbbb\b/, "refHead never surfaces in the reason readRules hands to a specialist");
  assert.match(
    out,
    /touched exactly these files and no others/,
    "no skew wording survives — the header is unconditional now",
  );
});

// Two rejections with nothing in common but the verdict — and the snapshot
// schema makes a further shape routine: `diffLines` is declared in that schema's
// `properties` and absent from its `required` list, and the snapshot agent's
// own prompt instructs the omission ("do not withhold one field because
// another failed"), so a run where `gh pr diff` captured the PR's whole change
// and only `wc -l` failed arrives here with no count at all. `usableDiff`
// rejects that diff like the others — deliberately, since the count is the
// only thing that rules out the 0-byte file — but the REASON handed to every
// specialist is a separate question, and a count that measured 0 is the only
// rejection that licenses "it is empty".
//
// The fixture is what these pins turn on, so each spells its own out. The case
// named for the empty diff used to report no count at all — `git show
// f743264:plugin/scripts/review-pr-reads.test.mjs | grep -A2 'distinguishes an
// empty rejected'` — so the empty case went unexercised under its own name,
// and the label it pinned was the conflation (#1131).
test("readRules calls a rejected diff empty only when a count measured it", () => {
  const out = readRules(null, PATHS, { diffPath: "/s/pr.diff", diffLines: 0 });
  assert.match(out, /REJECTED — it is empty/);
  // A complete list — closure is TRUE here and must still be claimed.
  assert.match(out, /touched exactly these files and no others/);
});

// The case the label used to lie about, and the one the snapshot schema's own
// optional `diffLines` makes ordinary: `gh pr diff` can succeed while `wc -l`
// fails, so the file a
// specialist is told not to read may hold the PR's whole change, and "it is
// empty" is then the silent green of `tests 0` served as a review instruction.
// review-core.mjs's diff-decision log already obeys this rule — the pin named
// "the no-diff log reports the raw fields, not a guard it did not measure"
// holds it there — and this is the copy every specialist reads.
test("readRules does not call a rejected diff empty when no count was reported", () => {
  const out = readRules(null, PATHS, { diffPath: "/s/pr.diff" });
  assert.match(out, /REJECTED — its\s+line\s+count\s+was\s+never\s+reported/);
  assert.doesNotMatch(
    out,
    /it is empty/,
    "an unreported count is served as a measured emptiness — every specialist reads that the PR changed nothing",
  );
  // Still rejected: `usableDiff`'s guard is unchanged, and a diff no count
  // measured is still the one file not to read.
  assert.match(out, /Do not read it/);
});

// A run with no diffPath at all is not a rejection: nothing was captured, and
// saying "a diff was captured and rejected" would be a fresh false claim.
test("readRules reports no capture when the snapshot agent reported no diffPath", () => {
  const out = readRules(null, PATHS, {});
  assert.match(out, /No diff file was captured/);
  assert.doesNotMatch(out, /REJECTED/);
});

// The rule is the whole point of the block; it must survive every branch, not
// just the happy one. Assert the imperative and the counting clause, not a word
// that also appears in the surrounding rationale.
test("every branch carries the bounding rule", () => {
  for (const out of [readRules("/s/pr.diff", PATHS), readRules(null, PATHS), readRules(null, null)]) {
    assert.match(out, /BOUND EVERY READ/);
    assert.match(out, /'wc -l' says it is small/);
  }
});

// Bounded at both ends in prose-pin.mjs's between() — an unbounded end runs to
// EOF where the specialist and refuter prompts satisfy it, the defect
// `review-core-testcmd.test.mjs`'s "the test-run prompt hands the command over
// verbatim and rules 'tests 0' a failure" records.
const slice = (from, to) => between(CODE, from, to, "review-core.mjs");

// The snapshot schema's `additionalProperties: false` REJECTS an undeclared
// field, so a prompt that asks for these four while the schema omits them
// silently yields nothing. Both halves have to be pinned or the feature
// disconnects in one token.
test("the snapshot agent asks for the diff facts AND declares them in its schema", () => {
  const snapshot = slice("const snap = await agent(", "if (snap) {");
  // Pinned on `"$RUN"` since #1129: the capture is a shell redirect into a
  // directory the snapshot block's own `mkdir -p` created, and both artefacts
  // hang off the same per-run root, which is what keeps `pr.diff` a SIBLING of
  // the snapshot tree (the relationship the read-rules qualifier below depends
  // on) while stopping two reviews in one session from overwriting each other's.
  assert.match(snapshot, /gh pr diff \$\{pr\} > "?\$RUN"?\/pr\.diff/, "no diff capture");
  // `/headRefOid/` alone also matches the prose ("Report `prHead` = the
  // headRefOid") in the same prompt, so deleting this command left the suite
  // green — pin the command line itself, not a word it shares with prose.
  assert.match(
    snapshot,
    /gh pr view \$\{pr\} --json headRefOid -q \.headRefOid/,
    "no PR head to cross-check against the snapshot's",
  );
  // #1513: the read the caller actually compares the snapshot against. It sits
  // BESIDE the `headRefOid` read above — that field is still reported, and its
  // disagreement with this one is the PR-object desync a controller adjudicates
  // — so the two commands are pinned separately, and each on its own command
  // line rather than on a word ("ls-remote", "headRefName") the surrounding
  // prose also carries.
  assert.match(
    snapshot,
    /branch=\$\(gh pr view \$\{pr\} --json headRefName -q \.headRefName\)/,
    "no branch-name read — `refs/heads/$branch` then names no ref, and every PR falls through to the PR-ref read instead of reporting the branch ref #1513 chose",
  );
  // #1616 made this pair ORDERED rather than a single line, so all three facts
  // are pinned: the branch read captures into `$ref` (uncaptured, the fallback
  // below can never see that it succeeded), the fallback is GUARDED on that
  // capture being empty, and the branch read comes FIRST. Order is not
  // decoration — reversed, every same-repo PR pays a second network read and
  // reports an operand read from a different ref than #1513 chose, which no
  // "both lines present" pin would notice.
  const branchRead = /ref=\$\(git -C \$\{worktree\} ls-remote origin "refs\/heads\/\$branch" \| cut -f1\)/;
  const prRefRead = /\[ -n "\$ref" \] \|\| ref=\$\(git -C \$\{worktree\} ls-remote origin "refs\/pull\/\$\{pr\}\/head" \| cut -f1\)/;
  assert.match(
    snapshot,
    branchRead,
    "no captured branch-ref read — the head compare is back on the PR object's lagging headRefOid (#1513), or the fallback can no longer tell whether this read answered",
  );
  assert.match(
    snapshot,
    prRefRead,
    "no guarded PR-ref fallback — a fork PR's branch resolves nowhere on `origin`, so refHead goes permanently absent and the wrong-commit backstop cannot fire for any fork (#1616)",
  );
  assert.ok(
    snapshot.search(branchRead) < snapshot.search(prRefRead),
    "the PR-ref read no longer comes SECOND — a same-repo PR must not pay a second network read, and must keep reporting the branch ref #1513 made the operand (#1616)",
  );
  assert.match(
    snapshot,
    /^\s*echo "\$ref"$/m,
    "the resolved ref is never printed — both reads run and the agent has no line to report `refHead` from",
  );
  assert.match(snapshot, /wc -l < "?\$RUN"?\/pr\.diff/, "no line count — a 0-byte diff would pass as usable");
  // Scoped to `SNAPSHOT_SCHEMA.properties` directly — a real import now,
  // never a second copy of its JSON re-parsed from source text. Declaring a
  // field ANYWHERE else — beside `required`, in the options bag — leaves it
  // undeclared as far as `additionalProperties: false` is concerned.
  for (const field of ["diffPath", "diffLines", "refHead", "prHead"]) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(SNAPSHOT_SCHEMA.properties, field),
      `${field} is not declared in SNAPSHOT_SCHEMA.properties — additionalProperties:false drops it`,
    );
  }
  // Declared beside them, but not one of them: `pathVerified` and
  // `repoVerified` belong to `required`, not to the gh-failure set, so they are
  // pinned on their own rather than folded into the loop above — whose comment,
  // and the one below, both read "these four". Only `required` membership was
  // pinned when `pathVerified` was added (#140); `additionalProperties: false`
  // is what makes the DECLARATION mandatory too, for every field this schema
  // carries. `repoError` is optional by design — a verified snapshot has
  // nothing to say there — but an undeclared field the agent reports anyway is
  // dropped, so it needs the same declaration pin (#1056).
  for (const field of ["pathVerified", "repoVerified", "repoError"]) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(SNAPSHOT_SCHEMA.properties, field),
      `${field} is not declared in SNAPSHOT_SCHEMA.properties — additionalProperties:false drops it`,
    );
  }
  // The review must survive a gh failure. Those three stay out of `required`.
  // `pathVerified` joins path+head instead (#140) — a caller check on whether
  // the snapshot exists, not a `gh` fact that can legitimately be absent — and
  // `repoVerified` joins them on the same rule (#1056): whether the snapshot is
  // a git repository holding the reviewed tree is a check, not a network fact,
  // and an omitted boolean must not read as a verified measurement environment.
  assert.deepEqual(
    SNAPSHOT_SCHEMA.required,
    ["runRoot", "path", "head", "pathVerified", "repoVerified"],
    "required must stay path+head+pathVerified+repoVerified only",
  );
  // Commands pinned, schema pinned — and the INSTRUCTION between them was not.
  // Measured: deleting this paragraph outright left this file at 12 pass, 0
  // fail. The commands still run, the schema still accepts the fields, and
  // nothing tells the agent to report any of them, so all four come back
  // omitted, `usableDiff` returns null on every run forever, and the feature
  // degrades to branch 2 under a green suite. `\s+` spans the line wraps so a
  // reflow of the same sentences stays green; the words are what is pinned.
  // These names live inside a template literal, so each backtick is a
  // BACKSLASH-backtick in the source text — `\\?` matches it either way.
  const B = "\\\\?`";
  for (const [re, missing] of [
    [
      // The measured escape for this one was re-inserting the paragraph verbatim
      // inside a `/* */` block — which starts its line with `/*`, not `//`, so a
      // `//`-only anchor would have stayed green. Handled once by CODE now,
      // rather than by an anchor each future assertion has to remember.
      // The run root, not `scratch`: #1129 moved every artefact of a run onto a
      // per-run root, and a pin left on the bare root would go green again on
      // exactly the regression it exists to stop — the diff capture sliding
      // back to a path two reviews in one session share.
      `Report\\s+${B}diffPath${B}\\s+=\\s+the\\s+SNAPSHOT_RUN_ROOT\\s+value\\s+with\\s+'/pr\\.diff'\\s+appended,\\s+ONLY\\s+if\\s+'gh pr diff'\\s+exited\\s+0`,
      "diffPath is not both bound to a value and gated on the exit code — the agent must infer the path from the redirect target",
    ],
    [
      `${B}refHead${B}\\s+=\\s+the\\s+sha\\s+the\\s+'echo\\s+"\\$ref"'\\s+line\\s+printed`,
      "refHead's value is not bound to the ref read — the commands run and nothing tells the agent to report what they printed (#1513)",
    ],
    [
      // An empty string reported as `refHead` is FALSY, so the compare skips on
      // it exactly as it does on an absent field — but the run log's `??` does
      // not catch it, so the skip prints as a blank instead of naming itself.
      // Since #1616 `refHead` can also be OMITTED because the branch-ref read
      // never ran at all — a cross-repo PR skips it outright — so "every read
      // this PR was entitled to" is what covers both a same-repo PR whose two
      // reads both came back empty and a cross-repo PR whose one read did.
      `Omit\\s+${B}refHead${B}\\s+when\\s+every\\s+read\\s+this\\s+PR\\s+was\\s+entitled\\s+to\\s+came\\s+back\\s+empty`,
      "a PR is not told to omit refHead when every read it was entitled to came back empty — the head check then skips without saying so",
    ],
    [`${B}prHead${B}\\s+=\\s+the\\s+headRefOid`, "prHead's value is not bound to the headRefOid"],
    [`${B}diffLines${B}\\s+=\\s+the\\s+wc\\s+-l\\s+count`, "diffLines' value is not bound to the wc -l count"],
    [
      "do\\s+not\\s+withhold\\s+one\\s+field\\s+because\\s+another\\s+failed",
      "one gh failure can suppress the fields that succeeded",
    ],
  ])
    assert.match(snapshot, new RegExp(re, "m"), missing);
});

// The functions are worthless if nothing calls them, and a text-lift pin tests a
// COPY: it stays green while the feature disconnects. Pin the CALL SITES.
test("the specialist prompt interpolates the read rules", () => {
  const prompt = slice("READ ONLY FROM THE SNAPSHOT", "Scratch files go in");
  assert.match(prompt, /\$\{readRules\(usableDiff\(snap\), stats, snap\)\}/);
  // `pr.diff` is a SIBLING of the snapshot tree, not a child of it — reading it
  // under an unqualified "READ ONLY FROM THE SNAPSHOT" is the exact
  // contradiction this branch's headline fix removes. Bound to the clause
  // itself (the `)` closing the HEAD parenthetical, then the qualifier), not
  // to "diff" appearing anywhere in the prompt: the `readRules` interpolation
  // this same prompt carries contains "Diff" in its own text, so a
  // presence-only check would stay green against a qualifier reading
  // "— nothing else." — which restores the original contradiction outright.
  // `\s+` between every word so a reflow of the same sentence stays green.
  assert.match(
    prompt,
    /READ ONLY FROM THE SNAPSHOT:[\s\S]*?\)\s+—\s+plus\s+the\s+diff\s+file\s+named\s+below,\s+if\s+one\s+is\s+given\./,
    "the SNAPSHOT permission is not qualified to admit the diff file named below — the sibling-file contradiction FIX-1 removed is back",
  );
});

test("the refuter prompt interpolates the same read rules", () => {
  const prompt = slice("Try to REFUTE this finding", "Scratch: ");
  assert.match(prompt, /\$\{readRules\(usableDiff\(snap\), stats, snap\)\}/);
});

// Nothing pinned this line, and its own comment says the feature is unobservable
// without it: deleting the whole `log()` call left the repo-wide suite at
// 283/283. That is how it shipped stating a measurement never taken — the clause
// chain printed `diff is 0 lines` for an ABSENT `diffLines`, so a run where
// `gh pr diff` produced 500 real lines and only `wc -l` failed read as an empty
// PR and nobody looked at `wc`. Both deferred follow-ups in the spec read this
// line for their evidence. Shape from `select-dimensions.test.mjs`'s
// `reviewDispatchOptions`: match the call, then assert on what it prints.
test("the no-diff log reports the raw fields, not a guard it did not measure", () => {
  const m = CODE.match(/^\s*log\(\n\s*usable[\s\S]*?^\s*\);$/m);
  assert.ok(m, "the diff-decision log line is gone — `usableDiff` returning null forever is then invisible");
  for (const field of ["diffPath", "diffLines", "refHead", "prHead"]) {
    assert.match(
      m[0],
      new RegExp(`${field}=\\$\\{snap\\.${field}`),
      `the no-diff log does not print raw ${field} — the reader cannot tell absent from zero`,
    );
  }
  // The exact regression: a message asserting a count that was never reported.
  assert.doesNotMatch(
    m[0],
    /diff is 0 lines/,
    "an absent diffLines is reported as a measured 0 — a failed read and an empty read are indistinguishable again",
  );
  assert.match(m[0], /\(absent\)/, "an omitted field prints as empty rather than saying it was omitted");
});

