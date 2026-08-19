// Verifying the verifier.
//
// "The tests passed" is worth exactly as much as the tests' ability to fail.
// This module answers a question no test suite asks about itself: if I break
// this file on purpose, does your verify_command notice?
//
// The idea is not new — it is mutation testing — but the framing here is
// narrower and cheaper. We do not try to score a whole suite. We ask only
// whether THIS command, run in THIS directory, can detect a change to THESE
// lines: the ones the edit just touched. A mutant that survives is not proof
// of a bug. It is proof that the edit went unverified, which is the thing worth
// knowing before you believe a green result.
//
// The motivating case was real and embarrassing: a test sabotaged add(a,b) to
// a*b and then asserted on add(2, 2). Both give 4. The verification passed, the
// rollback never fired, and a broken guarantee reported green.

// Which lines did the edit actually touch? Mutating anywhere else would tell us
// about the rest of the file, not about this change.
export function changedLines(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  const changed = new Set();
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let ja = a.length - 1, jb = b.length - 1;
  while (ja >= i && jb >= i && a[ja] === b[jb]) { ja--; jb--; }
  for (let k = i; k <= jb; k++) changed.add(k + 1); // 1-based, in AFTER
  if (!changed.size && b.length) changed.add(Math.min(i + 1, b.length));
  return [...changed].sort((x, y) => x - y);
}

// Deterministic, order-independent mutation rules. Each is a pair so the
// reverse direction is covered too, and each changes behaviour rather than
// formatting — a mutant that only reshuffles whitespace proves nothing.
const RULES = [
  { name: 'comparison', find: /(?<![=!<>])===(?!=)/g, put: '!==' },
  { name: 'comparison', find: /!==/g, put: '===' },
  { name: 'comparison', find: /(?<![<>=!])==(?!=)/g, put: '!=' },
  { name: 'comparison', find: /(?<![<>=!])<=(?!=)/g, put: '>' },
  { name: 'comparison', find: /(?<![<>=!])>=(?!=)/g, put: '<' },
  { name: 'logic', find: /&&/g, put: '||' },
  { name: 'logic', find: /\|\|/g, put: '&&' },
  { name: 'boolean', find: /\btrue\b/g, put: 'false' },
  { name: 'boolean', find: /\bFalse\b/g, put: 'True' },
  { name: 'boolean', find: /\bfalse\b/g, put: 'true' },
  { name: 'boolean', find: /\bTrue\b/g, put: 'False' },
  // Arithmetic. Swapping '+' for '-' is the single most valuable mutant: it is
  // exactly the change that a weak assertion misses. The motivating bug —
  // asserting add(2, 2) === 4, which cannot tell + from * — dies to this rule.
  { name: 'arithmetic', find: /(?<=[\w)\]"']\s)\+(?=\s[\w("'])/g, put: '-' },
  // '+' to '*' as well as '+' to '-'. Both are needed, and the reason is the
  // bug that started this: add(2, 2) === 4 catches the '-' mutant (2-2 is 0)
  // but not the '*' mutant (2*2 is 4). One mutant per operator would have
  // reported that assertion as sound.
  { name: 'arithmetic', find: /(?<=[\w)\]]\s)\+(?=\s[\w(])/g, put: '*' },
  { name: 'arithmetic', find: /(?<=[\w)\]]\s)-(?=\s[\w(])/g, put: '+' },
  { name: 'arithmetic', find: /(?<=[\w)\]]\s?)\*(?!\*)(?=\s?[\w(])/g, put: '+' },
  { name: 'arithmetic', find: /(?<=[\w)\]]\s?)\/(?!\/)(?=\s?[\w(])/g, put: '*' },
  // Numeric literals: a value that no assertion pins down is a value nothing
  // is checking.
  { name: 'number', find: /\b(\d+)\b/g, put: (m) => String(Number(m) + 1) },
  { name: 'return', find: /\breturn\s+(?=[^;\n]+)/g, put: 'return null && ', py: 'return None and ' },
];

