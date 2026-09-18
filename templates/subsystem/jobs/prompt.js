/**
 * Hygen prompt.js — JOB-6 jobs subsystem scaffold.
 *
 * All locals are resolved by the CLI (src/cli/shared/jobs-scaffold-locals.ts)
 * and forwarded as CLI args. This prompt.js coerces boolean-ish strings back
 * into JS booleans so template `<% if (multiTenant) { %>` gates work — Hygen
 * args arrive as strings, and `if ("false")` would render truthy in EJS.
 *
 * Invoked via:
 *   bunx hygen subsystem jobs \
 *     --workerPath <abs> --workerExists <'true'|''> \
 *     --jobWorkerModuleImport <specifier> --appConfigImport <specifier> \
 *     --mainTsPath <abs> --configPath <abs> --schemaPath <abs> \
 *     --multiTenant <'true'|'false'> --workerMode <embedded|standalone> \
 *     --skipSchema <'true'|''> --appName <string>
 */

import { renderGeneratedBanner } from "../../_shared/generated-banner.mjs";
import { requiredPathArg } from "../../_shared/required-arg.mjs";

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
      workerMode: args.workerMode === "standalone" ? "standalone" : "embedded",
      multiTenant: coerceBool(args.multiTenant),
      mainTsPath: requiredPathArg(args, "mainTsPath", "subsystem jobs"),
      configPath: args.configPath ?? "codegen.config.yaml",
      // Hygen's skip_if treats any non-empty string as truthy, so we send an
      // empty string when the file doesn't exist (CLI already does this).
      workerExists: args.workerExists ?? "",
      // #513: the worker lands at `src/worker.ts` (inside the default tsconfig
      // include, next to `app.module.ts`); the CLI always passes an absolute
      // --workerPath, this fallback only guards a direct hygen invocation.
      workerPath: requiredPathArg(args, "workerPath", "subsystem jobs"),
      // #513: mode-aware JobWorkerModule import (the only mode-dependent import
      // the worker carries — AppModule is imported relatively).
      jobWorkerModuleImport:
        args.jobWorkerModuleImport ??
        "@pattern-stack/codegen/runtime/subsystems/jobs/index",
      // GEN-0: `<generated>/app-config` from the worker — its `jobWorkerOptions`
      // is the whole `JobWorkerModule.forRoot` argument.
      appConfigImport: requiredPathArg(args, "appConfigImport", "subsystem jobs"),
      schemaPath:
        requiredPathArg(args, "schemaPath", "subsystem jobs"),
      // #517: package mode skips the schema template (the schema ships in the
      // package, re-exported via the schema barrel). Hygen's skip_if treats any
      // non-empty string as truthy, so the CLI sends '' in vendored mode and
      // 'true' in package mode. Default '' so a direct hygen invocation renders.
      skipSchema: args.skipSchema ?? "",
      // @generated DO-NOT-EDIT banner — the jobs subsystem schema is
      // force-overwritten on every `subsystem install`.
      generatedBanner: renderGeneratedBanner({
        generator: "subsystem jobs",
        seam: "the codegen.config.yaml jobs block, then re-run `codegen subsystem install`",
      }),
    };
  },
};
