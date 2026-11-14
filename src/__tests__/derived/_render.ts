/**
 * Render a render-matrix case's entities through the real backend templates, in-process — the way
 * `src/__tests__/backend/eav-templates.test.ts` does: `buildBackendLocals` plus the locals `prompt.js` owns, then
 * `ejs.render` over each template body. Each template's own front matter decides whether it is written (`to:`
 * rendering to `null`, or `skip_if:` rendering to `true`), as hygen does.
 *
 * The result is a path → text map of what `entity new` would write for those entities.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ejs from 'ejs';

import { buildBackendLocals } from '../../../templates/entity/new/backend/entity-locals.js';
import { entityLookupFrom } from '../../../templates/_shared/entity-naming.mjs';
import { runtimeImportLocals } from '../../config/runtime-mode.mjs';
import { DEFAULT_CODEGEN_CONFIG } from '../../config/project-config';
import { deriveRoleRelationships } from '../../roles/derive';
import { PROJECT_CONFIG_LOCALS } from '../backend/_entity-lookup';
import type { DefinitionSet } from './_inputs';
import { REPO_ROOT } from './_inputs';

const BACKEND_TEMPLATES = join(REPO_ROOT, 'templates/entity/new/backend');

/** The templates that emit an entity's API surface: repository, service, controllers, use cases. */
const SURFACE_TEMPLATES = [
	'repository.ejs.t',
	'service.ejs.t',
	'controller.ejs.t',
	'search-controller.ejs.t',
	...readdirSync(join(BACKEND_TEMPLATES, 'use-cases'))
		.filter((f) => f.endsWith('.ejs.t'))
		.sort()
		.map((f) => `use-cases/${f}`),
];

/** The module tree root a render writes under — the schema default, as a project with no config would. */
export const RENDER_MODULES_DIR = DEFAULT_CODEGEN_CONFIG.paths.modules_dir;

interface Template {
	front: Record<string, string>;
	body: string;
}

function readTemplate(rel: string): Template {
	const source = readFileSync(join(BACKEND_TEMPLATES, rel), 'utf-8');
	const lines = source.split('\n');
	const end = lines.indexOf('---', 1);
	if (lines[0] !== '---' || end === -1) throw new Error(`${rel}: no front matter`);
	const front: Record<string, string> = {};
	for (const line of lines.slice(1, end)) {
		const m = /^(\w+):\s*(.*)$/.exec(line);
		if (m) front[m[1]!] = m[2]!.replace(/^"(.*)"$/, '$1');
	}
	return { front, body: lines.slice(end + 1).join('\n') };
}

/** The locals `templates/entity/new/prompt.js` owns, for a project with no events and no detection. */
function promptLocals(set: DefinitionSet): Record<string, unknown> {
	return {
		generatedBanner: '',
		runtimeMode: 'vendored',
		...runtimeImportLocals('vendored'),
		hasDetection: false,
		detectionConfigsLiteral: '{}',
		hasEmits: false,
		emitsEvents: [],
		createEventType: null,
		updateEventType: null,
		deleteEventType: null,
		...PROJECT_CONFIG_LOCALS,
		modulesDir: RENDER_MODULES_DIR,
		entityLookup: entityLookupFrom(set.entities.map((d) => d.entity)),
		junctions: set.junctions,
		renderSet: set.entities.map((d) => d.entity.name),
	};
}

/** Render `entities` of `set` through the surface templates; path → text. */
export function renderEntities(set: DefinitionSet, entities: readonly string[]): Map<string, string> {
	const files = new Map<string, string>();
	const base = promptLocals(set);
	const templates = SURFACE_TEMPLATES.map((rel) => ({ rel, ...readTemplate(rel) }));
	for (const name of entities) {
		const raw = set.entities.find((d) => d.entity.name === name);
		if (!raw) throw new Error(`render: '${name}' is not in the set`);
		// prompt.js merges a `cardinality: one` role into relationships before the backend extension runs.
		const definition = structuredClone(raw) as typeof raw;
		if (definition.roles) {
			definition.relationships = { ...(definition.relationships ?? {}), ...deriveRoleRelationships(definition.roles) };
		}
		const locals = buildBackendLocals(definition, base);
		for (const t of templates) {
			const to = ejs.render(t.front.to ?? '', locals).trim();
			if (to === '' || to === 'null' || to === 'undefined') continue;
			if (t.front.skip_if !== undefined && ejs.render(t.front.skip_if, locals).trim() === 'true') continue;
			files.set(to, ejs.render(t.body, locals, { rmWhitespace: false }));
		}
	}
	return files;
}
