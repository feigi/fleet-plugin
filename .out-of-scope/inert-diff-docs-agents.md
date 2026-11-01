# `docs/agents/` as Inert Diff Prose

The finisher skips the acceptance mutation only on `finisher-scope.mjs`'s **Inert diff**
verdict, and a markdown file under any `agents` directory segment is prompt surface, never
prose. We don't accept proposals to exempt `docs/agents/` from that rule, so a PR that edits
`docs/agents/*.md` still runs the mutation, or halts the finisher when none can be built.

## Why this is out of scope

**Those files are instructions, not documentation.** The setup skill writes them and adds an
`## Agent skills` block to `AGENTS.md` or `CLAUDE.md` that sends every agent to
`docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md` and `docs/agents/domain.md`
for how to work in the repository. This repository's own `AGENTS.md` carries that block. An
edit there changes what an agent does on its next read, exactly as an edit under `skills/`
does.

**`triage-labels.md` is also program input.** `label-map.mjs ensure`, the Label map step
run-team's phase 0 runs at every run start, reads the repository's triage-label table from
`docs/agents/triage-labels.md` and derives the label strings every member types from it. A
diff to that file can change which label the fleet applies, with no code in the diff.

**The rule has to hold in a repository that is not this one.** fleet-ctl runs wherever it is
installed, and any repository the setup skill has run in has the same files with the same
readers. A narrower exemption for one file would be a second rule to keep in step with the
setup skill's templates.

The cost is real: a PR that touches only `docs/agents/` halts the finisher for a human. That
is the trade the ruling makes: instruction-file edits stay behind a person.

## What would reopen this

- The setup skill stops pointing agents at `docs/agents/` from `AGENTS.md` or `CLAUDE.md`,
  and `label-map.mjs` stops reading `docs/agents/triage-labels.md`, so nothing reads those
  files as instructions any more.

## Prior requests

- #4026 — "Inert-diff verdict treats .out-of-scope/ and docs/agents/ as prompt surface, so a
  docs-only PR halts the finisher" (ruled: the root `.out-of-scope/` records became prose;
  `docs/agents/` did not)
- #3989 — "Reduce fleet halts: docs-only mutation check, rebase after a fix, stale finisher
  worktree, bot holds, dispositions-escalate" (item 1)
