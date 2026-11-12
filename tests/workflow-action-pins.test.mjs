// ADR 0039. Renovate moves every action `uses:` ref in `.github/workflows/`,
// and it can only do that quietly — one PR, one dependency, automerged when
// the change is not a major — if each ref is an exact commit the bot rewrites
// and a comment it keeps in step. Two properties of the workflow files, read
// here as DATA with targeted patterns (this repo has no YAML dependency; a
// commented-out ref is never read, since a line counts only when `uses:` or
// `- uses:` opens it):
//
//   (a) every `uses:` is `owner/repo@<40-hex SHA> # vX.Y.Z`. A tag ref
//       (`@v5`) moves under the workflow with no commit recording it — the
//       silent drift ADR 0010 refuses — and a SHA without the version comment
//       leaves the bot and the reader without the release it is meant to be;
//   (b) the SAME-REF rule: every action used in a workflow other than ci.yml is
//       used in ci.yml at the identical SHA. release.yml runs after merge,
//       pin-drift.yml on a schedule, and release-label.yml runs the base
//       branch's copy (`pull_request_target`), so none of them runs a bumped
//       action before the merge. Renovate puts one dependency at one version
//       into one branch across every file, so under this rule each bump also
//       changes ci.yml, whose checks the `main` ruleset requires — the new ref
//       is exercised before it merges.
//
// A local action (`uses: ./path`) has no ref to pin and is exempt; a
// reusable-workflow or docker reference is not, and reds on (a).
//
// Not checked, because only the network can: that a SHA is the commit its
// `# vX.Y.Z` comment names. The PR's own required checks running on the
// pinned workflows are the proof that the refs resolve.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const WORKFLOWS = ".github/workflows";
const CI = `${WORKFLOWS}/ci.yml`;
// GitHub Actions runs a workflow file named `.yml` or `.yaml`, so both are read.
const WORKFLOW_FILE = /\.ya?ml$/;

const SHA = /^[0-9a-f]{40}$/;
const VERSION_COMMENT = /^v\d+\.\d+\.\d+$/;

