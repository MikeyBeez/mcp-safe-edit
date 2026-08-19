// The function tree.
//
// A file is not a bag of text, it is a set of things it can do. So decompose it
// into every callable — including the ones nested inside other callables, which
// a top-level scan misses entirely — and give each one a name, a line range and
// a parent. That gives three things the text layer cannot:
//
//   1. presence checking at the granularity that matters (did f.inner survive?)
//   2. an unambiguous edit address (replace function X, not "the third match")
//   3. a unit for mutation probing, so we can say WHICH function nothing watches
//
// Nesting is the part worth insisting on. A closure inside a handler is where
// the real logic usually lives, and it is invisible to every exports-level check.

import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as acorn from 'acorn';

// ---------------------------------------------------------------------------
// JavaScript
// ---------------------------------------------------------------------------

function jsFunctions(content) {
  let ast;
  for (const opts of [
    { sourceType: 'module', ecmaVersion: 'latest', allowAwaitOutsideFunction: true, allowHashBang: true, locations: true },
    { sourceType: 'script', ecmaVersion: 'latest', allowReturnOutsideFunction: true, allowHashBang: true, locations: true },
  ]) {
    try { ast = acorn.parse(content, opts); break; } catch { /* try the next */ }
  }
  if (!ast) { const e = new Error('does not parse as JavaScript'); e.parseError = true; throw e; }

  const found = [];

  const record = (node, name, kind, scope) => {
    found.push({
      name: scope.length ? `${scope.join('.')}.${name}` : name,
      short_name: name,
      kind,
      depth: scope.length,
      parent: scope.length ? scope.join('.') : null,
      start_line: node.loc.start.line,
      end_line: node.loc.end.line,
      lines: node.loc.end.line - node.loc.start.line + 1,
      params: (node.params || []).length,
      async: !!node.async,
      generator: !!node.generator,
    });
  };

  // Name an anonymous function from where it is bound, the way a human reads it.
  const nameOf = (node, parentNode, key) => {
    if (node.id?.name) return node.id.name;
    if (parentNode?.type === 'VariableDeclarator' && parentNode.id?.name) return parentNode.id.name;
    if (parentNode?.type === 'Property') return parentNode.key?.name ?? parentNode.key?.value;
    if (parentNode?.type === 'MethodDefinition') return parentNode.key?.name ?? parentNode.key?.value;
    if (parentNode?.type === 'AssignmentExpression' && parentNode.left?.property?.name) return parentNode.left.property.name;
    if (parentNode?.type === 'ClassDeclaration' || parentNode?.type === 'ClassExpression') return parentNode.id?.name;
    return `<anonymous@${node.loc.start.line}>`;
  };

  const FN = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

  const walk = (node, parentNode, scope) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const n of node) walk(n, parentNode, scope); return; }
    if (!node.type) return;

    let nextScope = scope;

    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
      const cname = node.id?.name ?? nameOf(node, parentNode) ?? '<class>';
      found.push({
        name: scope.length ? `${scope.join('.')}.${cname}` : cname,
        short_name: cname, kind: 'class', depth: scope.length,
        parent: scope.length ? scope.join('.') : null,
        start_line: node.loc.start.line, end_line: node.loc.end.line,
        lines: node.loc.end.line - node.loc.start.line + 1, params: 0, async: false, generator: false,
      });
      nextScope = [...scope, cname];
    } else if (FN.has(node.type)) {
      const name = nameOf(node, parentNode);
      const kind = parentNode?.type === 'MethodDefinition'
        ? 'method'
        : (node.type === 'ArrowFunctionExpression' ? 'arrow' : 'function');
      record(node, name, kind, scope);
      nextScope = [...scope, name];
    }

    for (const k of Object.keys(node)) {
      if (k === 'type' || k === 'loc' || k === 'start' || k === 'end') continue;
      walk(node[k], node, nextScope);
    }
  };

  walk(ast.body, null, []);
  return found.sort((a, b) => a.start_line - b.start_line);
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

const PY = `
import ast, json, sys
src = sys.stdin.read()
try:
    tree = ast.parse(src)
except SyntaxError as e:
    print(json.dumps({"parse_error": f"line {e.lineno}: {e.msg}"})); sys.exit(0)
out = []
def walk(node, scope):
    for c in ast.iter_child_nodes(node):
        if isinstance(c, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            name = ".".join(scope + [c.name])
            kind = "class" if isinstance(c, ast.ClassDef) else ("method" if scope else "function")
            out.append({
                "name": name, "short_name": c.name, "kind": kind, "depth": len(scope),
                "parent": ".".join(scope) if scope else None,
                "start_line": c.lineno, "end_line": getattr(c, "end_lineno", c.lineno),
                "lines": getattr(c, "end_lineno", c.lineno) - c.lineno + 1,
                "params": len(getattr(getattr(c, "args", None), "args", []) or []),
                "async": isinstance(c, ast.AsyncFunctionDef), "generator": False,
            })
            walk(c, scope + [c.name])
        else:
            walk(c, scope)
walk(tree, [])
out.sort(key=lambda x: x["start_line"])
print(json.dumps(out))
`;

function pyFunctions(content) {
  const out = execFileSync('python3', ['-c', PY], { input: content, encoding: 'utf8', timeout: 10000 });
  const parsed = JSON.parse(out);
  if (parsed.parse_error) { const e = new Error(`does not parse as Python: ${parsed.parse_error}`); e.parseError = true; throw e; }
  return parsed;
}

// ---------------------------------------------------------------------------

const BY_EXT = { '.js': jsFunctions, '.mjs': jsFunctions, '.cjs': jsFunctions, '.py': pyFunctions };

export function functionTree(filePath, content) {
  const fn = BY_EXT[path.extname(filePath).toLowerCase()];
  if (!fn) {
    return { understood: false, reason: `no function parser for "${path.extname(filePath) || 'extensionless'}" files`, functions: [] };
  }
  try {
    return { understood: true, functions: fn(content) };
  } catch (e) {
    if (e.parseError) return { understood: true, parse_error: e.message, functions: [] };
    return { understood: false, reason: e.message, functions: [] };
  }
}

// Which function contains a given line? The innermost one wins, because that is
// the one whose behaviour a change on that line actually alters.
export function functionAtLine(tree, line) {
  const containing = tree.filter((f) => f.start_line <= line && line <= f.end_line && f.kind !== 'class');
  if (!containing.length) return null;
  return containing.sort((a, b) => (b.depth - a.depth) || (a.lines - b.lines))[0];
}

// Compare two trees. A function that vanished is the finding; a rename shows up
// as one removal plus one addition, which is honest — we cannot know it was a
// rename, and pretending to would be a guess.
export function compareTrees(before, after) {
  const key = (f) => `${f.kind}:${f.name}`;
  const b = new Map(before.map((f) => [key(f), f]));
  const a = new Map(after.map((f) => [key(f), f]));
  return {
    removed: [...b.keys()].filter((k) => !a.has(k)),
    added: [...a.keys()].filter((k) => !b.has(k)),
    kept: [...b.keys()].filter((k) => a.has(k)),
  };
}
