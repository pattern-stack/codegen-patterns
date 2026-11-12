/**
 * Emitted-name hygiene lint (#813). Two rules, one subject: generated code must
 * not be breakable by an entity name or plural that validation accepts.
 *
 *  rule 1 — a file in which an entity type can be in scope never names a lib
 *           global type unqualified, except the reserved ones
 *           (RESERVED_ENTITY_TYPE_NAMES: Promise, Array, Date).
 *  rule 2 — a function that reads a table export by its identifier declares no
 *           binding a plural could equal (all-lowercase snake_case).
 *
 * Syntactic only (ts.createSourceFile): no program, no module resolution.
 */
import ts from 'typescript';
import { RESERVED_ENTITY_TYPE_NAMES } from '../src/schema/reserved-entity-names';

export interface EmittedFile {
  readonly path: string;
  readonly text: string;
}

export interface HygieneViolation {
  readonly path: string;
  readonly line: number;
  readonly rule: 'unqualified-lib-type' | 'plural-shaped-binding';
  readonly name: string;
  readonly detail: string;
}

let libNames: ReadonlySet<string> | null = null;

/**
 * Every type symbol in scope of an empty file under lib ES2022 + DOM whose
 * declarations all live in default-library files. Computed from the installed
 * `typescript`, so it tracks the compiler rather than a hand-kept list.
 */
export function libGlobalTypeNames(): ReadonlySet<string> {
  if (libNames) return libNames;
  const fileName = '/__hygiene__/empty.ts';
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    noEmit: true,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, ...rest) =>
    name === fileName ? ts.createSourceFile(name, '', ts.ScriptTarget.ES2022) : getSourceFile(name, ...rest);
  host.fileExists = ((orig) => (n: string) => n === fileName || orig(n))(host.fileExists.bind(host));
  const program = ts.createProgram([fileName], options, host);
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(fileName)!;
  const out = new Set<string>();
  for (const sym of checker.getSymbolsInScope(sf, ts.SymbolFlags.Type)) {
    const decls = sym.declarations ?? [];
    if (decls.length === 0) continue;
    if (decls.every((d) => program.isSourceFileDefaultLibrary(d.getSourceFile()))) out.add(sym.name);
  }
  libNames = out;
  return out;
}

const ENTITY_SPECIFIER = /(\.entity|\/entities\/[a-z][a-z0-9_]*)$/;
const PLURAL_SHAPE = /^[a-z][a-z0-9_]*$/;

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function specifierText(decl: ts.ImportDeclaration): string {
  return ts.isStringLiteral(decl.moduleSpecifier) ? decl.moduleSpecifier.text : '';
}

/** Names bound at file level (imports, type aliases, interfaces, classes, enums). */
function fileLevelBindings(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && st.importClause) {
      const c = st.importClause;
      if (c.name) names.add(c.name.text);
      const nb = c.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) names.add(nb.name.text);
      if (nb && ts.isNamedImports(nb)) for (const e of nb.elements) names.add(e.name.text);
    } else if (
      ts.isTypeAliasDeclaration(st) ||
      ts.isInterfaceDeclaration(st) ||
      ts.isClassDeclaration(st) ||
      ts.isEnumDeclaration(st)
    ) {
      if (st.name) names.add(st.name.text);
    }
  }
  return names;
}

function entityTypeInScope(sf: ts.SourceFile): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isImportDeclaration(n) && ENTITY_SPECIFIER.test(specifierText(n))) found = true;
    else if (
      ts.isTypeAliasDeclaration(n) &&
      ts.isTypeReferenceNode(n.type) &&
      ts.isIdentifier(n.type.typeName) &&
      n.type.typeName.text === 'InferSelectModel'
    )
      found = true;
    else ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

function rule1(path: string, sf: ts.SourceFile, out: HygieneViolation[]): void {
  if (!entityTypeInScope(sf)) return;
  const lib = libGlobalTypeNames();
  const bound = fileLevelBindings(sf);
  const reserved = new Set(RESERVED_ENTITY_TYPE_NAMES.map((r) => r.global));
  const check = (id: ts.Node) => {
    if (!ts.isIdentifier(id)) return;
    const name = id.text;
    if (!lib.has(name) || bound.has(name) || reserved.has(name)) return;
    out.push({
      path,
      line: lineOf(sf, id),
      rule: 'unqualified-lib-type',
      name,
      detail: `write globalThis.${name}, or reserve it in src/schema/reserved-entity-names.ts`,
    });
  };
  const visit = (n: ts.Node) => {
    if (ts.isTypeReferenceNode(n)) check(n.typeName);
    else if (ts.isExpressionWithTypeArguments(n) && ts.isHeritageClause(n.parent)) check(n.expression);
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

function isFunctionLike(n: ts.Node): n is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isConstructorDeclaration(n) ||
    ts.isGetAccessor(n) ||
    ts.isSetAccessor(n)
  );
}

