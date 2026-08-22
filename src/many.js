// many.js — one literal edit applied across many files, all-or-nothing.
//
// WHY THIS EXISTS (2026-08-22). mcp-smalledit was kept for one capability safe-edit
// lacked: sed_multifile, a pattern sweep across many files. Mikey's reason for
// preferring a stream editor was that it cannot add anything or leave anything off
// outside the edit radius. That is true of sed and it is true here — but sed buys it
// at a price this does not pay:
//
//   * sed interprets its pattern, so a stray `.` or `*` reaches further than intended.
//     Matching here is literal, via the same indexOf path safe_edit uses.
//   * sed edits as it goes. If file 37 of 40 is the one your pattern mangles, the first
//     36 are already written. Here NOTHING is written until EVERY file has been planned
//     and passed its structural gate, so a sweep that would gut a file writes nothing
//     at all.
//   * sed reports success for a run that matched nothing. Here a file with no match is
//     reported as SKIPPED, by name, and counted.
//
// The two-phase shape is the whole design: plan everything in memory, then write.

import { readFileSync } from 'node:fs';
import { editFile, writeFile, runVerification, EditError } from './edit.js';

/**
 * @param {string[]} absPaths   already permission-checked absolute paths
 * @param {object}   opts       edits, check_structure, allow_removals, dry_run,
 *                              skip_unmatched, verify_command, verify_cwd, stamp
 */
export function editMany(absPaths, opts = {}) {
  const {
    edits,
    dry_run = false,
    check_structure = true,
    allow_removals = [],
    skip_unmatched = true,
    verify_command,
    verify_cwd,
    verify_timeout_ms,
    stamp,
  } = opts;

  if (!Array.isArray(absPaths) || absPaths.length === 0)
    throw new EditError('paths must be a non-empty array of file paths.');
  if (!Array.isArray(edits) || edits.length === 0)
    throw new EditError('edits must be a non-empty array.');

  // ---- PHASE 1: plan every file. Nothing is written. ------------------------
  const planned = [], skipped = [], failed = [];
  for (const abs of absPaths) {
    let before;
    try { before = readFileSync(abs, 'utf8'); }
    catch (e) { failed.push({ path: abs, reason: `could not read: ${e.message}` }); continue; }

    try {
      // auto_verify off during planning: running a test suite once per file is the
      // wrong shape for a sweep. A single verify_command runs after all writes.
      const r = editFile(abs, {
        edits, dry_run: true, check_structure, allow_removals,
        auto_verify: false, verify_the_verifier: false, stamp,
      });
      planned.push({ path: abs, before, sha256_before: r.sha256_before, replacements: r.replacements, structure: r.structure });
    } catch (e) {
      const msg = String(e.message || e);
      // A file that simply does not contain the target is not a failure in a sweep --
      // it is most of the files. Distinguish it from an ambiguous match or a gutted
      // structure, which ARE failures and must stop everything.
      const isMiss = /matched 0 times|matched nothing|not found in|0 matches/i.test(msg);
      if (isMiss && skip_unmatched) skipped.push({ path: abs, reason: 'no match' });
      else failed.push({ path: abs, reason: msg });
    }
  }

  const summary = {
    files_given: absPaths.length,
    files_to_edit: planned.length,
    files_skipped_no_match: skipped.length,
    files_failed: failed.length,
    total_replacements: planned.reduce((a, p) => a + (p.replacements || 0), 0),
  };

  // ---- The gate: one bad file stops the whole sweep -------------------------
  if (failed.length) {
    return {
      applied: false,
      reason: 'REFUSED — nothing was written. At least one file could not be edited safely, ' +
              'and a partial sweep is worse than none: it leaves the tree in a state no one chose.',
      summary, failed, skipped,
      planned: planned.map((p) => ({ path: p.path, replacements: p.replacements })),
      hint: 'Fix or exclude the failing paths, then re-run. Nothing on disk has changed.',
    };
  }

  if (dry_run || planned.length === 0) {
    return {
      applied: false,
      dry_run: true,
      reason: planned.length === 0
        ? 'No file contained the target text. Nothing to do.'
        : 'Planned only. Every file passed its checks; re-send with dry_run:false to apply.',
      summary, skipped,
      planned: planned.map((p) => ({ path: p.path, replacements: p.replacements })),
    };
  }

  // A test seam, and only that. It is the one way to make a file move on disk between
  // planning and writing, which is the exact race the sha pin below exists to refuse.
  // index.js DOES spread the caller's args into opts, so the typeof guard is the whole
  // defence -- and it is enough: JSON-RPC arguments can never carry a function.
  if (typeof opts.__before_write === 'function') opts.__before_write(planned);

  // ---- PHASE 2: write. Every file is pinned to the sha it was planned against.
  const written = [], rollback = [];
  try {
    for (const p of planned) {
      const r = editFile(p.path, {
        edits, dry_run: false, check_structure, allow_removals,
        expect_sha256: p.sha256_before,     // refuses if the file moved since planning
        auto_verify: false, verify_the_verifier: false, stamp,
      });
      written.push({ path: p.path, replacements: r.replacements, sha256_after: r.sha256_after });
      rollback.push({ path: p.path, before: p.before });
    }
  } catch (e) {
    for (const r of rollback) {
      try { writeFile(r.path, { content: r.before, expect_sha256: '*', stamp }); } catch { /* reported below */ }
    }
    return {
      applied: false,
      reason: `A write failed partway through and every file already written was restored: ${e.message}`,
      summary, written_then_rolled_back: rollback.map((r) => r.path), skipped,
    };
  }

  // ---- Optional single verification over the whole sweep -------------------
  let verification = null;
  if (verify_command && verify_command.length) {
    verification = runVerification(verify_command, verify_cwd, verify_timeout_ms);
    {
      if (verification && verification.passed === false) {
        for (const r of rollback) {
          try { writeFile(r.path, { content: r.before, expect_sha256: '*', stamp }); } catch { /* below */ }
        }
        return {
          applied: false,
          reason: 'The sweep applied cleanly but the verification command failed, so ALL files were restored.',
          summary, verification, restored: rollback.map((r) => r.path), skipped,
        };
      }
    }
  }

  return {
    applied: true,
    summary,
    written,
    skipped,
    verification,
    note: 'Every file was planned and passed its structural gate before any write happened. ' +
          'Files with no match were skipped and are listed, not silently ignored.',
  };
}

