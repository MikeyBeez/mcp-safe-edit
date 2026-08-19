// What does this file promise to provide?
//
// A textual edit can be perfectly applied and still destroy the file. So before
// writing, we take an inventory of what the file DOES — its exports, its
// functions, its classes, its imports, its config keys — and after the edit we
// take it again and compare. Anything that disappeared without being declared
// is a refusal, not a warning.
//
// The one rule that matters here: an analyzer must never claim understanding it
// does not have. If a file type has no real parser, the inventory says so
// explicitly (`understood: false`) and the caller is told there is no structural
// guarantee. Silently returning "looks fine" for a file we cannot parse would be
// the exact disease this server exists to cure, one level up.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as acorn from 'acorn';
import { available as tsAvailable, unavailableReason as tsReason, tsInventory } from './ts-analyzer.js';

const EMPTY = () => ({ symbols: [], imports: [], notes: [] });

// ---------------------------------------------------------------------------
// JavaScript / ESM / CJS
// ---------------------------------------------------------------------------

function jsInventory(content) {
  let ast;
  const attempts = [
    { sourceType: 'module', ecmaVersion: 'latest', allowAwaitOutsideFunction: true, allowHashBang: true },
    { sourceType: 'script', ecmaVersion: 'latest', allowReturnOutsideFunction: true, allowHashBang: true },
  ];
  let lastErr;
  for (const opts of attempts) {
    try { ast = acorn.parse(content, opts); break; } catch (e) { lastErr = e; }
  }
  if (!ast) {
    const e = new Error(`does not parse as JavaScript: ${lastErr.message}`);
    e.parseError = true;
    throw e;
  }

  const symbols = [];
  const imports = [];
  const add = (kind, name) => { if (name) symbols.push(`${kind}:${name}`); };

  const namesFromId = (id) => {
    if (!id) return [];
    if (id.type === 'Identifier') return [id.name];
    if (id.type === 'ObjectPattern') return id.properties.flatMap((p) => (p.value ? namesFromId(p.value) : []));
    if (id.type === 'ArrayPattern') return id.elements.flatMap((el) => (el ? namesFromId(el) : []));
    if (id.type === 'AssignmentPattern') return namesFromId(id.left);
    if (id.type === 'RestElement') return namesFromId(id.argument);
    return [];
  };

  const declare = (node, exported) => {
    if (!node) return;
    if (node.type === 'FunctionDeclaration') { add(exported ? 'export.function' : 'function', node.id?.name); }
    else if (node.type === 'ClassDeclaration') {
      add(exported ? 'export.class' : 'class', node.id?.name);
      for (const m of node.body?.body || []) {
        const mn = m.key?.name ?? m.key?.value;
        if (mn) symbols.push(`method:${node.id?.name}.${mn}`);
      }
    } else if (node.type === 'VariableDeclaration') {
      for (const d of node.declarations) for (const n of namesFromId(d.id)) add(exported ? 'export.const' : 'const', n);
    }
  };

  for (const node of ast.body) {
    switch (node.type) {
      case 'ImportDeclaration':
        imports.push(node.source.value);
        break;
      case 'ExportNamedDeclaration':
        if (node.source) imports.push(node.source.value);
        declare(node.declaration, true);
        for (const s of node.specifiers || []) add('export', s.exported?.name ?? s.exported?.value);
        break;
      case 'ExportDefaultDeclaration':
        symbols.push('export:default');
        break;
      case 'ExportAllDeclaration':
        symbols.push(`export:*from ${node.source.value}`);
        imports.push(node.source.value);
        break;
      default:
        declare(node, false);
    }
  }

  // CommonJS: require() calls and module.exports / exports.x assignments.
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.type === 'CallExpression' && n.callee?.name === 'require' && n.arguments?.[0]?.value) {
      imports.push(String(n.arguments[0].value));
    }
    if (n.type === 'AssignmentExpression' && n.left?.type === 'MemberExpression') {
      const o = n.left.object, pName = n.left.property?.name;
      if (o?.name === 'exports' && pName) add('export', pName);
      if (o?.type === 'MemberExpression' && o.object?.name === 'module' && o.property?.name === 'exports' && pName) add('export', pName);
      if (o?.name === 'module' && pName === 'exports') {
        symbols.push('export:module.exports');
        if (n.right?.type === 'ObjectExpression') {
          for (const p of n.right.properties) {
            const k = p.key?.name ?? p.key?.value;
            if (k) add('export', k);
          }
        }
      }
    }
    for (const k of Object.keys(n)) if (k !== 'type' && k !== 'start' && k !== 'end') walk(n[k]);
  };
  walk(ast.body);

  return { symbols: [...new Set(symbols)].sort(), imports: [...new Set(imports)].sort(), notes: [] };
}

// ---------------------------------------------------------------------------
// Python — via the real ast module, not a regex
// ---------------------------------------------------------------------------

const PY_SCRIPT = `
import ast, json, sys
src = sys.stdin.read()
try:
    tree = ast.parse(src)
except SyntaxError as e:
    print(json.dumps({"parse_error": f"line {e.lineno}: {e.msg}"})); sys.exit(0)
symbols, imports = [], []
def walk(node, prefix=""):
    for child in ast.iter_child_nodes(node):
        if isinstance(child, ast.FunctionDef) or isinstance(child, ast.AsyncFunctionDef):
            symbols.append(("method:" if prefix else "function:") + prefix + child.name)
            walk(child, prefix + child.name + ".")
        elif isinstance(child, ast.ClassDef):
            symbols.append("class:" + prefix + child.name)
            walk(child, prefix + child.name + ".")
        elif isinstance(child, ast.Import):
            for a in child.names: imports.append(a.name)
        elif isinstance(child, ast.ImportFrom):
            imports.append(child.module or ".")
        elif isinstance(child, ast.Assign) and not prefix:
            for t in child.targets:
                if isinstance(t, ast.Name): symbols.append("const:" + t.id)
        else:
            if not isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                walk(child, prefix)
walk(tree)
print(json.dumps({"symbols": sorted(set(symbols)), "imports": sorted(set(imports))}))
`;

