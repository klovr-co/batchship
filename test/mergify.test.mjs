import assert from 'node:assert/strict';
import test from 'node:test';
import { parseConfig } from '../lib/config.mjs';
import { mergifyLeaks, renderMergify } from '../lib/render.mjs';
import { parseYaml } from '../lib/yaml.mjs';

const cfg = text => parseConfig(text);

test('default and hotfix queues: batch max 8 / 30 min, hotfix alone and first, interrupts', () => {
  const doc = parseYaml(renderMergify(cfg('mergeMethod: merge\nciCheck: Lint + Typecheck + Build\n')));
  const [hotfix, def] = doc.queue_rules;
  assert.equal(hotfix.name, 'hotfix');
  assert.equal(def.name, 'default');
  assert.deepEqual(def.batch_size, { min: 1, max: 8 });
  assert.equal(def.batch_max_wait_time, '30 min');
  assert.deepEqual(hotfix.batch_size, { min: 1, max: 1 });
  assert.equal(hotfix.batch_max_wait_time, '0 s');
  for (const rule of [hotfix, def]) {
    assert.equal(rule.merge_method, 'merge');
    assert.deepEqual(rule.merge_conditions, ['check-success = Lint + Typecheck + Build']);
    assert.ok(rule.queue_conditions.includes('base = main'));
    assert.ok(rule.queue_conditions.includes('-draft'));
    assert.ok(rule.queue_conditions.includes('-label = hold'));
    assert.ok(rule.queue_conditions.includes('-label = needs-owner'));
    assert.equal(rule.allow_inplace_checks, false);
  }
  assert.ok(hotfix.queue_conditions.includes('label = hotfix'));
  assert.ok(def.queue_conditions.includes('label = queue'));
  assert.deepEqual(doc.priority_rules, [{ name: 'hotfix', conditions: ['label = hotfix'], priority: 'high', allow_checks_interruption: true }]);
  assert.deepEqual(mergifyLeaks(renderMergify(cfg(null))), []);
});

test('base follows shipTarget, merge method follows the config', () => {
  const doc = parseYaml(renderMergify(cfg('shipTarget: staging\nbranches:\n  production: main\n  staging: staging\n')));
  for (const rule of doc.queue_rules) {
    assert.ok(rule.queue_conditions.includes('base = staging'));
    assert.equal(rule.merge_method, 'squash');
    assert.deepEqual(rule.merge_conditions, ['check-success = CI gate']);
  }
  assert.match(renderMergify(cfg(null)), /^# Managed by tug /);
});

test('mergifyLeaks names rules that let hold or needs-owner in', () => {
  const leaky = `queue_rules:
  - name: hotfix
    queue_conditions:
      - label = hotfix
  - name: default
    queue_conditions:
      - label = queue
      - -label=hold
      - or:
          - -label = needs-owner
          - label = approved
`;
  assert.deepEqual(mergifyLeaks(leaky), [
    { rule: 'hotfix', missing: ['hold', 'needs-owner'] },
    { rule: 'default', missing: ['needs-owner'] },
  ]);
  assert.deepEqual(mergifyLeaks('pull_request_rules: []\n'), [{ rule: '(no queue_rules)', missing: ['hold', 'needs-owner'] }]);
});
