/**
 * Schema validation on `PUT /api/files/:path` (STUDIO-0, #698).
 *
 * The contract is that a write is validated BEFORE it touches disk, and that a
 * rejection carries real Zod issues — `path` and all, so the editor can put the
 * marker on the offending line. The loader in `src/utils/yaml-loader.ts`
 * flattens issues to strings, which is why this surface parses and validates
 * itself rather than going through it.
 */
import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
	UnknownFileKindError,
	kindForPath,
	listFiles,
	readFile,
	validateContent,
	writeFile,
} from '../../studio/server/files';
import { FileNotFoundError } from '../../studio/server/files';

const roots: string[] = [];

const VALID_ENTITY = `entity:
  name: contact
  plural: contacts
  table: contacts

fields:
  email:
    type: string
    required: true
`;

function makeProject(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-files-'));
	roots.push(root);
	fs.mkdirSync(path.join(root, 'entities'), { recursive: true });
	fs.mkdirSync(path.join(root, 'junctions'), { recursive: true });
	fs.mkdirSync(path.join(root, 'relationships'), { recursive: true });
	fs.writeFileSync(path.join(root, 'entities', 'contact.yaml'), VALID_ENTITY);
	fs.writeFileSync(path.join(root, 'codegen.config.yaml'), 'generate:\n  frontend: false\n');
	return root;
}

let projectDir: string;
beforeEach(() => {
	projectDir = makeProject();
});

afterAll(() => {
	for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

describe('listFiles', () => {
	it('lists the entity and the config, with the entity name from the YAML', () => {
		const files = listFiles(projectDir);
		const entity = files.find((f) => f.kind === 'entity');
		expect(entity).toEqual({ kind: 'entity', path: 'entities/contact.yaml', name: 'contact' });
		expect(files.some((f) => f.kind === 'config' && f.path === 'codegen.config.yaml')).toBe(true);
	});

	it('still lists a file whose YAML does not parse, under its file stem', () => {
		fs.writeFileSync(path.join(projectDir, 'entities', 'broken.yaml'), 'entity: [unclosed\n');
		const broken = listFiles(projectDir).find((f) => f.path === 'entities/broken.yaml');
		// Studio is how you go fix it — hiding it would hide the problem.
		expect(broken?.name).toBe('broken');
	});
});

describe('kindForPath — location decides the schema, not content', () => {
	it('classifies by directory', () => {
		expect(kindForPath(projectDir, 'entities/contact.yaml')).toBe('entity');
		expect(kindForPath(projectDir, 'junctions/x.yaml')).toBe('junction');
		expect(kindForPath(projectDir, 'relationships/x.yaml')).toBe('relationship');
		expect(kindForPath(projectDir, 'codegen.config.yaml')).toBe('config');
	});

	it('returns null for a file Studio does not own', () => {
		expect(kindForPath(projectDir, 'README.md')).toBeNull();
	});
});

describe('validateContent — entity', () => {
	it('accepts a valid entity', () => {
		expect(validateContent('entity', VALID_ENTITY)).toEqual({ ok: true });
	});

	it('reports a bad field type with the Zod path intact', () => {
		const bad = VALID_ENTITY.replace('type: string', 'type: strng');
		const outcome = validateContent('entity', bad);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error('unreachable');
		const issue = outcome.issues.find((i) => i.path.join('.') === 'fields.email.type');
		expect(issue).toBeDefined();
		expect(issue?.message).toContain('strng');
	});

	it('reports a missing required key', () => {
		const outcome = validateContent('entity', 'fields:\n  email:\n    type: string\n');
		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error('unreachable');
		expect(outcome.issues.some((i) => i.path.includes('entity'))).toBe(true);
	});

	it('reports a YAML SYNTAX error through the same channel, as one issue', () => {
		const outcome = validateContent('entity', 'entity:\n  name: [unclosed\n');
		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error('unreachable');
		expect(outcome.issues).toHaveLength(1);
		expect(outcome.issues[0].path).toEqual([]);
		expect(outcome.issues[0].code).toBe('custom');
		expect(outcome.issues[0].message.length).toBeGreaterThan(0);
	});
});

describe('writeFile', () => {
	it('writes valid content', () => {
		const next = VALID_ENTITY.replace('contacts\n', 'contacts\n  pattern: Integrated\n');
		expect(writeFile(projectDir, 'entities/contact.yaml', next)).toEqual({ ok: true });
		expect(fs.readFileSync(path.join(projectDir, 'entities', 'contact.yaml'), 'utf-8')).toBe(next);
	});

	it('does NOT touch disk when the content is invalid', () => {
		const before = fs.readFileSync(path.join(projectDir, 'entities', 'contact.yaml'), 'utf-8');
		const outcome = writeFile(
			projectDir,
			'entities/contact.yaml',
			VALID_ENTITY.replace('type: string', 'type: strng'),
		);
		expect(outcome.ok).toBe(false);
		expect(fs.readFileSync(path.join(projectDir, 'entities', 'contact.yaml'), 'utf-8')).toBe(before);
	});

	it('does NOT touch disk when the YAML does not parse', () => {
		const before = fs.readFileSync(path.join(projectDir, 'entities', 'contact.yaml'), 'utf-8');
		expect(writeFile(projectDir, 'entities/contact.yaml', 'entity: [unclosed\n').ok).toBe(false);
		expect(fs.readFileSync(path.join(projectDir, 'entities', 'contact.yaml'), 'utf-8')).toBe(before);
	});

	it('creates a new file in a directory that does not exist yet', () => {
		const rel = 'entities/crm/lead.yaml';
		const content = VALID_ENTITY.replace(/contact/g, 'lead').replace('leads\n', 'leads\n');
		expect(writeFile(projectDir, rel, content).ok).toBe(true);
		expect(fs.existsSync(path.join(projectDir, rel))).toBe(true);
	});

	it('refuses a file that is not a Studio surface', () => {
		expect(() => writeFile(projectDir, 'README.md', 'hi')).toThrow(UnknownFileKindError);
	});

	it('refuses a traversal instead of writing outside the project', () => {
		expect(() => writeFile(projectDir, '../escaped.yaml', VALID_ENTITY)).toThrow();
		expect(fs.existsSync(path.join(projectDir, '..', 'escaped.yaml'))).toBe(false);
	});
});

describe('readFile', () => {
	it('reads a listed file', () => {
		expect(readFile(projectDir, 'entities/contact.yaml').content).toBe(VALID_ENTITY);
	});

	it('throws FileNotFoundError for a missing file', () => {
		expect(() => readFile(projectDir, 'entities/nope.yaml')).toThrow(FileNotFoundError);
	});
});
