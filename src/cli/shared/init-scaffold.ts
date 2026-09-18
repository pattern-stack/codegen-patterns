/**
 * Init scaffold — compute and (optionally) apply the file set `codegen
 * project init` writes. Pure planning functions + a `writePlan()` actor so
 * unit tests can inspect the plan without hitting the filesystem.
 *
 * Every scaffolded file matches the skeleton in docs/CONSUMER-SETUP.md. The
 * shim files use a computed relative path back to the codegen-patterns
 * runtime so consumers in sibling/workspace/installed layouts all work.
 */

import fs from 'node:fs';
import path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';

import { findYamlFiles } from '../../utils/find-yaml-files.js';
import type { Context } from './context.js';
import { scanProject, generateConfig } from '../../scanner/index.js';
import { runtimeImport, subsystemsImport, type RuntimeMode } from './runtime-import.js';
import { FRONTEND_EMITTED_DEPS } from '../../emitters/frontend/deps.js';
import { DEFAULT_CODEGEN_CONFIG } from '../../config/project-config.js';
import {
	importSpecifier,
	projectLayout,
	tsconfigAliases,
	tsconfigIncludes,
	type ProjectLayout,
} from './project-layout.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PlanAction = 'create' | 'skip' | 'merge' | 'overwrite';

export interface PlanEntry {
	/** Absolute path of the target file or directory. */
	path: string;
	/** Relative path, for display. */
	relPath: string;
	/** What we plan to do. */
	action: PlanAction;
	/** File contents to write (undefined for directory-only entries). */
	content?: string;
	/** Human-readable reason the entry resolved this way. */
	reason?: string;
	/** True if this entry represents a directory (mkdir), not a file. */
	directory?: boolean;
}

export interface InitPlan {
	entries: PlanEntry[];
	/** High-level summary for the user (config snapshot, detected framework). */
	summary: {
		cwd: string;
		framework: string;
		orm: string;
		architecture: string;
		frontend: boolean;
		runtimePath: string;
	};
}

export interface InitOptions {
	cwd: string;
	/** Pass --force — overwrite non-directory files that already exist. */
	force?: boolean;
	/** Create tsconfig.json if it doesn't exist. */
	withTsconfig?: boolean;
	/** Override the detected runtime path (for tests). */
	runtimePath?: string;
	/** Skip running the scanner (use when the caller already has a context). */
	skipScan?: boolean;
	/**
	 * Runtime mode (ADR-037). `package` (default) ⇒ generated code imports
	 * `@pattern-stack/codegen/*` and NOTHING is vendored. `vendored` ⇒ the
	 * runtime closure is vendored into `src/shared/**` and generated code imports
	 * via `@shared/*`. Written into the emitted `codegen.config.yaml`.
	 */
	runtimeMode?: 'package' | 'vendored';
}

// ---------------------------------------------------------------------------
// Runtime path resolution
// ---------------------------------------------------------------------------

/**
 * Absolute path to the codegen runtime source tree (bundled with the CLI).
 *
 * Exported so `codegen update` can re-sync the vendored runtime closure
 * (VENDORED_RUNTIME_FILES) from the freshly-installed package version.
 */
export function runtimeRoot(): string {
	// Dev: src/cli/shared/ → ../../../runtime. Published npm tarball ships
	// runtime at dist/runtime/; dist/src/cli/index.js → ../../../runtime
	// doesn't exist, so fall back to dist/runtime/.
	const pkgRoot = path.resolve(import.meta.dirname, '..', '..', '..');
	const topLevel = path.join(pkgRoot, 'runtime');
	if (fs.existsSync(topLevel)) return topLevel;
	return path.join(pkgRoot, 'dist', 'runtime');
}

/**
 * Display-only relative path from the vendored `<shared>/base-classes/` back to
 * the codegen runtime, for the init summary (the scaffold entries vendor
 * content verbatim — see loadRuntimeFile).
 */
export function resolveRuntimePath(layout: ProjectLayout): string {
	return path.relative(path.join(layout.shared, 'base-classes'), runtimeRoot());
}

/**
 * Load the contents of a runtime file (path relative to the runtime root).
 * Used to vendor runtime files into consumer projects — see ADR note below.
 *
 * Exported for reuse by `codegen update` (re-syncs the same files).
 */
export function loadRuntimeFile(relPath: string): string {
	return fs.readFileSync(path.join(runtimeRoot(), relPath), 'utf-8');
}

// ---------------------------------------------------------------------------
// Content builders
// ---------------------------------------------------------------------------

/**
 * Runtime files vendored into `<backend_src>/shared/...` by `codegen project init`.
 *
 * Why vendor instead of re-export? TypeScript treats identical types coming
 * from different `node_modules` trees as distinct (e.g. two `PgTable<...>`
 * values fail to unify even at identical drizzle-orm versions — the private
 * `shouldInlineParams` field is the giveaway). When shims re-export from
 * `<monorepo>/codegen-patterns/runtime/...`, the consumer ends up compiling
 * against two separate drizzle type graphs: its own `node_modules/drizzle-orm`
 * and the runtime repo's. Vendoring bakes the runtime into the consumer's
 * own module graph, so only one drizzle-orm identity exists.
 *
 * The list is intentionally exhaustive of the transitive closure reachable
 * from `@shared/*` imports in the generated templates — if a generated file
 * imports it (directly or transitively), it's here.
 *
 * Exported as the canonical package-owned vendored closure: `project init`
 * writes it, `project update` re-syncs it. Any file added here is picked up
 * by both flows automatically.
 */
export interface VendoredRuntimeFile {
	/** Path relative to the runtime root (source of truth). */
	runtime: string;
	/**
	 * Destination relative to the vendored runtime root `<backend_src>/shared`
	 * (`ProjectLayout.shared`, the `@shared/*` alias target).
	 */
	target: string;
}

