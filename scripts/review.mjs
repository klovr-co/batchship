#!/usr/bin/env node
// Code review by agents of each fix before it lands on a batch (fix.mjs done runs it), and an advisory review of the whole batch (ship.mjs). Reviewers come from review.reviewers in .ship.json:
// "same" (the harness running this), "claude", "codex", "agy", each optionally ":model", or { "name", "cmd" } for any command
// that reads the prompt on stdin and prints the JSON verdict. They run in parallel and read only.
// Usage: review.mjs [--base <ref>] [--focus "..."] [--advisory] [--out <file>] [--force: the human re-opens review after the round limit]   Writes batchship-review.json in the worktree's git dir; exit 0 = approved, 1 = changes, 2 = could not run.
import { execSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, withLivePolicy } from './config.mjs';

export const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['verdict', 'summary', 'findings'],
  properties: {
    verdict: { type: 'string', enum: ['approve', 'changes'] },
    summary: { type: 'string' },
    findings: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['severity', 'file', 'line', 'summary'],
      properties: { severity: { type: 'string', enum: ['blocker', 'major', 'minor'] }, file: { type: 'string' }, line: { type: ['integer', 'null'] }, summary: { type: 'string' } },
    } },
  },
};

// The harness this script runs under. Child processes inherit the parent's variables, so the innermost harness is checked first.
export function sameHarness(env = process.env) {
  if (env.ANTIGRAVITY_AGENT) return 'agy';
  if (env.CODEX_SANDBOX || env.CODEX_CI || env.CODEX_THREAD_ID) return 'codex';
  if (env.CLAUDECODE) return 'claude';
  return null;
}

export function parseReviewer(spec, env = process.env) {
  if (typeof spec === 'object') return { name: spec.name || spec.cmd, cmd: spec.cmd };
  const [h, model] = spec.split(/:(.*)/);
  const harness = h === 'same' ? sameHarness(env) : h;
  if (!harness) throw new Error('reviewer "same": cannot tell which agent is running; name one in review.reviewers (claude, codex, agy)');
  if (!['claude', 'codex', 'agy'].includes(harness)) throw new Error(`unknown reviewer "${spec}": use same, claude, codex, agy (each optionally :model) or { "cmd": ... }`);
  return { name: model ? `${harness}:${model}` : harness, harness, model };
}

// Command line per harness, kept read-only: claude gets file-reading tools only, codex runs in its read-only sandbox, agy in plan mode.
export function commandFor({ harness, model, cmd }, prompt, schemaPath, outPath, patchDir) {
  if (cmd) return { file: cmd, args: [], shell: true, stdin: prompt };
  const m = (flag) => (model ? [flag, model] : []);
  if (harness === 'claude') return { file: 'claude', args: ['-p', prompt, '--output-format', 'json', '--json-schema', JSON.stringify(SCHEMA),
    '--tools', 'Read,Grep,Glob', ...(patchDir ? ['--add-dir', patchDir] : []), ...m('--model')] };
  if (harness === 'codex') return { file: 'codex', args: ['exec', '-s', 'read-only', '--ephemeral', '--skip-git-repo-check', '--output-schema', schemaPath, '-o', outPath, ...m('-m'), prompt], out: outPath };
  return { file: 'agy', args: ['-p', prompt, '--mode', 'plan', '--sandbox', '--output-format', 'json', '--json-schema', schemaPath, ...(patchDir ? ['--add-dir', patchDir] : []), ...m('--model')] };
}

