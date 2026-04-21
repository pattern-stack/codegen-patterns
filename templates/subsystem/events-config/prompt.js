/**
 * Hygen prompt.js — #121 (F13) events config-block scaffold.
 *
 * Split from `templates/subsystem/events/` so the CLI can invoke the
 * config-block inject step independently of the rest of the events scaffold.
 * This lets `subsystem install events --force` preserve an existing `events:`
 * block by skipping this action entirely, while `--force-config` opts in
 * to regenerating it.
 *
 * Invoked via:
 *   bunx hygen subsystem events-config --configPath <abs>
 */

export default {
  prompt: async ({ args }) => {
    return {
      configPath: args.configPath ?? "codegen.config.yaml",
    };
  },
};
