import { test } from "node:test";
import assert from "node:assert/strict";
import { reportWritesOf } from "../plugin/scripts/member-record.mjs";

const P = "/scratch/reports/impl-9.json";
const BODY = '{"member":"impl-9"}';
const bash = (command) => ({ type: "toolCall", id: "b1", name: "bash", arguments: { command } });
const writesOf = (command) => reportWritesOf(bash(command));
const one = (command, content = BODY) => assert.deepEqual(writesOf(command), [{ file: "impl-9.json", content }], command);

test("each heredoc shape that writes a report yields exactly one write, body verbatim", () => {
  one(`cat > ${P} <<'EOF'\n${BODY}\nEOF`);
  one(`cat > ${P} <<EOF\n${BODY}\nEOF`);
  one(`cat > ${P} <<"EOF"\n${BODY}\nEOF`);
  one(`cat > "${P}" <<'EOF'\n${BODY}\nEOF`);
  one(`cat > '${P}' <<'EOF'\n${BODY}\nEOF`);
  one(`cat >${P} <<'EOF'\n${BODY}\nEOF`);
  one(`cat <<'EOF' > ${P}\n${BODY}\nEOF`);
  one(`tee ${P} <<'EOF'\n${BODY}\nEOF`);
  one(`tee ${P} >/dev/null <<'EOF'\n${BODY}\nEOF`);
  one(`cat > ${P} <<'EOF' && echo done\n${BODY}\nEOF\necho after`);
  // A wrapper word before the command, as the rtk-rewritten transcripts carry.
  one(`rtk cat > ${P} <<'EOF'\n${BODY}\nEOF`);
  one(`cd /scratch && cat > ${P} <<'EOF'\n${BODY}\nEOF`);
  // An unquoted tag does not expand the body.
  one(`cat > ${P} <<EOF\n{"d":"$HOME $(pwd)"}\nEOF`, '{"d":"$HOME $(pwd)"}');
  // Every stdout redirect form, the last of several winning; other descriptors aside.
  one(`cat >| ${P} <<'EOF'\n${BODY}\nEOF`);
  one(`cat &> ${P} <<'EOF'\n${BODY}\nEOF`);
  one(`cat > /tmp/x.json > ${P} <<'EOF'\n${BODY}\nEOF`);
  one(`cat 2</dev/null > ${P} <<'EOF'\n${BODY}\nEOF`);
  one(`cat > ${P} 2>&1 <<'EOF'\n${BODY}\nEOF`);
  one(`/usr/bin/cat > ${P} <<'EOF'\n${BODY}\nEOF`);
  one(`cat > /scratch/rep\\\norts/impl-9.json <<'EOF'\n${BODY}\nEOF`);
  // Of several heredocs on one command, the last is the one written.
  one(`cat <<'A' > ${P} <<'B'\nx\nA\n${BODY}\nB`);
  // A terminator line may carry trailing blanks.
  one(`cat > ${P} <<'EOF'\n${BODY}\nEOF \t`);
});

test("a CR is a blank between words and at a terminator's end, so a CRLF command reads", () => {
  one(`cat > ${P}\r <<'EOF'\n${BODY}\nEOF`);
  one(`cat > ${P} <<'EOF'\r\n${BODY}\r\nEOF\r\n`, `${BODY}\r`);
});

test("a write behind a wrapper, inside $(…), or in a -c string is read the same way", () => {
  one(`timeout 5 cat > ${P} <<'EOF'\n${BODY}\nEOF`);
  one(`timeout -s KILL 5 tee ${P} <<'EOF'\n${BODY}\nEOF`);
  one(`nohup cat > ${P} <<'EOF'\n${BODY}\nEOF`);
  one(`nice -n 5 cat > ${P} <<'EOF'\n${BODY}\nEOF`);
  one(`sudo -u x cat > ${P} <<'EOF'\n${BODY}\nEOF`);
  one(`stdbuf -o0 cat > ${P} <<'EOF'\n${BODY}\nEOF`);
  one(`env FOO=1 cat > ${P} <<'EOF'\n${BODY}\nEOF`);
  one(`env -i cat > ${P} <<'EOF'\n${BODY}\nEOF`);
  one(`out=$(cat > ${P} <<'EOF'\n${BODY}\nEOF\n)`);
  one(`bash -c 'cat > ${P} <<EOF\n${BODY}\nEOF'`);
  one(`sh -lc "cat > ${P} <<'EOF'\n{\\"member\\":\\"impl-9\\"}\nEOF"`);
});

