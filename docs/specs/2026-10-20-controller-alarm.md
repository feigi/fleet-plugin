# Controller alarm: the controller ends its turn, and an in-process omp extension starts the next one

Date: 2026-10-20
Status: spec, ticketed 2026-10-20 (#3621, #3622, #3623). Spec 7 of the 2026-10-13 determinism review; the "external wake" #3183 was to decide.
Relates to: ADR 0008 (decisions 1 and 3 retired by this spec), ADR 0033 (this spec's ruling), `docs/research/omp-controller-wake.md` (the measurements), ADR 0020 (the other plugin-shipped omp extension), ADR 0019 (shipped surface cites nothing), `docs/specs/2026-10-13-runbook-diet-and-incident-policy.md` § Series.
Conditional, met: stage 2 (#3484, the maintainer's live run) was a gate. It closed COMPLETED on 2026-10-20; had it failed, #3485 would have closed `wontfix` with only ADR 0008's Status line amended. The ticket carries no comment of results, so this spec relies on the closure reason and not on measurements from the live run.
Base tree: `main` at `42767445` (2026-10-20).

## Problem Statement

ADR 0008 decided that the controller holds its own turn, because nothing could wake an idle one. `fleet-heartbeat.mjs` blocks in a bash call for up to `--hold` seconds, prints how much of the interval remains and tells the controller to re-issue it "without ending its turn". The runbook's rule for it is "never end your turn on a drained queue".

That holds the controller's turn open for the whole life of a quiet run. It makes the controller's context grow with every re-issue, and it ties the heartbeat's correctness to a hold arithmetic (`elapsed`, `heldThisCall`) that exists only because no harness lets one command block for a whole interval.

`docs/research/omp-controller-wake.md` measured that an omp extension's `ctx.setInterval` calling `pi.sendUserMessage(...)` starts a real model turn in an idle interactive session. Nothing outside the omp process can do the same: the IRC bus is in-process with no self-send, RPC mode only accepts prompts from the process that launched it, and collab needs a write-capable room on every session plus the relay.

## Solution

The controller marks the beat and ends its turn. A plugin-shipped omp extension, the **alarm**, polls every 30 s and, when the controller is idle and the beat has fallen due, starts a new turn with an ordinary user message that tells the controller to run `fleet-event.mjs heartbeat`. "Never end your turn on a drained queue" is deleted.

## User Stories

- As the controller, I want to end my turn when there is nothing to do, so that a quiet night does not grow my context with re-issued hold calls.
- As the controller, I want the next turn to arrive with the command to run, so that the level-check still happens without my holding a call open.
- As a maintainer, I want phase 0 to refuse when the alarm is not armed, so that a run never ends its turn into a session nothing will wake.
- As a maintainer typing into the controller's editor, I want an alarm turn not to eat my draft.

## Implementation Decisions

**D1. The mechanism.** An in-process omp extension, `plugin/scripts/controller-alarm.mjs`, registered in `plugin/package.json#omp.extensions` beside `member-write-guard.mjs`. Like that file it loads into every omp session on the box, so it is inert unless its gate passes. It dies with the session, as the hold did; session death stays out of scope.

**D2. The gate, on every 30 s poll.** All must hold:

- `ctx.isIdle()`;
- `ctx.agent.kind === "main"`;
- `.fleet/heartbeat.json` `controller.pid === process.pid` (measured equal to `proc.mjs`'s nearest-`omp` ancestor);
- `beat.stopped` is empty;
- `now >= beat.at + beat.interval * 1000`.

The repository's `.fleet/` path is resolved once, at `session_start`, from `ctx.cwd`. When it cannot be resolved — outside a git repository, or inside one whose git fails or times out — no timer is set and no alarm file is written (D8). A poll that cannot read or judge `.fleet/heartbeat.json` is "not due" and writes nothing: `fleet-state.mjs`'s `readState` prints a warning on every degraded read, which would repeat in the TUI every 30 s, so `readState` gains an optional warning sink that defaults to `console.error`, leaving every existing caller unchanged. It fires at most once per interval for the same `beat.at`: a controller that never re-marks is re-alarmed every interval, not every poll. The decision is a pure function, `alarmDue({ kind, pid, controller, beat, idle, now, firedFor })`, with `firedFor` null or `{ at, firedAt }` (the `beat.at` last fired for and when).

**D3. It never queues.** It fires only when idle, with no `deliverAs`. A queued `followUp` is lost when the maintainer presses Esc, and a steer backgrounds the controller's running bash call. A busy controller is skipped until the next poll.

**D4. The message.** `pi.sendUserMessage("[fleet-alarm] run ~/.fleet/bin/fleet-run fleet-event.mjs heartbeat")`. It is an ordinary user turn and the marker tells it apart from a typed one. Not `sendMessage({ triggerTurn })`, which a model once declined to run.

**D5. No suppression while the maintainer is talking.** A draft in the editor survives a fire (measured).

**D6. The term.** **Alarm**, because **Wake** is taken (`CONTEXT.md`: a Send that resumes a finished member). The SKILL.md event table's `Heartbeat` row becomes `Alarm (a [fleet-alarm] turn)`, still mapping to `fleet-event.mjs heartbeat`. The `fleet-event` kind keeps the name `heartbeat` and its `--fold-unchanged`.

**D7. `fleet-heartbeat.mjs`.** The name stays.

- Keeps `interval()`, `mark()`, `--stop`, and `--base`, `--ceiling`, `--multiplier`, `--state`. It remains the only writer of `beat` and the only place the back-off is computed; the extension only reads.
- Loses `--hold`, `heldThisCall`, `block()` and its `Atomics.wait`, and the `elapsed` key, including its validation and carry in `fleet-state.mjs`.
- Output is one line, e.g. `heartbeat: beat marked, alarm due in 600s (quiet=1) → end your turn`.
- A mark that was not recorded never prints `→ end your turn`. With no recorded `beat` the gate never passes, so that line would be the drained-queue stall with nothing to report it; ADR 0008's rule that beating too often is harmless and never beating is the defect holds here. A failed write, or a degraded state file left as it is, prints a line that names the failure and says no alarm is armed.

**D8. Phase 0 refuses when the alarm is not armed.** At `session_start`, for the main session only, the extension resolves `.fleet/` (D2) and sets its timer, and only then writes `~/.fleet/alarm/<pid>.json` holding `{pid, lstart, fleet}`, `fleet` being the `.fleet/` path it resolved. A session that set no timer writes no file, so the file proves the timer is armed and not only that the extension loaded. Phase 0's first step, `alarm`, compares the file's `pid` and `lstart` with the controller's pid and start time, read the way the ledger reads them (`proc.mjs`'s `controllerOf`), and its `fleet` with the `.fleet/` path phase 0 resolves itself through `fleet-dir.mjs`'s `fleetFile(null)`. It refuses with "restart omp" on a missing file, an unreadable one, a mismatch of any of the three, or no omp process above the run: an alarm polling another repository's `.fleet/` never fires for this run. There is no fallback to the hold. Comparing `lstart` makes a leftover file harmless. An omp launched as `bun …/dist/cli.js` carries no `omp` argv, so the ledger records no controller and this step refuses it.

**D9. The stall rule is unchanged.** `fleet-state.mjs`'s `stallsAt` stays. It takes the latest of `beat.at + 2 × beat.interval` and a 2400 s window past each of `ticked`, `acted` and `controller.at`. Because `beat.at` is now set once at idle rather than refreshed every 240 s, a dead controller leaves an older `beat.at` behind and is flagged sooner, never later. With the default back-off the shift shows only at the 1200 s ceiling, where it is at most 960 s, the interval less the old refresh; below the ceiling the window past the tick the idle mark follows ends after the beat's own end, so the verdict does not move. What the change costs is a live controller's margin: the hold re-marked the beat every 240 s for as long as it ran, while an idle controller's beat now ages until the alarm re-marks it, so with the default back-off an alarm turn that starts more than 1200 s after it fell due reads as a stall — one interval at the ceiling, and the window's remainder below it, which is longer. That is accepted and recorded in ADR 0033. The board's only reaction to a stall is not moving tickets.

**D10. Prose.**

- SKILL.md: the "arm the heartbeat and hold" sentence and the section "Nothing to do: arm the beat" become "Nothing to do: mark the beat and end your turn". The rule "never end your turn on a drained queue" is deleted.
- `references/ci-and-staleness.md`, "Beat when there is nothing to do": the Monitor measurement stays as the reason the alarm is an in-process extension rather than a watcher; "You cannot be woken" goes.
- `docs/components/reaping-and-liveness.md`: the hold-and-reissue lines.
- `fleet-heartbeat.mjs`'s header ("WHY A HOLD AND NOT A WATCHER") becomes why an alarm.
- `fleet-event.mjs`'s comment that says the hold stays in `fleet-heartbeat.mjs`.
- Unchanged: `commands/run-merge-bot.md`'s CI-gate wait, which is a member's own wait; the alarm is inert in `kind: "sub"`.
- Shipped files cite no issue, ADR or research path (ADR 0019).

**D11. Tests.**

- Delete the hold, `heldThisCall` and `elapsed` paths in `fleet-heartbeat.test.mjs` and `fleet-state.test.mjs`.
- Keep the `interval`, `--stop` and mark tests and the single-writer pin on `beat`.
- Add tests for `alarmDue`, with each gate condition negated and the due boundary covered, plus a phase 0 refusal test for a missing or mismatched alarm file.
- No end-to-end test boots omp; stage 2 is the end-to-end proof.

**D12. The ADR.** ADR 0033, "The controller ends its turn; an alarm wakes it", records D1–D9 and its consequences. ADR 0008's Status gains `Amended by ADR 0033: on omp an in-process extension alarm wakes an idle controller; decisions 1 and 3 retired.`

## Ticketing

Blocker-first, each ticket carrying a `## Blocked by` list. #3621 is blocked by #3485, which this spec's PR closes, so nothing here is pullable before the spec merges.

| order | ticket | what it lands |
|---|---|---|
| 1 | #3621 | `controller-alarm.mjs`: `alarmDue`, the extension, the alarm file, the `package.json` registration, `readState`'s warning sink |
| 2 | #3622 | phase 0's `alarm` step |
| 3 | #3623 | `fleet-heartbeat.mjs` loses the hold; `elapsed` leaves `fleet-state.mjs`; SKILL.md, references and component prose; tests deleted and retargeted |

The order is the safety property, not a convenience. A controller must never be told to end its turn before an alarm is provably armed in its session: #3621 ships the alarm while the old controller still holds its turn; #3622 then refuses any session without it; only #3623 changes what the controller is told. A held controller is mid-turn for only the first 60 s of a hold, since on omp a longer hold becomes a background job (ADR 0008 decision 3), so the controller can be idle during one. What keeps the gate shut through the hold cycle is that each hold, 240 s at most, re-marks `beat.at` when it ends, so `beat.at + beat.interval`, at least 300 s on, stays ahead at every poll while each hold is re-issued within 60 s of the last one ending. The script and the prose that tells the controller how to call it are one ticket because between two tickets a controller would follow prose its script contradicts.

### The cases this class has

What the change newly does, and what it refuses, enumerated rather than only the named cases:

- **Gate conditions.** Five, each negated in #3621's tests: not idle, `kind: "sub"`, another session's pid, a stopped beat, a beat not yet due. Plus the dedup, which is a sixth way to say "not now".
- **Sessions the extension loads into.** Subagents (`kind: "sub"`): inert, and they write no alarm file. Unrelated omp sessions in the same or another repository: the pid test refuses them; where `.fleet/` cannot be resolved no timer is set and no alarm file is written, so phase 0 refuses such a session. Two omp sessions in one checkout: only the one whose pid the ledger recorded passes.
- **What it can wrongly refuse.** A controller idle at the instant its beat falls due with `stopped: ""` (the empty string, not `null`) must be accepted: #3621 pins that input. A session whose start time cannot be read writes no alarm file, so phase 0 refuses it: the safe direction.
- **What the cutover newly does.** Marking once at idle instead of refreshing every 240 s moves a dead controller's stall verdict earlier, never later, and only at the ceiling with the default back-off; a live controller whose alarm turn is late now reads as stalled once it is late by more than 1200 s with the default back-off (D9). A failed mark write used to read as a fire and beat more often; with no hold it would read as "end your turn" and never beat, so D7 forbids that line. Removing `--hold` makes the flag an unknown-flag refusal for any caller still passing it: the only callers are the SKILL.md text and the tests, both in #3623.
- **What this leaves.** A session that dies still stops the run; the alarm dies with it, as the hold did. Nothing prunes `~/.fleet/alarm/`: a leftover file is harmless because its `lstart` never matches a live process. An alarm turn that arrives while the maintainer is mid-conversation with the controller is not suppressed (D5).

## Out of Scope

- Surviving session death, and the member-side waits in `commands/run-merge-bot.md`.
- Any change to `stallsAt`, the back-off arithmetic, or `fleet-tick.mjs`.
- An end-to-end test that boots omp.

## Open Questions

None open. The wording of the line `fleet-heartbeat.mjs` prints for an unrecorded mark is the implementer's, bounded by D7: it names the failure, says no alarm is armed, and does not contain `end your turn`.
