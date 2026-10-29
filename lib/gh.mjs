// The GitHub calls tug makes, through the gh CLI. `tug ship` takes any object with the same methods, so tests
// run the state machine against a fake.
import { execFileSync } from 'node:child_process';

export const MERGIFY_CHECK = 'Mergify Merge Queue';

export function gh(args, { input, cwd } = {}) {
  return execFileSync('gh', args, { cwd, input, encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['pipe', 'pipe', 'pipe'] });
}

const json = (args, opts) => JSON.parse(gh(args, opts) || 'null');

/** owner/name of the repo in cwd, and its default branch. */
export function repoInfo(cwd) {
  const r = json(['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef'], { cwd });
  return { slug: r.nameWithOwner, defaultBranch: r.defaultBranchRef?.name ?? null };
}

export function createClient(slug) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(slug || '')) throw new Error(`not a GitHub repo: ${slug}`);
  const R = ['-R', slug];
  const api = (path, extra = []) => json(['api', ...extra, `repos/${slug}/${path}`]);
  return {
    slug,
    pr(number) {
      const p = json(['pr', 'view', String(number), ...R, '--json', 'number,state,isDraft,labels,headRefOid,headRefName,baseRefName,mergeCommit,url,title']);
      return { ...p, labels: (p.labels || []).map(l => l.name) };
    },
    ready: number => gh(['pr', 'ready', String(number), ...R]),
    addLabels: (number, labels) => gh(['pr', 'edit', String(number), ...R, '--add-label', labels.join(',')]),
    comment: (number, body) => gh(['pr', 'comment', String(number), ...R, '--body', body]),
    openPrsWithLabel: label => json(['pr', 'list', ...R, '--state', 'open', '--label', label, '--json', 'number', '--limit', '100']).map(p => p.number),
    /** The newest Mergify Merge Queue check run on a commit: { status, conclusion, title, summary, startedAt, completedAt } or null. */
    mergifyCheck(sha) {
      const runs = api(`commits/${sha}/check-runs?check_name=${encodeURIComponent(MERGIFY_CHECK)}&filter=latest&per_page=20`).check_runs || [];
      runs.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)) || b.id - a.id);
      const c = runs[0];
      return c ? { status: c.status, conclusion: c.conclusion, title: c.output?.title || '', summary: c.output?.summary || '', startedAt: c.started_at, completedAt: c.completed_at } : null;
    },
    /** Runs of a workflow file on a commit, newest first: [{ id, status, conclusion, url, headSha, createdAt }]. */
    runs(workflow, sha) {
      return json(['run', 'list', ...R, '-w', workflow, '--commit', sha, '--json', 'databaseId,status,conclusion,url,headSha,createdAt', '--limit', '20']).map(r => ({ ...r, id: r.databaseId }));
    },
    /** Recent runs of a workflow on a branch, newest first. */
    branchRuns(workflow, branch) {
      return json(['run', 'list', ...R, '-w', workflow, '-b', branch, '--json', 'databaseId,status,conclusion,url,headSha,createdAt', '--limit', '20']).map(r => ({ ...r, id: r.databaseId }));
    },
    /** True when `sha` contains `ancestor` (sha is the same commit or ahead of it). */
    contains(ancestor, sha) {
      const status = api(`compare/${ancestor}...${sha}`).status;
      return status === 'ahead' || status === 'identical';
    },
    labels: () => json(['label', 'list', ...R, '--json', 'name', '--limit', '500']).map(l => l.name),
    createLabel: ({ name, color, description }) => gh(['label', 'create', name, ...R, '--color', color, '--description', description]),
    setDefaultBranch: branch => gh(['repo', 'edit', slug, '--default-branch', branch]),
    defaultBranch: () => json(['repo', 'view', slug, '--json', 'defaultBranchRef']).defaultBranchRef?.name ?? null,
    /** Every PR's head branch, state and head sha (for upkeep). */
    allPrs: () => json(['pr', 'list', ...R, '--state', 'all', '--limit', '1000', '--json', 'headRefName,state,headRefOid']),
    createPr: ({ base, head, title, body, labels = [] }) =>
      gh(['pr', 'create', ...R, '--base', base, '--head', head, '--title', title, '--body', body, ...labels.flatMap(l => ['--label', l])]).trim(),
  };
}
