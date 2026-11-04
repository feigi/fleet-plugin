// One thread of `histories`: runs the histories `from` up to `to` and posts their summaries.
import { parentPort, workerData } from "node:worker_threads";
import { history, summarize } from "./split-histories.mjs";

const { delta, runs, from, to, stop } = workerData;
const summaries = [];
for (let h = from; h < to; h++) summaries.push(summarize(history({ delta, h, runs, stop })));
parentPort.postMessage(summaries);
