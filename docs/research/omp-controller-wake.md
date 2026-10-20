# omp: can anything wake an idle run-team controller?

Research for `feigi/fleet-plugin` issue #3183, the seventh item of the
2026-10-13 determinism review (`docs/specs/2026-10-13-runbook-diet-and-incident-policy.md`
§ Series). Measured 2026-10-18 against omp 18.12.1 (`@oh-my-pi/pi-coding-agent`,
bun 1.4.3, darwin arm64). Source citations are `file:line` under that
package's `src/`. Probes ran in throwaway interactive TUI sessions
(haiku-5.5, `--no-extensions -e <probe>`), not in a live `/skill:run-team`
session. That live run is stage 2 (#3484), a separate maintainer ticket,
recorded in §7 under its own versions (omp 18.12.2; 18.12.3 for candidate 3).

## TL;DR

**Nothing outside the omp process can usefully wake an idle controller, but
an extension inside it can.** An omp extension's `ctx.setInterval` timer that
calls `pi.sendUserMessage(...)` starts a real model turn in an idle interactive
session: 5/5 idle fires, fire → `agent_start` in 0–3 ms. The model then ran the
injected command each time. A fresh fire also starts a turn when the editor
holds an unsent draft, which it leaves intact, and after an Esc-aborted turn.
A manual `/compact` racing the fire delays it until compaction ends and loses
nothing.

The one way to lose a wake is to *queue* it: a `deliverAs: "followUp"`
message queued during a turn is dropped, or pasted into the editor, when the
user presses Esc. A design that fires only when `ctx.isIdle()` never queues,
so it never hits that path.

| Candidate (issue order) | Verdict | Evidence |
|---|---|---|
| 1. `hub send` from a detached timer process | **No.** Ruled out by source, not run | in-process only, self-send forbidden (§1) |
| 1b. collab relay guest (found during research) | **Possible, rejected** | needs a global write-capable room, the relay, a hand-written guest (§1) |
| 2. Plugin omp extension with a timer | **Yes** for the mechanism | probes 1–3 (§2–§4) |
| 3. Background `task` that sleeps and reports | **Not a retirement path**; measured once in stage 2 (§7) | it is the hold renamed (§5); whether `ctx.isIdle()` holds while it sleeps is still open (§7) |
| (found) `/loop` | **Rejected** | a human must enable it per session (§1) |

The ruling built on this is in the issue's `## Agent Brief — ruling` comment.
Stage 2, a maintainer's live run (§7), gates the spec. This file records only
the measurements.

## 1. Paths from outside the session

- **`hub send` / `write agent://<name>`** is the IRC bus, which is in-process
  only. `IrcBus.send` → `session.deliverIrcMessage`
  (`irc/bus.ts`, header :1-10, delivery ~74-165) wakes an idle *peer* with a
  real turn (`session/irc-bridge.ts:181-244`, `agent-session.ts:1435-1510`).
  `irc/messaging.ts:44-130` `executeSend` forbids self-send. `agent://` writes
  reach it only from a session's own tools (`internal-urls/agent-protocol.ts:186-194`).
  No socket or IPC listener exists. `hub` itself is only a TUI overlay
  (`modes/components/index.ts`) and a `legacy-compat.ts` case. A detached
  process cannot reach the controller this way.
- **RPC mode** (`modes/rpc/rpc-mode.ts:2-8`, `prompt` frame at :1869) accepts
  external prompts, but only from the process that launched omp in RPC mode.
  It cannot attach to a running interactive session.
- **Collab** is the one real external route. A writable guest's `prompt` frame
  reaches the host session (`collab/host.ts:725-727`) as
  `session.promptCustomMessage(..., {streamingBehavior: "steer"})`
  (`host.ts:993-1003`), which starts a turn when idle
  (`agent-session.ts` ~7830-7960, `#promptWithMessage` ~8150; the final dispatch
  was not read). Costs:
  - Hosting starts only via `/collab` or the global setting
    `collab.autoStart = control` (`modes/interactive-mode.ts:2441`). The setting
    opens a write-capable room on *every* session. There is no CLI flag and no
    extension API to start hosting.
  - Traffic goes through the relay (`collab.relayUrl`, default `wss://my.omp.sh`)
    unless you self-host one.
  - The guest's credential is the room link, fetched with
    `omp collab link <pid>` over a local 0700 socket (`collab/registry.ts`).
  - `omp join` needs a TTY (`commands/join.ts`), so the timer would need a
    hand-written protocol guest.
  Rejected: candidate 2 does the same job with none of these costs.
- **`/loop`** (`modes/interactive-mode.ts:1247-1248`, `#scheduleLoopAutoSubmit`
  :2904-2909) re-submits a prompt 800 ms after each turn ends. It is TUI-only and
  a human enables it per session. Rejected for that reason.
- **No cron or scheduler** exists in `src/`.

## 2. Probe 1: an extension timer wakes an idle session

Extension API surface:
- `ExtensionAPI.sendUserMessage(content, options?)` (`extensibility/extensions/types.ts:1844`)
- `sendMessage(message, {triggerTurn?, deliverAs?})` (:1836-1839)
- `ctx.setInterval` / `setTimeout` (`runner.ts:1481-1483`). These are unref'd and
  error-contained (`managed-timers.ts:28-32`, :66-81) and cleared on teardown
  (`runner.ts:1508`).
- `ctx.isIdle()` (`types.ts` ~675)
- `ctx.agent.kind` (`"main"` for the top level, `runner.ts:498-502`; `"sub"` for
  subagents)

Probe extension (`probe-ext.mjs`):

```js
import { appendFileSync } from "node:fs";
const LOG = process.env.PROBE_LOG || "/tmp/omp-wake-probe/fires.log";
const MODE = process.env.PROBE_MODE || "user";
const MS = Number(process.env.PROBE_MS || 45000);
const MAX = Number(process.env.PROBE_MAX || 4);
const DELIVER = process.env.PROBE_DELIVER || undefined;
const ts = () => new Date().toISOString() + " (" + Math.floor(Date.now() / 1000) + ")";
const log = (m) => appendFileSync(LOG, `${ts()} ${m}\n`);
export default function probe(pi) {
  let armed = false, n = 0;
  for (const ev of ["agent_start", "agent_end", "turn_start", "turn_end", "session_before_compact", "session_compact", "session_shutdown"])
    pi.on(ev, async () => { log(`EVENT ${ev}`); });
  pi.on("session_start", async (_e, ctx) => {
    if (armed) return;
    armed = true;
    ctx.setInterval(() => {
      n++; if (n > MAX) return;
      const idle = ctx.isIdle();
      const text = `WAKE-PROBE #${n}: run \`date +%s\` with bash and reply with the number`;
      let ret, err;
      try {
        if (MODE === "custom") ret = pi.sendMessage({ customType: "wake-probe", content: text, display: true }, { triggerTurn: true, ...(DELIVER ? { deliverAs: DELIVER } : {}) });
        else ret = pi.sendUserMessage(text, DELIVER ? { deliverAs: DELIVER } : undefined);
      } catch (e) { err = String(e); }
      log(`FIRE #${n} isIdle=${idle} hasPending=${ctx.hasPendingMessages()} mode=${MODE} ret=${String(ret)} err=${err}`);
    }, MS);
  });
}
```

Launch (a tmux pty, so the real interactive TUI):

```
tmux new-session -d -s wake1 -x 160 -y 50 -c /tmp/omp-wake-probe \
  "PROBE_MODE=user PROBE_MS=45000 PROBE_MAX=3 omp --model anthropic/claude-haiku-5-5 --thinking off \
   --no-extensions -e /tmp/omp-wake-probe/probe-ext.mjs --session-dir /tmp/omp-wake-probe/sessions \
   --auto-approve --no-title 'say OK and stop'"
