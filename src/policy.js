// How much to verify.
//
// Verifying everything on every edit is correct and unaffordable: each probe is
// a full run of the suite, so a 20-second suite times twenty functions is a
// seven-minute wait to change one line. So the amount of verification scales
// with the edit, and the ladder is explicit rather than a fixed maximum:
//
//   structural  0 runs   AST gate only. A comment, whitespace, a declared
//                        no-op. Instant.
//   smoke       1 run    Run the suite once, pass/fail, roll back on fail.
//                        "Did my change break anything." No probing.
//   changed     1 + k    smoke, then probe ONLY the functions this edit touched.
//                        "...and is my change actually watched." k = touched fns.
//   full        1 + n    changed, but probe every function. "Everything,
//                        occasionally." n = all fns.
//
// auto picks from the size of the edit. And because a long run of small
// changed-only edits can accumulate an interaction bug that only a full pass
// would catch - function A's edit quietly breaking function B - auto ESCALATES
// to full when enough small edits, or enough time, have passed since the last
// full check. That is the "test occasionally because of latency" part: cheap by
// default, thorough on a schedule.

import fs from 'node:fs';
import path from 'node:path';
import { sha256, BACKUP_ROOT } from './core.js';
import { changedLines } from './probe.js';
import { functionTree, functionAtLine } from './functions.js';

export const LEVELS = ['structural', 'smoke', 'changed', 'full'];
const rank = (l) => LEVELS.indexOf(l);

// Which lines changed carry actual code, not just comments or blank space?
// A pure-comment edit needs no test run; a one-token logic change does.
const isWholeComment = (line) => {
  const t = line.trim();
  return t === '' || t.startsWith('//') || t.startsWith('#') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('*/');
};
// Drop only lines that are ENTIRELY a comment or blank, then compare. If the
// remainder is identical, the edit changed no code. Conservative on purpose: a
// comment appended to a code line leaves that line different, so it is NOT
// comment-only and still gets a run.
const codeSkeleton = (src) => src.split('\n').filter((l) => !isWholeComment(l)).map((l) => l.replace(/\s+$/, '')).join('\n');

export function editMetrics(abs, before, after, structureReport) {
  const lines = changedLines(before, after);
  const afterLines = after.split('\n');
  const commentOnly = codeSkeleton(before) === codeSkeleton(after);
  const codeLines = commentOnly ? [] : lines.filter((ln) => {
    const row = afterLines[ln - 1];
    return row !== undefined && !isWholeComment(row);
  });

  let touched = [];
  const tree = functionTree(abs, after);
  if (tree.understood && !tree.parse_error) {
    const set = new Set();
    for (const ln of lines) {
      const f = functionAtLine(tree.functions, ln);
      if (f) set.add(f.name);
    }
    touched = [...set];
  }

  const structureChanged = !!structureReport &&
    ((structureReport.added || []).length + (structureReport.removed || []).length +
     (structureReport.functions_added || []).length + (structureReport.functions_removed || []).length) > 0;

  return {
    changed_lines: lines.length,
    code_lines: codeLines.length,
    touched_functions: touched,
    structure_changed: structureChanged,
    comment_only: commentOnly,
  };
}

// State that lets auto escalate. Kept OUTSIDE the repo, keyed by the file's
// path, alongside backups - a scan artifact must never land in the tree.
const STATE_DIR = process.env.SAFE_EDIT_VERIFY_STATE
  || path.join(BACKUP_ROOT, '..', 'verify-state');
const stateFile = (abs) => path.join(STATE_DIR, `${sha256(abs).slice(0, 16)}.json`);

export function readVerifyState(abs) {
  try { return JSON.parse(fs.readFileSync(stateFile(abs), 'utf8')); }
  catch { return { edits_since_full: 0, last_full_at: null }; }
}
export function writeVerifyState(abs, state) {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(stateFile(abs), JSON.stringify(state, null, 2)); }
  catch { /* best effort; the policy still works, it just won't escalate */ }
}

// Choose the effort. Pure decision given metrics, state and thresholds, plus a
// `now` passed in so the decision is testable and the module never calls Date
// itself (which would make it non-deterministic to test).
export function choosePolicy(metrics, state, {
  max_changed_functions = 2,
  max_code_lines = 40,
  escalate_after_edits = 10,
  escalate_after_hours = 24,
  now = 0,
  has_verify_command = true,
} = {}) {
  // Without a verify_command there is nothing to run: structural is the ceiling.
  if (!has_verify_command) {
    return { effort: 'structural', reason: 'no verify_command given, so only the structural gate can run' };
  }

  // A comment or whitespace edit cannot change behaviour, so it is structural
  // and immune to escalation - a full pass would buy nothing.
  if (metrics.comment_only && !metrics.structure_changed) {
    return { effort: 'structural', reason: 'the edit changed only comments or whitespace and removed nothing, so no behaviour could have changed' };
  }

  let effort, reason;
  if (metrics.touched_functions.length <= max_changed_functions && metrics.code_lines <= max_code_lines && !metrics.structure_changed) {
    effort = 'changed';
    reason = `a small edit: ${metrics.code_lines} code line(s) in ${metrics.touched_functions.length} function(s), so only those are probed`;
  } else {
    effort = 'full';
    reason = metrics.structure_changed
      ? 'the set of things this file provides changed, so the whole file is probed'
      : `a large edit: ${metrics.code_lines} code lines across ${metrics.touched_functions.length} functions, so the whole file is probed`;
  }

  // The occasional full pass. Only escalates UP, and only from below full.
  if (rank(effort) < rank('full')) {
    const overEdits = (state.edits_since_full || 0) >= escalate_after_edits;
    const hoursSince = state.last_full_at ? (now - state.last_full_at) / 3.6e6 : 0;
    const overTime = hoursSince >= escalate_after_hours;
    if (overEdits || overTime) {
      const why = overEdits
        ? `${state.edits_since_full} small edits since the last full check`
        : `${Math.round(hoursSince)}h since the last full check`;
      return { effort: 'full', reason: `${reason} - but escalated to a full check: ${why}. Small edits accumulate interaction risk that only a full pass catches.`, escalated: true };
    }
  }
  return { effort, reason };
}

// Fold the outcome of a run back into the state.
export function recordRun(state, effort, now) {
  if (effort === 'full') return { edits_since_full: 0, last_full_at: now };
  if (effort === 'structural') return state; // a comment edit is not behavioural
  return { edits_since_full: (state.edits_since_full || 0) + 1, last_full_at: state.last_full_at || null };
}
