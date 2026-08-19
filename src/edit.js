// The edit operations themselves. Separate from the MCP plumbing so they can be
// tested directly, and so the server file stays thin enough to read in one go.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { inventory, compareInventories } from './inventory.js';
import { changedLines, generateMutants, destructionProbe, summarise } from './probe.js';
import {
  sha256, readFile, findAll, lineOf, replaceAt, diagnoseMiss,
  atomicWrite, backup, diff,
} from './core.js';

// Echo the text that was searched for, truncated and with newlines made visible,
// so a caller with several edits can tell which one failed without guessing.
function preview(s, max = 60) {
  const flat = String(s).replace(/\n/g, '\\n').replace(/\t/g, '\\t');
  return JSON.stringify(flat.length > max ? flat.slice(0, max) + '…' : flat);
}

class EditError extends Error {
  constructor(message, detail = {}) { super(message); this.detail = detail; }
}
export { EditError };

// Compare-and-swap. This is the core safety property: if the caller passes the
// hash it read, an edit computed against a stale copy is refused rather than
// silently applied to a file somebody else has since changed.
function assertUnchanged(abs, expectSha) {
  const now = readFile(abs);
  if (expectSha && now.sha256 !== expectSha) {
    throw new EditError(
      `File changed since you read it. Expected sha256 ${expectSha.slice(0, 12)}…, found ${now.sha256.slice(0, 12)}…. Re-read the file and recompute the edit.`,
      { expected_sha256: expectSha, actual_sha256: now.sha256 }
    );
  }
  return now;
}

// Plan every edit against the ORIGINAL content before applying any of them.
// A batch is all-or-nothing: a half-applied edit is worse than no edit.
function planEdits(content, edits) {
  const plan = [];
  const problems = [];
  edits.forEach((e, idx) => {
    const label = `edit[${idx}]`;
    if (typeof e.old !== 'string' || e.old === '') {
      problems.push(`${label}: "old" must be a non-empty string`);
      return;
    }
    if (typeof e.new !== 'string') {
      problems.push(`${label}: "new" must be a string (use "" to delete)`);
      return;
    }
    const offsets = findAll(content, e.old);
    const found = offsets.length;

    if (found === 0) {
      const hints = diagnoseMiss(content, e.old);
      problems.push(
        `${label}: text not found (0 matches) — searched for ${preview(e.old)}.` +
        (hints.length ? ` Diagnosis: ${hints.join('; ')}.` : ' It does not appear in the file in any form.')
      );
      return;
    }

    // How many matches is the caller asserting? Default is exactly one, which
    // makes an ambiguous edit an error instead of a coin flip.
    const expected = e.expect_count !== undefined ? e.expect_count : (e.replace_all ? found : 1);
    if (found !== expected) {
      const lines = offsets.slice(0, 10).map((o) => lineOf(content, o));
      problems.push(
        `${label}: expected ${expected} match${expected === 1 ? '' : 'es'} but found ${found}, on line${lines.length === 1 ? '' : 's'} ${lines.join(', ')}` +
        (found > 1 && e.expect_count === undefined && !e.replace_all
          ? '. Pass replace_all:true to change all of them, or expect_count to state the number you mean, or lengthen "old" until it is unique.'
          : '.')
      );
      return;
    }
    plan.push({ idx, offsets, oldLen: e.old.length, replacement: e.new, count: found });
  });

  if (problems.length) {
    throw new EditError(
      `No changes were made. ${problems.length} of ${edits.length} edit${edits.length === 1 ? '' : 's'} could not be applied:\n  - ${problems.join('\n  - ')}`,
      { problems }
    );
  }

  // Overlapping edits would make the result depend on application order, which
  // is exactly the non-determinism this server exists to remove.
  const spans = plan.flatMap((p) => p.offsets.map((o) => ({ from: o, to: o + p.oldLen, idx: p.idx })));
  spans.sort((a, b) => a.from - b.from);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i].from < spans[i - 1].to) {
      throw new EditError(
        `No changes were made. edit[${spans[i - 1].idx}] and edit[${spans[i].idx}] overlap in the file, so the result would depend on the order they were applied.`,
        { overlapping: [spans[i - 1].idx, spans[i].idx] }
      );
    }
  }
  return plan;
}

