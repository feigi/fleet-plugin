// A review evicts the trees in its own run root when it ends: the snapshot and
// every specialist's and refuter's copy lose every path git ignores, whatever
// the review returned or threw, and the run root's own files stay. Driven
// through review-core.mjs's `runReview` with a scripted host whose snapshot
// agent builds the run root on disk, the way the snapshot step's shell does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReview } from "../plugin/scripts/review-core.mjs";
import { runReviewToFile } from "../plugin/scripts/review-eval.mjs";
import { ARGS, SNAP, parallel, pipeline, review, scriptedHost } from "./support/review-host-fixture.mjs";
import { makeTree } from "./support/run-tree.mjs";

function scratchDir(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "run-end-")));
  const scratch = join(dir, "scratch");
  mkdirSync(scratch);
  t.after(() => {
    // A case may leave a read-only directory behind.
    for (const p of readOnly) chmodSync(p, 0o755);
    readOnly.length = 0;
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, scratch };
}
const readOnly = [];

const RUN = "run-abcd1234";

// The run root a snapshot step leaves: the snapshot, a specialist's copy and a
// refuter's copy two levels down, each a tree with an installed directory, and
// the run root's own files.
function buildRunRoot(run) {
  const trees = [
    makeTree(join(run, "snapshot-abc123")),
    makeTree(join(run, "correctness", "copy")),
    makeTree(join(run, "verify-correctness", "finding-1", "copy")),
  ];
  const files = ["install.log", "status.txt", "pr.diff"].map((n) => join(run, n));
  for (const p of files) writeFileSync(p, "kept\n");
  return { trees, files };
}

const installed = (tree) => join(tree, "node_modules", "pkg", "index.js");

/**
 * A scripted host whose snapshot agent calls `build()` — which builds the run
 * root on disk and may return the report to give — and otherwise reports
 * `report`. `logs` collects what the review logs.
 */
function hostFor(build, report) {
  const base = scriptedHost({ "review:correctness": [review([])] });
  const logs = [];
  const host = {
    ...base.host, pipeline, parallel,
    log: (m) => logs.push(m),
    agent: async (prompt, opts) => {
      if (!opts.label.startsWith("snapshot")) return base.host.agent(prompt, opts);
      const built = build();
      return structuredClone(built ?? report);
    },
  };
  return { host, logs };
}

const reportFor = (run) => ({ ...SNAP, runRoot: run, path: join(run, "snapshot-abc123") });

test("runReview returns with every tree in its run root evicted and the run root's own files standing", async (t) => {
  const { scratch } = scratchDir(t);
  const run = join(scratch, "pr7", RUN);
  let built;
  const { host, logs } = hostFor(() => { built = buildRunRoot(run); }, reportFor(run));

  const result = await runReview(host, { ...ARGS, scratch });

  assert.equal(result.head, "abc123");
  for (const tree of built.trees) {
    assert.ok(!existsSync(join(tree, "node_modules")), `${tree} kept its installed directory`);
    assert.ok(existsSync(join(tree, "tracked.txt")) && existsSync(join(tree, ".git")), `${tree} lost more than its ignored paths`);
  }
  for (const p of built.files) assert.ok(existsSync(p), `${p} was removed`);
  assert.deepEqual(logs.filter((m) => /eviction/.test(m)), []);
});

test("runReview evicts the same trees when it throws past the snapshot step", async (t) => {
  const { scratch } = scratchDir(t);
  const run = join(scratch, "pr7", RUN);
  let built;
  // A later stage of the review throws: the whole review is a throw.
  const { host } = hostFor(() => { built = buildRunRoot(run); }, reportFor(run));
  host.pipeline = async () => { throw new Error("the host fell over"); };

  await assert.rejects(runReview(host, { ...ARGS, scratch }), /the host fell over/);

  for (const tree of built.trees) assert.ok(!existsSync(join(tree, "node_modules")), `${tree} kept its installed directory after a throw`);
  for (const p of built.files) assert.ok(existsSync(p));
});

test("runReview evicts the run root a refused snapshot report names, since the report named one", async (t) => {
  const { scratch } = scratchDir(t);
  const run = join(scratch, "pr7", RUN);
  let built;
  // The snapshot's path was not verified: the review refuses the tree.
  const { host } = hostFor(() => { built = buildRunRoot(run); }, { ...reportFor(run), pathVerified: false });

  await assert.rejects(runReview(host, { ...ARGS, scratch }), /review-pr:/);

  for (const tree of built.trees) assert.ok(!existsSync(join(tree, "node_modules")));
});