// `- uses: ref # comment`, `uses: "ref"` — the value, then an optional
// trailing comment. A `uses:` buried in a `run: |` block scalar is shaped the
// same and read the same; no workflow here carries one.
const USES = /^\s*(?:-\s+)?uses:\s*(["']?)([^\s"'#]+)\1[ \t]*(?:#[ \t]*(.*?)[ \t]*)?$/;

function usesOf(text) {
  const found = [];
  for (const line of text.split("\n")) {
    const m = line.match(USES);
    if (!m) continue;
    const [, , value, comment] = m;
    if (value.startsWith("./")) continue;
    const at = value.lastIndexOf("@");
    found.push({
      value,
      action: at === -1 ? value : value.slice(0, at),
      ref: at === -1 ? "" : value.slice(at + 1),
      comment: comment ?? "",
    });
  }
  return found;
}

function pinProblems(files) {
  const problems = [];
  if (files[CI] === undefined) return [`${CI}: not found — the same-ref rule is measured against it`];
  const ciRefs = new Map();
  for (const { action, ref } of usesOf(files[CI])) {
    ciRefs.set(action, new Set([...(ciRefs.get(action) ?? []), ref]));
  }

  for (const [file, text] of Object.entries(files)) {
    for (const { value, action, ref, comment } of usesOf(text)) {
      if (!SHA.test(ref)) {
        problems.push(`${file}: \`uses: ${value}\` is not pinned to a 40-hex commit SHA (ref \`${ref}\`)`);
      } else if (!VERSION_COMMENT.test(comment)) {
        problems.push(
          `${file}: \`uses: ${value}\` has no \`# vX.Y.Z\` comment naming its release (comment ${JSON.stringify(comment)})`,
        );
      }
      if (file === CI) continue;
      const used = ciRefs.get(action);
      if (!used) {
        problems.push(`${file}: \`${action}\` is used here but not in ${CI} — a bump of it would not run in the required checks`);
      } else if (!used.has(ref)) {
        problems.push(`${file}: \`${action}@${ref}\` is not the ref ${CI} uses [${[...used]}] — same-ref rule`);
      }
    }
  }
  return problems;
}

const REAL = Object.fromEntries(
  readdirSync(join(ROOT, WORKFLOWS))
    .filter((name) => WORKFLOW_FILE.test(name))
    .map((name) => [`${WORKFLOWS}/${name}`, readFileSync(join(ROOT, WORKFLOWS, name), "utf8")]),
);

const report = (problems) => `\n  ${problems.join("\n  ")}`;
const assertClean = (files) => {
  const problems = pinProblems(files);
  assert.deepEqual(problems, [], `the workflow pins are broken:${report(problems)}`);
};
const assertBroken = (files, file, pattern) => {
  const problems = pinProblems(files);
  assert.ok(
    problems.some((p) => p.startsWith(`${file}:`) && pattern.test(p)),
    `expected a problem naming ${file} matching ${pattern}, got:${report(problems)}`,
  );
};

// A literal, checked edit: a mutant whose target text has drifted away would
// otherwise leave the file unchanged and assert against the real tree.
const swap = (text, from, to) => {
  assert.ok(text.includes(from), `mutation target \`${from}\` not found — update this test's mutant`);
  return text.split(from).join(to);
};
const checkoutRef = (text) => text.match(/actions\/checkout@([0-9a-f]{40})/)?.[1];
const RELEASE = `${WORKFLOWS}/release.yml`;

test("every workflow in the tree pins its actions by SHA with a version comment, and agrees with ci.yml", () => {
  assert.ok(Object.keys(REAL).length > 1, "no workflows read");
  assertClean(REAL);
});

test("a `.yaml` workflow is read as well as a `.yml` one, and nothing else is", () => {
  for (const name of ["ci.yml", "extra.yaml"]) assert.ok(WORKFLOW_FILE.test(name), `${name} is not read`);
  for (const name of ["README.md", "notes.yml.bak"]) assert.ok(!WORKFLOW_FILE.test(name), `${name} is read`);
});

test("a tag ref in any workflow reds, naming the file and the ref", () => {
  for (const file of Object.keys(REAL)) {
    const text = REAL[file];
    const [first] = usesOf(text);
    if (!first) continue;
    assertBroken({ ...REAL, [file]: swap(text, `${first.action}@${first.ref}`, `${first.action}@v5`) }, file, /not pinned to a 40-hex commit SHA \(ref `v5`\)/);
  }
});

test("a SHA with no version comment, or a malformed one, reds", () => {
  const sha = checkoutRef(REAL[RELEASE]);
  assertBroken({ ...REAL, [RELEASE]: swap(REAL[RELEASE], `actions/checkout@${sha} # v5.1.0`, `actions/checkout@${sha}`) }, RELEASE, /no `# vX.Y.Z` comment/);
  assertBroken({ ...REAL, [RELEASE]: swap(REAL[RELEASE], `actions/checkout@${sha} # v5.1.0`, `actions/checkout@${sha} # v5`) }, RELEASE, /no `# vX.Y.Z` comment/);
});

test("release.yml at a SHA ci.yml does not use reds, naming release.yml and the ref", () => {
  const sha = checkoutRef(REAL[RELEASE]);
  const other = "0".repeat(40);
  assertBroken({ ...REAL, [RELEASE]: swap(REAL[RELEASE], sha, other) }, RELEASE, new RegExp(`actions/checkout@${other}\` is not the ref`));
});

test("ci.yml using one action at two refs: another workflow at the earlier of them stays green", () => {
  const later = "c".repeat(40);
  assertClean({ ...REAL, [CI]: `${REAL[CI]}\n      - uses: actions/checkout@${later} # v5.0.0\n` });
});

test("a `uses:` that is not its step's first key is read too: a tag ref there reds", () => {
  assertBroken(
    { ...REAL, [CI]: `${REAL[CI]}\n      - name: a key before uses\n        uses: actions/checkout@v5\n` },
    CI,
    /`uses: actions\/checkout@v5` is not pinned to a 40-hex commit SHA/,
  );
});

test("an action used outside ci.yml but not in ci.yml reds", () => {
  assertBroken(
    { ...REAL, [RELEASE]: `${REAL[RELEASE]}\n      - uses: owner/tool@${"a".repeat(40)} # v1.2.3\n` },
    RELEASE,
    /`owner\/tool` is used here but not in/,
  );
});

test("ci.yml missing reds rather than passing the same-ref rule vacuously", () => {
  const { [CI]: _ci, ...rest } = REAL;
  assert.ok(pinProblems(rest).some((p) => p.startsWith(`${CI}: not found`)));
});

test("input it must accept: a local action, a commented-out tag ref, a subpath action, a quoted ref", () => {
  const sha = "b".repeat(40);
  const tail = [
    "      - uses: ./.github/actions/local",
    "      # - uses: actions/checkout@v5",
    `      - uses: owner/repo/sub/path@${sha} # v1.2.3`,
    `      - uses: "owner/quoted@${sha}" # v2.0.0`,
    "      - run: echo uses is a word here",
  ].join("\n");
  assertClean({ ...REAL, [CI]: `${REAL[CI]}\n${tail}\n`, [RELEASE]: `${REAL[RELEASE]}\n${tail}\n` });
});
