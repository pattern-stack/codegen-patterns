/**
 * `POST /api/relationships` (preview) and `PUT /api/relationships` (write)
 * — STUDIO-0, #698.
 *
 * These endpoints author YAML; they do not generate code. Adding a link in
 * Studio edits the definition files, and the user then clicks Generate, which
 * runs the real CLI over them. Keeping the two apart is what lets the preview
 * be an honest dry run: it renders the exact post-edit content of every file
 * the write would touch, and touches nothing.
 *
 * Which files each kind writes:
 *   belongs_to / has_one  → the FROM entity YAML (+ the TO entity YAML when
 *                           `options.inverse` asks for the reverse accessor)
 *   has_many              → the FROM entity YAML
 *   many_to_many          → a new first-class relationship definition at
 *                           `relationships/<from>_<to>.yaml`
 *   inherits              → the FROM (child) entity YAML's top-level `inherits:`
 *
 * Existing files are edited through `yaml`'s Document API, not re-serialized
 * from a parsed object, so comments and key order in the rest of the file
 * survive an edit made from the browser.
 */

import fs from 'node:fs';
import path from 'node:path';
import pluralize from 'pluralize';
import { discriminatorKindsOf } from '../../schema/inheritance.js';
import { Document, parseDocument, stringify as stringifyYaml } from 'yaml';

import type {
	RelationshipKind,
	RelationshipOptions,
	RelationshipPreviewFile,
	RelationshipRequest,
} from '../shared/api.js';
import { definitionDirs, listFiles, validateContent } from './files.js';
import { resolveProjectPath, toProjectRelative } from './paths.js';

export class RelationshipRequestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RelationshipRequestError';
	}
}

const KINDS: RelationshipKind[] = ['belongs_to', 'has_many', 'has_one', 'many_to_many', 'inherits'];

/** Validate and normalize the request body. Throws on anything unusable. */
export function parseRelationshipRequest(body: unknown): RelationshipRequest {
	if (!body || typeof body !== 'object') {
		throw new RelationshipRequestError('body must be a JSON object');
	}
	const b = body as Record<string, unknown>;
	// Reject unknown top-level keys rather than ignoring them: a misspelled
	// `kinds:` or `options` nested one level too deep would otherwise be
	// silently dropped and the caller would get a preview of something it did
	// not ask for.
	const KNOWN = ['from', 'to', 'kind', 'options'];
	const unknown = Object.keys(b).filter((k) => !KNOWN.includes(k));
	if (unknown.length > 0) {
		throw new RelationshipRequestError(
			`unknown key${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => `'${k}'`).join(', ')} — expected ${KNOWN.join(', ')}`,
		);
	}
	const from = b.from;
	const to = b.to;
	const kind = b.kind;
	if (typeof from !== 'string' || from.length === 0) {
		throw new RelationshipRequestError('`from` is required');
	}
	if (typeof to !== 'string' || to.length === 0) {
		throw new RelationshipRequestError('`to` is required');
	}
	if (typeof kind !== 'string' || !KINDS.includes(kind as RelationshipKind)) {
		throw new RelationshipRequestError(`\`kind\` must be one of ${KINDS.join(', ')}`);
	}
	const options = (b.options ?? {}) as RelationshipOptions;
	if (typeof options !== 'object' || options === null || Array.isArray(options)) {
		throw new RelationshipRequestError('`options` must be an object');
	}
	return { from, to, kind: kind as RelationshipKind, options };
}

/** The entity YAML defining `name`, or null when the project has none. */
function entityFile(projectDir: string, name: string): string | null {
	const match = listFiles(projectDir).find((f) => f.kind === 'entity' && f.name === name);
	return match ? resolveProjectPath(projectDir, match.path) : null;
}

function requireEntityFile(projectDir: string, name: string): string {
	const file = entityFile(projectDir, name);
	if (!file) {
		throw new RelationshipRequestError(`No entity named '${name}' in this project`);
	}
	return file;
}

/** `account` → `account_id`. The FK column convention entity YAML uses. */
function foreignKeyFor(target: string): string {
	return `${target}_id`;
}

/**
 * Add one relationship to an entity document, in place.
 *
 * Returns false when a relationship of that name already exists — Studio
 * refuses to silently redefine an authored link.
 */
function addRelationship(
	doc: Document,
	relName: string,
	value: Record<string, unknown>,
): boolean {
	if (!doc.has('entity')) {
		throw new RelationshipRequestError('entity YAML has no top-level `entity:` key');
	}
	// `relationships:` is a TOP-LEVEL sibling of `entity:`, not a key inside it
	// (EntityDefinitionSchema).
	const existing = doc.getIn(['relationships', relName]);
	if (existing !== undefined) return false;
	doc.setIn(['relationships', relName], doc.createNode(value));
	return true;
}

