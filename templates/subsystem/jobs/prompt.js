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
 *     --mainTsPath <abs> --configPath <abs> --schemaPath <abs> \
 *     --multiTenant <'true'|'false'> --workerMode <embedded|standalone> \
 *     --appName <string>
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
      workerMode: args.workerMode === "standalone" ? "standalone" : "embedded",
      multiTenant: coerceBool(args.multiTenant),
      mainTsPath: args.mainTsPath ?? "src/main.ts",
      configPath: args.configPath ?? "codegen.config.yaml",
      // Hygen's skip_if treats any non-empty string as truthy, so we send an
      // empty string when the file doesn't exist (CLI already does this).
      workerExists: args.workerExists ?? "",
      workerPath: args.workerPath ?? "worker.ts",
      schemaPath:
        args.schemaPath ?? "shared/subsystems/jobs/job-orchestration.schema.ts",
    };
  },
};