export const VENDORED_RUNTIME_FILES: VendoredRuntimeFile[] = [
	// base-classes — consumer-facing inheritance targets
	{ runtime: 'base-classes/base-repository.ts', target: 'base-classes/base-repository.ts' },
	// Ambient tenant scope — imported by base-repository.ts (scopePredicate)
	{ runtime: 'base-classes/tenant-context.ts', target: 'base-classes/tenant-context.ts' },
	{ runtime: 'base-classes/base-service.ts', target: 'base-classes/base-service.ts' },
	{ runtime: 'base-classes/integrated-entity-repository.ts', target: 'base-classes/integrated-entity-repository.ts' },
	{ runtime: 'base-classes/integrated-entity-service.ts', target: 'base-classes/integrated-entity-service.ts' },
	// Inbound-integration write surface (#374) — deps of integrated/junction repos
	{ runtime: 'base-classes/integration-upsert-config.ts', target: 'base-classes/integration-upsert-config.ts' },
	{ runtime: 'base-classes/junction-integration-repository.ts', target: 'base-classes/junction-integration-repository.ts' },
	{ runtime: 'base-classes/activity-entity-repository.ts', target: 'base-classes/activity-entity-repository.ts' },
	{ runtime: 'base-classes/activity-entity-service.ts', target: 'base-classes/activity-entity-service.ts' },
	{ runtime: 'base-classes/metadata-entity-repository.ts', target: 'base-classes/metadata-entity-repository.ts' },
	{ runtime: 'base-classes/metadata-entity-service.ts', target: 'base-classes/metadata-entity-service.ts' },
	{ runtime: 'base-classes/knowledge-entity-repository.ts', target: 'base-classes/knowledge-entity-repository.ts' },
	{ runtime: 'base-classes/knowledge-entity-service.ts', target: 'base-classes/knowledge-entity-service.ts' },
	{ runtime: 'base-classes/with-analytics.ts', target: 'base-classes/with-analytics.ts' },
	// Capability mixin contract (ADR-041) — the types a `kind: 'capability'`
	// pattern's repository mixin is written against. A vendored consumer whose
	// entity declares a capability imports this from
	// `@shared/base-classes/capability-mixin`; package mode resolves the same
	// source through `@pattern-stack/codegen/runtime/base-classes/capability-mixin`.
	{ runtime: 'base-classes/capability-mixin.ts', target: 'base-classes/capability-mixin.ts' },
	// Library capability mixins (ADR-041.1) — the `mixinImport`s of the library
	// `Actor` / `Communication` patterns, `@shared/base-classes/with-*` here and
	// rewritten to the package path in package mode.
	{ runtime: 'base-classes/with-actor.ts', target: 'base-classes/with-actor.ts' },
	{ runtime: 'base-classes/with-communication.ts', target: 'base-classes/with-communication.ts' },
	// base-classes — transitive deps of base-service
	{ runtime: 'base-classes/lifecycle-events.ts', target: 'base-classes/lifecycle-events.ts' },
	{ runtime: 'base-classes/base-read-use-cases.ts', target: 'base-classes/base-read-use-cases.ts' },
	// Types + constants reached via `@shared/types/*` and `@shared/constants/*`
	{ runtime: 'types/drizzle.ts', target: 'types/drizzle.ts' },
	{ runtime: 'constants/tokens.ts', target: 'constants/tokens.ts' },
	// Events protocol — imported transitively by base-service + lifecycle-events
	{ runtime: 'subsystems/events/event-bus.protocol.ts', target: 'subsystems/events/event-bus.protocol.ts' },
	// The generated typed bus facade (`subsystems/events/generated/bus.ts`,
	// emitted by the event codegen post-step) imports exactly three vendored
	// siblings — `eventsRuntimeImports()` in event-codegen-generator.ts:114-118
	// is the closed list: `../event-bus.protocol` (above), `../events.tokens`
	// and `../events-errors`. Only the protocol was vendored, so every
	// vendored-runtime project shipped a `generated/bus.ts` that could not
	// compile (#575 for the errors module; the tokens module had the same gap).
	// `events-errors.ts` has no relative imports; `events.tokens.ts` imports
	// `../token-key`, which is why that file is here too. If the generated bus
	// ever grows a fourth `../` import, it belongs in this block.
	{ runtime: 'subsystems/events/events-errors.ts', target: 'subsystems/events/events-errors.ts' },
	{ runtime: 'subsystems/events/events.tokens.ts', target: 'subsystems/events/events.tokens.ts' },
	{ runtime: 'subsystems/token-key.ts', target: 'subsystems/token-key.ts' },
	// Pipes — ZodValidationPipe is wired on every generated controller
	// @Body() to give runtime Zod validation at the controller boundary.
	{ runtime: 'pipes/zod-validation.pipe.ts', target: 'pipes/zod-validation.pipe.ts' },
	// Pagination-by-default (Page<T> envelope, ListQuerySchema, resolveListQuery,
	// buildPage, opaque cursor codec) — imported by EVERY generated list
	// controller/dto/use-case. Vendored to `src/shared/http/page.ts` (alias
	// `@shared/http/page`), DISTINCT from the consumer's optional `@shared/http/
	// pagination` search contract so the two never collide. Package mode resolves
	// the same source via `@pattern-stack/codegen/runtime/http/pagination`.
	{ runtime: 'http/pagination.ts', target: 'http/page.ts' },
	// EAV helpers — referenced by generated services on `eav_value_table` entities
	{ runtime: 'eav-helpers.ts', target: 'eav-helpers.ts' },
	// OpenAPI registry (OPENAPI-1/2) — generated modules register Zod DTOs
	// here at onModuleInit; OPENAPI-4 mounts Swagger UI off the same registry.
	// `@anatine/zod-openapi` is an optional peer dep (lazy-imported on build).
	{ runtime: 'shared/openapi/registry.ts', target: 'openapi/registry.ts' },
	{ runtime: 'shared/openapi/registry.tokens.ts', target: 'openapi/registry.tokens.ts' },
	{ runtime: 'shared/openapi/errors.ts', target: 'openapi/errors.ts' },
	// OPENAPI-3: shared error response schema referenced by every generated
	// controller's 4xx `@ApiResponse` `$ref`. Auto-registered in the registry
	// constructor so consumer projects expose `ErrorResponseDto` on
	// `/docs-json` without per-entity duplication.
	{
		runtime: 'shared/openapi/error-response.dto.ts',
		target: 'openapi/error-response.dto.ts',
	},
	{ runtime: 'shared/openapi/index.ts', target: 'openapi/index.ts' },
];

