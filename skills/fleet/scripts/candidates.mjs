#!/usr/bin/env node
// Open issues that are candidates for work, reduced to the fields a shortlist
// needs.
//
// Never fetches raw bodies for the whole list — they are ~97% of the payload.
// The body is reduced server-side to dependency references only.
//
// The label policy is a FLAG, not prose. `next-ticket` may drop a required
// label and retry when the result is empty; the fleet must not, because an
// empty ready-for-agent queue means there is no work, not that the net should
// widen — ready-for-human tickets need a human to brainstorm first, and an
// unattended fleet has no channel to one.

import { execFileSync } from "node:child_process";

const NAME = "candidates";

function die(msg) {
  console.error(`${NAME}: ${msg}`);
  process.exit(2);
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
}
const has = (name) => process.argv.includes(`--${name}`);

const requireLabel = arg("require-label");
const allowFallback = has("allow-fallback");

if (allowFallback && !requireLabel) die("--allow-fallback is meaningless without --require-label");

const EXCLUDE =
  "-label:in-progress -label:onhold -label:wontfix -label:needs-triage -label:needs-info";
const JQ =
  '[.[]|{n:.number,t:.title,l:[.labels[].name],' +
  'd:[(.body//""|scan("(?i)(?:depends on|blocked by|requires|after)\\\\s+#\\\\d+"))]}]';

function query(label) {
  const search = label ? `${EXCLUDE} label:${label}` : EXCLUDE;
  const args = [
    "issue", "list",
    "--state", "open",
    "--limit", "100",
    "--search", search,
    "--json", "number,title,labels,body",
    "--jq", JQ,
  ];
  console.error(`$ gh ${args.join(" ")}`);
  let out;
  try {
    out = execFileSync("gh", args, { encoding: "utf8" });
  } catch (e) {
    // Fail closed. A failed query and an empty queue are different facts, and
    // only one of them means "there is no work".
    die(`gh issue list failed: ${String(e.stderr || e.message).trim()}`);
  }
  const trimmed = out.trim();
  if (trimmed === "") return [];
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    die(`could not parse gh output as JSON: ${e.message}`);
  }
}

let rows = query(requireLabel);
console.error(`    ${rows.length} candidate(s)${requireLabel ? ` with label:${requireLabel}` : ""}`);

if (rows.length === 0 && allowFallback && requireLabel) {
  console.error(`${NAME}: empty with label:${requireLabel}; --allow-fallback given, retrying unfiltered`);
  rows = query(null);
  console.error(`    ${rows.length} candidate(s) unfiltered`);
}

for (const r of rows) {
  console.error(`    #${r.n} [${r.l.join(",")}] ${r.t}${r.d.length ? `  deps:${r.d.join(";")}` : ""}`);
}

console.log(JSON.stringify(rows, null, 2));

// Exit 1 for a successful query with no survivors. The caller must be able to
// tell "the queue is empty" from "the query broke" (2) without reading stderr.
process.exit(rows.length === 0 ? 1 : 0);
