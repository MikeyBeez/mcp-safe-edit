import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let ctx;
const p = (...x) => path.join(ctx.root, ...x);

before(async () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'safe-edit-test-')));
  const root = path.join(base, 'sandbox');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(root); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP SECRET\n');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(REPO, 'src', 'index.js'), root],
    cwd: REPO,
    env: { ...process.env, SAFE_EDIT_BACKUPS: path.join(base, 'backups') },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'safe-edit-tests', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);

  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    if (r.isError) throw new Error(r.content[0].text);
    return JSON.parse(r.content[0].text);
  };
  const err = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    if (!r.isError) return null;
    return JSON.parse(r.content[0].text);
  };
  ctx = { base, root, outside, client, call, err };
});

after(async () => {
  await ctx.client.close();
  fs.rmSync(ctx.base, { recursive: true, force: true });
});

beforeEach(() => {
  for (const e of fs.readdirSync(ctx.root)) fs.rmSync(p(e), { recursive: true, force: true });
  fs.writeFileSync(p('a.txt'), 'alpha\nbeta\ngamma\n');
  fs.writeFileSync(p('dup.txt'), 'target\nmiddle\ntarget\nend\ntarget\n');
});

describe('the hash token', () => {
  test('safe_read returns a sha256 that safe_verify agrees with', async () => {
    const r = await ctx.call('safe_read', { path: p('a.txt') });
    assert.match(r.sha256, /^[0-9a-f]{64}$/);
    assert.equal((await ctx.call('safe_verify', { path: p('a.txt'), expect_sha256: r.sha256 })).matches, true);
  });

  test('an edit against a stale hash is refused', async () => {
    const r = await ctx.call('safe_read', { path: p('a.txt') });
    fs.writeFileSync(p('a.txt'), 'someone else changed it\nbeta\n');   // concurrent change
    const e = await ctx.err('safe_edit', {
      path: p('a.txt'), expect_sha256: r.sha256, edits: [{ old: 'beta', new: 'BETA' }],
    });
    assert.ok(e, 'a stale edit must be refused');
    assert.match(e.error, /changed since you read it/i);
    assert.equal(fs.readFileSync(p('a.txt'), 'utf8'), 'someone else changed it\nbeta\n', 'the other writer must be left alone');
  });

  test('an edit with the current hash succeeds', async () => {
    const r = await ctx.call('safe_read', { path: p('a.txt') });
    const out = await ctx.call('safe_edit', { path: p('a.txt'), expect_sha256: r.sha256, edits: [{ old: 'beta', new: 'BETA' }] });
    assert.equal(out.verified, true);
    assert.equal(fs.readFileSync(p('a.txt'), 'utf8'), 'alpha\nBETA\ngamma\n');
  });

  test('the returned sha256_after matches the file that landed', async () => {
    const out = await ctx.call('safe_edit', { path: p('a.txt'), edits: [{ old: 'beta', new: 'BETA' }] });
    const check = await ctx.call('safe_verify', { path: p('a.txt'), expect_sha256: out.sha256_after });
    assert.equal(check.matches, true);
  });
});

describe('match counting', () => {
  test('a missing text is an error and nothing is written', async () => {
    const before = fs.readFileSync(p('a.txt'), 'utf8');
    const e = await ctx.err('safe_edit', { path: p('a.txt'), edits: [{ old: 'NOT PRESENT', new: 'x' }] });
    assert.ok(e);
    assert.match(e.error, /0 matches/);
    assert.equal(fs.readFileSync(p('a.txt'), 'utf8'), before);
  });

  test('an ambiguous match is an error, not a coin flip', async () => {
    const e = await ctx.err('safe_edit', { path: p('dup.txt'), edits: [{ old: 'target', new: 'X' }] });
    assert.ok(e);
    assert.match(e.error, /expected 1 match but found 3/);
    assert.match(e.error, /on lines 1, 3, 5/);
    assert.equal(fs.readFileSync(p('dup.txt'), 'utf8'), 'target\nmiddle\ntarget\nend\ntarget\n');
  });

  test('replace_all changes every occurrence and reports the count', async () => {
    const out = await ctx.call('safe_edit', { path: p('dup.txt'), edits: [{ old: 'target', new: 'X', replace_all: true }] });
    assert.equal(out.replacements, 3);
    assert.equal(fs.readFileSync(p('dup.txt'), 'utf8'), 'X\nmiddle\nX\nend\nX\n');
  });

  test('expect_count asserts a specific number', async () => {
    const ok = await ctx.call('safe_edit', { path: p('dup.txt'), edits: [{ old: 'target', new: 'X', expect_count: 3 }] });
    assert.equal(ok.replacements, 3);
  });

  test('a wrong expect_count is refused', async () => {
    const e = await ctx.err('safe_edit', { path: p('dup.txt'), edits: [{ old: 'target', new: 'X', expect_count: 2 }] });
    assert.ok(e);
    assert.match(e.error, /expected 2 matches but found 3/);
  });

  test('the error tells you how to resolve the ambiguity', async () => {
    const e = await ctx.err('safe_edit', { path: p('dup.txt'), edits: [{ old: 'target', new: 'X' }] });
    assert.match(e.error, /replace_all/);
    assert.match(e.error, /lengthen "old" until it is unique/);
  });
});

