# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker  | Meaning                                  |
| -------------------------- | --------------------- | ---------------------------------------- |
| `needs-triage`             | _no equivalent_       | Maintainer needs to evaluate this issue  |
| `needs-info`               | _no equivalent_       | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`     | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`     | Requires human implementation            |
| `wontfix`                  | `wontfix`             | Will not be actioned                     |

Only three of the five roles resolve. `needs-triage` and `needs-info` do not
exist in this repo — `gh api repos/feigi/claude-config/labels/needs-triage` and
`.../needs-info` both return HTTP 404. For those two roles, skip the label step
rather than inventing a string; don't assume an untriaged issue carries a label.

When a skill mentions a role that does map (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.
