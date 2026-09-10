'use strict';
// Runs every *_tests.js in this folder as a separate process and reports totals.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const files = fs.readdirSync(__dirname)
  .filter(f => f.endsWith('_tests.js'))
  .sort();

let failed = 0;
for (const f of files) {
  console.log('\n' + '#'.repeat(60) + '\n# ' + f + '\n' + '#'.repeat(60));
  try {
    const out = execFileSync('node', [path.join(__dirname, f)], { encoding: 'utf8' });
    process.stdout.write(out);
  } catch (e) {
    if (e.stdout) process.stdout.write(e.stdout);
    if (e.stderr) process.stderr.write(e.stderr);
    failed++;
  }
}

console.log('\n' + '='.repeat(60));
console.log(failed ? (failed + ' suite(s) FAILED') : 'ALL SUITES PASSED');
console.log('='.repeat(60));
process.exit(failed ? 1 : 0);
