// Which open PRs the fleet owns, as one rule for every reader. An Owned PR is
// an open, non-draft PR whose `author.login` is the login the fleet's `gh`
// credentials answer to: every member acts through those credentials, so every
// PR the fleet opens carries it. A bot's PR, a stranger's, a fork's and a draft
// are not owned, whatever they close.
//
// Each reader reads the login itself, at its own read, with GH_LOGIN_ARGS, and
// parses what `gh` printed with loginOf(). A read that failed or printed no
// login is a refusal by that reader, never "owns nothing".

// The `gh` arguments whose stdout is the login the credentials answer to.
export const GH_LOGIN_ARGS = ["api", "user", "-q", ".login"];

// The login `gh api user -q .login` printed, or null when it printed none.
export function loginOf(stdout) {
  const login = typeof stdout === "string" ? stdout.trim() : "";
  return login === "" ? null : login;
}

const isRecord = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

// Whether `pr`, a row of `gh pr list --json author,isDraft,…`, carries what
// isOwnedPr() reads: an author that is null (an account GitHub no longer has)
// or has a string login, and a boolean draft flag. A reader refuses a row that
// does not, since whether it is owned is unknown.
export function ownershipReadable(pr) {
  return isRecord(pr) && (pr.author === null || (isRecord(pr.author) && typeof pr.author.login === "string")) && typeof pr.isDraft === "boolean";
}

// Whether `pr`, a row of `gh pr list --json author,isDraft,…`, is an Owned PR
// of `login`. An absent or malformed author or draft flag is not owned.
export function isOwnedPr(pr, login) {
  return typeof login === "string" && login !== "" && pr?.author?.login === login && pr?.isDraft === false;
}
