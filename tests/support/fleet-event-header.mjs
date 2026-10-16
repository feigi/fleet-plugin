// The header comment of `fleet-event.mjs` — the leading `//` lines after the
// shebang, comment markers stripped — as one string with every run of
// whitespace squashed to a space. It is where each wake's writes are described
// since run-team/SKILL.md's wake table became one command per kind, so the
// prose pins that used to read those writes off the skill read them here.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "..", "..", "plugin", "scripts", "fleet-event.mjs");

const LINES = readFileSync(SCRIPT, "utf8").split("\n").slice(1);
const END = LINES.findIndex((l) => !l.startsWith("//"));

export const EVENT_HEADER = LINES.slice(0, END === -1 ? LINES.length : END)
  .map((l) => l.replace(/^\/\/ ?/, ""))
  .join(" ")
  .replace(/\s+/g, " ")
  .trim();