function editedEntity(
	projectDir: string,
	entityName: string,
	relName: string,
	value: Record<string, unknown>,
): RelationshipPreviewFile {
	const file = requireEntityFile(projectDir, entityName);
	const doc = parseDocument(fs.readFileSync(file, 'utf-8'));
	if (doc.errors.length > 0) {
		throw new RelationshipRequestError(
			`${toProjectRelative(projectDir, file)} is not valid YAML: ${doc.errors[0].message}`,
		);
	}
	if (!addRelationship(doc, relName, value)) {
		throw new RelationshipRequestError(
			`'${entityName}' already declares a relationship named '${relName}'`,
		);
	}
	const content = doc.toString();
	// A preview must never propose a file the PUT would reject: run the same
	// schema the file surface runs, and fail here with the reason.
	const outcome = validateContent('entity', content);
	if (!outcome.ok) {
		throw new RelationshipRequestError(
			`the resulting ${entityName} YAML would be invalid: ${outcome.issues[0].message}`,
		);
	}
	return { path: toProjectRelative(projectDir, file), content };
}

/**
 * The base's discriminator field name and its kinds — `discriminatorKindsOf`, the generator's own resolver
 * (`src/schema/inheritance.ts`: literal `choices:`, or one hop of `choices_of: <entity>.<field>`), fed the base's
 * file and, for a `choices_of`, its owner's. `discriminator` is null for a base that declares none; `kinds` is null
 * when they do not resolve (the generator's own validation then speaks). There is no second reading of `choices_of`
 * here (RFC-0006 S6 R2).
 */
function baseKinds(
	projectDir: string,
	baseFile: string,
): { discriminator: string | null; kinds: string[] | null } {
	const base = parseDocument(fs.readFileSync(baseFile, 'utf-8')).toJSON() as Record<string, unknown> | null;
	const discriminator = base?.discriminator;
	if (!base || typeof discriminator !== 'string') return { discriminator: null, kinds: null };
	const definitions: Record<string, unknown>[] = [base];
	const field = (base.fields as Record<string, { choices_of?: unknown } | undefined> | undefined)?.[discriminator];
	if (typeof field?.choices_of === 'string') {
		const ownerFile = entityFile(projectDir, field.choices_of.split('.')[0] ?? '');
		if (ownerFile) {
			const owner = parseDocument(fs.readFileSync(ownerFile, 'utf-8')).toJSON() as Record<string, unknown> | null;
			if (owner) definitions.push(owner);
		}
	}
	const kinds = discriminatorKindsOf(
		base as Parameters<typeof discriminatorKindsOf>[0],
		definitions as unknown as Parameters<typeof discriminatorKindsOf>[1],
	);
	return { discriminator, kinds };
}

/**
 * `inherits:` on the CHILD (`from`), naming the base (`to`) — RFC-0006. It is a key of
 * the entity, not an entry of `relationships:`, so it does not go through
 * `addRelationship`. The short form when the kind value is the entity's own name; the
 * long form `{ base, as }` when `options.as` says otherwise. The single-file schema is the
 * judge (a child that declares its own `timestamps` is refused here, as it would be on a PUT).
 */
function inheritsEdit(
	projectDir: string,
	req: RelationshipRequest,
): RelationshipPreviewFile {
	if (req.from === req.to) {
		throw new RelationshipRequestError(`'${req.from}' cannot inherit itself`);
	}
	const baseFile = requireEntityFile(projectDir, req.to);
	const file = requireEntityFile(projectDir, req.from);
	const doc = parseDocument(fs.readFileSync(file, 'utf-8'));
	if (doc.errors.length > 0) {
		throw new RelationshipRequestError(
			`${toProjectRelative(projectDir, file)} is not valid YAML: ${doc.errors[0].message}`,
		);
	}
	if (doc.has('inherits')) {
		throw new RelationshipRequestError(`'${req.from}' already declares \`inherits:\``);
	}
	const as = req.options?.as?.trim();
	// The kind this child will be: `as`, else its own name. The base must list it (R1), so refuse here, naming the base,
	// rather than propose a file that fails at generation.
	const kind = as || req.from;
	const { discriminator, kinds } = baseKinds(projectDir, baseFile);
	if (discriminator === null) {
		throw new RelationshipRequestError(
			`'${req.to}' declares no \`discriminator:\`, so it cannot be inherited — add \`discriminator: <enum field>\` to ${toProjectRelative(projectDir, baseFile)} first`,
		);
	}
	if (kinds !== null && !kinds.includes(kind)) {
		throw new RelationshipRequestError(
			`'${req.to}' does not list '${kind}' among its kinds (${discriminator}: ${kinds.join(', ')})${as ? '' : " — set `as` to one of them, or add it to the base's choices"}`,
		);
	}
	const value = as && as !== req.from ? { base: req.to, as } : req.to;
	// `doc.setIn` APPENDS the key at the end of the mapping (after `fields:`, `relationships:`, …), which is where it lands;
	// the schema is key-order-free. The edit keeps every comment and the file's other keys where they were.
	doc.setIn(['inherits'], doc.createNode(value));
	const content = doc.toString();
	const outcome = validateContent('entity', content);
	if (!outcome.ok) {
		throw new RelationshipRequestError(
			`the resulting ${req.from} YAML would be invalid: ${outcome.issues[0].message}`,
		);
	}
	return { path: toProjectRelative(projectDir, file), content };
}

