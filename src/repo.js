// Repo scale.
//
// One file at a time answers "is this function watched". A repo answers the
// question you actually have: where, across everything I have built, could I
// break something and have nothing complain.
//
// Two constraints shape this. Every probe costs a full run of the verification,
// so the work is bounded by an explicit budget and anything dropped is NAMED -
// a silently truncated report reads as "I checked everything" when it did not.
// And probing mutates a file in place, so files are done ONE AT A TIME: the
// verification runs over the whole repo, and two files mutated at once would
// each read the other's breakage as its own. That is the concurrency bug this
// server already fixed at file scale, returning at repo scale in a new hat.

import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from './core.js';
import { functionCoverage } from './coverage.js';
import { establishBaseline, confirmBaseline } from './runner.js';

const SOURCE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.py']);
const SKIP_DIR = new Set([
  'node_modules', '.git', '.venv', 'venv', 'dist', 'build', 'coverage',
  '__pycache__', '.next', '.cache', 'vendor', 'third_party', '.pytest_cache',
]);

const looksLikeTest = (rel) =>
  /(^|\/)(test|tests|spec)(\/|$)/.test(rel) ||
  /\.(test|spec)\.[a-z]+$/.test(rel) ||
  /(^|\/)test_[^/]*\.py$/.test(rel) ||
  /(^|\/)conftest\.py$/.test(rel);

export function discoverSources(root, { max_files = 500, skip_tests = true } = {}) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 8 || out.length >= max_files) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= max_files) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIR.has(e.name) || e.name.startsWith('.')) continue;
        walk(full, depth + 1);
      } else if (e.isFile()) {
        if (!SOURCE_EXT.has(path.extname(e.name).toLowerCase())) continue;
        // Test files are the thing doing the watching. Probing them asks whether
        // the tests test the tests, which is a different question.
        if (skip_tests && looksLikeTest(full.slice(root.length))) continue;
        out.push(full);
      }
    }
  };
  walk(root, 0);
  return out.sort();
}

const stateFile = (root) => path.join(root, '.safe-edit-repo-state.json');
const loadState = (root) => {
  try { return JSON.parse(fs.readFileSync(stateFile(root), 'utf8')); } catch { return { files: {} }; }
};
const saveState = (root, state) => {
  try { fs.writeFileSync(stateFile(root), JSON.stringify(state, null, 2) + '\n'); } catch { /* best effort */ }
};

// A cached per-file result is reusable only when BOTH the file and the thing
// doing the watching are unchanged. The file's own hash is not enough: a
// rewritten test suite changes the answer for a file that never moved.
const fingerprintOf = (command, cwd, testsHash) =>
  sha256(`${JSON.stringify(command)} ${cwd} ${testsHash}`).slice(0, 16);

// Hash whatever the verification reads. We cannot know that in general, so hash
// every test-looking file in the tree. Imperfect, and imperfect in the safe
// direction: a change anywhere in the tests invalidates every cached result.
export function hashTests(root) {
  const parts = [];
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIR.has(e.name) || e.name.startsWith('.')) continue;
        walk(full, depth + 1);
      } else if (looksLikeTest(full.slice(root.length))) {
        try { parts.push(`${full}:${sha256(fs.readFileSync(full, 'utf8'))}`); } catch { /* skip */ }
      }
    }
  };
  walk(root, 0);
  return sha256(parts.sort().join('\n')).slice(0, 16);
}

