/**
 * Shared configuration loader for codegen
 *
 * Loads and caches codegen.config.yaml once, shared by all config modules.
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';

/**
 * Load project-specific codegen configuration from codegen.config.yaml
 * Returns null if config file doesn't exist (falls back to defaults)
 */
function loadProjectConfig(cwd = process.cwd()) {
  const configPath = path.resolve(cwd, 'codegen.config.yaml');

  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    return yaml.parse(content);
  } catch (error) {
    console.warn(`Warning: Failed to load codegen.config.yaml: ${error.message}`);
    return null;
  }
}

// Load project config once at module initialization
export const projectConfig = loadProjectConfig();

export default projectConfig;
