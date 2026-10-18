# omp: can anything wake an idle run-team controller?

Research for `feigi/fleet-plugin` issue #3183, the seventh item of the
2026-10-13 determinism review (`docs/specs/2026-10-13-runbook-diet-and-incident-policy.md`
§ Series). Measured 2026-10-18 against omp 18.12.1 (`@oh-my-pi/pi-coding-agent`,
bun 1.4.3, darwin arm64). Source citations are `file:line` under that
package's `src/`. Probes ran in throwaway interactive TUI sessions
(haiku-5.5, `--no-extensions -e <probe>`), not in a live `/skill:run-team`
session: that live run is stage 2, a separate maintainer ticket.

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
| 3. Background `task` that sleeps and reports | **Not a retirement path**; measure in stage 2 | it is the hold renamed (§5) |
| (found) `/loop` | **Rejected** | a human must enable it per session (§1) |

The ruling built on this is in the issue's `## Agent Brief — ruling` comment.
Stage 2 (a maintainer's live run) gates the spec. This file records only the
measurements.

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
another form. It cannot retire the rule. Stage 2 measures it once, with the
maintainer confirming the TUI was at the prompt while the task slept, to test
ADR 0008 decision 3's unmeasured claim.

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
  holding the turn. Stage 2 can run on current main.
- The stall rule (`fleet-state.mjs:460-470`) is stale when
  `now > max(beat.at + 2 × beat.interval, ticked/acted/controller.at + 2400 s)`.
  The hold refreshes `beat.at` every 240 s while idle. A mark written once at
  turn end flags a dead controller up to one interval later. The busy-turn case
  is unchanged: the hold never refreshed `beat` during a busy turn either.

## Not measured here

- The live `/skill:run-team` run: a wake leads to a tick, which leads to
  acting on a `PULL` row. The full sequence was not run.
- Auto-compaction triggered during a turn.
- Idle stretches longer than about 2 minutes, in particular one at the 1200 s ceiling.
- RPC and print modes. `ctx.setInterval` is unref'd, so a mode where
  nothing else keeps the event loop alive would not keep the process up.
