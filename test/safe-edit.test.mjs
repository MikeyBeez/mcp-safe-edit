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
  test('advertises the eighteen tools', async () => {
    const { tools } = await ctx.client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      'safe_allowed_roots', 'safe_analyzers', 'safe_baseline', 'safe_edit', 'safe_edit_function',
      'safe_function_report', 'safe_functions', 'safe_inventory',
      'safe_list_backups', 'safe_preview', 'safe_read', 'safe_rebuild_function',
      'safe_replace_lines', 'safe_restore', 'safe_spec_check',
      'safe_spec_generate', 'safe_verify', 'safe_write',
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

describe('structural inventory', () => {
  test('lists what a JavaScript file provides', async () => {
    fs.writeFileSync(p('mod.js'), 'import fs from "node:fs";\nexport function alpha(){ return 1; }\nexport const beta = 2;\nclass Thing { go(){} }\n');
    const inv = await ctx.call('safe_inventory', { path: p('mod.js') });
    assert.equal(inv.understood, true);
    assert.equal(inv.language, 'javascript');
    assert.ok(inv.symbols.includes('export.function:alpha'));
    assert.ok(inv.symbols.includes('export.const:beta'));
    assert.ok(inv.symbols.includes('class:Thing'));
    assert.ok(inv.symbols.includes('method:Thing.go'));
    assert.deepEqual(inv.imports, ['node:fs']);
  });

  test('lists what a Python file provides', async () => {
    fs.writeFileSync(p('m.py'), 'import os\n\ndef work(x):\n    return x\n\nclass Runner:\n    def start(self):\n        pass\n');
    const inv = await ctx.call('safe_inventory', { path: p('m.py') });
    assert.equal(inv.language, 'python');
    assert.ok(inv.symbols.includes('function:work'));
    assert.ok(inv.symbols.includes('class:Runner'));
    assert.ok(inv.symbols.includes('method:Runner.start'));
  });

  test('lists JSON key paths', async () => {
    fs.writeFileSync(p('c.json'), '{"mcpServers":{"brain":{"command":"node"}}}');
    const inv = await ctx.call('safe_inventory', { path: p('c.json') });
    assert.ok(inv.symbols.includes('key:mcpServers'));
    assert.ok(inv.symbols.includes('key:mcpServers.brain.command'));
  });

  test('admits when it cannot analyse a file type', async () => {
    fs.writeFileSync(p('main.rs'), 'fn main() { println!("hi"); }\n');
    const inv = await ctx.call('safe_inventory', { path: p('main.rs') });
    assert.equal(inv.understood, false);
    assert.match(inv.reason, /no structural analyzer/);
  });

  test('safe_analyzers says which types are covered', async () => {
    const a = await ctx.call('safe_analyzers');
    for (const ext of ['.js', '.py', '.json', '.md', '.ts']) {
      assert.ok(a.supported.some((x) => x.ext === ext), `${ext} should be covered`);
    }
  });
});

describe('the structural gate', () => {
  beforeEach(() => {
    fs.writeFileSync(p('mod.js'),
      'export function alpha(){ return 1; }\nexport function beta(){ return 2; }\nexport const GAMMA = 3;\n');
  });

  test('an edit that keeps everything is allowed and reports the check', async () => {
    const out = await ctx.call('safe_edit', { path: p('mod.js'), edits: [{ old: 'return 1;', new: 'return 11;' }] });
    assert.equal(out.structure.checked, true);
    assert.deepEqual(out.structure.removed, []);
    assert.equal(out.structure.language, 'javascript');
  });

  test('an edit that deletes a function is REFUSED and nothing is written', async () => {
    const before = fs.readFileSync(p('mod.js'), 'utf8');
    const e = await ctx.err('safe_edit', {
      path: p('mod.js'),
      edits: [{ old: 'export function beta(){ return 2; }\n', new: '' }],
    });
    assert.ok(e, 'removing an exported function must be refused by default');
    assert.match(e.error, /would remove/);
    assert.match(e.error, /beta/);
    assert.equal(fs.readFileSync(p('mod.js'), 'utf8'), before, 'the file must be untouched');
  });

  test('a declared removal is allowed', async () => {
    await ctx.call('safe_edit', {
      path: p('mod.js'),
      edits: [{ old: 'export function beta(){ return 2; }\n', new: '' }],
      allow_removals: ['export.function:beta'],
    });
    assert.doesNotMatch(fs.readFileSync(p('mod.js'), 'utf8'), /beta/);
  });

  test('a bare name works as a declaration too', async () => {
    await ctx.call('safe_edit', {
      path: p('mod.js'),
      edits: [{ old: 'export function beta(){ return 2; }\n', new: '' }],
      allow_removals: ['beta'],
    });
    assert.doesNotMatch(fs.readFileSync(p('mod.js'), 'utf8'), /beta/);
  });

  test('an edit that breaks the syntax is REFUSED', async () => {
    const before = fs.readFileSync(p('mod.js'), 'utf8');
    const e = await ctx.err('safe_edit', {
      path: p('mod.js'),
      edits: [{ old: 'export function alpha(){ return 1; }', new: 'export function alpha({ return 1;' }],
    });
    assert.ok(e);
    assert.match(e.error, /unparseable/);
    assert.equal(fs.readFileSync(p('mod.js'), 'utf8'), before);
  });

  test('a broken JSON edit is REFUSED', async () => {
    fs.writeFileSync(p('cfg.json'), '{"a":1,"b":2}');
    const e = await ctx.err('safe_edit', { path: p('cfg.json'), edits: [{ old: '"b":2', new: '"b":' }] });
    assert.ok(e);
    assert.match(e.error, /unparseable/);
    assert.equal(fs.readFileSync(p('cfg.json'), 'utf8'), '{"a":1,"b":2}');
  });

  test('removing a JSON key is REFUSED', async () => {
    fs.writeFileSync(p('cfg.json'), '{"a":1,"b":2}');
    const e = await ctx.err('safe_edit', { path: p('cfg.json'), edits: [{ old: ',"b":2', new: '' }] });
    assert.match(e.error, /key:b/);
  });

  test('a Python edit that removes a method is REFUSED', async () => {
    fs.writeFileSync(p('m.py'), 'class R:\n    def start(self):\n        pass\n\n    def stop(self):\n        pass\n');
    const e = await ctx.err('safe_edit', { path: p('m.py'), edits: [{ old: '\n    def stop(self):\n        pass\n', new: '' }] });
    assert.ok(e);
    assert.match(e.error, /method:R\.stop/);
  });

  test('additions are reported but never blocked', async () => {
    const out = await ctx.call('safe_edit', {
      path: p('mod.js'),
      edits: [{ old: 'export const GAMMA = 3;', new: 'export const GAMMA = 3;\nexport function delta(){ return 4; }' }],
    });
    assert.ok(out.structure.added.includes('export.function:delta'));
    assert.deepEqual(out.structure.removed, []);
  });

  test('an unanalysable file type is edited but flagged as unguaranteed', async () => {
    fs.writeFileSync(p('thing.rs'), 'fn add(a: i32) -> i32 { a + 1 }\n');
    const out = await ctx.call('safe_edit', { path: p('thing.rs'), edits: [{ old: 'a + 1', new: 'a + 2' }] });
    assert.equal(out.structure.checked, false);
    assert.match(out.structure.warning, /NO STRUCTURAL GUARANTEE/);
    assert.equal(fs.readFileSync(p('thing.rs'), 'utf8'), 'fn add(a: i32) -> i32 { a + 2 }\n');
  });

  test('check_structure:false switches the gate off and says so', async () => {
    const out = await ctx.call('safe_edit', {
      path: p('mod.js'),
      edits: [{ old: 'export function beta(){ return 2; }\n', new: '' }],
      check_structure: false,
    });
    assert.equal(out.structure.checked, false);
    assert.match(out.structure.warning, /switched off/);
  });

  test('preview runs the gate too, so a refusal is visible before writing', async () => {
    const e = await ctx.err('safe_preview', {
      path: p('mod.js'),
      edits: [{ old: 'export function beta(){ return 2; }\n', new: '' }],
    });
    assert.ok(e, 'preview must fail wherever the real edit would fail');
    assert.match(e.error, /would remove/);
  });

  test('an unbalanced markdown fence is reported', async () => {
    fs.writeFileSync(p('doc.md'), '# Title\n\n```js\ncode\n```\n\ntext\n');
    const out = await ctx.call('safe_edit', { path: p('doc.md'), edits: [{ old: '```\n\ntext', new: '\n\ntext' }] });
    assert.ok(out.structure.notes.some((n) => /unbalanced code fences/.test(n)));
  });
});

describe('the behavioural gate', () => {
  beforeEach(() => {
    fs.writeFileSync(p('lib.js'), 'export function add(a, b){ return a + b; }\n');
    fs.writeFileSync(p('check.mjs'),
      'import { add } from "./lib.js";\nif (add(2, 3) !== 5) { console.error("add is wrong"); process.exit(1); }\nconsole.log("ok");\n');
  });

  test('a passing verify_command lets the edit stand', async () => {
    const out = await ctx.call('safe_edit', {
      path: p('lib.js'),
      edits: [{ old: 'return a + b;', new: 'return b + a;' }],
      verify_command: [process.execPath, p('check.mjs')],
      verify_cwd: ctx.root,
    });
    assert.equal(out.verification.passed, true);
    assert.match(fs.readFileSync(p('lib.js'), 'utf8'), /return b \+ a;/);
  });

  test('a failing verify_command ROLLS THE FILE BACK', async () => {
    const before = fs.readFileSync(p('lib.js'), 'utf8');
    const e = await ctx.err('safe_edit', {
      path: p('lib.js'),
      edits: [{ old: 'return a + b;', new: 'return a * b;' }],   // structurally fine, behaviourally wrong
      verify_command: [process.execPath, p('check.mjs')],
      verify_cwd: ctx.root,
    });
    assert.ok(e, 'a failing verification must not leave the edit in place');
    assert.match(e.error, /ROLLED BACK/);
    assert.equal(fs.readFileSync(p('lib.js'), 'utf8'), before, 'the file must be exactly as it was');
    assert.equal(e.rolled_back, true);
    assert.match(e.verification.output, /add is wrong/);
  });

  test('the rollback still leaves a backup of the attempt', async () => {
    const e = await ctx.err('safe_edit', {
      path: p('lib.js'),
      edits: [{ old: 'return a + b;', new: 'return a * b;' }],
      verify_command: [process.execPath, p('check.mjs')],
      verify_cwd: ctx.root,
    });
    assert.ok(e.backup_id, 'the pre-edit content is still recoverable');
  });

  test('verify_command must be an argv array, never a shell string', async () => {
    const e = await ctx.err('safe_edit', {
      path: p('lib.js'),
      edits: [{ old: 'return a + b;', new: 'return b + a;' }],
      verify_command: 'npm test; rm -rf /',
    });
    assert.ok(e);
    assert.match(e.error, /array of strings/);
  });

  test('verify_cwd outside the allowed roots is denied', async () => {
    const e = await ctx.err('safe_edit', {
      path: p('lib.js'),
      edits: [{ old: 'return a + b;', new: 'return b + a;' }],
      verify_command: [process.execPath, '-e', 'process.exit(0)'],
      verify_cwd: ctx.outside,
    });
    assert.match(e.error, /Access denied/);
  });
});

describe('verifying the verifier', () => {
  beforeEach(() => {
    fs.writeFileSync(p('lib.js'), 'export function add(a, b){ return a + b; }\n');
  });

  test('a real test catches every deliberate breakage, so its pass is informative', async () => {
    fs.writeFileSync(p('good.mjs'),
      'import { add } from "./lib.js";\n' +
      'if (add(2, 3) !== 5) { console.error("wrong"); process.exit(1); }\n' +
      'if (add(0, 0) !== 0) { console.error("wrong"); process.exit(1); }\n');
    const out = await ctx.call('safe_edit', {
      path: p('lib.js'),
      edits: [{ old: 'return a + b;', new: 'return b + a;' }],
      verify_command: [process.execPath, p('good.mjs')],
      verify_cwd: ctx.root,
    });
    assert.equal(out.verification.passed, true);
    assert.equal(out.verification_trust.trustworthy, true);
    assert.equal(out.verification_trust.survived.length, 0);
    assert.ok(out.verification_trust.probes_run >= 2);
  });

  test('a test that never touches the file is exposed as proving nothing', async () => {
    fs.writeFileSync(p('blind.mjs'), 'console.log("I never import the file under edit");\n');
    const out = await ctx.call('safe_edit', {
      path: p('lib.js'),
      edits: [{ old: 'return a + b;', new: 'return b + a;' }],
      verify_command: [process.execPath, p('blind.mjs')],
      verify_cwd: ctx.root,
    });
    assert.equal(out.verification.passed, true, 'the command itself passes');
    assert.equal(out.verification_trust.trustworthy, false);
    assert.equal(out.verification_trust.confidence, 'none');
    assert.match(out.verification_trust.verdict, /replaced with garbage|does not exercise this file/);
  });

  test('THE MOTIVATING BUG: an assertion that cannot tell + from * is caught', async () => {
    // add(2,2) === 4 is true for both addition and multiplication. The file IS
    // loaded, so destruction is caught, and the '-' mutant is caught too
    // (2-2 is 0). Only the '*' mutant slips through — which is precisely the
    // blindness that let the original bug ship. max_probes is raised so both
    // arithmetic mutants get a run.
    fs.writeFileSync(p('weak.mjs'),
      'import { add } from "./lib.js";\n' +
      'if (add(2, 2) !== 4) { console.error("wrong"); process.exit(1); }\n');
    const out = await ctx.call('safe_edit', {
      path: p('lib.js'),
      edits: [{ old: 'return a + b;', new: 'return b + a;' }],
      verify_command: [process.execPath, p('weak.mjs')],
      verify_cwd: ctx.root,
      max_probes: 6,
    });
    assert.equal(out.verification.passed, true);
    assert.equal(out.verification_trust.trustworthy, false);
    assert.equal(out.verification_trust.confidence, 'partial');
    const arith = out.verification_trust.survived.find((s) => s.rule === 'arithmetic' && /\*/.test(s.after));
    assert.ok(arith, 'the + to * mutant must survive a test that only checks add(2,2)');
    assert.match(out.verification_trust.verdict, /MISSED/);
  });

  test('the file is left exactly as the edit intended after probing', async () => {
    fs.writeFileSync(p('weak.mjs'), 'import { add } from "./lib.js";\nif (add(2,2) !== 4) process.exit(1);\n');
    const out = await ctx.call('safe_edit', {
      path: p('lib.js'),
      edits: [{ old: 'return a + b;', new: 'return b + a;' }],
      verify_command: [process.execPath, p('weak.mjs')],
      verify_cwd: ctx.root,
    });
    assert.equal(fs.readFileSync(p('lib.js'), 'utf8'), 'export function add(a, b){ return b + a; }\n',
      'probing must not leave a mutant behind');
    const check = await ctx.call('safe_verify', { path: p('lib.js'), expect_sha256: out.sha256_after });
    assert.equal(check.matches, true, 'the reported hash must match what is on disk after probing');
  });

  test('require_trustworthy_verification rolls back an uninformative pass', async () => {
    const before = fs.readFileSync(p('lib.js'), 'utf8');
    fs.writeFileSync(p('blind.mjs'), 'console.log("nothing to see");\n');
    const e = await ctx.err('safe_edit', {
      path: p('lib.js'),
      edits: [{ old: 'return a + b;', new: 'return b + a;' }],
      verify_command: [process.execPath, p('blind.mjs')],
      verify_cwd: ctx.root,
      require_trustworthy_verification: true,
    });
    assert.ok(e);
    assert.match(e.error, /ROLLED BACK/);
    assert.match(e.error, /proves nothing/);
    assert.equal(fs.readFileSync(p('lib.js'), 'utf8'), before);
  });

  test('probing can be switched off, and the result says so by its absence', async () => {
    fs.writeFileSync(p('good.mjs'), 'import { add } from "./lib.js";\nif (add(2,3) !== 5) process.exit(1);\n');
    const out = await ctx.call('safe_edit', {
      path: p('lib.js'),
      edits: [{ old: 'return a + b;', new: 'return b + a;' }],
      verify_command: [process.execPath, p('good.mjs')],
      verify_cwd: ctx.root,
      verify_the_verifier: false,
    });
    assert.equal(out.verification.passed, true);
    assert.equal(out.verification_trust, undefined);
  });

  test('each probe is reported with the exact line it changed', async () => {
    fs.writeFileSync(p('good.mjs'), 'import { add } from "./lib.js";\nif (add(2,3) !== 5) process.exit(1);\n');
    const out = await ctx.call('safe_edit', {
      path: p('lib.js'),
      edits: [{ old: 'return a + b;', new: 'return b + a;' }],
      verify_command: [process.execPath, p('good.mjs')],
      verify_cwd: ctx.root,
    });
    const mutant = out.verification_trust.probes.find((x) => x.rule !== 'destruction');
    assert.ok(mutant.before && mutant.after && mutant.before !== mutant.after);
    assert.equal(typeof mutant.line, 'number');
  });
});

describe('the function tree', () => {
  beforeEach(() => {
    fs.writeFileSync(p('tree.js'),
      'export function outer(a) {\n' +
      '  const helper = (x) => x * 2;\n' +
      '  function inner(y) {\n' +
      '    return helper(y);\n' +
      '  }\n' +
      '  return inner(a);\n' +
      '}\n' +
      'class Thing {\n' +
      '  go() { return 1; }\n' +
      '}\n');
  });

  test('finds functions nested inside other functions', async () => {
    const t = await ctx.call('safe_functions', { path: p('tree.js') });
    const names = t.functions.map((f) => f.name);
    assert.ok(names.includes('outer'));
    assert.ok(names.includes('outer.inner'), 'a function inside a function must be found');
    assert.ok(names.includes('outer.helper'), 'an arrow bound to a const inside a function must be found');
    assert.ok(names.includes('Thing.go'));
  });

  test('each function carries its line range, depth and parent', async () => {
    const t = await ctx.call('safe_functions', { path: p('tree.js') });
    const inner = t.functions.find((f) => f.name === 'outer.inner');
    assert.equal(inner.start_line, 3);
    assert.equal(inner.end_line, 5);
    assert.equal(inner.depth, 1);
    assert.equal(inner.parent, 'outer');
  });

  test('deleting a NESTED function is refused, which an exports check would miss', async () => {
    const before = fs.readFileSync(p('tree.js'), 'utf8');
    const e = await ctx.err('safe_edit', {
      path: p('tree.js'),
      edits: [{ old: '  function inner(y) {\n    return helper(y);\n  }\n', new: '' }],
    });
    assert.ok(e, 'a nested function vanishing must be refused');
    assert.match(e.error, /outer\.inner/);
    assert.equal(fs.readFileSync(p('tree.js'), 'utf8'), before);
  });

  test('finds Python functions nested inside methods', async () => {
    fs.writeFileSync(p('n.py'), 'class R:\n    def go(self):\n        def helper(x):\n            return x\n        return helper(1)\n');
    const t = await ctx.call('safe_functions', { path: p('n.py') });
    assert.ok(t.functions.map((f) => f.name).includes('R.go.helper'));
  });
});

describe('editing by function name', () => {
  beforeEach(() => {
    fs.writeFileSync(p('fn.js'),
      'export function alpha(a) {\n  return a + 1;\n}\n\nexport function beta(b) {\n  return b + 2;\n}\n');
  });

  test('replaces a whole function by name', async () => {
    const out = await ctx.call('safe_edit_function', {
      path: p('fn.js'), function_name: 'beta',
      new_source: 'export function beta(b) {\n  return b + 200;\n}',
    });
    assert.equal(out.verified, true);
    assert.match(fs.readFileSync(p('fn.js'), 'utf8'), /return b \+ 200;/);
    assert.match(fs.readFileSync(p('fn.js'), 'utf8'), /return a \+ 1;/, 'the other function must be untouched');
  });

  test('an unknown name lists what the file does define', async () => {
    const e = await ctx.err('safe_edit_function', { path: p('fn.js'), function_name: 'gamma', new_source: 'x' });
    assert.match(e.error, /No function called "gamma"/);
    assert.ok(e.available.includes('alpha'));
    assert.ok(e.available.includes('beta'));
  });

  test('replacing a function with one of a different name is refused', async () => {
    const e = await ctx.err('safe_edit_function', {
      path: p('fn.js'), function_name: 'beta',
      new_source: 'export function renamed(b) {\n  return b + 2;\n}',
    });
    assert.ok(e, 'a rename via replacement silently drops the old name, so it must be declared');
    assert.match(e.error, /beta/);
  });

  test('a rename is allowed when declared', async () => {
    await ctx.call('safe_edit_function', {
      path: p('fn.js'), function_name: 'beta',
      new_source: 'export function renamed(b) {\n  return b + 2;\n}',
      allow_removals: ['beta'],
    });
    assert.match(fs.readFileSync(p('fn.js'), 'utf8'), /function renamed/);
  });

  test('replacement source that does not parse is refused', async () => {
    const before = fs.readFileSync(p('fn.js'), 'utf8');
    const e = await ctx.err('safe_edit_function', {
      path: p('fn.js'), function_name: 'beta', new_source: 'export function beta(b) { return b + ;',
    });
    assert.ok(e);
    assert.equal(fs.readFileSync(p('fn.js'), 'utf8'), before);
  });

  test('a file type with no parser says so rather than guessing', async () => {
    fs.writeFileSync(p('x.rs'), 'fn f(a: i32) -> i32 { a }\n');
    const e = await ctx.err('safe_edit_function', { path: p('x.rs'), function_name: 'f', new_source: 'x' });
    assert.match(e.error, /Cannot address by function/);
  });
});

describe('the per-function verification map', () => {
  beforeEach(() => {
    fs.writeFileSync(p('two.js'),
      'export function watched(a, b) {\n  return a + b;\n}\n\nexport function ignored(a, b) {\n  return a - b;\n}\n');
    // A suite that exercises only one of the two functions.
    fs.writeFileSync(p('half.mjs'),
      'import { watched } from "./two.js";\n' +
      'if (watched(2, 3) !== 5) { console.error("watched is wrong"); process.exit(1); }\n');
  });

  test('separates the functions a suite watches from the ones it does not', async () => {
    const r = await ctx.call('safe_function_report', {
      path: p('two.js'),
      verify_command: [process.execPath, p('half.mjs')],
      verify_cwd: ctx.root,
    });
    assert.equal(r.checkable, true);
    const byName = Object.fromEntries(r.functions.map((f) => [f.name, f.status]));
    assert.equal(byName.watched, 'watched');
    assert.equal(byName.ignored, 'UNWATCHED');
    assert.ok(r.summary.unwatched_names.includes('ignored'));
    assert.match(r.summary.verdict, /UNWATCHED/);
  });

  test('says plainly when the suite does not exercise the file at all', async () => {
    fs.writeFileSync(p('blind.mjs'), 'console.log("unrelated");\n');
    const r = await ctx.call('safe_function_report', {
      path: p('two.js'),
      verify_command: [process.execPath, p('blind.mjs')],
      verify_cwd: ctx.root,
    });
    assert.equal(r.checkable, false);
    assert.match(r.reason, /replaced with garbage|does not exercise this file/);
  });

  test('the file is byte-identical after the whole report runs', async () => {
    const before = fs.readFileSync(p('two.js'), 'utf8');
    await ctx.call('safe_function_report', {
      path: p('two.js'),
      verify_command: [process.execPath, p('half.mjs')],
      verify_cwd: ctx.root,
    });
    assert.equal(fs.readFileSync(p('two.js'), 'utf8'), before, 'probing must leave no trace');
  });

  test('the run budget is respected and what was skipped is named', async () => {
    const r = await ctx.call('safe_function_report', {
      path: p('two.js'),
      verify_command: [process.execPath, p('half.mjs')],
      verify_cwd: ctx.root,
      max_functions: 1,
    });
    assert.equal(r.functions.length, 1);
    assert.equal(r.skipped.length, 1, 'a silently truncated report would be the same lie in a new costume');
  });
});

describe('the specification', () => {
  const SUITE_STRONG =
    'import { add, mul } from "./calc.js";\n' +
    'if (add(2, 3) !== 5) { console.error("add wrong"); process.exit(1); }\n' +
    'if (mul(3, 4) !== 12) { console.error("mul wrong"); process.exit(1); }\n';

  beforeEach(() => {
    fs.writeFileSync(p('calc.js'),
      'export function add(a, b) {\n  return a + b;\n}\n\nexport function mul(a, b) {\n  return a * b;\n}\n');
    fs.writeFileSync(p('suite.mjs'), SUITE_STRONG);
  });

  const gen = () => ctx.call('safe_spec_generate', {
    path: p('calc.js'), verify_command: [process.execPath, p('suite.mjs')], verify_cwd: ctx.root,
  });
  const check = (extra = {}) => ctx.call('safe_spec_check', { path: p('calc.js'), verify_cwd: ctx.root, ...extra });

  test('records both what must pass and what must fail', async () => {
    const g = await gen();
    const spec = JSON.parse(fs.readFileSync(p('calc.js.spec.json'), 'utf8'));
    assert.equal(spec.functions.add.required, true);
    assert.equal(spec.functions.add.watched, true);
    assert.ok(spec.functions.add.must_fail.length > 0, 'a falsification must be recorded');
    assert.ok(g.summary.falsifications_recorded > 0);
  });

  test('an unchanged file meets its spec', async () => {
    await gen();
    const r = await check();
    assert.equal(r.passed, true, JSON.stringify(r.violations));
    assert.match(r.verdict, /Meets the spec/);
  });

  test('a removed function is a violation', async () => {
    await gen();
    fs.writeFileSync(p('calc.js'), 'export function add(a, b) {\n  return a + b;\n}\n');
    const r = await check({ probe: false });
    assert.equal(r.passed, false);
    assert.ok(r.violations.some((v) => v.kind === 'function_missing' && v.function === 'mul'));
  });

  test('THE EROSION CHECK: weakening a test is caught even though everything is green', async () => {
    await gen();
    // The code is untouched and the suite still passes — it just stopped
    // checking mul. Every other gate in this server reports success here.
    fs.writeFileSync(p('suite.mjs'),
      'import { add, mul } from "./calc.js";\n' +
      'if (add(2, 3) !== 5) { console.error("add wrong"); process.exit(1); }\n' +
      'if (typeof mul !== "function") { process.exit(1); }\n');
    const stillGreen = await ctx.call('safe_edit', {
      path: p('calc.js'), edits: [{ old: 'return a + b;', new: 'return b + a;' }],
      verify_command: [process.execPath, p('suite.mjs')], verify_cwd: ctx.root,
      verify_the_verifier: false,
    });
    assert.equal(stillGreen.verification.passed, true, 'the suite is green, which is the point');

    const r = await check();
    assert.equal(r.passed, false, 'the spec must notice that the tests got weaker');
    const erosion = r.violations.find((v) => v.kind === 'test_erosion');
    assert.ok(erosion, 'test erosion must be reported');
    assert.equal(erosion.function, 'mul');
    assert.match(erosion.detail, /used to fail the verification and now passes/);
  });

  test('a broken verification is a violation, and probing stops there', async () => {
    await gen();
    fs.writeFileSync(p('calc.js'), 'export function add(a, b) {\n  return a - b;\n}\n\nexport function mul(a, b) {\n  return a * b;\n}\n');
    const r = await check();
    assert.equal(r.passed, false);
    assert.ok(r.violations.some((v) => v.kind === 'verification_failed'));
  });

  test('checking leaves the file byte-identical', async () => {
    await gen();
    const before = fs.readFileSync(p('calc.js'), 'utf8');
    await check();
    assert.equal(fs.readFileSync(p('calc.js'), 'utf8'), before);
  });

  test('an unwatched function is recorded as a gap rather than quietly omitted', async () => {
    fs.writeFileSync(p('suite.mjs'), 'import { add } from "./calc.js";\nif (add(2,3) !== 5) process.exit(1);\n');
    await gen();
    const spec = JSON.parse(fs.readFileSync(p('calc.js.spec.json'), 'utf8'));
    assert.equal(spec.functions.mul.watched, false);
    assert.match(spec.functions.mul.gap, /nothing in the verification would notice/);
  });
});

describe('piece-by-piece rebuild', () => {
  beforeEach(() => {
    fs.writeFileSync(p('calc.js'),
      'export function add(a, b) {\n  return a + b;\n}\n\nexport function mul(a, b) {\n  return a * b;\n}\n');
    fs.writeFileSync(p('suite.mjs'),
      'import { add, mul } from "./calc.js";\n' +
      'if (add(2, 3) !== 5) { console.error("add wrong"); process.exit(1); }\n' +
      'if (mul(3, 4) !== 12) { console.error("mul wrong"); process.exit(1); }\n');
  });

  const rebuild = (fn, src, extra = {}) => ctx.call('safe_rebuild_function', {
    path: p('calc.js'), function_name: fn, new_source: src,
    verify_command: [process.execPath, p('suite.mjs')], verify_cwd: ctx.root, ...extra,
  });

  test('a rebuilt function that the tests actually check is accepted', async () => {
    const out = await rebuild('add', 'export function add(a, b) {\n  const total = a + b;\n  return total;\n}');
    assert.equal(out.rebuilt.watched, true);
    assert.match(fs.readFileSync(p('calc.js'), 'utf8'), /const total = a \+ b;/);
  });

  test('a rebuild the tests cannot check is ROLLED BACK even though it passes', async () => {
    // Nothing watches mul once its assertion is gone. A rebuild that passes is
    // then merely fitted, not verified.
    fs.writeFileSync(p('suite.mjs'), 'import { add } from "./calc.js";\nif (add(2,3) !== 5) process.exit(1);\n');
    const before = fs.readFileSync(p('calc.js'), 'utf8');
    const e = await ctx.err('safe_rebuild_function', {
      path: p('calc.js'), function_name: 'mul',
      new_source: 'export function mul(a, b) {\n  return a * b * 1;\n}',
      verify_command: [process.execPath, p('suite.mjs')], verify_cwd: ctx.root,
    });
    assert.ok(e, 'an unverifiable rebuild must not stand');
    assert.match(e.error, /ROLLED BACK/);
    assert.match(e.error, /fits the checker|only fits/);
    assert.equal(fs.readFileSync(p('calc.js'), 'utf8'), before);
  });

  test('require_watched:false accepts it and says so', async () => {
    fs.writeFileSync(p('suite.mjs'), 'import { add } from "./calc.js";\nif (add(2,3) !== 5) process.exit(1);\n');
    const out = await rebuild('mul', 'export function mul(a, b) {\n  return a * b * 1;\n}', { require_watched: false });
    assert.equal(out.rebuilt.watched, false);
  });

  test('a rebuild without a verify_command is refused', async () => {
    const e = await ctx.err('safe_rebuild_function', {
      path: p('calc.js'), function_name: 'add', new_source: 'export function add(a,b){ return a+b; }',
    });
    assert.match(e.error, /requires a verify_command/);
  });

  test('a rebuild that breaks the tests is rolled back', async () => {
    const before = fs.readFileSync(p('calc.js'), 'utf8');
    const e = await ctx.err('safe_rebuild_function', {
      path: p('calc.js'), function_name: 'add',
      new_source: 'export function add(a, b) {\n  return a - b;\n}',
      verify_command: [process.execPath, p('suite.mjs')], verify_cwd: ctx.root,
    });
    assert.ok(e);
    assert.equal(fs.readFileSync(p('calc.js'), 'utf8'), before);
  });
});

describe('the trust layer', () => {
  beforeEach(() => {
    fs.writeFileSync(p('calc.js'), 'export function add(a, b) {\n  return a + b;\n}\n');
    fs.writeFileSync(p('suite.mjs'), 'import { add } from "./calc.js";\nif (add(2,3) !== 5) process.exit(1);\n');
  });

  const baseline = (cmd, extra = {}) => ctx.call('safe_baseline', {
    verify_command: cmd, verify_cwd: ctx.root, ...extra,
  });

  test('a green stable suite is usable', async () => {
    const b = await baseline([process.execPath, p('suite.mjs')]);
    assert.equal(b.usable, true);
    assert.equal(b.status, 'green');
    assert.equal(b.samples, 3);
    assert.ok(typeof b.median_ms === 'number');
  });

  test('a suite that already fails is refused as a baseline', async () => {
    fs.writeFileSync(p('suite.mjs'), 'process.exit(1);\n');
    const b = await baseline([process.execPath, p('suite.mjs')]);
    assert.equal(b.usable, false);
    assert.equal(b.status, 'red');
    assert.match(b.reason, /rubber stamp/);
  });

  test('a flaky suite is detected and refused', async () => {
    // Alternates on a counter file, so identical input gives different results.
    fs.writeFileSync(p('counter.txt'), '0');
    fs.writeFileSync(p('flaky.mjs'),
      'import fs from "node:fs";\n' +
      `const f = ${JSON.stringify(p('counter.txt'))};\n` +
      'const n = Number(fs.readFileSync(f, "utf8")) + 1;\n' +
      'fs.writeFileSync(f, String(n));\n' +
      'process.exit(n % 2);\n');
    const b = await baseline([process.execPath, p('flaky.mjs')], { samples: 4 });
    assert.equal(b.usable, false);
    assert.equal(b.status, 'flaky');
    assert.match(b.reason, /different results on identical input/);
  });

  test('a command that cannot run is reported as crashed, not failed', async () => {
    const b = await baseline(['/nonexistent/binary/xyz']);
    assert.equal(b.usable, false);
    assert.equal(b.status, 'crashed');
  });

  test('a red baseline stops the coverage report rather than reporting everything watched', async () => {
    fs.writeFileSync(p('suite.mjs'), 'process.exit(1);\n');
    const r = await ctx.call('safe_function_report', {
      path: p('calc.js'), verify_command: [process.execPath, p('suite.mjs')], verify_cwd: ctx.root,
    });
    assert.equal(r.checkable, false);
    assert.equal(r.baseline.status, 'red');
    assert.deepEqual(r.functions, [], 'no per-function claims may be made on a red baseline');
  });

  test('the report records the baseline it relied on', async () => {
    const r = await ctx.call('safe_function_report', {
      path: p('calc.js'), verify_command: [process.execPath, p('suite.mjs')], verify_cwd: ctx.root,
    });
    assert.equal(r.baseline.status, 'green');
    assert.ok(r.baseline.samples >= 1);
  });

  test('identical probes inside one run are memoised', async () => {
    const r = await ctx.call('safe_function_report', {
      path: p('calc.js'), verify_command: [process.execPath, p('suite.mjs')], verify_cwd: ctx.root,
      mutants_per_function: 3,
    });
    assert.ok(r.cache, 'cache stats should be reported');
    assert.equal(r.cache.scope, 'memory-only (this run)');
  });

  test('a rewritten test suite is NOT served from cache', async () => {
    // The bug this guards: a probe result is not a pure function of the file
    // being probed. It depends on the test files too. Keying the cache on the
    // probed content alone served a stale answer from a stronger suite.
    const strong = [process.execPath, p('suite.mjs')];
    let r = await ctx.call('safe_function_report', { path: p('calc.js'), verify_command: strong, verify_cwd: ctx.root });
    assert.equal(r.functions.find((f) => f.name === 'add').status, 'watched');

    fs.writeFileSync(p('suite.mjs'), 'import { add } from "./calc.js";\nif (typeof add !== "function") process.exit(1);\n');
    r = await ctx.call('safe_function_report', { path: p('calc.js'), verify_command: strong, verify_cwd: ctx.root });
    assert.equal(r.functions.find((f) => f.name === 'add').status, 'UNWATCHED',
      'the weakened suite must be measured, not the cached answer from the strong one');
  });
});

describe('TypeScript', () => {
  beforeEach(() => {
    fs.writeFileSync(p('svc.ts'),
      'import fs from "node:fs";\n' +
      'export interface Opts { path: string; depth: number }\n' +
      'export type Id = string;\n' +
      'export function load(o: Opts): Id {\n' +
      '  const clean = (s: string): string => s.trim();\n' +
      '  return clean(o.path);\n' +
      '}\n' +
      'export class Svc {\n' +
      '  private count = 0;\n' +
      '  run(n: number): number { return n + this.count; }\n' +
      '}\n');
  });

  test('reads a real TypeScript file with the real compiler', async () => {
    const inv = await ctx.call('safe_inventory', { path: p('svc.ts') });
    assert.equal(inv.understood, true);
    assert.equal(inv.language, 'typescript');
    assert.ok(inv.symbols.includes('export.function:load'));
    assert.ok(inv.symbols.includes('export.class:Svc'));
    assert.ok(inv.symbols.includes('method:Svc.run'));
    assert.deepEqual(inv.imports, ['node:fs']);
  });

  test('types are part of the contract', async () => {
    const inv = await ctx.call('safe_inventory', { path: p('svc.ts') });
    assert.ok(inv.symbols.includes('export.interface:Opts'), 'an exported interface is a promise to consumers');
    assert.ok(inv.symbols.includes('export.type:Id'));
  });

  test('deleting an exported interface is REFUSED, though no runtime check would notice', async () => {
    const before = fs.readFileSync(p('svc.ts'), 'utf8');
    const e = await ctx.err('safe_edit', {
      path: p('svc.ts'),
      edits: [{ old: 'export interface Opts { path: string; depth: number }\n', new: '' }],
    });
    assert.ok(e, 'losing an exported type must be refused');
    assert.match(e.error, /Opts/);
    assert.equal(fs.readFileSync(p('svc.ts'), 'utf8'), before);
  });

  test('the function tree includes arrows nested inside typed functions', async () => {
    const t = await ctx.call('safe_functions', { path: p('svc.ts') });
    const names = t.functions.map((f) => f.name);
    assert.ok(names.includes('load'));
    assert.ok(names.includes('load.clean'), 'an arrow inside a typed function must be found');
    assert.ok(names.includes('Svc.run'));
  });

  test('a type annotation is not mistaken for broken syntax', async () => {
    const out = await ctx.call('safe_edit', { path: p('svc.ts'), edits: [{ old: 'return n + this.count;', new: 'return n + this.count + 0;' }] });
    assert.equal(out.structure.checked, true, 'TypeScript must be checked, not waved through');
    assert.deepEqual(out.structure.removed, []);
  });

  test('an edit that breaks TypeScript syntax is REFUSED', async () => {
    const before = fs.readFileSync(p('svc.ts'), 'utf8');
    const e = await ctx.err('safe_edit', { path: p('svc.ts'), edits: [{ old: 'export class Svc {', new: 'export class Svc {{{' }] });
    assert.ok(e);
    assert.match(e.error, /unparseable/);
    assert.equal(fs.readFileSync(p('svc.ts'), 'utf8'), before);
  });

  test('a TypeScript function can be replaced by name', async () => {
    await ctx.call('safe_edit_function', {
      path: p('svc.ts'), function_name: 'load',
      new_source: 'export function load(o: Opts): Id {\n  const clean = (s: string): string => s.trim();\n  return clean(o.path).toLowerCase();\n}',
    });
    assert.match(fs.readFileSync(p('svc.ts'), 'utf8'), /toLowerCase/);
  });
});

describe('the six ways it could lie (found by adversarial review)', () => {
  beforeEach(() => {
    fs.writeFileSync(p('lib.js'), 'export function price(a, b) {\n  return a + b;\n}\n');
  });

  test('a checksum guard that never runs the code cannot make it look watched', async () => {
    // The suite objects to garbage without executing a line, so the destruction
    // probe alone reads it as exercising the file. The null probe catches it:
    // it also objects to an appended comment, which cannot change behaviour.
    fs.writeFileSync(p('expected.sha'), 'irrelevant');
    fs.writeFileSync(p('guard.mjs'),
      'import fs from "node:fs";\n' +
      'import crypto from "node:crypto";\n' +
      `const src = fs.readFileSync(${JSON.stringify(p('lib.js'))}, "utf8");\n` +
      'const h = crypto.createHash("sha256").update(src).digest("hex");\n' +
      `const want = fs.readFileSync(${JSON.stringify(p('expected.sha'))}, "utf8").trim();\n` +
      'if (want !== "seed" && h !== want) { console.error("drift"); process.exit(1); }\n');
    // Seed the expected hash from the current file.
    const crypto = await import('node:crypto');
    fs.writeFileSync(p('expected.sha'),
      crypto.createHash('sha256').update(fs.readFileSync(p('lib.js'), 'utf8')).digest('hex'));

    const r = await ctx.call('safe_function_report', {
      path: p('lib.js'), verify_command: [process.execPath, p('guard.mjs')], verify_cwd: ctx.root,
    });
    assert.equal(r.checkable, false, 'a byte-checking suite must not yield coverage claims');
    assert.equal(r.null_probe.caught, true);
    assert.match(r.reason, /cannot alter behaviour|checking the file bytes/);
    assert.deepEqual(r.functions, []);
  });

  test('a real suite passes the null probe and still reports coverage', async () => {
    fs.writeFileSync(p('suite.mjs'), 'import { price } from "./lib.js";\nif (price(2,3) !== 5) process.exit(1);\n');
    const r = await ctx.call('safe_function_report', {
      path: p('lib.js'), verify_command: [process.execPath, p('suite.mjs')], verify_cwd: ctx.root,
    });
    assert.equal(r.checkable, true);
    assert.equal(r.null_probe.caught, false, 'a behavioural suite ignores an added comment');
    assert.equal(r.functions[0].status, 'watched');
  });

  test('two byte-identical files do not share a cached answer', async () => {
    // A vendored copy nothing imports must not inherit the tested original's
    // result. The destruction probe used to be a constant string, so every file
    // in a repo collided.
    fs.mkdirSync(p('a'), { recursive: true });
    fs.mkdirSync(p('b'), { recursive: true });
    const body = 'export function price(a, b) {\n  return a + b;\n}\n';
    fs.writeFileSync(p('a', 'lib.js'), body);
    fs.writeFileSync(p('b', 'lib.js'), body);           // byte-identical, imported by nobody
    fs.writeFileSync(p('suite.mjs'), 'import { price } from "./a/lib.js";\nif (price(2,3) !== 5) process.exit(1);\n');
    const cmd = [process.execPath, p('suite.mjs')];
    const scope = 'test-scope-fixed';

    const ra = await ctx.call('safe_function_report', { path: p('a', 'lib.js'), verify_command: cmd, verify_cwd: ctx.root, cache_scope: scope });
    assert.equal(ra.functions[0].status, 'watched');

    const rb = await ctx.call('safe_function_report', { path: p('b', 'lib.js'), verify_command: cmd, verify_cwd: ctx.root, cache_scope: scope });
    assert.equal(rb.checkable, false, 'the untested copy must not inherit the tested one\'s answer');
    assert.match(rb.reason, /does not exercise this file/);
  });

  test('a suite that degrades as it runs voids the sweep', async () => {
    // Passes the first few times, fails afterwards. The up-front baseline cannot
    // see it; comparing the baseline before and after can.
    fs.writeFileSync(p('runs.txt'), '0');
    fs.writeFileSync(p('drift.mjs'),
      'import fs from "node:fs";\n' +
      `const f = ${JSON.stringify(p('runs.txt'))};\n` +
      'const n = Number(fs.readFileSync(f, "utf8")) + 1;\n' +
      'fs.writeFileSync(f, String(n));\n' +
      'if (n > 3) process.exit(1);\n');
    const r = await ctx.call('safe_function_report', {
      path: p('lib.js'), verify_command: [process.execPath, p('drift.mjs')], verify_cwd: ctx.root,
    });
    assert.equal(r.checkable, false, 'a suite whose behaviour changes mid-sweep must void the result');
    assert.deepEqual(r.functions, []);
  });

  test('allow_removals no longer authorises every same-named symbol', async () => {
    fs.writeFileSync(p('two.js'),
      'export class A {\n  handler() { return 1; }\n}\n' +
      'export class B {\n  handler() { return 2; }\n}\n');
    const before = fs.readFileSync(p('two.js'), 'utf8');
    const e = await ctx.err('safe_edit', {
      path: p('two.js'),
      edits: [
        { old: '  handler() { return 1; }\n', new: '' },
        { old: '  handler() { return 2; }\n', new: '' },
      ],
      allow_removals: ['A.handler'],
    });
    assert.ok(e, 'a grant for A.handler must not cover B.handler');
    assert.match(e.error, /B\.handler/);
    assert.doesNotMatch(e.error.replace(/B\.handler/g, ''), /A\.handler/);
    assert.equal(fs.readFileSync(p('two.js'), 'utf8'), before);
  });

  test('a fully-qualified grant still works', async () => {
    fs.writeFileSync(p('two.js'),
      'export class A {\n  handler() { return 1; }\n}\n' +
      'export class B {\n  handler() { return 2; }\n}\n');
    await ctx.call('safe_edit', {
      path: p('two.js'),
      edits: [{ old: '  handler() { return 1; }\n', new: '' }],
      allow_removals: ['A.handler'],
    });
    assert.doesNotMatch(fs.readFileSync(p('two.js'), 'utf8'), /return 1/);
  });

  test('a backup id cannot escape its directory', async () => {
    await ctx.call('safe_edit', { path: p('lib.js'), edits: [{ old: 'a + b', new: 'b + a' }] });
    const e = await ctx.err('safe_restore', {
      path: p('lib.js'), backup_id: '../../../../../../../../tmp/anything',
    });
    assert.ok(e, 'a traversing backup id must be refused');
    assert.match(e.error, /valid backup id/i);
  });

  test('a real backup id still restores', async () => {
    const out = await ctx.call('safe_edit', { path: p('lib.js'), edits: [{ old: 'a + b', new: 'b + a' }] });
    await ctx.call('safe_restore', { path: p('lib.js'), backup_id: out.backup_id });
    assert.match(fs.readFileSync(p('lib.js'), 'utf8'), /a \+ b/);
  });
});

describe('silent-removal holes closed', () => {
  test('a key nested inside a JSON array is protected', async () => {
    fs.writeFileSync(p('cfg.json'), '{"tools":[{"name":"search","handler":"h","schema":"s"}]}');
    const before = fs.readFileSync(p('cfg.json'), 'utf8');
    const e = await ctx.err('safe_edit', { path: p('cfg.json'), edits: [{ old: ',"handler":"h"', new: '' }] });
    assert.ok(e, 'a capability inside an array must not vanish quietly');
    assert.match(e.error, /tools\.0\.handler/);
    assert.equal(fs.readFileSync(p('cfg.json'), 'utf8'), before);
  });

  test('an argv element cannot be silently rewritten away', async () => {
    fs.writeFileSync(p('cfg.json'), '{"args":["--root","/Users/bard/Code"]}');
    const e = await ctx.err('safe_edit', { path: p('cfg.json'), edits: [{ old: '"/Users/bard/Code"', new: '"/"' }] });
    assert.ok(e, 'changing an allowed root in a config is a removal of the old value');
    assert.match(e.error, /args\.1/);
  });

  test('a python decorator is part of what the function is', async () => {
    fs.writeFileSync(p('srv.py'), 'from mcp import mcp\n\n@mcp.tool()\ndef search(q):\n    return q\n');
    const before = fs.readFileSync(p('srv.py'), 'utf8');
    const e = await ctx.err('safe_edit', { path: p('srv.py'), edits: [{ old: '@mcp.tool()\n', new: '' }] });
    assert.ok(e, 'stripping @mcp.tool() unregisters the tool while leaving the function');
    assert.match(e.error, /decorator:search@mcp\.tool/);
    assert.equal(fs.readFileSync(p('srv.py'), 'utf8'), before);
  });

  test('python class attributes are part of the contract', async () => {
    fs.writeFileSync(p('cfg.py'), 'class Cfg:\n    port: int = 8080\n    token = ""\n');
    const e = await ctx.err('safe_edit', { path: p('cfg.py'), edits: [{ old: '    port: int = 8080\n', new: '' }] });
    assert.ok(e, 'a dataclass or pydantic field vanishing is a real loss');
    assert.match(e.error, /attr:Cfg\.port/);
  });

  test('adding a decorator or a field is allowed', async () => {
    fs.writeFileSync(p('srv.py'), 'from mcp import mcp\n\ndef search(q):\n    return q\n');
    const out = await ctx.call('safe_edit', { path: p('srv.py'), edits: [{ old: 'def search(q):', new: '@mcp.tool()\ndef search(q):' }] });
    assert.ok(out.structure.added.some((x) => x.includes('decorator:search')));
    assert.deepEqual(out.structure.removed, []);
  });
});