function databaseModuleContent(mode: RuntimeMode): string {
	// In vendored mode DRIZZLE comes from the vendored shim (`../constants/tokens`);
	// in package mode from the package runtime (ADR-037).
	const drizzleTokenImport =
		mode === 'vendored' ? '../constants/tokens' : runtimeImport(mode, 'constants/tokens');
	return `import { Module, Global } from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { DRIZZLE } from '${drizzleTokenImport}';

export { DRIZZLE };

/**
 * The Drizzle client type this project injects under DRIZZLE.
 *
 * Drizzle 1.0's generic slot on NodePgDatabase is the relations manifest
 * (\`defineRelations()\`), not the table schema. No manifest is emitted yet,
 * so the default (\`EmptyRelations\`) is the accurate type.
 */
export type DrizzleDB = NodePgDatabase;

/**
 * DatabaseModule — provides the DRIZZLE injection token globally.
 * Import once in AppModule, before any generated module.
 */
@Global()
@Module({
  providers: [
    {
      provide: DRIZZLE,
      useFactory: () => {
        const pool = new Pool({
          connectionString: process.env.DATABASE_URL ?? 'postgresql://localhost:5432/app_dev',
        });
        // Drizzle 1.0 takes a config object; \`schema\` was removed from it.
        // The relations manifest belongs here as \`relations\` once emitted.
        return drizzle({ client: pool });
      },
    },
  ],
  exports: [DRIZZLE],
})
export class DatabaseModule {}
`;
}

// Deprecated — kept only for backwards compatibility with `resolveRuntimePath`
// consumers/tests. Vendored files replace these in the scaffold output.
//
// The tokens/drizzle shims used to be thin re-exports from
// `codegen-patterns/runtime`. That triggered the dual-drizzle type clash
// (see VENDORED_RUNTIME_FILES comment). Vendored files are now the source
// of truth; no runtime re-export shim is emitted.

function appModuleContent(mode: RuntimeMode, layout: ProjectLayout): string {
	// OpenAPI registry: vendored shim (`<shared>/openapi`) in vendored mode; the
	// package runtime barrel in package mode (ADR-037). Every relative specifier
	// is computed from app.module.ts's own location (#612).
	const from = layout.appModule;
	const openApiImport =
		mode === 'vendored'
			? importSpecifier(from, path.join(layout.shared, 'openapi'))
			: runtimeImport(mode, 'shared/openapi');
	return `import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '${importSpecifier(from, layout.databaseModule)}';
import { GENERATED_MODULES } from '${importSpecifier(from, path.join(layout.generated, 'modules'))}';
import { OPENAPI_REGISTRY, OpenApiRegistry } from '${openApiImport}';

/**
 * OpenApiModule — @Global() wrapper around the OPENAPI_REGISTRY singleton.
 *
 * OPENAPI-4: every generated entity module \`@Inject(OPENAPI_REGISTRY)\` to
 * register its Zod DTOs at onModuleInit (OPENAPI-2). NestJS's DI scoping
 * means providers declared in AppModule are NOT automatically visible
 * inside imported feature modules — exports from AppModule only flow to
 * modules that explicitly import AppModule, which feature modules don't.
 * Making the provider module \`@Global()\` broadcasts the token to every
 * module in the application graph; each generated module picks it up
 * without needing to import anything extra.
 *
 * \`useValue: new OpenApiRegistry()\` locks the instance to one per
 * process. Never instantiate \`new OpenApiRegistry()\` elsewhere — a
 * forked registry forks the schema table and produces a partial
 * /docs-json at boot.
 */
@Global()
@Module({
  providers: [{ provide: OPENAPI_REGISTRY, useValue: new OpenApiRegistry() }],
  exports: [OPENAPI_REGISTRY],
})
class OpenApiModule {}

/**
 * AppModule — wires DatabaseModule (global) + the OpenApiModule (global)
 * + the GENERATED_MODULES barrel.
 *
 * DatabaseModule must come first — it provides the DRIZZLE token that every
 * generated repository depends on. OpenApiModule follows so the registry
 * is in the global injector before any generated module's onModuleInit
 * fires. main.ts reads the built registry at boot to produce the Swagger
 * document (OPENAPI-4).
 */
@Module({
  imports: [DatabaseModule, OpenApiModule, ...GENERATED_MODULES],
})
export class AppModule {}
`;
}

/**
 * Default `src/main.ts` — NestFactory bootstrap + conditional Swagger setup.
 *
 * OPENAPI-4: the Swagger block is gated on `config.openapi?.enabled`
 * loaded from `codegen.config.yaml` at startup. Disabled mode skips the
 * entire SwaggerModule.setup call so no `/docs` or `/docs-json` routes are
 * registered; the registry still exists (it's a singleton provider) but is
 * never built.
 *
 * Emitted only when `src/main.ts` is missing — never clobbers an existing
 * bootstrap file. Consumers with a pre-authored main.ts should copy the
 * Swagger block verbatim (see CONSUMER-SETUP §OpenAPI).
 */
/**
 * The package-mode RequesterContext boundary + closed-by-default boot-fail
 * (ADR-043 §4). Inserted before `app.listen()` in the generated `main.ts`.
 */
