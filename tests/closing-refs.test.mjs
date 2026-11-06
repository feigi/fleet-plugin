import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ownClosingIssues, commitClosingIssues } from "../plugin/scripts/closing-refs.mjs";
import { ref, prUrl, commit } from "./support/queue-gh.mjs";

const FOREIGN = "other-org/other-repo";
const urlless = (r) => {
  const { url: _url, ...rest } = r;
  return rest;
};

test("own-repository references are kept, unique, in GitHub's order", () => {
  assert.deepEqual(ownClosingIssues(7, prUrl(7), [ref(3), ref(1), ref(3), ref(2)]), [3, 1, 2]);
  assert.deepEqual(ownClosingIssues(7, prUrl(7), []), []);
});

test("another repository's references are dropped, whatever their number", () => {
  assert.deepEqual(ownClosingIssues(7, prUrl(7), [ref(3, FOREIGN)]), []);
  assert.deepEqual(ownClosingIssues(7, prUrl(7), [ref(3, FOREIGN), ref(4), ref(5, "other-org/own-repo")]), [4]);
});

test("a reference with a url is placed by its url alone", () => {
  // Its repository says own; its url says another repository's issue, or
  // another issue than its number.
  for (const url of ["https://github.com/other-org/other-repo/issues/3", "https://github.com/fleet-test/own-repo/issues/9999", "https://github.com/fleet-test/own-repo-2/issues/3", "https://github.com/fleet-test/own-repo/issues/31"]) {
    assert.deepEqual(ownClosingIssues(7, prUrl(7), [{ ...ref(3), url }]), [], url);
  }
});

test("a reference with no url, or an empty one, is placed by its repository's owner and name", () => {
  assert.deepEqual(ownClosingIssues(7, prUrl(7), [urlless(ref(3))]), [3]);
  assert.deepEqual(ownClosingIssues(7, prUrl(7), [{ ...ref(3), url: "" }]), [3]);
  for (const repo of [FOREIGN, "other-org/own-repo", "leet-test/own-repo"]) {
    assert.deepEqual(ownClosingIssues(7, prUrl(7), [urlless(ref(3, repo))]), [], repo);
  }
});

test("a reference with no integer number is refused, never taken for an own issue", () => {
  const { number: _n, ...unnumbered } = ref(3);
  for (const bad of [unnumbered, { ...ref(3), number: "3" }, { ...ref(3), number: 3.5 }, null, {}]) {
    assert.throws(() => ownClosingIssues(7, prUrl(7), [ref(1), bad]), { message: "a reference with no issue number" }, JSON.stringify(bad));
  }
});

test("a reference with neither a url nor a repository to place it by is refused", () => {
  const { url: _url, repository: _repository, ...unplaced } = ref(3);
  const blank = { ...ref(3), url: "", repository: { ...ref(3).repository, name: "" } };
  const ownerless = { ...urlless(ref(3)), repository: { name: "own-repo" } };
  for (const bad of [unplaced, blank, ownerless]) {
    assert.throws(() => ownClosingIssues(7, prUrl(7), [bad]), { message: "a reference to #3 with neither a url nor a repository" }, JSON.stringify(bad));
  }
});

test("a PR url that does not end /pull/<pr> is refused, whatever the references", () => {
  assert.throws(() => ownClosingIssues(7, prUrl(8), []), { message: `url ${prUrl(8)}, not PR #7's` });
  assert.throws(() => ownClosingIssues(7, undefined, [ref(3)]), { message: "url undefined, not PR #7's" });
});

test("a closing-references value that is not an array is refused", () => {
  assert.throws(() => ownClosingIssues(7, prUrl(7), ""), { message: "no closingIssuesReferences array" });
});

// -- commitClosingIssues ------------------------------------------------------

test("a commit's closing keyword names its issue, with the first commit that names it, in the order met", () => {
  const found = commitClosingIssues([
    commit("aaa1111", "work", "Closes #7\n\nand fixes #9"),
    commit("bbb2222", "Resolves #9, closed #7", ""),
    commit("ccc3333", "fixed #4"),
  ]);
  assert.deepEqual(found, [{ number: 7, oid: "aaa1111" }, { number: 9, oid: "aaa1111" }, { number: 4, oid: "ccc3333" }]);
  assert.deepEqual(commitClosingIssues([]), []);
});

test("every keyword form counts, in any case, with an optional colon and optional whitespace before #N", () => {
  const forms = ["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved", "CLOSES", "Fixes"];
  for (const word of forms) {
    for (const colon of ["", ":"]) {
      for (const gap of ["", " ", "  ", "\t"]) {
        const text = `${word}${colon}${gap}#5`;
        assert.deepEqual(commitClosingIssues([commit("abc1234", text)]), [{ number: 5, oid: "abc1234" }], JSON.stringify(text));
      }
    }
  }
  assert.deepEqual(commitClosingIssues([commit("abc1234", "x", "line one\n(fixes #6)")]), [{ number: 6, oid: "abc1234" }]);
});

