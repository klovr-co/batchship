// git pre-push: blocks pushing to the integration/production branches. Reads stdin lines: <lref> <lsha> <rref> <rsha>
import { readFileSync } from 'node:fs';
import { loadConfig } from './config.mjs';

const c = loadConfig();
const guarded = [c.protectedBranch, ...c.manualBranches].map((b) => `refs/heads/${b}`);
for (const line of readFileSync(0, 'utf8').split('\n').filter(Boolean)) {
  const remote = line.split(' ')[2];
  if (guarded.includes(remote)) {
    console.error(`batchship: no direct push to ${remote.replace('refs/heads/', '')}; use ${c.batchPrefixes[0]}NAME + PR`);
    process.exit(1);
  }
}
