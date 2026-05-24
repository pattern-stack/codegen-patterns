/**
 * Hygen prompt.js — EVT-8 events subsystem scaffold.
 *
 * All locals are resolved by the CLI (src/cli/shared/events-scaffold-locals.ts)
 * and forwarded as CLI args. This prompt.js coerces boolean-ish strings back
 * into JS booleans so template `<% if (multiTenant) { %>` gates work — Hygen
 * args arrive as strings, and `if ("false")` would render truthy in EJS.
 *
 * Invoked via:
 *   bunx hygen subsystem events \
 *     --configPath <abs> --schemaPath <abs> --generatedKeepPath <abs> \
 *     --multiTenant <'true'|'false'> --appName <string>
 *
 * Unlike jobs, events has no separate worker process — the outbox drain loop
 * runs inside the NestJS app context wherever `EventsModule.forRoot(...)` is
 * imported. So no workerPath / workerMode / mainTsPath locals here.
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
        args.schemaPath ?? "shared/subsystems/events/domain-events.schema.ts",
      generatedKeepPath:
        args.generatedKeepPath ??
        "shared/subsystems/events/generated/.gitkeep",
      // @generated DO-NOT-EDIT banner — the events subsystem schema is
      // force-overwritten on every `subsystem install`.
      generatedBanner: renderGeneratedBanner({
        generator: "subsystem events",
        seam: "the codegen.config.yaml events block, then re-run `codegen subsystem install`",
      }),
    };
  },
};