test("a headline gh cut short is joined back to the rest of it the body opens with", () => {
  const subject = "feat: tighten the readers of the settle and the gate, closes #3637";
  const cutAt = (n) => commit("abc1234", `${subject.slice(0, n)}…`, `…${subject.slice(n)}\n\nand the rest of the body`);
  for (const n of [subject.indexOf("closes") + 3, subject.indexOf("#"), subject.indexOf("#") + 3]) {
    assert.deepEqual(commitClosingIssues([cutAt(n)]), [{ number: 3637, oid: "abc1234" }], `cut at ${JSON.stringify(subject.slice(n))}`);
  }
  assert.deepEqual(commitClosingIssues([commit("abc1234", "the work, fix…", "…es #5")]), [{ number: 5, oid: "abc1234" }]);
  assert.deepEqual(commitClosingIssues([commit("abc1234", "the work, fix…", "es #5")]), [], "a body not opening with … is a line of its own");
  assert.deepEqual(commitClosingIssues([commit("abc1234", "the work, fix", "…es #5")]), [], "a headline not ending in … is a line of its own");
});

test("a keyword inside a larger word, a bare #N, Refs, another repository's reference and a URL close nothing", () => {
  for (const text of [
    "bugfix #5", "prefix #5", "unresolved #5", "disclose #5", "re_fix #5", "fix9 #5", "9fix #5", "1closes #5",
    "see #5", "#5", "Refs #5", "refs #5", "issue #5",
    "closes owner/repo#5", "fixes other-org/other-repo#5", "closes https://github.com/o/r/issues/5",
    "closes\n#5", "closes:\n#5", "closes #", "closes five",
  ]) {
    assert.deepEqual(commitClosingIssues([commit("abc1234", text)]), [], JSON.stringify(text));
    assert.deepEqual(commitClosingIssues([commit("abc1234", "x", text)]), [], `body ${JSON.stringify(text)}`);
  }
});

test("it names what drop-merged-label.sh's commit scan names, on the same texts", () => {
  const scan = join(dirname(fileURLToPath(import.meta.url)), "..", "plugin", "scripts", "drop-merged-label.sh");
  const shell = readFileSync(scan, "utf8").match(/grep -Eio '([^']*close\[sd\]\?[^']*)'/)?.[1];
  assert.ok(shell, "the shell's keyword pattern is found");
  const texts = [
    "Closes #1", "bugfix #2", "prefix #3", "x fixes #4, resolved #5", "closes\t#6", "fix  #7", "FIXED #8",
    "closes owner/repo#9", "(closes #10)", "a\ncloses #11\nb", "closes #12 and closes #13", "_fixes #14", "closes #15abc",
    "9fix #16", "1closes #17",
  ];
  for (const text of texts) {
    const r = spawnSync("sh", ["-c", `printf '%s\\n' "$1" | LC_ALL=C grep -Eio '${shell}' | grep -Eo '[0-9]+'`, "sh", text], { encoding: "utf8" });
    assert.ok(r.status === 0 || r.status === 1, `the shell scan of ${JSON.stringify(text)} exited ${r.status}: ${r.stderr}`);
    assert.equal(r.stderr, "", `the shell scan of ${JSON.stringify(text)} wrote to stderr`);
    const fromShell = r.stdout.split("\n").filter(Boolean).map(Number);
    const fromJs = commitClosingIssues([commit("abc1234", text)]).map((c) => c.number);
    assert.deepEqual(fromJs, [...new Set(fromShell)], JSON.stringify(text));
  }
});

test("a number past the safe integers names no issue, so it closes nothing", () => {
  assert.deepEqual(commitClosingIssues([commit("abc1234", "closes #99999999999999999999")]), []);
  assert.deepEqual(commitClosingIssues([commit("abc1234", "closes #99999999999999999999, fixes #4")]), [{ number: 4, oid: "abc1234" }]);
});

test("a commits value that is not a list of messaged, oid'd commits is refused", () => {
  assert.throws(() => commitClosingIssues(undefined), { message: "no list of commits" });
  assert.throws(() => commitClosingIssues({ length: 0 }), { message: "no list of commits" });
  assert.throws(() => commitClosingIssues([{ messageHeadline: "x" }]), { message: "a commit with no oid" });
  assert.throws(() => commitClosingIssues([null]), { message: "a commit with no oid" });
  assert.throws(() => commitClosingIssues([{ oid: "", messageHeadline: "x" }]), { message: "a commit with no oid" });
  assert.throws(() => commitClosingIssues([{ oid: "abc1234", messageBody: "" }]), { message: "commit abc1234 with no message" });
  assert.throws(() => commitClosingIssues([{ oid: "abc1234", messageHeadline: "x", messageBody: 3 }]), { message: "commit abc1234 with no message" });
  assert.deepEqual(commitClosingIssues([{ oid: "abc1234", messageHeadline: "closes #2", messageBody: null }]), [{ number: 2, oid: "abc1234" }], "a null body is an empty one");
});
