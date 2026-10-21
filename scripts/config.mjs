import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULTS = {
  protectedBranch: 'main',   // the live/integration branch: batches land here
  manualBranches: [],        // branches only a human touches (e.g. ['main'] when staging is the live branch): agents may not push or open PRs to them
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
