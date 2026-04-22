/**
 * Unit tests for ast-patch primitives.
 *
 * Coverage:
 *   - Idempotency: applying a patch twice yields byte-identical output.
 *   - Preservation: existing imports, decorators, JSDoc, unrelated providers
 *     survive.
 *   - Bail semantics: exotic shapes (missing @Module, factory decorators,
 *     non-array `imports`) return `{ changed: false, bail: ... }` and leave
 *     the file untouched.
 */

import { describe, test, expect } from 'bun:test';
import { Project, IndentationText, QuoteKind, NewLineKind } from 'ts-morph';

import {
	ensureImport,
	ensureClassDeclaration,
	ensureModuleImportEntry,
	ensureMainSwaggerBlock,
} from '../../cli/shared/ast-patch.js';

function mkProject() {
	return new Project({
		useInMemoryFileSystem: true,
		manipulationSettings: {
			indentationText: IndentationText.TwoSpaces,
			quoteKind: QuoteKind.Single,
			newLineKind: NewLineKind.LineFeed,
		},
		skipAddingFilesFromTsConfig: true,
		skipLoadingLibFiles: true,
	});
}

// ---------------------------------------------------------------------------
// ensureImport
// ---------------------------------------------------------------------------

describe('ensureImport', () => {
	test('adds a fresh import when module is absent', () => {
		const project = mkProject();
		const sf = project.createSourceFile('src/app.module.ts', `export const x = 1;\n`);
		const res = ensureImport(sf, '@nestjs/common', ['Module', 'Global']);
		expect(res.changed).toBe(true);
		const text = sf.getFullText();
		expect(text).toContain("import { Global, Module } from '@nestjs/common'");
	});

	test('merges named bindings into an existing import', () => {
		const project = mkProject();
		const sf = project.createSourceFile(
			'src/app.module.ts',
			`import { Module } from '@nestjs/common';\nexport const x = 1;\n`
		);
		const res = ensureImport(sf, '@nestjs/common', ['Global', 'Module']);
		expect(res.changed).toBe(true);
		const text = sf.getFullText();
		expect(text).toMatch(/import \{ Module, Global \} from '@nestjs\/common'/);
	});

	test('is idempotent — applying twice gives identical text', () => {
		const project = mkProject();
		const sf = project.createSourceFile(
			'src/a.ts',
			`import { Module } from '@nestjs/common';\n`
		);
		ensureImport(sf, '@nestjs/common', ['Global', 'Module']);
		const once = sf.getFullText();
		const res2 = ensureImport(sf, '@nestjs/common', ['Global', 'Module']);
		expect(res2.changed).toBe(false);
		expect(sf.getFullText()).toBe(once);
	});

	test('no-op when import already fully satisfied', () => {
		const project = mkProject();
		const sf = project.createSourceFile(
			'src/a.ts',
			`import { Global, Module } from '@nestjs/common';\n`
		);
		const before = sf.getFullText();
		const res = ensureImport(sf, '@nestjs/common', ['Module']);
		expect(res.changed).toBe(false);
		expect(sf.getFullText()).toBe(before);
	});
});

// ---------------------------------------------------------------------------
// ensureClassDeclaration
// ---------------------------------------------------------------------------

describe('ensureClassDeclaration', () => {
	const SNIPPET = `@Module({ providers: [] })\nclass OpenApiModule {}`;

	test('inserts class before anchor class if missing', () => {
		const project = mkProject();
		const sf = project.createSourceFile(
			'src/app.module.ts',
			`import { Module } from '@nestjs/common';\n\n@Module({ imports: [] })\nexport class AppModule {}\n`
		);
		const res = ensureClassDeclaration(sf, 'OpenApiModule', SNIPPET, {
			insertBeforeClass: 'AppModule',
		});
		expect(res.changed).toBe(true);
		const text = sf.getFullText();
		expect(text.indexOf('OpenApiModule')).toBeLessThan(text.indexOf('AppModule'));
	});

	test('is idempotent when class is already present', () => {
		const project = mkProject();
		const sf = project.createSourceFile(
			'src/app.module.ts',
			`${SNIPPET}\n\nexport class AppModule {}\n`
		);
		const before = sf.getFullText();
		const res = ensureClassDeclaration(sf, 'OpenApiModule', SNIPPET, {
			insertBeforeClass: 'AppModule',
		});
		expect(res.changed).toBe(false);
		expect(sf.getFullText()).toBe(before);
	});

	test('preserves existing JSDoc/decorators on anchor class', () => {
		const project = mkProject();
		const sf = project.createSourceFile(
			'src/app.module.ts',
			`import { Module } from '@nestjs/common';\n\n/**\n * Docs here.\n */\n@Module({ imports: [] })\nexport class AppModule {}\n`
		);
		ensureClassDeclaration(sf, 'OpenApiModule', SNIPPET, {
			insertBeforeClass: 'AppModule',
		});
		const text = sf.getFullText();
		expect(text).toContain('Docs here.');
		expect(text).toContain('@Module({ imports: [] })\nexport class AppModule');
	});
});

// ---------------------------------------------------------------------------
// ensureModuleImportEntry
// ---------------------------------------------------------------------------

