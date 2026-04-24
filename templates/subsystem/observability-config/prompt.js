/**
 * Hygen prompt.js — OBS-7 observability config-block scaffold.
 *
 * Split from `templates/subsystem/observability/` so the CLI can invoke the
 * config-block inject step independently. `subsystem install observability
 * --force` preserves an existing `observability:` block by skipping this
 * action; `--force-config` opts into regenerating it (mirrors EVT-8 /
 * SYNC-7 / BRIDGE-9 / #121 F13 precedent).
 *
 * Invoked via:
 *   bunx hygen subsystem observability-config --configPath <abs>
 */

export default {
  prompt: async ({ args }) => {
    return {
      configPath: args.configPath ?? "codegen.config.yaml",
    };
  },
};
