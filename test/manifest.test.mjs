import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { VERSION } from '../lib/version.mjs';

const json = p => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));

test('every manifest says shiplane and the kit version', () => {
  for (const p of ['package.json', 'plugin.json', '.claude-plugin/plugin.json']) {
    const m = json(p);
    assert.equal(m.name, 'shiplane', p);
    assert.equal(m.version, VERSION, p);
  }
  assert.equal(json('.claude-plugin/marketplace.json').plugins[0].name, 'shiplane');
});
