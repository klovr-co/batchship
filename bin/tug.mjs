#!/usr/bin/env node
// tug was shiplane's name until 1.1.1. `tug setup` wrote user-level Stop hooks that run this path
// ('<node>' '<checkout>/bin/tug.mjs' guard --hook claude|codex): this shim keeps them working until `shiplane setup`
// replaces them. It is not on PATH (package.json's bin is shiplane only) and `shiplane doctor` reports such hooks.
import { EXIT } from '../lib/ship.mjs';
import { main } from './shiplane.mjs';

if (process.argv[2] !== 'guard') console.error('tug is now shiplane: run `shiplane ...` (and `shiplane setup` once, to replace hooks that still call bin/tug.mjs)');
main().then(
  code => { process.exitCode = code; },
  err => {
    console.error(`shiplane: ${err.message ?? err}`);
    process.exitCode = EXIT.error;
  },
);
