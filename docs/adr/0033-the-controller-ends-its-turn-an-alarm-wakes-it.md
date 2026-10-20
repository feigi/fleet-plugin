# 0033 — The controller ends its turn; an alarm wakes it

**Status:** Accepted. Ruled 2026-10-18 on #3183 by the maintainer, in a grilling session, against the measurements in `docs/research/omp-controller-wake.md`; the live run it was conditional on (#3484) closed COMPLETED on 2026-10-20. Specified in `docs/specs/2026-10-20-controller-alarm.md`. Amends ADR 0008: decisions 1 and 3 are retired.

## Context

ADR 0008 ruled that a turn-based fleet holds its own turn, because nothing external could wake an idle controller: a scheduler cannot run the reconcile (it holds none of the counts), a backgrounded watcher does not wake an idle agent (measured twice), and prose alone had failed twice. `fleet-heartbeat.mjs` therefore blocks inside the controller's turn and the runbook says "never end your turn on a drained queue".

ADR 0008 recorded the cost itself: the wait lives inside a turn, so it cannot outlive the run. It also named what it did not measure — an out-of-band mechanism "may have to be reconsidered".

The research measured the one thing ADR 0008 did not: an omp extension is a plugin-shipped part of the process the controller runs in. Its `ctx.setInterval` timer calling `pi.sendUserMessage(...)` started a real model turn in an idle interactive session in every idle fire tried, with the turn starting within a few milliseconds. It also started one with an unsent draft in the editor, which it left intact, and after an Esc-aborted turn. The extension's `process.pid` equals the pid `ledger.mjs rotate` records as the controller. What loses a wake is queueing one: a `followUp` queued during a turn is dropped when the user presses Esc.

## Decision

1. **The controller marks the beat and ends its turn.** On a drained queue it runs `fleet-heartbeat.mjs`, which writes the mark and returns, and ends its turn. "Never end your turn on a drained queue" is deleted.
2. **The alarm is an in-process omp extension**, `plugin/scripts/controller-alarm.mjs`, registered in `plugin/package.json#omp.extensions` beside `member-write-guard.mjs`. It is always loaded and inert unless its gate passes.
3. **The gate, on every 30 s poll:** the session is idle; `ctx.agent.kind` is `main`; `.fleet/heartbeat.json` `controller.pid` equals `process.pid`; `beat.stopped` is empty; and `now` is at or past `beat.at + beat.interval`. The `.fleet/` path is resolved once at `session_start` from `ctx.cwd`; outside a git repository no timer is set. It fires at most once per interval for the same `beat.at`, so a controller that never re-marks is re-alarmed every interval and not every poll.
4. **It never queues.** It fires only when idle, with no `deliverAs`: a queued `followUp` is lost on Esc, and a steer backgrounds the controller's running bash call. A busy controller is skipped until the next poll.
5. **The message** is `pi.sendUserMessage("[fleet-alarm] run ~/.fleet/bin/fleet-run fleet-event.mjs heartbeat")`: an ordinary user turn, told apart by its marker. Not `sendMessage({ triggerTurn })`, which a model once declined to run.
6. **Nothing is suppressed while the maintainer is talking.** A draft in the editor survives a fire.
7. **`fleet-heartbeat.mjs` keeps its name** and `interval()`, `mark()`, `--stop` and the back-off flags; it stays the only writer of `beat` and the only place the back-off is computed. It loses `--hold`, `heldThisCall`, `block()` and the `elapsed` key. An unrecorded mark never prints `→ end your turn`, because with no recorded `beat` the gate never passes and that line would be the silent stall.
8. **Phase 0 refuses when the alarm is not loaded.** The extension writes `~/.fleet/alarm/<pid>.json` holding `{pid, lstart}` at `session_start`; phase 0 compares it with the controller's pid and start time and refuses, "restart omp", on a missing file or a mismatch. There is no fallback to the hold. Comparing `lstart` makes a leftover file harmless.
9. **The stall rule is unchanged.** `fleet-state.mjs`'s `stallsAt` stays.
10. **The term is Alarm**, because Wake is taken (`CONTEXT.md`). The `fleet-event` kind keeps the name `heartbeat`.

## Consequences

- **It dies with the session, as the hold did.** Context exhaustion, a crashed harness or a budget stop still stops the run and the alarm with it. The restart layer ADR 0008 left open, and ADR 0025 ruled, is untouched.
- **A dead controller is flagged up to one interval later.** `beat.at` is set once when the controller goes idle instead of being refreshed every 240 s, and `stallsAt` judges `beat.at + 2 × beat.interval`. A death is therefore reported later by at most the interval less the old refresh, 960 s at the 1200 s ceiling. Accepted: the board's only reaction to a stall is not moving tickets.
- **The ceiling stays a bound on blindness.** ADR 0008 decisions 2 and 4 to 7 stand: the heartbeat takes no fleet state, the back-off, the 30-minute limit, backing off on "nothing to act on" and not on "output unchanged", and the beat not stopping on idleness. Decision 8's one-writer state file stands too, less the `elapsed` key and the paragraph about re-reading the file after a hold, which go with the hold. An alarm turn, like a hold's end, is a wake and never a verdict: the controller runs `fleet-event.mjs heartbeat` and the tick reads the run as it stands then.
- **A session without the extension cannot start a run.** An omp that was started before the plugin was reinstalled, or launched as `bun …/dist/cli.js` where no argv carries `omp` and the ledger records no controller, is refused at phase 0.
- **The mark moves from beating often to never beating on a failed write.** ADR 0008 treated a failed state write as a fire because beating too often is harmless. With no hold, a mark that did not land arms nothing, so the heartbeat's output says so instead of "end your turn".
- **An alarm turn is not suppressed during a conversation.** An alarm can arrive while the maintainer is mid-exchange with the controller; the draft survives and the turn is an ordinary one.
- **Nothing prunes `~/.fleet/alarm/`.** A leftover file never matches a live process's start time.

## Rejected: routes from outside the session

- **`hub send` / `write agent://<name>`** is the IRC bus, which is in-process only with self-send forbidden, and no socket or IPC listener exists, so a detached timer cannot reach the controller.
- **Collab** is the one real external route, and needs a write-capable room on every session (`collab.autoStart = control`, no CLI flag and no extension API to start hosting), traffic through the relay unless one is self-hosted, and a hand-written protocol guest, since `omp join` needs a TTY.
- **`/loop`** is TUI-only and a human enables it per session.
- **A sleeping background `task`** cannot retire the rule: the controller would have to start a new sleeper before every turn ends, which is "never end your turn" in another form.