/** The first-class relationship definition file for a `many_to_many`. */
function relationshipDefinitionFile(
	projectDir: string,
	req: RelationshipRequest,
): RelationshipPreviewFile {
	const name = req.options?.through ?? `${req.from}_${req.to}`;
	const dir = definitionDirs(projectDir).relationships;
	const file = path.join(dir, `${name}.yaml`);
	if (fs.existsSync(file)) {
		throw new RelationshipRequestError(
			`${toProjectRelative(projectDir, file)} already exists — edit it instead`,
		);
	}
	// Both endpoints must be real entities, or the definition is dead on arrival.
	requireEntityFile(projectDir, req.from);
	requireEntityFile(projectDir, req.to);

	const relationship: Record<string, unknown> = {
		name,
		// `table:` is written explicitly, never left to the schema default.
		// That default is `${name}s`, which for `contact_opportunity` yields
		// `contact_opportunitys` — and the table name drives the emitted module
		// folder, so the default would put a misspelled directory in the diff.
		// Every checked-in relationship fixture in this repo writes `table:` for
		// the same reason (#698). The default itself is tracked in #700.
		table: pluralize(name),
		from: req.from,
		to: req.to,
	};
	// `types`, `temporal` and `sourced` are omitted when unset so the schema's
	// own defaults apply, rather than baking today's defaults into the file.
	if (req.options?.types && req.options.types.length > 0) {
		relationship.types = req.options.types;
	}
	if (req.options?.temporal !== undefined) relationship.temporal = req.options.temporal;
	if (req.options?.sourced !== undefined) relationship.sourced = req.options.sourced;

	const content =
		`# Generated by codegen studio.\n` +
		stringifyYaml({ relationship }, { lineWidth: 0 });
	const outcome = validateContent('relationship', content);
	if (!outcome.ok) {
		throw new RelationshipRequestError(
			`the resulting relationship YAML would be invalid: ${outcome.issues[0].message}`,
		);
	}
	return { path: toProjectRelative(projectDir, file), content };
}

/**
 * The complete post-edit content of every file this request would write.
 * Pure: reads the project, writes nothing.
 */
export function previewRelationship(
	projectDir: string,
	req: RelationshipRequest,
): RelationshipPreviewFile[] {
	const opts = req.options ?? {};

	if (req.kind === 'many_to_many') {
		return [relationshipDefinitionFile(projectDir, req)];
	}

	if (req.kind === 'inherits') {
		return [inheritsEdit(projectDir, req)];
	}

	const files: RelationshipPreviewFile[] = [];

	if (req.kind === 'belongs_to') {
		const relName = opts.name ?? req.to;
		const value: Record<string, unknown> = {
			type: 'belongs_to',
			target: req.to,
			foreign_key: foreignKeyFor(req.to),
		};
		// RelationshipSchema is `.strict()` and spells this `nullable`, not
		// `required` — the wire option is the UI's word, the YAML key is the
		// schema's.
		if (opts.required !== undefined) value.nullable = !opts.required;
		if (opts.onDelete !== undefined) value.on_delete = opts.onDelete;
		if (opts.inverse !== undefined) value.inverse = opts.inverse;
		files.push(editedEntity(projectDir, req.from, relName, value));

		// The reverse accessor is a real relationship on the TARGET entity, so
		// it is a second edited file — not a key on the first one.
		if (opts.inverse) {
			files.push(
				editedEntity(projectDir, req.to, opts.inverse, {
					type: 'has_many',
					target: req.from,
					foreign_key: foreignKeyFor(req.to),
				}),
			);
		}
		return files;
	}

	// has_many / has_one live on the FROM entity and point back through the
	// TARGET's FK to this entity.
	const relName = opts.name ?? req.to;
	const value: Record<string, unknown> = {
		type: req.kind,
		target: req.to,
		foreign_key: foreignKeyFor(req.from),
	};
	if (opts.inverse !== undefined) value.inverse = opts.inverse;
	files.push(editedEntity(projectDir, req.from, relName, value));
	return files;
}

/** Apply a previewed edit. Returns the project-relative paths written. */
export function writeRelationship(projectDir: string, req: RelationshipRequest): string[] {
	const preview = previewRelationship(projectDir, req);
	for (const file of preview) {
		const abs = resolveProjectPath(projectDir, file.path);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, file.content, 'utf-8');
	}
	return preview.map((f) => f.path);
}
