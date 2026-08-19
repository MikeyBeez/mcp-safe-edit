// The specification.
//
// Every spec format in circulation says what must PASS. That is the half a
// generator can game: rebuild the file until the listed tests go green and you
// are done, whether or not the result is right. The measured overfitting rate
// for exactly that loop is 22-33%, and it gets WORSE with refinement, because
// iterating against a checker is how you learn to satisfy the checker.
//
// So this spec records both halves:
//
//   must_pass  — the verification command, as usual
//   must_fail  — specific deliberate breakages that HAVE to make it fail
//
// The second half is what cannot be gamed. You cannot satisfy "the suite must
// fail when this line becomes a * b" by writing a * b. It is a claim about the
// tests' power to discriminate, checked by running it, and it is the thing that
// catches a suite quietly weakening over time.

import fs from 'node:fs';
import path from 'node:path';
import { sha256, readFile } from './core.js';
import { functionTree } from './functions.js';
import { functionCoverage } from './coverage.js';

export const SPEC_VERSION = 1;

export function buildSpec(abs, content, runVerification, opts = {}) {
  const cov = functionCoverage(abs, content, runVerification, opts);
  const tree = functionTree(abs, content);

  const spec = {
    spec_version: SPEC_VERSION,
    file: abs,
    file_sha256: sha256(content),
    generated_at: opts.stamp || null,
    verify_command: opts.verify_command || null,
    verify_cwd: opts.verify_cwd || null,
    checkable: cov.checkable,
    reason: cov.reason || null,
    functions: {},
  };

  for (const f of tree.functions) {
    if (f.kind === 'class') continue;
    const probed = (cov.functions || []).find((c) => c.name === f.name);
    spec.functions[f.name] = {
      kind: f.kind,
      required: true,
      lines: f.lines,
      // Deliberately NOT storing start/end lines as a requirement: a function
      // moving down the file is not a violation, and pinning line numbers would
      // make the spec fail on every unrelated edit above it.
      watched: probed ? probed.status === 'watched' : null,
      status: probed ? probed.status : 'not-probed',
      must_fail: probed && probed.attempts
        ? probed.attempts.filter((a) => a.caught).map((a) => ({ rule: a.rule, change: a.change }))
        : [],
      gap: probed && probed.status === 'UNWATCHED'
        ? 'nothing in the verification would notice if this function broke — a test here would buy you something'
        : null,
    };
  }

  const fns = Object.values(spec.functions);
  spec.summary = {
    functions: fns.length,
    watched: fns.filter((f) => f.watched === true).length,
    unwatched: fns.filter((f) => f.watched === false).length,
    not_probed: fns.filter((f) => f.watched === null).length,
    falsifications_recorded: fns.reduce((n, f) => n + f.must_fail.length, 0),
  };
  return spec;
}

export function writeSpec(specPath, spec) {
  fs.mkdirSync(path.dirname(specPath), { recursive: true });
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 2) + '\n', 'utf8');
  return specPath;
}

export const readSpec = (specPath) => JSON.parse(fs.readFileSync(specPath, 'utf8'));

// Check a file against its spec. Three questions, in the order that matters:
//
//   1. Is every required function still here?          (the file lost something)
//   2. Does the verification still pass?               (the file broke)
//   3. Do the recorded falsifications still falsify?   (the TESTS got weaker)
//
// The third is the one nothing else checks. If a breakage that used to fail the
// suite now passes it, the suite has been weakened — an assertion deleted, a
// test skipped, an expectation loosened to make something go green. That change
// is invisible to every other gate, including a full green run.
export function checkSpec(abs, content, spec, runVerification, { probe = true } = {}) {
  const tree = functionTree(abs, content);
  const result = { file: abs, spec_version: spec.spec_version, violations: [], warnings: [], checks: [] };

  if (!tree.understood) {
    result.violations.push({ kind: 'unparseable', detail: tree.reason });
    return finish(result);
  }
  if (tree.parse_error) {
    result.violations.push({ kind: 'parse_error', detail: tree.parse_error });
    return finish(result);
  }

  // 1. presence
  const present = new Set(tree.functions.map((f) => f.name));
  const missing = Object.entries(spec.functions).filter(([n, s]) => s.required && !present.has(n)).map(([n]) => n);
  result.checks.push({ check: 'required functions present', passed: missing.length === 0, missing });
  for (const m of missing) result.violations.push({ kind: 'function_missing', function: m, detail: `the spec requires ${m} and the file no longer defines it` });

  const added = [...present].filter((n) => !(n in spec.functions));
  if (added.length) result.warnings.push({ kind: 'new_functions', detail: `not in the spec, so nothing requires them: ${added.join(', ')}` });

  if (!probe) return finish(result);

  // 2. does it still pass
  const live = runVerification(content);
  result.checks.push({ check: 'verification passes', passed: live.passed, exit_code: live.exit_code });
  if (!live.passed) {
    result.violations.push({ kind: 'verification_failed', detail: `the verification command fails on the current file (exit ${live.exit_code})` });
    return finish(result); // no point probing a red suite
  }

  // 3. do the falsifications still falsify
  const originalSha = sha256(content);
  const eroded = [];
  try {
    for (const [name, s] of Object.entries(spec.functions)) {
      for (const mf of s.must_fail) {
        const applied = applyRecordedChange(content, mf.change);
        if (!applied) { result.warnings.push({ kind: 'falsification_unreplayable', function: name, detail: `the recorded breakage no longer matches the file: ${mf.change}` }); continue; }
        fs.writeFileSync(abs, applied, 'utf8');
        const r = runVerification(applied);
        if (r.passed) eroded.push({ function: name, rule: mf.rule, change: mf.change });
      }
    }
  } finally {
    fs.writeFileSync(abs, content, 'utf8');
    if (sha256(fs.readFileSync(abs, 'utf8')) !== originalSha) {
      throw new Error(`SPEC CHECK RECOVERY FAILED for ${abs} — restore from a backup immediately.`);
    }
  }

  result.checks.push({ check: 'recorded falsifications still fail', passed: eroded.length === 0, eroded });
  for (const e of eroded) {
    result.violations.push({
      kind: 'test_erosion',
      function: e.function,
      detail: `"${e.change}" used to fail the verification and now passes it. The tests got weaker, not the code. Something was deleted, skipped or loosened.`,
    });
  }
  return finish(result);
}

// A recorded change is stored as "old line => new line". Replay it literally:
// if the old line is no longer in the file, say so rather than guessing.
function applyRecordedChange(content, change) {
  const i = change.lastIndexOf(' => ');
  if (i === -1) return null;
  const from = change.slice(0, i).trim();
  const to = change.slice(i + 4).trim();
  const lines = content.split('\n');
  const idx = lines.findIndex((l) => l.trim() === from);
  if (idx === -1) return null;
  const out = [...lines];
  out[idx] = lines[idx].replace(from, to);
  return out.join('\n');
}

function finish(result) {
  result.passed = result.violations.length === 0;
  result.verdict = result.passed
    ? `Meets the spec: every required function is present${result.checks.some((c) => c.check === 'verification passes') ? ', the verification passes, and every recorded breakage still breaks it' : ''}.`
    : `${result.violations.length} violation${result.violations.length === 1 ? '' : 's'}: ${result.violations.map((v) => v.kind).join(', ')}.`;
  return result;
}
