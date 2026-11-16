/**
 * #915 review — the definitions-root layout (`paths.entities: definitions`, with
 * providers, jobs and events beside the entities). One rule decides which files
 * are entities (`listEntityYamls(dir, layout.nonEntityDirs)`), so every command
 * — `entity new`, `entity validate`, `project inspect`, the frontend and semantic
 * emit contexts — sees the same set, and none reads a provider, job or event
 * YAML as an entity.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Cli } from 'clipanion';

import entityNoun from '../../cli/commands/entity.js';
import junctionNoun from '../../cli/commands/junction.js';
import projectNoun from '../../cli/commands/project.js';
import { loadFrontendEmitContext } from '../../emitters/frontend/load-context.js';
import { loadSemanticEmitContext } from '../../emitters/semantic/load-context.js';
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
	for (const noun of [entityNoun, junctionNoun, relationshipNoun, projectNoun]) {
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

const EVENT = 'type: note_created\ndirection: change\naggregate: note\nversion: 1\ndescription: A note was created.\npayload:\n  note_id:\n    type: uuid\n';

/** `paths.entities: definitions` — the supported layout where providers and jobs sit under the entities root. */
function mkDefinitionsRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'defroot-'));
	tempDirs.push(root);
	fs.writeFileSync(
		path.join(root, 'codegen.config.yaml'),
		'paths:\n  entities: definitions\n  events_dir: definitions/events\nsubsystems:\n  install: [integration]\ngenerate:\n  frontend: true\n',
	);
	fs.mkdirSync(path.join(root, 'definitions', 'providers'), { recursive: true });
	fs.mkdirSync(path.join(root, 'definitions', 'jobs'), { recursive: true });
	fs.mkdirSync(path.join(root, 'definitions', 'events'), { recursive: true });
	fs.writeFileSync(path.join(root, 'definitions', 'events', 'note_created.yaml'), EVENT);
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

describe('every reader of the entity set uses the one rule (#915 review F1, F4)', () => {
	test('entity validate --json exits 0 — the job, provider and event are not entities', async () => {
		const root = mkDefinitionsRoot();
		const { code, out } = await run(['entity', 'validate', '--json', '--cwd', root]);
		expect(out).not.toContain('note_poll');
		expect((JSON.parse(out) as { valid: boolean }).valid).toBe(true);
		expect(code).toBe(0);
	});

	test('project inspect --kind analyze --json exits 0', async () => {
		const root = mkDefinitionsRoot();
		const { code } = await run(['project', 'inspect', '--kind', 'analyze', '--json', '--cwd', root]);
		expect(code).toBe(0);
	});

	test('project graph --json exits 0', async () => {
		const root = mkDefinitionsRoot();
		const { code } = await run(['project', 'graph', '--json', '--cwd', root]);
		expect(code).toBe(0);
	});

	test('the frontend and semantic emit contexts load the set, skipping provider, job and event YAML', async () => {
		const root = mkDefinitionsRoot();
		const { config } = await loadContext({ cwd: root, skipDetection: true });
		const entitiesDir = path.join(root, 'definitions');
		const fe = loadFrontendEmitContext(root, config as never, { entitiesDir });
		expect(fe.skip).toBeUndefined();
		expect(fe.ctx).toBeDefined();
		expect(() => loadSemanticEmitContext(root, config as never, { entitiesDir })).not.toThrow();
	});
});

describe('one relationships directory (#915 review F5)', () => {
	function mkProject(relDir: string): string {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-dir-'));
		tempDirs.push(root);
		fs.writeFileSync(path.join(root, 'codegen.config.yaml'), 'paths:\n  entities: src/defs\n');
		fs.mkdirSync(path.join(root, 'src', 'defs'), { recursive: true });
		fs.writeFileSync(path.join(root, 'src', 'defs', 'note.yaml'), NOTE);
		fs.writeFileSync(path.join(root, 'src', 'defs', 'user.yaml'), USER);
		fs.mkdirSync(path.join(root, relDir), { recursive: true });
		fs.writeFileSync(
			path.join(root, relDir, 'note_user.yaml'),
			'relationship:\n  name: note_user\n  table: note_users\n  from: note\n  to: user\n  types: [related_to]\n',
		);
		return root;
	}
	const draws = async (root: string) => {
		const { code, out } = await run(['project', 'graph', '--json', '--cwd', root]);
		expect(code).toBe(0);
		return (JSON.parse(out) as { relationshipDefinitions: number }).relationshipDefinitions;
	};

	test('a relationship beside the entities root (not at <cwd>/relationships) is not drawn', async () => {
		expect(await draws(mkProject('src/relationships'))).toBe(0);
	});

	test('a relationship at relationshipsDirFor(cwd) is drawn', async () => {
		expect(await draws(mkProject('relationships'))).toBe(1);
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
