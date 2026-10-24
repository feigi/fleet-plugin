// The release labels, as every reader of them counts them: a PR carries
// exactly one of `patch`, `minor` and `major`, and a repository whose label
// list defines none of the three has no release label to count. Shared by
// finisher-label.mjs, which counts them before it labels, and the finisher
// gate in ledger.mjs, which counts them before it dispatches a finisher.

export const RELEASE_LABELS = Object.freeze(["patch", "minor", "major"]);

// `gh label list` reads at most this many labels.
export const LABEL_LIST_LIMIT = 1000;

// The `gh` arguments that read the repository's label list.
export const LABEL_LIST_ARGS = Object.freeze(["label", "list", "--json", "name", "--limit", String(LABEL_LIST_LIMIT)]);

// The release labels among the label names `names`, in RELEASE_LABELS' order.
export const releaseLabelsIn = (names) => RELEASE_LABELS.filter((r) => names.includes(r));

// What the repository's label names `defined`, as LABEL_LIST_ARGS reads them,
// say of the release labels: "defined" when they name one, "undefined" when
// they name none, and "cut-off" when they name none but fill the limit — a
// list cut off before the release labels proves nothing of their absence.
export function releaseLabelsDefined(defined) {
  if (releaseLabelsIn(defined).length > 0) return "defined";
  return defined.length >= LABEL_LIST_LIMIT ? "cut-off" : "undefined";
}
