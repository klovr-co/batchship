#!/usr/bin/env node
// Lists candidate local checks found in the repo (root + one level of subfolders). Read-only.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SKIP = new Set(['node_modules', '.git', '.claude', '.batchship', 'dist', 'build', 'vendor', '.venv', 'venv']);
const has = (d, f) => existsSync(join(d, f));
const read = (d, f) => (has(d, f) ? readFileSync(join(d, f), 'utf8') : '');

export function detectDir(dir, rel) {
  const out = [];
  const tag = rel || 'root';
  const base = { cwd: rel || undefined, paths: rel ? [rel + '/'] : undefined };
  const add = (name, cmd, quick = false) => out.push({ name: `${tag}:${name}`, cmd, quick, ...Object.fromEntries(Object.entries(base).filter(([, v]) => v)) });

  if (has(dir, 'package.json')) {
    let scripts = {};
    try { scripts = JSON.parse(read(dir, 'package.json')).scripts || {}; } catch {}
    for (const [key, quick] of [['lint', true], ['typecheck', false], ['test', false]])
      if (scripts[key]) add(key, `npm run ${key}`, quick);
  }
  const py = read(dir, 'pyproject.toml') + read(dir, 'tox.ini') + read(dir, 'setup.cfg');
  if (py || has(dir, 'requirements.txt')) {
    if (has(dir, 'ruff.toml') || /\[tool\.ruff/.test(py)) add('ruff', 'ruff check .', true);
    if (has(dir, 'mypy.ini') || /\[tool\.mypy|\[mypy/.test(py)) add('mypy', 'mypy .');
    if (/pytest/.test(py) || has(dir, 'pytest.ini') || has(dir, 'tests')) add('pytest', 'pytest -x -q');
  }
  if (has(dir, 'go.mod')) { add('vet', 'go vet ./...', true); add('test', 'go test ./...'); }
  if (has(dir, 'Cargo.toml')) add('check', 'cargo check');
  const mk = read(dir, 'Makefile');
  if (!out.length) for (const t of ['lint', 'test']) if (new RegExp(`^${t}:`, 'm').test(mk)) add(t, `make ${t}`, t === 'lint');
  return out;
}

export function detect(root = process.cwd()) {
  const found = detectDir(root, '');
  for (const e of readdirSync(root)) {
    if (SKIP.has(e) || e.startsWith('.')) continue;
    const p = join(root, e);
    if (statSync(p).isDirectory()) found.push(...detectDir(p, e));
  }
  return found;
}

export function ciWorkflows(root = process.cwd()) {
  const d = join(root, '.github/workflows');
  return existsSync(d) ? readdirSync(d).filter((f) => /\.ya?ml$/.test(f)) : [];
}

import { pathToFileURL } from 'node:url';
if (import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify({ checks: detect(), workflows: ciWorkflows() }, null, 2));
