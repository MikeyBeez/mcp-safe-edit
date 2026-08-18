// mcp-safe-edit — deterministic file editing.
//
// The whole design comes from one observation: almost every editing bug in this
// system was an operation that ran without checking the result matched the
// intent. So every function here states a precondition, counts what it matched,
// writes atomically, and re-reads to confirm what landed. Nothing returns
// "success" on the strength of not having thrown.
//
// This module is pure logic over a filesystem. It exports plain functions so
// they can be unit-tested without starting a server.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

export const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const short = (h) => h.slice(0, 12);

// ---------------------------------------------------------------------------
// Path containment
// ---------------------------------------------------------------------------

// Resolve a path for the allow-check, following symlinks — including dangling
// ones, which realpath throws on and which would otherwise be a free pass out
// of the allowed roots.
export function resolveForCheck(requestPath, depth = 0) {
  if (depth > 32) return null; // symlink loop
  const absolute = path.resolve(requestPath);
  try {
    return fs.realpathSync(absolute);
  } catch { /* absent, or a dangling link */ }
  try {
    if (fs.lstatSync(absolute).isSymbolicLink()) {
      const target = fs.readlinkSync(absolute);
      return resolveForCheck(path.resolve(path.dirname(absolute), target), depth + 1);
    }
  } catch { /* genuinely absent */ }
  const parent = path.dirname(absolute);
  if (parent === absolute) return null;
  const realParent = resolveForCheck(parent, depth + 1);
  return realParent === null ? null : path.join(realParent, path.basename(absolute));
}

export function makeGuard(roots) {
  const real = roots.map((r) => {
    try { return fs.realpathSync(path.resolve(r)); } catch { return null; }
  }).filter(Boolean);
  if (!real.length) throw new Error('no valid allowed roots');
  return function assertAllowed(p) {
    const resolved = resolveForCheck(p);
    if (resolved === null) throw new Error(`Path is not resolvable: ${p}`);
    const inside = real.some((r) => resolved === r || resolved.startsWith(r + path.sep));
    if (!inside) throw new Error(`Access denied: ${p} resolves to ${resolved}, outside the allowed roots`);
    return resolved;
  };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export function readFile(abs) {
  const content = fs.readFileSync(abs, 'utf8');
  return {
    path: abs,
    sha256: sha256(content),
    bytes: Buffer.byteLength(content, 'utf8'),
    lines: content === '' ? 0 : content.split('\n').length,
    ends_with_newline: content.endsWith('\n'),
    content,
  };
}

// ---------------------------------------------------------------------------
// Matching — the part that has to be exact and countable
// ---------------------------------------------------------------------------

// Every occurrence of `needle` in `hay`, as absolute offsets. Plain string
// scanning: no regex, so nothing in the needle is ever interpreted.
export function findAll(hay, needle) {
  const out = [];
  if (needle === '') return out;
  let i = hay.indexOf(needle);
  while (i !== -1) { out.push(i); i = hay.indexOf(needle, i + needle.length); }
  return out;
}

export const lineOf = (content, offset) => content.slice(0, offset).split('\n').length;

// Replace every occurrence by offset. Done right-to-left so earlier offsets stay
// valid, and via slicing rather than String.replace so '$&' and '$1' in the
// replacement are literal characters.
export function replaceAt(content, offsets, needleLen, replacement) {
  let out = content;
  for (const off of [...offsets].sort((a, b) => b - a)) {
    out = out.slice(0, off) + replacement + out.slice(off + needleLen);
  }
  return out;
}

// When an exact match fails, say WHY rather than just "not found". These are
// the three things that actually go wrong: trailing whitespace, CRLF, and
// leading indentation.
export function diagnoseMiss(content, needle) {
  const hints = [];
  const stripTrailing = (s) => s.split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n');
  if (findAll(stripTrailing(content), stripTrailing(needle)).length > 0) {
    hints.push('would match if trailing whitespace were ignored');
  }
  if (content.includes('\r\n') && !needle.includes('\r\n')) {
    hints.push('the file uses CRLF line endings but the search text uses LF');
  }
  if (!content.includes('\r\n') && needle.includes('\r\n')) {
    hints.push('the search text uses CRLF but the file uses LF');
  }
  const dedent = (s) => s.split('\n').map((l) => l.replace(/^[ \t]+/, '')).join('\n');
  if (findAll(dedent(content), dedent(needle)).length > 0) {
    hints.push('would match if leading indentation were ignored — check tabs versus spaces');
  }
  const firstLine = needle.split('\n')[0].trim();
  if (firstLine.length > 3 && content.includes(firstLine)) {
    hints.push(`the first line ("${firstLine.slice(0, 60)}") does appear in the file, so the mismatch is later in the block`);
  }
  return hints;
}

// ---------------------------------------------------------------------------
// Atomic write + post-write verification
// ---------------------------------------------------------------------------

export function atomicWrite(abs, content) {
  const dir = path.dirname(abs);
  fs.mkdirSync(dir, { recursive: true });
  let mode;
  try { mode = fs.statSync(abs).mode & 0o777; } catch { mode = 0o644; }
  const tmp = path.join(dir, `.${path.basename(abs)}.safe-edit-${process.pid}-${Date.now()}.tmp`);
  try {
    const fd = fs.openSync(tmp, 'w', mode);
    try {
      fs.writeFileSync(fd, content, 'utf8');
      fs.fsyncSync(fd);            // durable before the rename
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, abs);       // atomic on the same filesystem
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw e;
  }
  // The postcondition. Read it back and prove the bytes on disk are the bytes
  // we meant to write. Without this, every claim of success is a guess.
  const after = fs.readFileSync(abs, 'utf8');
  if (after !== content) {
    throw new Error(`Post-write verification FAILED for ${abs}: the file on disk does not match what was written`);
  }
  return sha256(after);
}

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

export const BACKUP_ROOT = process.env.SAFE_EDIT_BACKUPS
  || path.join(os.homedir(), '.mcp-safe-edit', 'backups');

export function backup(abs, content, stamp) {
  const key = sha256(abs).slice(0, 16);
  const dir = path.join(BACKUP_ROOT, key);
  fs.mkdirSync(dir, { recursive: true });
  const id = `${stamp}-${short(sha256(content))}`;
  fs.writeFileSync(path.join(dir, `${id}.bak`), content, 'utf8');
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, path: abs, sha256: sha256(content), saved_at: stamp }, null, 2));
  return id;
}

