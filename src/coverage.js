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
import { generateMutants, destructionProbe, nullProbe } from './probe.js';
import { establishBaseline, classifyProbe, confirmBaseline } from './runner.js';

// Only ask about functions where the answer means something. A one-line getter
// that nothing watches is not news; a forty-line dispatcher that nothing watches
// is the finding.
const isWorthProbing = (f) => f.kind !== 'class' && f.lines >= 1;

export function functionCoverage(abs, content, runVerification, {
  mutants_per_function = 1,
  max_functions = 25,
  max_runs = 60,
  include = null,
  baseline_samples = 3,
  inherited_baseline = null,
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
  const run = (c) => runVerification(c, abs);

  // An exclusive lock. Two sweeps on the same file interleave their mutants,
  // and each then reads the OTHER's breakage as its own being caught - an
  // adversarial review produced a fabricated 'watched' that way. A stale lock
  // older than an hour is broken rather than deadlocking forever.
  const lockPath = `${abs}.safe-edit-lock`;
  let lockFd = null;
  try {
    lockFd = fs.openSync(lockPath, 'wx');
  } catch {
    let stale = false;
    try { stale = (Date.now() - fs.statSync(lockPath).mtimeMs) > 3600000; } catch { stale = true; }
    if (stale) { try { fs.unlinkSync(lockPath); lockFd = fs.openSync(lockPath, 'wx'); } catch { /* fall through */ } }
    if (lockFd === null) {
      return { checkable: false, reason: `another probe sweep is already running on ${abs}. Concurrent sweeps interleave their mutants and each reads the other's breakage as its own, so this one refuses rather than reporting a fabricated result.`, functions: [] };
    }
  }
  const releaseLock = () => { try { fs.closeSync(lockFd); } catch {} try { fs.unlinkSync(lockPath); } catch {} };

  const report = { checkable: true, functions: [], runs: 0, skipped: [] };

  // Nothing below may be believed until the suite is shown green and stable on
  // the unmodified file. A red or flaky baseline makes every mutant look caught.
  // baseline_samples: 0 means the CALLER already established a green, stable
  // baseline for this exact command and passes it in. A repo sweep does that
  // once instead of once per file; with a 20-second suite, re-establishing it
  // per file spent the entire time budget before a single probe ran.
  const baseline = (baseline_samples === 0 && inherited_baseline)
    ? inherited_baseline
    : establishBaseline(runVerification, { samples: baseline_samples });
  report.baseline = baseline;
  if (!baseline.usable) {
    releaseLock();
    report.checkable = false;
    report.reason = baseline.reason;
    return report;
  }

  try {
    // Does the command check what this file DOES, or merely what its bytes are?
    // A snapshot, checksum or lint rule objects to garbage without executing a
    // line, and then every mutant looks caught for the wrong reason.
    const np = nullProbe(content, ext);
    if (np) {
      write(np.content);
      const npRes = classifyProbe(run(np.content));
      runs++;
      report.null_probe = { caught: npRes.caught, note: npRes.note };
      if (npRes.caught) {
        report.checkable = false;
        report.reason = 'the verification FAILS on a change that cannot alter behaviour (a single appended comment), so it is checking the file bytes rather than what the file does. Every mutant would be caught for that reason alone and no coverage claim is possible.';
        return report;
      }
    }
    // Does the verifier touch this file at all? If not, nothing below matters.
    const d = destructionProbe(content, abs);
    write(d.content);
    const dRes = classifyProbe(run(d.content));
    runs++;
    if (!dRes.caught) {
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
      let inconclusive = 0;
      for (const mut of mutants) {
        if (runs >= max_runs) break;
        write(mut.content);
        const c = classifyProbe(run(mut.content));
        runs++;
        attempts.push({ rule: mut.rule, line: mut.line, change: `${mut.before} => ${mut.after}`, caught: c.caught, conclusive: c.conclusive, note: c.note });
        if (c.caught) caughtAny = true;
        if (!c.conclusive) inconclusive++;
      }

      const allInconclusive = attempts.length > 0 && attempts.every((a) => !a.conclusive);
      report.functions.push({
        name: f.name, kind: f.kind, lines: f.lines, start_line: f.start_line,
        inconclusive_probes: inconclusive,
        status: allInconclusive ? 'inconclusive' : (caughtAny ? 'watched' : 'UNWATCHED'),
        note: caughtAny
          ? 'a deliberate change here failed the verification, so something is checking this'
          : 'a deliberate change here did NOT fail the verification — nothing would notice if this function broke',
        attempts,
      });
    }
  } finally {
    write(content);
    const restored = sha256(fs.readFileSync(abs, 'utf8'));
    releaseLock();
    if (restored !== originalSha) {
      throw new Error(`COVERAGE PROBE RECOVERY FAILED for ${abs}: expected ${originalSha.slice(0, 12)}, found ${restored.slice(0, 12)}. Restore from a backup immediately.`);
    }
  }

  report.runs = runs;
  const watched = report.functions.filter((f) => f.status === 'watched');
  const unwatched = report.functions.filter((f) => f.status === 'UNWATCHED');
  const inconclusive = report.functions.filter((f) => f.status === 'inconclusive');
  const unprobeable = report.functions.filter((f) => f.status === 'not-probeable');
  report.summary = {
    total_functions: tree.functions.filter(isWorthProbing).length,
    probed: report.functions.length,
    watched: watched.length,
    unwatched: unwatched.length,
    not_probeable: unprobeable.length,
    inconclusive: inconclusive.length,
    unwatched_names: unwatched.map((f) => f.name),
    verdict: unwatched.length === 0
      ? `Every function probed is watched: a deliberate change to any of them fails your verification.`
      : `${unwatched.length} of ${report.functions.length} probed functions are UNWATCHED — you could break them and your verification would still pass. Largest first: ${unwatched.slice(0, 5).map((f) => `${f.name} (${f.lines} lines)`).join(', ')}.`,
  };
  // Did running the sweep change how the verification behaves? A suite that
  // leaves state behind degrades as it is invoked, and the up-front sample
  // cannot see that. If it moved, every result above is void.
  if (baseline_samples !== 0) {
    const drift = confirmBaseline(runVerification, baseline, { samples: 2 });
    report.baseline_after = drift;
    if (!drift.stable) {
      report.checkable = false;
      report.reason = drift.reason;
      report.functions = [];
      return report;
    }
  }

  if (typeof runVerification.stats === 'function') report.cache = runVerification.stats();
  void lines;
  return report;
}
