// suite-slot.mjs: the host-wide bound on concurrent FULL test-suite runs.
//
// Every case runs the real script against a host of its own — a fresh HOME
// from `slotHome()` — because the slots live under the running user's
// `~/.fleet/suite-slots/` and a live fleet run on this machine is using it. No
// case may take, wait on or remove a lock there; see tests/support/suite-slot-home.mjs.
//
// A holder this process stands in for is a lock file naming this process's own
// pid, alive for as long as the test is. Where the claim is about the wrapper
// itself holding a slot — released on exit, killed mid-run, signalled — a real
// wrapper is spawned.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./support/temp-dir.mjs";
import { slotHome, holdSlots, deadPid, SUITE_SLOT } from "./support/suite-slot-home.mjs";

// The wrapper, run to completion. The timeout is a backstop: a wrapper that
// hangs reads as a failed assertion on its signal, not as a hung suite.
function run(host, entrypoint, args = [], env = {}) {
  return spawnSync(process.execPath, [SUITE_SLOT, entrypoint, ...args], {
    encoding: "utf8",
    env: host.env(env),
    timeout: 30_000,
  });
}

// The wrapper left running: `done` settles when it exits, with what it
// printed. `stdout()` is what has arrived so far.
function launch(host, entrypoint, args = [], env = {}) {
  const child = spawn(process.execPath, [SUITE_SLOT, entrypoint, ...args], { env: host.env(env), stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const done = new Promise((resolve) => child.on("close", (status, signal) => resolve({ status, signal, stdout: out, stderr: err })));
  return { child, done, stdout: () => out };
}

const until = async (fn, what, ms = 10_000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

const waitMs = (stderr) => Number(/^SUITE_SLOT_WAIT_MS=(\d+)$/m.exec(stderr)?.[1]);

test("a full run takes one slot stamped with the wrapper's pid, prints its wait, and releases it", () => {
  const host = slotHome();
  const r = run(host, 'cat "$FLEET_SUITE_SLOT"; echo; ls "$(dirname "$FLEET_SUITE_SLOT")"');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const [stamp, ...listing] = r.stdout.trim().split("\n");
  assert.equal(stamp, String(r.pid), "the slot does not name the wrapper that holds it");
  assert.deepEqual(listing, ["1.lock"]);
  // A free slot is taken on the first pass, well inside one 2 s cycle.
  assert.ok(waitMs(r.stderr) < 1000, `a free slot reports a wait of almost nothing: ${r.stderr}`);
  assert.deepEqual(readdirSync(host.slots), [], "the slot outlived the run");
});

test("a narrowed run takes no slot and does not wait behind a full house", () => {
  const host = slotHome();
  holdSlots(host, 2);
  // Ends in `:` — the wrapper appends "$@" to the whole entrypoint, so what
  // follows the last command is that command's own arguments, here a no-op's.
  const r = run(host, 'echo "[${FLEET_SUITE_SLOT-unset}] $#"; :', ["a b"], { FLEET_SUITE_WAIT_S: "1" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout, "[unset] 1\n");
  assert.doesNotMatch(r.stderr, /SUITE_SLOT_WAIT_MS/);
  assert.equal(readFileSync(host.lock(1), "utf8"), String(process.pid), "a narrowed run touched a held slot");
});

test("a wrapper inside a held slot takes no second slot", () => {
  const host = slotHome();
  const inner = `"${process.execPath}" "${SUITE_SLOT}" 'echo inner-ran; ls "$(dirname "$FLEET_SUITE_SLOT")"'`;
  const r = run(host, inner, [], { FLEET_SUITE_SLOTS: "1", FLEET_SUITE_WAIT_S: "1" });
  assert.equal(r.status, 0, "the nested wrapper waited on the slot its own parent holds: " + r.stdout + r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n"), ["inner-ran", "1.lock"]);
  assert.equal(r.stderr.match(/SUITE_SLOT_WAIT_MS/g).length, 1, "the nested wrapper took a slot of its own");
});

test("a nested wrapper's own arguments still reach its command", () => {
  const host = slotHome();
  const r = run(host, 'echo "$#:$1"; :', ["a b"], { FLEET_SUITE_SLOT: "/held/by/an/outer/wrapper" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout, "1:a b\n");
});

test("two full runs at the default bound both run at once", async () => {
  const host = slotHome();
  const dir = tempDir("slot-barrier-");
  // Each run announces itself and then waits for the other's mark: both exit 0
  // only if both were running at the same time, and 3 if the other never came.
  const entry = 'touch "$D/$A"; i=0; while [ ! -e "$D/$B" ]; do i=$((i+1)); [ $i -gt 100 ] && exit 3; sleep 0.1; done; :';
  const one = launch(host, entry, [], { D: dir, A: "a", B: "b" });
  const two = launch(host, entry, [], { D: dir, A: "b", B: "a" });
  const [x, y] = await Promise.all([one.done, two.done]);
  assert.equal(x.status, 0, x.stderr);
  assert.equal(y.status, 0, y.stderr);
});

test("a third full run waits for a slot and takes it when one is freed", async () => {
  const host = slotHome();
  const mark = join(tempDir("slot-third-"), "ran");
  holdSlots(host, 2);
  const third = launch(host, 'touch "$MARK"; echo RAN', [], { FLEET_SUITE_WAIT_S: "30", MARK: mark });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(existsSync(mark), false, "the third run started with both slots held");
  rmSync(host.lock(2));
  const r = await third.done;
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "RAN\n");
  assert.ok(waitMs(r.stderr) >= 400, `the wait it reports does not cover the time it spent waiting: ${r.stderr}`);
});

test("a wait that outlasts the cap exits 75 naming the wait, having launched nothing", () => {
  const host = slotHome();
  const mark = join(tempDir("slot-cap-"), "ran");
  holdSlots(host, 2);
  const t0 = Date.now();
  const r = run(host, 'touch "$MARK"', [], { FLEET_SUITE_WAIT_S: "1", MARK: mark });
  assert.equal(r.status, 75, r.stdout + r.stderr);
  assert.match(r.stderr, /^suite-slot: no slot after 1s$/m);
  assert.ok(Date.now() - t0 >= 900, "gave up before the cap");
  assert.equal(existsSync(mark), false, "the entrypoint ran without a slot");
  assert.doesNotMatch(r.stderr, /by hand/, "a live holder is named as a wedge to remove");
});

test("FLEET_SUITE_SLOTS sets how many full runs fit", () => {
  const host = slotHome();
  holdSlots(host, 1);
  const tight = run(host, "echo RAN", [], { FLEET_SUITE_SLOTS: "1", FLEET_SUITE_WAIT_S: "1" });
  assert.equal(tight.status, 75, "one slot, held: the run did not wait");
  const roomy = run(host, "echo RAN", [], { FLEET_SUITE_SLOTS: "2", FLEET_SUITE_WAIT_S: "1" });
  assert.equal(roomy.status, 0, roomy.stdout + roomy.stderr);
  assert.equal(roomy.stdout, "RAN\n");
});

test("a malformed bound is refused, not read as a number or a default", () => {
  for (const [name, value] of [["FLEET_SUITE_WAIT_S", "30s"], ["FLEET_SUITE_WAIT_S", ""], ["FLEET_SUITE_SLOTS", "0"], ["FLEET_SUITE_SLOTS", "two"]]) {
    const host = slotHome();
    const mark = join(tempDir("slot-bad-"), "ran");
    const r = run(host, 'touch "$MARK"', [], { [name]: value, MARK: mark });
    assert.equal(r.status, 2, `${name}=${JSON.stringify(value)}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, new RegExp(`${name} must be an integer`));
    assert.equal(existsSync(mark), false, `${name}=${JSON.stringify(value)} still launched the entrypoint`);
  }
});

test("a slot whose holder is dead is taken over by the next full run", () => {
  const host = slotHome();
  mkdirSync(host.slots, { recursive: true });
  writeFileSync(host.lock(1), String(deadPid()));
  const r = run(host, 'cat "$FLEET_SUITE_SLOT"', [], { FLEET_SUITE_SLOTS: "1", FLEET_SUITE_WAIT_S: "1" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout, String(r.pid));
  assert.equal(existsSync(`${host.lock(1)}.reap`), false, "the takeover left its reap lock behind");
});

test("a holder killed mid-run is reaped by the next waiter", async () => {
  const host = slotHome();
  const dir = tempDir("slot-kill-");
  const held = launch(host, 'echo $$ > "$D/child"; exec sleep 60 >/dev/null 2>&1', [], { FLEET_SUITE_SLOTS: "1", D: dir });
  // Both files are created before they are written, so a reader that finds the
  // file may find it empty: wait for the content, not the file.
  const text = (path) => (existsSync(path) ? readFileSync(path, "utf8") : "");
  const childPid = () => (/^(\d+)\n$/.exec(text(join(dir, "child")))?.[1]);
  try {
    await until(() => childPid() !== undefined && text(host.lock(1)) === String(held.child.pid), "the holder to take its slot");
    held.child.kill("SIGKILL");
    await held.done;
    assert.ok(existsSync(host.lock(1)), "a SIGKILLed wrapper cannot have released its slot");
    const r = run(host, "echo RAN", [], { FLEET_SUITE_SLOTS: "1", FLEET_SUITE_WAIT_S: "5" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stdout, "RAN\n");
  } finally {
    // The wrapper's child outlives it; it is this test's to end. Never a pid
    // that is not a whole positive number: kill(0) is this process's own group.
    const pid = Number(childPid());
    if (pid > 1) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
});

test("a slot nothing can take over is named, and never taken", () => {
  const cap = { FLEET_SUITE_SLOTS: "1", FLEET_SUITE_WAIT_S: "1" };
  // An empty lock: its writer died between creating it and writing its pid.
  const empty = slotHome();
  mkdirSync(empty.slots, { recursive: true });
  writeFileSync(empty.lock(1), "");
  const a = run(empty, "echo RAN", [], cap);
  assert.equal(a.status, 75, a.stdout + a.stderr);
  assert.ok(a.stderr.includes(`${empty.lock(1)} holds "", not a pid, so it is never taken over`), a.stderr);
  // A dead holder whose takeover another waiter holds the reap lock for: the
  // reap lock is what keeps two waiters from each deleting the other's fresh
  // lock, so a waiter that finds it held must wait, however dead the holder.
  const reaping = slotHome();
  mkdirSync(reaping.slots, { recursive: true });
  const dead = deadPid();
  writeFileSync(reaping.lock(1), String(dead));
  writeFileSync(`${reaping.lock(1)}.reap`, "");
  const b = run(reaping, "echo RAN", [], cap);
  assert.equal(b.status, 75, b.stdout + b.stderr);
  assert.ok(b.stderr.includes(`${reaping.lock(1)} is held by dead pid ${dead}; ${reaping.lock(1)}.reap is blocking its takeover`), b.stderr);
  assert.equal(readFileSync(reaping.lock(1), "utf8"), String(dead), "the slot was taken while another waiter held its reap lock");
});

test("a command's exit status is the wrapper's, and a command killed by a signal is never a pass", () => {
  const host = slotHome();
  assert.equal(run(host, "exit 3").status, 3);
  const killed = run(host, "kill -9 $$");
  assert.equal(killed.status, 137, `a suite killed by SIGKILL read as ${killed.status}: ${killed.stderr}`);
  const killedNarrow = run(host, "kill -9 $$", ["x"]);
  assert.equal(killedNarrow.status, 137);
});

test("arguments reach the command as the words they were, never re-split or run by a shell", () => {
  const host = slotHome();
  const mark = join(tempDir("slot-argv-"), "pwned");
  const r = run(host, "printf '<%s>'", ["a b", `$(touch ${mark})`, "*", "it's", "[x]"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `<a b><$(touch ${mark})><*><it's><[x]>`);
  assert.equal(existsSync(mark), false, "a shell metacharacter in an argument was executed");
});

test("a compound entrypoint keeps its meaning, with the arguments after it", () => {
  const host = slotHome();
  const r = run(host, 'echo first && printf "<%s>" "$1"', ["x", "y"]);
  assert.equal(r.status, 0, r.stderr);
  // The arguments are appended after the whole compound command, so they are
  // the last command's own: `printf "<%s>" "$1" "$@"`.
  assert.equal(r.stdout, "first\n<x><x><y>");
});

test("SIGTERM reaches the running command, ends the wrapper as 143 and frees the slot", async () => {
  const host = slotHome();
  const held = launch(host, "echo up; exec sleep 60", [], { FLEET_SUITE_SLOTS: "1" });
  try {
    await until(() => held.stdout().includes("up"), "the command to start");
    held.child.kill("SIGTERM");
    const r = await Promise.race([held.done, new Promise((res) => setTimeout(() => res("hung"), 10_000))]);
    assert.notEqual(r, "hung", "the wrapper ignored SIGTERM while its command ran");
    assert.equal(r.status, 143, r.stderr);
    assert.deepEqual(readdirSync(host.slots), []);
  } finally {
    held.child.kill("SIGKILL");
  }
});

test("SIGTERM to a waiting wrapper ends it at once, launching nothing", async () => {
  const host = slotHome();
  const mark = join(tempDir("slot-term-wait-"), "ran");
  holdSlots(host, 2);
  const waiting = launch(host, 'touch "$MARK"', [], { FLEET_SUITE_WAIT_S: "30", MARK: mark });
  try {
    await new Promise((r) => setTimeout(r, 400));
    waiting.child.kill("SIGTERM");
    const r = await Promise.race([waiting.done, new Promise((res) => setTimeout(() => res("hung"), 10_000))]);
    assert.notEqual(r, "hung", "a waiting wrapper outlived SIGTERM");
    assert.equal(r.status, 143);
    assert.equal(existsSync(mark), false);
    assert.equal(readFileSync(host.lock(1), "utf8"), String(process.pid), "a waiter touched a slot it never held");
  } finally {
    waiting.child.kill("SIGKILL");
  }
});

test("an entrypoint that is a flag, or none at all, is refused", () => {
  const host = slotHome();
  for (const args of [["--bogus"], [""], []]) {
    const r = spawnSync(process.execPath, [SUITE_SLOT, ...args], { encoding: "utf8", env: host.env(), timeout: 30_000 });
    assert.equal(r.status, 2, `${JSON.stringify(args)}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /usage: suite-slot\.mjs/);
  }
});

test("a slot directory that cannot be made is refused naming it", () => {
  const host = slotHome();
  writeFileSync(join(host.home, ".fleet", "suite-slots"), "in the way");
  const r = run(host, "echo RAN");
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.ok(r.stderr.includes(`cannot create ${host.slots}`), r.stderr);
});
