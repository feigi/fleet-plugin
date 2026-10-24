// A `gh` stub for `ledger.mjs dispatch`. `gh pr list` answers `prs` as the
// open `ready-to-merge` queue `dispatch merge-bot` records. A finisher dispatch
// reads four more answers: `gh pr view <n> --json closingIssuesReferences,url`,
// `gh issue view <n> --json title`, `gh pr view <n> --json labels` and the
// repository's label list, `gh label list --json name --limit <limit>`. They
// default to a PR in `OWN_REPO` that closes nothing and carries `patch`, an
// issue titled `issue <n>`, and a repository defining all three release
// labels; `closes`, `titled`, `labelled` and `defines` set them per test, and
// `failsOn` makes any of them fail. Any other gh call fails loudly. Every call
// is appended to `<bin>/calls`, so a test can assert that a refusal made none.
//
// Shell builtins plus one link: the finisher gate resolves the ledger's repository through git, so the stub bin holds the real git too.
//
// Deliberately not a `.test.mjs`, so `node --test` never loads it as a suite.

import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { writeExecStub } from "./exec-stub.mjs";
import { LABEL_LIST_ARGS } from "../../plugin/scripts/release-labels.mjs";

/** The repository, as `owner/name`, every PR the stub answers for is in. */
const OWN_REPO = "fleet-test/own-repo";

/** `pr`'s url, as gh answers it for a PR in `OWN_REPO`. */
export const prUrl = (pr) => `https://github.com/${OWN_REPO}/pull/${pr}`;

/**
 * One `closingIssuesReferences` element in gh's own shape: issue `number` of
 * `repo` (`owner/name`), with its `repository` and `url`.
 */
export function ref(number, repo = OWN_REPO) {
  const [login, name] = repo.split("/");
  return {
    id: `I_${login}_${name}_${number}`,
    number,
    repository: { id: `R_${login}_${name}`, name, owner: { id: `U_${login}`, login } },
    url: `https://github.com/${repo}/issues/${number}`,
  };
}

/**
 * Writes `<bin>/gh` answering `gh pr list` with the PR numbers `prs`, plus
 * `gh pr view`, `gh issue view` and `gh label list` as described above, and
 * links the real git into `<bin>`.
 */
export function writeQueueGh(bin, prs = []) {
  const git = spawnSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  if (!existsSync(join(bin, "git"))) symlinkSync(git, join(bin, "git"));
  writeExecStub(join(bin, "gh"), `#!/bin/sh
printf '%s\\n' "$*" >> '${bin}/calls'
case "$1 $2" in
"pr list")
  printf '%s\\n' '${JSON.stringify(prs.map((number) => ({ number })))}' ;;
"pr view")
  case "$4 $5" in
  "--json closingIssuesReferences,url")
    f='${bin}/pr-'"$3"
    [ -f "$f.fail" ] && { printf 'gh stub: pr view %s failed\\n' "$3" >&2; exit 1; }
    if [ -f "$f.json" ]; then /bin/cat "$f.json"; else printf '{"closingIssuesReferences":[],"url":"${prUrl("")}%s"}\\n' "$3"; fi ;;
  "--json labels")
    f='${bin}/labels-'"$3"
    [ -f "$f.fail" ] && { printf 'gh stub: pr view %s labels failed\\n' "$3" >&2; exit 1; }
    if [ -f "$f.json" ]; then /bin/cat "$f.json"; else printf '{"labels":[{"name":"patch"}]}\\n'; fi ;;
  *) printf 'gh stub: unexpected gh %s\\n' "$*" >&2; exit 64 ;;
  esac ;;
"issue view")
  [ "$4 $5" = "--json title" ] || { printf 'gh stub: unexpected gh %s\\n' "$*" >&2; exit 64; }
  f='${bin}/issue-'"$3"
  [ -f "$f.fail" ] && { printf 'gh stub: issue view %s failed\\n' "$3" >&2; exit 1; }
  if [ -f "$f.json" ]; then /bin/cat "$f.json"; else printf '{"title":"issue %s"}\\n' "$3"; fi ;;
"label list")
  [ "$*" = "${LABEL_LIST_ARGS.join(" ")}" ] || { printf 'gh stub: unexpected gh %s\\n' "$*" >&2; exit 64; }
  f='${bin}/label-list'
  [ -f "$f.fail" ] && { printf 'gh stub: label list failed\\n' >&2; exit 1; }
  if [ -f "$f.json" ]; then /bin/cat "$f.json"; else printf '[{"name":"patch"},{"name":"minor"},{"name":"major"}]\\n'; fi ;;
*) printf 'gh stub: unexpected gh %s\\n' "$*" >&2; exit 64 ;;
esac
`);
}

/**
 * Answers `gh pr view <pr> --json closingIssuesReferences,url` with the PR's
 * url and `refs`: each an issue number in `OWN_REPO`, or a reference object
 * as it stands — `ref(n, "other/repo")` for another repository's issue.
 */
export function closes(bin, pr, refs) {
  const closing = refs.map((r) => (typeof r === "number" ? ref(r) : r));
  writeFileSync(join(bin, `pr-${pr}.json`), JSON.stringify({ closingIssuesReferences: closing, url: prUrl(pr) }));
}

/** Answers `gh issue view <n> --json title` with `title`. */
export function titled(bin, n, title) {
  writeFileSync(join(bin, `issue-${n}.json`), JSON.stringify({ title }));
}

/**
 * Answers `gh pr view <pr> --json labels` with the label names `names`, or
 * with `names` itself when it is a string — an answer gh never gives.
 */
export function labelled(bin, pr, names) {
  const answer = typeof names === "string" ? names : JSON.stringify({ labels: names.map((name) => ({ name })) });
  writeFileSync(join(bin, `labels-${pr}.json`), answer);
}

/**
 * Answers `gh label list` with the label names `names`, or with `names`
 * itself when it is a string — an answer gh never gives.
 */
export function defines(bin, names) {
  const answer = typeof names === "string" ? names : JSON.stringify(names.map((name) => ({ name })));
  writeFileSync(join(bin, "label-list.json"), answer);
}

/**
 * Makes gh's answer for `<kind>` `<n>` fail: `pr` or `issue` `<n>`, `labels`
 * for PR `<n>`'s labels, or `label` `list` for the repository's label list.
 */
export function failsOn(bin, kind, n) {
  writeFileSync(join(bin, `${kind}-${n}.fail`), "");
}

/** Every gh call the stub has answered, one command line each. */
export function ghCalls(bin) {
  const log = join(bin, "calls");
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
}