export function listBackups(abs) {
  const dir = path.join(BACKUP_ROOT, sha256(abs).slice(0, 16));
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return []; }
  return files.filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
    .sort((a, b) => (a.saved_at < b.saved_at ? 1 : -1));
}

export function readBackup(abs, id) {
  const dir = path.join(BACKUP_ROOT, sha256(abs).slice(0, 16));
  return fs.readFileSync(path.join(dir, `${id}.bak`), 'utf8');
}

// ---------------------------------------------------------------------------
// Unified-ish diff, for showing what actually changed
// ---------------------------------------------------------------------------

export function diff(before, after, context = 2) {
  const a = before.split('\n'), b = after.split('\n');
  const out = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    // find the next resync point
    let k = 1, resync = null;
    while (k < 200 && resync === null) {
      if (a[i + k] !== undefined && a[i + k] === b[j]) resync = { di: k, dj: 0 };
      else if (b[j + k] !== undefined && a[i] === b[j + k]) resync = { di: 0, dj: k };
      else if (a[i + k] !== undefined && a[i + k] === b[j + k]) resync = { di: k, dj: k };
      k++;
    }
    const di = resync ? resync.di : a.length - i;
    const dj = resync ? resync.dj : b.length - j;
    for (let x = 0; x < di; x++) out.push(`-${i + x + 1}: ${a[i + x]}`);
    for (let y = 0; y < dj; y++) out.push(`+${j + y + 1}: ${b[j + y]}`);
    i += di; j += dj;
    if (!resync) break;
  }
  if (!out.length) return '(no textual change)';
  return out.length > 400 ? out.slice(0, 400).join('\n') + `\n… ${out.length - 400} more changed lines` : out.join('\n');
}
