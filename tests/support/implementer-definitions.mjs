// The implementer definitions plugin/agents ships, read off disk — one
// `fleet-implementer-<cell>` name per `fleet-implementer-<cell>.agent.md` — so a
// test that holds every implementer to a rule covers a Cell the day its
// definition lands, and every such test reads the list the same way.
//
// A bare `fleet-implementer.agent.md` is not in the list: it names no Cell.
// tier-roles.test.mjs reads the directory itself because it is the test that
// catches such a file.

import { readdirSync } from "node:fs";

/** @returns {string[]} each implementer definition's name, without `.agent.md` */
export const implementerDefinitions = () =>
  readdirSync(new URL("../../plugin/agents/", import.meta.url))
    .map((f) => /^(fleet-implementer-.+)\.agent\.md$/.exec(f)?.[1])
    .filter(Boolean);
