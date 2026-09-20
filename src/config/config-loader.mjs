/**
 * The project's parsed `codegen.config.yaml`, for the hygen-side helpers
 * (`paths.mjs`) and the prompts that read them.
 *
 * Parsed and validated once by `project-config.ts` (CFG-0, #640) — the same
 * loader the CLI uses. An invalid file throws `CodegenConfigError` here, at
 * import, so the prompt fails before it generates anything.
 *
 * - `projectConfig` — the parsed file, `null` when the project has none.
 * - `resolvedConfig` — `projectConfig`, or the schema's defaults
 *   (`DEFAULT_CODEGEN_CONFIG`) when there is no file. Read every value through
 *   this: the defaults are declared once, in the schema (PATH-0, #642).
 */

import { configOrDefaults, loadProjectConfig } from './project-config.js';

export const projectConfig = loadProjectConfig(process.cwd());

export const resolvedConfig = configOrDefaults(projectConfig);

export default projectConfig;