function authBoundaryBlock(): string {
	return `  // Ambient requester boundary (ADR-043 / ADR-0002): bridge the verified
  // principal into AsyncLocalStorage so every downstream repository read/write
  // is scoped with no threaded userId. No-op + warn if AUTH_USER_CONTEXT is
  // unbound — the boot-fail check below then decides whether that is allowed.
  installRequesterContext(app);

  // Closed-by-default data plane (ADR-043 §4). This is the HTTP entrypoint
  // (we are about to app.listen()), so an unauthenticated data plane here is a
  // real exposure. Refuse to serve when no IUserContext is bound, unless the
  // localhost-only escape hatch is set. This check lives ONLY in the HTTP
  // bootstrap — a worker process that imports AppModule but never listens must
  // not trip it.
  const userContext = app.get(AUTH_USER_CONTEXT, { strict: false });
  const allowAnonymous = config.auth?.devAllowAnonymous === true;
  if (!userContext && !allowAnonymous) {
    throw new Error(
      '[auth] FATAL: entity HTTP controllers are exposed but no IUserContext ' +
        'is bound under AUTH_USER_CONTEXT. The data plane would be ' +
        'unauthenticated. Bind an IUserContext (install the auth subsystem, ' +
        'or provide your own), or set auth.devAllowAnonymous=true in ' +
        'codegen.config.yaml for LOCALHOST DEV ONLY.',
    );
  }
  if (!userContext && allowAnonymous) {
    // eslint-disable-next-line no-console
    console.warn(
      '[auth] auth.devAllowAnonymous=true — the data plane is ' +
        'UNAUTHENTICATED. This must never be set in a non-localhost deployment.',
    );
  }
`;
}

/**
 * The vendored-mode hint (the auth subsystem files aren't vendored on a bare
 * scaffold, so we can't statically import them yet). `subsystem install auth`
 * vendors them; `project upgrade-auth` then wires this block in via AST patch.
 */
function authBoundaryHint(): string {
	return `  // Closed-by-default data plane (ADR-043). The auth subsystem is not yet
  // vendored on a fresh project, so wiring is deferred:
  //   1. codegen subsystem install auth     # vendors the auth runtime
  //   2. codegen project upgrade-auth        # AST-wires the boundary + boot-fail
  //                                           # here and AuthModule.forRoot in app.module.ts
`;
}

export function mainTsContent(mode: RuntimeMode, layout: ProjectLayout): string {
	const openApiImport =
		mode === 'vendored'
			? importSpecifier(layout.mainTs, path.join(layout.shared, 'openapi'))
			: runtimeImport(mode, 'shared/openapi');
	// Closed-by-default data plane (ADR-043). We wire the boundary + boot-fail
	// directly into the scaffold ONLY in package mode, where the auth barrel
	// always resolves from the published package. In vendored mode a bare
	// scaffold has no `./shared/subsystems/auth` until `subsystem install auth`
	// vendors it, so we emit a hint instead and let `project upgrade-auth` do
	// the AST wiring after install (avoids a dangling import on a fresh project).
	const wireAuth = mode === 'package';
	const authImportLine = wireAuth
		? `import { installRequesterContext, AUTH_USER_CONTEXT } from '${subsystemsImport(mode, 'auth')}';\n`
		: '';
	return `import 'reflect-metadata';
import fs from 'node:fs';
import path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { parse as parseYaml } from 'yaml';
import { AppModule } from './app.module';
import { OPENAPI_REGISTRY, OpenApiRegistry } from '${openApiImport}';
${authImportLine}
interface OpenApiConfig {
  enabled?: boolean;
  path?: string;
  title?: string;
  version?: string;
  description?: string;
  auth?: 'bearer' | 'none';
}

interface AuthConfig {
  /**
   * Localhost-only escape hatch (ADR-043 §4). When true, an app with no
   * IUserContext bound serves an UNAUTHENTICATED data plane instead of
   * refusing to boot. NEVER set this in a non-localhost deployment.
   */
  devAllowAnonymous?: boolean;
}

interface CodegenConfig {
  openapi?: OpenApiConfig;
  auth?: AuthConfig;
}

/**
 * Load \`codegen.config.yaml\` to pick up the \`openapi:\` block. Missing or
 * malformed → no config (Swagger disabled). The registry is the source of
 * truth for the document content; this just toggles whether Swagger UI
 * mounts + which metadata the header shows.
 */
function loadConfig(): CodegenConfig {
  const configPath = path.resolve(process.cwd(), 'codegen.config.yaml');
  if (!fs.existsSync(configPath)) return {};
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = parseYaml(raw);
    return (parsed && typeof parsed === 'object' ? parsed : {}) as CodegenConfig;
  } catch {
    return {};
  }
}

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();

  if (config.openapi?.enabled) {
    // OPENAPI-4: build the document in two passes.
    //
    //   1. Our vendored \`OpenApiRegistry\` owns the component schemas
    //      (Zod-derived DTOs registered by every generated module at
    //      onModuleInit — OPENAPI-2).
    //   2. \`SwaggerModule.createDocument\` scans controller decorators
    //      (@Api* — OPENAPI-3) and produces the \`paths\` map. Our
    //      schemas then get merged into the \`components.schemas\` it
    //      emits by reference.
    //
    // Both passes are needed: Nest's scanner is the source of truth for
    // paths (it knows the routes); the registry is the source of truth
    // for schemas (Zod can't be inferred from reflection metadata).
    const registry = app.get<OpenApiRegistry>(OPENAPI_REGISTRY);
    const registryDocument = await registry.build({
      title: config.openapi.title ?? 'API',
      version: config.openapi.version ?? '0.0.0',
      description: config.openapi.description,
    });

    const docBuilder = new DocumentBuilder()
      .setTitle(config.openapi.title ?? 'API')
      .setVersion(config.openapi.version ?? '0.0.0');
    if (config.openapi.description) docBuilder.setDescription(config.openapi.description);
    if ((config.openapi.auth ?? 'bearer') === 'bearer') docBuilder.addBearerAuth();

    const nestDocument = SwaggerModule.createDocument(app, docBuilder.build());

    // Merge registry-owned component schemas on top of whatever Nest's
    // decorator scanner produced. Controllers reference schemas by
    // \`$ref\` (OPENAPI-3), so this merge is what actually resolves the
    // refs consumers see in /docs-json.
    // Registry schemas are typed Record<string, unknown> locally
    // (avoids depending on openapi3-ts); the runtime shape matches Nest's
    // SchemaObject — generateSchema(zodRef, false, '3.0') emits valid
    // OpenAPI 3.0 schema objects. Cast to satisfy Nest's stricter typing.
    nestDocument.components = {
      ...nestDocument.components,
      schemas: {
        ...(nestDocument.components?.schemas ?? {}),
        ...registryDocument.components.schemas,
      } as NonNullable<typeof nestDocument.components>['schemas'],
    };

    // \`persistAuthorization\` keeps the "Authorize" bearer token across page
    // reloads, so the token pasted in Swagger UI keeps flowing as the
    // \`Authorization\` header — which the RequesterContext boundary (below)
    // turns into ambient tenant scope on every request.
    SwaggerModule.setup(config.openapi.path ?? '/docs', app, nestDocument, {
      swaggerOptions: { persistAuthorization: true },
    });
  }

${wireAuth ? authBoundaryBlock() : authBoundaryHint()}
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(\`Application listening on http://localhost:\${port}\`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start application:', err);
  process.exit(1);
});
`;
}

