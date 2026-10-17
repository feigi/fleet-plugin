#!/usr/bin/env node
// dispatch-prompt.mjs — render one member's dispatch brief from its template.
//
//   dispatch-prompt.mjs render <role> [--kind <kind>] [--<arg> <value>…]
//                                     [--member <name>] [--json]
//
// Roles: implementer, fix-applier, finisher, merge-bot, review-runner,
// recipe-deriver, relabel (the comment a Pull posts on a ticket it returns,
// not a member's brief). A role with kinds (fix-applier: review, conflict,
// dispositions-retry, red-check; finisher: fresh, repair; relabel:
// needs-triage, fork, hands, covered, fixed) requires --kind; a role without them refuses it
// as an unknown flag.
//
// OUTPUT. The brief on stdout and nothing else. With --json the payload
// {role, kind, args, sha256} replaces it, `sha256` being the hash of the
// brief's bytes. With --member <name> the brief is also written to
// `<fleet-dir>/briefs/<name>.md` and the payload plus `path` (the .md file)
// to `<fleet-dir>/briefs/<name>.json`, `<fleet-dir>` as fleet-dir.mjs's
// fleetFile() resolves it. Every file is written before anything reaches
// stdout, so a failed write leaves no brief for a caller to dispatch on.
//
// EXIT. 0 rendered. 2 refused, with the reason on stderr and nothing on
// stdout: a missing, unknown or relative argument, a template that carries a
// placeholder it never declared or no text at all for the kind, a leftover
// declared placeholder in the output, or instruments.sh answering anything
// but 0.
//
// INSTRUMENTS. After the command line has parsed and before anything is
// validated or rendered, instruments.sh runs from the main checkout — the
// directory holding the git common dir, where the run's baseline lives — and
// any outcome but exit 0 refuses: a changed set, an unanswerable check, a
// spawn that never ran, a signal. That is the fail-closed contract
// instruments.sh states for its own callers.
//
// THE TEMPLATE CONTRACT. One file per role, `skills/run-team/briefs/<role>.md`,
// beside the install this script runs from.
//
// - A frontmatter block, `---` on the first line and on its own closing line,
//   holds one directive per line:
//     arg <flag> <placeholder>   the argument `--<flag>` fills `<placeholder>`
//     path <flag>                that argument must be an absolute path
//     literal <text>             `<text>` is carried to the member as written
//   A placeholder is `<` + a letter + anything but `<`, `>` and a newline +
//   `>`, matched by its inner text exactly; it may hold spaces. No flag and
//   no placeholder is declared twice, and --member, --json and --kind are
//   reserved.
// - Every placeholder the selected text carries must be declared by `arg` or
//   `literal`; an undeclared one is a template defect and refuses, naming it.
// - An argument is required exactly when its placeholder occurs in the text
//   selected for the kind. A flag the selected text never uses is refused.
// - The body is plain text. Lines `## kind: <k>[, <k>…]` open a section that
//   applies to those kinds; text before the first such line applies to every
//   kind. The brief is the applicable sections' lines in file order, joined
//   with newlines and ended by one. Sections may repeat and interleave, which
//   is how kinds share text without a copy.
// - Substitution is one pass over the template: a value is never rescanned,
//   so a value holding another placeholder's spelling is not substituted into.
//   After it, any declared placeholder still present in the output — which
//   only a caller passing a value like `<branch>` can cause — refuses, naming
//   it.
//
// The text every member of a role shares lives in that role's agent body; a
// template carries only what varies between dispatches of the role.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeDie, defineFlags, writeAll } from "./arg.mjs";
import { FleetDirUnresolvable, fleetFile } from "./fleet-dir.mjs";
import { gitEnv } from "./git-env.mjs";
import { runnerScratchRefusal } from "./review-core.mjs";

