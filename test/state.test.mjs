import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { shipCommand } from '../bin/tug.mjs';
import { findShipState, formatStatus, readJson, recordSessionPr, sessionFromEnv, sessionPath, shipReporter, shipStatePath } from '../lib/state.mjs';
import { World } from './fake-mergify.mjs';
import { assertInTmp, removeRepo, tempRepo, testGit } from './helpers.mjs';

const repos = [];
after(() => repos.forEach(removeRepo));
const repo = () => {
  const dir = tempRepo();
  repos.push(dir);
  return dir;
};

test('the session id comes from the environment, and only a safe one', () => {
  assert.equal(sessionFromEnv({ TUG_SESSION_ID: 'a', CLAUDE_CODE_SESSION_ID: 'b' }), 'a');
  assert.equal(sessionFromEnv({ CLAUDE_CODE_SESSION_ID: '0780a34a-3ded' }), '0780a34a-3ded');
  assert.equal(sessionFromEnv({ CODEX_THREAD_ID: 't-1' }), 't-1');
  assert.equal(sessionFromEnv({ TUG_SESSION_ID: '../x' }), null);
  assert.equal(sessionFromEnv({}), null);
});

test('shipReporter: running with a pid and log, then done with the result; the state dir ignores itself', () => {
  const dir = repo();
  let t = Date.parse('2026-10-29T08:00:00Z');
  const r = shipReporter({ root: dir, number: 12, session: 's', pid: 777, clock: () => t });
  assert.equal(readJson(r.path).status, 'running');
  assert.equal(readJson(r.path).pid, 777);
  for (let i = 0; i < 30; i++) r.log(`step ${i}`);
  t += 60_000;
  r.beat();
  const mid = readJson(r.path);
  assert.equal(mid.log.length, 20);
  assert.equal(mid.last, 'step 29');
  assert.equal(mid.updatedAt, '2026-10-29T08:01:00.000Z');
  r.finish({ code: 2, line: 'tug ship #12: not shipped', next: 'ask', waiting: 'needs-owner' });
  assert.deepEqual((({ status, code, waiting }) => ({ status, code, waiting }))(readJson(r.path)), { status: 'done', code: 2, waiting: 'needs-owner' });
  assert.equal(readFileSync(join(dir, '.agents/state/.gitignore'), 'utf8').split('\n')[1], '*');
  assert.equal(testGit(dir, ['status', '--porcelain']).trim(), '', 'state never shows as untracked');
});

test('recordSessionPr is idempotent and only ever adds queued', () => {
  const dir = repo();
  recordSessionPr(dir, 's1', { number: 3 });
  recordSessionPr(dir, 's1', { number: 3, queued: true });
  recordSessionPr(dir, 's1', { number: 3 });
  recordSessionPr(dir, 's1', { number: 4 });
  assert.deepEqual(readJson(sessionPath(dir, 's1')).prs.map(p => [p.number, p.queued]), [[3, true], [4, false]]);
  assert.throws(() => sessionPath(dir, '../evil'), /bad session id/);
  assert.ok(!existsSync(`${sessionPath(dir, 's1')}.lock`), 'the lock is released');
});

test('--status: running, done, gone, none; found from another worktree', () => {
  const dir = repo();
  const wt = assertInTmp(dir) + '-wt';
  testGit(dir, ['worktree', 'add', '-q', '-b', 'f', wt]);
  repos.push(assertInTmp(wt));
  const now = Date.parse('2026-10-29T08:00:00Z');
  assert.equal(formatStatus(9, findShipState(dir, 9)).code, 1);
  const r = shipReporter({ root: wt, number: 9, pid: 4242, clock: () => now });
  r.log('Mergify: Running merge queue checks');
  const found = findShipState(dir, 9);
  assert.equal(found.path, shipStatePath(wt, 9));
  assert.deepEqual(formatStatus(9, found, { isAlive: p => p === 4242, now }), { code: 0, text: 'tug ship #9: running (pid 4242, since 2026-10-29T08:00:00.000Z): Mergify: Running merge queue checks' });
  assert.match(formatStatus(9, found, { isAlive: () => false, now }).text, /stopped without a result/);
  r.finish({ code: 4, line: 'tug ship #9: merged · deploy: failure', next: 'open the run' });
  assert.deepEqual(formatStatus(9, findShipState(dir, 9)), { code: 4, text: 'tug ship #9: merged · deploy: failure\nnext: open the run' });
});

test('tug ship --background: no progress on the terminal, one result line, state and session written', async () => {
  const dir = repo();
  const w = new World({ deploys: { 'deploy.yml': { conclusion: 'success' } } });
  const out = [];
  const err = [];
  const o = w.opts();
  const code = await shipCommand({ root: dir, number: 7, background: true, env: { TUG_SESSION_ID: 'sess-bg' }, client: o.client, config: o.config, workflowFiles: ['deploy.yml'], sleep: o.sleep, clock: o.clock, out: t => out.push(t), err: t => err.push(t) });
  assert.equal(code, 0);
  assert.deepEqual(err, []);
  assert.deepEqual(out, ['tug ship #7: merged mmmmmmm into main · deploy: deploy.yml success · live: https://app.example.com']);
  const state = readJson(shipStatePath(dir, 7));
  assert.equal(state.status, 'done');
  assert.equal(state.code, 0);
  assert.equal(state.pid, process.pid);
  assert.ok(state.log.some(l => /posted "@mergifyio queue"/.test(l)));
  assert.deepEqual(readJson(sessionPath(dir, 'sess-bg')).prs.map(p => [p.number, p.queued]), [[7, true]]);
});

test('tug ship --background on a refusal: one line with next:, the state says what it waits on', async () => {
  const dir = repo();
  const w = new World({ pr: { labels: ['needs-owner'] } });
  const out = [];
  const o = w.opts();
  const code = await shipCommand({ root: dir, number: 7, background: true, env: { TUG_SESSION_ID: 'sess-r' }, client: o.client, config: o.config, workflowFiles: ['deploy.yml'], sleep: o.sleep, clock: o.clock, out: t => out.push(t), err: () => {} });
  assert.equal(code, 2);
  assert.equal(out.length, 1);
  assert.match(out[0], /^tug ship #7: not shipped: it has the needs-owner label · next: ask the user/);
  assert.equal(readJson(shipStatePath(dir, 7)).waiting, 'needs-owner');
  assert.deepEqual(readJson(sessionPath(dir, 'sess-r')).prs.map(p => [p.number, p.queued]), [[7, false]], 'recorded, not queued');
  assert.ok(existsSync(join(dir, '.agents/state/.gitignore')));
});

test('several tug ship processes recording one session at once lose no PR', async () => {
  const dir = repo();
  const { spawn } = await import('node:child_process');
  const lib = new URL('../lib/state.mjs', import.meta.url).href;
  const runs = Array.from({ length: 8 }, (_, i) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `import { recordSessionPr } from ${JSON.stringify(lib)}; for (let k = 0; k < 5; k++) recordSessionPr(${JSON.stringify(dir)}, 'race', { number: ${i + 1} * 100 + k, queued: true });`], { stdio: 'inherit' });
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  }));
  await Promise.all(runs);
  assert.equal(readJson(sessionPath(dir, 'race')).prs.length, 40);
});