```

The variants changed `PROBE_MODE`, `PROBE_DELIVER`, `PROBE_MS`, `PROBE_LOG`,
the session dir and the first prompt. The mid-turn variants used
`run sleep 80 with bash tool (timeout 120), then reply DONE`.

**Idle, `sendUserMessage`, 45 s.** The interval fired at exactly +45.00 s each time:

```
09:54:25.685 session_start; arming setInterval 45000ms
09:54:25.878 agent_start / 09:54:28.709 agent_end   ("say OK and stop" → "OK"; idle)
09:55:10.688 FIRE #1 isIdle=true ret=undefined
09:55:10.690 agent_start (+2 ms)  09:55:11.831 bash `date +%s`  09:55:13.567 agent_end "1792317311"
09:55:55.690 FIRE #2 isIdle=true → agent_start +1 ms → bash → "1792317356"
```

**Idle, `sendMessage({...}, {triggerTurn: true})`, 30 s.** Two fires, turn starts at +0 and +3 ms,
bash ran both times.

**Transcript shape.**
- `sendUserMessage` writes an ordinary user entry:
  `{"type":"message","message":{"role":"user","content":[{"type":"text","text":"WAKE-PROBE #1: …"}],"attribution":"user"}}`.
  This is identical to a typed prompt, so only a text marker tells them apart.
- `sendMessage` writes
  `{"type":"custom_message","customType":"wake-probe",…,"display":true,"attribution":"agent"}`.

**Fire during a turn** (the model running `sleep 80`, `isIdle=false`):

| Call | Result |
|---|---|
| `sendUserMessage` default (steer) | Delivered within 28 ms and the bash ran 2 s later. **The in-flight foreground bash was auto-backgrounded** ("Backgrounded early to handle an incoming message"). Its later completion started another run. |
| `sendUserMessage` + `deliverAs: "followUp"` | Queued until the turn's final stop, 52 s later, then ran. |
| `sendMessage` triggerTurn (default) | Into context immediately. The model finished waiting on the backgrounded job first and ran the command 53 s later. |

**Manual `/compact` racing a fire:**

```
09:56:38.883 EVENT session_before_compact
09:56:40.690 FIRE #3 isIdle=true          ← isIdle() is true during compaction
09:56:41.884 EVENT session_compact
09:56:41.896 agent_start (+1.2 s, after compaction)
09:56:41.921 user "WAKE-PROBE #3 …" recorded after the compaction entry → bash ran
```

`sendUserMessage` → `prompt()` waits for manual-compaction cleanup before it
dispatches (`agent-session.ts` ~9300). Not tested: auto-compaction triggered
during a turn.

## 3. Probe 2: drafts, Esc, and queued wakes

`probe2.mjs` arms a 1 s `ctx.setInterval` that reads a command file. Each line
is `<kind>:<deliver>` (`user`, `custom` or `useragent` (`sendUserMessage` with
`attribution: "agent"`), plus `default` or `followUp`), so every fire runs
inside a timer callback. It logs `isIdle()`,
`ctx.ui.getEditorText()` and the agent/turn/message events. Each row is its
own fresh session (`run.sh <name>`, same flags as probe 1).

| # | Setup | Fire call | Turn starts? | Result |
|---|---|---|---|---|
| 1a–d | idle, unsent draft in editor | all four (user/custom × default/followUp) | yes, 1–2 ms | draft kept intact, not submitted or merged |
| 2a, 2b | idle after an Esc-aborted turn | `sendUserMessage` followUp / default | yes, 3 ms | normal turn, bash ran |
| 3a | idle after Esc | `sendMessage` triggerTurn + followUp | yes, 0 ms | normal turn |
| 3b | idle after Esc | `sendMessage` triggerTurn default | yes, 0 ms | turn started; the model replied "I can't run that…", reading the aborted-bash context |
| 2c | followUp queued **during** the turn, then Esc | `sendUserMessage` followUp | **never** | Esc moved the text into the editor, above the draft; nothing in the transcript |
| 2d | same | `sendMessage` followUp | **never** | silently dropped |
| 2e | same | `sendUserMessage` followUp, `attribution: "agent"` | **never** | silently dropped |

Source:
- Esc → `input-controller.ts:574` → `clearQueue({forInterrupt: true})`
  (`agent-session.ts:9344-9357`). This keeps only advisor cards (9349-9351).
  User-authored entries (`queued-messages.ts:70-71`) go back to the editor
  (`input-controller.ts:1993`); the rest are dropped.
- `abort()` sets `autoResumeSuppressed` (`agent-session.ts:10047`). That gates
  only idle drains of already-queued items (8851) and asides. It does not gate
  a fresh fire:
  - `sendUserMessage` default → `prompt()` clears the latch (7618).
  - The followUp path clears it while queuing (8728) and drains at once
    (8795).
  - Idle `sendMessage` + `triggerTurn` calls `agent.prompt` directly and
    ignores `deliverAs` (9231-9237).
- `types.ts`'s note that an explicit `deliverAs` "queues without starting a
  turn" (9269-9271) does not hold for an idle `sendUserMessage` followUp: the
  idle drain starts the turn in 2–3 ms.

Not observed: an Esc landing inside the sub-second window between a fire and
`agent_start`, more than one fire after an Esc, and abort routes other than a
single TUI Esc.

## 4. Probe 3: the extension's pid is the ledger's controller pid

`ledger.mjs rotate` records the controller as the nearest ancestor whose argv[0]
or argv[1] has basename `omp` (`plugin/scripts/proc.mjs:180`, `controllerOf`
:185-190, called from `ledger.mjs:1540-1543`). The probe extension logged
`process.pid` on `session_start`. A bash tool call in the same session ran
`processSource()`, `ancestry()` and `controllerOf()` from the unmodified
`proc.mjs`:

```
extension: pid=32180 ppid=32122 title="omp" argv0="bun" kind="main"
ledger:    LEDGER_CONTROLLER_PID=32180
  32101     1 tmux -L omp-probe new-session …
  32122 32101 zsh -c omp --no-extensions -e …/ext.mjs …
  32180 32122 bun /Users/chris/.bun/bin/omp --no-extensions -e …/ext.mjs …
