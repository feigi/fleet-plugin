// #1752 (parent #1743). The Renovate bot and the two release workflows keep a
// JOINT contract that none of the three files can state alone:
//
//   renovate.json                        decides which labels a bot PR carries
//                                        and whether it automerges;
//   .github/workflows/release-label.yml  counts release labels (exactly one is
//                                        required) and, on an UNLABELLED bot
//                                        PR, stamps a blind fallback label;
//   .github/workflows/release.yml        turns the one release label into the
//                                        version segment it bumps.
//
// Before #1752 the bot config set no labels at all, so every bot PR reached the
// fallback and was stamped `patch` whatever it carried, and every bot PR was
// automerged — a Node major could ship with nobody watching AND announce
// itself as a patch. Each file read fine on its own; the defect was the
// disagreement between them. So this test reads all three as DATA and checks
// the contract they must keep together:
//
//   1. every update type the bot can emit resolves, from the bot config
//      itself, to exactly one label the gate counts — the fallback reclaiming
//      the labelling job is the defect, not a simplification;
//   2. that label is one the fallback's own guard recognises, so the
//      fallback stands down instead of adding a second release label;
//   3. release.yml bumps the segment matching the update type's size;
//   4. no update type is simultaneously major and automergeable.
//
// It pins the contract, not the wording: label NAMES are read out of the
// workflows (rename them consistently in all three files and this stays
// green), the schedule is never read, and the bot config may express its
// rules through `labels`, `addLabels` or top-level update-type objects.
//
// WHICH UPDATE TYPES THE BOT CAN EMIT. Renovate's schema (44.115.6, fetched
// 2026-09-25) names ten: major, minor, patch, pin, pinDigest, digest,
// lockFileMaintenance, rollback, bump, replacement. With `enabledManagers:
// ["nvm"]` over an exact `.nvmrc` (ADR 0010) the `node-version` datasource
// yields only the semver three — no digests, no lock file, no range to pin or
// bump — and `rollback` only once `rollbackPrs` (default false) is opted into.
// That derivation holds only for the nvm manager, so a widened
// `enabledManagers` reds here rather than silently checking too few types.
//
// HOW THE BOT CONFIG RESOLVES, per Renovate's own source and docs rather than
// guessed: `labels` is non-mergeable (a later setting replaces it), `addLabels`
// appends, and the PR carries both; `automerge` defaults to false.
// `lib/workers/repository/updates/flatten.ts` applies packageRules, merges the
// top-level update-type object (`"major": {…}`), then applies packageRules
// AGAIN, so packageRules win over that object — modelled in that order below.
// The presets `config:recommended` extends set neither labels nor automerge
// (checked against renovate's `lib/config/presets/internal/*.preset.ts`), so the
// repo file alone decides both.
//
// CEILINGS. The workflows are read with targeted patterns, not a YAML parser —
// this repo has no package.json and no YAML dependency, the same trade
// ci-state.mjs makes; whole-line `#` comments are blanked first so a comment
// cannot satisfy a pattern. A packageRule is treated as applying to every
// update type it names regardless of any other matcher on it. That is
// one-sided, not simply conservative: an extra matcher on a rule that ADDS
// `automerge:false`/labels can make Renovate apply the safety settings to
// FEWER packages than this test assumes — narrow the major rule away from
// the real dependency it must cover and nothing here reds, while real
// Renovate falls through to the unattended top-level automerge for it; this
// repo's actual major rule matches on update type alone, which is what
// keeps that gap closed, not this test. An extra matcher on a rule that
// only LOOSENS settings is the direction that stays merely stricter than
// Renovate. And the ordering of Renovate's label write against the
// fallback job on the `opened` event is runtime behaviour no file here
// records.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const BOT = "renovate.json";
const GATE = ".github/workflows/release-label.yml";
const RELEASE = ".github/workflows/release.yml";

// Renovate's vocabulary on one side, release.yml's segment variables on the
// other: the size a semver update type must be announced as.
const SEGMENT_OF = { major: "MAJOR", minor: "MINOR", patch: "PATCH" };

