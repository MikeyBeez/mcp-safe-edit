#!/usr/bin/env node
// mcp-safe-edit — the MCP surface. Thin on purpose: all behaviour lives in
// core.js and edit.js so it can be tested without a server.
//
// Usage: node src/index.js <allowed-root> [more-roots...]

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { makeGuard, readFile, listBackups, readBackup, backup, atomicWrite, sha256, diff } from './core.js';
import { editFile, writeFile, replaceLines, editFunction, runVerification, EditError } from './edit.js';
import { functionTree } from './functions.js';
import { functionCoverage } from './coverage.js';
import { inventory, describeAnalyzers } from './inventory.js';

const roots = process.argv.slice(2);
if (!roots.length) {
  console.error('Usage: mcp-safe-edit <allowed-root> [more-roots...]');
  process.exit(1);
}
let assertAllowed;
try { assertAllowed = makeGuard(roots); }
catch (e) { console.error(`[safe-edit] FATAL: ${e.message}`); process.exit(1); }

const nowStamp = () => new Date().toISOString();
const ok = (o) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o, null, 2) }] });
const fail = (m, detail) => ({
  content: [{ type: 'text', text: JSON.stringify({ error: m, ...(detail || {}) }, null, 2) }],
  isError: true,
});

const S = (props, required = []) => ({ type: 'object', properties: props, required });
const str = { type: 'string' };
const num = { type: 'number' };
const bool = { type: 'boolean' };

const EDIT_ITEM = {
  type: 'object',
  properties: {
    old: { type: 'string', description: 'Exact text to find. Matched literally — never as a regex.' },
    new: { type: 'string', description: 'Replacement text. Inserted literally; $& and $1 are ordinary characters.' },
    replace_all: { type: 'boolean', description: 'Replace every occurrence. Without this, more than one match is an error.' },
    expect_count: { type: 'number', description: 'Assert the exact number of occurrences. Mismatch is an error and nothing is written.' },
  },
  required: ['old', 'new'],
};

