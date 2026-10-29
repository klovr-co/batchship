import assert from 'node:assert/strict';
import test from 'node:test';
import { parseYaml, scalar, yamlScalar } from '../lib/yaml.mjs';

test('parses maps, lists of scalars and maps, comments and quotes', () => {
  const doc = parseYaml(`
# top comment
shipTarget: staging   # trailing
branches:
  production: main
  staging: "staging"
list:
  - a
  - 'b # not a comment'
  - https://x.example/a#frag
rules:
  - name: one
    conds:
      - label = queue
      - or:
          - -files ~= ^x
          - label = approved
empty: []
flow: [a, "b c"]
n: 8
none: null
`);
  assert.deepEqual(doc, {
    shipTarget: 'staging',
    branches: { production: 'main', staging: 'staging' },
    list: ['a', 'b # not a comment', 'https://x.example/a#frag'],
    rules: [{ name: 'one', conds: ['label = queue', { or: ['-files ~= ^x', 'label = approved'] }] }],
    empty: [],
    flow: ['a', 'b c'],
    n: 8,
    none: null,
  });
});

test('throws on what it cannot read', () => {
  assert.throws(() => parseYaml('a: |\n  text\n'), /block scalars/);
  assert.throws(() => parseYaml('a: 1\na: 2\n'), /duplicate key/);
  assert.throws(() => parseYaml('a:\n\tb: 1\n'), /tabs/);
  assert.throws(() => parseYaml('a:\n  - - x\n'), /nested sequences/);
  assert.deepEqual(parseYaml('--- # doc\na: 1\n'), { a: 1 });
  assert.throws(() => parseYaml('a: 1\n---\nb: 2\n'), /multiple documents/);
});

test('yamlScalar reads back as the same value', () => {
  for (const v of ['main', 'CI gate', 'Lint + Typecheck + Build', 'check-success = CI gate', 'a: b', '#x', 'null', '8', 'true', '', 'bunx bun@$(cat .bun-version) install', null, 3, false]) {
    assert.deepEqual(scalar(yamlScalar(v)), v, `round trip of ${JSON.stringify(v)}`);
  }
});
