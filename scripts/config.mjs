import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULTS = {
  protectedBranch: 'main',   // integration branch: batches land here
  productionBranch: null,    // optional, e.g. 'main' when protectedBranch is 'staging'; takes releases from protectedBranch or hotfix/*
  batchPrefixes: ['ship/'],
  hotfixPrefixes: ['hotfix/'],
  guardMode: 'warn', // 'warn' | 'block'
  checks: [],        // { name, cmd, cwd?, paths?: string[] (prefixes), quick?: boolean }
};

export function loadConfig(dir = process.cwd()) {
  const file = join(dir, '.ship.json');
  if (!existsSync(file)) return { ...DEFAULTS };
  return { ...DEFAULTS, ...JSON.parse(readFileSync(file, 'utf8')) };
}
