import assert from 'node:assert/strict';
import test from 'node:test';
import { parseConfig } from '../lib/config.mjs';
import { agentsBlockVersion, renderAgentsBlock, upsertAgentsBlock } from '../lib/render.mjs';
import { VERSION } from '../lib/version.mjs';

const config = parseConfig('shipTarget: staging\nbranches:\n  production: main\n  staging: staging\n');
const block = renderAgentsBlock(config);

test('the block has the markers, the version and the ship branch', () => {
  assert.ok(block.startsWith(`<!-- tug:start v${VERSION} -->\n## Shipping (managed by tug; settings in .agents/config.yml)`));
  assert.ok(block.endsWith('<!-- tug:end -->'));
  assert.match(block, /from a fresh origin\/staging\. Never push to it/);
  assert.match(block, /`node \.agents\/tug\/tug\.mjs ship <pr> --background` in a background shell \(an installed `tug ship` is the same/);
  assert.equal(block.split('\n').filter(l => /^\d\. /.test(l)).length, 9);
  assert.match(block, /Wait with `ship --background`, never with a PR watch alone \(T3's PR watch ends at merge without waking you\)/);
  assert.equal(agentsBlockVersion(block), VERSION);
});

test('appends to a file without a block, keeping the file', () => {
  const before = '# AGENTS\n\n## Setup\nRun it.\n';
  const after = upsertAgentsBlock(before, block);
  assert.ok(after.startsWith('# AGENTS\n\n## Setup\nRun it.\n\n<!-- tug:start'));
  assert.ok(after.endsWith('<!-- tug:end -->\n'));
  assert.equal(upsertAgentsBlock(null, block), `${block}\n`);
});

test('replaces only what is between the markers', () => {
  const head = '# AGENTS\nintro\n\n';
  const tail = '\n\n## Convex\nkeep me   \n\ttabs too\n';
  const old = `${head}<!-- tug:start v0.9.0 -->\nold rules\n<!-- tug:end -->${tail}`;
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
  assert.throws(() => upsertAgentsBlock('<!-- tug:start v1 -->\nno end\n', block), /without <!-- tug:end -->/);
  assert.throws(() => upsertAgentsBlock('<!-- tug:start v1 -->\n<!-- tug:end -->\n<!-- tug:start v1 -->\n<!-- tug:end -->\n', block), /more than one/);
  assert.throws(() => upsertAgentsBlock('text\n<!-- tug:end -->\n', block), /without <!-- tug:start -->/);
});
