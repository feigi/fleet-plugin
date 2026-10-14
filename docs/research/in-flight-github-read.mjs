// The GitHub read shared by the In-flight research scripts
// (in-flight-baseline-derive.mjs, in-flight-guard-derive.mjs): transport
// choice, the raw-JSON cache and its refusal inside a git checkout, and the
// list-page reader whose truncation rule is docs/agents/issue-tracker.md's
// --limit rule in code. Zero dependencies, Node >= 18.
//
// Shells out to `gh api` when `gh auth status` succeeds, else to `curl`
// (honouring GITHUB_TOKEN when set and valid). Node's own fetch is deliberately
// not used: it does not honour HTTPS_PROXY.
//
// A caller hands in its own die(msg, code) and log(msg), so each script's
// refusals keep its own prefix and exit-code vocabulary.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PER_PAGE = 100;
/** The cache both scripts default to, so a page read by one serves the other. */
export const DEFAULT_CACHE = path.join(os.tmpdir(), "in-flight-baseline-cache");

/**
 * @param {{repo: string, cache: string, refresh: boolean, transport: "auto"|"gh"|"curl",
 *          noToken: boolean, die: (msg: string, code?: number) => never, log: (msg: string) => void}} o
 * @returns {{apiGet: (apiPath: string) => any, listPage: (basePath: string, page: number) => any[],
 *            fetchedAt: Map<string, string>, repoCacheDir: string, transport: {kind: string, token?: string|null}}}
 */
export function openGithubRead({ repo, cache, refresh, transport: wanted, noToken, die, log }) {
  // Raw JSON never belongs in a checkout: refuse a cache dir that sits inside one.
  for (let d = path.resolve(cache); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, ".git"))) die(`--cache ${cache} is inside the git checkout at ${d}; use a directory outside any repo (default ${DEFAULT_CACHE})`);
    if (path.dirname(d) === d) break;
  }
  const repoCacheDir = path.join(cache, repo.replace("/", "__"));
  fs.mkdirSync(repoCacheDir, { recursive: true });

  function curlRaw(url, token) {
    const args = ["-sS", "-w", "\n%{http_code}", "-H", "Accept: application/vnd.github+json",
      "-H", "X-GitHub-Api-Version: 2022-11-28"];
    if (token) args.push("-H", `Authorization: Bearer ${token}`);
    args.push(url);
    for (let attempt = 0; ; attempt++) {
      const r = spawnSync("curl", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
      if (r.error) die(`curl could not be run: ${r.error.message}`);
      if (r.status === 0 && typeof r.stdout === "string") {
        const cut = r.stdout.lastIndexOf("\n");
        const status = Number(r.stdout.slice(cut + 1).trim());
        return { status, body: r.stdout.slice(0, cut) };
      }
      if (attempt >= 3) die(`curl failed after ${attempt + 1} attempts: ${(r.stderr || "").trim()}`);
      const wait = 2000 * 2 ** attempt;
      log(`curl transport error (${(r.stderr || "").trim().split("\n")[0]}); retrying in ${wait / 1000}s`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
    }
  }

  function pickTransport() {
    if (wanted === "gh" || wanted === "auto") {
      const r = spawnSync("gh", ["auth", "status"], { encoding: "utf8" });
      if (r.status === 0) return { kind: "gh" };
      const why = r.error ? r.error.message : (r.stderr || r.stdout || "").trim();
      if (wanted === "gh") die(`--transport gh but \`gh auth status\` failed:\n${why}`);
      log(`gh auth status failed (${why.split("\n")[0] || "no gh"}); falling back to curl`);
    }
    let token = noToken ? null : (process.env.GITHUB_TOKEN || null);
    if (token) {
      // Probe the token before trusting it: an invalid token turns every read
      // into a 401, and a silent fallback would hide that. /rate_limit is free.
      const probe = curlRaw("https://api.github.com/rate_limit", token);
      if (probe.status === 401) { log("GITHUB_TOKEN is set but rejected (401); continuing without it"); token = null; }
      else if (probe.status !== 200) die(`token probe GET /rate_limit returned HTTP ${probe.status}`);
    }
    return { kind: "curl", token };
  }

  const transport = pickTransport();
  log(`transport: ${transport.kind}${transport.kind === "curl" ? (transport.token ? " (GITHUB_TOKEN)" : " (unauthenticated)") : ""}; cache: ${repoCacheDir}`);

  /** GET an API path (relative to https://api.github.com/), cached. Returns the
   *  parsed JSON body. Fails loudly on anything but HTTP 200. */
  const fetchedAt = new Map(); // apiPath -> ISO instant the cached body was read from GitHub
  function apiGet(apiPath) {
    const file = path.join(repoCacheDir, apiPath.replace(/[^A-Za-z0-9_.-]/g, "_") + ".json");
    if (!refresh && fs.existsSync(file)) {
      const env = JSON.parse(fs.readFileSync(file, "utf8"));
      if (env.status === 200) { fetchedAt.set(apiPath, env.fetchedAt); return env.data; }
    }
    let status, body;
    if (transport.kind === "gh") {
      const r = spawnSync("gh", ["api", apiPath], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
      if (r.status !== 0) die(`gh api ${apiPath} failed (exit ${r.status}): ${(r.stderr || "").trim()}`, 2);
      status = 200; body = r.stdout;
    } else {
      ({ status, body } = curlRaw(`https://api.github.com/${apiPath}`, transport.token));
      if (status !== 200) {
        const hint = status === 403 || status === 429 ? " (rate limited? check X-RateLimit headers; set GITHUB_TOKEN or wait)" : "";
        die(`GET ${apiPath} returned HTTP ${status}${hint}: ${body.slice(0, 300)}`, 2);
      }
    }
    let data;
    try { data = JSON.parse(body); } catch { die(`GET ${apiPath}: body is not JSON`, 2); }
    const now = new Date().toISOString();
    fs.writeFileSync(file, JSON.stringify({ fetchedAt: now, transport: transport.kind, apiPath, status, data }));
    fetchedAt.set(apiPath, now);
    return data;
  }

  /** Read one list page; a non-array body is a failure, never an empty list. */
  function listPage(basePath, page) {
    const data = apiGet(`${basePath}${basePath.includes("?") ? "&" : "?"}per_page=${PER_PAGE}&page=${page}`);
    if (!Array.isArray(data)) die(`${basePath} page ${page}: expected a JSON array, got ${typeof data}`, 2);
    if (data.length > PER_PAGE) die(`${basePath} page ${page}: ${data.length} items on a per_page=${PER_PAGE} page`, 2);
    return data;
  }

  return { apiGet, listPage, fetchedAt, repoCacheDir, transport };
}
