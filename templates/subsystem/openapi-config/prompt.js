/**
 * Hygen prompt.js — OPENAPI-4 OpenAPI config-block scaffold.
 *
 * The OpenAPI "subsystem" is config-only: the runtime helpers
 * (`OpenApiRegistry`, `OPENAPI_REGISTRY` token, `ErrorResponseDto`) are
 * already vendored into every consumer project by `codegen project init`
 * (see `src/cli/shared/init-scaffold.ts::VENDORED_RUNTIME_FILES`). So
 * there is no `runtime/subsystems/openapi/` directory to copy — this
 * template's sole job is to inject the `openapi:` block into
 * `codegen.config.yaml`.
 *
 * Mirrors the bridge-config / events-config / jobs-config / sync-config
 * prompt.js shape. Invoked via:
 *   bunx hygen subsystem openapi-config --configPath <abs>
 */

export default {
  prompt: async ({ args }) => {
    return {
      configPath: args.configPath ?? "codegen.config.yaml",
    };
  },
};