function rootSchemaContent(layout: ProjectLayout): string {
	const barrel = path.join(layout.generated, 'schema');
	return `/**
 * Drizzle schema root.
 * Re-exports the generated schema barrel. Codegen owns ${path.relative(layout.root, barrel).split(path.sep).join('/')}.ts
 * — add or remove entity YAML to change the table set.
 */
export * from '${importSpecifier(layout.rootSchema, barrel)}';
`;
}

function emptyModulesBarrel(): string {
	return `// AUTO-GENERATED — DO NOT EDIT.
// Regenerated on every \`codegen entity new\` / \`codegen entity new --all\`.
// See ADR-017.
import type { DynamicModule, ForwardReference, Type } from '@nestjs/common';
export const GENERATED_MODULES: Array<
	Type | DynamicModule | Promise<DynamicModule> | ForwardReference
> = [];
`;
}

function emptySchemaBarrel(): string {
	return `// AUTO-GENERATED — DO NOT EDIT.
// Regenerated on every \`codegen entity new\` / \`codegen entity new --all\`.
// See ADR-017.
export {};
`;
}

function exampleEntityYaml(): string {
	return `# Example entity definition — delete or rename to get started.
#
# entity:
#   name: account
#   pattern: Integrated   # Base | Integrated | Activity | Metadata | Knowledge (or app-defined)
#
# fields:
#   name:
#     type: string
#     required: true
#   email:
#     type: string
#   status:
#     type: enum
#     choices: [active, inactive]
#
# queries:
#   - by: [email]
#     unique: true
`;
}

function tsconfigTemplate(layout: ProjectLayout): string {
	const aliases = tsconfigAliases(layout);
	const alias = (name: string) => `"${name}": ["${aliases[name]![0]}"]`;
	const includes = tsconfigIncludes(layout).map((g) => `    "${g}",`).join('\n');
	return `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "strict": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "paths": {
      ${alias('@shared/*')},
      ${alias('@modules/*')},
      ${alias('@generated/*')}
    },
    "types": ["node"]
  },
  "include": [
${includes}
    "drizzle.config.ts"
  ]
}
`;
}

// ---------------------------------------------------------------------------
// tsconfig merge
// ---------------------------------------------------------------------------

interface TsconfigMergeResult {
	content: string;
	added: string[];
	unchanged: boolean;
}

/**
 * Strip JSONC single-line (//) and block (/* ... *&#47;) comments so
 * JSON.parse can handle a typical tsconfig.json authored by `bun init` or
 * similar tooling. Deliberately simple — doesn't handle comment-looking
 * substrings inside string literals, which is acceptable because tsconfig
 * values are well-known shapes.
 */
function stripJsonComments(raw: string): string {
	let out = '';
	let i = 0;
	let inString = false;
	let stringChar = '';
	while (i < raw.length) {
		const c = raw[i];
		const next = raw[i + 1];
		if (inString) {
			out += c;
			if (c === '\\' && i + 1 < raw.length) {
				out += next;
				i += 2;
				continue;
			}
			if (c === stringChar) inString = false;
			i++;
			continue;
		}
		if (c === '"' || c === "'") {
			inString = true;
			stringChar = c;
			out += c;
			i++;
			continue;
		}
		if (c === '/' && next === '/') {
			// single-line comment — skip to newline
			while (i < raw.length && raw[i] !== '\n') i++;
			continue;
		}
		if (c === '/' && next === '*') {
			i += 2;
			while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i++;
			i += 2;
			continue;
		}
		out += c;
		i++;
	}
	// Strip trailing commas before ] and }
	return out.replace(/,\s*([\]}])/g, '$1');
}

const REQUIRED_COMPILER_OPTIONS: Record<string, unknown> = {
	experimentalDecorators: true,
	emitDecoratorMetadata: true,
};

/**
 * Idempotent merge of required path aliases + compiler options into an
 * existing tsconfig. Only adds missing entries — never clobbers user-
 * authored paths or flags. Tolerates JSONC via a comment-stripping pass.
 */