```

The two are equal, so `controller.pid === process.pid` identifies the
controller session from inside an extension. Not covered:
- An omp launched from a bash tool inside another omp. Its own calls would
  record the inner pid.
- An omp launched as `bun …/dist/cli.js`, where no argv carries `omp`. The
  ledger then records no controller at all.

## 5. Candidate 3: a sleeping background `task`

A `task` member's final report auto-delivers to the main session
(`docs/research/omp-review-offturn.md`), and background-job completions enter a
run as asides at step boundaries (`agent-session.ts:2133-2136`).
`#hasPendingAsyncWake` (:3156-3181) keeps `agent_end` from settling while such
work is pending (:4797-4800). So a sleeping task may keep the session from
ever becoming idle, and its report would then be ADR 0008 decision 3's
in-turn mechanism rather than an idle wake. Either way, the controller must
start a new sleeper before every turn ends, which is "never end your turn" in
another form. It cannot retire the rule. Stage 2 measured it once (§7), with
the maintainer at the TUI while the task slept, to test ADR 0008 decision 3's
unmeasured claim.

## 6. What the heartbeat state allows

- `.fleet/heartbeat.json` (`fleet-dir.mjs` `fleetFile`, per repo via
  `git rev-parse --git-common-dir`) holds:
  - `controller {pid, lstart, prior, at}` (written by `ledger.mjs rotate`)
  - `quiet` (only writer: `fleet-tick.mjs:2148-2149`)
  - `beat {at, interval, stopped}` (only writer: `fleet-heartbeat.mjs`, pinned
    in `fleet-state.test.mjs`)
  - `elapsed`, read only by `fleet-heartbeat.mjs` itself
