// Running the verification, and knowing what the result means.
//
// Everything above this file reads "the suite failed" as "the mutant was
// caught". Three things break that reading, and all three make the tool lie in
// the confident direction, which is worse than not measuring at all, because a
// number launders a guess.
//
//   1. A suite that was ALREADY failing. Then every mutant looks caught.
//   2. A FLAKY suite. Then caught mutants are manufactured at random.
//   3. A CRASH or TIMEOUT. The runner not starting is not the tests objecting.
//
// So a verification result is no longer a boolean. It is an outcome, and only
// one of the outcomes counts as a mutant being caught.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { BACKUP_ROOT } from './core.js';

const tail = (s, n = 4000) => { const t = String(s); return t.length > n ? '...' + t.slice(-n) : t; };

// Outcomes:
//   passed   exit 0
//   failed   exit non-zero: the tests objected. ONLY this counts as caught.
//   timeout  took too long. Inconclusive: it may be an infinite loop the mutant
//            caused, or just a slow machine.
//   crashed  the command could not run at all (ENOENT, permission). Says
//            nothing whatsoever about the code.
export function runOnce(command, cwd, timeoutMs = 120000) {
  if (!Array.isArray(command) || !command.length || command.some((c) => typeof c !== 'string')) {
    throw new Error('verify_command must be an array of strings, e.g. ["npm","test"]. It is executed directly, never through a shell.');
  }
  const [cmd, ...args] = command;
  const started = Date.now();
  try {
    const stdout = execFileSync(cmd, args, { cwd, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
    return { outcome: 'passed', exit_code: 0, ms: Date.now() - started, output: tail(stdout) };
  } catch (e) {
    const ms = Date.now() - started;
    const out = tail(`${e.stdout || ''}${e.stderr || ''}` || e.message);
    if (e.code === 'ETIMEDOUT' || e.signal === 'SIGTERM') return { outcome: 'timeout', exit_code: null, ms, output: out };
    if (e.code === 'ENOENT' || e.code === 'EACCES' || e.status === undefined) {
      return { outcome: 'crashed', exit_code: e.status ?? null, ms, output: out, error: e.code || e.message };
    }
    return { outcome: 'failed', exit_code: e.status, ms, output: out };
  }
}

export const passedOf = (r) => r.outcome === 'passed';

// Caching, and the assumption that nearly made it lie.
//
// The first version keyed the cache on (probed file content, command, cwd), on
// the reasoning that a probe result is a pure function of those. It is not. The
// command's result also depends on every OTHER file in the repo - the test files
// most of all. A test suite rewritten between runs produces a different answer
// for byte-identical input, and a disk cache keyed the old way happily served
// the stale one. Its own test caught it: a function known to be unwatched came
// back watched, from a cached run of a stronger suite.
//
// So the default is memoisation for the lifetime of ONE runner, which is always
// sound because nothing else changes inside a single probe sweep. A disk cache
// is opt-in and requires the caller to name a scope - a git SHA, a lockfile
// hash - asserting what it is that has not changed. If you cannot name it, you
// do not get to cache it.
const CACHE_DIR = process.env.SAFE_EDIT_CACHE || path.join(BACKUP_ROOT, '..', 'probe-cache');
// The key must include WHICH FILE the content belongs to. Two byte-identical
// files - a vendored copy, a monorepo duplicate, a generated stub - are not
// interchangeable: one may be exercised by the suite and the other not. An
// adversarial review proved this: probing a tested file then a byte-identical
// untested copy returned 4 cache hits, 0 runs, and reported the untested copy
// as fully watched.
const keyOf = (scope, target, content, command, cwd) =>
  crypto.createHash('sha256').update(`${scope}\u0000${target}\u0000${content}\u0000${JSON.stringify(command)}\u0000${cwd || ''}`).digest('hex');

export function makeRunner(command, cwd, timeoutMs = 120000, { cache_scope = null } = {}) {
  let hits = 0, misses = 0;
  const memo = new Map();

  const run = (content, target = '') => {
    if (content === undefined) { misses++; return runOnce(command, cwd, timeoutMs); }
    const memoKey = keyOf('memo', target, content, command, cwd);
    if (memo.has(memoKey)) { hits++; return { ...memo.get(memoKey), cached: 'memory' }; }

    let onDisk = null;
    if (cache_scope) {
      try { onDisk = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `${keyOf(cache_scope, target, content, command, cwd)}.json`), 'utf8')); }
      catch { /* miss */ }
    }
    if (onDisk) { hits++; memo.set(memoKey, onDisk); return { ...onDisk, cached: 'disk' }; }

    misses++;
    const r = runOnce(command, cwd, timeoutMs);
    // Never cache an inconclusive result: a crash or timeout may be about the
    // machine, and freezing it would make a transient problem permanent.
    if (r.outcome === 'passed' || r.outcome === 'failed') {
      memo.set(memoKey, r);
      if (cache_scope) {
        try {
          fs.mkdirSync(CACHE_DIR, { recursive: true });
          fs.writeFileSync(path.join(CACHE_DIR, `${keyOf(cache_scope, target, content, command, cwd)}.json`), JSON.stringify(r));
        } catch { /* best effort */ }
      }
    }
    return r;
  };
  run.command = command; run.cwd = cwd; run.timeoutMs = timeoutMs;
  run.stats = () => ({ cache_hits: hits, cache_misses: misses, scope: cache_scope || 'memory-only (this run)' });
  return run;
}

