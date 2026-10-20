// One GraphQL read of the current repository for many numbers at once: each
// number is an aliased `<field>(number:N){…}` of the one query, a hundred to a
// call, so a caller that would ask `gh` about every number one `gh … view` at a
// time asks once per hundred instead. The caller names the field
// (`pullRequest`, `issueOrPullRequest`) and what to select on it; what an
// answer means is the caller's.
//
// `gh api graphql` exits 1 when any one alias errors yet still prints the full
// body, `data.repository` holding every alias GitHub answered and `errors[]`
// naming each failed one by `path: ["repository", "<alias>"]`. So a body that
// carries an object `data.repository` is read alias by alias at any exit
// status, never as "the whole call failed".
//
// `-F owner={owner} -F name={repo}` is filled in from the environment gh sees:
// an inherited GH_REPO outranks the repository the cwd is bound to, and a
// GIT_DIR naming another repository moves it too. gitEnv({ GH_REPO: "" })
// scrubs both, so the read is of the repository the cwd is in.

import { spawnSync } from "node:child_process";
import { gitEnv } from "./git-env.mjs";

const BATCH = 100;
const MAX_BUFFER = 64 * 1024 * 1024;

/** A child that did not answer, as one short reason. */
export function how(r) {
  if (r.error) return r.error.code ?? r.error.message;
  if (r.signal) return `killed by ${r.signal}`;
  const said = String(r.stderr ?? "").trim().split("\n").at(-1);
  return said ? `exit ${r.status}: ${said}` : `exit ${r.status}`;
}

/**
 * What GitHub says of each of `numbers`, as a Map keyed by number:
 *
 *   `{ node }`         — the alias GitHub answered with an object, as parsed.
 *   `{ notFound }`     — null with a NOT_FOUND error naming the alias at path
 *                        length 2: GitHub's own "this number names nothing".
 *   `{ unreachable }`  — no usable answer, with the reason. Any other error
 *                        naming an alias, an error naming no alias (it may
 *                        belong to any of the batch), a null no NOT_FOUND
 *                        explains, a missing alias, and an unparseable or
 *                        absent body all land here: a failed lookup is not an
 *                        answer.
 *
 * `field` and `selection` build each alias, `n<N>:<field>(number:<N>)<selection>`;
 * `timeoutMs` bounds each `gh` call.
 */
export function ghAliasedRead(numbers, { field, selection, timeoutMs }) {
  const out = new Map();
  for (let i = 0; i < numbers.length; i += BATCH) {
    const batch = numbers.slice(i, i + BATCH);
    const fields = batch.map((n) => `n${n}:${field}(number:${n})${selection}`).join(" ");
    const r = spawnSync("gh", ["api", "graphql", "-F", "owner={owner}", "-F", "name={repo}",
      "-f", `query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${fields}}}`], {
      encoding: "utf8", maxBuffer: MAX_BUFFER, timeout: timeoutMs, env: gitEnv({ GH_REPO: "" }),
    });
    let body;
    let unparseable;
    try {
      body = JSON.parse(r.stdout);
    } catch (e) {
      body = undefined;
      if (r.status === 0) unparseable = e.message;
    }
    const repo = body?.data?.repository;
    const errors = body?.errors ?? [];
    const answered = repo !== null && typeof repo === "object" && !Array.isArray(repo) && Array.isArray(errors);
    const nothing = new Set();
    const refused = new Map();
    let batchWide;
    if (answered) {
      for (const e of errors) {
        const path = e?.path;
        const alias = Array.isArray(path) && path[0] === "repository" && typeof path[1] === "string" ? path[1] : null;
        const said = `${e?.type ?? "error"}${e?.message ? `: ${e.message}` : ""}`;
        if (alias === null) batchWide ??= said;
        else if (e.type === "NOT_FOUND" && path.length === 2) nothing.add(alias);
        else refused.set(alias, said);
      }
    }
    for (const n of batch) {
      const alias = `n${n}`;
      const gone = (why) => out.set(n, { unreachable: why });
      if (!answered) gone(unparseable === undefined ? how(r) : `${how(r)}: unparseable body: ${unparseable}`);
      else if (refused.has(alias)) gone(refused.get(alias));
      else if (batchWide !== undefined) gone(batchWide);
      else if (!Object.hasOwn(repo, alias)) gone(how(r));
      else if (repo[alias] === null) {
        if (nothing.has(alias)) out.set(n, { notFound: true });
        else gone("null with no NOT_FOUND error");
      } else out.set(n, { node: repo[alias] });
    }
  }
  return out;
}
