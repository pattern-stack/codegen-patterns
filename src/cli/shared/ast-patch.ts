/**
 * AST patching primitives for consumer code (ts-morph based).
 *
 * Used by `codegen project upgrade-openapi` (and future additive-install
 * commands, issue #188) to bring existing consumer files up to the shape
 * `project init` emits on a fresh project, **without** clobbering
 * user-authored content.
 *
 * Every helper is:
 *   - **idempotent**: applying twice leaves the file byte-identical to one
 *     application.
 *   - **surgical**: only touches the specific construct it owns. Existing
 *     imports, decorators, comments, and unrelated providers survive.
 *   - **honest about bail-outs**: when the file's shape is unexpected (e.g.
 *     a factory-based module, a `@Module()` decorator on something other
 *     than a class), the helper returns `{ changed: false, bail: '<reason>' }`
 *     and leaves the file untouched. Callers surface the bail message + the
 *     CONSUMER-SETUP pointer to the user.
 *
 * The helpers mutate a `SourceFile` in memory; the caller is responsible for
 * calling `sourceFile.save()` (or equivalent) once all patches are staged.
 */

import type { SourceFile, ClassDeclaration } from 'ts-morph';
import { SyntaxKind, Node } from 'ts-morph';

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export interface PatchResult {
	changed: boolean;
	/** Human-readable reason the patch could not be applied safely. */
	bail?: string;
	/** Short note explaining what was done (or why nothing was done). */
	note?: string;
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

/**
 * Ensure `import { <named...> } from '<moduleSpecifier>'` exists.
 *
 * Merge semantics:
 *   - If an import from the same module specifier already exists, add any
 *     missing named bindings to that import's named-imports clause.
 *   - Default or namespace imports from the module are preserved; we only
 *     append to the named-imports list.
 *   - Type-only imports are left as type-only and not widened. (We prepend a
 *     new value-level import if needed — though in our use case we only call
 *     this for value imports, so the scenario is rare.)
 */
export function ensureImport(
	sourceFile: SourceFile,
	moduleSpecifier: string,
	named: string[]
): PatchResult {
	if (named.length === 0) return { changed: false, note: 'no names requested' };

	const existing = sourceFile.getImportDeclaration(
		(imp) => imp.getModuleSpecifierValue() === moduleSpecifier
	);

	if (!existing) {
		sourceFile.addImportDeclaration({
			moduleSpecifier,
			namedImports: [...named].sort(),
		});
		return { changed: true, note: `added import from '${moduleSpecifier}'` };
	}

	// Don't widen a type-only import to a value import — that changes runtime
	// semantics. Bail if caller is asking for value bindings from a type-only
	// import.
	if (existing.isTypeOnly()) {
		// Add a *separate* value import directly after the type import to
		// avoid mangling the existing type-only one.
		sourceFile.insertImportDeclaration(existing.getChildIndex() + 1, {
			moduleSpecifier,
			namedImports: [...named].sort(),
		});
		return {
			changed: true,
			note: `added value import from '${moduleSpecifier}' (existing was type-only)`,
		};
	}

	const current = new Set(existing.getNamedImports().map((n) => n.getName()));
	const missing = named.filter((n) => !current.has(n));
	if (missing.length === 0) return { changed: false, note: 'import already satisfied' };

	existing.addNamedImports(missing.map((name) => ({ name })));
	return {
		changed: true,
		note: `added [${missing.join(', ')}] to existing import from '${moduleSpecifier}'`,
	};
}

// ---------------------------------------------------------------------------
// Class declarations (OpenApiModule)
// ---------------------------------------------------------------------------

/**
 * Ensure a class declaration with the given name exists in the source file.
 * If missing, inserts `source` (a verbatim TypeScript snippet containing the
 * class) immediately **before** the anchor class (usually `AppModule`).
 *
 * If a class with the same name already exists, this is a no-op — even if
 * its decorator/body shape has drifted. We deliberately do **not** rewrite
 * existing classes: once the user has customised `OpenApiModule`, their
 * customisation wins. Callers are expected to surface a warning when that
 * happens so the user knows to audit.
 */
export function ensureClassDeclaration(
	sourceFile: SourceFile,
	className: string,
	snippet: string,
	opts: { insertBeforeClass?: string } = {}
): PatchResult {
	const existing = sourceFile.getClass(className);
	if (existing) {
		return {
			changed: false,
			note: `class '${className}' already present — leaving as-is`,
		};
	}

	const anchor = opts.insertBeforeClass
		? sourceFile.getClass(opts.insertBeforeClass)
		: undefined;

	if (anchor) {
		// Insert before everything attached to the anchor class — JSDoc and
		// decorators included. We anchor on the class's JSDoc block if
		// present (`getJsDocs()[0]`), fall back to its first decorator, and
		// finally to the class keyword. Without this, a JSDoc on the anchor
		// class ends up stranded above the inserted OpenApiModule.
		const jsDoc = anchor.getJsDocs()[0];
		const firstDecorator = anchor.getDecorators()[0];
		const anchorNode = jsDoc ?? firstDecorator ?? anchor;
		const insertPos = anchorNode.getStart();
		sourceFile.insertText(insertPos, ensureTrailingNewline(snippet) + '\n');
	} else {
		// Fall back to appending at end of file.
		sourceFile.addStatements('\n' + snippet.trimEnd() + '\n');
	}

	return { changed: true, note: `inserted class '${className}'` };
}

function ensureTrailingNewline(s: string): string {
	return s.endsWith('\n') ? s : s + '\n';
}

// ---------------------------------------------------------------------------
// @Module imports array
// ---------------------------------------------------------------------------

/**
 * Ensure `moduleName` appears in the `@Module({ imports: [...] })` decorator
 * of the given class declaration.
 *
 * Bail-out conditions (return `{ changed: false, bail: '...' }`):
 *   - Class has no `@Module()` decorator.
 *   - `@Module()` is not a call expression (e.g. a factory was used).
 *   - The decorator argument isn't an object literal.
 *   - `imports` exists but is not an array literal (e.g. a spread of a
 *     function result, a const alias, etc.).
 */
export function ensureModuleImportEntry(
	classDecl: ClassDeclaration,
	moduleName: string
): PatchResult {
	const decorator = classDecl.getDecorator('Module');
	if (!decorator) {
		return {
			changed: false,
			bail: `class '${classDecl.getName()}' has no @Module() decorator`,
		};
	}
	if (!decorator.isDecoratorFactory()) {
		return {
			changed: false,
			bail: `@Module on '${classDecl.getName()}' is not a call expression`,
		};
	}
	const [arg] = decorator.getArguments();
	if (!arg || !Node.isObjectLiteralExpression(arg)) {
		return {
			changed: false,
			bail: `@Module on '${classDecl.getName()}' takes a non-object argument (factory?)`,
		};
	}

	let importsProp = arg.getProperty('imports');
	if (!importsProp) {
		arg.addPropertyAssignment({
			name: 'imports',
			initializer: `[${moduleName}]`,
		});
		return { changed: true, note: `created imports: [${moduleName}]` };
	}

	if (!Node.isPropertyAssignment(importsProp)) {
		return {
			changed: false,
			bail: `@Module.imports on '${classDecl.getName()}' is not a simple property assignment`,
		};
	}

	const init = importsProp.getInitializer();
	if (!init || !Node.isArrayLiteralExpression(init)) {
		return {
			changed: false,
			bail: `@Module.imports on '${classDecl.getName()}' is not an array literal (spread/alias?)`,
		};
	}

	// Idempotency: bail out (as no-op) if moduleName already appears as a
	// top-level element. We only inspect direct children; if the user spreads
	// a variable that happens to contain `moduleName`, we can't see it, but
	// that's a rare enough shape not to over-engineer around.
	const already = init.getElements().some((el) => {
		// Plain identifier: `OpenApiModule`
		if (Node.isIdentifier(el) && el.getText() === moduleName) return true;
		// Spread of something named the same (unlikely, but harmless to check)
		if (Node.isSpreadElement(el)) {
			const expr = el.getExpression();
			if (Node.isIdentifier(expr) && expr.getText() === moduleName) return true;
		}
		return false;
	});
	if (already) {
		return { changed: false, note: `${moduleName} already in imports` };
	}

	// Insert BEFORE the first spread element, if any (convention: named
	// modules come before `...GENERATED_MODULES`).
	const elements = init.getElements();
	const spreadIdx = elements.findIndex((el) => Node.isSpreadElement(el));
	const insertAt = spreadIdx === -1 ? elements.length : spreadIdx;
	init.insertElement(insertAt, moduleName);

	return { changed: true, note: `added ${moduleName} to imports` };
}

// ---------------------------------------------------------------------------
// main.ts — Swagger bootstrap block
// ---------------------------------------------------------------------------

export interface MainSwaggerPatchOptions {
	/** The full Swagger block to inject (imports + in-bootstrap code). */
	swaggerImports: string[];
	/** Snippet inserted inside the bootstrap function, after `app` creation. */
	swaggerBlock: string;
}

/**
 * Best-effort patch of `src/main.ts`:
 *   - Skip if `SwaggerModule.setup(...)` is already called anywhere.
 *   - Otherwise: find the `NestFactory.create(...)` call, walk up to its
 *     containing statement, and insert `swaggerBlock` immediately after it.
 *     Add `swaggerImports` at the top of the file.
 *
 * Bails when:
 *   - `NestFactory.create(...)` is not found (consumer has an exotic
 *     bootstrap).
 */
export function ensureMainSwaggerBlock(
	sourceFile: SourceFile,
	opts: MainSwaggerPatchOptions
): PatchResult {
	// Already wired?
	const text = sourceFile.getFullText();
	if (/SwaggerModule\.setup\s*\(/.test(text)) {
		return { changed: false, note: 'SwaggerModule.setup already present' };
	}

	// Find `NestFactory.create(...)` call.
	const calls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
	const createCall = calls.find((c) => {
		const expr = c.getExpression();
		return Node.isPropertyAccessExpression(expr) && expr.getText() === 'NestFactory.create';
	});
	if (!createCall) {
		return {
			changed: false,
			bail: "couldn't find NestFactory.create(...) — custom bootstrap shape",
		};
	}

	// Walk up to the enclosing statement (usually
	// `const app = await NestFactory.create(...);`).
	let stmt: Node | undefined = createCall;
	while (stmt && !Node.isStatement(stmt)) stmt = stmt.getParent();
	if (!stmt) {
		return {
			changed: false,
			bail: "NestFactory.create(...) is not inside a statement",
		};
	}

	// Insert Swagger block right after the statement.
	const insertPos = stmt.getEnd();
	sourceFile.insertText(insertPos, '\n\n' + opts.swaggerBlock.trimEnd() + '\n');

	// Add required imports (merging into existing clauses where possible).
	for (const importLine of opts.swaggerImports) {
		const match = importLine.match(
			/^import\s+\{\s*([^}]+)\s*\}\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/
		);
		if (match) {
			const names = match[1]!.split(',').map((s) => s.trim()).filter(Boolean);
			ensureImport(sourceFile, match[2]!, names);
		} else {
			// Fallback: prepend verbatim at top of file.
			sourceFile.insertStatements(0, importLine);
		}
	}

	return { changed: true, note: 'inserted Swagger bootstrap block' };
}
