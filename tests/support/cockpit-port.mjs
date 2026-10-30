// What the derived-port rows share for telling an outside holder apart from
// a launch that scanned wrong: the skip reason, and a watch over the port
// window while a spawned launch picks its port.
//
// A row cannot hold the derived port open for a launch — the launch has to
// bind it — so whatever else on the machine holds a cockpit-range port can
// come and go between the row deciding where the launch should land and the
// launch binding. Concurrent suites do exactly that. A probe taken before the
// spawn, or one before and one after, misses a holder that arrives after the
// first and leaves before the second; the watch below is up for the whole
// window instead, so a row asserts the landing only when nothing it could see
// was in the launch's way.
//
// Deliberately not a `.test.mjs`, so `node --test` never loads it as a suite.

import { connect } from "node:net";

// The skip reason for a row that could not bind its fixed port itself
// (#2522): the outside process holding it can let go before the launch
// binds, and the launch then takes the port the row needed held.
export function heldOutside(port) {
  return `port ${port} is held by a process outside this test, which can release it before the launch binds`;
}

// Modelled on the launch's pre-bind check (heldFailure in board-server.mjs),
// from outside: a connect to 127.0.0.1 that is refused means nothing holds
// the port; one that connects or hangs means something does. It differs from
// the launch's check in two ways: its timeout is shorter (200 ms, where the
// launch waits 1000 ms), and any other failure counts as held here, where the
// launch treats it as a fault and exits. A connect, never a bind: a bind
// would itself be a holder that pushes the launch off the port.
function answers(port, ms = 200) {
  return new Promise((res) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (held) => { socket.destroy(); res(held); };
    socket.setTimeout(ms, () => done(true));
    socket.once("connect", () => done(true));
    socket.once("error", (e) => done(e.code !== "ECONNREFUSED"));
  });
}

// Watches `ports` — one launch's candidates, in its scan order — from the
// first round, which has finished by the time this resolves, until stop().
// blockerBefore() stops it and takes the port the launch announced: it
// returns the first candidate ahead of the landing when anything answered on
// every candidate ahead of it while the watch was up, or null otherwise — a
// launch that landed past a candidate nobody was seen holding scanned wrong,
// even if an earlier candidate was held, and the row has to fail on it. A
// landing on the first candidate, or outside the window altogether, has no
// candidate ahead of it to excuse it, so it returns null too. The launch's
// own listener answers once it binds; it is at the landing, never ahead of it.
// allHeld() is for a launch that announced nothing: it returns true when
// something answered on every candidate while the watch was up, so the
// launch exhausting its window is the holders' doing and not the scan's.
// A row calls stop() in its `finally` as well, so a row that throws before it
// reads the landing does not leave the watch polling under the rows after it.
export async function watchWindow(ports, everyMs = 5) {
  const seen = new Set();
  const round = async () => {
    const open = ports.filter((p) => !seen.has(p));
    const held = await Promise.all(open.map((p) => answers(p)));
    open.forEach((p, i) => { if (held[i]) seen.add(p); });
  };
  await round();
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      await new Promise((res) => setTimeout(res, everyMs));
      await round();
    }
  })();
  const stop = async () => { stopped = true; await loop; };
  return {
    stop,
    async blockerBefore(landed) {
      await stop();
      const at = ports.indexOf(landed);
      if (at <= 0) return null;
      const ahead = ports.slice(0, at);
      return ahead.every((p) => seen.has(p)) ? ahead[0] : null;
    },
    allHeld() {
      return ports.every((p) => seen.has(p));
    },
  };
}
