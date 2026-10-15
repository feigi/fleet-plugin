// A member's rendered brief, written the way `dispatch-prompt.mjs render
// <role> --member <name>` leaves it: `<dir>/briefs/<name>.md` and its
// sidecar `<name>.json` carrying `{role, kind, args, sha256, path}`.
// `ledger.mjs dispatch` refuses a member without one, so every suite that
// dispatches renders first, as the controller does.
//
// `ROLE_OF` is spelled out here rather than imported from ledger-grammar.mjs,
// so a test of the gate is checked against the roles the templates carry,
// not against the table under test.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ROLE_OF = { impl: "implementer", "fix-pr": "fix-applier", "finisher-pr": "finisher", "merge-bot": "merge-bot" };

/** The role a member name renders as, or null for a name no family owns. */
export function roleOf(member) {
  const m = /^(impl|fix-pr|finisher-pr|merge-bot)-[1-9]/.exec(member);
  return m === null ? null : ROLE_OF[m[1]];
}

/**
 * Writes `member`'s brief and sidecar under `<dir>/briefs/` and returns
 * `{path, sha256, sidecar}`. `sidecar` overrides fields of the written JSON
 * (a field set to undefined is left out).
 */
export function renderBrief(dir, member, { role = roleOf(member), text = `The brief for ${member}.\n`, sidecar = {} } = {}) {
  const briefs = join(dir, "briefs");
  mkdirSync(briefs, { recursive: true });
  const path = join(briefs, `${member}.md`);
  const sha256 = createHash("sha256").update(text).digest("hex");
  writeFileSync(path, text);
  const json = join(briefs, `${member}.json`);
  writeFileSync(json, `${JSON.stringify({ role, kind: null, args: {}, sha256, path, ...sidecar }, null, 2)}\n`);
  return { path, sha256, sidecar: json };
}

/**
 * `run`, a function taking ledger.mjs's arguments, wrapped so a `dispatch`
 * finds its member's brief rendered under `<dir>/briefs/` — rendered here
 * when it is absent. A bare `dispatch merge-bot` names its bot only in the
 * refusal, so that call is run once, the brief the refusal names rendered,
 * and run again, which is the controller's own order for a merge bot.
 * `argsOf` picks ledger.mjs's argument list out of a call's arguments, for
 * a `run` that takes them as an array beside other parameters.
 */
export function rendering(dir, run, argsOf = (call) => call) {
  return (...call) => {
    const args = argsOf(call);
    if (!args.includes("dispatch")) return run(...call);
    const name = args.at(-1);
    if (name !== "merge-bot") {
      renderIfAbsent(dir, name);
      return run(...call);
    }
    const r = run(...call);
    const m = /no rendered brief for (merge-bot-[0-9]+)/.exec(r?.stderr ?? "");
    if (m === null) return r;
    renderIfAbsent(dir, m[1]);
    return run(...call);
  };
}

function renderIfAbsent(dir, member) {
  if (roleOf(member) === null || existsSync(join(dir, "briefs", `${member}.json`))) return;
  renderBrief(dir, member);
}