// Finds the verdict object in whatever a reviewer printed: plain JSON, a wrapper ({result} / {structured_output}), or JSON inside prose or a code fence.
export function extractVerdict(text) {
  const isVerdict = (o) => o && typeof o === 'object' && typeof o.verdict === 'string' && Array.isArray(o.findings);
  const walk = (v) => {
    if (isVerdict(v)) return v;
    if (typeof v === 'string') return fromText(v);
    if (v && typeof v === 'object') for (const x of Object.values(v)) { const r = walk(x); if (r) return r; }
    return null;
  };
  const fromText = (s) => {
    try { return walk(JSON.parse(s)); } catch {}
    for (let i = s.lastIndexOf('{"verdict"'); i >= 0; i = i ? s.lastIndexOf('{"verdict"', i - 1) : -1) {
      for (let j = s.indexOf('}', i); j >= 0; j = s.indexOf('}', j + 1)) { try { const o = JSON.parse(s.slice(i, j + 1)); if (isVerdict(o)) return o; } catch {} }
    }
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) try { return walk(JSON.parse(s.slice(a, b + 1))); } catch {}
    return null;
  };
  return fromText(String(text));
}

// A risky change gets review.riskyReviewers (when set) instead of review.reviewers: it touches soloPaths or review.riskyPaths,
// or changes more than review.riskyLines lines. Small, ordinary fixes keep the cheaper list.
export function pickReviewers(review, { files = [], lines = 0, soloPaths = [] }) {
  const paths = [...soloPaths, ...(review.riskyPaths || [])];
  const hit = files.find((f) => paths.some((p) => f.startsWith(p)));
  const big = review.riskyLines > 0 && lines > review.riskyLines;
  const risky = !!hit || big;
  const why = hit ? `touches ${hit}` : big ? `${lines} changed lines` : '';
  return { reviewers: risky && review.riskyReviewers?.length ? review.riskyReviewers : review.reviewers, risky, why };
}

// Changed files and lines (added + deleted) in a git diff range.
function diffSize(range) {
  const files = tryGit(`diff --name-only ${range}`).split('\n').filter(Boolean);
  const lines = tryGit(`diff --numstat ${range}`).split('\n').reduce((n, l) => { const [a, d] = l.split('\t'); return n + (+a || 0) + (+d || 0); }, 0);
  return { files, lines };
}

// Blockers and majors hold the batch back whatever the reviewer's own verdict says; minors are reported only.
export const blocking = (findings) => findings.filter((f) => f.severity === 'blocker' || f.severity === 'major');

// The reviewers get the commits, not git: inline when small, else in a file they read. Headless agy cannot run commands at all.
export function buildPrompt({ branch, live, focus, patch = '', patchFile, maxDiff = 100000, whole = false }) {
  return [
    whole
      ? `Review the whole batch ${branch} before it merges into ${live}. Each fix in it was already reviewed on its own, so look at how the fixes interact and at merge conflict resolutions. You are a reviewer: read only. Do not run shell commands, edit files, commit, push, or comment on GitHub; use your file reading and search tools.`
      : `Review the new commits on ${branch}: a fix landing on a temporary integration branch, which later merges into ${live}. You are a reviewer: read only. Do not run shell commands, edit files, commit, push, or comment on GitHub; use your file reading and search tools.`,
    patch.length <= maxDiff
      ? `The ${whole ? 'diff' : 'commits'} ${whole ? 'is' : 'are'} below. Read the surrounding code in the repo as needed.\n\n<commits>\n${patch}\n</commits>`
      : `The ${whole ? 'diff is' : 'commits are'} in ${patchFile} (read it in parts). Read the surrounding code in the repo as needed.`,
    'Look for correctness bugs, security problems (who can trigger what, data or account leaks, secrets in logs or stored messages), data loss, unsafe migrations, and risky logic without tests. Ignore style and formatting.',
    focus ? `Look hardest at: ${focus}` : '',
    'Severity: blocker = must not ship; major = fix before it lands; minor = worth fixing, not required. Only report what you can point to in the code.',
    'Reply with JSON only: {"verdict":"approve"|"changes","summary":"one or two sentences","findings":[{"severity":"blocker"|"major"|"minor","file":"path","line":123 or null,"summary":"what is wrong and the fix"}]}',
  ].filter(Boolean).join('\n\n');
}

// Reviewer process groups still running, so Ctrl-C on review.mjs stops them too.
const running = new Set();
const stopAll = () => { for (const pid of running) try { process.kill(-pid, 'SIGTERM'); } catch {} };

