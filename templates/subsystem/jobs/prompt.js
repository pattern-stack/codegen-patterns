/**
 * Hygen prompt.js — JOB-6 jobs subsystem scaffold.
 *
 * All locals are resolved by the CLI (src/cli/shared/jobs-scaffold-locals.ts)
 * and forwarded as CLI args.
 *
 * Invoked via:
 *   bunx hygen subsystem jobs \
 *     --workerPath <abs> --workerExists <'true'|''> \
 *     --mainTsPath <abs> --configPath <abs> --schemaPath <abs> \
 *     --skipSchema <'true'|''> --appName <string>
 */

import { renderGeneratedBanner } from "../../_shared/generated-banner.mjs";
import { requiredPathArg } from "../../_shared/required-arg.mjs";


export default {
  prompt: async ({ args }) => {
    return {
      appName: args.appName ?? "",
      mainTsPath: requiredPathArg(args, "mainTsPath", "subsystem jobs"),
      configPath: args.configPath ?? "codegen.config.yaml",
      // Hygen's skip_if treats any non-empty string as truthy, so we send an
      // empty string when the file doesn't exist (CLI already does this).
      workerExists: args.workerExists ?? "",
      // #513: the worker lands at `src/worker.ts` (inside the default tsconfig
      // include, next to `app.module.ts`); the CLI always passes an absolute
      // --workerPath, this fallback only guards a direct hygen invocation.
      workerPath: requiredPathArg(args, "workerPath", "subsystem jobs"),
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
