/**
 * Hygen prompt.js — #287 auth config-block scaffold.
 *
 * Split from `templates/subsystem/auth/` so the CLI can invoke the
 * config-block inject step independently — `subsystem install auth --force`
 * preserves an existing `auth:` block by skipping this action; pass
 * `--force-config` to opt into regeneration. Mirrors `events-config` /
 * `sync-config` / `observability-config` exactly.
 *
 * Invoked via:
 *   bunx hygen subsystem auth-config --configPath <abs>
 */

export default {
  prompt: async ({ args }) => {
    return {
      configPath: args.configPath ?? "codegen.config.yaml",
    };
  },
};
