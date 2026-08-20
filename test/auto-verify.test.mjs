// Auto-verify: safe_edit works out the appropriate tests when none are named.
//
// Mikey, 2026-08-19: "edits should be made through a server. The server should run
// the appropriate tests." safe_edit could always RUN a verify_command; it had no way
// to CHOOSE one, so every edit that omitted the argument got the structural gate and
// no tests. These tests pin the inference and the rollback that follows from it.

import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { inferVerifyCommand } from '../src/infer.js';
import { editFile } from '../src/edit.js';

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'autoverify-'));
  fs.mkdirSync(path.join(base, 'test'));
  // The fixture's test script deliberately does NOT nest `node --test`. Running the
  // test runner inside the test runner makes the child's result depend on the parent's
  // globbing and env, which is how the first version of this test passed standalone
  // and failed in-suite. A plain exit code is deterministic.
  fs.writeFileSync(path.join(base, 'package.json'),
    JSON.stringify({ name: 'fx', version: '1.0.0', scripts: {
      test: "node -e \"import('./lib.js').then(m => process.exit(m.answer() === 42 ? 0 : 1))\"" } }));
  fs.writeFileSync(path.join(base, 'lib.js'), 'export const answer = () => 42;\n');
  fs.writeFileSync(path.join(base, 'test', 'lib.test.mjs'),
    "import { test } from 'node:test'; import assert from 'node:assert';\n" +
    "import { answer } from '../lib.js';\n" +
    "test('answer is 42', () => assert.equal(answer(), 42));\n");
  return base;
}

describe('inferring the right tests', () => {
  test('a declared npm test script wins', () => {
    const base = fixture();
    const g = inferVerifyCommand(path.join(base, 'lib.js'));
    assert.deepEqual(g.command, ['npm', 'test']);
    assert.equal(g.cwd, base);
    assert.equal(g.confidence, 'declared');
    fs.rmSync(base, { recursive: true, force: true });
  });

  test('a test directory is found even with no declared script', () => {
    const base = fixture();
    const pkg = path.join(base, 'package.json');
    fs.writeFileSync(pkg, JSON.stringify({ name: 'fx', version: '1.0.0' }));
    const g = inferVerifyCommand(path.join(base, 'lib.js'));
    assert.deepEqual(g.command, ['node', '--test', 'test']);
    assert.equal(g.confidence, 'discovered');
    fs.rmSync(base, { recursive: true, force: true });
  });

  test('it declines rather than guessing when there is nothing to run', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'notests-'));
    fs.writeFileSync(path.join(base, 'notes.md'), '# just a document\n');
    const g = inferVerifyCommand(path.join(base, 'notes.md'));
    assert.equal(g.command, null);
    assert.equal(g.confidence, 'none');
    assert.match(g.why, /no test script/);
    fs.rmSync(base, { recursive: true, force: true });
  });
});

describe('auto-verify changes what an edit does', () => {
  test('an edit that breaks the suite is rolled back, with no verify_command given', () => {
    const base = fixture();
    const lib = path.join(base, 'lib.js');
    assert.throws(
      // verify_effort:'smoke' forces one run. On a one-character edit the default
      // 'auto' policy legitimately picks the structural gate and skips running — that
      // latency trade-off is a separate, already-tested behaviour. What is under test
      // here is that WHEN it runs, it runs the command auto-verify inferred.
      () => editFile(lib, { edits: [{ old: '42', new: '43', count: 1 }],
                            verify_the_verifier: false, verify_effort: 'smoke' }),
      /ROLLED BACK/,
      'a breaking edit must not survive just because no verify_command was named');
    assert.match(fs.readFileSync(lib, 'utf8'), /42/, 'the file on disk must be unchanged');
    fs.rmSync(base, { recursive: true, force: true });
  });

  test('auto_verify:false restores the old behaviour', () => {
    const base = fixture();
    const lib = path.join(base, 'lib.js');
    const r = editFile(lib, { edits: [{ old: '42', new: '43', count: 1 }], auto_verify: false });
    assert.equal(r.inferred_verification, null, 'nothing should be inferred when it is switched off');
    assert.match(fs.readFileSync(lib, 'utf8'), /43/, 'the edit lands untested, as before');
    fs.rmSync(base, { recursive: true, force: true });
  });

  test('the inference is reported, never silent', () => {
    const base = fixture();
    const r = editFile(path.join(base, 'lib.js'),
      { edits: [{ old: '42', new: '43', count: 1 }], dry_run: true });
    assert.ok(r.inferred_verification, 'the result must say what it worked out');
    assert.match(r.inferred_verification.why, /declares a test script/);
    fs.rmSync(base, { recursive: true, force: true });
  });
});
