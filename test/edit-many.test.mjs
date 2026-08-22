// safe_edit_many: one literal edit across many files, all-or-nothing.
//
// Mikey, 2026-08-22, on why he preferred a stream editor: it "can't add anything or
// leave anything off that's outside of the edit radius". True of sed, and true here —
// but sed buys it at a price this does not pay. sed interprets its pattern, so a stray
// dot reaches further than intended. sed edits as it goes, so when file 37 of 40 is the
// one your pattern mangles, the first 36 are already written. And sed reports success
// for a run that matched nothing.
//
// These tests pin the three differences. The middle one is the reason the tool exists:
// NOTHING is written until EVERY file has been planned and passed its structural gate.

import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { editMany } from '../src/many.js';

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'editmany-'));
  const paths = {};
  for (const [name, body] of Object.entries(files)) {
    const p = path.join(root, name);
    fs.writeFileSync(p, body);
    paths[name] = p;
  }
  return { root, paths, read: (n) => fs.readFileSync(paths[n], 'utf8') };
}

describe('safe_edit_many — one bad file stops the whole sweep', () => {
  test('an ambiguous match in ONE file leaves every file untouched', () => {
    const f = fixture({
      'a.js': 'const TIMEOUT = 5000;\nexport function a(){ return TIMEOUT; }\n',
      'b.js': 'const TIMEOUT = 5000;\nexport function b(){ return TIMEOUT; }\n',
      'c.js': 'const TIMEOUT = 5000;\nconst OTHER = 5000;\nexport function c(){ return TIMEOUT + OTHER; }\n',
    });
    const snap = Object.keys(f.paths).map(f.read);
    const r = editMany(Object.values(f.paths), { edits: [{ old: '5000', new: '9000' }] });

    assert.equal(r.applied, false, 'a sweep with an ambiguous file must be refused');
    assert.ok(JSON.stringify(r.failed).includes('c.js'), 'the failing file must be named');
    Object.keys(f.paths).forEach((n, i) =>
      assert.equal(f.read(n), snap[i], `${n} was written despite the refusal`));
    fs.rmSync(f.root, { recursive: true, force: true });
  });

  test('an edit that would remove a function is refused for the whole sweep', () => {
    const f = fixture({
      'f.js': 'export function keepMe(){ return 1; }\nexport function alsoKeep(){ return 2; }\n',
      'g.js': 'export function keepMe(){ return 1; }\n',
    });
    const snap = Object.keys(f.paths).map(f.read);
    const r = editMany(Object.values(f.paths),
      { edits: [{ old: 'export function keepMe(){ return 1; }\n', new: '' }] });

    assert.equal(r.applied, false);
    Object.keys(f.paths).forEach((n, i) => assert.equal(f.read(n), snap[i]));
    fs.rmSync(f.root, { recursive: true, force: true });
  });
});

describe('safe_edit_many — a miss is not a failure', () => {
  test('a file with no match is SKIPPED and reported by name, not silently ignored', () => {
    const f = fixture({
      'a.js': 'const TIMEOUT = 5000;\nexport function a(){ return TIMEOUT; }\n',
      'd.js': 'export function d(){ return 1; }\n',
    });
    const before = f.read('d.js');
    const r = editMany(Object.values(f.paths), { edits: [{ old: 'TIMEOUT = 5000', new: 'TIMEOUT = 9000' }] });

    assert.equal(r.applied, true, r.reason);
    assert.ok(r.skipped.some((s) => s.path.endsWith('d.js')), 'the unmatched file must be listed');
    assert.equal(f.read('d.js'), before, 'the unmatched file must be untouched');
    assert.match(f.read('a.js'), /9000/);
    assert.equal(r.summary.files_to_edit, 1);
    assert.equal(r.summary.files_skipped_no_match, 1);
    fs.rmSync(f.root, { recursive: true, force: true });
  });
});

describe('safe_edit_many — matching is literal', () => {
  test('a dot in the search text is a dot, not a wildcard', () => {
    const f = fixture({ 'e.js': 'const re = "a.c";\nconst lit = "abc";\nexport function e(){ return re + lit; }\n' });
    const r = editMany(Object.values(f.paths), { edits: [{ old: 'a.c', new: 'XXX' }] });
    assert.equal(r.applied, true, r.reason);
    assert.match(f.read('e.js'), /"abc"/, 'a regex reading of "a.c" would have eaten "abc"');
    assert.match(f.read('e.js'), /"XXX"/);
    fs.rmSync(f.root, { recursive: true, force: true });
  });
});

describe('safe_edit_many — dry_run', () => {
  test('plans every file and writes nothing', () => {
    const f = fixture({ 'a.js': 'const X = 1;\nexport function a(){ return X; }\n' });
    const before = f.read('a.js');
    const r = editMany(Object.values(f.paths), { edits: [{ old: 'X = 1', new: 'X = 2' }], dry_run: true });
    assert.equal(r.applied, false);
    assert.equal(r.dry_run, true);
    assert.equal(r.planned.length, 1);
    assert.equal(f.read('a.js'), before);
    fs.rmSync(f.root, { recursive: true, force: true });
  });
});

describe('safe_edit_many — argument guards', () => {
  test('refuses an empty path list rather than reporting a no-op success', () => {
    assert.throws(() => editMany([], { edits: [{ old: 'a', new: 'b' }] }), /non-empty array/);
  });
  test('refuses an empty edit list', () => {
    assert.throws(() => editMany(['/tmp/x'], { edits: [] }), /non-empty array/);
  });
});

// The gap a mutation test found on 2026-08-22: deleting the sha256 pin from PHASE 2
// left all 162 tests green. Nothing checked that a file which moved on disk BETWEEN
// planning and writing gets refused. These two do.
describe('safe_edit_many — a file that moves between planning and writing', () => {
  test('refuses the write and restores the files it had already written', () => {
    const f = fixture({
      'a.js': 'const T = 1;\nexport function a(){ return T; }\n',
      'b.js': 'const T = 1;\nexport function b(){ return T; }\n',
    });
    const aBefore = f.read('a.js');
    const paths = [f.paths['a.js'], f.paths['b.js']];

    const r = editMany(paths, {
      edits: [{ old: 'T = 1', new: 'T = 2' }],
      // someone else edits b.js after we planned it and before we wrote it
      __before_write: () => {
        fs.writeFileSync(f.paths['b.js'], 'const T = 1;\nexport function b(){ return T + 0; }\n');
      },
    });

    assert.equal(r.applied, false, 'a moved file must not be written over');
    assert.match(r.reason, /restored/i);
    assert.equal(f.read('a.js'), aBefore, 'the file written before the failure must be put back');
    assert.ok(!f.read('b.js').includes('T = 2'), 'the moved file must keep the other edit');
    fs.rmSync(f.root, { recursive: true, force: true });
  });

  test('a sweep with nothing moving under it still applies', () => {
    const f = fixture({
      'a.js': 'const T = 1;\nexport function a(){ return T; }\n',
      'b.js': 'const T = 1;\nexport function b(){ return T; }\n',
    });
    const r = editMany([f.paths['a.js'], f.paths['b.js']], {
      edits: [{ old: 'T = 1', new: 'T = 2' }],
      __before_write: () => {},
    });
    assert.equal(r.applied, true);
    assert.ok(f.read('a.js').includes('T = 2'));
    assert.ok(f.read('b.js').includes('T = 2'));
    fs.rmSync(f.root, { recursive: true, force: true });
  });
});
