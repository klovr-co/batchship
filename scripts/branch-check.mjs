#!/usr/bin/env node
// CI-side rule, agent-independent: a PR into the protected branch must come from ship/* or hotfix/* in the same repo.
// Env: HEAD_REF, BASE_REF, HEAD_REPO, BASE_REPO, SHIP_ENFORCE=1 to fail (default: warn only).
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';

export function checkPr({ headRef, baseRef, headRepo, baseRepo, config }) {
  if (baseRef !== config.protectedBranch) return null;
  const ok = [...config.batchPrefixes, ...config.hotfixPrefixes].some((p) => headRef.startsWith(p));
  if (ok && headRepo === baseRepo) return null;
  if (headRepo !== baseRepo) return `PR from a fork (${headRepo}) into ${baseRef}.`;
  return `PR into ${baseRef} must come from ${config.batchPrefixes.join(', ')} or ${config.hotfixPrefixes.join(', ')} (head: ${headRef}).`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const e = process.env;
  const msg = checkPr({ headRef: e.HEAD_REF || '', baseRef: e.BASE_REF || '', headRepo: e.HEAD_REPO || '', baseRepo: e.BASE_REPO || '', config: loadConfig() });
  if (msg) {
    console.log(`::${e.SHIP_ENFORCE === '1' ? 'error' : 'warning'}::batchship: ${msg}`);
    if (e.SHIP_ENFORCE === '1') process.exit(1);
  }
}
