import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

// Helpers for the live tests: load one app file with every import replaced by `mods` (anything not in `mods`
// is an error, so a test also proves what a file loads), and read a file's code without its comments.

export const root = resolve(import.meta.dirname, '../..');

export function loadTs(file, mods, { required = [], globals = {} } = {}) {
  const code = ts.transpileModule(readFileSync(join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    fileName: file,
  }).outputText;
  const module = { exports: {} };
  // `globals` itself becomes the file's global object, so a test can look at (or change) its globals later.
  const context = globals;
  const defaults = {
    console: { warn() {}, log() {}, error() {} },
    Promise, Date, Math, Number, String, Array, Object, Map, Set, Error, Uint8Array,
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: (...args) => clearTimeout(...args),
  };
  for (const [key, value] of Object.entries(defaults)) if (!(key in context)) context[key] = value;
  context.module = module;
  context.exports = module.exports;
  context.require = (id) => {
    required.push(id);
    if (Object.hasOwn(mods, id)) {
      const value = mods[id];
      if (value instanceof Error) throw value;
      return value;
    }
    throw new Error(`unexpected import ${id} in ${file}`);
  };
  vm.runInNewContext(code, context);
  return module.exports;
}

// The code only (comments may name packages and handlers to explain them).
export function codeOf(file) {
  const text = readFileSync(join(root, file), 'utf8');
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, file.endsWith('x') ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard, text);
  let out = '';
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia) continue;
    out += scanner.getTokenText();
  }
  return out;
}

export function sourceOf(file, text = readFileSync(join(root, file), 'utf8')) {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

// Everything a file loads FOR REAL (types vanish, so `import type …`, `import { type X }` and
// `typeof import('…')` don't count): [{ spec, inFunction }] where inFunction is the name of the function the
// load sits in (null = at the top of the file).
export function valueLoads(file, text) {
  const source = sourceOf(file, text);
  const found = [];
  const fnName = (node) => {
    for (let p = node.parent; p; p = p.parent) {
      if (ts.isFunctionDeclaration(p) && p.name) return p.name.text;
      if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && ts.isVariableDeclaration(p.parent)) return p.parent.name.getText();
      if (ts.isMethodDeclaration(p) || ts.isFunctionExpression(p) || ts.isArrowFunction(p)) return '(function)';
    }
    return null;
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const typeOnly = clause && (clause.isTypeOnly || (!clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings)
        && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every((e) => e.isTypeOnly)));
      if (!typeOnly) found.push({ spec: node.moduleSpecifier.text, inFunction: null });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      if (!node.isTypeOnly) found.push({ spec: node.moduleSpecifier.text, inFunction: null });
    } else if (ts.isCallExpression(node) && node.arguments.length && ts.isStringLiteralLike(node.arguments[0])
      && ((ts.isIdentifier(node.expression) && node.expression.text === 'require') || node.expression.kind === ts.SyntaxKind.ImportKeyword)) {
      found.push({ spec: node.arguments[0].text, inFunction: fnName(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

// The names a file exports as values (functions, constants, classes), sorted.
export function valueExports(file) {
  const source = sourceOf(file);
  const names = [];
  for (const statement of source.statements) {
    const exported = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) names.push(statement.name.text);
    else if (ts.isVariableStatement(statement)) for (const d of statement.declarationList.declarations) names.push(d.name.getText());
  }
  return names.sort();
}
