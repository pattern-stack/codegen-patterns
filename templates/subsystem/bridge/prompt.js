/**
 * Hygen prompt.js — BRIDGE-9 bridge subsystem scaffold (lean variant).
 *
 * Locals resolved by the CLI (src/cli/shared/bridge-scaffold-locals.ts) and
 * forwarded as CLI args. This prompt.js coerces boolean-ish strings back into
 * JS booleans for parity with events / integration (Hygen args arrive as strings).
 *
 * Invoked via:
 *   bunx hygen subsystem bridge \
 *     --configPath <abs> --generatedKeepPath <abs> \
 *     --multiTenant <'true'|'false'> --appName <string>
 *
 * No schema template here — `bridge-delivery.schema.ts` ships unconditionally
 * via `copyRuntime` (BRIDGE-1's `tenant_id` column is always emitted; multi-
 * tenancy is a runtime enforcement concern, not a scaffold-time gate).
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
      multiTenant: coerceBool(args.multiTenant),
      configPath: args.configPath ?? "codegen.config.yaml",
      generatedKeepPath:
        args.generatedKeepPath ??
        "shared/subsystems/bridge/generated/.gitkeep",
    };
  },
};