export function mergeTsconfig(
	raw: string,
	layout: ProjectLayout,
): TsconfigMergeResult & { parseError?: string } {
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(stripJsonComments(raw));
	} catch (err: unknown) {
		return {
			content: raw,
			added: [],
			unchanged: true,
			parseError: err instanceof Error ? err.message : String(err),
		};
	}

	const compilerOptions = (parsed.compilerOptions ?? {}) as Record<string, unknown>;
	const paths = (compilerOptions.paths ?? {}) as Record<string, unknown>;

	const added: string[] = [];
	for (const [alias, target] of Object.entries(tsconfigAliases(layout))) {
		if (!(alias in paths)) {
			paths[alias] = target;
			added.push(alias);
		}
	}

	// Also ensure decorator flags are enabled — NestJS generated code uses them.
	for (const [opt, value] of Object.entries(REQUIRED_COMPILER_OPTIONS)) {
		if (compilerOptions[opt] === undefined) {
			compilerOptions[opt] = value;
			added.push(opt);
		}
	}

	// Verbatim module syntax + allowImportingTsExtensions (bun init defaults)
	// conflict with NestJS decorator metadata — turn them off for decorated code.
	if (compilerOptions.verbatimModuleSyntax === true) {
		compilerOptions.verbatimModuleSyntax = false;
		added.push('verbatimModuleSyntax=false');
	}

	if (added.length === 0) {
		return { content: raw, added: [], unchanged: true };
	}

	compilerOptions.paths = paths;
	// NO `baseUrl`. TypeScript 7 REMOVED the option outright (TS5102, not a
	// deprecation), so emitting it into a consumer's tsconfig hands them a
	// config their compiler rejects. Every `paths` entry this scaffold writes
	// is already relative (`./<backend_src>/shared/*`), and without `baseUrl` those
	// resolve against the tsconfig's own directory — the same target `baseUrl:
	// '.'` was producing. `provider-module-generator.ts` reads
	// `compilerOptions.baseUrl ?? '.'`, so the alias map is unaffected.
	parsed.compilerOptions = compilerOptions;

	return {
		content: JSON.stringify(parsed, null, 2) + '\n',
		added,
		unchanged: false,
	};
}

// ---------------------------------------------------------------------------
// Frontend dependency merge (ADR-038 FE-4)
// ---------------------------------------------------------------------------

interface PackageJsonMergeResult {
	content: string;
	added: string[];
	unchanged: boolean;
	parseError?: string;
}

/**
 * Idempotent merge of {@link FRONTEND_EMITTED_DEPS} into a consumer frontend
 * `package.json`'s `dependencies`. Mirrors the {@link mergeTsconfig} precedent:
 * only ADDS missing keys — an existing entry's version is preserved verbatim
 * (the consumer's range choice wins; we never clobber or downgrade). The
 * emitted frontend imports against these packages (ADR-038 version-pairing
 * contract); the deps comment in `generated/index.ts` keeps drift visible.
 *
 * Re-running init never duplicates or reorders existing entries — when every
 * required key is already present, `unchanged: true` and the raw content is
 * returned untouched.
 */
export function mergeFrontendDeps(raw: string): PackageJsonMergeResult {
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(raw) as Record<string, unknown>;
	} catch (err: unknown) {
		return {
			content: raw,
			added: [],
			unchanged: true,
			parseError: err instanceof Error ? err.message : String(err),
		};
	}

	const deps = (parsed.dependencies ?? {}) as Record<string, unknown>;
	const added: string[] = [];
	for (const [pkg, range] of Object.entries(FRONTEND_EMITTED_DEPS)) {
		if (!(pkg in deps)) {
			deps[pkg] = range;
			added.push(pkg);
		}
	}

	if (added.length === 0) {
		return { content: raw, added: [], unchanged: true };
	}

	parsed.dependencies = deps;
	return {
		content: JSON.stringify(parsed, null, 2) + '\n',
		added,
		unchanged: false,
	};
}

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

function relOf(cwd: string, abs: string): string {
	return path.relative(cwd, abs) || abs;
}

function fileEntry(
	cwd: string,
	absPath: string,
	content: string,
	opts: { force?: boolean; skipReason?: string }
): PlanEntry {
	const exists = fs.existsSync(absPath);
	let action: PlanAction;
	let reason: string | undefined = opts.skipReason;
	if (!exists) {
		action = 'create';
	} else if (opts.force) {
		action = 'overwrite';
		reason = 'exists — --force';
	} else {
		action = 'skip';
		reason = opts.skipReason ?? 'already exists';
	}
	return { path: absPath, relPath: relOf(cwd, absPath), action, content, reason };
}

function dirEntry(cwd: string, absPath: string): PlanEntry {
	const exists = fs.existsSync(absPath);
	return {
		path: absPath,
		relPath: relOf(cwd, absPath),
		action: exists ? 'skip' : 'create',
		directory: true,
		reason: exists ? 'already exists' : undefined,
	};
}

/**
 * Build the complete init plan without touching disk.
 *
 * Detection: if `ctx.framework` is provided (not null), it's used; otherwise
 * we run `scanProject()` unless `skipScan` is set.
 */
