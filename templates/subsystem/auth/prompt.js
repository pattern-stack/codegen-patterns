/**
 * Hygen prompt.js — #287 auth subsystem scaffold.
 *
 * Locals are resolved by the CLI (src/cli/shared/auth-scaffold-locals.ts)
 * and forwarded as CLI args. This prompt.js just coerces and forwards;
 * no interactive prompts.
 *
 * Invoked via:
 *   bunx hygen subsystem auth \
 *     --appName <string> \
 *     --configPath <abs> \
 *     --schemaPath <abs> \
 *     --appModulePath <abs> \
 *     --envConfigPath <abs> \
 *     --redirectUriBase <url> \
 *     --tokenEncryptionKey <b64-32-bytes>
 *
 * The three templates this folder steers:
 *   - `auth-oauth-state.schema.ejs.t` — emits the `auth_oauth_state`
 *     drizzle schema (sole emitter; copyRuntime skips the runtime source).
 *   - `app-module-hook.ejs.t` — appends a TODO comment block to
 *     app.module.ts directing the human to register
 *     `AuthModule.forRoot({ ... })`. Same convention as observability.
 *   - `env-config.ejs.t` — appends `TOKEN_ENCRYPTION_KEY=<b64>` and
 *     `AUTH_REDIRECT_URI_BASE=<url>` to `.env.config`. Idempotent via
 *     `skip_if: "TOKEN_ENCRYPTION_KEY"` — re-running install does NOT
 *     regenerate the key (rotation is a separate operation).
 *
 * Auth has NO `multi_tenant` knob (see auth-scaffold-locals.ts docstring).
 */

export default {
  prompt: async ({ args }) => {
    return {
      appName: args.appName ?? "",
      configPath: args.configPath ?? "codegen.config.yaml",
      schemaPath:
        args.schemaPath ??
        "src/shared/subsystems/auth/auth-oauth-state.schema.ts",
      appModulePath: args.appModulePath ?? "src/app.module.ts",
      envConfigPath: args.envConfigPath ?? ".env.config",
      redirectUriBase: args.redirectUriBase ?? "http://localhost:3000",
      tokenEncryptionKey: args.tokenEncryptionKey ?? "",
    };
  },
};
