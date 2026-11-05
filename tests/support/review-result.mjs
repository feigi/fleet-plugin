// A `reviewed=` is written only by `ledger.mjs review <pr> --result <path>`,
// which derives it from a review result file, so a test that wants one on a
// ledger hands the verb the file the token names rather than the token.
//
// `viaResult(scratch, args)` rewrites a `review <pr> …` call that carries a
// `reviewed=<head>:<s>/<r>/<u>:<run>` word into the same call with that word
// replaced by `--result <scratch>/pr<pr>/<run>/review.json --scratch
// <scratch>`, writing the file when the test has not. A file already there is
// left as the test made it. Every other call is returned as it came.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REVIEWED_WORD = /^reviewed=([0-9a-fA-F]{7,40}):(\d+)\/(\d+)\/(\d+):(run-[A-Za-z0-9]{8})$/;

/** The review result file `token` names, in PR `pr`'s partition of `scratch`. */
export function writeReviewResult(scratch, pr, token, extra = {}) {
  const m = REVIEWED_WORD.exec(token);
  if (m === null) throw new Error(`${token} is not a reviewed= token a result file can carry`);
  const [, head, survived, refuted, unverified, run] = m;
  const dir = join(scratch, `pr${pr}`, run);
  const path = join(dir, "review.json");
  if (existsSync(path)) return path;
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify({
    pr: Number(pr), head,
    counts: { survived: Number(survived), refuted: Number(refuted), unverified: Number(unverified), crashed: 0 },
    ...extra,
  }));
  return path;
}

export function viaResult(scratch, args) {
  if (args[0] !== "review" || args.length < 3) return args;
  const pr = String(args[1]).replace(/^#/, "");
  const kept = [];
  const results = [];
  for (const arg of args.slice(2)) {
    for (const word of String(arg).split(/\s+/).filter(Boolean)) {
      if (REVIEWED_WORD.test(word)) results.push(word);
      else kept.push(word);
    }
  }
  if (results.length === 0) return args;
  if (results.length > 1) throw new Error(`one review call derives one reviewed= from one --result; split ${results.join(" ")} into calls`);
  return [args[0], args[1], ...kept, "--result", writeReviewResult(scratch, pr, results[0]), "--scratch", scratch];
}
