// What GitHub's search does to `gh pr list --search created:… --limit N`, for
// the `gh` stubs of the suites that run pr-cost.mjs.
//
// Two things a stub that `cat`s its fixture cannot say: the `created:` window
// selects only the PRs created in it (`>=A`, or `A..B` with both days in), and
// the answer is cut at 1,000 rows whatever `--limit` asks for — the cap
// pr-cost.mjs must read around. A fixture row's creation day is its
// `createdAt`, and the window's first day when it has none.
//
// `searchPrs` is embedded in a stub's source with `${searchPrs}` (a function
// declaration's text), so it must stay self-contained: no import, no closure.
//
// Deliberately not a `.test.mjs`, so `node --test` never loads it as a suite.

import { WINDOW_START } from "../../plugin/scripts/pr-cost.mjs";

/**
 * The rows `gh pr list` would print for `args`: `prs` filtered by the
 * `created:` qualifier of `--search` when there is one, then cut at
 * `min(--limit, 1000)` — the 30 `gh` defaults to when `--limit` is absent.
 */
export function searchPrs(prs, args, firstDay) {
  const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const search = flag("--search");
  const created = /(?:^|\s)created:(\S+)/.exec(search ?? "")?.[1];
  let [lo, hi] = [undefined, undefined];
  if (created?.startsWith(">=")) lo = created.slice(2);
  else if (created) [lo, hi] = created.split("..");
  const dayOf = (p) => String(p.createdAt ?? firstDay).slice(0, 10);
  const inWindow = prs.filter((p) => (lo === undefined || dayOf(p) >= lo) && (hi === undefined || dayOf(p) <= hi));
  const limit = Number(flag("--limit") ?? 30);
  return inWindow.slice(0, Math.min(limit, 1000));
}

/** Source for the top of a node stub: `searchPrs` and the window's first day. */
export const SEARCH_STUB_SRC = `${searchPrs}\nconst FIRST_DAY = ${JSON.stringify(WINDOW_START)};\n`;
