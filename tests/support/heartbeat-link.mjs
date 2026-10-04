// A path to fleet-heartbeat.mjs for tests to spawn it by, never its own name.
//
// `pkill -f fleet-heartbeat.mjs` — the line a controller runs to clear the
// heartbeat it backgrounded — matches whole command lines machine-wide: it
// SIGTERMs a test's heartbeat child too, and spawnSync reports that as
// `status: null` in whichever case was running. Observed in #2779: the failed
// spawnSync calls of one full-suite run landed together in a single span under
// 100ms long, right after such a sweep, and the file passes alone. The script
// resolves its own path by realpath (see is-cli.mjs), so the link runs the same
// code and its argv carries no `fleet-heartbeat.mjs` for a pattern kill to find.
//
// Deliberately not a `.test.mjs`, so `node --test` never loads it as a suite.

import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./temp-dir.mjs";

export const HEARTBEAT = fileURLToPath(new URL("../../plugin/scripts/fleet-heartbeat.mjs", import.meta.url));

/** What `pkill -f fleet-heartbeat.mjs` matches a command line against. */
export const KILL_PATTERN = /fleet-heartbeat\.mjs/;

/** A symlink to HEARTBEAT under a temp directory removed when this process exits. */
export function heartbeatLink() {
  const link = join(tempDir("hb-cli-"), "beat.mjs");
  symlinkSync(HEARTBEAT, link);
  return link;
}
