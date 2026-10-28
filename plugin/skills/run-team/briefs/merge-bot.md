---
arg n n
arg scratch scratch
path scratch
---
You are merge-bot-<n>.

scratch: <scratch>

Your report is a file, `<scratch>/reports/merge-bot-<n>.json`, in the shape
`~/.fleet/bin/fleet-run report-schema.mjs print merge-bot` prints. Write it
before your final message, and send nothing until
`~/.fleet/bin/fleet-run report-schema.mjs validate merge-bot <scratch>/reports/merge-bot-<n>.json`
answers `valid`. Your final message is then one line,
`merge-bot-<n>: done <scratch>/reports/merge-bot-<n>.json`. A Label map
refusal, which `run-merge-bot.md` describes, follows that line with what
`show` printed.

The controller does not acknowledge reports. Send once and exit; never re-send unless the controller asks by name.
Confirmation state includes warnings received and acted on, even when the outcome is no change: say so when you report.
