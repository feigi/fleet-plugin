# Landing a change on main

Evidence for the rule SKILL.md states in **Fix the tooling mid-run**, keyed by the rule it justifies.

## A mid-run tooling fix lands through a PR

**Landing it.** The file being right is not the end of it. `main` carries a
ruleset with no bypass actors, so a direct `git push origin main` is **refused** —
`! [remote rejected] main -> main (push declined due to repository rule
violations)`, measured 2026-08-10 by a controller that tried exactly that at the
end of a 7-PR run. A mid-run tooling fix goes through a PR like every other
change, and that PR faces every required check any other PR faces — the set
`.github/rulesets/main.json` declares — so it carries a release label too.
Plan it as a PR the run's own merge queue lands, never as an edit-and-continue.