function pyInventory(content) {
  let out;
  try {
    out = execFileSync('python3', ['-c', PY_SCRIPT], { input: content, encoding: 'utf8', timeout: 10000 });
  } catch (e) {
    const err = new Error(`python3 unavailable for structural checking: ${e.message}`);
    err.unavailable = true;
    throw err;
  }
  const parsed = JSON.parse(out);
  if (parsed.parse_error) {
    const e = new Error(`does not parse as Python: ${parsed.parse_error}`);
    e.parseError = true;
    throw e;
  }
  return { symbols: parsed.symbols, imports: parsed.imports, notes: [] };
}

// ---------------------------------------------------------------------------
// JSON — every key path is a capability
// ---------------------------------------------------------------------------

function jsonInventory(content) {
  let obj;
  try { obj = JSON.parse(content); }
  catch (e) { const err = new Error(`does not parse as JSON: ${e.message}`); err.parseError = true; throw err; }
  const symbols = [];
  const walk = (v, prefix) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const k of Object.keys(v)) { symbols.push(`key:${prefix}${k}`); walk(v[k], `${prefix}${k}.`); }
    } else if (Array.isArray(v)) {
      symbols.push(`array:${prefix.slice(0, -1)}[${v.length}]`);
    }
  };
  walk(obj, '');
  return { symbols: symbols.sort(), imports: [], notes: [] };
}

// ---------------------------------------------------------------------------
// Markdown — headings are the contract
// ---------------------------------------------------------------------------

function mdInventory(content) {
  const symbols = [];
  let fences = 0;
  for (const line of content.split('\n')) {
    const h = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (h) symbols.push(`heading${h[1].length}:${h[2]}`);
    if (/^\s*```/.test(line)) fences++;
  }
  const notes = [];
  if (fences % 2 !== 0) notes.push(`unbalanced code fences (${fences} fence markers) — a fence was probably left open`);
  return { symbols: symbols.sort(), imports: [], notes };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

// TypeScript is handled by the real compiler, never by the JavaScript parser
// with the types ignored: that would choke on an annotation and report a
// healthy file as broken. If the compiler is not installed the analyzer says so
// rather than guessing.
const withPath = (fn) => (content, filePath) => fn(filePath, content);

const ANALYZERS = {
  '.js': { lang: 'javascript', fn: jsInventory },
  '.mjs': { lang: 'javascript', fn: jsInventory },
  '.cjs': { lang: 'javascript', fn: jsInventory },
  '.py': { lang: 'python', fn: pyInventory },
  '.json': { lang: 'json', fn: jsonInventory },
  '.md': { lang: 'markdown', fn: mdInventory },
  '.ts': { lang: 'typescript', fn: withPath(tsInventory), needs: tsAvailable },
  '.tsx': { lang: 'typescript', fn: withPath(tsInventory), needs: tsAvailable },
};

const KNOWN_UNSUPPORTED = {};

export function inventory(filePath, content) {
  const ext = path.extname(filePath).toLowerCase();
  const a = ANALYZERS[ext];
  if (a && a.needs && !a.needs()) {
    return { understood: false, language: a.lang, reason: tsReason(), ...EMPTY() };
  }
  if (!a) {
    return {
      understood: false,
      language: ext || 'none',
      reason: KNOWN_UNSUPPORTED[ext] || `no structural analyzer for "${ext || 'extensionless'}" files`,
      ...EMPTY(),
    };
  }
  try {
    const r = a.fn(content, filePath);
    return { understood: true, language: a.lang, ...r };
  } catch (e) {
    if (e.parseError) return { understood: true, language: a.lang, parse_error: e.message, ...EMPTY() };
    if (e.unavailable) return { understood: false, language: a.lang, reason: e.message, ...EMPTY() };
    throw e;
  }
}

// Compare two inventories. Removals are the thing we care about; additions are
// normal and reported for information.
export function compareInventories(before, after) {
  if (!before.understood || !after.understood) {
    return { checkable: false, reason: after.reason || before.reason, removed: [], added: [], removed_imports: [], added_imports: [] };
  }
  if (after.parse_error) {
    return { checkable: true, broken: after.parse_error, removed: [], added: [], removed_imports: [], added_imports: [] };
  }
  const b = new Set(before.symbols), a = new Set(after.symbols);
  const bi = new Set(before.imports), ai = new Set(after.imports);
  return {
    checkable: true,
    broken: null,
    removed: [...b].filter((x) => !a.has(x)),
    added: [...a].filter((x) => !b.has(x)),
    removed_imports: [...bi].filter((x) => !ai.has(x)),
    added_imports: [...ai].filter((x) => !bi.has(x)),
    notes: after.notes || [],
  };
}

export function describeAnalyzers() {
  return {
    supported: Object.entries(ANALYZERS).filter(([, a]) => !a.needs || a.needs()).map(([ext, a]) => ({ ext, language: a.lang })),
    unsupported: [
      ...Object.entries(KNOWN_UNSUPPORTED).map(([ext, reason]) => ({ ext, reason })),
      ...Object.entries(ANALYZERS).filter(([, a]) => a.needs && !a.needs()).map(([ext]) => ({ ext, reason: tsReason() })),
    ],
    note: 'Any other extension is edited without a structural guarantee, and safe_edit will say so in its result.',
  };
}
