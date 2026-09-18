/**
 * The project's parsed `codegen.config.yaml`, for the hygen-side helpers
 * (`paths.mjs`, `locations.mjs`, `naming-config.mjs`) and the prompts that read
 * them.
 *
 * Parsed and validated once by `project-config.ts` (CFG-0, #640) — the same
 * loader the CLI uses. An invalid file throws `CodegenConfigError` here, at
 * import, so the prompt fails before it generates anything. `null` when the
 * project has no config file (every reader falls back to its defaults).
 */

import { loadProjectConfig } from './project-config.js';

export const projectConfig = loadProjectConfig(process.cwd());

export default projectConfig;