const NAME = "dispatch-prompt";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const BRIEFS_DIR = join(SCRIPT_DIR, "..", "skills", "run-team", "briefs");
const ROLES = ["implementer", "fix-applier", "finisher", "merge-bot", "review-runner", "recipe-deriver", "relabel"];
const RESERVED = ["member", "json", "kind"];
const USAGE = `usage: ${NAME}.mjs render <role> [--kind <kind>] [--<arg> <value>…] [--member <name>] [--json] — roles: ${ROLES.join(", ")}`;
const PLACEHOLDER = /<([A-Za-z][^<>\n]*)>/g;
const KIND_HEADER = /^## kind: (.+)$/;

const die = makeDie(NAME);

// --- the template ------------------------------------------------------------

function parseTemplate(role, text) {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const refuse = (why) => die(`template ${role}.md ${why}`);
  if (lines[0] !== "---") refuse("does not open with a --- frontmatter block");
  const close = lines.indexOf("---", 1);
  if (close === -1) refuse("never closes its frontmatter block");

  const args = [];
  const paths = new Set();
  const literals = new Set();
  for (const line of lines.slice(1, close)) {
    const m = /^(arg|path|literal) (.+)$/.exec(line);
    if (m === null) refuse(`has a frontmatter line that is no directive: ${line}`);
    if (m[1] === "literal") {
      literals.add(m[2]);
    } else if (m[1] === "path") {
      paths.add(m[2]);
    } else {
      const split = /^(\S+) (.+)$/.exec(m[2]);
      if (split === null) refuse(`has an arg line without a placeholder: ${line}`);
      const [, flag, placeholder] = split;
      if (RESERVED.includes(flag)) refuse(`declares the reserved flag --${flag}`);
      if (args.some((a) => a.flag === flag || a.placeholder === placeholder)) refuse(`declares --${flag} or <${placeholder}> twice`);
      args.push({ flag, placeholder });
    }
  }
  for (const flag of paths) if (!args.some((a) => a.flag === flag)) refuse(`marks --${flag} as a path but never declares it`);
  for (const a of args) if (literals.has(a.placeholder)) refuse(`declares <${a.placeholder}> as both an argument and a literal`);

  const sections = [];
  let current = { kinds: null, lines: [] };
  sections.push(current);
  for (const line of lines.slice(close + 1)) {
    const header = KIND_HEADER.exec(line);
    if (header === null) {
      current.lines.push(line);
      continue;
    }
    current = { kinds: header[1].split(",").map((k) => k.trim()), lines: [] };
    sections.push(current);
  }
  const kinds = [...new Set(sections.flatMap((s) => s.kinds ?? []))];

  const whole = sections.flatMap((s) => s.lines).join("\n");
  for (const a of args) if (!whole.includes(`<${a.placeholder}>`)) refuse(`declares <${a.placeholder}> but never carries it`);
  return { args, paths, literals, sections, kinds };
}

function loadTemplate(role) {
  let text;
  try {
    text = readFileSync(join(BRIEFS_DIR, `${role}.md`), "utf8");
  } catch (err) {
    return die(`cannot read the template for ${role}: ${err.message}`);
  }
  return parseTemplate(role, text);
}

// --- the instrument check ---------------------------------------------------

function runInstruments() {
  let root;
  try {
    root = dirname(fleetFile(null));
  } catch (err) {
    if (err instanceof FleetDirUnresolvable) die(`instruments.sh not run — no main checkout to run it from: ${err.message}`);
    throw err;
  }
  const r = spawnSync("sh", [join(SCRIPT_DIR, "instruments.sh"), "--repo", root], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: gitEnv(),
  });
  if (r.error) die(`instruments.sh could not run: ${r.error.message}`);
  if (r.signal) die(`instruments.sh was killed by ${r.signal}`);
  if (r.status === 0) return;
  const said = (r.stderr ?? "").trim() || (r.stdout ?? "").trim();
  const verdict = r.status === 1 ? "the instrument set changed" : `the check could not answer (exit ${r.status})`;
  die(`instruments.sh refused: ${verdict}${said ? ` — ${said}` : ""}`);
}

// --- main --------------------------------------------------------------------