test("runReview evicts nothing when the snapshot agent reported nothing, and says nothing about it", async (t) => {
  const { scratch } = scratchDir(t);
  const run = join(scratch, "pr7", RUN);
  let built;
  const { host, logs } = hostFor(() => { built = buildRunRoot(run); }, null);

  await assert.rejects(runReview(host, { ...ARGS, scratch }), /review-pr:/);

  for (const tree of built.trees) assert.ok(existsSync(installed(tree)), `${tree} was evicted though no run root was reported`);
  assert.deepEqual(logs.filter((m) => /eviction/.test(m)), []);
});

test("runReviewToFile still writes review.json in the evicted run root and returns its status, ledger token and digest", async (t) => {
  const { scratch } = scratchDir(t);
  const run = join(scratch, "pr7", RUN);
  let built;
  const { host } = hostFor(() => { built = buildRunRoot(run); }, reportFor(run));

  const out = await runReviewToFile({ ...ARGS, scratch }, (a) => runReview(host, a));

  assert.equal(out.status, "completed");
  assert.equal(out.path, join(run, "review.json"));
  assert.match(out.ledger, new RegExp(`^reviewed=abc123:\\d+/\\d+/\\d+:${RUN}$`));
  assert.equal(out.attempts, 1);
  assert.deepEqual(out.errors, []);
  const written = JSON.parse(readFileSync(out.path, "utf8"));
  assert.equal(written.head, "abc123");
  assert.deepEqual(out.digest, (await import("../plugin/scripts/review-core.mjs")).digestOf(written));
  for (const tree of built.trees) assert.ok(!existsSync(join(tree, "node_modules")));
});

test("each failed attempt runReviewToFile retries evicts its own run root", async (t) => {
  const { scratch } = scratchDir(t);
  const runs = [join(scratch, "pr7", "run-aaaaaaaa"), join(scratch, "pr7", "run-bbbbbbbb")];
  const built = [];
  const { host } = hostFor(() => {
    const run = runs[built.length];
    built.push(buildRunRoot(run));
    return reportFor(run);
  }, null);
  host.pipeline = async () => { throw new Error("the host fell over"); };

  const out = await runReviewToFile({ ...ARGS, scratch }, (a) => runReview(host, a));

  assert.equal(out.status, "failed");
  assert.equal(built.length, 2);
  for (const { trees } of built) for (const tree of trees) assert.ok(!existsSync(join(tree, "node_modules")), `${tree} outlived its attempt`);
});

// A reported run root of any other shape is left alone: a `..` segment, another
// PR's run root, a symlink, the checkout.
test("a run root the snapshot report names that is not run- and eight characters directly in this PR's scratch directory is never evicted", async (t) => {
  const { dir, scratch } = scratchDir(t);
  const own = join(scratch, "pr7");
  mkdirSync(own, { recursive: true });
  const cases = {
    "a `..` segment": () => {
      const a = join(own, "run-aaaaaaaa");
      const b = join(own, "run-bbbbbbbb");
      mkdirSync(a, { recursive: true });
      return { tree: makeTree(join(b, "snapshot-abc123")), run: `${a}/../run-bbbbbbbb` };
    },
    "another PR's run root": () => {
      const run = join(scratch, "pr8", "run-cccccccc");
      return { tree: makeTree(join(run, "snapshot-abc123")), run };
    },
    "a symlink": () => {
      const real = join(dir, "elsewhere", "run-dddddddd");
      const tree = makeTree(join(real, "snapshot-abc123"));
      symlinkSync(real, join(own, "run-dddddddd"));
      return { tree, run: join(own, "run-dddddddd") };
    },
    "the checkout": () => {
      const checkout = join(dir, "checkout");
      return { tree: makeTree(join(checkout, "snapshot-abc123")), run: checkout };
    },
    "a name of another length": () => {
      const run = join(own, "run-abcd12");
      return { tree: makeTree(join(run, "snapshot-abc123")), run };
    },
    "a trailing slash": () => {
      const run = join(own, "run-eeeeeeee");
      return { tree: makeTree(join(run, "snapshot-abc123")), run: `${run}/` };
    },
  };
  for (const [name, make] of Object.entries(cases)) {
    let made;
    const { host, logs } = hostFor(() => {
      made = make();
      return { ...SNAP, runRoot: made.run, path: join(made.run, "snapshot-abc123") };
    }, null);
    await runReview(host, { ...ARGS, scratch }).catch(() => {});
    assert.ok(existsSync(installed(made.tree)), `${name}: a run root of that shape was evicted`);
    const said = logs.filter((m) => m.startsWith("no eviction at the end of the review: the reported run root "));
    assert.equal(said.length, 1, `${name}: the refused run root was not logged once, got ${JSON.stringify(logs)}`);
  }
});