function applyPlan(content, plan) {
  // Apply right-to-left across the whole batch so every offset stays valid.
  const all = plan.flatMap((p) => p.offsets.map((o) => ({ o, len: p.oldLen, rep: p.replacement })));
  all.sort((a, b) => b.o - a.o);
  let out = content;
  for (const { o, len, rep } of all) out = out.slice(0, o) + rep + out.slice(o + len);
  return out;
}

// ---------------------------------------------------------------------------
// The structural gate
// ---------------------------------------------------------------------------
//
// A textually perfect edit can still gut the file. So before the write lands we
// take an inventory of what the file provides, take it again on the edited text
// still held in memory, and refuse if anything vanished that the caller did not
// declare. Refusing here means nothing was written at all — there is no window
// where the file is broken on disk.

export function structuralGate(abs, beforeContent, afterContent, allowRemovals = []) {
  const before = inventory(abs, beforeContent);
  const after = inventory(abs, afterContent);
  const cmp = compareInventories(before, after);

  const report = {
    language: after.language,
    checked: cmp.checkable === true,
    provided_before: before.symbols.length,
    provided_after: after.symbols.length,
    added: cmp.added,
    removed: cmp.removed,
    added_imports: cmp.added_imports,
    removed_imports: cmp.removed_imports,
    notes: cmp.notes || [],
  };

  if (!cmp.checkable) {
    report.warning = `NO STRUCTURAL GUARANTEE: ${cmp.reason}. The text edit was applied exactly as asked, but nothing verified that this file still does what it did.`;
    return report;
  }

  if (cmp.broken) {
    throw new EditError(
      `Refused: the edit would leave the file unparseable — ${cmp.broken}. Nothing was written.`,
      { structure: report }
    );
  }

  const undeclared = cmp.removed.filter((sym) => !allowRemovals.includes(sym) && !allowRemovals.includes(sym.split(':').slice(1).join(':')));
  if (undeclared.length) {
    throw new EditError(
      `Refused: the edit would remove ${undeclared.length} thing${undeclared.length === 1 ? '' : 's'} this file provides — ${undeclared.join(', ')}. ` +
      `Nothing was written. If that removal is intended, pass allow_removals with those names.`,
      { structure: report, would_remove: undeclared }
    );
  }

  const lostImports = cmp.removed_imports.filter((i) => !allowRemovals.includes(i));
  if (lostImports.length) report.warning = `imports no longer referenced: ${lostImports.join(', ')}`;

  return report;
}

// ---------------------------------------------------------------------------
// The behavioural gate
// ---------------------------------------------------------------------------
//
// Structure is not behaviour. If the caller names a command that proves the
// file still works — a test suite, a linter, a type-check — we run it AFTER the
// write and roll the file back if it fails. execFile with an argv array, never
// a shell string, so nothing in the arguments is interpreted.

