// How long the cockpit lives: as long as the controller its run recorded, and
// no longer. The cockpit is spawned detached (phase0.mjs), so nothing ties it
// to the omp session that started it; this is the one thing that ends it
// short of a signal. The decision is a pure function of two values, in the
// board's own split (compute-board.mjs pure, board-gather.mjs impure), so a
// test feeds it verdicts instead of killing processes. boardTick() in
// board.mjs reads the record and the process table and acts on the answer.

import { judgeController, processSource, ProcUnreadable } from "./proc.mjs";

// What the verdict on the Controller record means for the cockpit, this tick.
//
// `verdict` is judgeController()'s answer, or null when there is none to give:
// no record, or a process table that could not be read. Null is not a death
// and not a life — it neither arms the cockpit nor ends it, which is also how
// a heartbeat file that could not be read behaves, since readState() answers
// that with no record.
//
// Any verdict but `dead` is a live controller, and the first one ARMS the
// cockpit. judgeController()'s `none`, its answer for a missing record, never
// arrives here: controllerVerdict() below answers a missing record with null.
// Until the cockpit is armed a `dead` verdict means nothing: a cockpit launched
// by hand between runs finds the last run's record and must not exit on it.
// Once armed, the first `dead` ends it. `armed` is the caller's to carry from
// tick to tick; the record is judged afresh on every one, so a record
// replaced by a new live controller keeps an armed cockpit serving.
//
// A drain is not an input: a controller that has stopped beating is still a
// controller, and judgeController() never reads the beat.
export function cockpitLifetime(armed, verdict) {
  if (verdict === null) return { armed, exit: false };
  if (verdict === "dead") return { armed, exit: armed };
  return { armed: true, exit: false };
}

// judgeController() for the cockpit: the record against the process table as
// it stands now, with no ancestry — it passes an empty chain, so `ancestor`
// never occurs, and every verdict but `dead` reads the same here. Null when
// there is no record or the table cannot be read, `onUnreadable` told why.
// `makeSource` is a parameter for the reason proc.mjs's FLEET_PROC_TABLE
// exists: a test suite run under a live omp session must not judge that one.
// Nothing here signals a process; judgeController() reads, and kill(pid, 0)
// only asks.
export function controllerVerdict(record, makeSource = processSource, onUnreadable = () => {}) {
  if (!record) return null;
  try {
    return judgeController(record, makeSource(), []);
  } catch (e) {
    if (!(e instanceof ProcUnreadable)) throw e;
    onUnreadable(e.message);
    return null;
  }
}
