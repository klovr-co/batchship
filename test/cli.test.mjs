import assert from 'node:assert/strict';
import test from 'node:test';
import { isPrNumber, main } from '../bin/shiplane.mjs';

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
  assert.ok(errors.every(e => /usage: shiplane <pr>/.test(e)));
});

test('the default command is ship: shiplane <pr> is shiplane ship <pr>, in the CLI and the vendored copy', async () => {
  const { withDefaultCommand, prNumberHint, runtimeMain } = await import('../lib/shiplane.mjs');
  assert.deepEqual(withDefaultCommand(['12', '--background']), ['ship', '12', '--background']);
  assert.deepEqual(withDefaultCommand(['ship', '12']), ['ship', '12']);
  assert.deepEqual(withDefaultCommand(['doctor']), ['doctor']);
  for (const bad of [['#12'], ['012'], ['12abc'], ['-3'], []]) assert.deepEqual(withDefaultCommand(bad), bad, JSON.stringify(bad));
  assert.match(prNumberHint('#12'), /digits only.*shiplane 12/);
  assert.equal(prNumberHint('doctor'), '');
  const errors = [];
  const orig = console.error;
  console.error = t => errors.push(String(t));
  try {
    assert.equal(await main(['#12']), 1);
    assert.equal(await main(['12', '--bogus']), 1);
    assert.equal(await main(['12', '13']), 1);
    assert.equal(await runtimeMain(['012']), 1);
    assert.equal(await runtimeMain(['12', '--bogus']), 1);
  } finally {
    console.error = orig;
  }
  assert.match(errors[0], /unknown command #12 \(a PR number is digits only.*shiplane 12\)/);
  assert.match(errors[1], /shiplane ship: unknown option --bogus/);
  assert.match(errors[2], /usage: shiplane <pr>/);
  assert.match(errors[3], /012 is not in the repo's copy.*digits only/);
  assert.match(errors[4], /unknown option --bogus/);
});
