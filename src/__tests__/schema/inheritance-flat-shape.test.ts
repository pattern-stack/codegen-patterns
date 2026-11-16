/**
 * RFC-0006 S7a — the one owner of a joined-table child's flat shape (`flatChildShape`, with its two views
 * `flattenInheritedChild` and `flatChildOwners`), on the integrated family (test/fixtures/integrated-child/entities).
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { EntityDefinitionSchema, type EntityDefinition } from '../../schema/entity-definition.schema';
import { flatChildOwners, flatChildShape, flattenInheritedChild } from '../../schema/inheritance';

const DIR = join(import.meta.dir, '../../../test/fixtures/integrated-child/entities');
// biome-ignore lint/suspicious/noExplicitAny: raw YAML
const rawOf = (name: string): Record<string, any> => parseYaml(readFileSync(join(DIR, `${name}.yaml`), 'utf8'));
const defOf = (name: string): EntityDefinition => EntityDefinitionSchema.parse(rawOf(name));
const family = ['inbox_item', 'mail_message', 'calendar_event', 'mailbox'].map(defOf);
const [inbox, mail, calendar, mailbox] = family as [EntityDefinition, EntityDefinition, EntityDefinition, EntityDefinition];

describe('flattenInheritedChild', () => {
	it('mail_message flattens to what a flat declaration of the same columns parses to', () => {
		const child = rawOf('mail_message');
		const base = rawOf('inbox_item');
		const { kind: _kind, ...baseFields } = base.fields;
		const { inherits: _inherits, ...own } = child;
		const flat = EntityDefinitionSchema.parse({
			...own,
			tenant_scoped: base.tenant_scoped,
			behaviors: base.behaviors,
			fields: { ...baseFields, ...child.fields },
			relationships: base.relationships,
		});
		expect(flattenInheritedChild(mail, family)).toEqual(flat);
	});

	it('keeps no inherits: key and no discriminator, and reads the base from the set it is given', () => {
		const flat = flattenInheritedChild(calendar, family);
		expect('inherits' in flat).toBe(false);
		expect(Object.keys(flat.fields)).toEqual(['tenant_id', 'title', 'preview', 'starts_at', 'ends_at']);
		expect(flat.tenant_scoped).toBe(true);
		expect(flat.behaviors).toEqual(['timestamps', 'soft_delete', 'external_id_tracking']);
	});

	it('a non-child, and a child whose base is not in the set, come back unchanged', () => {
		expect(flattenInheritedChild(inbox, family)).toBe(inbox);
		expect(flattenInheritedChild(mailbox, family)).toBe(mailbox);
		expect(flattenInheritedChild(mail, [mail])).toBe(mail);
	});
});

describe('flatChildOwners — the same walk, as owners', () => {
	it('names the declaring entity of each field', () => {
		expect(flatChildOwners(mail, family)).toEqual({
			base: 'inbox_item',
			fields: { tenant_id: 'inbox_item', title: 'inbox_item', preview: 'inbox_item', subject: 'mail_message', sent_at: 'mail_message' },
			relationships: { mailbox: 'inbox_item' },
		});
	});

	it("a base belongs_to appears under the child, owned by the base", () => {
		const shape = flatChildShape(calendar, family);
		const rel = shape?.relationships.find((r) => r.name === 'mailbox');
		expect(rel?.owner).toBe('inbox_item');
		expect(rel?.relationship.type).toBe('belongs_to');
		expect(flattenInheritedChild(calendar, family).relationships?.mailbox).toEqual(rel?.relationship);
	});

	it('the discriminator is in neither view', () => {
		expect(flatChildOwners(mail, family)?.fields).not.toHaveProperty('kind');
	});

	it('is null for a non-child', () => {
		expect(flatChildOwners(inbox, family)).toBeNull();
		expect(flatChildShape(mailbox, family)).toBeNull();
	});
});