export function runVerification(command, cwd, timeoutMs = 120000) {
  if (!Array.isArray(command) || !command.length || command.some((c) => typeof c !== 'string')) {
    throw new EditError('verify_command must be an array of strings, e.g. ["npm","test"]. It is executed directly, never through a shell.');
  }
  const [cmd, ...args] = command;
  try {
    const stdout = execFileSync(cmd, args, { cwd, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
    return { passed: true, command, exit_code: 0, output: tail(stdout) };
  } catch (e) {
    return {
      passed: false,
      command,
      exit_code: e.status === undefined ? null : e.status,
      timed_out: e.signal === 'SIGTERM' || /ETIMEDOUT/.test(String(e.code)),
      output: tail(`${e.stdout || ''}${e.stderr || ''}` || e.message),
    };
  }
}

const tail = (s, n = 4000) => {
  const t = String(s);
  return t.length > n ? '…' + t.slice(-n) : t;
};

// ---------------------------------------------------------------------------
// Verifying the verifier
// ---------------------------------------------------------------------------
//
// A passing test is only as meaningful as the test's ability to fail. So after
// verify_command passes, we break the file on purpose and check the command
// notices. Cheapest probe first: if replacing the file with garbage does not
// fail the command, the command never touches this file and nothing finer is
// worth measuring.
//
// Every probe restores the real content in a finally block, and the restoration
// is confirmed by hash before returning. A probe must never be able to leave the
// file in a mutated state.

export function probeVerifier(abs, finalContent, beforeContent, command, cwd, timeoutMs, maxProbes = 3) {
  const finalSha = sha256(finalContent);
  const results = [];
  let destroyed = null;

  const runOn = (content) => {
    fs.writeFileSync(abs, content, 'utf8');
    return runVerification(command, cwd, timeoutMs);
  };

  try {
    // Probe 0 — total destruction.
    const d = destructionProbe(finalContent);
    const dRes = runOn(d.content);
    destroyed = dRes.passed ? 'survived' : 'caught';
    results.push({ ...stripContent(d), caught: !dRes.passed, exit_code: dRes.exit_code });

    if (destroyed === 'caught') {
      const ext = path.extname(abs).toLowerCase();
      const lines = changedLines(beforeContent, finalContent);
      const mutants = generateMutants(finalContent, lines, Math.max(0, maxProbes - 1), ext);
      for (const mut of mutants) {
        const r = runOn(mut.content);
        results.push({ ...stripContent(mut), caught: !r.passed, exit_code: r.exit_code });
      }
    }
  } finally {
    // Always put the real content back, and prove it went back.
    fs.writeFileSync(abs, finalContent, 'utf8');
    const restored = sha256(fs.readFileSync(abs, 'utf8'));
    if (restored !== finalSha) {
      throw new EditError(
        `PROBE RECOVERY FAILED: after testing your verify_command the file could not be restored. ` +
        `Expected ${finalSha.slice(0, 12)}…, found ${restored.slice(0, 12)}…. Restore from the backup immediately.`
      );
    }
  }

  const survivors = results.filter((r) => !r.caught);
  const ran = results.length;
  return { ...summarise(destroyed, survivors, ran), probes_run: ran, probes: results, survived: survivors };
}

const stripContent = ({ content, ...rest }) => rest;

export function editFile(abs, { edits, expect_sha256, dry_run = false, stamp, check_structure = true, allow_removals = [], verify_command, verify_cwd, verify_timeout_ms, verify_the_verifier = true, max_probes = 3, require_trustworthy_verification = false }) {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new EditError('edits must be a non-empty array');
  }
  const before = assertUnchanged(abs, expect_sha256);
  const plan = planEdits(before.content, edits);
  const after = applyPlan(before.content, plan);

  const replacements = plan.reduce((n, p) => n + p.count, 0);

  if (after === before.content) {
    // Cannot happen with a well-formed plan, but if it ever did, saying so is
    // the whole point of this server.
    throw new EditError('Every edit matched, but the resulting content is identical to the original. Nothing was written.');
  }

  const result = {
    path: abs,
    dry_run,
    edits_applied: plan.length,
    replacements,
    per_edit: plan.map((p) => ({ edit: p.idx, replacements: p.count, lines: p.offsets.map((o) => lineOf(before.content, o)) })),
    sha256_before: before.sha256,
    sha256_after: sha256(after),
    diff: diff(before.content, after),
  };

  // Gate 1: does the file still provide everything it provided before?
  // Runs on the in-memory result, so a refusal never touches the disk.
  if (check_structure) {
    result.structure = structuralGate(abs, before.content, after, allow_removals);
  } else {
    result.structure = { checked: false, warning: 'structural checking was switched off for this call' };
  }

  if (dry_run) {
    result.note = 'Nothing was written. Re-send with dry_run:false and expect_sha256 to apply.';
    return result;
  }

  const backupId = backup(abs, before.content, stamp);
  const written = atomicWrite(abs, after);
  if (written !== result.sha256_after) {
    throw new EditError(`Post-write verification failed: expected ${result.sha256_after.slice(0, 12)}…, file on disk is ${written.slice(0, 12)}…`);
  }
  result.backup_id = backupId;
  result.verified = true;

  // Gate 2: does it still WORK? Only the caller knows what proves that, so they
  // name the command. A failure rolls the file back to exactly what it was.
  if (verify_command) {
    const cwd = verify_cwd || path.dirname(abs);
    const v = runVerification(verify_command, cwd, verify_timeout_ms);
    result.verification = v;
    if (!v.passed) {
      atomicWrite(abs, before.content);
      result.rolled_back = true;
      result.sha256_after = before.sha256;
      throw new EditError(
        `The edit applied but your verification command failed, so the file was ROLLED BACK to its previous content. ` +
        `Command: ${verify_command.join(' ')} (exit ${v.exit_code}${v.timed_out ? ', timed out' : ''}).`,
        { verification: v, rolled_back: true, backup_id: backupId, structure: result.structure, diff_that_was_reverted: result.diff }
      );
    }

    // It passed. But is passing informative? Break the file on purpose and see.
    if (verify_the_verifier && max_probes > 0) {
      const trust = probeVerifier(abs, after, before.content, verify_command, cwd, verify_timeout_ms, max_probes);
      result.verification_trust = trust;

      if (trust.trustworthy === false && require_trustworthy_verification) {
        atomicWrite(abs, before.content);
        result.rolled_back = true;
        result.sha256_after = before.sha256;
        throw new EditError(
          `ROLLED BACK. Your verification passed, but it also passed on deliberately broken versions of this file, ` +
          `so its green result proves nothing about this edit. ${trust.verdict}`,
          { verification: v, verification_trust: trust, rolled_back: true, backup_id: backupId, diff_that_was_reverted: result.diff }
        );
      }
    }
  }
  return result;
}

export function writeFile(abs, { content, expect_sha256, create_only = false, stamp }) {
  if (typeof content !== 'string') throw new EditError('content must be a string');
  const exists = fs.existsSync(abs);
  if (create_only && exists) {
    throw new EditError(`Refusing to overwrite: ${abs} already exists and create_only was set.`);
  }
  if (exists && expect_sha256 === undefined && !create_only) {
    throw new EditError(
      `Refusing to overwrite an existing file blindly. Read it first and pass expect_sha256, or pass expect_sha256:"*" to overwrite deliberately.`
    );
  }
  let beforeContent = '';
  let backupId = null;
  if (exists) {
    const before = expect_sha256 === '*' ? readFile(abs) : assertUnchanged(abs, expect_sha256);
    beforeContent = before.content;
    backupId = backup(abs, beforeContent, stamp);
  }
  const shaAfter = atomicWrite(abs, content);
  return {
    path: abs,
    created: !exists,
    backup_id: backupId,
    sha256_before: exists ? sha256(beforeContent) : null,
    sha256_after: shaAfter,
    bytes: Buffer.byteLength(content, 'utf8'),
    diff: exists ? diff(beforeContent, content) : '(new file)',
    verified: true,
  };
}

// Line-addressed replacement, for when the text you want to change is not
// unique but its position is. The caller asserts what it expects to find there,
// so a shifted file is caught instead of silently mangled.
export function replaceLines(abs, { start_line, end_line, expect_text, new_text, expect_sha256, dry_run = false, stamp }) {
  const before = assertUnchanged(abs, expect_sha256);
  const lines = before.content.split('\n');
  if (!Number.isInteger(start_line) || !Number.isInteger(end_line) || start_line < 1 || end_line < start_line) {
    throw new EditError('start_line and end_line must be integers with 1 <= start_line <= end_line');
  }
  if (end_line > lines.length) {
    throw new EditError(`end_line ${end_line} is past the end of the file (${lines.length} lines).`);
  }
  const current = lines.slice(start_line - 1, end_line).join('\n');
  if (expect_text !== undefined && current !== expect_text) {
    throw new EditError(
      `Lines ${start_line}-${end_line} do not contain what you expected, so the file has probably shifted. Nothing was written.`,
      { expected: expect_text, actual: current }
    );
  }
  const after = [...lines.slice(0, start_line - 1), ...String(new_text).split('\n'), ...lines.slice(end_line)].join('\n');
  const result = {
    path: abs, dry_run, start_line, end_line,
    sha256_before: before.sha256, sha256_after: sha256(after),
    diff: diff(before.content, after),
  };
  if (dry_run) { result.note = 'Nothing was written.'; return result; }
  result.backup_id = backup(abs, before.content, stamp);
  atomicWrite(abs, after);
  result.verified = true;
  return result;
}
