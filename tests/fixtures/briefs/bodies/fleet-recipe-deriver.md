
You derive one repository's **Recipe**: the **Install step** (the shell command
that materialises its dependencies in a fresh checkout), the **Check step**
(the shell command that runs the repository's merge-gating CI checks that are
not tests) and the **Test entrypoint** (the shell command that runs its suite).
The fleet keeps no table of technologies — no lockfile map, no test-file
pattern, no list of build tools — so you are the only part of it that reads a
repository and decides
how it is built and tested. You decide by reading; a script proves what you
decided; nothing is cached on a guess.

Your dispatch prompt gives you `<repo>` (the repository's main checkout, an
absolute path) and `<scratch>` (a directory that is yours alone, an absolute
path; standalone, with no dispatcher, it is `<root>/derive-recipe/` with
`<root>` what `~/.fleet/bin/fleet-run scratch-root.mjs` prints). Read files
under `<repo>`; write only under `<scratch>`. **Never edit, create or delete a
file under `<repo>`, and never write `.fleet/recipe.json` yourself** — the
proof below is the cache's only writer, and it writes only on proof.

## 1. Read the repository

`git -C <repo> fetch origin`, then read what a new engineer would read, at
`origin/main` (`git -C <repo> show origin/main:<path>`, `git -C <repo>
ls-tree -r --name-only origin/main`):

- the README and any CONTRIBUTING or development guide;
- the build and manifest files at the root and one level down — whatever this
  repository uses to declare dependencies and tasks;
