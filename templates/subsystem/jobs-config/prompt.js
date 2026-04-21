/**
 * Hygen prompt.js — #121 (F13) jobs config-block scaffold.
 *
 * Split from `templates/subsystem/jobs/` so the CLI can invoke the
 * config-block inject step independently of the rest of the jobs scaffold.
 * This lets `subsystem install jobs --force` preserve an existing `jobs:`
 * block by skipping this action entirely, while `--force-config` opts in
 * to regenerating it.
 *
 * Invoked via:
 *   bunx hygen subsystem jobs-config --configPath <abs>
 */

export default {
  prompt: async ({ args }) => {
    return {
      configPath: args.configPath ?? "codegen.config.yaml",
    };
  },
};
