// A ticket's text as the fleet reads it off a saved `gh issue view --json
// title,body,comments,…`: its brief, its `Out of scope` section, the paths it
// names, a ruling posted outside its brief, and the text a member is
// dispatched with. A module of its own, importing nothing, because
// ticket-router.mjs, pull.mjs and dispatch-prompt.mjs each read a ticket this
// way, and the renderer has no use for the router's fit or anything it
// imports.

/** An `## Agent Brief` heading line: what marks the comment the brief is taken from. */
const AGENT_BRIEF = /^## Agent Brief/m;

/** The brief: the last comment carrying an `## Agent Brief` heading line, else the body. */
export function briefText(issue) {
  const comments = Array.isArray(issue.comments) ? issue.comments : [];
  for (let i = comments.length - 1; i >= 0; i--) {
    const body = String(comments[i]?.body ?? "");
    if (AGENT_BRIEF.test(body)) return body;
  }
  return String(issue.body ?? "");
}

/** A ruling or triage heading line: what a decision posted outside an `## Agent Brief` comment is headed with. */
const RULING_HEADING = /^## (?:Ruling|Triage).*$/m;

/**
 * The newest comment with a ruling or triage heading line and no `## Agent
 * Brief` heading line that comes after the last comment `briefText` takes the
 * brief from, or after none when there is no such comment, as its first ruling
 * or triage heading line and its `url`; null when none is.
 */
export function strandedRuling(issue) {
  const comments = Array.isArray(issue.comments) ? issue.comments : [];
  for (let i = comments.length - 1; i >= 0; i--) {
    const body = String(comments[i]?.body ?? "");
    if (AGENT_BRIEF.test(body)) return null;
    const heading = RULING_HEADING.exec(body);
    if (heading !== null) return { heading: heading[0], url: comments[i].url };
  }
  return null;
}

/** The line span `[at, end)` of `lines`' `Out of scope` section, heading to the next heading of its level or above; null when there is none. */
function outOfScopeSpan(lines) {
  const at = lines.findIndex((l) => /^#{1,6}\s*out of scope\b/i.test(l));
  if (at === -1) return null;
  const level = /^#+/.exec(lines[at])[0].length;
  for (let i = at + 1; i < lines.length; i++) {
    const h = /^(#{1,6})\s/.exec(lines[i]);
    if (h !== null && h[1].length <= level) return { at, end: i };
  }
  return { at, end: lines.length };
}

/** The `Out of scope` section of `text`, heading to the next heading of its level or above; null when there is none. */
export function outOfScope(text) {
  const all = text.split("\n");
  const span = outOfScopeSpan(all);
  return span === null ? null : all.slice(span.at, span.end).join("\n").trim();
}

/**
 * The ticket as a member is told it: its title, its brief (briefText), and the
 * body's `Out of scope` section when the brief carries none. An implementer's
 * dispatch carries it, and a review fix-applier's brief carries the same text
 * for the PR that implementer opened.
 */
export function ticketText(issue) {
  const text = briefText(issue).trim();
  const outside = outOfScope(text) === null ? outOfScope(String(issue.body ?? "")) : null;
  return [`Title: ${issue.title}`, text, ...(outside === null ? [] : [outside])].join("\n\n");
}

/** `text` with each declared placeholder's spelling `<name>` written `‹name›`, which dispatch-prompt.mjs does not read. */
export function defang(text, names) {
  return names.reduce((t, n) => t.split(`<${n}>`).join(`‹${n}›`), text);
}

/**
 * The file paths a brief names: every backticked token without whitespace that
 * holds a `/` or ends in an extension, in first-seen order, each once. The
 * brief's `Out of scope` section names no target, so its tokens are skipped.
 */
export function briefPaths(brief) {
  const all = brief.split("\n");
  const span = outOfScopeSpan(all);
  const kept = span === null ? brief : [...all.slice(0, span.at), ...all.slice(span.end)].join("\n");
  const paths = new Set();
  for (const m of kept.matchAll(/`([^`\n]+)`/g)) {
    const tok = m[1];
    if (/\s/.test(tok)) continue;
    if (tok.includes("/") || /\.[A-Za-z][A-Za-z0-9]*$/.test(tok)) paths.add(tok);
  }
  return [...paths];
}
