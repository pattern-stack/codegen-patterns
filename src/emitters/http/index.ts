/**
 * Each pattern-stack HTTP layer's text (H-1b): `<generated>/http.ts` and the app's `main.ts`. One row per layer in
 * `HTTP_LAYERS` (`src/targets/http.ts`), typed so a layer without its renderers is a `tsc` error; no reader branches on
 * the `http` value.
 */
import type { PatternStackHttp } from '../../targets/http.js';

/** One entity whose routes `http.ts` mounts. */
export interface HttpAppEntity {
	/** Its module in the composition (`crm`), and its key there (`contact`). */
	module: string;
	key: string;
	routesFunction: string;
	/** The import specifier of its routes file, from `http.ts`. */
	routesImport: string;
}

export interface HttpAppInput {
	banner: string;
	entities: readonly HttpAppEntity[];
	/** The layer's runtime import (`answer`, `useNestFallbacks`, …). */
	runtimeImport: string;
	openApiImport: string;
}

export interface HttpMainInput {
	/** The import specifiers of the app's `compose.ts` and `<generated>/http.ts`, from `main.ts`. */
	composeImport: string;
	httpImport: string;
}

export interface HttpRenderers {
	/** `<generated>/http.ts`: `createApp(app)`, every entity's routes and the OpenAPI document. */
	appFile(input: HttpAppInput): string;
	/** `<backend_src>/main.ts`: compose, start, serve, stop on a signal. */
	mainContent(input: HttpMainInput): string;
}

const hono: HttpRenderers = {
	appFile: (input) => `${input.banner}
/**
 * The app's HTTP layer (H-1b): every entity's routes, as views of its commands, and \`/docs-json\`. Unknown routes and
 * crashes answer as the Nest target does. Runs on Bun and Node.
 */
import { Hono } from 'hono';
import { OpenApiRegistry } from '${input.openApiImport}';
import { useNestBodyLimit, useNestFallbacks } from '${input.runtimeImport}';
import type { App } from './commands';
import { registerOpenApiSchemas } from './openapi';
${input.entities.map((e) => `import { ${e.routesFunction} } from '${e.routesImport}';`).join('\n')}

export interface CreateAppOptions {
  /** The OpenAPI document's info, and where it is served: \`/<path>-json\` (default \`docs\`, as the Nest target). */
  openApi?: { title?: string; version?: string; description?: string; path?: string };
}

export function createApp(app: App, options: CreateAppOptions = {}): Hono {
  // Express's router (under Nest) ignores a trailing slash; Hono's must be told (case still matters: a known difference).
  const http = new Hono({ strict: false });
  useNestBodyLimit(http);
  const openApi = new OpenApiRegistry();
  registerOpenApiSchemas(openApi);
  const docs = options.openApi ?? {};
  http.get(\`/\${docs.path ?? 'docs'}-json\`, async (c) =>
    c.json(
      await openApi.build({
        title: docs.title ?? 'API',
        version: docs.version ?? '0.0.0',
        ...(docs.description ? { description: docs.description } : {}),
      }),
    ),
  );
${input.entities.map((e) => `  http.route('/', ${e.routesFunction}(app.module('${e.module}').${e.key}.useCases));`).join('\n')}
  useNestFallbacks(http);
  return http;
}
`,
	mainContent: (input) => `import { serve, type ServerType } from '@hono/node-server';
import { composeApp } from '${input.composeImport}';
import { createApp } from '${input.httpImport}';

/** How long a stop waits for open requests before it exits anyway. */
const SHUTDOWN_DEADLINE_MS = 10_000;

/**
 * Compose, start, and serve the HTTP layer (H-1b) on the \`http.port\` setting. SIGINT / SIGTERM, from the start on,
 * close the server (if it is listening), then stop the composition; a stop that outlasts the deadline exits anyway. A
 * server that can't listen (the port is taken) stops the composition and exits 1. \`@hono/node-server\` runs on Bun
 * and Node alike.
 */
async function main(): Promise<void> {
  const app = composeApp();
  let server: ServerType | undefined;
  let stopping = false;
  const stop = (signal: string, code = 0) => {
    if (stopping) return;
    stopping = true;
    // eslint-disable-next-line no-console
    console.log(\`\${signal}: stopping\`);
    globalThis.setTimeout(() => process.exit(1), SHUTDOWN_DEADLINE_MS).unref();
    const stopApp = () =>
      app.stop().then(
        () => process.exit(code),
        (err) => {
          // eslint-disable-next-line no-console
          console.error(err);
          process.exit(1);
        },
      );
    if (server) server.close(() => void stopApp());
    else void stopApp();
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));

  await app.start();
  // A signal during start stops what started; don't serve a stopped app.
  if (stopping) return;
  // The \`port\` format checked it when the app composed: 1 to 65535.
  const port = globalThis.Number(app.system('settings').http.port);
  server = serve({ fetch: createApp(app).fetch, port });
  server.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error(\`listening on \${port} failed:\`, err);
    stop('listen error', 1);
  });
  // eslint-disable-next-line no-console
  console.log(\`listening on http://localhost:\${port}\`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Failed:', err);
  process.exit(1);
});
`,
};

export const HTTP_RENDERERS: { readonly [H in PatternStackHttp]: HttpRenderers } = { hono };

/** The file `http.ts` is written to, beside `wiring.ts`. */
export const HTTP_APP_FILE = 'http.ts';