test("a plain cat heredoc piped into tee writes tee's path, unless a later redirect replaces its stdin", () => {
  one(`cat <<'EOF' | tee ${P}\n${BODY}\nEOF`);
  one(`cat <<'EOF' | tee ${P} >/dev/null\n${BODY}\nEOF`);
  one(`cat < /etc/hosts <<'EOF' > ${P}\n${BODY}\nEOF`);
  assert.deepEqual(writesOf(`cat <<'EOF' < /etc/hosts > ${P}\n${BODY}\nEOF`), []);
  assert.deepEqual(writesOf(`cat <<'EOF' <<< x > ${P}\n${BODY}\nEOF`), []);
  assert.deepEqual(writesOf(`cat <<'EOF' | tee ${P} < /etc/hosts\n${BODY}\nEOF`), []);
});

test("<<- strips leading tabs from the body lines and the terminator, and only tabs", () => {
  one(`cat > ${P} <<-'EOF'\n\t{\n\t\t"a": 1\n\t}\n\tEOF`, '{\n"a": 1\n}');
  one(`cat > ${P} <<-EOF\n\t${BODY}\nEOF`);
  // Without the dash a tabbed terminator is not one, and spaces are not stripped under it either.
  assert.deepEqual(writesOf(`cat > ${P} <<'EOF'\n${BODY}\n\tEOF`), []);
  assert.deepEqual(writesOf(`cat > ${P} <<-'EOF'\n${BODY}\n  EOF`), []);
});

test("a variable target resolves from a NAME=value earlier in the same command, or by its literal reports/ tail", () => {
  one(`R=${P}; cat > $R <<'EOF'\n${BODY}\nEOF`);
  one(`R=${P}\ncat > $R <<'EOF'\n${BODY}\nEOF`);
  one(`R=${P}; cat > "$R" <<EOF\n${BODY}\nEOF`);
  one(`R=${P}; cat > \${R} <<EOF\n${BODY}\nEOF`);
  one(`R=${P}; cat > "\${R}" <<EOF\n${BODY}\nEOF`);
  one(`R="${P}"; cat > $R <<EOF\n${BODY}\nEOF`);
  one(`export R=${P}; cat > $R <<EOF\n${BODY}\nEOF`);
  one(`local R=${P}; cat > $R <<EOF\n${BODY}\nEOF`);
  one(`declare R=${P}; cat > $R <<EOF\n${BODY}\nEOF`);
  one(`R=${P}; mkdir -p "$(dirname "$R")"; cat > "$R" <<EOF\n${BODY}\nEOF`);
  one(`R=${P}; tee "$R" >/dev/null <<'EOF'\n${BODY}\nEOF`);
  // The last assignment before the write wins.
  one(`R=/scratch/other.json; R=${P}; cat > $R <<'EOF'\n${BODY}\nEOF`);
  // Whatever precedes a literal /reports/<name>.json tail, the report's name is known.
  one(`D=/scratch; mkdir -p $D/reports; cat > $D/reports/impl-9.json <<'EOF'\n${BODY}\nEOF`);
  one(`cat > "$D/reports/impl-9.json" <<'EOF'\n${BODY}\nEOF`);
  one(`cat > \${D}/reports/impl-9.json <<'EOF'\n${BODY}\nEOF`);
  one(`cat > "$HOME/reports/impl-9.json" <<'EOF'\n${BODY}\nEOF`);
  one(`R=$(pwd)/reports/impl-9.json; cat > $R <<'EOF'\n${BODY}\nEOF`);
});

test("a command that writes two reports yields both, in order", () => {
  const Q = "/scratch/reports/impl-9-b.json";
  const both = [{ file: "impl-9.json", content: "1" }, { file: "impl-9-b.json", content: "2" }];
  assert.deepEqual(writesOf(`cat > ${P} <<'EOF'\n1\nEOF\ncat > ${Q} <<'EOF'\n2\nEOF`), both);
  assert.deepEqual(writesOf(`cat > ${P} <<A; cat > ${Q} <<B\n1\nA\n2\nB`), both);
});

