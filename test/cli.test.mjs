import assert from 'node:assert/strict';
import test from 'node:test';
import { isPrNumber, main } from '../bin/tug.mjs';

test('PR numbers are parsed strictly', async () => {
  for (const ok of ['1', '7', '1333']) assert.equal(isPrNumber(ok), true, ok);
  for (const bad of ['', '0', '01', '#12', '-3', '+3', '1e3', '12abc', ' 12', '12 ', '1.0', '0x10', '١٢']) assert.equal(isPrNumber(bad), false, JSON.stringify(bad));
  const errors = [];
  const orig = console.error;
  console.error = t => errors.push(t);
  try {
    for (const bad of ['#12', '1e3', '01']) assert.equal(await main(['ship', bad]), 1);
    assert.equal(await main(['ship', '12', '13']), 1);
  } finally {
    console.error = orig;
  }
  assert.ok(errors.every(e => /usage: tug ship <pr>/.test(e)));
});