function run(reviewer, prompt, dir, timeoutMs, patchDir) {
  const tmp = mkdtempSync(join(tmpdir(), 'batchship-review-'));
  const schemaPath = join(tmp, 'schema.json');
  writeFileSync(schemaPath, JSON.stringify(SCHEMA));
  const c = commandFor(reviewer, prompt, schemaPath, join(tmp, 'out.txt'), patchDir);
  // A reviewer started from inside Claude Code must not look like a nested interactive session.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE' && !/^CLAUDE_CODE_(SESSION|CHILD|MESSAGING|ENTRYPOINT)/.test(k)));
  return new Promise((done) => {
    const p = spawn(c.file, c.args, { cwd: dir, env, shell: !!c.shell, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    running.add(p.pid);
    p.stdin.end(c.stdin || '');
    // Own process group, so a timeout also stops whatever the reviewer started.
    const timer = setTimeout(() => { try { process.kill(-p.pid, 'SIGTERM'); } catch {} }, timeoutMs);
    const finish = (error) => {
      clearTimeout(timer);
      running.delete(p.pid);
      const text = c.out && existsSync(c.out) ? readFileSync(c.out, 'utf8') : out;
      rmSync(tmp, { recursive: true, force: true });
      const v = error ? null : extractVerdict(text);
      done(v ? { name: reviewer.name, ok: true, verdict: v.verdict, summary: v.summary || '', findings: v.findings }
        : { name: reviewer.name, ok: false, error: error || `no verdict in output: ${(err || text).trim().slice(-400)}` });
    };
    p.on('error', (e) => finish(`could not start ${c.file}: ${e.message}`));
    p.on('close', (code, signal) => finish(signal ? `stopped after ${timeoutMs / 60000} min` : null));
  });
}

const git = (a) => execSync(`git ${a}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 }).trim();
const tryGit = (a) => { try { return git(a); } catch { return ''; } };
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

// Reviews the commits since the last passing review on this branch (first time: since it left --base, default the live branch).
// Commits that only merge another branch in carry nothing new, so they pass without a reviewer.
// --advisory: one review of the whole diff against --base (merge resolutions included); reports, never blocks, keeps no rounds.
// --out <file>: also write the results as JSON (ship.mjs puts them in the batch PR).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const top = git('rev-parse --show-toplevel');
  tryGit(`fetch -q origin ${loadConfig(top).protectedBranch}`); // fresh live policy and base
  const config = withLivePolicy(top, loadConfig(top)); // a batch cannot switch its own review off
  const { rounds, timeoutMinutes, focus: baseFocus } = config.review;
  let { reviewers } = config.review;
  const choose = (range) => {
    const p = pickReviewers(config.review, { ...diffSize(range), soloPaths: config.soloPaths });
    if (p.risky) console.log(`Risky change (${p.why}): reviewers ${JSON.stringify(p.reviewers)}.`);
    return p.reviewers;
  };
  const live = config.protectedBranch;
  const force = process.argv.includes('--force');
  const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const branch = git('rev-parse --abbrev-ref HEAD');
  const head = git('rev-parse HEAD');
  const markerPath = git('rev-parse --git-path batchship-review.json');
  const prev = readJson(markerPath)?.branch === branch ? readJson(markerPath) : null;
  const baseRef = arg('base') || `origin/${live}`;
  const outFile = arg('out');
  const show = (results) => {
    if (outFile) writeFileSync(outFile, JSON.stringify(results, null, 2));
    for (const r of results) {
      console.log(`\n## ${r.name}: ${r.ok ? `${r.verdict}. ${r.summary}` : `FAILED TO RUN: ${r.error}`}`);
      for (const f of r.findings || []) console.log(`- [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ''}: ${f.summary}`);
    }
  };
  if (!reviewers?.length) { if (outFile) writeFileSync(outFile, '[]'); console.log('review.reviewers is empty in .ship.json: review is off.'); process.exit(0); }
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopAll(); process.exit(130); });
  if (process.argv.includes('--advisory')) {
    reviewers = choose(`${baseRef}...HEAD`);
    let parsed;
    try { parsed = reviewers.map((r) => parseReviewer(r)); } catch (e) { console.error(e.message); process.exit(2); }
    const patch = git(`diff ${baseRef}...HEAD`);
    if (!patch) { if (outFile) writeFileSync(outFile, '[]'); console.log('Nothing to review.'); process.exit(0); }
    const patchFile = resolve(git('rev-parse --git-path batchship-review.patch'));
    writeFileSync(patchFile, patch);
    const prompt = buildPrompt({ branch, live, patch, patchFile, whole: true, focus: [baseFocus, arg('focus')].filter(Boolean).join(' ') });
    console.log(`Advisory review of the whole ${branch} with ${parsed.map((r) => r.name).join(', ')} ...`);
    show(await Promise.all(parsed.map((r) => run(r, prompt, process.cwd(), timeoutMinutes * 60000, dirname(patchFile)))));
    process.exit(0);
  }
  if (prev?.head === head && prev.pass && !force) { console.log(`Review already passed for ${head.slice(0, 8)}.`); process.exit(0); }
  const base = (prev?.passed && tryGit(`merge-base --is-ancestor ${prev.passed} HEAD && echo y`) === 'y' && prev.passed)
    || tryGit(`merge-base HEAD ${baseRef}`) || tryGit(`merge-base HEAD ${live}`);
  const range = base ? `${base}..HEAD` : 'HEAD';
  const save = (pass, failures, results = []) => writeFileSync(markerPath, JSON.stringify({ branch, head, pass, passed: pass ? head : prev?.passed || '', failures, from: base, at: new Date().toISOString(), results }, null, 2) + '\n');
  if (!git(`rev-list --first-parent --no-merges ${range}`)) { save(true, 0); console.log('Nothing new to review since the last passing review (merges only).'); process.exit(0); }
  const failures = prev?.failures || 0;
  if (failures >= rounds && prev.head !== head && !force) {
    console.error(`Review failed ${failures} times since the last pass (review.rounds is ${rounds}). Stop and hand the batch to the human with the open findings.`); process.exit(1);
  }
  reviewers = choose(range);
  let parsed;
  try { parsed = reviewers.map((r) => parseReviewer(r)); } catch (e) { console.error(e.message); process.exit(2); }
  const patch = git(`log -p --first-parent --no-merges --format="commit %h %s" ${range}`);
  const patchFile = resolve(git('rev-parse --git-path batchship-review.patch'));
  writeFileSync(patchFile, patch);
  const prompt = buildPrompt({ branch, live, patch, patchFile, focus: [baseFocus, arg('focus')].filter(Boolean).join(' ') });
  const count = git(`rev-list --count --first-parent --no-merges ${range}`);
  console.log(`Reviewing ${count} new commit(s) on ${branch} with ${parsed.map((r) => r.name).join(', ')} ...`);
  const results = await Promise.all(parsed.map((r) => run(r, prompt, process.cwd(), timeoutMinutes * 60000, dirname(patchFile))));
  const failed = results.filter((r) => !r.ok);
  const open = results.filter((r) => r.ok).flatMap((r) => blocking(r.findings));
  const pass = !failed.length && !open.length;
  // A reviewer that could not run does not use up a round; a re-run on the same HEAD does not either.
  const used = pass ? 0 : failed.length || prev?.head === head ? failures : failures + 1;
  save(pass, used, results);
  show(results);
  if (pass) console.log('\nReview passed.');
  else if (failed.length) console.log(`\nReview could not finish: ${failed.map((r) => r.name).join(', ')} did not run. Fix the reviewer or review.reviewers, then re-run.`);
  else console.log(`\nReview: ${open.length} blocker/major finding(s), failed review ${used} of ${rounds}. Fix them, commit, and run it again. A finding you disagree with: leave it, say why in the PR, and let the human decide.`);
  process.exit(pass ? 0 : failed.length ? 2 : 1);
}
