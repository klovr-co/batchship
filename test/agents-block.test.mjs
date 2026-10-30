import assert from 'node:assert/strict';
import test from 'node:test';
import { parseConfig } from '../lib/config.mjs';
import { agentsBlockVersion, renderAgentsBlock, upsertAgentsBlock } from '../lib/render.mjs';
import { VERSION } from '../lib/version.mjs';

const config = parseConfig('shipTarget: staging\nbranches:\n  production: main\n  staging: staging\n');
const block = renderAgentsBlock(config);

test('the block has the markers, the version and the ship branch', () => {
  assert.ok(block.startsWith(`<!-- shiplane:start v${VERSION} -->\n## Shipping (managed by shiplane; settings in .agents/config.yml)`));
  assert.ok(block.endsWith('<!-- shiplane:end -->'));
  assert.match(block, /from a fresh origin\/staging\. Never push to it/);
  assert.match(block, /`node \.agents\/shiplane\/shiplane\.mjs ship <pr> --background` in a background shell, from the repo root \(an installed `shiplane ship` is the same/);
  assert.equal(block.split('\n').filter(l => /^\d\. /.test(l)).length, 9);
  assert.match(block, /Wait with `ship --background`, never with a PR watch alone \(T3's PR watch ends at merge without waking you\)/);
  assert.equal(agentsBlockVersion(block), VERSION);
});

test('appends to a file without a block, keeping the file', () => {
  const before = '# AGENTS\n\n## Setup\nRun it.\n';
  const after = upsertAgentsBlock(before, block);
  assert.ok(after.startsWith('# AGENTS\n\n## Setup\nRun it.\n\n<!-- shiplane:start'));
  assert.ok(after.endsWith('<!-- shiplane:end -->\n'));
  assert.equal(upsertAgentsBlock(null, block), `${block}\n`);
});

test('replaces only what is between the markers', () => {
  const head = '# AGENTS\nintro\n\n';
  const tail = '\n\n## Convex\nkeep me   \n\ttabs too\n';
  const old = `${head}<!-- shiplane:start v0.9.0 -->\nold rules\n<!-- shiplane:end -->${tail}`;
  const after = upsertAgentsBlock(old, block);
  assert.equal(after, `${head}${block}${tail}`);
  assert.equal(upsertAgentsBlock(after, block), after, 'idempotent');
});

test('a CRLF AGENTS.md gets a CRLF block', () => {
  const old = '# AGENTS\r\nintro\r\n';
  const after = upsertAgentsBlock(old, block);
  assert.ok(after.startsWith(old));
  assert.ok(!/[^\r]\n/.test(after), 'no bare LF');
  assert.equal(upsertAgentsBlock(after, block), after);
});

test('broken markers throw instead of guessing', () => {
  assert.throws(() => upsertAgentsBlock('<!-- shiplane:start v1 -->\nno end\n', block), /without <!-- shiplane:end -->/);
  assert.throws(() => upsertAgentsBlock('<!-- shiplane:start v1 -->\n<!-- shiplane:end -->\n<!-- shiplane:start v1 -->\n<!-- shiplane:end -->\n', block), /more than one/);
  assert.throws(() => upsertAgentsBlock('text\n<!-- shiplane:end -->\n', block), /without <!-- shiplane:start -->/);
});