describe('all-or-nothing batches', () => {
  test('one bad edit in a batch means none are applied', async () => {
    const before = fs.readFileSync(p('a.txt'), 'utf8');
    const e = await ctx.err('safe_edit', {
      path: p('a.txt'),
      edits: [{ old: 'alpha', new: 'GOOD' }, { old: 'NOT THERE', new: 'bad' }],
    });
    assert.ok(e);
    assert.match(e.error, /No changes were made/);
    assert.equal(fs.readFileSync(p('a.txt'), 'utf8'), before, 'the good edit must not land either');
  });

  test('a batch reports every problem at once, not just the first', async () => {
    const e = await ctx.err('safe_edit', {
      path: p('a.txt'),
      edits: [{ old: 'MISSING ONE', new: 'x' }, { old: 'MISSING TWO', new: 'y' }],
    });
    assert.equal(e.problems.length, 2, 'both failures should be reported in one round trip');
    assert.match(e.problems[0], /MISSING ONE/);
    assert.match(e.problems[1], /MISSING TWO/);
  });

  test('several valid edits apply together', async () => {
    const out = await ctx.call('safe_edit', {
      path: p('a.txt'),
      edits: [{ old: 'alpha', new: 'A' }, { old: 'gamma', new: 'C' }],
    });
    assert.equal(out.edits_applied, 2);
    assert.equal(fs.readFileSync(p('a.txt'), 'utf8'), 'A\nbeta\nC\n');
  });

  test('overlapping edits are refused, because the result would depend on order', async () => {
    fs.writeFileSync(p('ov.txt'), 'abcdef\n');
    const e = await ctx.err('safe_edit', {
      path: p('ov.txt'),
      edits: [{ old: 'abcd', new: '1' }, { old: 'cdef', new: '2' }],
    });
    assert.ok(e);
    assert.match(e.error, /overlap/);
    assert.equal(fs.readFileSync(p('ov.txt'), 'utf8'), 'abcdef\n');
  });
});

describe('literal matching', () => {
  test('regex metacharacters in "old" are literal', async () => {
    fs.writeFileSync(p('re.txt'), 'a.c\nabc\n');
    const out = await ctx.call('safe_edit', { path: p('re.txt'), edits: [{ old: 'a.c', new: 'DOT' }] });
    assert.equal(out.replacements, 1);
    assert.equal(fs.readFileSync(p('re.txt'), 'utf8'), 'DOT\nabc\n', '"a.c" must not match "abc"');
  });

  test('substitution patterns in "new" are literal', async () => {
    const out = await ctx.call('safe_edit', { path: p('a.txt'), edits: [{ old: 'beta', new: '$& and $1' }] });
    assert.equal(out.replacements, 1);
    assert.equal(fs.readFileSync(p('a.txt'), 'utf8'), 'alpha\n$& and $1\ngamma\n');
  });

  test('an empty "old" is rejected', async () => {
    const e = await ctx.err('safe_edit', { path: p('a.txt'), edits: [{ old: '', new: 'X' }] });
    assert.ok(e);
    assert.match(e.error, /non-empty/);
  });

  test('an empty "new" deletes the text', async () => {
    await ctx.call('safe_edit', { path: p('a.txt'), edits: [{ old: 'beta\n', new: '' }] });
    assert.equal(fs.readFileSync(p('a.txt'), 'utf8'), 'alpha\ngamma\n');
  });
});

describe('diagnosing a miss', () => {
  test('trailing whitespace is named as the cause', async () => {
    fs.writeFileSync(p('ws.txt'), 'const x = 1;   \nconst y = 2;\n');
    const e = await ctx.err('safe_edit', { path: p('ws.txt'), edits: [{ old: 'const x = 1;\n', new: 'const x = 9;\n' }] });
    assert.match(e.error, /trailing whitespace/);
  });

  test('a CRLF/LF mismatch is named', async () => {
    fs.writeFileSync(p('crlf.txt'), 'one\r\ntwo\r\n');
    const e = await ctx.err('safe_edit', { path: p('crlf.txt'), edits: [{ old: 'one\ntwo', new: 'X' }] });
    assert.match(e.error, /CRLF/);
  });

  test('an indentation mismatch is named', async () => {
    fs.writeFileSync(p('ind.txt'), '\tif (x) {\n\t\treturn 1;\n\t}\n');
    const e = await ctx.err('safe_edit', { path: p('ind.txt'), edits: [{ old: '    if (x) {\n        return 1;\n    }', new: 'X' }] });
    assert.match(e.error, /indentation|tabs versus spaces/);
  });

  test('it says when only the first line of a block matched', async () => {
    fs.writeFileSync(p('blk.txt'), 'function go() {\n  return 42;\n}\n');
    const e = await ctx.err('safe_edit', { path: p('blk.txt'), edits: [{ old: 'function go() {\n  return 43;\n}', new: 'X' }] });
    assert.match(e.error, /first line/);
  });
});

