// infer.js — work out which tests are the RIGHT tests for a file being edited.
//
// Mikey, 2026-08-19: "This is why edits should be made through a server. The server
// should run the appropriate tests."
//
// safe_edit could already run a verify_command, roll back on failure, and even probe
// whether the command notices a deliberately broken file. What it could NOT do was
// work out the command by itself — so an edit with no verify_command silently got the
// structural gate and no tests at all. Every edit made on 2026-08-19 was in that
// category. The capability was there; nobody supplied the argument.
//
// This closes that. It never guesses silently: the result always carries `why`, and
// callers surface it.

import fs from 'node:fs';
import path from 'node:path';

const STOP_AT = ['.git'];   // don't walk past a repo boundary

function upward(fromDir) {
  const out = [];
  let d = fromDir;
  for (let i = 0; i < 12; i++) {
    out.push(d);
    if (STOP_AT.some(m => fs.existsSync(path.join(d, m)))) break;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return out;
}

/**
 * Returns { command, cwd, why, confidence } or { command: null, why }.
 * confidence: 'declared' (a test script exists) | 'discovered' (test files found) | 'none'
 */
export function inferVerifyCommand(absFilePath) {
  const start = fs.existsSync(absFilePath) && fs.statSync(absFilePath).isDirectory()
    ? absFilePath : path.dirname(absFilePath);

  for (const dir of upward(start)) {
    // 1. A declared npm test script is the strongest signal — the repo says so itself.
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) {
      try {
        const j = JSON.parse(fs.readFileSync(pkg, 'utf8'));
        const t = j.scripts && j.scripts.test;
        if (t && !/no test specified/i.test(t)) {
          return { command: ['npm', 'test'], cwd: dir, confidence: 'declared',
                   why: `${path.basename(dir)}/package.json declares a test script: ${t}` };
        }
      } catch { /* malformed package.json is not our problem here */ }
    }

    // 2. Python: a declared pytest config.
    for (const cfg of ['pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini']) {
      const f = path.join(dir, cfg);
      if (fs.existsSync(f)) {
        try {
          if (/\[tool\.pytest|\[pytest\]/.test(fs.readFileSync(f, 'utf8'))) {
            return { command: ['python3', '-m', 'pytest', '-q'], cwd: dir, confidence: 'declared',
                     why: `${cfg} configures pytest` };
          }
        } catch { /* ignore */ }
      }
    }

    // 3. Nothing declared, but a test directory exists — weaker, still worth running.
    for (const td of ['test', 'tests', '__tests__']) {
      const d = path.join(dir, td);
      if (fs.existsSync(d) && fs.statSync(d).isDirectory()) {
        const files = fs.readdirSync(d);
        if (files.some(f => /\.test\.(m?js|ts)$/.test(f)))
          return { command: ['node', '--test', td], cwd: dir, confidence: 'discovered',
                   why: `no test script declared, but ${td}/ holds *.test.mjs files` };
        if (files.some(f => /^test_.*\.py$|_test\.py$/.test(f)))
          return { command: ['python3', '-m', 'pytest', '-q', td], cwd: dir, confidence: 'discovered',
                   why: `no pytest config, but ${td}/ holds test_*.py files` };
      }
    }
  }

  return { command: null, cwd: null, confidence: 'none',
           why: 'no test script, pytest config, or test directory found walking up to the repo root' };
}
