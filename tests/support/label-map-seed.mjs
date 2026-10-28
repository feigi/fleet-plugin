// The Label map every fixture that spawns a role-reading script seeds into its
// `.fleet/`, written through label-map.mjs's own cache writer so a fixture's
// cache is the format the reader reads, never a hand-copied one.
//
// Deliberately not a `.test.mjs`, so `node --test` never loads it as a suite.

import { LABEL_ROLES, writeLabelMap } from "../../plugin/scripts/label-map.mjs";

/**
 * Seed `.fleet/labels.json` for the repository at `workspace` and return the
 * file's path. With no overrides it is the identity map: every role mapped to
 * its own name, every origin `default`, the table `{ present: false, rows: {} }`.
 *
 * `roles` and `origin` are merged over those defaults, role by role, so
 * `{ roles: { "ready-for-agent": "agent-ready" } }` remaps one role and keeps
 * the other seven; a role set to `undefined` is left out of the file.
 * `table` and `derivedAt` replace the default whole.
 */
export function seedLabelMap(workspace, { roles = {}, origin = {}, table = { present: false, rows: {} }, derivedAt = new Date().toISOString() } = {}) {
  const each = (value) => Object.fromEntries(LABEL_ROLES.map((role) => [role, value(role)]));
  return writeLabelMap(
    {
      derivedAt,
      table,
      roles: { ...each((role) => role), ...roles },
      origin: { ...each(() => "default"), ...origin },
    },
    { cwd: workspace },
  );
}