- `fleet-heartbeat.mjs` writes `beat: mark(target, "")` on **every** call, in
  the same write as `elapsed` (:248). So `--hold 1`, the minimum
  (`int("hold", 1)`), already leaves the mark an alarm would read without
  holding the turn. Stage 2 therefore needed no plugin change.
- The stall rule (`fleet-state.mjs:460-470`) is stale when
  `now > max(beat.at + 2 × beat.interval, ticked/acted/controller.at + 2400 s)`.
  The hold refreshes `beat.at` every 240 s while idle. A mark written once at
  turn end flags a dead controller up to one interval later. The busy-turn case
  is unchanged: the hold never refreshed `beat` during a busy turn either.

## 7. Stage 2: the live run

Measured 2026-10-19 to 2026-10-20 in one real `/skill:run-team` session on this
repository (#3484), with the throwaway alarm from that ticket loaded through
`-e`. The session ran about 18 hours of wall clock and merged 18 PRs of its own
plus one folded in by hand. The alarm logged every poll decision to
`/tmp/fleet-alarm/alarm.log`. That file no longer exists. Each log count below is
one the controller printed from it during the session (the totals at
2026-10-20T08:53:35Z, the stop lines at 09:23:25Z), and the printed result is an
entry in the controller's transcript. The transcript supplies the rest.

Sources:

- **The controller transcript**,
  `2026-10-19T15-04-42-871Z_01a154b1-8677-70f5-aac4-f0220c978651.jsonl` (session
  `01a154b1-8677-70f5-aac4-f0220c978651`). Its entries carry millisecond
  timestamps: the `[fleet-alarm]` user entries, tool calls and tool results.
- **The member transcripts**: the 526 `.jsonl` files in the directory of the same
  name, one per member session.
- **`pmset -g log`**, for power events.
- **Versions.** The alarm run used omp 18.12.2: `runtime.version` is 18.12.2 on
  every controller-transcript entry from 2026-10-19T15:04:42Z to
  2026-10-20T09:33:50Z. The first 18.12.3 entry is at 09:34:07Z, after a
  `session_exit` ("dispose") entry at 09:33:50Z, so candidate 3 (09:41Z) ran under
  18.12.3. The main checkout was at `8a8bbf22` from 2026-10-19T13:57:15Z (its
  reflog) until its HEAD next moved at 2026-10-20T10:54:42Z, after the run; the
  alarm's default helper path is `<cwd>/plugin/scripts`. The version of the
  installed `@feigi/fleet-ctl` plugin is **not known**: the transcript records no
  plugin version, and the install under `~/.omp/plugins/node_modules` was rewritten
  at 2026-10-20T11:17Z, so its present contents say nothing about the run.

| Check | Result |
|---|---|
| Armed | one `armed pid=37611` line at session start; the `.fleet/heartbeat.json` `controller.pid` written by phase 0 equals it |
| Pid gate | one `not controller (controller.pid=<old>)` skip, before phase 0 wrote the pid; none after |
| Sub-agent sessions | 457 `inert: kind=sub` lines: the extension loads in every member's session and stays inert there |
| (a) a turn is injected | 94 `FIRE` lines. The controller transcript holds 94 `[fleet-alarm]` user entries, the first at 18:08:18Z and the last at 2026-10-20T08:47:51Z. For each of the seven fires whose log line survives, the entry's `message.timestamp` equals the `FIRE` time to within 1 ms. Excerpts: "A fire, in the log and the transcript" |
| (b) the turn runs the tick | all 94 alarm turns ran `fleet-event.mjs heartbeat` in a `bash` call; the first started at 18:08:21.037Z and returned at 18:08:28.695Z. The model then acted on its rows, as (c) shows |
| (c) the tick leads to acting | alarm turns printed `PULL` rows and the controller pulled and dispatched from them. `PULL #3576` printed at 20:21:38Z, then `pull.mjs next --head 3576` and a `task` dispatch of `impl-3576` at 20:22:09Z. `PULL #3580` printed at 21:41:11Z (`impl-3580` dispatched at 21:42:14Z) and `PULL #3581` at 22:29:11Z (`impl-3581` at 22:29:53Z). Each `PULL` row is a `bash` tool result inside an alarm turn |
| Interval ceiling | fires at 300 s: 75, at 600 s: 12, at 1200 s: 7 |
| Auto-compaction | 44 `session_compact` events in the log, none typed by the maintainer. None was the controller's: its transcript has 0 `"type":"compaction"` entries, and the member transcripts have 44 (see "Whose compactions"). For the controller the case is **not observed**. A fire followed every one of the 44: the last compaction entry is at 2026-10-20T08:06:08Z, the last fire at 08:47:51Z |
| Once per interval for a `beat.at` | 9 `already fired for this beat` skips. The guard holds a repeat fire for one interval, not for good: a `beat.at` the controller never re-marks fires again every interval, as #3485's ruling 2 specifies. Each skip is a poll after an alarm turn that ended without re-marking the beat. This count does not show whether any `beat.at` fired twice |
| Lateness (`late=`) | median 14 s, 90th percentile 221 s, 10 fires over 120 s, maximum 8419 s |
| Fire to tick | over all 94 alarm turns, from the fire (the user entry's `message.timestamp`) to the `fleet-event.mjs heartbeat` `bash` call: starts after min 2.7 s, median 4.4 s, 90th percentile 6.8 s, max 20.3 s; returns after min 8.2 s, median 16.3 s, 90th percentile 21.9 s, max 29.6 s (90th percentile by nearest rank). The `[fleet-alarm]` entry is written 0.48 to 3.56 s after the fire, median 0.61 s |
| `--hold 240` relapse | none: three default-hold heartbeat calls, all before the first alarm turn; every call after it used `--hold 1`. The standing instruction was never typed. See "The `--hold 240` relapse check" |

Poll decisions besides the fires and the `stopped` skips: 1260 `not due`,
773 `busy`, 9 `already fired`, 1 `not controller`.

**Which session wrote a line.** The alarm registers its `EVENT` handlers
before its `kind` check and logs them with no pid. omp emits `agent_start`,
`session_compact` and `session_shutdown` to each session's own extensions,
sub-agent sessions included (`agent-session.ts`, `session-maintenance.ts`,
read at 18.12.3). So every sub-agent session counted above writes `EVENT`
lines in the same form as the controller. Only `armed`, `poll:` and `FIRE`
lines come from the main session alone. An `EVENT agent_start` after a `FIRE` is
the injected turn by timing. In the two pairs that survive it precedes the
controller's entry write by 4 ms (18:08:18.853Z against 18:08:18.857Z) and by
28 ms (18:18:51.464Z against 18:18:51.492Z); the other 92 `EVENT agent_start` lines
after fires are not recoverable. The `session_compact` count took in every member
session's compaction; the transcripts attribute all 44 to members (see "Whose
compactions").

### A fire, in the log and the transcript

One fire per interval, with the log lines that survive and the controller
transcript's entries. The surviving log lines are the ones the controller printed
into tool results; it grepped the 600 s and 1200 s fires for `FIRE` only, so no
`EVENT` line survives for them. The `[fleet-alarm]` text is shortened. The fire
time is the user entry's `message.timestamp`; "written" is the entry's own
`timestamp`. All on 2026-10-19, UTC.

```
300 s, the first fire of the run
alarm.log   2026-10-19T18:08:18.151Z FIRE beat.at=2026-10-19T15:42:59.077Z interval=300s late=8419s
alarm.log   2026-10-19T18:08:18.853Z EVENT agent_start
transcript  user  "[fleet-alarm] run … fleet-event.mjs heartbeat …"  fire 18:08:18.151Z, written 18:08:18.857Z
transcript  bash  fleet-event.mjs heartbeat  started 18:08:21.037Z (+2.9 s), result 18:08:28.695Z (+10.5 s)

300 s
alarm.log   2026-10-19T18:18:48.172Z FIRE beat.at=2026-10-19T18:13:44.988Z interval=300s late=3s
alarm.log   2026-10-19T18:18:51.464Z EVENT agent_start
transcript  user  "[fleet-alarm] run … fleet-event.mjs heartbeat …"  fire 18:18:48.173Z, written 18:18:51.492Z
transcript  bash  fleet-event.mjs heartbeat  started 18:18:54.737Z (+6.6 s), result 18:19:09.215Z (+21.0 s)

600 s
alarm.log   2026-10-19T18:40:18.234Z FIRE beat.at=2026-10-19T18:30:04.288Z interval=600s late=14s
transcript  user  "[fleet-alarm] run … fleet-event.mjs heartbeat …"  fire 18:40:18.234Z, written 18:40:19.237Z
transcript  bash  fleet-event.mjs heartbeat  started 18:40:21.793Z (+3.6 s), result 18:40:30.009Z (+11.8 s)

1200 s
alarm.log   2026-10-19T19:25:48.424Z FIRE beat.at=2026-10-19T19:02:07.226Z interval=1200s late=221s
transcript  user  "[fleet-alarm] run … fleet-event.mjs heartbeat …"  fire 19:25:48.425Z, written 19:25:49.054Z
transcript  bash  fleet-event.mjs heartbeat  started 19:25:51.414Z (+3.0 s), result 19:25:59.710Z (+11.3 s)
```

The fire does not start the turn within milliseconds in this run. Across all 94
alarm turns the entry is written 0.48 to 3.56 s after the fire (median 0.61 s),
and in the two surviving pairs `agent_start` followed the fire by 0.70 s and
3.29 s. §2's 0–3 ms was measured in an idle throwaway probe session, a different
measurement. The Checks table's "Fire to tick" row gives the delay to the tick.

### Whose compactions

The controller transcript has 0 `"type":"compaction"` entries. The member
transcripts hold 44, in nine files: `impl-3541` (10), `impl-3542` (10),
`impl-3541-b` (9), `impl-3541-c` (8), `impl-3554` (2), `impl-3581-b` (2) and
`merge-bot-1`, `merge-bot-7`, `merge-bot-13` (1 each). That equals the log's 44
`session_compact` events. The first eight `session_compact` lines the controller
printed at 07:25Z (15:44:50.065Z to 18:42:54.099Z) match the member entries'
timestamps (15:44:50.064Z to 18:42:54.098Z) to within 5 ms. None of the 44 was the
controller's.

### What the lateness says

The long tail comes from the controller being busy, and has these causes:

- **A busy controller is never alarmed.** The gate checks `ctx.isIdle()` first.
  A controller blocked inside one tool call stays busy, so the log shows
  `poll: skip busy` for minutes on end and the fire lands only when the turn
  ends. The transcript shows two kinds of in-turn block, not one. It has 29 tool
  calls over 240 s: 11 `wait` calls on background jobs (two ran the full 1800 s,
  starting 15:11:55Z and 17:26:51Z), 17 `eval` loops waiting on PR checks (each
  checks the PR, then `time.sleep(30)`, for 36 to 50 rounds, titled for example
  "Wait for check on 3560/3561"), and one 245 s `bash` call (09:30:02Z, a test
  run). A controller that hands its turn back, as the design ruled for spec 7
  (#3485) has it do, does not have the problem; one that blocks in `wait` or in a
  CI-poll loop still does.
- **Alarm turns that start work.** A turn that dispatches a member and then waits
  on its result is busy for the member's whole run, so the next due fire waits
  with it.
- **The 8419 s fire was the first fire, and the controller's first turn.** The
  controller transcript has no assistant message that ended a turn (a
  `stopReason` other than `toolUse`) between session start (15:04:42Z) and
  18:08:10Z. The maintainer's two messages in between (15:05:45Z and 18:06:23Z)
  arrived mid-turn. That turn ran 11007 s (3 h 3 min) in 105 tool calls: 62 `bash`,
  20 `wait`, 16 `task`, 6 `eval` and 1 `read`. The `wait` calls held 9717 s of it,
  and one `eval` loop of 484 s (17:14:30Z) polled PR checks. The gate could not
  pass until the turn ended at 18:08:10Z. The fire came at 18:08:18Z with
  `beat.at=15:42:59.077Z interval=300s`, so it was 8419 s past `beat.at + 300 s`.
- **The laptop did not sleep during the run.** `pmset -g log` records its last
  `Sleep` and `Wake` events at 2026-10-19 10:57:48 and 10:58:01 CEST, six hours
  before the run began (17:04 CEST), and none after, through 2026-10-20 14:26 CEST,
  where the log ends. No gap between consecutive controller-transcript entries
  exceeds 1800 s, and both 1800 s `wait` timeouts ran 1800.0 s.

In the ordinary idle case the fire landed within a poll or two of `beat.at +
beat.interval`: the median is 14 s against a 30 s poll.

### The `--hold 240` relapse check (#3484 step 3)

Step 3 asked for a standing instruction to use `--hold 1` in place of SKILL.md's
240 s hold, and the run to show whether the controller relapsed to the 240 s hold.
From the controller transcript:

- **Default-hold calls: 3.** `fleet-heartbeat.mjs` without `--hold` holds up to
  240 s. It ran at 15:07:47Z (returned at once, `held 0s`), 15:07:54Z and 15:41:58Z
  (both moved to the background at 60 s). All three precede the first
  `[fleet-alarm]` turn at 18:08:18Z, inside the first-turn stretch above. They were
  not what held that turn: the 15:41:58Z call returned to the model at 15:42:58Z,
  2 h 25 min before the turn ended.
- **After the first alarm turn, every heartbeat call used `--hold 1`.** There are
  123 such `bash` calls (first 18:08:31Z, last 08:48:12Z), and no `--hold` value
  other than 1 appears in any `bash` call of the session. No busy stretch after
  18:08:18Z followed a 240 s hold.
- **The standing instruction was never typed.** The maintainer typed 21 messages,
  and none is the step-3 instruction. The first, at 15:05:45Z, was `fyi, alarm.mjs
  is armed (issue://3484)`. The controller got `--hold 1` from the alarm's own
  line, which carries it (`… run ~/.fleet/bin/fleet-run fleet-heartbeat.mjs --hold 1
  and end your turn …`); the first `--hold 1` call came 14 s after the first fire.

### The stop (#3484 step 8)

At the end of the run `fleet-heartbeat.mjs --stop "<reason>"` set `beat.stopped`
in `.fleet/heartbeat.json`. The alarm's gate evaluates `ctx.isIdle()` before it
reads `beat.stopped`, so every poll that landed during the controller's own
closing turn logged `poll: skip busy`, and the stop could only show on a poll
that found the controller idle. The first such poll logged:

```
2026-10-20T09:00:51.505Z poll: skip stopped: run drained; closeout finish blocked at tier-outcomes by #3611 (reviewed PR #3606 closes no issue)
```

The log held 44 such lines when the controller counted them at 09:23:25 (an
`eval` whose result is in the controller transcript): one per poll from 09:00:51 to
about 09:22:21, while the controller sat idle. The controller transcript has no
entry between 09:00:38Z and the maintainer's message at 09:22:50. That message
started a turn, and polls after it logged `skip busy`. The line the maintainer had
quoted, 09:20:51, was the 41st. The last `FIRE` of the run (08:47:51) precedes the
stop, and the same `eval` found no `FIRE` after the first `skip stopped` line, so
the stop silenced the alarm: no fire followed it. The controller could not observe
the line from inside its own turn; it had only confirmed the gate's decision
expression offline against the real state file, and the maintainer read the log.

### Notes for the design

- The `quiet` back-off reached the 1200 s ceiling and stayed there while the
  fleet had only long members running; every member report reset it to the base.
  The ceiling therefore bounds idle latency only for a fleet that is truly quiet.
- An alarm turn and a member-report turn are the same kind of turn to the
  controller; the log records only the alarm side of the interleaving, so this
  run does not measure interference between the two.

### Candidate 3, measured once (#3484 step 7)

After the run drained, with `beat.stopped` set so the alarm was silent, and with
nothing else running, the controller dispatched one background `task` member
that slept 300 s and reported, and ended its turn. In that process the alarm
extension was not loaded, so no alarm poll could interfere.

| Event | Time (UTC, 2026-10-20) |
|---|---|
| controller dispatches the task and ends its turn | 09:41:52 |
| member starts its sleep | 09:42:03 |
| member writes its end timestamp (5 min 04 s of sleep) | 09:47:07 |
| first command of the controller's new turn | 09:47:13 |

- The report started a new turn about 6 s after the member finished, with no
  other work pending.
- The maintainer, at the TUI during the sleep, could type: the session accepted
  input while the task was pending.

What this does not show: whether `ctx.isIdle()` was true during the sleep. The
alarm gate tests `isIdle()`, and the alarm was not loaded, so nothing polled it.
"The TUI accepted typing" and "`isIdle()` is true" are different claims, and
section 5's reading of `#hasPendingAsyncWake` (a pending sleeper may keep the
session from settling) is neither confirmed nor refuted here. The conclusion of
section 5 is unchanged: the controller must start a new sleeper before every
turn ends, so this is "never end your turn" in another form and cannot retire
the rule.

### Against the ticket's Outcomes

| #3484 check | This run |
|---|---|
| Pid check | passes: the `armed` pid equals `controller.pid` (the Armed row) |
| (a), (b), (c) | as their rows above record; (a)'s `EVENT agent_start` is the controller's by timing: 4 ms and 28 ms before its entry write in the two surviving pairs |
| Ceiling stretch | reached: fires at 1200 s (the Interval ceiling row) |
| Auto-compaction | not observed for the controller: its transcript has 0 compaction entries; all 44 `session_compact` events were member sessions' (see "Whose compactions") |

#3484's Outcomes count auto-compaction not observed alongside the passes.
Whether these results unblock #3485 or amend ADR 0008 is the maintainer's
call on #3484.

## Not measured here

- The log also shows an `EVENT session_shutdown` while the controller was
  closing out. This run did not establish what caused it or whether the timer
  survives one. A sub-agent session's disposal writes the same line (see
  "Which session wrote a line" above), so it is one candidate cause.
- Whether `ctx.isIdle()` is true while a background `task` is pending (see the
  candidate 3 measurement above).
- RPC and print modes. `ctx.setInterval` is unref'd, so a mode where
  nothing else keeps the event loop alive would not keep the process up.
- A compaction of the controller's own session. None occurred (see "Whose
  compactions"), so whether the alarm fires after one was not exercised.
- Log lines the controller did not print into the transcript. The log file is gone,
  so any figure here that is not a printed result or a transcript entry cannot be
  rechecked.
- The installed `@feigi/fleet-ctl` plugin's version during the run (see
  "Sources").
