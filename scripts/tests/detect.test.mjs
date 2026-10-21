import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detect } from '../detect.mjs';

test('mixed python + typescript repo yields per-folder checks with cwd and paths', () => {
  const r = mkdtempSync(join(tmpdir(), 'det-'));
  mkdirSync(join(r, 'web')); mkdirSync(join(r, 'api')); mkdirSync(join(r, 'node_modules'));
  writeFileSync(join(r, 'web/package.json'), JSON.stringify({ scripts: { lint: 'x', test: 'y' } }));
  writeFileSync(join(r, 'api/pyproject.toml'), '[tool.ruff]\n[tool.pytest.ini_options]\n');
  const names = detect(r).map((c) => c.name).sort();
  assert.deepEqual(names, ['api:pytest', 'api:ruff', 'web:lint', 'web:test']);
  const lint = detect(r).find((c) => c.name === 'web:lint');
  assert.equal(lint.cwd, 'web'); assert.deepEqual(lint.paths, ['web/']); assert.equal(lint.quick, true);
});
test('empty repo yields nothing', () => assert.deepEqual(detect(mkdtempSync(join(tmpdir(), 'det-'))), []));

test('uses the repo package manager (pnpm / bun) instead of npm', () => {
  for (const [lock, pm] of [['pnpm-lock.yaml', 'pnpm'], ['bun.lock', 'bun']]) {
    const r = mkdtempSync(join(tmpdir(), 'det-'));
    writeFileSync(join(r, 'package.json'), JSON.stringify({ scripts: { lint: 'x' } }));
    writeFileSync(join(r, lock), '');
    assert.equal(detect(r)[0].cmd, `${pm} run lint`);
  }
});