// The snapshot step builds its `mktemp` template from the scratch exactly as
// given, so a trailing slash or a `./` segment reaches the reported run root
// and the snapshot path under it.
test("a scratch spelled with a trailing slash or a ./ segment still has its reported run root evicted", async (t) => {
  const { dir, scratch } = scratchDir(t);
  for (const [spelled, name] of [[`${scratch}/`, "run-slash111"], [`${dir}/./scratch`, "run-dotseg11"]]) {
    const run = `${spelled}/pr7/${name}`;
    let built;
    const { host, logs } = hostFor(() => { built = buildRunRoot(run); }, { ...SNAP, runRoot: run, path: `${run}/snapshot-abc123` });

    const result = await runReview(host, { ...ARGS, scratch: spelled });

    assert.equal(result.head, "abc123", spelled);
    for (const tree of built.trees) assert.ok(!existsSync(join(tree, "node_modules")), `${spelled}: ${tree} kept its installed directory`);
    assert.deepEqual(logs.filter((m) => /eviction/.test(m)), [], spelled);
  }
});

test("a log that throws on an eviction line changes nothing the review returns", async (t) => {
  const { scratch } = scratchDir(t);
  const own = join(scratch, "pr7");
  const results = [];
  for (const [name, throws] of [["run-abcd12", false], ["run-wxyz98", true]]) {
    // A name of another length: the run root is refused, and that is logged.
    const run = join(own, name);
    const { host } = hostFor(() => { makeTree(join(run, "snapshot-abc123")); }, { ...SNAP, runRoot: run, path: join(run, "snapshot-abc123") });
    const log = host.log;
    host.log = (m) => {
      if (throws && /eviction/.test(m)) throw new Error("log sink closed");
      log(m);
    };
    const result = await runReview(host, { ...ARGS, scratch });
    results.push(JSON.stringify(result).replaceAll(name, "<run>"));
  }
  assert.equal(results[1], results[0], "a throwing log changed what the review returned");
});

test("a failed eviction at the end of the review is logged and changes nothing the review returns", { skip: process.getuid?.() === 0 && "root ignores the read-only parent" }, async (t) => {
  const healthy = scratchDir(t);
  const failing = scratchDir(t);
  const results = [];
  let logs;
  for (const [{ scratch }, fail] of [[healthy, false], [failing, true]]) {
    const run = join(scratch, "pr7", RUN);
    const h = hostFor(() => {
      buildRunRoot(run);
      if (!fail) return;
      const stuck = makeTree(join(run, "zz-stuck"), { installed: ["sub/node_modules/pkg/index.js"] });
      chmodSync(join(stuck, "sub"), 0o555);
      readOnly.push(join(stuck, "sub"));
    }, reportFor(run));
    const result = await runReview(h.host, { ...ARGS, scratch });
    results.push(JSON.stringify(result).replaceAll(scratch, "<scratch>"));
    if (fail) logs = h.logs;
  }

  assert.equal(results[1], results[0], "a failed eviction changed what the review returned");
  const said = logs.filter((m) => /eviction at the end of the review failed/.test(m));
  assert.equal(said.length, 1, `expected one eviction failure in the log, got ${JSON.stringify(logs)}`);
  assert.match(said[0], /zz-stuck: could not remove sub\/node_modules\//);
});

test("a skipped directory in the run root is logged once as a skip at the end of the review and changes nothing the review returns", { skip: process.getuid?.() === 0 && "root reads a mode-000 directory" }, async (t) => {
  const plain = scratchDir(t);
  const skipping = scratchDir(t);
  const results = [];
  let logs;
  let locked;
  for (const [{ scratch }, skip] of [[plain, false], [skipping, true]]) {
    const run = join(scratch, "pr7", RUN);
    const h = hostFor(() => {
      buildRunRoot(run);
      if (!skip) return;
      locked = join(run, "zz-locked");
      mkdirSync(locked);
      chmodSync(locked, 0);
      readOnly.push(locked);
    }, reportFor(run));
    const result = await runReview(h.host, { ...ARGS, scratch });
    results.push(JSON.stringify(result).replaceAll(scratch, "<scratch>"));
    if (skip) logs = h.logs;
  }

  assert.equal(results[1], results[0], "a skipped directory changed what the review returned");
  const said = logs.filter((m) => /eviction/.test(m));
  assert.equal(said.length, 1, `expected one eviction line in the log, got ${JSON.stringify(logs)}`);
  assert.ok(said[0].startsWith(`eviction at the end of the review skipped ${locked}: `), said[0]);
  assert.match(said[0], /cannot list it \((EACCES|EPERM)\)$/);
  assert.doesNotMatch(said[0], /failed/);
});
