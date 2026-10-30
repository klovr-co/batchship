// Part of shiplane. `shiplane init` copies this file into .agents/shiplane/checks/; edit it in the shiplane repo, not there.
// Generated files are current: run a generator (config `generated: - run: <command>`) and fail if it changes the
// tree, i.e. the committed output is stale. Works in a dirty tree: it compares each path's state before and after.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanEnv, git } from '../git.mjs';

/** Paths in `git status --porcelain -z`: a rename or copy entry is followed by its old path as its own field. */
export function statusPaths(output) {
  const fields = output.split('\0');
  const paths = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if (entry[0] === 'R' || entry[0] === 'C') paths.push(fields[++i]);
  }
  return paths.filter(Boolean);
}

/** Map of every dirty or untracked path to a fingerprint of its status and content. */
export function snapshot(cwd) {
  const out = git(cwd, ['status', '--porcelain', '-z', '--untracked-files=all']);
  const state = new Map();
  for (const entry of out.split('\0')) if (entry.length >= 4) state.set(entry.slice(3), entry.slice(0, 2));
  for (const path of statusPaths(out)) {
    let digest = 'gone';
    try {
      digest = createHash('sha1').update(readFileSync(join(cwd, path))).digest('hex');
    } catch { /* deleted or a directory */ }
    state.set(path, `${state.get(path) ?? '??'} ${digest}`);
  }
  return state;
}

/** Paths whose state differs between two snapshots. */
export function diffSnapshots(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter(p => before.get(p) !== after.get(p)).sort();
}

/** Run one generator in cwd; { ok, changed, output, code }. */
export function checkGenerated({ cwd, run, env = cleanEnv() }) {
  const before = snapshot(cwd);
  const result = spawnSync('sh', ['-c', run], { cwd, env, encoding: 'utf8', maxBuffer: 1 << 26 });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const changed = diffSnapshots(before, snapshot(cwd));
  if (result.status !== 0) return { ok: false, changed, code: result.status ?? 1, output, message: `generator failed (exit ${result.status ?? 'signal'}): ${run}` };
  if (changed.length) {
    return {
      ok: false,
      changed,
      code: 0,
      output,
      message: `\`${run}\` changed files, so the committed output is stale:\n${changed.map(p => `  ${p}`).join('\n')}\nReview and commit them, then push again.`,
    };
  }
  return { ok: true, changed, code: 0, output, message: `generated files current (${run})` };
}
