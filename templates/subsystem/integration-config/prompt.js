/**
 * Hygen prompt.js — SYNC-7 integration config-block scaffold.
 *
 * Split from `templates/subsystem/integration/` so the CLI can invoke the
 * config-block inject step independently of the rest of the integration scaffold.
 * This lets `subsystem install integration --force` preserve an existing `integration:`
 * block by skipping this action entirely, while `--force-config` opts in
 * to regenerating it.
 *
 * Mirrors `events-config` exactly.
 *
 * Invoked via:
 *   bunx hygen subsystem integration-config --configPath <abs>
 */

export default {
  prompt: async ({ args }) => {
    return {
      configPath: args.configPath ?? "codegen.config.yaml",
    };
  },
};