test("no write for what the shell would not write there", () => {
  // Unterminated heredoc, including a terminator that only appears with trailing text other than blanks.
  assert.deepEqual(writesOf(`cat > ${P} <<'EOF'\n${BODY}`), []);
  assert.deepEqual(writesOf(`cat > ${P} <<'EOF'\n${BODY}\nEOFX`), []);
  assert.deepEqual(writesOf(`cat > ${P} <<'EOF'`), []);
  // Unassigned, non-literal and re-assigned-to-unknown variables, and no literal reports/ tail.
  assert.deepEqual(writesOf(`cat > $R <<'EOF'\n${BODY}\nEOF`), []);
  assert.deepEqual(writesOf(`R=$(pwd)/reports/$N.json; cat > $R <<'EOF'\n${BODY}\nEOF`), []);
  assert.deepEqual(writesOf(`R=${P}; R=$(pwd); cat > $R <<'EOF'\n${BODY}\nEOF`), []);
  assert.deepEqual(writesOf(`cat > $DIR/impl-9.json <<'EOF'\n${BODY}\nEOF`), []);
  assert.deepEqual(writesOf(`cat > /scratch/reports/$N.json <<'EOF'\n${BODY}\nEOF`), []);
  // A target outside reports/, or not a .json file in it.
  assert.deepEqual(writesOf(`cat > /tmp/impl-9.json <<'EOF'\n${BODY}\nEOF`), []);
  assert.deepEqual(writesOf(`R=/tmp/impl-9.json; cat > $R <<'EOF'\n${BODY}\nEOF`), []);
  assert.deepEqual(writesOf(`cat > /scratch/reports/impl-9.md <<'EOF'\n${BODY}\nEOF`), []);
  assert.deepEqual(writesOf(`cat > /scratch/reports/impl-9.json.bak <<'EOF'\n${BODY}\nEOF`), []);
  // Appends, here-strings, stderr redirects, a later stdout redirect elsewhere, and cat with
  // operands are not the report's content; nor is what xargs runs on the body's words.
  assert.deepEqual(writesOf(`cat >> ${P} <<'EOF'\n${BODY}\nEOF`), []);
  assert.deepEqual(writesOf(`tee -a ${P} <<'EOF'\n${BODY}\nEOF`), []);
  assert.deepEqual(writesOf(`tee --append ${P} <<'EOF'\n${BODY}\nEOF`), []);
  assert.deepEqual(writesOf(`cat > ${P} <<< "${BODY}"`), []);
  assert.deepEqual(writesOf(`cat 2> ${P} <<'EOF'\n${BODY}\nEOF`), []);
  assert.deepEqual(writesOf(`cat > ${P} > /tmp/x.json <<'EOF'\n${BODY}\nEOF`), []);
  assert.deepEqual(writesOf(`cat other.json > ${P} <<'EOF'\n${BODY}\nEOF`), []);
  assert.deepEqual(writesOf(`xargs cat > ${P} <<'EOF'\n${BODY}\nEOF`), []);
  // A write quoted, commented, or inside another heredoc's body is not a command.
  assert.deepEqual(writesOf(`echo "cat > ${P} <<'EOF'"\n${BODY}\nEOF`), []);
  assert.deepEqual(writesOf(`# cat > ${P} <<'EOF'\n${BODY}\nEOF`), []);
  assert.deepEqual(writesOf(`cat > /tmp/x <<'A'\ncat > ${P} <<'B'\n${BODY}\nB\nA`), []);
});

test("a heredoc for another command is skipped whole, and the next report write still lands", () => {
  one(`python3 - <<'PY'\nprint(1)\nPY\ncat > ${P} <<'EOF'\n${BODY}\nEOF`);
  one(`gh pr create --body "$(cat <<'EOF'\nbody\nEOF\n)"\ncat > ${P} <<'EOF'\n${BODY}\nEOF`);
  // Quotes in a heredoc inside $(…) are body text, not quoting.
  one(`git commit -m "$(cat <<'EOF'\nfix: don't drop\nEOF\n)" && cat > ${P} <<'EOF'\n${BODY}\nEOF`);
  one(`gh pr create --body "$(cat <<'EOF'\nsay "hi\nEOF\n)"\ncat > ${P} <<'EOF'\n${BODY}\nEOF`);
});

test("the write tool and non-bash calls are as before", () => {
  assert.deepEqual(reportWritesOf({ type: "toolCall", name: "write", arguments: { path: P, content: BODY } }), [{ file: "impl-9.json", content: BODY }]);
  assert.deepEqual(reportWritesOf({ type: "toolCall", name: "write", arguments: { path: "/tmp/impl-9.json", content: BODY } }), []);
  assert.deepEqual(reportWritesOf({ type: "toolCall", name: "read", arguments: { path: P } }), []);
  assert.deepEqual(reportWritesOf({ type: "text", text: "x" }), []);
});

test("10,000 unterminated heredoc lines scan in linear time", () => {
  const unterminated = Array.from({ length: 10_000 }, () => `cat > ${P} <<EOF`).join("\n");
  const started = performance.now();
  assert.deepEqual(writesOf(unterminated), []);
  const terminated = `R=${P}\n` + Array.from({ length: 10_000 }, () => `cat > $R <<'A'\nx\nA`).join("\n");
  assert.equal(writesOf(terminated).length, 10_000);
  assert.ok(performance.now() - started < 500, `took ${performance.now() - started}ms`);
});
