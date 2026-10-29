import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { checkLineEndings, endingsChanged, lineEndingChanges, lineEndings } from '../lib/checks/line-endings.mjs';
import { commit, removeRepo, tempRepo, testGit } from './helpers.mjs';

test('lineEndings names a file\'s style', () => {
  assert.equal(lineEndings(Buffer.from('a\nb\n')), 'lf');
  assert.equal(lineEndings(Buffer.from('a\r\nb\r\n')), 'crlf');
  assert.equal(lineEndings(Buffer.from('a\r\nb\n')), 'mixed');
  assert.equal(lineEndings(Buffer.from('no newline')), 'none');
  assert.equal(lineEndings(Buffer.from([1, 0, 2, 10])), 'binary');
});

test('endingsChanged: flips and mixing fail; keeping a style or going to none/binary does not', () => {
  assert.equal(endingsChanged('lf', 'crlf'), true);
  assert.equal(endingsChanged('crlf', 'lf'), true);
  assert.equal(endingsChanged('lf', 'mixed'), true);
  assert.equal(endingsChanged('crlf', 'mixed'), true);
  assert.equal(endingsChanged('lf', 'lf'), false);
  assert.equal(endingsChanged('mixed', 'lf'), false);
  assert.equal(endingsChanged('lf', 'none'), false);
  assert.equal(endingsChanged('none', 'crlf'), false);
});

const repos = [];
after(() => repos.forEach(removeRepo));

test('in a temp repo: flags the flipped and the mixed files only', () => {
  const dir = tempRepo({ 'lf.txt': 'a\nb\n', 'crlf.txt': 'a\r\nb\r\n', 'keep.txt': 'a\r\nb\r\n', 'mix.txt': 'a\nb\n' });
  repos.push(dir);
  const base = testGit(dir, ['rev-parse', 'HEAD']).trim();
  const sha = commit(dir, { 'lf.txt': 'a\r\nb\r\nc\r\n', 'crlf.txt': 'a\nb\n', 'keep.txt': 'a\r\nb\r\nc\r\n', 'mix.txt': 'a\r\nb\n', 'new-mixed.txt': 'x\r\ny\n', 'new-ok.txt': 'x\r\n' });
  const problems = lineEndingChanges(dir, base, sha).sort((x, y) => x.file.localeCompare(y.file));
  assert.deepEqual(problems, [
    { file: 'crlf.txt', before: 'crlf', after: 'lf' },
    { file: 'lf.txt', before: 'lf', after: 'crlf' },
    { file: 'mix.txt', before: 'lf', after: 'mixed' },
    { file: 'new-mixed.txt', before: 'new', after: 'mixed' },
  ]);
  const result = checkLineEndings({ cwd: dir, base, sha });
  assert.equal(result.ok, false);
  assert.match(result.message, /crlf.txt: crlf -> lf/);
  assert.match(result.message, /perl -pi/);
});

test('in a temp repo: a rename that flips endings is caught', () => {
  const dir = tempRepo({ 'old.txt': 'one\r\ntwo\r\nthree\r\nfour\r\n' });
  repos.push(dir);
  const base = testGit(dir, ['rev-parse', 'HEAD']).trim();
  testGit(dir, ['mv', 'old.txt', 'new.txt']);
  const sha = commit(dir, { 'new.txt': 'one\ntwo\nthree\nfour\n' });
  assert.deepEqual(lineEndingChanges(dir, base, sha), [{ file: 'new.txt', before: 'crlf', after: 'lf' }]);
});

test('in a temp repo: a content change that keeps the style passes', () => {
  const dir = tempRepo({ 'a.txt': 'a\r\n', 'b.txt': 'b\n' });
  repos.push(dir);
  const base = testGit(dir, ['rev-parse', 'HEAD']).trim();
  const sha = commit(dir, { 'a.txt': 'a\r\nmore\r\n', 'b.txt': 'b\nmore\n' });
  assert.equal(checkLineEndings({ cwd: dir, base, sha }).ok, true);
});
