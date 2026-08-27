// Scraper for per-member model/effort facts. Pure over the harness's own
// subagent transcripts: no clock, no network, no gh. See
// docs/specs/2026-08-27-fleet-member-outcomes-instrumentation-design.md.

// `<synthetic>` is not a model — it is the harness labelling a turn it
// generated itself, and mapping it to anything would invent a data point. The
// `[1m]` suffix is a context-window variant of the SAME model: meta.json writes
// `claude-opus-5[1m]` while that member's own messages write `claude-opus-5`,
// so keeping both spellings would split every count in half.
export function normalizeModel(raw) {
  const s = String(raw ?? "").trim();
  if (!s || s === "<synthetic>") return null;
  return s.replace(/\[[^\]]*\]$/, "");
}

// A member's name is the only place its unit of work is recorded — nothing
// writes ticket or PR into meta.json. Four live finisher spellings all book a
// PR: `fix-pr-<n>`, `review-pr-<n>`, `finisher-pr-<n>`, `finish-pr-<n>`, plus
// `finisher-<n>` and `finish-<n>` without the `-pr-` infix. `merge-bot-<n>` is
// deliberately excluded: its number is a WAVE index. The `-b`, `-c`, `-d` retry
// suffixes are stripped first, because a re-dispatched member works the same unit.
export function parseMemberName(name) {
  const s = String(name ?? "").trim().replace(/-[a-z]$/, "");
  let m = /^(?:fix|review|finish|finisher)-pr-(\d+)$/.exec(s);
  if (m) return { ticket: "", pr: m[1] };
  m = /^finish(?:er)?-(\d+)$/.exec(s);
  if (m) return { ticket: "", pr: m[1] };
  m = /^impl-(\d+)$/.exec(s);
  if (m) return { ticket: m[1], pr: "" };
  return { ticket: "", pr: "" };
}
