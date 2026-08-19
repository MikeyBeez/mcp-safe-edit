// TypeScript, via the real compiler.
//
// Deliberately NOT the JavaScript parser with the types stripped out. Half of
// this repo's own servers are .ts, and a JS parser choking on a type annotation
// would report a healthy file as broken, which is a worse failure than
// admitting we cannot read it.
//
// Loaded lazily so the whole server still runs if typescript is not installed:
// the analyzer then reports that it cannot check .ts files, which is the honest
// answer rather than a silent pass.
//
// Pinned to typescript 5.x on purpose. TypeScript 7 is the Go rewrite, and its
// package no longer exports the classic compiler API from the main entry - the
// AST lives under ./unstable/* subpaths. A path with 'unstable' in its name is
// not somewhere to put a safety check, so this stays on 5.x until that settles.

let ts = null;
let loadError = null;
try { ts = (await import('typescript')).default; }
catch (e) { loadError = e.message; }

export const available = () => ts !== null;
export const unavailableReason = () =>
  `the typescript package is not installed here (${loadError}) - run npm install typescript to enable structural checking for .ts files`;

function parse(filePath, content) {
  const sf = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  // parseDiagnostics is not in the public typings but is the only way to learn
  // that a file failed to parse without running a whole program.
  const diags = sf.parseDiagnostics || [];
  if (diags.length) {
    const d = diags[0];
    const pos = sf.getLineAndCharacterOfPosition(d.start || 0);
    const e = new Error(`does not parse as TypeScript: line ${pos.line + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
    e.parseError = true;
    throw e;
  }
  return sf;
}

const isExported = (node) =>
  !!(node.modifiers || []).find((m) => m.kind === ts.SyntaxKind.ExportKeyword);

const nameOf = (node) => {
  if (node.name) {
    if (typeof node.name.text === 'string') return node.name.text;
    if (node.name.escapedText) return String(node.name.escapedText);
  }
  return null;
};

export function tsInventory(filePath, content) {
  const sf = parse(filePath, content);
  const symbols = [];
  const imports = [];
  const add = (kind, name) => { if (name) symbols.push(`${kind}:${name}`); };

  const K = ts.SyntaxKind;

  const visit = (node, scope) => {
    switch (node.kind) {
      case K.ImportDeclaration:
        if (node.moduleSpecifier?.text) imports.push(node.moduleSpecifier.text);
        break;
      case K.CallExpression:
        if (node.expression?.escapedText === 'require' && node.arguments?.[0]?.text) imports.push(node.arguments[0].text);
        break;
      case K.ExportAssignment:
        symbols.push('export:default');
        break;
      case K.FunctionDeclaration:
        add(isExported(node) ? 'export.function' : 'function', nameOf(node));
        break;
      case K.ClassDeclaration: {
        const cn = nameOf(node) || '<anonymous class>';
        add(isExported(node) ? 'export.class' : 'class', cn);
        for (const m of node.members || []) {
          const mn = nameOf(m);
          if (!mn) continue;
          if (m.kind === K.MethodDeclaration) symbols.push(`method:${cn}.${mn}`);
          else if (m.kind === K.PropertyDeclaration) symbols.push(`property:${cn}.${mn}`);
        }
        break;
      }
      // Types are part of the contract too. Deleting an exported interface
      // breaks every consumer, and no runtime check would ever notice.
      case K.InterfaceDeclaration:
        add(isExported(node) ? 'export.interface' : 'interface', nameOf(node));
        break;
      case K.TypeAliasDeclaration:
        add(isExported(node) ? 'export.type' : 'type', nameOf(node));
        break;
      case K.EnumDeclaration:
        add(isExported(node) ? 'export.enum' : 'enum', nameOf(node));
        break;
      case K.VariableStatement: {
        const exported = isExported(node);
        for (const d of node.declarationList.declarations) {
          const n = nameOf(d);
          if (n) add(exported ? 'export.const' : 'const', n);
        }
        break;
      }
      case K.ExportDeclaration:
        if (node.moduleSpecifier?.text) imports.push(node.moduleSpecifier.text);
        for (const el of node.exportClause?.elements || []) add('export', nameOf(el));
        break;
      default: break;
    }
    ts.forEachChild(node, (c) => visit(c, scope));
  };
  ts.forEachChild(sf, (n) => visit(n, []));

  return { symbols: [...new Set(symbols)].sort(), imports: [...new Set(imports)].sort(), notes: [] };
}

export function tsFunctions(filePath, content) {
  const sf = parse(filePath, content);
  const K = ts.SyntaxKind;
  const found = [];
  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;

  const bindingName = (node) => {
    // An arrow or function expression takes the name of what it is bound to,
    // the way a person reads it.
    const p = node.parent;
    if (!p) return null;
    if (p.kind === K.VariableDeclaration || p.kind === K.PropertyAssignment || p.kind === K.PropertyDeclaration) return nameOf(p);
    if (p.kind === K.BinaryExpression && p.left?.name) return String(p.left.name.escapedText || p.left.name.text);
    return null;
  };

  const visit = (node, scope) => {
    let next = scope;
    const push = (name, kind) => {
      const full = scope.length ? `${scope.join('.')}.${name}` : name;
      found.push({
        name: full, short_name: name, kind, depth: scope.length,
        parent: scope.length ? scope.join('.') : null,
        start_line: lineOf(node.getStart(sf)), end_line: lineOf(node.getEnd()),
        lines: lineOf(node.getEnd()) - lineOf(node.getStart(sf)) + 1,
        params: (node.parameters || []).length,
        async: !!(node.modifiers || []).find((m) => m.kind === K.AsyncKeyword),
        generator: !!node.asteriskToken,
      });
      next = [...scope, name];
    };

    switch (node.kind) {
      case K.ClassDeclaration:
      case K.ClassExpression:
        push(nameOf(node) || `<class@${lineOf(node.getStart(sf))}>`, 'class');
        break;
      case K.FunctionDeclaration:
        push(nameOf(node) || `<anonymous@${lineOf(node.getStart(sf))}>`, 'function');
        break;
      case K.MethodDeclaration:
      case K.Constructor:
        push(node.kind === K.Constructor ? 'constructor' : (nameOf(node) || `<method@${lineOf(node.getStart(sf))}>`), 'method');
        break;
      case K.GetAccessor:
      case K.SetAccessor:
        push(nameOf(node) || `<accessor@${lineOf(node.getStart(sf))}>`, 'accessor');
        break;
      case K.ArrowFunction:
      case K.FunctionExpression:
        push(bindingName(node) || nameOf(node) || `<anonymous@${lineOf(node.getStart(sf))}>`,
          node.kind === K.ArrowFunction ? 'arrow' : 'function');
        break;
      default: break;
    }
    ts.forEachChild(node, (c) => visit(c, next));
  };
  ts.forEachChild(sf, (n) => visit(n, []));

  return found.sort((a, b) => a.start_line - b.start_line);
}
