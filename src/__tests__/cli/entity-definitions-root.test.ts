/**
 * #915 review — definitions-root layout; an entity, relationship or junction YAML that fails validation is a run-level rejection, named,
 * whichever command runs and whichever target it names. The whole-set
 * post-steps (barrels, relations manifest, scope union, events) read the
 * entity directory and used to skip an invalid entity without a word, writing a
 * manifest over a set missing it; the run then failed in `tsc`, far from the
 * cause. Nothing is written when the set is not whole.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Cli } from 'clipanion';

import entityNoun from '../../cli/commands/entity.js';
import junctionNoun from '../../cli/commands/junction.js';
import relationshipNoun from '../../cli/commands/relationship.js';
import { loadContext } from '../../cli/shared/context.js';
import { buildInitPlan, writePlan } from '../../cli/shared/init-scaffold.js';
import { setJsonMode } from '../../cli/ui/json.js';

const tempDirs: string[] = [];
afterEach(() => {
	setJsonMode(false);
	for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
	tempDirs.length = 0;
});

const NOTE = 'entity:\n  name: note\n  plural: notes\nfields:\n  body:\n    type: string\n';
const USER = 'entity:\n  name: user\n  plural: users\nfields:\n  email:\n    type: string\n';
// `config:` at the YAML root instead of inside `entity:` — fails the schema.
const BAD = 'entity:\n  name: bad\n  plural: bads\nconfig:\n  x: 1\nfields:\n  title:\n    type: string\n';

async function run(argv: string[]): Promise<{ code: number; out: string }> {
	const cli = new Cli({ binaryName: 'codegen', binaryVersion: '0.0.0' });
	for (const noun of [entityNoun, junctionNoun, relationshipNoun]) {
		for (const Cls of noun.commandClasses) cli.register(Cls);
	}
	const chunks: string[] = [];
	const push = (...args: unknown[]) => chunks.push(args.map(String).join(' ') + '\n');
	const orig = {
		write: process.stdout.write.bind(process.stdout),
		ewrite: process.stderr.write.bind(process.stderr),
		log: console.log,
		warn: console.warn,
		error: console.error,
	};
	const sink = ((data: string | Uint8Array) => {
		chunks.push(typeof data === 'string' ? data : new TextDecoder().decode(data));
		return true;
	}) as typeof process.stdout.write;
	process.stdout.write = sink;
	process.stderr.write = sink;
	console.log = push;
	console.warn = push;
	console.error = push;
	try {
		return { code: await cli.run(argv), out: chunks.join('') };
	} finally {
		process.stdout.write = orig.write;
		process.stderr.write = orig.ewrite;
		console.log = orig.log;
		console.warn = orig.warn;
		console.error = orig.error;
	}
}


const PROVIDER = [
	'slug: hubspot',
	'display_name: HubSpot',
	'auth:',
	'  type: oauth2',
	"  strategy: '@app/integrations/providers/hubspot/hubspot-oauth.strategy#HubspotOAuthStrategy'",
	'  scopes: [crm.objects.contacts.read]',
	'client:',
	"  class: '@app/integrations/providers/hubspot/hubspot.client#HubspotClient'",
	'  base_url: https://api.hubapi.com',
	'surfaces: [crm]',
	'',
].join('\n');

const JOB = [
	'type: note_poll',
	'pool: integration',
	'triggers:',
	'  - schedule: { every: 15m, align: true }',
	'arms:',
	'  - kind: poll',
	'    domain: note',
	'    read:',
	'      mode: poll',
	'      poll:',
	'        cursor: { kind: timestamp, field: updated_at }',
	'      mapping:',
	'        - { source: id, target: external_id }',
	'',
].join('\n');

/** `paths.entities: definitions` — the supported layout where providers and jobs sit under the entities root. */
function mkDefinitionsRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'defroot-'));
	tempDirs.push(root);
	fs.writeFileSync(
		path.join(root, 'codegen.config.yaml'),
		'paths:\n  entities: definitions\nsubsystems:\n  install: [integration]\n',
	);
	fs.mkdirSync(path.join(root, 'definitions', 'providers'), { recursive: true });
	fs.mkdirSync(path.join(root, 'definitions', 'jobs'), { recursive: true });
	fs.writeFileSync(
		path.join(root, 'definitions', 'note.yaml'),
		NOTE.replace('  plural: notes\n', '  plural: notes\n  surface: crm\n'),
	);
	fs.writeFileSync(path.join(root, 'definitions', 'providers', 'hubspot.yaml'), PROVIDER);
	fs.writeFileSync(path.join(root, 'definitions', 'jobs', 'note_poll.yaml'), JOB);
	return root;
}

describe('one rule for which files are entities (#915 review)', () => {
	test('entity new <valid> under paths.entities: definitions, with a provider and a job beside it', async () => {
		const root = mkDefinitionsRoot();
		const file = path.join(root, 'definitions', 'note.yaml');
		const { code, out } = await run(['entity', 'new', file, '--dry-run', '--json', '--cwd', root]);
		expect(out).not.toContain('reached a whole-set step');
		expect(code).toBe(0);
	});

	test('entity new --all, same layout', async () => {
		const root = mkDefinitionsRoot();
		const { code, out } = await run(['entity', 'new', '--all', '--dry-run', '--json', '--cwd', root]);
		expect(out).not.toContain('reached a whole-set step');
		expect(code).toBe(0);
	});

	test('a real (non-dry) run writes the barrels from the entity set only', async () => {
		const root = mkDefinitionsRoot();
		const { code, out } = await run(['entity', 'new', '--all', '--force', '--cwd', root]);
		expect(out).not.toContain('reached a whole-set step');
		expect(code).toBe(0);
	});
});

describe('`codegen init` scaffolds nothing its next command rejects (#915 review)', () => {
	test('init, then entity new on a valid entity — no placeholder deleted first', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'init-then-new-'));
		tempDirs.push(root);
		const ctx = await loadContext({ cwd: root, skipDetection: true });
		writePlan(await buildInitPlan(ctx, { cwd: root, skipScan: true }));
		// The scaffold's note on adding an entity is not YAML.
		expect(fs.existsSync(path.join(root, 'entities', 'README.md'))).toBe(true);
		expect(fs.existsSync(path.join(root, 'entities', 'example.yaml'))).toBe(false);

		const file = path.join(root, 'entities', 'note.yaml');
		fs.writeFileSync(file, NOTE);
		const one = await run(['entity', 'new', file, '--force', '--json', '--cwd', root]);
		expect(one.out).not.toContain('reached a whole-set step');
		expect(one.code).toBe(0);
		const all = await run(['entity', 'new', '--all', '--force', '--json', '--cwd', root]);
		expect(all.code).toBe(0);
	});
});
