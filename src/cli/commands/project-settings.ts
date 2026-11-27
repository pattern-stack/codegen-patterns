/**
 * `codegen project settings` (SET-1): every value the project needs at startup, derived from its YAML (providers'
 * `settings:` and `client.base_url`, the installed subsystems', the project's database URL), where each is read from,
 * who needs it, and whether it is set now (the environment, then the project's `.env`). Works under either wiring,
 * with no build. `--check` exits 1 naming each required value that is unset.
 */

import path from 'node:path';
import { Command, Option } from 'clipanion';

import { loadContext } from '../shared/context.js';
import { checkSource, projectSettings, settingRows, type SettingRow } from '../shared/project-settings.js';
import { printError, printInfo, printSuccess } from '../ui/output.js';
import { isJsonMode, printJson, setJsonMode } from '../ui/json.js';

function ownerLabel(row: SettingRow): string {
	return row.owner.kind === 'project' ? 'project' : `${row.owner.kind} ${row.owner.name}`;
}

function statusLabel(row: SettingRow): string {
	if (row.status === 'set') return row.secret ? 'set' : `set (${row.value})`;
	if (row.status === 'default') return row.secret ? 'default' : `default (${row.default})`;
	if (row.status === 'invalid') return `INVALID (${row.problem})`;
	return 'MISSING';
}

/** The rows as aligned columns: env var, typed key, owner, secret, status. */
export function formatSettingRows(rows: readonly SettingRow[]): string[] {
	const cols = rows.map((r) => [r.env, `${r.group}.${r.key}`, ownerLabel(r), r.secret ? 'secret' : '', statusLabel(r)]);
	const widths = [0, 1, 2, 3].map((i) => Math.max(...cols.map((c) => c[i]!.length), 0));
	return cols.map((c) => c.map((v, i) => (i < 4 ? v.padEnd(widths[i]!) : v)).join('  ').trimEnd());
}

export class ProjectSettingsCommand extends Command {
	static paths = [['project', 'settings']];
	static usage = Command.Usage({
		description: 'List every setting the project needs (from its YAML), where it is read from, and whether it is set',
		details: `
			Derived from the YAML alone, with no build: each provider's \`settings:\` and \`client.base_url\`, each installed
			subsystem's settings, and the project's database URL. A value counts as set when it is in the environment or in
			the project's \`.env\`. A secret's value is never printed.

			\`--check\` exits 1 when a required setting (one with no default) is unset, or a value is one startup would refuse
			(a base URL that isn't a URL), naming each.
		`,
		examples: [
			['List the settings', 'codegen project settings'],
			['Fail when one is missing (CI, pre-deploy)', 'codegen project settings --check'],
			['As JSON', 'codegen project settings --json'],
		],
	});

	check = Option.Boolean('--check', false);
	json = Option.Boolean('--json', false);
	cwd = Option.String('--cwd', { required: false });
	configPath = Option.String('--config', { required: false });

	async execute(): Promise<number> {
		if (this.json) setJsonMode(true);
		const ctx = await loadContext({ cwd: this.cwd, configPath: this.configPath, json: this.json, skipDetection: true });
		let rows: SettingRow[];
		try {
			rows = settingRows(projectSettings(ctx), checkSource(ctx));
		} catch (err: unknown) {
			printError(err instanceof Error ? err.message : String(err));
			return 1;
		}
		// Missing or invalid: compose would refuse either.
		const missing = rows.filter((r) => r.status === 'missing' || r.status === 'invalid');
		const failed = this.check && missing.length > 0;
		if (isJsonMode()) {
			printJson({
				command: 'project settings',
				settings: rows.map(({ value, ...r }) => ({ ...r, ...(value !== undefined ? { value } : {}) })),
				missing: missing.map((r) => r.env),
				ok: missing.length === 0,
			});
			return failed ? 1 : 0;
		}
		for (const line of formatSettingRows(rows)) console.log(line);
		console.log('');
		if (missing.length === 0) {
			printSuccess(`${rows.length} settings; every required one is set.`);
			return 0;
		}
		const envFile = path.relative(process.cwd(), path.join(ctx.cwd, '.env')) || '.env';
		const report = `${missing.length} setting${missing.length === 1 ? '' : 's'} unset or invalid: ${missing
			.map((r) => `${r.env} (${r.group}.${r.key}, ${ownerLabel(r)}${r.problem ? `: ${r.problem}` : ''})`)
			.join(', ')}. Set ${missing.length === 1 ? 'it' : 'them'} in the environment or ${envFile} (.env.example lists every one).`;
		if (failed) {
			printError(report);
			return 1;
		}
		printInfo(report);
		return 0;
	}
}