function tableExports(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && st.importClause && ENTITY_SPECIFIER.test(specifierText(st))) {
      // Type-only imports count too: `typeof <plural>` reads the table binding, and
      // a local of the same name declared in that scope shadows it (READ-1 review).
      const nb = st.importClause.namedBindings;
      if (nb && ts.isNamedImports(nb)) {
        for (const e of nb.elements) if (PLURAL_SHAPE.test(e.name.text)) names.add(e.name.text);
      }
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (
          ts.isIdentifier(d.name) &&
          d.initializer &&
          ts.isCallExpression(d.initializer) &&
          ts.isIdentifier(d.initializer.expression) &&
          d.initializer.expression.text === 'pgTable'
        )
          names.add(d.name.text);
      }
    }
  }
  return names;
}

function bindingNames(name: ts.BindingName, into: ts.Identifier[]): void {
  if (ts.isIdentifier(name)) into.push(name);
  else for (const el of name.elements) if (ts.isBindingElement(el)) bindingNames(el.name, into);
}

/** Bindings a function introduces in its own scope (not those of nested functions). */
function ownBindings(fn: ts.FunctionLikeDeclaration): ts.Identifier[] {
  const ids: ts.Identifier[] = [];
  for (const p of fn.parameters) bindingNames(p.name, ids);
  const visit = (n: ts.Node) => {
    if (isFunctionLike(n) || ts.isClassLike(n)) return;
    if (ts.isVariableDeclaration(n)) bindingNames(n.name, ids);
    else if (ts.isCatchClause(n) && n.variableDeclaration) bindingNames(n.variableDeclaration.name, ids);
    ts.forEachChild(n, visit);
  };
  if (fn.body) visit(fn.body);
  return ids;
}

/** Identifiers in the function (nested ones included) that read `names` as a value. */
function readsAny(fn: ts.Node, names: ReadonlySet<string>): string | null {
  let hit: string | null = null;
  const visit = (n: ts.Node) => {
    if (hit) return;
    if (ts.isIdentifier(n) && names.has(n.text)) {
      const p = n.parent;
      const isPropName =
        (ts.isPropertyAccessExpression(p) && p.name === n) ||
        (ts.isPropertyAssignment(p) && p.name === n) ||
        (ts.isPropertySignature(p) && p.name === n) ||
        (ts.isMethodDeclaration(p) && p.name === n) ||
        (ts.isBindingElement(p) && p.propertyName === n);
      const isDecl =
        (ts.isVariableDeclaration(p) && p.name === n) || (ts.isParameter(p) && p.name === n) ||
        (ts.isBindingElement(p) && p.name === n);
      if (!isPropName && !isDecl) hit = n.text;
    }
    ts.forEachChild(n, visit);
  };
  visit(fn);
  return hit;
}

function rule2(path: string, sf: ts.SourceFile, out: HygieneViolation[]): void {
  const tables = tableExports(sf);
  if (tables.size === 0) return;
  const visit = (n: ts.Node) => {
    if (isFunctionLike(n) && n.body) {
      const read = readsAny(n.body, tables);
      if (read) {
        for (const id of ownBindings(n)) {
          if (!PLURAL_SHAPE.test(id.text)) continue;
          out.push({
            path,
            line: lineOf(sf, id),
            rule: 'plural-shaped-binding',
            name: id.text,
            detail: `binding in a function that reads table export \`${read}\``,
          });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

export function emittedNameViolations(files: readonly EmittedFile[]): HygieneViolation[] {
  const out: HygieneViolation[] = [];
  for (const f of files) {
    if (!/\.tsx?$/.test(f.path)) continue;
    const sf = ts.createSourceFile(f.path, f.text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    rule1(f.path, sf, out);
    rule2(f.path, sf, out);
  }
  return out;
}
