// What a test guard may ask of a `git worktree list --porcelain` listing.
//
// Every `worktree` line carries the full path, and a fixture's path starts
// with the operator's TMPDIR, so a guard that greps the whole listing for a
// fixture's name or for an attribute answers for TMPDIR as well: one holding
// `locked`, `stale-wt` or `79-brief` failed the guard that looks for its
// absence (#2531). These read only the parts a fixture controls.

/**
 * The names the listing gives its worktrees: each `worktree` line's last path
 * component, and each `branch refs/heads/` line's branch. The directories
 * above a worktree are never a name.
 */
export const worktreeNames = (porcelain) =>
  porcelain.split("\n").flatMap((l) =>
    l.startsWith("worktree ") ? [l.slice("worktree ".length).replace(/.*\//, "")]
    : l.startsWith("branch refs/heads/") ? [l.slice("branch refs/heads/".length)]
    : []);

/**
 * Whether any worktree in the listing carries the attribute `attr`
 * (`locked`, `prunable`, `detached`). git prints an attribute on a line of its
 * own, the bare word or the word, a space and a reason, so the line is matched
 * whole and a path containing the word never is.
 */
export const hasAttribute = (porcelain, attr) =>
  porcelain.split("\n").some((l) => l === attr || l.startsWith(`${attr} `));