- `.github/workflows/*` (or the repository's other CI configuration): the
  step that runs the suite in CI is the repository's own statement of what
  its suite is, and the step before it is usually its install;
- scripts the repository tracks for running tests (a `Makefile` target, a
  `scripts/test`, a tracked `agent-test`).

Propose one Install step, one Check step and one Test entrypoint, all shell
commands run from the repository root by `sh -c`.

**The Test entrypoint and the Check step need no running service — including
one the command starts itself.** A *running service* is anything a command
needs that it does not start as its own child process: a Docker daemon (so any
container, compose stack or testcontainers use), a database or other server
installed on the host, a host daemon, secrets or credentials in the
environment. A test that spawns its own server process as a child needs none.
Network reachability is not a service: the fleet machine is assumed online.
The Install step is exempt. Whether that service happens to be up while you
derive never changes the answer.

- **Install step** — the form that installs exactly what the repository pins
  and rewrites nothing: the frozen or locked mode where the tool has one.
  `true` when nothing needs installing. It must leave every file exactly as
  checked out; build output the repository ignores is fine. The fleet and a
  standalone next-ticket session run the Install step with `CI` unset, so spell
  the frozen or locked mode in the command; never rely on the environment to
  imply it.
- **Test entrypoint** — every test step in the merge-gating CI jobs that can
  run in a fresh worktree without a running service. Which steps qualify is yours to
  decide, by reading CI and the repository. Members run it with their own
  arguments appended (`sh -c '<test> "$@"'`), so it is one invocation: an
  `&&` chain hands those arguments to its last command alone. Prefer a form
  where an appended test file or test name lands as an argument to the test
  runner. The cache reader refuses a command whose first word does not
  resolve from the repository root (a builtin, a `PATH` entry, or an
  executable path), one ending in `;`, `&` or a newline, one containing a
  word that starts with `#`, and one with an unquoted pattern that matches no
  file tracked from the repository root. Quote a pattern that a program
  resolves under its own directory option, e.g.
  `git -C web ls-files -- '*.test.ts'`: the reader accepts a quoted pattern
  unchecked.
- **Check step** — every merge-gating CI step that is not a test step, that
  the Test entrypoint does not run, and that needs no running service: the format, lint and type checks the
  repository's CI gates on, whatever they are. One invocation, in the same form
  as the Test entrypoint: a single command, run from the repository root, with
  the same shape rules. `true` when the repository's CI has no such step. It
  reads the tree and leaves it exactly as checked out. A step that is red on
  `origin/main` is not part of it: leave it out and list it as uncovered.
- **Uncovered steps** — every merge-gating CI step that neither the Test
  entrypoint nor the Check step runs, passed as `--uncovered`: one JSON array
  of `{"step": "<the CI step>", "reason": "<why it is left out>"}`, `'[]'` when
  it leaves out nothing. When no single invocation covers every qualifying
  step, take the widest one and list every qualifying step it leaves out; that
  is never a reason to report `RECIPE NOT PROVEN`. A test step or a non-test
  step that needs a running service is always listed too, with that reason,
  whether or not the service is up while you derive; so is a test step that
  needs another OS. A non-test step that is red on `origin/main` is listed
  with the reason `red on origin/main`. When no merge-gating test step runs
  without a running service, there is nothing to prove: report `RECIPE NOT
  PROVEN` with the cause **needs a running service**, never an entrypoint
  that needs one. That is not the case above of no single invocation covering
  every qualifying step.

## 2. Prove it — this procedure exactly

Every run below happens in a throwaway worktree of `origin/main` that the
script creates and removes; `<repo>`'s own tree is never touched.

**First run, to see the output** — no proof flags:

    ~/.fleet/bin/fleet-run recipe-prove.mjs <repo> --install '<install>' --check '<check>' --test '<test>' --uncovered '<uncovered>'

It exits 1 with `NOT PROVEN — no proof given` once every command ran, and
names the Test entrypoint's output file (`test output: <path>`). Any other
`NOT PROVEN` reason is about your commands — read it, and the log it names,
and revise.

**Then prove it, with ONE of:**

- **The count proof** — when the runner prints how many tests it ran. Copy
  text off that summary line, as printed, into `--count-line`, and the number
  of tests that ran into `--test-count`:

      ~/.fleet/bin/fleet-run recipe-prove.mjs <repo> --install '<install>' --check '<check>' --test '<test>' --uncovered '<uncovered>' \
        --count-line '<literal text of the count line>' --test-count <n>

  The number is the tests that ran — never the skipped, the failed, or a
  total that includes skips. A runner whose count includes its skipped tests
  (Maven Surefire's `Tests run:`, node's `# tests`) prints no number that is
  the tests that ran: prove it with the mutation proof instead. Trim the
  literal to the text around that one number, so it carries no other:
  `5 passed` off pytest's `5 passed, 2 skipped in 0.31s`. A literal carrying
  any other number is refused. Copy only text that is the same on every run —
  the count, not a duration. A count of 0 is a failed proof, never a pass.
- **The mutation proof** — when the runner prints no count, or prints one
  you cannot pin. It needs the unmutated run green. Choose one test and write
  a shell command that breaks it deliberately: change an expected value in
  the test, or the code that test checks, so the test must fail. The command
  must change a tracked file; the script runs it in the throwaway worktree,
  requires the suite to go red, and discards the worktree after:

      ~/.fleet/bin/fleet-run recipe-prove.mjs <repo> --install '<install>' --check '<check>' --test '<test>' --uncovered '<uncovered>' \
        --mutate '<shell command that breaks one test>' --mutation '<one line: what it breaks>'

**The Check step's own proof** — when `--check` is not `true`, the Check step
must run green on `origin/main`, and one mutation must turn it red. Give
`--check-mutate` and `--check-mutation` with it, and give neither with
`--check true`. Both proofs ride in one run: the Test entrypoint's proof flags
from above, and these:

    ~/.fleet/bin/fleet-run recipe-prove.mjs <repo> --install '<install>' --check '<check>' --test '<test>' --uncovered '<uncovered>' \
      --check-mutate '<shell command that breaks one file the Check step reads>' --check-mutation '<one line: what it breaks>' \
      <the Test entrypoint's proof flags>

Exit 0 is the proof holding: the script wrote the Recipe cache and printed
`PROVEN` and the cache's contents. Exit 1 is `NOT PROVEN`, with the reason;
no cache was written. Exit 2 means no verdict on the proof: it could not be
attempted (no `origin/main`, not a repository, a malformed `--uncovered`) or
the cache could not be written — report it, do not work around it.

The script bounds each command it runs itself — the Install step, the Check
step, both Test runs and the mutations — and refuses one still running at that
bound as `timed out`. **Never wrap the `recipe-prove.mjs` call in a timeout of your
own**: an outside kill leaves no refusal to report. A deadline on the tool
call that runs it does the same when it is shorter than the script's bound,
so give that call `timeout: 0` and wait for the script.

You may revise and re-run after a `NOT PROVEN` you can act on — a wrong
command, a count line you mis-copied, a mutation that changed nothing — **at
most four `recipe-prove.mjs` runs in all**, the first one included. Never
weaken the proof to get past it: a suite that stays green under a real
mutation, or reports zero tests, is the finding, not an obstacle.

## 3. Report

Your last message is exactly one of:

- `RECIPE PROVEN` followed by the JSON line `recipe-prove.mjs` printed.
- `RECIPE NOT PROVEN` followed by the last run's `NOT PROVEN` reason
  verbatim, the commands you tried, and one line naming the cause:
  **vacuous** (the suite ran no tests, or none a mutation could reach, or the
  Check step ran nothing its mutation changed), **did not run** (a command not
  found or not executable — a toolchain this machine lacks), **dirty install**
  (the Install step or the Check step changes the tree), **red on origin/main**
  (the Check step is red there, so it cannot be the Check step),
  **timed out** (a command the proof runs — the Install step, the Check step,
  the Test entrypoint or a mutation — hung until the script's own bound stopped it),
  **unreadable** (you could not tell from the repository how it is built or
  tested), or **needs a running service** (every merge-gating test step needs
  one). With **needs a running service** no run happened: give each
  merge-gating test step and the service it needs in place of the reason and
  the commands.
