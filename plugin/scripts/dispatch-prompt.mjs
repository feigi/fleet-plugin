#!/usr/bin/env node
// dispatch-prompt.mjs: render a member brief from a template, refusing a missing
// argument or a leftover placeholder.
//
// Usage: node scripts/dispatch-prompt.mjs render <role> [--<arg> <value>…] [--member <name>] [--json]
//
// Roles: implementer, fix-applier, finisher, merge-bot, review-runner, tier-check
//
// Output: the brief on stdout. With --json: {role, kind, args, sha256}.
// With --member <name>: also writes both .md and .json files to the member directory.
//
// The template contract:
// - Every placeholder <name> in a template is a required argument
// - Paths (--worktree, --scratch, --review-file, --abs-path) must be absolute
// - instruments.sh runs first; its exit 1/2 becomes exit 2 here
// - A template with an undeclared <foo> exits 2 naming it
// - Missing --kind for roles that require it exits 2

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { makeDie } from "./arg.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const die = makeDie("dispatch-prompt.mjs");

// Role definitions: which roles have --kind variants, and what kinds
const ROLE_KINDS = {
  "fix-applier": ["review", "conflict", "dispositions-retry"],
  finisher: ["fresh", "repair"],
  "review-runner": ["fresh", "full", "skip"],
};

// Path arguments that must be absolute
const PATH_ARGS = new Set(["worktree", "scratch", "review-file", "abs-path"]);

function parseArgs() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] !== "render") {
    die("Usage: dispatch-prompt.mjs render <role> [--<arg> <value>…] [--member <name>] [--json]");
  }

  if (argv.length < 2) {
    die("Usage: dispatch-prompt.mjs render <role>");
  }

  const role = argv[1];
  const args = {};
  let member = null;
  let jsonOutput = false;
  let kind = null;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--member") {
      if (i + 1 >= argv.length) {
        die("--member needs a value");
      }
      member = argv[++i];
    } else if (arg === "--json") {
      jsonOutput = true;
    } else if (arg === "--kind") {
      if (i + 1 >= argv.length) {
        die("--kind needs a value");
      }
      kind = argv[++i];
    } else if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (i + 1 >= argv.length) {
        die(`--${name} needs a value`);
      }
      const value = argv[++i];
      if (value.startsWith("--")) {
        die(`--${name} needs a value`);
      }
      args[name] = value;
    } else {
      die(`Unexpected argument: ${arg}`);
    }
  }

  return { role, kind, args, member, jsonOutput };
}

function validateRole(role) {
  const validRoles = ["implementer", "fix-applier", "finisher", "merge-bot", "review-runner", "tier-check"];
  if (!validRoles.includes(role)) {
    die(`Invalid role: ${role}. Valid roles: ${validRoles.join(", ")}`);
  }
}

function validateKind(role, kind) {
  if (ROLE_KINDS[role]) {
    if (!kind) {
      die(`Role ${role} requires --kind. Valid values: ${ROLE_KINDS[role].join(", ")}`);
    }
    if (!ROLE_KINDS[role].includes(kind)) {
      die(`Invalid kind for ${role}: ${kind}. Valid values: ${ROLE_KINDS[role].join(", ")}`);
    }
  }
}

function loadTemplate(role, kind) {
  let templatePath = join(__dirname, "..", "skills", "run-team", "briefs", `${role}.md`);
  let template = readFileSync(templatePath, "utf8");

  // Handle kind-specific sections
  if (kind && ROLE_KINDS[role]) {
    // Extract kind-specific content
    const kindPattern = new RegExp(`^## kind: ${kind}$`, "m");
    const kindMatch = template.match(kindPattern);
    if (!kindMatch) {
      die(`Template for ${role} has no section for kind: ${kind}`);
    }

    const startIdx = template.indexOf(kindMatch[0]) + kindMatch[0].length;
    const restOfTemplate = template.slice(startIdx);
    const nextKindMatch = restOfTemplate.match(/^## kind: /m);
    const endIdx = nextKindMatch ? startIdx + restOfTemplate.indexOf(nextKindMatch[0]) : template.length;

    template = template.slice(startIdx, endIdx).trim();
  }

  return template;
}

function findPlaceholders(text) {
  const placeholders = new Set();
  const regex = /<([a-zA-Z-_][a-zA-Z0-9-_]*)>/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    placeholders.add(match[1]);
  }
  return placeholders;
}

function validateArguments(role, kind, args, template) {
  const requiredPlaceholders = findPlaceholders(template);

  // Check for missing arguments
  for (const placeholder of requiredPlaceholders) {
    if (!args[placeholder]) {
      die(`Missing required argument: --${placeholder}`);
    }
  }

  // Validate path arguments are absolute
  for (const [name, value] of Object.entries(args)) {
    if (PATH_ARGS.has(name)) {
      if (!isAbsolute(value)) {
        die(`Path argument --${name} must be absolute: ${value}`);
      }
    }
  }

  // Check for leftover placeholders in rendered output
  const rendered = template.replace(/<[a-zA-Z-_][a-zA-Z0-9-_]*>/g, (match) => {
    const name = match.slice(1, -1);
    return args[name] !== undefined ? args[name] : match;
  });

  const leftoverPlaceholders = findPlaceholders(rendered);
  if (leftoverPlaceholders.size > 0) {
    const placeholder = Array.from(leftoverPlaceholders)[0];
    die(`Leftover placeholder in rendered brief: <${placeholder}>`);
  }
}

function renderBrief(template, args) {
  return template.replace(/<([a-zA-Z-_][a-zA-Z0-9-_]*)>/g, (match) => {
    const name = match.slice(1, -1);
    return args[name] !== undefined ? args[name] : match;
  });
}

function runInstruments() {
  const instrumentsPath = join(__dirname, "instruments.sh");
  const result = spawnSync("bash", [instrumentsPath], {
    cwd: join(__dirname, ".."),
    stdio: "pipe",
  });

  if (result.status === 1 || result.status === 2) {
    die("instruments.sh failed");
  }
}

function computeSha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function main() {
  const { role, kind, args, member, jsonOutput } = parseArgs();

  validateRole(role);
  validateKind(role, kind);

  // Run instruments first
  runInstruments();

  // Load and validate template
  const template = loadTemplate(role, kind);
  validateArguments(role, kind, args, template);

  // Render brief
  const brief = renderBrief(template, args);

  // Prepare output
  if (jsonOutput) {
    const output = {
      role,
      kind: kind || null,
      args,
      sha256: computeSha256(brief),
    };
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(brief);
  }

  // Write member files if requested
  if (member) {
    const memberDir = join(args.scratch || "", member);
    mkdirSync(memberDir, { recursive: true });
    const mdPath = join(memberDir, `${member}.md`);
    const jsonPath = join(memberDir, `${member}.json`);

    writeFileSync(mdPath, brief, "utf8");

    const jsonData = {
      role,
      kind: kind || null,
      args,
      sha256: computeSha256(brief),
    };
    writeFileSync(jsonPath, JSON.stringify(jsonData, null, 2) + "\n", "utf8");
  }
}

main().catch((err) => {
  die(err.message);
});
