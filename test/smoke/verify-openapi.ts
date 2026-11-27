#!/usr/bin/env bun
/**
 * OPENAPI-4: verify the generated consumer project exposes a fully-
 * populated OpenAPI document.
 *
 * Runs inside the smoke harness's tmp project (passed as argv[2]). Imports
 * the generated `AppModule` and builds the document in the order the shipped
 * `main.ts` does — `NestFactory.create()`, then `registry.build()`, with NO
 * `app.init()` in between (main.ts cannot init first: `init()` installs the
 * router's not-found handler, and Swagger mounted after it 404s). It used to
 * call `app.init()` first, which ran every `onModuleInit` and so could not
 * see that the shipped order left the registry empty (every entity `$ref` in
 * `/docs-json` dangled in a fresh app; rehearsal of 0.35.0). Asserts:
 *
 *   - every `$ref` in the document names a `components.schemas` entry.
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
import { danglingRefs } from './_openapi-refs';

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

	// ADR-043: after `project upgrade-auth` the generated AppModule imports
	// AuthModule.forRoot({ encryptionKey: 'env' }), whose EnvEncryptionKey
	// reads INTEGRATION_TOKEN_ENCRYPTION_KEY at construction (app.init()).
	// Provide a syntactically valid 32-byte base64 key — this path only builds
	// the OpenAPI document; no token is ever encrypted.
	process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY =
		process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY ?? Buffer.alloc(32, 7).toString('base64');

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
	// No `app.init()` here: main.ts builds the document before `app.listen()`,
	// so this does too. Calling it would run `onModuleInit` and hide exactly the
	// ordering defect this gate exists for.

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
		// Every $ref must resolve. A validator alone does not catch a dangling
		// component ref (@readme/openapi-parser's validate() accepted one).
		const dangling = danglingRefs(document);
		if (dangling.length > 0) {
			fail(
				`${dangling.length} $ref(s) do not resolve in the document: ${dangling.join(', ')} — present: ${Object.keys(document.components.schemas).join(', ')}`,
			);
		}

		// Nest's SwaggerModule.createDocument emits '3.0.0'; our
		// registry on its own emits '3.0.3'. Accept any 3.0.x — the
		// locked decision is "3.0", not the patch level.
		if (!/^3\.0\./.test(document.openapi)) {
			fail(`expected openapi 3.0.x, got '${document.openapi}'`);
		}

		// `family` (argv[3]) is passed by the scenario whose fixtures carry the joined-table family (RFC-0006, #875): the
		// family checks run exactly when it is named, so a scenario that should have the family cannot skip them.
		const withFamily = process.argv[3] === 'family';
		const requiredSchemas = [
			'CreateContactDto',
			'UpdateContactDto',
			// backend registers the response DTO as `OutputDto`
			// (OPENAPI-2 implementation note 3).
			'ContactOutputDto',
			'ErrorResponseDto',
			...(withFamily ? (['CreateMeetingDto', 'MeetingOutputDto'] as const) : []),
		] as const;

		const presentSchemas = Object.keys(document.components.schemas);
		for (const name of requiredSchemas) {
			if (!presentSchemas.includes(name)) {
				fail(`components.schemas missing ${name} — present: ${presentSchemas.join(', ')}`);
			}
		}

		if (withFamily) {
			// A child's output is FLAT: the base's columns and its own at one level, the kind fixed (RFC-0006 §5).
			const flat = document.components.schemas['MeetingOutputDto'] as { properties?: Record<string, unknown> };
			for (const key of ['id', 'kind', 'tenantId', 'occurredAt', 'source', 'title', 'startsAt']) {
				if (!flat.properties || !(key in flat.properties)) {
					fail(`MeetingOutputDto is not flat: no '${key}' — has: ${Object.keys(flat.properties ?? {}).join(', ')}`);
				}
			}
			if ('communication' in (flat.properties ?? {})) fail(`MeetingOutputDto nests 'communication'; a child is flat`);

			// A base whose every kind has a child table has no create route, so it registers no create schema either.
			// Positive controls first: the module is mounted (its list route and its update schema exist), so the
			// two absences below cannot pass because the module is missing.
			if (!document.paths['/communication_parts']?.get) fail(`paths['/communication_parts'].get is missing`);
			if (!presentSchemas.includes('UpdateCommunicationPartDto')) fail('UpdateCommunicationPartDto is not registered');
			if (presentSchemas.includes('CreateCommunicationPartDto')) {
				fail('CreateCommunicationPartDto is registered, but communication_part has no create route');
			}
			if (document.paths['/communication_parts']?.post) fail(`paths['/communication_parts'].post exists`);

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
