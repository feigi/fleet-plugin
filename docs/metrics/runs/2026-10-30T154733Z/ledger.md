# Fleet run ledger

## Rows

- #3996 impl-3996=PR#4031 · tier=slow-high · tier-ok=impl-3996:fleet-implementer-slow-high · review=member:review-pr-4031 · reviewed=61266afdcb6e1586b116c3389e8cbf901cf32c5e:0/0/3:run-g4Iwz6Os · fix-pr-4031=no-op · dispositions-ok=fix-pr-4031:run-g4Iwz6Os · ci=41029234166:1:success · finisher-pr-4031=labelled
- #4002 impl-4002=PR#4032 · tier=slow-high · tier-ok=impl-4002:fleet-implementer-slow-high · review=member:review-pr-4032 · reviewed=8f0e440c2edff14bddd2b74794076217f48e7eb5:0/0/2:run-8QQ6mv6x · fix-pr-4032=applied:a92f94d0a4e78450c9fa97a5aa9269b4290bac9d · dispositions-ok=fix-pr-4032:run-8QQ6mv6x · ci=41038197722:1:success · finisher-pr-4032=labelled
- #4008 impl-4008=PR#4033 · tier=slow-high · tier-ok=impl-4008:fleet-implementer-slow-high · review=member:review-pr-4033 · reviewed=bf2870f27118b8acb644229e85c7526eca0d5465:0/0/5:run-JVEwqB9J · fix-pr-4033=applied:8ded15e08c4b82d919f79f4332119dd9bf69349f · dispositions-ok=fix-pr-4033:run-JVEwqB9J · ci=41039732498:1:success · finisher-pr-4033=labelled
- #4012 impl-4012=PR#4035 · tier=task-high · tier-ok=impl-4012:fleet-implementer-task-high · review=member:review-pr-4035 · reviewed=9c49703a5a62bf292c2d1ecbf6c9a014b1114920:0/0/1:run-SJVY3NvE · fix-pr-4035=no-op · dispositions-ok=fix-pr-4035:run-SJVY3NvE · ci=41032203619:1:success · finisher-pr-4035=labelled · held-behind:#4033
- #3682 impl-3682=PR#4040 · tier=task-high · tier-ok=impl-3682:fleet-implementer-task-high · review=member:review-pr-4040 · reviewed=4d9acc18053885790406003696e97d908540269f:1/0/14:run-pap7M6wD · fix-pr-4040=applied:10df58056168f2cbee7be4bf2e6c3f082329e18d · dispositions-ok=fix-pr-4040:run-pap7M6wD · finisher-pr-4040=labelled
- #3846 impl-3846=PR#4041 · tier=task-high · tier-ok=impl-3846:fleet-implementer-task-high · review=member:review-pr-4041 · reviewed=3a8436cd4ead84420ad0b3bdd84eaf98fb244669:2/2/4:run-JXYs9kjd · fix-pr-4041=applied:4ccd42f729e6384289dd7f5fcf02f9b2ad5db345 · dispositions-ok=fix-pr-4041:run-JXYs9kjd · finisher-pr-4041=labelled

## Dispatched

- impl-3996=PR#4031 brief=05a39373 agent=fleet-implementer-slow-high
- impl-4002=PR#4032 brief=6a962dd8 agent=fleet-implementer-slow-high
- impl-4008=PR#4033 brief=167f0dea agent=fleet-implementer-slow-high
- impl-4012=PR#4035 brief=866ca2a0 agent=fleet-implementer-task-high
- impl-3682=PR#4040 brief=eee428a1 agent=fleet-implementer-task-high
- fix-pr-4031=no-op brief=15446aa9
- fix-pr-4033=applied:8ded15e08c4b82d919f79f4332119dd9bf69349f brief=2829f9fc
- fix-pr-4032=applied:a92f94d0a4e78450c9fa97a5aa9269b4290bac9d brief=85ca7363
- fix-pr-4035=no-op brief=f18c40d9
- finisher-pr-4035=labelled brief=790d5b9b
- merge-bot-1=done brief=c62ba17a queued=4035
- finisher-pr-4031=labelled brief=c4f63c55
- finisher-pr-4032=labelled brief=c4d92750
- merge-bot-2=done brief=ea7c04e1 queued=4031,4035
- finisher-pr-4033=labelled brief=3df30a16
- impl-3846=PR#4041 brief=b9fdb87d agent=fleet-implementer-task-high
- fix-pr-4040=applied:10df58056168f2cbee7be4bf2e6c3f082329e18d brief=dc7c3be5
- fix-pr-4041=applied:4ccd42f729e6384289dd7f5fcf02f9b2ad5db345 brief=a989c699
- finisher-pr-4040=labelled brief=c8f61ce8
- merge-bot-3=done brief=32f689ee queued=4040
- finisher-pr-4041=labelled brief=e42c785e
- merge-bot-4=done brief=1dc83a62 queued=4041

## Routed

- impl-3996 POLICY=slow-high CELL=slow-high DRAW=1/2 BY=burn-in STRATUM=light BRIEF=1730 CRITERIA=5 PARENT=- SIZED=- OBJECTIVE=cost TRIPPED=smol-high REASON=guard-tripped
- impl-4002 POLICY=slow-high CELL=slow-high DRAW=1/2 BY=burn-in STRATUM=light BRIEF=1864 CRITERIA=4 PARENT=- SIZED=- OBJECTIVE=cost TRIPPED=smol-high REASON=guard-tripped
- impl-4008 POLICY=slow-high CELL=slow-high DRAW=1/2 BY=burn-in STRATUM=light BRIEF=1906 CRITERIA=4 PARENT=- SIZED=- OBJECTIVE=cost TRIPPED=smol-high REASON=guard-tripped
- impl-4012 POLICY=slow-high CELL=task-high DRAW=2/2 BY=burn-in STRATUM=light BRIEF=1618 CRITERIA=3 PARENT=- SIZED=- OBJECTIVE=cost TRIPPED=smol-high REASON=guard-tripped
- impl-3682 POLICY=slow-high CELL=task-high DRAW=2/2 BY=burn-in STRATUM=heavy BRIEF=9784 CRITERIA=11 PARENT=- SIZED=- OBJECTIVE=cost TRIPPED=smol-high REASON=guard-tripped
- impl-3846 POLICY=slow-high CELL=task-high DRAW=2/2 BY=burn-in STRATUM=heavy BRIEF=12237 CRITERIA=7 PARENT=- SIZED=- OBJECTIVE=cost TRIPPED=smol-high REASON=guard-tripped

## Filed

- #4038 cockpit-tick-nonblocking test 'a relaunch that lands mid-gather()' fails when concurrent suite runs hold its cockpit port window
- #4039 PR #4033 review: the suggestion band, checked
- #4042 PR #4040 review: the suggestion band, checked
- #4043 .out-of-scope/fleet-prompt-doc-duplication.md: cites removed run-team section A mid-run tooling fix and renamed instruments.md heading
- #4044 PR #4041 review: the suggestion band, checked

## Ruled



## Drain

- shortlist empty, all run PRs merged
