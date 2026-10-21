#!/bin/sh
# Builds a throwaway repo to try batchship end to end: a tiny node app, a local bare "origin", batchship installed, guard on block.
# Usage: playground/setup.sh [dir]   (default /tmp/batchship-playground; replaced if it exists)
set -e
PLUGIN=$(cd "$(dirname "$0")/.." && pwd)
DIR=${1:-/tmp/batchship-playground}
case "$DIR" in /tmp/*|/private/tmp/*|/var/*) ;; *) echo "refusing: $DIR is not under /tmp or /var"; exit 1 ;; esac
rm -rf "$DIR" "$(dirname "$DIR")/.batchship-wt/app"
mkdir -p "$DIR" && cd "$DIR"
git init -q --bare origin.git
git init -q -b main app && cd app
git config user.email play@example.com && git config user.name playground
git remote add origin "$DIR/origin.git"

cat > package.json <<'EOF'
{ "name": "app", "private": true, "type": "module",
  "scripts": { "lint": "node --check src/cart.js && node --check src/signup.js", "test": "node --test" } }
EOF
mkdir -p src test .github/workflows
cat > src/cart.js <<'EOF'
export const total = (items) => items.reduce((s, i) => s + i.price, 0); // bug: ignores quantity
export const label = (n) => `${n} item`; // bug: no plural
EOF
cat > src/signup.js <<'EOF'
export const validEmail = (e) => e.includes('@');
export const welcome = (name) => `Welcome ${name}`; // copy: should end with "!"
EOF
cat > test/cart.test.js <<'EOF'
import test from 'node:test'; import assert from 'node:assert/strict'; import { total } from '../src/cart.js';
test('total', () => assert.equal(total([{ price: 2 }]), 2));
EOF
cat > .github/workflows/ci.yml <<'EOF'
name: CI
on: { pull_request: { types: [opened, synchronize, ready_for_review] } }
jobs:
  test: { if: "!github.event.pull_request.draft", runs-on: ubuntu-latest, steps: [ { uses: actions/checkout@v4 }, { run: npm test } ] }
EOF
printf 'node_modules/\n' > .gitignore
printf '# app\n\nA tiny shop app.\n' > AGENTS.md
git add -A && git commit -qm "app" && git push -q -u origin main

node "$PLUGIN/scripts/init.mjs" > /dev/null
node -e '
const f = ".ship.json", c = JSON.parse(require("fs").readFileSync(f, "utf8"));
c.guardMode = "block"; c.soloPaths = [".github/"]; c.setup = "true";
c.checks = [{ name: "lint", cmd: "npm run lint", quick: true }, { name: "test", cmd: "npm test" }];
require("fs").writeFileSync(f, JSON.stringify(c, null, 2) + "\n");'
# Stands in for the human merging the setup PR, so the pre-push guard is overridden once here.
git add -A && git commit -qm "Set up batchship" && BATCHSHIP_ALLOW=1 git push -q
echo "playground ready: $DIR/app (on main, guard: block)"
