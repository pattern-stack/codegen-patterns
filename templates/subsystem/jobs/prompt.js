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
 *     --jobWorkerModuleImport <specifier> --workerForRootOpts <ts-literal> \
 *     --mainTsPath <abs> --configPath <abs> --schemaPath <abs> \
 *     --multiTenant <'true'|'false'> --workerMode <embedded|standalone> \
 *     --appName <string>
 */

import { renderGeneratedBanner } from "../../_shared/generated-banner.mjs";

function coerceBool(raw) {
  if (raw === true) return true;
  if (raw === false) return false;
  if (typeof raw === "string") return raw.toLowerCase() === "true";
  return false;
}

// #513: the CLI base64-encodes --workerForRootOpts because Hygen's yargs parser
// mangles a raw `{ mode: 'standalone', … }` TS literal (the braces/colons are
// read as nested object syntax). Decode it back to the source string here. A
// direct hygen invocation that passes a non-encoded value (or omits it) falls
// back to the plain default below.
function decodeWorkerForRootOpts(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    return "{ mode: 'standalone', allPools: true }";
  }
  try {
    const decoded = Buffer.from(raw, "base64").toString("utf-8");
    // Re-encoding round-trips iff `raw` was valid base64 of the decoded bytes;
    // guards against a hand-passed plain literal being treated as base64.
    if (Buffer.from(decoded, "utf-8").toString("base64") === raw) {
      return decoded;
    }
  } catch {
    /* fall through to raw */
  }
  return raw;
}

export default {
  prompt: async ({ args }) => {
    return {
      appName: args.appName ?? "",
      workerMode: args.workerMode === "standalone" ? "standalone" : "embedded",
      multiTenant: coerceBool(args.multiTenant),
      mainTsPath: args.mainTsPath ?? "src/main.ts",
      configPath: args.configPath ?? "codegen.config.yaml",
      // Hygen's skip_if treats any non-empty string as truthy, so we send an
      // empty string when the file doesn't exist (CLI already does this).
      workerExists: args.workerExists ?? "",
      // #513: the worker lands at `src/worker.ts` (inside the default tsconfig
      // include, next to `app.module.ts`); the CLI always passes an absolute
      // --workerPath, this fallback only guards a direct hygen invocation.
      workerPath: args.workerPath ?? "src/worker.ts",
      // #513: mode-aware JobWorkerModule import + the pre-serialised
      // forRoot(<opts>) literal (the only mode-dependent import the worker
      // carries — AppModule is imported relatively).
      jobWorkerModuleImport:
        args.jobWorkerModuleImport ??
        "@pattern-stack/codegen/runtime/subsystems/jobs/index",
      workerForRootOpts: decodeWorkerForRootOpts(args.workerForRootOpts),
      schemaPath:
        args.schemaPath ?? "shared/subsystems/jobs/job-orchestration.schema.ts",
      // @generated DO-NOT-EDIT banner — the jobs subsystem schema is
      // force-overwritten on every `subsystem install`.
      generatedBanner: renderGeneratedBanner({
        generator: "subsystem jobs",
        seam: "the codegen.config.yaml jobs block, then re-run `codegen subsystem install`",
      }),
    };
  },
};