export async function buildInitPlan(
	ctx: Context,
	options: InitOptions
): Promise<InitPlan> {
	const cwd = options.cwd;
	const force = Boolean(options.force);
	// Runtime mode (ADR-037). Default `package` — generated code depends on the
	// npm package; nothing is vendored. `vendored` keeps the legacy `@shared/**`
	// model and vendors the runtime closure below.
	const runtimeMode = options.runtimeMode === 'vendored' ? 'vendored' : 'package';

	// Detection — drive config defaults.
	//
	// Architecture default: 'clean-lite-ps'. The CONSUMER-SETUP.md flow and
	// the codegen-pattern-demo-app both use clean-lite-ps; it's the
	// supported consumer path. The scanner only overrides when it finds
	// high-confidence evidence of a different layout (e.g. existing
	// domain/ + application/ directories).
	let framework = 'nestjs';
	let orm = 'drizzle';
	let architecture: 'clean' | 'clean-lite-ps' = 'clean-lite-ps';
	let frontend = false;

	if (!options.skipScan) {
		try {
			const profile = ctx.framework ?? (await scanProject({ directory: cwd }));
			const proposed = generateConfig(profile);
			framework = proposed.framework;
			orm = proposed.orm;
			// Only override architecture when the scanner detected actual
			// clean-architecture evidence (domain/, application/ dirs). A
			// fresh project that resolves to 'flat' with high confidence
			// should stay at the clean-lite-ps default — otherwise init
			// would emit a config that asks codegen to generate files into
			// presentation/ and infrastructure/ directories that don't
			// (and shouldn't) exist.
			if (
				profile.architecture.detected === 'clean' &&
				profile.architecture.confidence >= 50
			) {
				architecture = proposed.generate.architecture;
			}
			frontend = proposed.generate.frontend;
		} catch {
			// Detection failed — keep defaults.
		}
	}

	// Every target below resolves from the project's `paths.*` — its existing
	// `codegen.config.yaml` when there is one, else the schema defaults, which
	// are also what the config written in step 1 declares (#566, PATH-0).
	const layout = projectLayout(cwd, ctx.config);
	const runtimePath = options.runtimePath ?? resolveRuntimePath(layout);

	const entries: PlanEntry[] = [];

	// 1. codegen.config.yaml
	{
		const configPath = path.join(cwd, 'codegen.config.yaml');
		const config = {
			// Runtime mode (ADR-037). `package` (default) imports the runtime from
			// `@pattern-stack/codegen/*`; `vendored` imports it via `@shared/*` and
			// vendors `src/shared/**`. Existing vendored projects MUST set this to
			// `vendored` explicitly — the default does not silently flip them.
			runtime: runtimeMode,
			paths: {
				backend_src: DEFAULT_CODEGEN_CONFIG.paths.backend_src,
				entities: DEFAULT_CODEGEN_CONFIG.paths.entities,
				events_dir: DEFAULT_CODEGEN_CONFIG.paths.events_dir,
				generated: DEFAULT_CODEGEN_CONFIG.paths.generated,
			},
			generate: {
				architecture,
				frontend,
				commands: true,
				queries: true,
			},
			naming: {
				fileCase: 'kebab-case',
				suffixStyle: 'dotted',
				terminology: {
					command: 'use-case',
					query: 'use-case',
				},
			},
			database: {
				dialect: 'postgres',
			},
		};
		const content = stringifyYaml(config, { indent: 2 });
		entries.push(fileEntry(cwd, configPath, content, { force }));
	}

	// 2. tsconfig.json — idempotent merge
	{
		const tsconfigPath = path.join(cwd, 'tsconfig.json');
		if (fs.existsSync(tsconfigPath)) {
			const raw = fs.readFileSync(tsconfigPath, 'utf-8');
			const merged = mergeTsconfig(raw, layout);
			if (merged.parseError) {
				entries.push({
					path: tsconfigPath,
					relPath: relOf(cwd, tsconfigPath),
					action: 'skip',
					reason: `unable to parse (${merged.parseError}); add aliases manually`,
				});
			} else if (merged.unchanged) {
				entries.push({
					path: tsconfigPath,
					relPath: relOf(cwd, tsconfigPath),
					action: 'skip',
					reason: 'path aliases already present',
				});
			} else {
				entries.push({
					path: tsconfigPath,
					relPath: relOf(cwd, tsconfigPath),
					action: 'merge',
					content: merged.content,
					reason: `add aliases: ${merged.added.join(', ')}`,
				});
			}
		} else if (options.withTsconfig) {
			entries.push({
				path: tsconfigPath,
				relPath: relOf(cwd, tsconfigPath),
				action: 'create',
				content: tsconfigTemplate(layout),
				reason: 'new tsconfig.json',
			});
		} else {
			entries.push({
				path: tsconfigPath,
				relPath: relOf(cwd, tsconfigPath),
				action: 'skip',
				reason: 'missing — pass --with-tsconfig to create one',
			});
		}
	}

	// 3. <backend_src>/shared/database/database.module.ts
	entries.push(
		fileEntry(
			cwd,
			layout.databaseModule,
			databaseModuleContent(runtimeMode),
			{ force }
		)
	);

	// 4-6. Vendor runtime files into <backend_src>/shared/ — ONLY in `vendored` mode
	// (ADR-037). Vendoring (vs re-export) avoids the dual-drizzle type-identity
	// clash the old shim form triggered when the consumer and runtime each
	// resolved their own drizzle-orm. In `package` mode the consumer depends on
	// `@pattern-stack/codegen` and the generated code imports from the package, so
	// there is nothing to vendor. See VENDORED_RUNTIME_FILES comment.
	if (runtimeMode === 'vendored') {
		for (const v of VENDORED_RUNTIME_FILES) {
			entries.push(
				fileEntry(cwd, path.join(layout.shared, v.target), loadRuntimeFile(v.runtime), { force })
			);
		}
	}

	// 7. <generated>/{modules,schema}.ts — empty barrels
	entries.push(
		fileEntry(
			cwd,
			path.join(layout.generated, 'modules.ts'),
			emptyModulesBarrel(),
			{ force }
		)
	);
	entries.push(
		fileEntry(
			cwd,
			path.join(layout.generated, 'schema.ts'),
			emptySchemaBarrel(),
			{ force }
		)
	);

	// 8. <backend_src>/app.module.ts — only if missing (never clobber user auth'd module)
	{
		const appModulePath = layout.appModule;
		if (!fs.existsSync(appModulePath)) {
			entries.push({
				path: appModulePath,
				relPath: relOf(cwd, appModulePath),
				action: 'create',
				content: appModuleContent(runtimeMode, layout),
			});
		} else {
			entries.push({
				path: appModulePath,
				relPath: relOf(cwd, appModulePath),
				action: 'skip',
				reason:
					'exists — run `codegen project upgrade-openapi` to patch; see docs/CONSUMER-SETUP.md §OpenAPI for manual wiring',
			});
		}
	}

	// 8b. <backend_src>/main.ts — NestFactory bootstrap + conditional Swagger setup
	// (OPENAPI-4). Never clobber an existing main.ts — consumers who own
	// their own bootstrap (custom logging, Helmet, cors, etc.) copy the
	// Swagger block manually from CONSUMER-SETUP §OpenAPI.
	{
		const mainPath = layout.mainTs;
		if (!fs.existsSync(mainPath)) {
			entries.push({
				path: mainPath,
				relPath: relOf(cwd, mainPath),
				action: 'create',
				content: mainTsContent(runtimeMode, layout),
			});
		} else {
			entries.push({
				path: mainPath,
				relPath: relOf(cwd, mainPath),
				action: 'skip',
				reason:
					'exists — run `codegen project upgrade-openapi` to patch; see docs/CONSUMER-SETUP.md §OpenAPI for manual wiring',
			});
		}
	}

	// 9. <backend_src>/schema.ts — drizzle schema root
	{
		const schemaPath = layout.rootSchema;
		if (!fs.existsSync(schemaPath)) {
			entries.push({
				path: schemaPath,
				relPath: relOf(cwd, schemaPath),
				action: 'create',
				content: rootSchemaContent(layout),
			});
		} else {
			entries.push({
				path: schemaPath,
				relPath: relOf(cwd, schemaPath),
				action: 'skip',
				reason: `exists — ensure it re-exports '${importSpecifier(schemaPath, path.join(layout.generated, 'schema'))}'`,
			});
		}
	}

	// 10. <entities>/ + <entities>/example.yaml
	entries.push(dirEntry(cwd, layout.entities));
	{
		const entitiesDir = layout.entities;
		const examplePath = path.join(entitiesDir, 'example.yaml');
		const hasOtherYamls =
			fs.existsSync(entitiesDir) &&
			findYamlFiles(entitiesDir).some(
				(f) => path.basename(f) !== 'example.yaml',
			);
		if (fs.existsSync(examplePath)) {
			entries.push({
				path: examplePath,
				relPath: relOf(cwd, examplePath),
				action: 'skip',
				reason: 'already exists',
			});
		} else if (hasOtherYamls) {
			entries.push({
				path: examplePath,
				relPath: relOf(cwd, examplePath),
				action: 'skip',
				reason: 'other entities present',
			});
		} else {
			entries.push({
				path: examplePath,
				relPath: relOf(cwd, examplePath),
				action: 'create',
				content: exampleEntityYaml(),
			});
		}
	}

	// 11. Frontend consumer deps (ADR-038 FE-4). Only when the proposed config
	// enables the frontend pipeline. The emitter emits imports against the
	// version-pairing contract (FRONTEND_EMITTED_DEPS); the consumer must install
	// them. We locate the frontend package.json from `paths.frontend_src`'s parent.
	//   - package.json present → idempotent MERGE (add only missing keys, never
	//     clobber an existing version range);
	//   - absent → a `skip` plan-entry NOTICE listing the required deps verbatim,
	//     so the user knows what to install. Never fails init.
	// `@pattern-stack/codegen` itself gains no runtime dep from this.
	if (frontend) {
		const frontendRoot = path.dirname(layout.frontendSrc);
		const pkgPath = path.join(frontendRoot, 'package.json');
		const depsList = Object.entries(FRONTEND_EMITTED_DEPS)
			.map(([p, r]) => `${p}@${r}`)
			.join(', ');
		if (fs.existsSync(pkgPath)) {
			const raw = fs.readFileSync(pkgPath, 'utf-8');
			const merged = mergeFrontendDeps(raw);
			if (merged.parseError) {
				entries.push({
					path: pkgPath,
					relPath: relOf(cwd, pkgPath),
					action: 'skip',
					reason: `unable to parse (${merged.parseError}); add frontend deps manually: ${depsList}`,
				});
			} else if (merged.unchanged) {
				entries.push({
					path: pkgPath,
					relPath: relOf(cwd, pkgPath),
					action: 'skip',
					reason: 'frontend deps already present',
				});
			} else {
				entries.push({
					path: pkgPath,
					relPath: relOf(cwd, pkgPath),
					action: 'merge',
					content: merged.content,
					reason: `add frontend deps: ${merged.added.join(', ')}`,
				});
			}
		} else {
			entries.push({
				path: pkgPath,
				relPath: relOf(cwd, pkgPath),
				action: 'skip',
				reason: `frontend enabled but ${relOf(cwd, pkgPath)} not found — install: ${depsList}`,
			});
		}
	}

	return {
		entries,
		summary: {
			cwd,
			framework,
			orm,
			architecture,
			frontend,
			runtimePath,
		},
	};
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

export interface WriteResult {
	created: PlanEntry[];
	merged: PlanEntry[];
	overwritten: PlanEntry[];
	skipped: PlanEntry[];
}

export function writePlan(plan: InitPlan): WriteResult {
	const created: PlanEntry[] = [];
	const merged: PlanEntry[] = [];
	const overwritten: PlanEntry[] = [];
	const skipped: PlanEntry[] = [];

	for (const e of plan.entries) {
		if (e.action === 'skip') {
			skipped.push(e);
			continue;
		}
		if (e.directory) {
			fs.mkdirSync(e.path, { recursive: true });
			created.push(e);
			continue;
		}
		if (e.content === undefined) {
			skipped.push(e);
			continue;
		}
		fs.mkdirSync(path.dirname(e.path), { recursive: true });
		fs.writeFileSync(e.path, e.content, 'utf-8');
		if (e.action === 'create') created.push(e);
		else if (e.action === 'merge') merged.push(e);
		else if (e.action === 'overwrite') overwritten.push(e);
	}

	return { created, merged, overwritten, skipped };
}
