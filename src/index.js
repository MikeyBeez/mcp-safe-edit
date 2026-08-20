#!/usr/bin/env node
// mcp-safe-edit — the MCP surface. Thin on purpose: all behaviour lives in
// core.js and edit.js so it can be tested without a server.
//
// Usage: node src/index.js <allowed-root> [more-roots...]

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { makeGuard, readFile, listBackups, readBackup, backup, atomicWrite, sha256, diff } from './core.js';
import { editFile, writeFile, replaceLines, editFunction, rebuildFunction, runVerification, EditError } from './edit.js';
import { buildSpec, writeSpec, readSpec, checkSpec } from './spec.js';
import { makeRunner, establishBaseline } from './runner.js';
import { repoReport, discoverSources } from './repo.js';
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
      auto_verify: { type: 'boolean', description: 'Default true. When verify_command is omitted, work out the appropriate tests for this file — walk up to the nearest package.json test script, pytest config, or test directory — and use that. What it decided (or why it found nothing) is always reported back as inferred_verification; it never runs something silently. Set false to edit without tests.' },
      verify_cwd: { type: 'string', description: 'Where to run verify_command. Defaults to the edited file\'s directory.' },
      verify_timeout_ms: num,
      verify_effort: { type: 'string', description: 'How hard to verify: auto (default), structural (AST gate only, no run), smoke (run the suite once), changed (run + probe the functions this edit touched), full (run + probe every function). auto scales with the edit size and escalates to full occasionally. This is the latency switch: small edits test what changed, big edits test everything.' },
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
      cache_scope: { type: 'string', description: 'Opt in to a disk cache by naming what has not changed - a git SHA, a lockfile hash. Results are only reused within that scope, because a probe depends on every file in the repo, not just the one being probed. Omit for memory-only caching within this run, which is always sound.' },
      include: { type: 'array', items: { type: 'string' }, description: 'Only probe these function names.' },
    }, ['path', 'verify_command']),
    fn: (a) => {
      const abs = assertAllowed(a.path);
      const cwd = a.verify_cwd ? assertAllowed(a.verify_cwd) : undefined;
      const run = makeRunner(a.verify_command, cwd, a.verify_timeout_ms, { cache_scope: a.cache_scope || null });
      return { path: abs, ...functionCoverage(abs, readFile(abs).content, run, a) };
    },
  },
  safe_repo_report: {
    desc: 'Scan a whole repo and answer the question a single file cannot: where, across everything here, could something break with nothing complaining. Probes each source file in turn, ranks unwatched functions by size, and is incremental - a file whose contents AND whose tests are both unchanged reuses its previous answer. Every file dropped for budget is named, because a silently truncated report reads as if everything had been checked.',
    schema: S({
      root: { type: 'string', description: 'Repo root to scan. Source files only; test files are skipped, since they are the thing doing the watching.' },
      verify_command: { type: 'array', items: { type: 'string' } },
      verify_cwd: str, verify_timeout_ms: num,
      max_files: { type: 'number', description: 'How many files to probe this run. Default 60.' },
      max_runs_total: { type: 'number', description: 'Hard ceiling on verification runs. Default 400.' },
      max_functions_per_file: num, mutants_per_function: num,
      time_budget_ms: { type: 'number', description: 'Stop and return after this long, naming what is left. Default 45000, chosen to fit inside a 60-second MCP client timeout. Call again to resume - nothing already measured is repeated.' },
      incremental: { type: 'boolean', description: 'Default true. Reuses a file result when the file and the tests are both unchanged.' },
    }, ['root', 'verify_command']),
    fn: (a) => {
      const root = assertAllowed(a.root);
      const cwd = a.verify_cwd ? assertAllowed(a.verify_cwd) : root;
      const runner = makeRunner(a.verify_command, cwd, a.verify_timeout_ms);
      return repoReport(root, runner, { ...a, stamp: nowStamp() });
    },
  },
  safe_repo_sources: {
    desc: 'List the source files a repo scan would probe, without running anything. Cheap way to see the scope and estimate the cost before committing to a sweep.',
    schema: S({ root: str, max_files: num }, ['root']),
    fn: (a) => {
      const root = assertAllowed(a.root);
      const files = discoverSources(root, { max_files: a.max_files || 500 });
      return { root, count: files.length, files };
    },
  },
  safe_baseline: {
    desc: 'Run the verification several times on the unmodified file and report whether it is green AND stable. Nothing this server measures can be believed on a red or flaky suite: a red baseline makes every function look watched, and a flaky one manufactures caught mutants at random. Check this before trusting any coverage number.',
    schema: S({
      path: str, verify_command: { type: 'array', items: { type: 'string' } },
      verify_cwd: str, verify_timeout_ms: num,
      samples: { type: 'number', description: 'How many identical runs to compare. Default 3.' },
    }, ['verify_command']),
    fn: (a) => {
      const cwd = a.verify_cwd ? assertAllowed(a.verify_cwd) : undefined;
      const run = makeRunner(a.verify_command, cwd, a.verify_timeout_ms);
      return establishBaseline(run, { samples: a.samples });
    },
  },
  safe_spec_generate: {
    desc: 'Write a specification for a file: every function it must provide, and for each one the deliberate breakages that MUST fail the verification. Every spec format records what has to pass, which a generator can satisfy by fitting. Recording what has to FAIL cannot be satisfied that way — you cannot make "the suite must fail when this becomes a*b" true by writing a*b.',
    schema: S({
      path: str, spec_path: { type: 'string', description: 'Where to write it. Defaults to <file>.spec.json alongside the file.' },
      verify_command: { type: 'array', items: { type: 'string' } },
      verify_cwd: str, verify_timeout_ms: num,
      max_functions: num, max_runs: num, mutants_per_function: num,
    }, ['path', 'verify_command']),
    fn: (a) => {
      const abs = assertAllowed(a.path);
      const cwd = a.verify_cwd ? assertAllowed(a.verify_cwd) : undefined;
      const run = makeRunner(a.verify_command, cwd, a.verify_timeout_ms, { cache_scope: a.cache_scope || null });
      const spec = buildSpec(abs, readFile(abs).content, run, { ...a, verify_cwd: cwd, stamp: nowStamp() });
      const out = assertAllowed(a.spec_path || `${abs}.spec.json`);
      writeSpec(out, spec);
      return { spec_path: out, summary: spec.summary, checkable: spec.checkable, reason: spec.reason };
    },
  },
  safe_spec_check: {
    desc: 'Check a file against its spec. Three questions: is every required function still present, does the verification still pass, and do the recorded breakages still break it. The third catches something nothing else does — a test suite quietly weakening. If a change that used to fail now passes, an assertion was deleted, skipped or loosened, and a full green run will not show it.',
    schema: S({
      path: str, spec_path: str, verify_cwd: str, verify_timeout_ms: num,
      probe: { type: 'boolean', description: 'Default true. False checks presence only, without running anything.' },
    }, ['path']),
    fn: (a) => {
      const abs = assertAllowed(a.path);
      const specPath = assertAllowed(a.spec_path || `${abs}.spec.json`);
      const spec = readSpec(specPath);
      const cwd = a.verify_cwd ? assertAllowed(a.verify_cwd) : (spec.verify_cwd || undefined);
      const run = makeRunner(spec.verify_command, cwd, a.verify_timeout_ms);
      return checkSpec(abs, readFile(abs).content, spec, run, { probe: a.probe !== false });
    },
  },
  safe_rebuild_function: {
    desc: 'Rebuild one function against the spec, piece by piece. Replaces it, requires the verification to pass, and then breaks the NEW implementation on purpose and requires the verification to notice. An implementation that passes the tests but that no deliberate breakage can disturb has been fitted, not verified — that is rolled back.',
    schema: S({
      path: str, function_name: str, new_source: str, expect_sha256: str,
      verify_command: { type: 'array', items: { type: 'string' } },
      verify_cwd: str, verify_timeout_ms: num,
      allow_removals: { type: 'array', items: { type: 'string' } },
      require_watched: { type: 'boolean', description: 'Default true. False accepts a rebuild the tests cannot check, and says so in the result.' },
    }, ['path', 'function_name', 'new_source', 'verify_command']),
    fn: (a) => rebuildFunction(assertAllowed(a.path), {
      ...a, verify_cwd: a.verify_cwd ? assertAllowed(a.verify_cwd) : undefined, stamp: nowStamp(),
    }),
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