const TOOLS = {
  safe_read: {
    desc: 'Read a file and return its content plus a sha256 token. Pass that token back as expect_sha256 when you edit, so an edit computed against a stale copy is refused instead of applied.',
    schema: S({ path: str }, ['path']),
    fn: ({ path: p }) => readFile(assertAllowed(p)),
  },
  safe_edit: {
    desc: 'Apply one or more exact-text edits to a file. Every edit is validated against the original content BEFORE anything is written, so a batch is all-or-nothing. A match count other than the one you asserted is an error. Then two gates: the file must still provide everything it provided before (functions, classes, exports, JSON keys), and if you name a verify_command it must pass or the file is rolled back. Writes atomically and re-reads to prove what landed.',
    schema: S({
      path: str,
      edits: { type: 'array', items: EDIT_ITEM },
      expect_sha256: { type: 'string', description: 'The sha256 from safe_read. Omit only if you accept editing whatever is currently there.' },
      dry_run: bool,
      check_structure: { type: 'boolean', description: 'Default true. Refuses the edit if it would remove something the file provides, or leave it unparseable.' },
      allow_removals: { type: 'array', items: { type: 'string' }, description: 'Names you INTEND to remove, e.g. ["function:oldHelper"] or just ["oldHelper"]. Anything removed that is not listed here is a refusal.' },
      verify_command: { type: 'array', items: { type: 'string' }, description: 'Argv array proving the file still works, e.g. ["npm","test"]. Run after the write, never through a shell. If it fails, the file is rolled back.' },
      verify_cwd: { type: 'string', description: 'Where to run verify_command. Defaults to the edited file\'s directory.' },
      verify_timeout_ms: num,
      verify_the_verifier: { type: 'boolean', description: 'Default true. After verify_command passes, break the file on purpose and confirm the command notices. A command that passes on a corrupted file proves nothing.' },
      max_probes: { type: 'number', description: 'How many deliberate breakages to try. Default 3: total destruction first, then targeted changes inside the edited lines. Each costs one run of verify_command.' },
      require_trustworthy_verification: { type: 'boolean', description: 'Default false. When true, an edit whose verification proved uninformative is rolled back rather than merely reported.' },
    }, ['path', 'edits']),
    fn: (a) => editFile(assertAllowed(a.path), {
      ...a,
      verify_cwd: a.verify_cwd ? assertAllowed(a.verify_cwd) : undefined,
      stamp: nowStamp(),
    }),
  },
  safe_preview: {
    desc: 'Exactly what safe_edit would do, without writing. Returns the diff and the resulting sha256.',
    schema: S({ path: str, edits: { type: 'array', items: EDIT_ITEM }, expect_sha256: str, check_structure: bool, allow_removals: { type: 'array', items: { type: 'string' } } }, ['path', 'edits']),
    fn: (a) => editFile(assertAllowed(a.path), { ...a, dry_run: true, stamp: nowStamp() }),
  },
  safe_write: {
    desc: 'Write whole-file content. Creating a new file is free; overwriting an existing one requires expect_sha256 (or the literal "*" to overwrite deliberately). Backs up the previous content first.',
    schema: S({ path: str, content: str, expect_sha256: str, create_only: bool }, ['path', 'content']),
    fn: (a) => writeFile(assertAllowed(a.path), { ...a, stamp: nowStamp() }),
  },
  safe_replace_lines: {
    desc: 'Replace a line range, asserting what you expect to find there. For when the target text is not unique but its position is.',
    schema: S({ path: str, start_line: num, end_line: num, expect_text: str, new_text: str, expect_sha256: str, dry_run: bool }, ['path', 'start_line', 'end_line', 'new_text']),
    fn: (a) => replaceLines(assertAllowed(a.path), { ...a, stamp: nowStamp() }),
  },
  safe_verify: {
    desc: 'Check whether a file still has the sha256 you expect. Cheap way to confirm an edit landed, or that nothing moved under you.',
    schema: S({ path: str, expect_sha256: str }, ['path', 'expect_sha256']),
    fn: ({ path: p, expect_sha256 }) => {
      const f = readFile(assertAllowed(p));
      return { path: f.path, matches: f.sha256 === expect_sha256, expected: expect_sha256, actual: f.sha256 };
    },
  },
  safe_list_backups: {
    desc: 'List the saved copies of a file, newest first. Every mutation through this server takes one first.',
    schema: S({ path: str }, ['path']),
    fn: ({ path: p }) => ({ path: assertAllowed(p), backups: listBackups(assertAllowed(p)) }),
  },
  safe_restore: {
    desc: 'Restore a file from one of its backups. Backs up the current content first, so a restore is itself reversible.',
    schema: S({ path: str, backup_id: str }, ['path', 'backup_id']),
    fn: ({ path: p, backup_id }) => {
      const abs = assertAllowed(p);
      const restored = readBackup(abs, backup_id);
      let current = '';
      try { current = readFile(abs).content; } catch { /* file may be gone */ }
      const safetyId = current ? backup(abs, current, nowStamp()) : null;
      const shaAfter = atomicWrite(abs, restored);
      return {
        path: abs, restored_from: backup_id, safety_backup_id: safetyId,
        sha256_after: shaAfter, diff: diff(current, restored), verified: true,
      };
    },
  },
  safe_functions: {
    desc: 'Decompose a file into every callable it defines, including functions nested inside other functions, arrows bound to consts, and methods inside classes — each with its line range, depth and parent. This is the unit edits should be addressed by.',
    schema: S({ path: str }, ['path']),
    fn: ({ path: p }) => {
      const abs = assertAllowed(p);
      return { path: abs, ...functionTree(abs, readFile(abs).content) };
    },
  },
  safe_edit_function: {
    desc: 'Replace one whole function by name. The parser finds its exact bounds, so there is no "which occurrence did you mean" — an unknown name lists what the file does define, and an ambiguous one lists the candidates. Passes through the same structural and verification gates as safe_edit.',
    schema: S({
      path: str,
      function_name: { type: 'string', description: 'Bare name, or fully qualified for a nested one, e.g. "outer.inner".' },
      new_source: { type: 'string', description: 'The complete replacement source for the function, including its signature.' },
      expect_sha256: str, dry_run: bool,
      allow_removals: { type: 'array', items: { type: 'string' } },
      verify_command: { type: 'array', items: { type: 'string' } },
      verify_cwd: str, verify_timeout_ms: num,
    }, ['path', 'function_name', 'new_source']),
    fn: (a) => editFunction(assertAllowed(a.path), {
      ...a, verify_cwd: a.verify_cwd ? assertAllowed(a.verify_cwd) : undefined, stamp: nowStamp(),
    }),
  },
  safe_function_report: {
    desc: 'For each function in a file, break it on purpose and see whether your verification command notices. Reports which functions are WATCHED and which are UNWATCHED — the ones you could break with nothing complaining. This is the map of where a test would actually buy you something, as opposed to line coverage, which only says a line ran.',
    schema: S({
      path: str,
      verify_command: { type: 'array', items: { type: 'string' } },
      verify_cwd: str, verify_timeout_ms: num,
      mutants_per_function: num, max_functions: num, max_runs: num,
      include: { type: 'array', items: { type: 'string' }, description: 'Only probe these function names.' },
    }, ['path', 'verify_command']),
    fn: (a) => {
      const abs = assertAllowed(a.path);
      const cwd = a.verify_cwd ? assertAllowed(a.verify_cwd) : undefined;
      const run = () => runVerification(a.verify_command, cwd, a.verify_timeout_ms);
      return { path: abs, ...functionCoverage(abs, readFile(abs).content, run, a) };
    },
  },
  safe_inventory: {
    desc: 'List everything a file provides — functions, classes, methods, exports, imports, JSON key paths, markdown headings. This is the contract safe_edit checks an edit against. Says plainly when a file type cannot be analysed.',
    schema: S({ path: str }, ['path']),
    fn: ({ path: p }) => {
      const abs = assertAllowed(p);
      const inv = inventory(abs, readFile(abs).content);
      return { path: abs, ...inv };
    },
  },
  safe_analyzers: {
    desc: 'Which file types get a structural guarantee, and which do not. Anything unlisted is edited textually with no guarantee, and safe_edit says so in its result rather than implying safety it cannot provide.',
    schema: S({}),
    fn: () => describeAnalyzers(),
  },
  safe_allowed_roots: {
    desc: 'List the directories this server is permitted to touch.',
    schema: S({}),
    fn: () => ({ roots: roots.map((r) => { try { return assertAllowed(r); } catch { return `${r} (invalid)`; } }) }),
  },
};

const server = new Server({ name: 'mcp-safe-edit', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.desc, inputSchema: t.schema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const t = TOOLS[req.params.name];
  if (!t) return fail(`unknown tool: ${req.params.name}`);
  try {
    return ok(t.fn(req.params.arguments || {}));
  } catch (e) {
    // Errors are the product here. They carry the diagnosis, and they always
    // mean nothing was written.
    return fail(e.message, e instanceof EditError ? e.detail : undefined);
  }
});

await server.connect(new StdioServerTransport());
console.error(`[safe-edit] connected. roots=${roots.join(', ')}`);