const code = (text) =>
  text
    .split("\n")
    .map((line) => (/^\s*#/.test(line) ? "" : line))
    .join("\n");

// The `select(. == "a" or . == "b")` jq filter both workflows use to decide
// which labels are release labels.
function releaseLabelFilter(src, file, problems) {
  const hits = [...src.matchAll(/select\(((?:\s*\.\s*==\s*"[^"]*"\s*(?:or)?)+)\s*\)/g)];
  if (hits.length !== 1) {
    problems.push(
      `${file}: expected exactly one \`select(. == "…" or …)\` release-label filter, found ${hits.length} — cannot tell which labels it treats as release labels`,
    );
    return null;
  }
  return new Set([...hits[0][1].matchAll(/"([^"]*)"/g)].map((m) => m[1]));
}

function readGate(text, problems) {
  const src = code(text);
  const counted = releaseLabelFilter(src, GATE, problems);
  const guard = src.match(/grep\s+-qE\s+'\^\(([^)]*)\)\$'/);
  if (!guard) {
    problems.push(
      `${GATE}: no \`grep -qE '^(…)$'\` guard found — cannot tell which labels make the bot fallback stand down`,
    );
  }
  const fallbacks = [...src.matchAll(/--add-label\s+["']?([^\s"']+)/g)].map((m) => m[1]);
  if (fallbacks.length !== 1) {
    problems.push(
      `${GATE}: expected exactly one \`--add-label\` bot fallback, found ${fallbacks.length}`,
    );
  }
  return {
    counted,
    guard: guard ? new Set(guard[1].split("|")) : null,
    fallback: fallbacks.length === 1 ? fallbacks[0] : null,
  };
}

function readRelease(text, problems) {
  const src = code(text);
  const labels = releaseLabelFilter(src, RELEASE, problems);
  const bumps = new Map();
  for (const m of src.matchAll(/([^\s()|;]+)\)\s*(MAJOR|MINOR|PATCH)=\$\(\(\s*\2\s*\+\s*1\s*\)\)/g)) {
    bumps.set(m[1], m[2]);
  }
  if (labels) {
    for (const label of labels) {
      if (!bumps.has(label)) {
        problems.push(`${RELEASE}: reads \`${label}\` as a release label but no case arm bumps a segment for it`);
      }
    }
  }
  for (const segment of Object.values(SEGMENT_OF)) {
    const by = [...bumps].filter(([, s]) => s === segment).map(([l]) => l);
    if (by.length !== 1) {
      problems.push(`${RELEASE}: expected exactly one label to bump ${segment}, found ${by.length} (${by.join(", ") || "none"})`);
    }
  }
  return { labels, bumps };
}

// What a bot PR of `type` ends up carrying, in Renovate's own merge order.
function resolveBot(cfg, type) {
  let labels = cfg.labels ?? [];
  const added = [...(cfg.addLabels ?? [])];
  let automerge = cfg.automerge ?? false;
  const apply = (layer) => {
    if ("labels" in layer) labels = layer.labels;
    if (layer.addLabels) added.push(...layer.addLabels);
    if ("automerge" in layer) automerge = layer.automerge;
  };
  if (cfg[type]) apply(cfg[type]);
  for (const rule of cfg.packageRules ?? []) {
    if (rule.matchUpdateTypes === undefined || [].concat(rule.matchUpdateTypes).includes(type)) apply(rule);
  }
  return { labels: [...new Set([...labels, ...added])], automerge: automerge === true };
}

function emittableTypes(cfg) {
  const types = Object.keys(SEGMENT_OF);
  const rollback = cfg.rollbackPrs === true || (cfg.packageRules ?? []).some((r) => r.rollbackPrs === true);
  return rollback ? [...types, "rollback"] : types;
}

// A JSON-valid renovate.json can still have the wrong SHAPE at exactly the
// spots resolveBot/emittableTypes read without a type check — an update-type
// override or a packageRules entry that is not a plain object, or
// packageRules itself not an array — and both throw a raw TypeError instead
// of a problem naming which file disagreed, breaking this test's own
// contract (the ticket's AC: "failure message names the file... and what the
// disagreement was"). Checked once, up front, so every downstream read can
// assume the shape it needs.
function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function botShapeProblem(cfg) {
  if (cfg.packageRules !== undefined && !Array.isArray(cfg.packageRules)) {
    return `${BOT}: \`packageRules\` must be an array, got ${typeof cfg.packageRules}`;
  }
  for (const rule of cfg.packageRules ?? []) {
    if (!isPlainObject(rule)) return `${BOT}: a \`packageRules\` entry must be an object, got ${JSON.stringify(rule)}`;
  }
  for (const type of [...Object.keys(SEGMENT_OF), "rollback"]) {
    if (cfg[type] !== undefined && !isPlainObject(cfg[type])) {
      return `${BOT}: top-level \`${type}\` override must be an object, got ${JSON.stringify(cfg[type])}`;
    }
  }
  return null;
}

function contractProblems({ bot, gate, release }) {
  const problems = [];
  let cfg;
  try {
    cfg = JSON.parse(bot);
  } catch (err) {
    return [`${BOT}: not valid JSON (${err.message})`];
  }
  const shapeProblem = botShapeProblem(cfg);
  if (shapeProblem) return [shapeProblem];

  // The one check #1752 exists to guarantee — a major update must never
  // automerge — needs only `cfg` and `resolveBot`, so it runs before, and
  // independently of, the gate/release parsing below: a cosmetic mismatch in
  // either workflow (e.g. a quoting style neither readGate nor readRelease
  // recognises) must not mask a live major-automerge regression behind an
  // unrelated "cannot tell which labels…" problem.
  if (resolveBot(cfg, "major").automerge) {
    problems.push(
      `${BOT}: \`major\` updates are automerged — a major must wait for a human, so the rule for \`major\` needs \`"automerge": false\``,
    );
  }

  const g = readGate(gate, problems);
  const r = readRelease(release, problems);
  if (!g.counted || !g.guard || !g.fallback || !r.labels) return problems;

  if (g.counted.size !== r.labels.size || [...g.counted].some((l) => !r.labels.has(l))) {
    problems.push(
      `${GATE} vs ${RELEASE}: the gate counts [${[...g.counted]}] as release labels but release.yml reads [${[...r.labels]}] — a label only one side knows either passes the gate and mints nothing, or mints from a PR the gate refused`,
    );
  }

  if (JSON.stringify(cfg.enabledManagers) !== JSON.stringify(["nvm"])) {
    problems.push(
      `${BOT}: enabledManagers is ${JSON.stringify(cfg.enabledManagers)}, not ["nvm"] — the update types this test checks were derived for the nvm manager alone, so a new manager's update types (digest, pin, …) would go unchecked; extend emittableTypes before widening it`,
    );
  }

  for (const type of emittableTypes(cfg)) {
    const { labels, automerge } = resolveBot(cfg, type);
    const releaseLabels = labels.filter((l) => g.counted.has(l));
    const segments = releaseLabels.map((l) => r.bumps.get(l));
    // `major` itself is covered unconditionally above, before g/r even
    // parse; here we only catch OTHER types whose resolved label maps to a
    // MAJOR segment (a minor/patch rule mislabelled onto `major`).
    if (automerge && type !== "major" && segments.includes("MAJOR")) {
      problems.push(
        `${BOT}: \`${type}\` updates are automerged while carrying a major change — a major must wait for a human, so the rule for \`${type}\` needs \`"automerge": false\``,
      );
    }
    if (releaseLabels.length === 0) {
      problems.push(
        `${BOT}: \`${type}\` updates get no release label from the bot config (resolved labels: [${labels}]) — ${GATE}'s bot fallback then stamps them \`${g.fallback}\` whatever their size`,
      );
      continue;
    }
    if (releaseLabels.length > 1) {
      problems.push(
        `${BOT}: \`${type}\` updates resolve to ${releaseLabels.length} release labels [${releaseLabels}] — ${GATE} refuses more than one, so the PR can never merge`,
      );
      continue;
    }
    const [label] = releaseLabels;
    if (!g.guard.has(label)) {
      problems.push(
        `${GATE} vs ${BOT}: the bot fallback's guard does not recognise \`${label}\`, which the bot sets on \`${type}\` updates — the fallback adds \`${g.fallback}\` on top and the PR carries two release labels`,
      );
    }
    const want = SEGMENT_OF[type];
    if (want && segments[0] !== want) {
      problems.push(
        `${BOT} vs ${RELEASE}: \`${type}\` updates are labelled \`${label}\`, which release.yml bumps as ${segments[0] ?? "nothing"} — a ${type} update must mint a ${want} release`,
      );
    }
  }
  return problems;
}

const REAL = {
  bot: readFileSync(join(ROOT, BOT), "utf8"),
  gate: readFileSync(join(ROOT, GATE), "utf8"),
  release: readFileSync(join(ROOT, RELEASE), "utf8"),
};

const withBot = (mutate) => {
  const cfg = JSON.parse(REAL.bot);
  mutate(cfg);
  return { ...REAL, bot: JSON.stringify(cfg) };
};
const ruleFor = (cfg, type) =>
  cfg.packageRules.find((r) => [].concat(r.matchUpdateTypes ?? []).includes(type));

const report = (problems) => `\n  ${problems.join("\n  ")}`;
const assertClean = (files) => {
  const problems = contractProblems(files);
  assert.deepEqual(problems, [], `the bot/release contract is broken:${report(problems)}`);
};
const assertBroken = (files, file, pattern) => {
  const problems = contractProblems(files);
  assert.ok(
    problems.some((p) => p.startsWith(file) && pattern.test(p)),
    `expected a problem naming ${file} matching ${pattern}, got:${report(problems)}`,
  );
};

test("the committed bot config and both release workflows keep the joint contract", () => {
  assertClean(REAL);
});

test("dropping the bot's label rules reds: the blind fallback would label every update", () => {
  const files = withBot((cfg) => {
    for (const rule of cfg.packageRules) delete rule.labels;
  });
  for (const type of ["major", "minor", "patch"]) {
    assertBroken(files, BOT, new RegExp(`\`${type}\` updates get no release label.*bot fallback`));
  }
  assertBroken(withBot((cfg) => delete cfg.packageRules), BOT, /`major` updates get no release label/);
});

test("re-enabling major automerge reds, whether set outright or inherited from the default", () => {
  assertBroken(withBot((cfg) => (ruleFor(cfg, "major").automerge = true)), BOT, /`major` updates are automerged/);
  assertBroken(withBot((cfg) => delete ruleFor(cfg, "major").automerge), BOT, /`major` updates are automerged/);
  assertBroken(withBot((cfg) => delete cfg.packageRules), BOT, /`major` updates are automerged/);
});

test("a mislabelled update type reds, naming the bot config and release.yml", () => {
  assertBroken(
    withBot((cfg) => (ruleFor(cfg, "major").labels = ["patch"])),
    `${BOT} vs ${RELEASE}`,
    /`major` updates are labelled `patch`, which release.yml bumps as PATCH/,
  );
  // Top-level `automerge: true` stays in force for minor; relabelling its
  // rule `major` makes it a major change by release.yml's reading.
  assertBroken(
    withBot((cfg) => (ruleFor(cfg, "minor").labels = ["major"])),
    BOT,
    /`minor` updates are automerged while carrying a major change/,
  );
});

// A literal, checked edit: a mutant whose target text has drifted away would
// otherwise leave the file unchanged and assert against the real tree.
const swap = (text, from, to) => {
  assert.ok(text.includes(from), `mutation target \`${from}\` not found — update this test's mutant`);
  return text.split(from).join(to);
};

test("a workflow that stops agreeing with the other two reds, naming that workflow", () => {
  assertBroken(
    { ...REAL, gate: swap(REAL.gate, "'^(patch|minor|major)$'", "'^(patch|minor)$'") },
    `${GATE} vs ${BOT}`,
    /guard does not recognise `major`/,
  );
  assertBroken(
    { ...REAL, release: swap(swap(REAL.release, '"major"', '"breaking"'), "major) MAJOR=", "breaking) MAJOR=") },
    `${GATE} vs ${RELEASE}`,
    /the gate counts .* but release.yml reads/,
  );
});

test("rewording the schedule or renaming the labels in all three files stays green", () => {
  assertClean(withBot((cfg) => (cfg.schedule = ["on the first day of the month"])));

  const rename = (text) => text.replace(/\b(patch|minor|major)\b/g, "semver:$1");
  assertClean({
    ...withBot((cfg) => {
      for (const r of cfg.packageRules) r.labels = r.labels.map((l) => `semver:${l}`);
    }),
    gate: rename(REAL.gate),
    release: rename(REAL.release),
  });
});

test("the same contract expressed through addLabels and update-type objects stays green", () => {
  assertClean(
    withBot((cfg) => {
      cfg.labels = ["dependencies"];
      cfg.major = { automerge: false, addLabels: ["major"] };
      cfg.packageRules = [
        { matchUpdateTypes: "minor", addLabels: ["minor"] },
        { matchUpdateTypes: ["patch"], addLabels: ["patch"] },
      ];
    }),
  );
});