describe('ensureModuleImportEntry', () => {
	test('appends to existing imports array', () => {
		const project = mkProject();
		const sf = project.createSourceFile(
			'src/app.module.ts',
			`import { Module } from '@nestjs/common';\n@Module({ imports: [DatabaseModule] })\nexport class AppModule {}\n`
		);
		const cls = sf.getClassOrThrow('AppModule');
		const res = ensureModuleImportEntry(cls, 'OpenApiModule');
		expect(res.changed).toBe(true);
		expect(sf.getFullText()).toContain('[DatabaseModule, OpenApiModule]');
	});

	test('inserts before spread element (named-before-spread convention)', () => {
		const project = mkProject();
		const sf = project.createSourceFile(
			'src/app.module.ts',
			`import { Module } from '@nestjs/common';\n@Module({ imports: [DatabaseModule, ...GENERATED_MODULES] })\nexport class AppModule {}\n`
		);
		const cls = sf.getClassOrThrow('AppModule');
		ensureModuleImportEntry(cls, 'OpenApiModule');
		const text = sf.getFullText();
		const openIdx = text.indexOf('OpenApiModule');
		const spreadIdx = text.indexOf('...GENERATED_MODULES');
		expect(openIdx).toBeLessThan(spreadIdx);
	});

	test('creates imports array when missing', () => {
		const project = mkProject();
		const sf = project.createSourceFile(
			'src/app.module.ts',
			`import { Module } from '@nestjs/common';\n@Module({})\nexport class AppModule {}\n`
		);
		const cls = sf.getClassOrThrow('AppModule');
		const res = ensureModuleImportEntry(cls, 'OpenApiModule');
		expect(res.changed).toBe(true);
		expect(sf.getFullText()).toContain('imports: [OpenApiModule]');
	});

	test('is idempotent — already-present module is a no-op', () => {
		const project = mkProject();
		const sf = project.createSourceFile(
			'src/app.module.ts',
			`import { Module } from '@nestjs/common';\n@Module({ imports: [OpenApiModule, DatabaseModule] })\nexport class AppModule {}\n`
		);
		const cls = sf.getClassOrThrow('AppModule');
		const before = sf.getFullText();
		const res = ensureModuleImportEntry(cls, 'OpenApiModule');
		expect(res.changed).toBe(false);
		expect(sf.getFullText()).toBe(before);
	});

	test('bails on missing @Module decorator', () => {
		const project = mkProject();
		const sf = project.createSourceFile(
			'src/app.module.ts',
			`export class AppModule {}\n`
		);
		const cls = sf.getClassOrThrow('AppModule');
		const res = ensureModuleImportEntry(cls, 'OpenApiModule');
		expect(res.changed).toBe(false);
		expect(res.bail).toBeDefined();
		expect(res.bail).toContain('no @Module()');
	});

	test('bails on non-array imports (alias / spread only)', () => {
		const project = mkProject();
		const sf = project.createSourceFile(
			'src/app.module.ts',
			`import { Module } from '@nestjs/common';\nconst ALL = [];\n@Module({ imports: ALL })\nexport class AppModule {}\n`
		);
		const cls = sf.getClassOrThrow('AppModule');
		const res = ensureModuleImportEntry(cls, 'OpenApiModule');
		expect(res.changed).toBe(false);
		expect(res.bail).toContain('array literal');
	});
});

// ---------------------------------------------------------------------------
// ensureMainSwaggerBlock
// ---------------------------------------------------------------------------

describe('ensureMainSwaggerBlock', () => {
	const IMPORTS = ["import { OPENAPI_REGISTRY, OpenApiRegistry } from './shared/openapi';"];
	const BLOCK = `  /* SWAGGER_BOOTSTRAP */\n`;

	test('skips when SwaggerModule.setup is already present', () => {
		const project = mkProject();
		const sf = project.createSourceFile(
			'src/main.ts',
			`import { NestFactory } from '@nestjs/core';\nimport { SwaggerModule } from '@nestjs/swagger';\nimport { AppModule } from './app.module';\nasync function bootstrap() { const app = await NestFactory.create(AppModule); SwaggerModule.setup('/docs', app, {} as any); await app.listen(3000); }\nbootstrap();\n`
		);
		const before = sf.getFullText();
		const res = ensureMainSwaggerBlock(sf, {
			swaggerImports: IMPORTS,
			swaggerBlock: BLOCK,
		});
		expect(res.changed).toBe(false);
		expect(sf.getFullText()).toBe(before);
	});

	test('inserts block after NestFactory.create when absent', () => {
		const project = mkProject();
		const sf = project.createSourceFile(
			'src/main.ts',
			`import { NestFactory } from '@nestjs/core';\nimport { AppModule } from './app.module';\nasync function bootstrap() {\n  const app = await NestFactory.create(AppModule);\n  await app.listen(3000);\n}\nbootstrap();\n`
		);
		const res = ensureMainSwaggerBlock(sf, {
			swaggerImports: IMPORTS,
			swaggerBlock: BLOCK,
		});
		expect(res.changed).toBe(true);
		const text = sf.getFullText();
		expect(text).toContain('SWAGGER_BOOTSTRAP');
		expect(text).toContain("from './shared/openapi'");
		const createIdx = text.indexOf('NestFactory.create');
		const blockIdx = text.indexOf('SWAGGER_BOOTSTRAP');
		expect(createIdx).toBeLessThan(blockIdx);
	});

	test('bails on custom bootstrap (no NestFactory.create)', () => {
		const project = mkProject();
		const sf = project.createSourceFile(
			'src/main.ts',
			`async function bootstrap() { console.log('hi'); }\nbootstrap();\n`
		);
		const res = ensureMainSwaggerBlock(sf, {
			swaggerImports: IMPORTS,
			swaggerBlock: BLOCK,
		});
		expect(res.changed).toBe(false);
		expect(res.bail).toContain('NestFactory.create');
	});
});
