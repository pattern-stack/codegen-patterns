/**
 * The project's settings as the CLI reads them (SET-1): the derivation over this project's provider YAMLs and installed
 * subsystems, the `.env.example` it writes, and each setting's status for `codegen project settings`.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { Context } from './context.js';
import { projectLayout } from './project-layout.js';
import { isSubsystemInstalled, type SubsystemName } from './subsystem-detect.js';
import { loadProviderSet } from './provider-module-generator.js';
import { deriveProjectSettings, SUBSYSTEM_SETTINGS, type ProjectSetting } from '../../derived/settings/index.js';
import { envExampleContent, isGeneratedEnvExample } from '../../emitters/settings/emit-settings.js';
import { generating } from '../../utils/generated-file.js';
import { projectSource, settingValueProblem, type SettingsSource } from '../../../runtime/settings.js';
import { printWarning } from '../ui/output.js';

/** The installed subsystems that declare settings: `isSubsystemInstalled`'s one rule, as the composition reads it. */
function installedWithSettings(ctx: Context): string[] {
	return Object.keys(SUBSYSTEM_SETTINGS).filter((n) => isSubsystemInstalled(ctx, n as SubsystemName));
}

/**
 * Every setting the project needs, from its YAML. A provider YAML that fails to load is refused here (as the composition
 * does), not dropped: a setting it declares must not vanish from the list.
 */
export function projectSettings(ctx: Context): ProjectSetting[] {
	const layout = projectLayout(ctx.cwd, ctx.config);
	const providers = loadProviderSet({ providersDir: layout.providers, entitySurfaces: new Set(), skipImportCheck: true });
	const failures = providers.loadFailures;
	if (failures.length > 0) {
		throw new Error(
			`[codegen] definitions/providers: ${failures.map((f) => `${f.error} (${path.relative(ctx.cwd, f.filePath)})`).join('; ')}`,
		);
	}
	return deriveProjectSettings({
		providers: providers.loaded,
		installedSubsystems: installedWithSettings(ctx),
		cwd: ctx.cwd,
	});
}

/** Where `.env.example` goes: beside `codegen.config.yaml`. */
export function envExamplePath(ctx: Context): string {
	return path.join(ctx.cwd, '.env.example');
}

/**
 * Write `.env.example` from the settings, when it changed. A `.env.example` codegen didn't write (no banner) is the
 * project's: left as it is, with a warning, so a curated one is never replaced.
 */
export function writeEnvExample(ctx: Context, settings: readonly ProjectSetting[]): string | null {
	const file = envExamplePath(ctx);
	const content = envExampleContent(settings);
	if (fs.existsSync(file)) {
		const text = fs.readFileSync(file, 'utf8');
		if (text === content) return file;
		if (!isGeneratedEnvExample(text)) {
			printWarning(
				`.env.example is yours (it has no codegen banner), so it was left as it is; ` +
					'`codegen project settings` lists every value the project needs',
			);
			return null;
		}
	}
	generating(file, () => fs.writeFileSync(file, content));
	return file;
}

/** What `codegen project settings` reads: the project's source, the one the generated `settings` system reads too. */
export function checkSource(ctx: Context): SettingsSource {
	return projectSource(ctx.cwd);
}

export type SettingStatus = 'set' | 'default' | 'missing' | 'invalid';

export interface SettingRow extends ProjectSetting {
	status: SettingStatus;
	/** The value, for a non-secret that is set (never a secret's). */
	value?: string;
	/** Why the value (or the default) would be refused at startup. */
	problem?: string;
}

/** Each setting with its status under `source`. */
export function settingRows(settings: readonly ProjectSetting[], source: SettingsSource): SettingRow[] {
	return settings.map((s) => {
		const value = source({ group: s.group, key: s.key, env: s.env });
		const shown = value !== undefined && !s.secret ? { value } : {};
		const raw = value ?? s.default;
		if (raw === undefined) return { ...s, status: 'missing' as const };
		// The rule `loadSettings` applies at startup, so the check never passes a value compose would refuse.
		const problem = settingValueProblem(s, raw);
		if (problem) return { ...s, status: 'invalid' as const, problem, ...shown };
		return { ...s, status: value !== undefined ? ('set' as const) : ('default' as const), ...shown };
	});
}
