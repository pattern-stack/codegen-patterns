/**
 * Hygen prompt.js — #287 auth-integrations starter scaffold.
 *
 * Locals are resolved by the CLI
 * (src/cli/shared/auth-integrations-scaffold-locals.ts) and forwarded as
 * CLI args. The vendor copies (runtime/integrations/** + integration.yaml)
 * happen in subsystem.ts (`runAuthIntegrationsScaffold`); this template
 * folder only injects the TODO comment block into app.module.ts.
 *
 * Invoked via:
 *   bunx hygen subsystem auth-integrations \
 *     --appName <string> \
 *     --appModulePath <abs>
 */

export default {
  prompt: async ({ args }) => {
    return {
      appName: args.appName ?? "",
      appModulePath: args.appModulePath ?? "src/app.module.ts",
    };
  },
};
