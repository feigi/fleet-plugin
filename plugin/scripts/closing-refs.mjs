// Which of a PR's closingIssuesReferences are in the PR's own repository.
// GitHub lists a reference into another repository there too, under that
// repository's issue number; read by number alone it stands in for this
// repository's issue of the same number. Every reader of the field counts a
// reference through this one rule.
//
// The PR's own repository is its url less `/pull/<pr>`; a url not ending so
// cannot be read. A reference is in it when its url is that repository's
// `/issues/<number>`, or, carrying no url, when its repository's
// `<owner>/<name>` ends that repository's url. A reference with no integer
// number, or with neither a url nor a repository to place it by, cannot be
// read: it is never taken for the PR's own repository's.

// The unique issue numbers, in GitHub's order, of the references in `refs`
// that are in PR `pr`'s own repository, its url being `prUrl`. Throws an Error
// whose message names what could not be read, phrased to follow the read's
// own "answered": `url <prUrl>, not PR #<pr>'s`, `a reference with no issue
// number`, `a reference to #<n> with neither a url nor a repository`.
export function ownClosingIssues(pr, prUrl, refs) {
  if (!Array.isArray(refs)) throw new Error("no closingIssuesReferences array");
  const suffix = `/pull/${pr}`;
  if (typeof prUrl !== "string" || !prUrl.endsWith(suffix)) throw new Error(`url ${prUrl}, not PR #${pr}'s`);
  const own = prUrl.slice(0, -suffix.length);
  const str = (v) => typeof v === "string" && v !== "";
  const numbers = new Set();
  for (const ref of refs) {
    const n = ref?.number;
    if (!Number.isInteger(n)) throw new Error("a reference with no issue number");
    const repo = ref.repository;
    let isOwn;
    if (str(ref.url)) isOwn = ref.url === `${own}/issues/${n}`;
    else if (str(repo?.name) && str(repo?.owner?.login)) isOwn = own.endsWith(`/${repo.owner.login}/${repo.name}`);
    else throw new Error(`a reference to #${n} with neither a url nor a repository`);
    if (isOwn) numbers.add(n);
  }
  return [...numbers];
}

// A PR's closingIssuesReferences leaves out an issue only a commit message's
// closing keyword names, yet GitHub closes that issue when the PR merges with
// a merge commit. This reads those: the issues the messages of `commits` — the
// `commits` entries `gh pr view --json commits` lists, each with `oid`,
// `messageHeadline` and `messageBody` — close, in the order their first
// mention comes in, as `{number, oid}` with `oid` the first commit that names
// the number. It counts what drop-merged-label.sh's commit scan counts, and a
// colon after the keyword besides, which GitHub's docs name as closing
// (`Closes: #N`) and that scan leaves out: per line of the message, a
// `close`, `closes`, `closed`, `fix`, `fixes`, `fixed`, `resolve`, `resolves`
// or `resolved` keyword, in any case, with no letter, digit or `_` before it —
// so `bugfix #N` and `prefix #N` are not keywords — and then an optional `:`,
// optional whitespace and `#N`. A match never crosses a line: whitespace
// before `#N` excludes a newline, and a newline is itself a character the
// keyword may follow, so the message is scanned whole. A letter or digit is
// one in Unicode's sense; the scan's `[:alnum:]` agrees under a UTF-8 locale,
// but under `C` a non-ASCII letter is none, so there the scan finds #5 in
// `éfix #5` and this one does not. A bare `#N`, `Refs #N`, a keyword before
// `owner/repo#N` or a URL is not a match.
// The message is the headline, a newline and the body, but gh cuts a long
// headline short with `…` and opens the body with `…` and the headline's rest,
// so a headline ending in `…` and a body starting with one are joined back
// into the one line they were. Throws an Error whose message names what could
// not be read, phrased to follow the read's own "answered": `no list of
// commits`, `a commit with no oid`, `commit <oid> with no message`.
const COMMIT_CLOSE = /(?:^|[^\p{L}\p{N}_])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?[ \t\r\v\f]*#([0-9]+)/giu;

export function commitClosingIssues(commits) {
  if (!Array.isArray(commits)) throw new Error("no list of commits");
  const first = new Map();
  for (const c of commits) {
    if (typeof c?.oid !== "string" || c.oid === "") throw new Error("a commit with no oid");
    const body = c.messageBody ?? "";
    if (typeof c.messageHeadline !== "string" || typeof body !== "string") throw new Error(`commit ${c.oid} with no message`);
    const cut = c.messageHeadline.endsWith("…") && body.startsWith("…");
    const message = cut ? `${c.messageHeadline.slice(0, -1)}${body.slice(1)}` : `${c.messageHeadline}\n${body}`;
    for (const m of message.matchAll(COMMIT_CLOSE)) {
      const number = Number(m[1]);
      if (Number.isSafeInteger(number) && !first.has(number)) first.set(number, c.oid);
    }
  }
  return [...first].map(([number, oid]) => ({ number, oid }));
}

// The most commits `gh pr view --json commits` lists: it answers the first
// COMMITS_LIMIT of a PR's commits and no count of the rest, so an answer of
// that many may be cut off, and a commit it does not hold was not read.
export const COMMITS_LIMIT = 100;
