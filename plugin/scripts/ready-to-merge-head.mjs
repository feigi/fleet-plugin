// The head record, as its writer posts it and its reader reads it back: a PR
// comment whose whole body is `ready-to-merge-head: <sha>`, naming the head
// the labeller audited, posted immediately before the `ready-to-merge` label.
// Shared by finisher-label.mjs, which writes it, and labelled-head.mjs, which
// the merge bot runs to read it, so the grammar is stated once. The prefix is
// not a label: it is `ready-to-merge-head:` whatever string the Label map
// gives `ready-to-merge`.

// The whole body: 40 lowercase hex after the prefix, and nothing else but
// trailing whitespace (a newline, CRLF, blank lines). A prefix before the
// keyword, a suffix after the SHA, a second line, a short or uppercase SHA is
// not a record.
const HEAD_RECORD = /^ready-to-merge-head: ([0-9a-f]{40})\s*$/;

// The body the writer posts for `sha`.
export const headRecordBody = (sha) => `ready-to-merge-head: ${sha}`;

// The newest record among `comments` (`{body, createdAt}` as `gh pr view --json
// comments` prints them): newest by `createdAt`, the later array position
// winning a tie, since the sort is stable. A comment that is not a record,
// however new, hides nothing. Answers the SHA, or null when no comment is a
// record.
export function newestHeadRecord(comments) {
  const records = comments
    .map((c) => ({ at: c.createdAt, m: HEAD_RECORD.exec(c.body) }))
    .filter((c) => c.m !== null)
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return records.length === 0 ? null : records[records.length - 1].m[1];
}
