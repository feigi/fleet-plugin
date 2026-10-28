# Label map

## What it is for

The string the consumer repository's tracker uses for each of the eight
**Label roles** — `needs-triage`, `needs-info`, `ready-for-agent`,
`ready-for-human`, `wontfix`, `in-progress`, `onhold`, `ready-to-merge`. A
role is a name the fleet's scripts and runbooks use for a label's meaning and is
never typed into a `gh` command; the Label map is where it becomes a string.
Its default string is its own name, so a repository whose labels are exactly
those needs nothing declared. `wayfinder:*` and `patch`/`minor`/`major` are not
roles: they stay literal. The map is derived from what the repository already
declares and what its tracker already has, never from a table of spellings the
plugin knows
([ADR 0035](../adr/0035-label-strings-come-from-the-consumer-repo-into-fleet-state-the-shipped-surface-names-roles.md)).

**Status.** The derivation step, the cache, the reader and `show` are shipped,
and the run-team controller's phase 0 runs the derivation step. Nothing else
reads the map yet: the scripts that query or set a label still use each role's
own name as its string (`candidates.mjs`'s Shortlist exclusions, for one), so
until that migration lands a repository's role labels must be exactly the role
names. Steps 5 and 6 below, and the opinionated choices that name the shipped
runbooks and every entry point, describe the target the follow-up tickets
reach: #3865 and #3866 for the runbook prose, #3867–#3873 for the scripts.

## How it works
1. **Declare.** The repository's triage-label table,
   [`docs/agents/triage-labels.md`](../agents/triage-labels.md), is the one
   table read: the one whose second header cell is `Label in our tracker`. A
   row is a role in its first cell and the tracker's string in its second. The
   plugin reads it and never writes it, or any other consumer file.
2. **Derive.** [`label-map.mjs ensure`](../../plugin/scripts/label-map.mjs) is
   the **Label map derivation step**. It reads the cache, the table and the
   tracker's live label list, and decides each role: *certain* (the table's
   string, the cached answer, or the role's own name, each existing live) or
   *uncertain* (renamed away, absent, or a near match such as `on-hold` beside
   `onhold`). Every role certain: it prints the map, exit 0, writing the
   cache only when it derived one. Any role uncertain: it prints the question,
   each uncertain role with its suggestion and the alternatives found, exit 3,
   and writes nothing. A table that breaks the string rules is exit 1, naming
   each role, the rule and the fix. A repository, `gh` or cache that cannot be
   read is exit 2.
3. **Answer.** The entry point asks the maintainer once, listing every
   uncertain role together. `label-map.mjs set` writes the map from a fresh
   derivation plus the answer: explicit `<role>=<label>` pairs,
   `--accept-suggestions`, and `--create`, under which a confirmed string the
   tracker lacks is created with `gh label create`. Without `--create` no label
   is ever created. The maintainer is told, in the same reply, how to make the
   answer permanent: edit the table.
4. **Cache.** `.fleet/labels.json` in the main checkout, resolved like the
   Recipe cache so a worktree and the main checkout name one file. It holds the
   table as it was when derived, the string per role and the origin of each
   (`table`, `default` or `maintainer`). It is gitignored, never committed and
   never written by hand; deleting it forces a fresh derivation.
5. **Read** (target; #3867–#3873). Every script that reads or writes a label
   is to resolve its role through the one reader in `label-map.mjs`, or
   `label-map.mjs show <role>` from shell. The reader never reads the tracker
   and has no defaults: an absent or broken map is a refusal naming the
   derivation step.
6. **Entry points** (target for all but phase 0; #3865). The run-team
   controller's phase 0 runs the derivation step first, before any query; the
   solo entry points are to do the same, and these are the only places that
   ask. A dispatched member — implementer, finisher, fix-applier, merge bot —
   is to only read the map, and to report a refusal to the controller as a
   halt cause, like a Recipe cache refusal.

## Opinionated choices

- **Roles, not strings, in everything shipped** (target; #3865, #3866). A prose
  rule at the top of each shipped runbook is to say label names there are
  roles. A member never derives the map itself.
- **The tracker's own spelling wins.** Whenever a string exists live, the map
  stores the live label's spelling, never the table's or the answer's. GitHub
  matches label names case-insensitively, so the scripts' exact comparisons
  against what `gh` returns need no case folding.
- **Ask when unsure, once.** A near match is a suggestion, never a decision. A
  carried answer stands until its label is gone, or until the table or another
  role's default comes to claim its string, so the maintainer is asked once.
- **A vanished label is never suggested back.** A role whose cached string is
  gone from the tracker is uncertain, and a suggestion equal to the vanished
  string is withheld, so no label the maintainer renamed or deleted is
  re-created by default.
- **The map is checked against the tracker on every derivation, not trusted
  until its inputs change.** A label renamed in the tracker changes no file the
  fleet can see, so the cached map is validated against the live label list at
  the start of the run-team controller's phase 0, and of every entry point once
  #3865 lands. This is the one place it differs from the Recipe cache.
- **A record the fleet posts and parses back is not a label.** The head record
  `ready-to-merge-head: <sha>` keeps its fixed grammar even though it contains a
  role name, so re-mapping `ready-to-merge` never orphans a record already
  posted.