describe('dry run', () => {
  test('preview shows the diff and writes nothing', async () => {
    const before = fs.readFileSync(p('a.txt'), 'utf8');
    const out = await ctx.call('safe_preview', { path: p('a.txt'), edits: [{ old: 'beta', new: 'BETA' }] });
    assert.equal(out.dry_run, true);
    assert.match(out.diff, /-2: beta/);
    assert.match(out.diff, /\+2: BETA/);
    assert.equal(fs.readFileSync(p('a.txt'), 'utf8'), before);
  });

  test('preview predicts the sha the real edit produces', async () => {
    const pre = await ctx.call('safe_preview', { path: p('a.txt'), edits: [{ old: 'beta', new: 'BETA' }] });
    const real = await ctx.call('safe_edit', { path: p('a.txt'), edits: [{ old: 'beta', new: 'BETA' }] });
    assert.equal(pre.sha256_after, real.sha256_after);
  });

  test('preview fails on the same input a real edit would fail on', async () => {
    const e = await ctx.err('safe_preview', { path: p('a.txt'), edits: [{ old: 'NOT THERE', new: 'x' }] });
    assert.ok(e, 'a preview must not report success where the edit would fail');
  });
});

describe('safe_write', () => {
  test('creates a new file freely', async () => {
    const out = await ctx.call('safe_write', { path: p('new.txt'), content: 'fresh\n' });
    assert.equal(out.created, true);
    assert.equal(fs.readFileSync(p('new.txt'), 'utf8'), 'fresh\n');
  });

  test('refuses to overwrite an existing file without a hash', async () => {
    const e = await ctx.err('safe_write', { path: p('a.txt'), content: 'clobbered\n' });
    assert.ok(e);
    assert.match(e.error, /Refusing to overwrite/);
    assert.match(fs.readFileSync(p('a.txt'), 'utf8'), /alpha/);
  });

  test('create_only refuses when the file exists', async () => {
    const e = await ctx.err('safe_write', { path: p('a.txt'), content: 'x', create_only: true });
    assert.match(e.error, /already exists/);
  });

  test('overwrites when given the current hash', async () => {
    const r = await ctx.call('safe_read', { path: p('a.txt') });
    await ctx.call('safe_write', { path: p('a.txt'), content: 'replaced\n', expect_sha256: r.sha256 });
    assert.equal(fs.readFileSync(p('a.txt'), 'utf8'), 'replaced\n');
  });

  test('"*" is an explicit opt-in to overwrite blindly', async () => {
    await ctx.call('safe_write', { path: p('a.txt'), content: 'deliberate\n', expect_sha256: '*' });
    assert.equal(fs.readFileSync(p('a.txt'), 'utf8'), 'deliberate\n');
  });
});

describe('line-addressed edits', () => {
  test('replaces a range when the expected text is there', async () => {
    await ctx.call('safe_replace_lines', { path: p('a.txt'), start_line: 2, end_line: 2, expect_text: 'beta', new_text: 'BETA' });
    assert.equal(fs.readFileSync(p('a.txt'), 'utf8'), 'alpha\nBETA\ngamma\n');
  });

  test('refuses when the file has shifted under the line numbers', async () => {
    const e = await ctx.err('safe_replace_lines', { path: p('a.txt'), start_line: 2, end_line: 2, expect_text: 'NOT BETA', new_text: 'X' });
    assert.ok(e);
    assert.match(e.error, /shifted/);
    assert.match(fs.readFileSync(p('a.txt'), 'utf8'), /beta/);
  });

  test('refuses a range past the end of the file', async () => {
    const e = await ctx.err('safe_replace_lines', { path: p('a.txt'), start_line: 2, end_line: 99, new_text: 'X' });
    assert.match(e.error, /past the end/);
  });
});

