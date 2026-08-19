// Which functions is anything actually watching?
//
// Line coverage tells you a line ran. It does not tell you anyone would notice
// if that line were wrong, which is the only question worth asking. So instead:
// take each function in turn, break it on purpose, run the verification command,
// and see whether it complains.
//
// A function whose deliberate breakage goes unnoticed is unverified. Not
// necessarily buggy — unverified. That distinction is the whole report. It says
// where a test would buy you something, instead of demanding one everywhere and
// filling the repo with assertions that cannot fail.

import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from './core.js';
import { functionTree } from './functions.js';
import { generateMutants, destructionProbe } from './probe.js';

// Only ask about functions where the answer means something. A one-line getter
// that nothing watches is not news; a forty-line dispatcher that nothing watches
// is the finding.
const isWorthProbing = (f) => f.kind !== 'class' && f.lines >= 1;

export function functionCoverage(abs, content, runVerification, {
  mutants_per_function = 1,
  max_functions = 25,
  max_runs = 60,
  include = null,
} = {}) {
  const tree = functionTree(abs, content);
  if (!tree.understood) {
    return { checkable: false, reason: tree.reason, functions: [] };
  }
  if (tree.parse_error) {
    return { checkable: false, reason: tree.parse_error, functions: [] };
  }

  const originalSha = sha256(content);
  const ext = path.extname(abs).toLowerCase();
  const lines = content.split('\n');
  let runs = 0;

  const write = (c) => fs.writeFileSync(abs, c, 'utf8');

  const report = { checkable: true, functions: [], runs: 0, skipped: [] };

  try {
    // Does the verifier touch this file at all? If not, nothing below matters.
    const d = destructionProbe(content);
    write(d.content);
    const dRes = runVerification();
    runs++;
    if (dRes.passed) {
      report.checkable = false;
      report.reason = 'the verification command passes even when this file is replaced with garbage, so it does not exercise this file at all';
      return report;
    }

    let candidates = tree.functions.filter(isWorthProbing);
    if (include) candidates = candidates.filter((f) => include.includes(f.name) || include.includes(f.short_name));
    // Biggest first: an unwatched large function is the more interesting finding,
    // and it keeps the useful answers inside a small run budget.
    candidates.sort((a, b) => b.lines - a.lines);
    if (candidates.length > max_functions) {
      report.skipped = candidates.slice(max_functions).map((f) => f.name);
      candidates = candidates.slice(0, max_functions);
    }

    for (const f of candidates) {
      if (runs >= max_runs) { report.skipped.push(`${f.name} (run budget spent)`); continue; }
      const range = [];
      for (let ln = f.start_line; ln <= f.end_line; ln++) range.push(ln);
      const mutants = generateMutants(content, range, mutants_per_function, ext);

      if (!mutants.length) {
        report.functions.push({
          name: f.name, kind: f.kind, lines: f.lines, start_line: f.start_line,
          status: 'not-probeable',
          note: 'no behaviour-changing mutation could be built here — the body is declarations, comments or pass-through code',
        });
        continue;
      }

      const attempts = [];
      let caughtAny = false;
      for (const mut of mutants) {
        if (runs >= max_runs) break;
        write(mut.content);
        const r = runVerification();
        runs++;
        attempts.push({ rule: mut.rule, line: mut.line, change: `${mut.before} => ${mut.after}`, caught: !r.passed });
        if (!r.passed) caughtAny = true;
      }

      report.functions.push({
        name: f.name, kind: f.kind, lines: f.lines, start_line: f.start_line,
        status: caughtAny ? 'watched' : 'UNWATCHED',
        note: caughtAny
          ? 'a deliberate change here failed the verification, so something is checking this'
          : 'a deliberate change here did NOT fail the verification — nothing would notice if this function broke',
        attempts,
      });
    }
  } finally {
    write(content);
    const restored = sha256(fs.readFileSync(abs, 'utf8'));
    if (restored !== originalSha) {
      throw new Error(`COVERAGE PROBE RECOVERY FAILED for ${abs}: expected ${originalSha.slice(0, 12)}…, found ${restored.slice(0, 12)}…. Restore from a backup immediately.`);
    }
  }

  report.runs = runs;
  const watched = report.functions.filter((f) => f.status === 'watched');
  const unwatched = report.functions.filter((f) => f.status === 'UNWATCHED');
  const unprobeable = report.functions.filter((f) => f.status === 'not-probeable');
  report.summary = {
    total_functions: tree.functions.filter(isWorthProbing).length,
    probed: report.functions.length,
    watched: watched.length,
    unwatched: unwatched.length,
    not_probeable: unprobeable.length,
    unwatched_names: unwatched.map((f) => f.name),
    verdict: unwatched.length === 0
      ? `Every function probed is watched: a deliberate change to any of them fails your verification.`
      : `${unwatched.length} of ${report.functions.length} probed functions are UNWATCHED — you could break them and your verification would still pass. Largest first: ${unwatched.slice(0, 5).map((f) => `${f.name} (${f.lines} lines)`).join(', ')}.`,
  };
  void lines;
  return report;
}
