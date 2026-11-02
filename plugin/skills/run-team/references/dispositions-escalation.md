# Dispositions escalation: what you do with an escalate

What SKILL.md's **Dispositions escalation** points at: the message, the records and the comment that clear a `dispositions escalate` whose check printed no violations — a `critical`, `important` or severity-less finding a fix-applier deferred `remedy-outside-diff`, its record breaking no rule. An escalate whose check printed violations is a second mismatch on one review: no answer clears it, you comment and flag the PR for a human, and a new review of the PR counts again from none.

## Ask the maintainer

Post the check's output with `gh pr comment <M>`: it names each escalated finding, and re-running the check for the escalated member reprints it. Then put one message to the maintainer, with one yes/no for each escalated finding. Each finding is named by:

- its address, `<bucket>[<index>]` as the check printed it, its severity and its claim, read from `<scratch>/pr<M>/<run>/review.json`;
- its remedy files, as the check printed them;
- the issue it was filed to and the fix-applier's reason, read from the escalated member's record `<scratch>/dispositions-<member>.json`.

Yes means upheld: the deferral stands. No means sent back: the finding is applied in this PR.

Record nothing until every finding has an answer, and nothing without the maintainer's explicit answer in this session. Answers arrive in pieces, so hold each until the last is in; silence, a default and your own reading of the finding are no answer.

## Record the answers

On the answers, in this order:

1. Run `dispositions-check.mjs --member <member> --scratch <scratch> --uphold '<list>' --send-back '<list>'`, `<member>` the escalated fix-applier and each list the findings answered that way, `<bucket>[<index>]` separated by commas. Quote each list — `[` opens a glob under zsh — and pass a flag only for a list that has a finding in it. One write puts an `escalation-answer=<run>:<bucket>[<index>]:upheld|sent-back` token per finding on the PR's row and replaces the escalate with the verdict the answers earn. It refuses instead, exit 2 and the ledger untouched, naming the cause: the PR's current verdict on its latest review is not an escalate from that member, a fix-applier on the PR is live, the record breaks a rule, a finding is not one the record escalates or is listed twice or both ways, or an escalated finding has no answer.
2. Record one line per finding: `ledger.mjs ruled <M> "escalation answer <bucket>[<index>]: upheld|sent back — <reason>"`, the maintainer's reason.
3. Post one PR comment under the escalate comment, quoting the answers.

The verdict then decides what follows:

- `ok`: dispatch the finisher, as for any `ok`. An upheld finding passes; its deferral is judged by every other rule as before.
- `mismatch`: a sent-back finding is a broken rule, so the tick prints `DISPATCH fix-pr PR#<M>` and the retry runs as any mismatch's does. The retry's `--violations` are the check's lines as printed, the sent-back ones included; re-run the check for the member to reprint them. The retry's record is judged with the answers: deferring a sent-back finding again, for any reason, is a second failure, and applying it while deferring an upheld one `remedy-outside-diff` passes.
- `escalate`: an earlier fix-applier on the review had already failed, so the send-back is the second failure. Comment, flag the PR for a human, and a new review of the PR counts again from none.
- `unchecked`: the answers are recorded, but a filing could not be read. Run the check again once `gh` answers; it reads the answers already on the row.

An answer belongs to one review. A new review counts from none, so the same finding deferred again on it escalates again.

## Any other answer

The maintainer may rule otherwise: close the PR, re-review it. Record `ledger.mjs ruled <M> <decision>` and carry it out.
