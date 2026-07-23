#!/usr/bin/env node

const inputChunks = [];
process.stdin.on('data', (chunk) => inputChunks.push(chunk));
process.stdin.on('end', () => {
  let input;
  try {
    input = JSON.parse(inputChunks.join(''));
  } catch {
    process.stdout.write('');
    return;
  }

  const parts = [];
  const reset = '\x1b[0m';
  const green = '\x1b[32m';
  const yellow = '\x1b[33m';
  const red = '\x1b[31m';
  const dim = '\x1b[2m';

  // 1. Folder + git branch
  const cwd = input.cwd || '';
  const folder = cwd.split('/').filter(Boolean).pop() || '';

  if (folder) {
    let branch = '';
    const path = require('path');
    const fs = require('fs');
    let dir = cwd;
    for (let i = 0; i < 10; i++) {
      try {
        const gitPath = path.join(dir, '.git');
        const stat = fs.statSync(gitPath);
        let headPath;
        if (stat.isDirectory()) {
          headPath = path.join(gitPath, 'HEAD');
        } else {
          // Worktree: .git is a file containing "gitdir: <path>"
          const contents = fs.readFileSync(gitPath, 'utf8').trim();
          const m = contents.match(/^gitdir:\s*(.+)$/m);
          if (!m) throw new Error('no gitdir');
          const gitdir = path.isAbsolute(m[1]) ? m[1] : path.resolve(dir, m[1]);
          headPath = path.join(gitdir, 'HEAD');
        }
        const head = fs.readFileSync(headPath, 'utf8').trim();
        branch = head.startsWith('ref: refs/heads/')
          ? head.slice('ref: refs/heads/'.length)
          : head.slice(0, 7);
        break;
      } catch {
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
    parts.push(branch ? `${folder} ${dim}[${branch}]${reset}` : folder);
  }

  // 2. Abbreviated model + thinking effort
  const modelId = ((input.model && (input.model.id || input.model.display_name)) || input.model || '').toLowerCase();
  let family = '';
  if (modelId.includes('opus')) {
    const ctxSize = input.context_window?.context_window_size;
    family = (ctxSize != null && ctxSize >= 1000000) ? 'Opus(1M)' : 'Opus';
  } else if (modelId.includes('sonnet')) family = 'Sonnet';
  else if (modelId.includes('haiku')) family = 'Haiku';

  if (family) {
    // Read effort from settings.json
    let effort = '';
    try {
      const fs = require('fs');
      const settings = JSON.parse(
        fs.readFileSync(require('path').join(process.env.HOME, '.claude', 'settings.json'), 'utf8')
      );
      effort = settings.effortLevel || '';
    } catch {}
    parts.push(effort ? `${family}@${effort}` : family);
  }

  // 3. Context fill % with color coding
  const pct = input.context_window?.used_percentage;
  if (pct != null) {
    const rounded = Math.round(pct);
    const color = rounded >= 80 ? red : rounded >= 50 ? yellow : green;
    parts.push(`ctx: ${color}${rounded}%${reset}`);
  }

  // 4. 5-hour rate limit percentage + reset countdown
  const fiveHour = input.rate_limits?.five_hour;
  if (fiveHour != null) {
    const usedPct = fiveHour.used_percentage;
    const color = usedPct >= 80 ? red : usedPct >= 50 ? yellow : green;

    let resetStr = '';
    if (fiveHour.resets_at != null) {
      const secsLeft = Math.max(0, fiveHour.resets_at - Math.floor(Date.now() / 1000));
      const h = Math.floor(secsLeft / 3600);
      const m = Math.floor((secsLeft % 3600) / 60);
      const hh = String(h).padStart(2, '0');
      const mm = String(m).padStart(2, '0');
      resetStr = ` ${dim}(rst T-${hh}:${mm})${reset}`;
    }

    parts.push(`5h: ${color}${Math.round(usedPct)}%${reset}${resetStr}`);
  }

  // 5. Session cost (USD) + last-turn delta (sticky)
  //    On /clear, the cost-reset-on-clear.sh SessionStart hook drops a flag
  //    file. We rebase the displayed cost by saving the harness-reported total
  //    at clear-time as a baseline, and showing (total - baseline).
  const cost = input.cost?.total_cost_usd;
  const sid = input.session_id;
  if (cost != null) {
    const fs = require('fs');
    const fmt = (n) => n.toFixed(2);
    let baseline = 0;
    let cleared = false;
    if (sid) {
      const baselineFile = `/tmp/claude-cost-baseline-${sid}.json`;
      const clearFlag = `/tmp/claude-clear-pending-${sid}`;
      try { fs.statSync(clearFlag); cleared = true; } catch {}
      if (cleared) {
        baseline = cost;
        try { fs.writeFileSync(baselineFile, JSON.stringify({ baseline })); } catch {}
        try { fs.unlinkSync(clearFlag); } catch {}
      } else {
        try {
          const b = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
          if (typeof b.baseline === 'number') baseline = b.baseline;
        } catch {}
      }
    }
    const display = Math.max(0, cost - baseline);
    let segment = `$${fmt(display)}`;
    if (sid) {
      const cacheFile = `/tmp/claude-cost-${sid}.json`;
      let prevCost = null;
      let lastDelta = 0;
      if (cleared) {
        try { fs.unlinkSync(cacheFile); } catch {}
      } else {
        try {
          const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
          if (typeof cached.cost === 'number') prevCost = cached.cost;
          if (typeof cached.delta === 'number') lastDelta = cached.delta;
        } catch {}
      }
      if (prevCost != null && cost > prevCost) lastDelta = cost - prevCost;
      try { fs.writeFileSync(cacheFile, JSON.stringify({ cost, delta: lastDelta })); } catch {}
      segment += ` ${dim}(+$${fmt(lastDelta)})${reset}`;
    }
    parts.push(segment);
  }

  // 6. GitHub link: workflow run > open PR > repo (45s TTL cache)
  try {
    const fs = require('fs');
    const path = require('path');
    const { execFileSync } = require('child_process');
    const crypto = require('crypto');

    // Determine the git root for cwd
    const gitRoot = (() => {
      let dir = cwd;
      for (let i = 0; i < 15; i++) {
        try { fs.statSync(path.join(dir, '.git')); return dir; } catch {}
        const p = path.dirname(dir);
        if (p === dir) return null;
        dir = p;
      }
      return null;
    })();

    if (gitRoot) {
      const cacheKey = crypto.createHash('md5').update(gitRoot).digest('hex').slice(0, 12);
      const cacheFile = `/tmp/claude-gh-link-${cacheKey}.json`;
      const TTL = 45;

      let cached = null;
      try {
        const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        if (raw && raw.ts && (Date.now() / 1000 - raw.ts) < TTL) cached = raw;
      } catch {}

      let linkUrl = null;
      let linkLabel = null;

      if (cached) {
        linkUrl = cached.url;
        linkLabel = cached.label;
      } else {
        // Resolve repo slug from remote
        let repoSlug = null;
        try {
          const remote = execFileSync('git', ['-C', gitRoot, 'remote', 'get-url', 'origin'],
            { timeout: 3000, env: process.env, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
          // ssh: git@github.com:owner/repo.git  or  https://github.com/owner/repo.git
          const m = remote.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
          if (m) repoSlug = m[1];
        } catch {}

        if (repoSlug) {
          const repoUrl = `https://github.com/${repoSlug}`;

          // Try: latest in-progress or queued workflow run on current branch
          let found = false;
          try {
            const branch = execFileSync('git', ['-C', gitRoot, 'rev-parse', '--abbrev-ref', 'HEAD'],
              { timeout: 3000, env: process.env, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
            const runsJson = execFileSync(
              'gh', ['run', 'list', '--branch', branch, '--limit', '3', '--json', 'status,databaseId,name'],
              { timeout: 8000, env: process.env, cwd: gitRoot, stdio: ['ignore', 'pipe', 'ignore'] }
            ).toString();
            const runs = JSON.parse(runsJson);
            const active = runs.find(r => r.status === 'in_progress' || r.status === 'queued' || r.status === 'waiting');
            if (active) {
              linkUrl = `${repoUrl}/actions/runs/${active.databaseId}`;
              linkLabel = `CI #${active.databaseId}`;
              found = true;
            }
          } catch {}

          // Try: open PR for current branch
          if (!found) {
            try {
              const prJson = execFileSync(
                'gh', ['pr', 'view', '--json', 'number,title,url', '--jq', '{number:.number,title:.title,url:.url}'],
                { timeout: 8000, env: process.env, cwd: gitRoot, stdio: ['ignore', 'pipe', 'ignore'] }
              ).toString().trim();
              if (prJson) {
                const pr = JSON.parse(prJson);
                linkUrl = pr.url;
                linkLabel = `PR #${pr.number}`;
                found = true;
              }
            } catch {}
          }

          // Fallback: repo root
          if (!found) {
            linkUrl = repoUrl;
            linkLabel = 'GitHub';
          }

          try {
            fs.writeFileSync(cacheFile, JSON.stringify({ ts: Math.floor(Date.now() / 1000), url: linkUrl, label: linkLabel }));
          } catch {}
        }
      }

      if (linkUrl && linkLabel) {
        const termProgram = process.env.TERM_PROGRAM || '';
        const supportsOsc8 = termProgram === 'iTerm.app' || termProgram === 'WezTerm' || termProgram === 'ghostty';
        if (supportsOsc8) {
          // OSC 8 hyperlink: ESC ] 8 ; ; url ST label ESC ] 8 ; ; ST
          const osc8 = `\x1b]8;;${linkUrl}\x07${dim}${linkLabel}${reset}\x1b]8;;\x07`;
          parts.push(osc8);
        } else {
          parts.push(`${dim}[${linkLabel}]${reset} ${linkUrl}`);
        }
      }
    }
  } catch {}

  process.stdout.write(parts.join(' | '));
});