const argv = process.argv.slice(2);
const role = argv[0] === "render" && argv[1] !== undefined && !argv[1].startsWith("--") ? argv[1] : null;
if (role !== null && !ROLES.includes(role)) die(`unknown role ${role} — roles: ${ROLES.join(", ")}`);
const template = role === null ? null : loadTemplate(role);
// The role is the one positional the shared stray() refusal does not know:
// take it out of argv so the declared grammar is just `render`.
if (role !== null) process.argv.splice(3, 1);

const flags = { member: "value", json: "bool" };
if (template !== null) {
  if (template.kinds.length > 0) flags.kind = "value";
  for (const a of template.args) flags[a.flag] = "value";
}
const { arg, has, sweep, stray } = defineFlags(die, { flags, positionals: ["render"] });
sweep();
stray();
if (role === null) die(USAGE);

runInstruments();

let kind = null;
if (template.kinds.length > 0) {
  kind = arg("kind");
  if (kind === null) die(`--kind is required for ${role} — one of ${template.kinds.join(", ")}`);
  if (!template.kinds.includes(kind)) die(`--kind ${kind} is not a kind of ${role} — one of ${template.kinds.join(", ")}`);
}
const selected = template.sections.filter((s) => s.kinds === null || s.kinds.includes(kind)).flatMap((s) => s.lines);
const body = selected.join("\n");
if (body.trim() === "") die(`template ${role}.md carries no text for ${kind === null ? "the role" : `kind ${kind}`}`);

const declared = new Set(template.args.map((a) => a.placeholder));
for (const [, inner] of body.matchAll(PLACEHOLDER)) {
  if (!declared.has(inner) && !template.literals.has(inner)) die(`template ${role}.md carries the undeclared placeholder <${inner}>`);
}

const required = template.args.filter((a) => body.includes(`<${a.placeholder}>`));
for (const a of template.args) {
  if (!required.includes(a) && arg(a.flag) !== null) {
    die(`--${a.flag} is not an argument of ${role}${kind === null ? "" : ` ${kind}`} — accepted: ${required.map((r) => `--${r.flag}`).join(", ")}`);
  }
}

const values = new Map();
for (const a of required) {
  const value = arg(a.flag);
  if (value === null) die(`missing required argument: --${a.flag}`);
  if (template.paths.has(a.flag) && !isAbsolute(value)) die(`--${a.flag} must be an absolute path, got ${value}`);
  if (role === "review-runner" && a.flag === "scratch") {
    const refusal = runnerScratchRefusal(value);
    if (refusal !== null) die(refusal);
  }
  values.set(a.placeholder, value);
}

const brief = `${body.replace(PLACEHOLDER, (whole, inner) => (values.has(inner) ? values.get(inner) : whole))}\n`;
for (const a of required) {
  if (brief.includes(`<${a.placeholder}>`)) die(`the rendered brief still carries <${a.placeholder}> — an argument value spells it`);
}

const payload = {
  role,
  kind,
  args: Object.fromEntries(required.map((a) => [a.flag, values.get(a.placeholder)])),
  sha256: createHash("sha256").update(brief).digest("hex"),
};

const member = arg("member");
if (member !== null) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(member)) die(`--member ${member} is not a member name: letters, digits, '.', '_' and '-', starting alphanumeric`);
  let mdPath;
  try {
    mdPath = fleetFile(`briefs/${member}.md`);
  } catch (err) {
    if (err instanceof FleetDirUnresolvable) die(`cannot place --member ${member}'s files: ${err.message}`);
    throw err;
  }
  const jsonPath = join(dirname(mdPath), `${member}.json`);
  try {
    mkdirSync(dirname(mdPath), { recursive: true });
    writeFileSync(mdPath, brief);
    writeFileSync(jsonPath, `${JSON.stringify({ ...payload, path: mdPath }, null, 2)}\n`);
  } catch (err) {
    die(`cannot write --member ${member}'s files under ${dirname(mdPath)}: ${err.message}`);
  }
}

writeAll(1, has("json") ? `${JSON.stringify(payload, null, 2)}\n` : brief);