export function repoReport(root, runner, {
  max_files = 60,
  max_runs_total = 400,
  // A sweep takes minutes; an MCP client gives a tool call 60 seconds. So a
  // call does a BOUNDED amount of work and returns what is left, and the caller
  // calls again. The incremental state makes that free - the next call reuses
  // everything already done. Discovered by running a real sweep and watching
  // the client time out at exactly 60000ms.
  time_budget_ms = 45000,
  mutants_per_function = 1,
  max_functions_per_file = 12,
  baseline_samples = 2,
  incremental = true,
  files = null,
  stamp = null,
} = {}) {
  const started = Date.now();

  // One baseline for the whole sweep. If the suite is red, flaky or missing,
  // nothing below can be measured, and saying so once is the whole answer.
  const baseline = establishBaseline(runner, { samples: 3 });
  if (!baseline.usable) {
    return { root, checkable: false, baseline, reason: baseline.reason, files: [] };
  }

  const testsHash = hashTests(root);
  const fingerprint = fingerprintOf(runner.command, runner.cwd, testsHash);
  const state = incremental ? loadState(root) : { files: {} };

  const targets = files || discoverSources(root, { max_files: 1000 });
  const report = {
    root, checkable: true, baseline, fingerprint, generated_at: stamp,
    files: [], skipped: [], reused: 0, probed: 0, runs: 0,
  };

  let budget = max_runs_total;
  let done = 0;

  const remaining = [];
  for (const file of targets) {
    if (done >= max_files) { remaining.push(file); report.skipped.push(`${file} (file budget of ${max_files} spent)`); continue; }
    if (budget <= 0) { remaining.push(file); report.skipped.push(`${file} (run budget of ${max_runs_total} spent)`); continue; }
    if (Date.now() - started > time_budget_ms) { remaining.push(file); report.skipped.push(`${file} (time budget of ${time_budget_ms}ms spent - call again to continue)`); continue; }

    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch { report.skipped.push(`${file} (unreadable)`); continue; }
    const fileSha = sha256(content);
    const prior = state.files[file];

    if (incremental && prior && prior.sha === fileSha && prior.fingerprint === fingerprint) {
      report.files.push({ ...prior.summary, file, reused: true });
      report.reused++;
      continue;
    }

    const cov = functionCoverage(file, content, runner, {
      mutants_per_function,
      max_functions: max_functions_per_file,
      max_runs: Math.min(budget, max_functions_per_file * mutants_per_function + 2),
      baseline_samples: 0,
      inherited_baseline: baseline,
    });
    budget -= cov.runs || 0;
    report.runs += cov.runs || 0;
    report.probed++;
    done++;

    const summary = cov.checkable === false
      ? { file, checkable: false, reason: cov.reason, unwatched: [], watched: 0, functions: 0 }
      : {
          file,
          checkable: true,
          functions: cov.summary?.total_functions ?? 0,
          probed: cov.summary?.probed ?? 0,
          watched: cov.summary?.watched ?? 0,
          unwatched: (cov.functions || []).filter((f) => f.status === 'UNWATCHED')
            .map((f) => ({ name: f.name, lines: f.lines, start_line: f.start_line })),
          inconclusive: cov.summary?.inconclusive ?? 0,
        };

    report.files.push(summary);
    state.files[file] = { sha: fileSha, fingerprint, summary, at: stamp };
  }

  // One drift check for the whole sweep rather than one per file.
  if (report.probed > 0) {
    const drift = confirmBaseline(runner, baseline, { samples: 2 });
    report.baseline_after = drift;
    if (!drift.stable) {
      return { root, checkable: false, baseline, baseline_after: drift, reason: drift.reason, files: [] };
    }
  }

  if (incremental) saveState(root, state);

  // Ranked by the size of what nothing is watching, because that is the order
  // in which writing a test buys the most.
  const checkable = report.files.filter((f) => f.checkable);
  const unwatched = checkable.flatMap((f) => (f.unwatched || []).map((u) => ({ ...u, file: f.file })));
  unwatched.sort((a, b) => b.lines - a.lines);

  report.summary = {
    files_seen: targets.length,
    files_probed: report.probed,
    files_reused: report.reused,
    files_skipped: report.skipped.length,
    files_unmeasurable: report.files.filter((f) => !f.checkable).length,
    functions_watched: checkable.reduce((n, f) => n + (f.watched || 0), 0),
    functions_unwatched: unwatched.length,
    top_unwatched: unwatched.slice(0, 25),
    elapsed_ms: Date.now() - started,
    remaining: remaining.length,
    complete: remaining.length === 0,
    next_step: remaining.length
      ? `${remaining.length} files still to probe. Call safe_repo_report again with the same arguments - everything already measured is reused, so the sweep resumes rather than restarts.`
      : 'The sweep covered every discovered source file.',
    verdict: unwatched.length === 0
      ? 'Nothing measured came back unwatched.'
      : `${unwatched.length} functions across ${new Set(unwatched.map((u) => u.file)).size} files could be broken without your verification noticing. Largest: ${unwatched.slice(0, 3).map((u) => `${path.basename(u.file)}:${u.name} (${u.lines} lines)`).join(', ')}.`,
  };
  return report;
}
