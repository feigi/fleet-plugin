// A `gh` stub for `ledger.mjs dispatch`. `gh pr list` answers `prs` as the
// open `ready-to-merge` queue `dispatch merge-bot` records. A finisher dispatch
// reads two more answers: `gh pr view <n> --json closingIssuesReferences` and
// `gh issue view <n> --json title`. Both default to a PR that closes nothing,
// and an issue with no title (a failed read); `closes`, `titled` and `failsOn`
// set them per test. Any other gh call fails loudly. Every call is appended to
// `<bin>/calls`, so a test can assert that a refusal made none.
//
// Shell builtins plus one link: the finisher gate resolves the ledger's repository through git, so the stub bin holds the real git too.
//
// Deliberately not a `.test.mjs`, so `node --test` never loads it as a suite.

import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { writeExecStub } from "./exec-stub.mjs";

/** Writes `<bin>/gh` answering `gh pr list` with the PR numbers `prs`. */
export function writeQueueGh(bin, prs = []) {
  const git = spawnSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  if (!existsSync(join(bin, "git"))) symlinkSync(git, join(bin, "git"));
  writeExecStub(join(bin, "gh"), `#!/bin/sh
printf '%s\\n' "$*" >> '${bin}/calls'
case "$1 $2" in
"pr list")
  printf '%s\\n' '${JSON.stringify(prs.map((number) => ({ number })))}' ;;
"pr view")
  [ "$4 $5" = "--json closingIssuesReferences" ] || { printf 'gh stub: unexpected gh %s\\n' "$*" >&2; exit 64; }
  f='${bin}/pr-'"$3"
  [ -f "$f.fail" ] && { printf 'gh stub: pr view %s failed\\n' "$3" >&2; exit 1; }
  if [ -f "$f.json" ]; then /bin/cat "$f.json"; else printf '%s\\n' '{"closingIssuesReferences":[]}'; fi ;;
"issue view")
  [ "$4 $5" = "--json title" ] || { printf 'gh stub: unexpected gh %s\\n' "$*" >&2; exit 64; }
  f='${bin}/issue-'"$3"
  [ -f "$f.fail" ] && { printf 'gh stub: issue view %s failed\\n' "$3" >&2; exit 1; }
  if [ -f "$f.json" ]; then /bin/cat "$f.json"; else printf '{"title":"issue %s"}\\n' "$3"; fi ;;
*) printf 'gh stub: unexpected gh %s\\n' "$*" >&2; exit 64 ;;
esac
`);
}

/** Answers `gh pr view <pr> --json closingIssuesReferences` with the issues `numbers`. */
export function closes(bin, pr, numbers) {
  writeFileSync(join(bin, `pr-${pr}.json`), JSON.stringify({ closingIssuesReferences: numbers.map((number) => ({ number })) }));
}

/** Answers `gh issue view <n> --json title` with `title`. */
export function titled(bin, n, title) {
  writeFileSync(join(bin, `issue-${n}.json`), JSON.stringify({ title }));
}

/** Makes gh's answer for `<kind>` (`pr` or `issue`) `<n>` fail. */
export function failsOn(bin, kind, n) {
  writeFileSync(join(bin, `${kind}-${n}.fail`), "");
}

/** Every gh call the stub has answered, one command line each. */
export function ghCalls(bin) {
  const log = join(bin, "calls");
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
}
