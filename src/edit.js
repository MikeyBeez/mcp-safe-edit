// The edit operations themselves. Separate from the MCP plumbing so they can be
// tested directly, and so the server file stays thin enough to read in one go.

import fs from 'node:fs';
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

export function editFile(abs, { edits, expect_sha256, dry_run = false, stamp }) {
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
