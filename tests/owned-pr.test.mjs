// Regression gate for owned-pr.mjs, the Owned PR rule every reader imports.
// Zero deps: `node --test tests/owned-pr.test.mjs`.
//
// The CLI suites reach isOwnedPr() only after loginOf() has refused an empty
// login, so the rule's own guards are pinned here, on the functions alone.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isOwnedPr, loginOf, ownershipReadable } from "../plugin/scripts/owned-pr.mjs";

test("loginOf: the trimmed login, or null when gh printed none", () => {
  assert.equal(loginOf("octo\n"), "octo");
  assert.equal(loginOf("  \n"), null);
  assert.equal(loginOf(""), null);
  assert.equal(loginOf(undefined), null);
  assert.equal(loginOf(null), null);
});

test("ownershipReadable: a null or string-login author and a boolean draft flag; anything else is unreadable", () => {
  assert.equal(ownershipReadable({ author: { login: "octo" }, isDraft: false }), true);
  assert.equal(ownershipReadable({ author: null, isDraft: true }), true);
  for (const row of [null, [], { isDraft: false }, { author: "octo", isDraft: false }, { author: {}, isDraft: false }, { author: [], isDraft: false },
    { author: { login: 7 }, isDraft: false }, { author: { login: "octo" } }, { author: { login: "octo" }, isDraft: "false" }]) {
    assert.equal(ownershipReadable(row), false, JSON.stringify(row));
  }
});

test("isOwnedPr: authored by the login and not a draft; an absent or malformed field is not owned", () => {
  assert.equal(isOwnedPr({ author: { login: "octo" }, isDraft: false }, "octo"), true);
  assert.equal(isOwnedPr({ author: { login: "octo" }, isDraft: true }, "octo"), false);
  assert.equal(isOwnedPr({ author: { login: "other" }, isDraft: false }, "octo"), false);
  assert.equal(isOwnedPr({ author: null, isDraft: false }, "octo"), false);
  assert.equal(isOwnedPr({ isDraft: false }, "octo"), false);
  assert.equal(isOwnedPr({ author: { login: "octo" } }, "octo"), false);
  assert.equal(isOwnedPr({ author: { login: "octo" }, isDraft: "false" }, "octo"), false);
});

test("isOwnedPr: an empty or absent login owns nothing, even a PR whose author login is empty", () => {
  assert.equal(isOwnedPr({ author: { login: "" }, isDraft: false }, ""), false);
  assert.equal(isOwnedPr({ author: { login: "octo" }, isDraft: false }, ""), false);
  assert.equal(isOwnedPr({ author: { login: "octo" }, isDraft: false }, undefined), false);
});
