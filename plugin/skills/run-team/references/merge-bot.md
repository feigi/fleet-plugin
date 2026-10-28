# Landing a change on main

Label names in this file are roles; the Label map gives the string to type; a member never derives the map.

Evidence for the rules SKILL.md states in **A mid-run tooling fix** and in the `ready-to-merge` wake, keyed by the rule each justifies.

## When to fix the tooling mid-run, and its shape

**Triggers.** Identical failure twice. A member does the wrong thing while
correctly following the text. A rule exists but sits where it is read last. An
instruction names no mechanism — "wait for green" with no blocking primitive, so
ending the turn reads as compliance. A caller has to restate what the callee
should say itself.

**Shape — lean, or it rots.** Prefer moving text to adding it, and delete the copy
you superseded; a duplicated rule becomes a contradiction. Exit conditions go in a
section's first paragraph, never its last. Name the mechanism, or name who owns
the step. Cut before you append.

## A mid-run tooling fix lands through a PR

**Landing it.** The file being right is not the end of it. `main` carries a
ruleset with no bypass actors, so a direct `git push origin main` is **refused** —
`! [remote rejected] main -> main (push declined due to repository rule
violations)`, measured 2026-08-10 by a controller that tried exactly that at the
end of a 7-PR run. A mid-run tooling fix goes through a PR like every other
change, and that PR faces every required check any other PR faces — the set
`.github/rulesets/main.json` declares — so it carries a release label too.
Plan it as a PR the run's own merge queue lands, never as an edit-and-continue.

## You own the merge watcher, not the bot

A dying member takes a watcher down with it
and the queue stops silently.
