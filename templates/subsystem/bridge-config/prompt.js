/**
 * Hygen prompt.js — BRIDGE-9 bridge config-block scaffold.
 *
 * Split from `templates/subsystem/bridge/` so the CLI can invoke the
 * config-block inject step independently. `subsystem install bridge --force`
 * preserves an existing `bridge:` block by skipping this action;
 * `--force-config` opts into regenerating it (mirrors EVT-8 / SYNC-7 +
 * #121 / F13 precedent).
 *
 * Invoked via:
 *   bunx hygen subsystem bridge-config --configPath <abs>
 */

export default {
  prompt: async ({ args }) => {
    return {
      configPath: args.configPath ?? "codegen.config.yaml",
    };
  },
};
