// Per-Pull noise of each Cell's figures, and the Pulls a comparison needs — derive script for router-noise.md.
// Usage: node docs/research/router-noise-derive.mjs <checkout of e5040b9a>
// Reads the committed corpus of that checkout through the Router's own modules.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
const S = (f) => join(root, "plugin", "scripts", f);
const { parseFeatures, attribute, tally, generations } = await import(S("pull-attribution.mjs"));
const { parseTsv } = await import(S("member-outcomes.mjs"));
const { parseTierOutcomes } = await import(S("tier-outcomes.mjs"));
const { ruleStratum } = await import(S("ticket-router.mjs"));

const read = (f) => readFileSync(join(root, "docs", "metrics", f), "utf8");
const features = parseFeatures(read("ticket-features.tsv"));
const members = parseTsv(read("member-outcomes.tsv"));
const verdicts = parseTierOutcomes(read("tier-outcomes.tsv"));
const all = attribute({ features, members, tiers: verdicts, windowStart: "2026-10-03", stratum: ruleStratum });
const units = all.filter((u) => u.pull.exploration_draw !== "" || u.pull.sizing_src === "rule");

const stats = (xs) => {
  const n = xs.length, mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const s = [...xs].sort((a, b) => a - b), q = (p) => s[Math.min(n - 1, Math.floor(p * n))];
  return { n, mean, sd, cv: sd / mean, p50: q(0.5), p90: q(0.9), max: s[n - 1] };
};
const f2 = (x) => x.toFixed(2);
// Pulls per Cell for 80% power, two-sided 5%, to see a relative difference d at coefficient of variation cv.
const nFor = (cv, d) => Math.ceil(2 * (1.96 + 0.8416) ** 2 * cv ** 2 / d ** 2);

const cvs = { usd: [], min: [] };
for (const c of tally(units, generations(all))) {
  if (!c.pulls.length) continue;
  const usd = stats(c.pulls.map((u) => u.spend));
  const min = stats(c.pulls.map((u) => u.workS / 60));
  cvs.usd.push(usd.cv); cvs.min.push(min.cv);
  console.log(`${c.cell} gen=${c.generation} n=${c.n} merged=${c.merged} fail=${c.failed}/${c.claims}`);
  console.log(`  $/Pull mean ${f2(usd.mean)} sd ${f2(usd.sd)} cv ${f2(usd.cv)} p50 ${f2(usd.p50)} p90 ${f2(usd.p90)} max ${f2(usd.max)}`);
  console.log(`  min/Pull mean ${f2(min.mean)} sd ${f2(min.sd)} cv ${f2(min.cv)} p50 ${f2(min.p50)} p90 ${f2(min.p90)}`);
}
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
for (const [k, list] of Object.entries(cvs)) {
  const cv = avg(list);
  console.log(`${k}: mean cv ${f2(cv)}; Pulls per Cell to see a difference of 20% ${nFor(cv, 0.2)}, 30% ${nFor(cv, 0.3)}, 50% ${nFor(cv, 0.5)}`);
}
// Fail rate: Pulls per Cell to tell 19% from 19%+d (two proportions, 80% power, 5% two-sided).
const p1 = 0.19;
for (const d of [0.1, 0.15, 0.2]) {
  const p2 = p1 + d, pb = (p1 + p2) / 2;
  const n = Math.ceil((1.96 * Math.sqrt(2 * pb * (1 - pb)) + 0.8416 * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))) ** 2 / d ** 2);
  console.log(`fail rate ${p1} vs ${f2(p2)}: ${n} Pulls per Cell`);
}
