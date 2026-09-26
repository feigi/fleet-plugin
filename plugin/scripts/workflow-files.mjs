import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

// #1204. Which files under `workflows/` the harness will actually register,
// and which are dead on arrival — derived, never listed.
//
// Shared rather than copied into each test file, for the reason
// strip-comments.mjs is shared: two copies of a discovery rule drift, and the
// half that drifts backwards is the half that goes silently green.
// `workflow-meta-first.test.mjs` asserts the SHAPE of the registrable files;
// `review-pr-reads.test.mjs` parse-checks them. Both need the same set, and
// neither may hardcode a filename — the workflow nobody remembered to add
// reads exactly like a workflow that passes.
//
// FOREIGN EVIDENCE, cited as observed rather than as a specification, the same
// constraint that governs #853: the registry is the harness's. What is new
// here is that the constraint was DISCHARGED rather than restated. Measured
// 2026-09-22 against Claude Code 2.1.272
// (`~/.local/share/claude/versions/2.1.272`), by lifting the shipped
// plugin-workflow discovery function out of the binary and running it, verbatim,
// against a throwaway plugin holding all three shapes at once — a flat
// `control.js`, a `nearmiss.mjs` beside it, and a nested `nested/deep.js`, each
// with `export const meta` first and a body that computes a marker, so an
// absence could not be misread as the meta-first trap (review-pr.js's
// throwaway-probe instruction). The function is:
//
//   async function _(o,s,i,n,d){let c=le(),e;try{e=await c.readdir(o)}catch{return[]}
//     return(await Promise.all(e.map(async(l)=>{
//       if(!(l.isFile()||l.isSymbolicLink()))return null;
//       if(!l.name.endsWith(".js"))return null;
//       return v(F(o,l.name),s,i,n,d)}))).filter((l)=>l!==null)}
//
// Three files on disk, ONE reached the loader: `control.js`. The `readdir` has
// no `recursive`, and a directory entry is dropped by the `isFile()` test
// rather than descended, so a nested workflow is never seen; `.mjs` fails the
// `endsWith(".js")` test. The sibling loader for `.claude/workflows/` is the
// same walk plus a counter — `if(/\.(mjs|cjs|ts)$/.test(r.name))i.nearMissExt++`
// — which returned `nearMissExt: 1` on the same tree: the harness does not
// merely fail to load a near-miss extension, it COUNTS people writing one. Its
// storage-backed variant refuses depth outright, `relPath.length!==1`.
//
// A live end-to-end registration could not be taken: this sandbox has no
// working Claude Code credentials (`claude -p` answers `OAuth session expired
// and could not be refreshed`, and no ANTHROPIC_API_KEY is set), so the
// harness never reaches the point of building a registry. Running its own
// shipped discovery code is the strongest check reachable from here, and it
// answers the same question one layer in.
//
// The OTHER harness registers nothing at all: omp's bundle carries no workflow
// loader (no `workflowsPath`, no `loadWorkflow`; its only `workflows/` strings
// are GitLab Duo API paths), which is the mechanism behind the standing fact
// that review-pr.js cannot run there and review-eval.mjs is the omp path. So
// widening this discovery to shapes "the loader might take" would assert
// something no loader does.
//
// The convention is therefore PINNED IN THREE PLACES, not two: the measurement
// above, `.github/workflows/ci.yml`'s `case plugin/workflows/*)` loop — which
// parse-checks `.js` with AsyncFunction and would send a `.mjs` to the
// `node --check` step that cannot accept a workflow body — and
// `docs/specs/2026-07-23-fleet-plugin-design.md`'s `## Layout` tree, whose
// `~/.claude/workflows/` listing is flat `.js` only.
export const WORKFLOWS = join(import.meta.dirname, "..", "workflows");

// Anything that reads as a script. A `.md` note or a stray `.DS_Store` beside a
// workflow is not this guard's business; a file the author plainly meant as
// code is.
const SCRIPT = /\.(js|mjs|cjs|ts)$/i;

// The one shape the loader takes: flat, `.js`.
const REGISTRABLE = /\.js$/;

// Split the tree into the files the harness loads and the files that look like
// workflows and are not. `unregistrable` is not a leftover bucket — it is the
// finding. A file in here is dead: it is never loaded, never errors, and
// nothing downstream can tell it from a workflow that ran and found nothing.
//
// Note what this does NOT do: it does not check meta-first on an unregistrable
// file. A `.mjs` whose first statement is `export const meta` is still dead, so
// asserting the shape rule on it would be a green on a broken file — worse than
// no coverage, which is the trap this ticket is itself about.
//
// A helper module deliberately parked under `workflows/` has no defence here,
// and needs none: a workflow body cannot `import` (#538 — `import()` is refused
// for any specifier, `require` is undefined), so a non-workflow script in this
// directory has no possible consumer. It belongs in `scripts/`.
export function discoverWorkflowFiles(dir = WORKFLOWS) {
  let entries;
  try {
    entries = readdirSync(dir, { recursive: true, withFileTypes: true });
  } catch (e) {
    // ENOENT — no workflows/ directory at all. Report the absence as an empty
    // set and let the caller refuse it. A throw here names the wrong thing:
    // the caller's floor assertion says "this guard asserted over nothing",
    // which is the sentence a reader needs. Any OTHER readdir failure
    // (EACCES, ENOTDIR, ...) is a real fault, not an absence, and must
    // propagate — folding it into the same empty result makes a permissions
    // or mount problem indistinguishable from a directory that was never
    // there.
    if (e.code !== "ENOENT") throw e;
    return { registrable: [], unregistrable: [] };
  }
  const registrable = [];
  const unregistrable = [];
  for (const entry of entries) {
    // Symlinks count, because the loader's own test is
    // `isFile() || isSymbolicLink()`.
    if (!(entry.isFile() || entry.isSymbolicLink())) continue;
    const path = relative(dir, join(entry.parentPath, entry.name));
    if (!SCRIPT.test(path)) continue;
    const nested = path.includes(sep);
    if (!nested && REGISTRABLE.test(path)) {
      registrable.push(path);
      continue;
    }
    unregistrable.push({
      path,
      // Both causes can hold at once, and the reader needs the one that is
      // actionable first: moving a nested `.mjs` up a level still leaves it
      // unloaded.
      why: nested
        ? "it is nested — the loader's readdir is not recursive and drops a directory entry instead of descending"
        : "its extension is not `.js` — the loader filters on `endsWith(\".js\")` and counts this as a near miss",
    });
  }
  registrable.sort();
  unregistrable.sort((a, b) => a.path.localeCompare(b.path));
  return { registrable, unregistrable };
}
