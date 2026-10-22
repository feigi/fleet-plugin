import { test } from "node:test";
import assert from "node:assert/strict";
import { ownClosingIssues } from "../plugin/scripts/closing-refs.mjs";
import { ref, prUrl } from "./support/queue-gh.mjs";

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
