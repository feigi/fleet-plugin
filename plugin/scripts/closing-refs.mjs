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