describe('backups', () => {
  test('every edit takes a backup first, and it can be restored', async () => {
    const original = fs.readFileSync(p('a.txt'), 'utf8');
    const out = await ctx.call('safe_edit', { path: p('a.txt'), edits: [{ old: 'beta', new: 'BETA' }] });
    assert.ok(out.backup_id);
    const list = await ctx.call('safe_list_backups', { path: p('a.txt') });
    assert.ok(list.backups.some((b) => b.id === out.backup_id));
    await ctx.call('safe_restore', { path: p('a.txt'), backup_id: out.backup_id });
    assert.equal(fs.readFileSync(p('a.txt'), 'utf8'), original);
  });

  test('a restore is itself reversible', async () => {
    const e1 = await ctx.call('safe_edit', { path: p('a.txt'), edits: [{ old: 'beta', new: 'BETA' }] });
    const r = await ctx.call('safe_restore', { path: p('a.txt'), backup_id: e1.backup_id });
    assert.ok(r.safety_backup_id, 'restoring must snapshot what it is about to replace');
    await ctx.call('safe_restore', { path: p('a.txt'), backup_id: r.safety_backup_id });
    assert.equal(fs.readFileSync(p('a.txt'), 'utf8'), 'alpha\nBETA\ngamma\n');
  });

  test('a failed edit takes no backup, because nothing changed', async () => {
    const before = (await ctx.call('safe_list_backups', { path: p('a.txt') })).backups.length;
    await ctx.err('safe_edit', { path: p('a.txt'), edits: [{ old: 'NOT THERE', new: 'x' }] });
    const after = (await ctx.call('safe_list_backups', { path: p('a.txt') })).backups.length;
    assert.equal(after, before);
  });
});

describe('containment', () => {
  test('reading outside the allowed root is denied', async () => {
    const e = await ctx.err('safe_read', { path: path.join(ctx.outside, 'secret.txt') });
    assert.match(e.error, /Access denied/);
  });

  test('writing outside the allowed root is denied', async () => {
    const target = path.join(ctx.outside, 'planted.txt');
    const e = await ctx.err('safe_write', { path: target, content: 'nope' });
    assert.match(e.error, /Access denied/);
    assert.equal(fs.existsSync(target), false);
  });

  test('a ../ traversal is denied', async () => {
    const e = await ctx.err('safe_read', { path: p('..', 'outside', 'secret.txt') });
    assert.match(e.error, /Access denied/);
  });

  test('a symlink pointing outside the root is denied', async () => {
    fs.symlinkSync(path.join(ctx.outside, 'secret.txt'), p('link.txt'));
    const e = await ctx.err('safe_read', { path: p('link.txt') });
    assert.match(e.error, /Access denied/);
  });

  test('a DANGLING symlink pointing outside is denied for writes', async () => {
    const target = path.join(ctx.outside, 'not-yet.txt');
    fs.symlinkSync(target, p('dangling.txt'));
    const e = await ctx.err('safe_write', { path: p('dangling.txt'), content: 'nope' });
    assert.match(e.error, /Access denied/);
    assert.equal(fs.existsSync(target), false);
  });

  test('a symlink that stays inside the root works', async () => {
    fs.symlinkSync(p('a.txt'), p('inside-link.txt'));
    assert.match((await ctx.call('safe_read', { path: p('inside-link.txt') })).content, /alpha/);
  });

  test('a sibling directory sharing the root prefix is denied', async () => {
    const evil = ctx.root + '-evil';
    fs.mkdirSync(evil, { recursive: true });
    fs.writeFileSync(path.join(evil, 'x.txt'), 'nope');
    const e = await ctx.err('safe_read', { path: path.join(evil, 'x.txt') });
    fs.rmSync(evil, { recursive: true, force: true });
    assert.match(e.error, /Access denied/);
  });
});

describe('atomicity', () => {
  test('no temp files are left behind after a successful edit', async () => {
    await ctx.call('safe_edit', { path: p('a.txt'), edits: [{ old: 'beta', new: 'BETA' }] });
    assert.deepEqual(fs.readdirSync(ctx.root).filter((f) => f.includes('safe-edit') && f.endsWith('.tmp')), []);
  });

  test('file permissions survive an edit', async () => {
    fs.chmodSync(p('a.txt'), 0o600);
    await ctx.call('safe_edit', { path: p('a.txt'), edits: [{ old: 'beta', new: 'BETA' }] });
    assert.equal(fs.statSync(p('a.txt')).mode & 0o777, 0o600);
  });
});

describe('tool surface', () => {
  test('advertises the nine tools', async () => {
    const { tools } = await ctx.client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      'safe_allowed_roots', 'safe_edit', 'safe_list_backups', 'safe_preview',
      'safe_read', 'safe_replace_lines', 'safe_restore', 'safe_verify', 'safe_write',
    ]);
  });

  test('an unknown tool is an error, not a crash', async () => {
    const e = await ctx.err('safe_nope');
    assert.match(e.error, /unknown tool/);
  });

  test('safe_allowed_roots reports the sandbox', async () => {
    assert.deepEqual((await ctx.call('safe_allowed_roots')).roots, [ctx.root]);
  });
});
