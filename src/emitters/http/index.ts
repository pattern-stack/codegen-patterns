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
import { useNestFallbacks } from '${input.runtimeImport}';
import type { App } from './commands';
import { registerOpenApiSchemas } from './openapi';
${input.entities.map((e) => `import { ${e.routesFunction} } from '${e.routesImport}';`).join('\n')}

export interface CreateAppOptions {
  /** The OpenAPI document's info, and where it is served: \`/<path>-json\` (default \`docs\`, as the Nest target). */
  openApi?: { title?: string; version?: string; description?: string; path?: string };
}

export function createApp(app: App, options: CreateAppOptions = {}): Hono {
  const http = new Hono();
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
	mainContent: (input) => `import { serve } from '@hono/node-server';
import { composeApp } from '${input.composeImport}';
import { createApp } from '${input.httpImport}';

/**
 * Compose, start, and serve the HTTP layer (H-1b) on the \`http.port\` setting. SIGINT / SIGTERM close the server, then
 * stop the composition. \`@hono/node-server\` runs on Bun and Node alike.
 */
async function main(): Promise<void> {
  const app = composeApp();
  await app.start();
  // The \`port\` format checked it when the app composed: 1 to 65535.
  const port = globalThis.Number(app.system('settings').http.port);
  const server = serve({ fetch: createApp(app).fetch, port });
  // eslint-disable-next-line no-console
  console.log(\`listening on http://localhost:\${port}\`);

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    // eslint-disable-next-line no-console
    console.log(\`\${signal}: stopping\`);
    server.close(() => {
      app.stop().then(
        () => process.exit(0),
        (err) => {
          // eslint-disable-next-line no-console
          console.error(err);
          process.exit(1);
        },
      );
    });
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
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
