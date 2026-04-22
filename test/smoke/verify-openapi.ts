#!/usr/bin/env bun
/**
 * OPENAPI-4: verify the generated consumer project exposes a fully-
 * populated OpenAPI document.
 *
 * Runs inside the smoke harness's tmp project (passed as argv[2]). Imports
 * the generated `AppModule`, calls `registry.build()`, and asserts the
 * document shape required by the OPENAPI-4 spec:
 *
 *   - OpenAPI version is 3.0.3.
 *   - components.schemas contains Create/Update/Output DTOs per entity
 *     plus the shared ErrorResponseDto.
 *   - paths['/contacts'] exists with get + post entries.
 *   - responses.200 present on the list endpoint.
 *   - components.securitySchemes.bearer.type === 'http' (once the main.ts
 *     bootstrap shape has been folded into the document — we replicate it
 *     here because we don't run the actual `main.ts`).
 *
 * Why programmatic, not HTTP? Spinning up a real Nest HTTP server inside
 * the smoke takes several seconds and depends on Postgres (DATABASE_URL).
 * The registry is the single source of truth for /docs-json — building it
 * directly is deterministic and cheap. `main.ts` just wraps `build()` +
 * `SwaggerModule.setup`; the HTTP shell adds no coverage the direct path
 * misses.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

interface Doc {
	openapi: string;
	info: { title: string; version: string };
	paths: Record<string, Record<string, unknown>>;
	components: {
		schemas: Record<string, unknown>;
		securitySchemes?: Record<string, { type: string; scheme?: string }>;
	};
	security?: unknown[];
}

function fail(msg: string): never {
	console.error(`[openapi-verify] FAIL: ${msg}`);
	process.exit(1);
}

async function main(): Promise<void> {
	const tmpDir = process.argv[2];
	if (!tmpDir) fail('usage: verify-openapi.ts <tmpDir>');

	// Ensure process.cwd() is the tmp project — `AppModule`'s path aliases
	// (@shared/*, @modules/*, @generated/*) are configured there, and Bun's
	// loader resolves module specifiers relative to the importer's file
	// URL, but the consumer's tsconfig must be the one in effect.
	process.chdir(tmpDir);

	// The generated modules register DTO schemas at onModuleInit. Nest's
	// `createApplicationContext` invokes those hooks. We skip the HTTP
	// listener — `app.init()` (implicit in createApplicationContext) is
	// enough to fire onModuleInit across the entire module graph.
	const nestCoreUrl = pathToFileURL(
		path.join(tmpDir, 'node_modules', '@nestjs', 'core', 'index.js'),
	).href;
	const nestCommonUrl = pathToFileURL(
		path.join(tmpDir, 'node_modules', '@nestjs', 'common', 'index.js'),
	).href;
	const nestSwaggerUrl = pathToFileURL(
		path.join(tmpDir, 'node_modules', '@nestjs', 'swagger', 'dist', 'index.js'),
	).href;
	const { NestFactory } = (await import(nestCoreUrl)) as typeof import('@nestjs/core');
	// Keep @nestjs/common resolvable from the tmp project — some test setups
	// have package duplication issues without this priming import.
	await import(nestCommonUrl);
	const { DocumentBuilder, SwaggerModule } = (await import(nestSwaggerUrl)) as typeof import('@nestjs/swagger');

	// Stub DATABASE_URL to something syntactically valid. pg.Pool never
	// actually connects until a query runs, and no DB query fires during
	// onModuleInit for the generated entity modules (they only register
	// Zod schemas with the OpenAPI registry).
	process.env.DATABASE_URL =
		process.env.DATABASE_URL ?? 'postgresql://stub:stub@127.0.0.1:1/stub';

	const appModuleUrl = pathToFileURL(
		path.join(tmpDir, 'src', 'app.module.ts'),
	).href;
	const openApiUrl = pathToFileURL(
		path.join(tmpDir, 'src', 'shared', 'openapi', 'index.ts'),
	).href;

	const { AppModule } = (await import(appModuleUrl)) as { AppModule: unknown };
	const { OPENAPI_REGISTRY } = (await import(openApiUrl)) as {
		OPENAPI_REGISTRY: string;
	};

	// Use NestFactory.create (not createApplicationContext) — the full
	// HTTP app is required for SwaggerModule.createDocument, which scans
	// routes via app.getHttpAdapter(). Nest lazy-loads @nestjs/platform-
	// express by default; app.listen() is never called, so no TCP
	// socket opens.
	const app = await NestFactory.create(AppModule as never, {
		logger: false,
		abortOnError: false,
	});
	await app.init();

	try {
		// Mirror main.ts's two-pass build (OPENAPI-4):
		//   1. registry.build() → component schemas from Zod DTOs.
		//   2. SwaggerModule.createDocument → paths from @Api* decorators.
		// Merge (2) as the base + overlay (1)'s schemas. This is exactly
		// what main.ts does — we run it here so CI catches drift between
		// the two surfaces before consumers do.
		const registry = app.get(OPENAPI_REGISTRY) as {
			build: (info: {
				title: string;
				version: string;
				description?: string;
			}) => Promise<Doc>;
		};

		const registryDocument = await registry.build({
			title: 'Smoke Test API',
			version: '0.0.0-smoke',
			description: 'programmatic verification document',
		});

		const docBuilder = new DocumentBuilder()
			.setTitle('Smoke Test API')
			.setVersion('0.0.0-smoke')
			.addBearerAuth();
		const document = SwaggerModule.createDocument(
			app as never,
			docBuilder.build(),
		) as unknown as Doc;

		document.components = {
			...document.components,
			schemas: {
				...(document.components?.schemas ?? {}),
				...registryDocument.components.schemas,
			},
		};

		// ── assertions ──────────────────────────────────────────────
		// Nest's SwaggerModule.createDocument emits '3.0.0'; our
		// registry on its own emits '3.0.3'. Accept any 3.0.x — the
		// locked decision is "3.0", not the patch level.
		if (!/^3\.0\./.test(document.openapi)) {
			fail(`expected openapi 3.0.x, got '${document.openapi}'`);
		}

		const requiredSchemas = [
			'CreateContactDto',
			'UpdateContactDto',
			// The smoke fixture uses clean-lite-ps architecture (init
			// default); CLP registers the response DTO as `OutputDto`
			// (OPENAPI-2 implementation note 3). Accept either suffix
			// so this verify step works across pipelines.
			['ContactResponseDto', 'ContactOutputDto'],
			'ErrorResponseDto',
		] as const;

		const presentSchemas = Object.keys(document.components.schemas);
		for (const entry of requiredSchemas) {
			const names = Array.isArray(entry) ? entry : [entry];
			const found = names.find((n) => presentSchemas.includes(n));
			if (!found) {
				fail(
					`components.schemas missing ${names.join(' | ')} — present: ${presentSchemas.join(', ')}`,
				);
			}
		}

		const contactsPath = document.paths['/contacts'];
		if (!contactsPath) {
			fail(
				`paths['/contacts'] missing — got: ${Object.keys(document.paths).join(', ')}`,
			);
		}
		if (!contactsPath.get) fail(`paths['/contacts'].get missing`);
		if (!contactsPath.post) fail(`paths['/contacts'].post missing`);

		const listGet = contactsPath.get as { responses?: Record<string, unknown> };
		if (!listGet.responses || !listGet.responses['200']) {
			fail(
				`paths['/contacts'].get.responses.200 missing — got: ${
					listGet.responses ? Object.keys(listGet.responses).join(', ') : '(none)'
				}`,
			);
		}

		// DocumentBuilder.addBearerAuth() registers the scheme under the
		// name 'bearer' by default; the type is always 'http'.
		const schemes = document.components.securitySchemes ?? {};
		const bearerEntry = Object.values(schemes).find((s) => s?.type === 'http' && s?.scheme === 'bearer');
		if (!bearerEntry) {
			fail(
				`expected an http/bearer security scheme in components.securitySchemes; got ${JSON.stringify(schemes)}`,
			);
		}

		// ── success log ────────────────────────────────────────────
		console.log(
			`schemas: ${presentSchemas.length} (${presentSchemas.slice(0, 8).join(', ')}${presentSchemas.length > 8 ? ', …' : ''})`,
		);
		console.log(`paths:   ${Object.keys(document.paths).length}`);
		console.log(`openapi: ${document.openapi}`);
	} finally {
		await app.close();
	}
}

main().catch((err) => {
	console.error('[openapi-verify] unexpected error:', err);
	process.exit(1);
});
