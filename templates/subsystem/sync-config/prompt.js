/**
 * Hygen prompt.js — SYNC-7 sync config-block scaffold.
 *
 * Split from `templates/subsystem/sync/` so the CLI can invoke the
 * config-block inject step independently of the rest of the sync scaffold.
 * This lets `subsystem install sync --force` preserve an existing `sync:`
 * block by skipping this action entirely, while `--force-config` opts in
 * to regenerating it.
 *
 * Mirrors `events-config` exactly.
 *
 * Invoked via:
 *   bunx hygen subsystem sync-config --configPath <abs>
 */

export default {
  prompt: async ({ args }) => {
    return {
      configPath: args.configPath ?? "codegen.config.yaml",
    };
  },
};
