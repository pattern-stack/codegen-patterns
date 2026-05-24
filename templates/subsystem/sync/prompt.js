/**
 * Hygen prompt.js — SYNC-7 sync subsystem scaffold.
 *
 * All locals are resolved by the CLI (src/cli/shared/sync-scaffold-locals.ts)
 * and forwarded as CLI args. This prompt.js coerces boolean-ish strings back
 * into JS booleans so template `<% if (multiTenant) { %>` gates work — Hygen
 * args arrive as strings, and `if ("false")` would render truthy in EJS.
 *
 * Invoked via:
 *   bunx hygen subsystem sync \
 *     --configPath <abs> --schemaPath <abs> \
 *     --multiTenant <'true'|'false'> --appName <string>
 *
 * Unlike events, sync has NO codegen-emitted artifacts (no generated/ dir,
 * no typed bus facade). So no `generatedKeepPath` local. Consumers that
 * want a typed layer above the orchestrator build it themselves — the
 * subsystem ships the substrate.
 *
 * Intentionally no starter entity YAMLs (sync_subscription, sync_run,
 * sync_run_item). The subsystem owns those tables directly via SYNC-1's
 * sync-audit.schema.ts; shipping entity YAMLs would generate redundant
 * repositories/services that shadow the subsystem. Matches the epic's
 * Phase 2 timing for `examples/sync/`.
 */

import { renderGeneratedBanner } from "../../_shared/generated-banner.mjs";

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
      multiTenant: coerceBool(args.multiTenant),
      configPath: args.configPath ?? "codegen.config.yaml",
      schemaPath:
        args.schemaPath ?? "shared/subsystems/sync/sync-audit.schema.ts",
      // @generated DO-NOT-EDIT banner — the sync subsystem schema is
      // force-overwritten on every `subsystem install`.
      generatedBanner: renderGeneratedBanner({
        generator: "subsystem sync",
        seam: "the codegen.config.yaml sync block, then re-run `codegen subsystem install`",
      }),
    };
  },
};
