// Part of tug. `tug init` copies this file into .agents/tug/checks/; edit it in the tug repo, not there.
// Line endings: a changed file that flips CRLF <-> LF (or becomes mixed) is a whole-file diff that hides the real
// change and breaks every other PR touching the file. Fails such a change; keeps each file's own style.
import { execFileSync } from 'node:child_process';
import { cleanEnv, git } from '../git.mjs';

/** "crlf", "lf", "mixed", "none" (no newline at all) or "binary" for a file's bytes. */
export function lineEndings(buffer) {
  if (buffer.includes(0)) return 'binary';
  let lf = 0;
  let crlf = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 10) {
      lf++;
      if (i > 0 && buffer[i - 1] === 13) crlf++;
    }
  }
  if (lf === 0) return 'none';
  if (crlf === 0) return 'lf';
  return crlf === lf ? 'crlf' : 'mixed';
}

/** A change that rewrites a file's line endings: an LF or CRLF file that ends up with any other style. */
export const endingsChanged = (before, after) =>
  (before === 'crlf' || before === 'lf') && after !== before && after !== 'none' && after !== 'binary';

/** Read many blobs (`<rev>:<path>` specs) with one `git cat-file --batch`. Returns a Buffer or null per spec. */
export function readBlobs(cwd, specs) {
  if (!specs.length) return [];
  const out = execFileSync('git', ['cat-file', '--batch'], { cwd, input: specs.join('\n') + '\n', maxBuffer: 1 << 30, env: cleanEnv() });
  const blobs = [];
  let at = 0;
  for (let n = 0; n < specs.length; n++) {
    const end = out.indexOf(10, at);
    const header = out.subarray(at, end).toString('utf8');
    at = end + 1;
    const match = /^\S+ (\S+) (\d+)$/.exec(header);
    if (!match) { blobs.push(null); continue; } // "<spec> missing"
    const size = Number(match[2]);
    blobs.push(match[1] === 'blob' ? out.subarray(at, at + size) : null);
    at += size + 1;
  }
  return blobs;
}

/** Files changed between base and sha: [{ status, file, from? }]. A rename (R) or copy (C) carries its old path. */
export function changedFiles(cwd, base, sha) {
  const fields = git(cwd, ['diff', '-M', '--name-status', '-z', base, sha]).split('\0').filter(Boolean);
  const out = [];
  for (let i = 0; i + 1 < fields.length; ) {
    const status = fields[i];
    if (/^[RC]/.test(status)) {
      out.push({ status: status[0], from: fields[i + 1], file: fields[i + 2] });
      i += 3;
    } else {
      out.push({ status, file: fields[i + 1] });
      i += 2;
    }
  }
  return out;
}

/**
 * Line-ending problems between base and sha: [{ file, before, after }].
 * A modified file must keep its style; an added file must not be mixed.
 */
export function lineEndingChanges(cwd, base, sha, changes = changedFiles(cwd, base, sha)) {
  // A rename or copy is compared with the file it came from.
  const pairs = changes.filter(c => c.status === 'M' || c.status === 'R' || c.status === 'C').map(c => ({ file: c.file, from: c.from ?? c.file }));
  const modified = pairs.map(p => p.file);
  const added = changes.filter(c => c.status === 'A').map(c => c.file);
  const blobs = readBlobs(cwd, [...pairs.flatMap(p => [`${base}:${p.from}`, `${sha}:${p.file}`]), ...added.map(file => `${sha}:${file}`)]);
  const problems = [];
  modified.forEach((file, i) => {
    const [a, b] = [blobs[2 * i], blobs[2 * i + 1]];
    if (!a || !b) return;
    const before = lineEndings(a);
    const after = lineEndings(b);
    if (endingsChanged(before, after)) problems.push({ file, before, after });
  });
  added.forEach((file, i) => {
    const blob = blobs[2 * modified.length + i];
    if (blob && lineEndings(blob) === 'mixed') problems.push({ file, before: 'new', after: 'mixed' });
  });
  return problems;
}

/** The check: { ok, problems, message }. */
export function checkLineEndings({ cwd, base, sha, changes }) {
  const problems = lineEndingChanges(cwd, base, sha, changes);
  if (!problems.length) return { ok: true, problems, message: 'line endings unchanged' };
  const list = problems.map(({ file, before, after }) => `  ${file}: ${before} -> ${after}`).join('\n');
  const fix = problems
    .map(({ file, before }) => `  ${before === 'crlf' ? "perl -pi -e 's/\\r?\\n/\\r\\n/'" : "perl -pi -e 's/\\r\\n/\\n/'"} '${file.replace(/'/g, "'\\''")}'`)
    .join('\n');
  return {
    ok: false,
    problems,
    message: `These files changed their line endings (a whole-file diff):\n${list}\nKeep each file's endings. To restore them, then commit:\n${fix}\n(New files take LF. In Python, open files with newline="" to keep endings.)`,
  };
}