// Before any probe result may be believed, the suite must be shown green AND
// stable on the unmodified file. Reporting "void" is the correct output when it
// is not; reporting a confident number from an unstable suite is the exact
// failure this project is about.
export function establishBaseline(runner, { samples = 3 } = {}) {
  const runs = [];
  for (let i = 0; i < Math.max(1, samples); i++) {
    // Bypass the cache deliberately: the point is to observe variation, and a
    // cache would hand back the same answer every time.
    runs.push(runOnce(runner.command, runner.cwd, runner.timeoutMs));
  }
  const outcomes = [...new Set(runs.map((r) => r.outcome))];
  const median = runs.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(runs.length / 2)];
  const base = { samples: runs.length, outcomes, median_ms: median };

  if (outcomes.length > 1) {
    return { ...base, usable: false, status: 'flaky',
      reason: `The verification gave different results on identical input across ${runs.length} runs (${outcomes.join(', ')}). Every probe would be measuring that flakiness rather than the code, so no confidence number can be reported until the suite is stable.` };
  }
  switch (outcomes[0]) {
    case 'crashed':
      return { ...base, usable: false, status: 'crashed',
        reason: `The verification command could not run at all: ${runs[0].error || runs[0].output.slice(0, 200)}` };
    case 'timeout':
      return { ...base, usable: false, status: 'timeout',
        reason: `The verification timed out on the unmodified file. Raise verify_timeout_ms or narrow the command.` };
    case 'failed':
      return { ...base, usable: false, status: 'red',
        reason: `The verification already FAILS on the unmodified file, so every deliberate breakage would also fail and every function would look watched. Fix the suite first: a red baseline turns this tool into a rubber stamp.` };
    default:
      return { ...base, usable: true, status: 'green',
        reason: `Green and stable across ${runs.length} runs (median ${median}ms).` };
  }
}

// Re-run the baseline AFTER a sweep and compare. establishBaseline samples
// before any probing, which cannot see a suite that degrades as it runs - one
// that leaves an artefact behind, or fails from the fourth invocation onward.
// An adversarial review beat the three-sample check exactly that way. If the
// baseline is not the same at the end as at the start, the sweep is void.
export function confirmBaseline(runner, before, { samples = 2 } = {}) {
  const after = establishBaseline(runner, { samples });
  const stable = after.status === before.status;
  return {
    stable, before: before.status, after: after.status,
    reason: stable
      ? `The verification behaved the same before and after the sweep (${before.status}).`
      : `VOID: the verification was ${before.status} before the sweep and ${after.status} after it. Something about running it changed its behaviour, so every result in this sweep is unreliable.`,
  };
}

// Given a probe result, decide honestly what happened.
export function classifyProbe(result) {
  switch (result.outcome) {
    case 'failed':  return { caught: true,  conclusive: true,  note: 'the verification objected' };
    case 'passed':  return { caught: false, conclusive: true,  note: 'the verification did not notice' };
    case 'timeout': return { caught: false, conclusive: false, note: 'the verification timed out: inconclusive, counted neither way' };
    case 'crashed': return { caught: false, conclusive: false, note: 'the verification could not run: inconclusive, says nothing about the code' };
    default:        return { caught: false, conclusive: false, note: 'unknown outcome' };
  }
}
