/**
 * Hygen prompt.js — OBS-7 observability subsystem scaffold (combiner variant).
 *
 * Locals resolved by the CLI (src/cli/shared/observability-scaffold-locals.ts)
 * and forwarded as CLI args. This prompt.js coerces boolean-ish strings back
 * into JS booleans for parity with events / bridge (Hygen args arrive as
 * strings).
 *
 * Invoked via:
 *   bunx hygen subsystem observability \
 *     --appName <string> --appModulePath <abs> --configPath <abs> \
 *     --bridgeMetricsEnabled <'true'|'false'>
 *
 * Observability is a COMBINER subsystem (ADR-025): it composes sibling
 * read-ports via @Optional() DI and ships no schema, no worker, no
 * generated/ dir. The sole template this folder contains is
 * `main-hook.ejs.t`, which appends a COMMENT BLOCK to the user's
 * app.module.ts directing them to register `ObservabilityModule.forRoot()`
 * AFTER Events/Jobs/Bridge/Sync. We deliberately don't attempt a regex
 * injection — the module order matters (combiner composes siblings), and
 * a wrong-place inject is worse than a clear TODO comment.
 */

function coerceBool(raw) {
  if (raw === true) return true;
  if (raw === false) return false;
  if (typeof raw === "string") return raw.toLowerCase() === "true";
  return false;
}

export default {
  prompt: async ({ args }) => {
    return {
      appName: args.appName ?? "",
      appModulePath: args.appModulePath ?? "src/app.module.ts",
      configPath: args.configPath ?? "codegen.config.yaml",
      bridgeMetricsEnabled: coerceBool(args.bridgeMetricsEnabled),
    };
  },
};