// Build mutants restricted to `lines` (1-based) of `content`.
export function generateMutants(content, lines, max = 4, ext = '.js') {
  const rows = content.split('\n');
  const targets = new Set(lines);
  const mutants = [];
  const seen = new Set();

  for (const rule of RULES) {
    for (const ln of lines) {
      if (mutants.length >= max) return mutants;
      const idx = ln - 1;
      const row = rows[idx];
      if (row === undefined) continue;
      // Skip comment-only and blank lines: changing a comment proves nothing.
      const trimmed = row.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) continue;

      rule.find.lastIndex = 0;
      const m = rule.find.exec(row);
      if (!m) continue;
      const put = (ext === '.py' && rule.py) ? rule.py : rule.put;
      const replacement = typeof put === 'function' ? put(m[1] ?? m[0]) : put;
      const mutatedRow = row.slice(0, m.index) + replacement + row.slice(m.index + m[0].length);
      if (mutatedRow === row) continue;
      const key = `${idx}:${mutatedRow}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const copy = [...rows];
      copy[idx] = mutatedRow;
      mutants.push({
        rule: rule.name,
        line: ln,
        before: row.trim().slice(0, 100),
        after: mutatedRow.trim().slice(0, 100),
        content: copy.join('\n'),
      });
    }
  }
  void targets;
  return mutants;
}

// The cheapest, bluntest probe: replace the file with something that cannot
// possibly work. If the verifier still passes, it does not exercise this file
// at all, and every finer question is moot.
export function destructionProbe(content, abs = '') {
  // The content includes the file's own path. Two byte-identical files in a
  // repo (a vendored copy, a monorepo duplicate) previously produced an
  // identical destruction probe, so a cache keyed on content served one file's
  // answer for the other. Found by an adversarial review, not by me.
  return {
    rule: 'destruction',
    line: 0,
    before: '(the whole file)',
    after: '(replaced with a syntax error)',
    content: `((( SAFE-EDIT PROBE for ${abs}: this file was deliberately corrupted to test whether your verify_command notices )))\n`,
  };
}

// The null probe: a change that CANNOT alter behaviour.
//
// The destruction probe answers "does the command object to this file being
// garbage" and I read that as "the command executes this file". It does not.
// A snapshot test, a checksum guard or a lint rule objects to garbage without
// ever running a line of it, and then every mutant is "caught" for the wrong
// reason and every function reports watched. That is the confident direction of
// error, and an adversarial review produced it three different ways.
//
// So: append a comment. Nothing about the program changes. If the verification
// FAILS on that, it is checking the file's bytes rather than its behaviour, and
// no coverage claim below it means anything.
const COMMENT_SYNTAX = {
  '.py': '#', '.rb': '#', '.sh': '#', '.yml': '#', '.yaml': '#',
  '.js': '//', '.mjs': '//', '.cjs': '//', '.ts': '//', '.tsx': '//',
  '.go': '//', '.rs': '//', '.java': '//', '.c': '//', '.h': '//', '.cpp': '//',
};

export function nullProbe(content, ext) {
  const marker = COMMENT_SYNTAX[ext];
  if (!marker) return null; // no comment syntax we trust: skip rather than guess
  return {
    rule: 'null',
    line: 0,
    before: '(unchanged)',
    after: '(one comment line appended)',
    content: content + `${marker} safe-edit null probe: this comment changes nothing\n`,
  };
}

// Interpret the results the way they should be read.
export function summarise(destroyed, survivors, ran, nullProbeCaught = false) {
  if (nullProbeCaught) {
    return {
      trustworthy: false,
      confidence: 'none',
      verdict: 'Your verify_command FAILED on a change that cannot alter behaviour - a single appended comment. It is checking the file\'s bytes, not what the file does (a snapshot, checksum or lint rule). Every mutant would be "caught" for that reason alone, so no coverage claim can be made.',
    };
  }
  if (destroyed === 'survived') {
    return {
      trustworthy: false,
      confidence: 'none',
      verdict: 'Your verify_command PASSED on a file that had been replaced with garbage. It does not exercise this file at all, so its green result says nothing about this edit.',
    };
  }
  if (!ran) {
    return { trustworthy: null, confidence: 'unknown', verdict: 'No probes were run.' };
  }
  if (survivors.length === 0) {
    return {
      trustworthy: true,
      confidence: ran <= 2 ? 'low' : 'reasonable',
      verdict: `Your verify_command caught every one of the ${ran} deliberate breakages and ignored a no-op change, so its pass on the real edit is informative.`,
    };
  }
  return {
    trustworthy: false,
    confidence: 'partial',
    verdict: `Your verify_command noticed total destruction but MISSED ${survivors.length} of ${ran} targeted changes to the lines this edit touched. It loads the file without checking this behaviour, so a passing result does not confirm the edit is correct.`,
  };
}
