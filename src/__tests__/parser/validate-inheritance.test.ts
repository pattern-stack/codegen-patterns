/**
 * RFC-0006 cross-entity rules (#875, slice S1) — `validateInheritance`.
 *
 * The fixture family (test/fixtures/inheritance/entities, RFC §13.1) is loaded
 * through the real loader and must validate clean. Every other case is that
 * family with ONE line changed, asserting the message names the entities and
 * fields involved. Rule numbers are the RFC's.
 */

import { describe, expect, it } from 'bun:test';

import { validateInheritance } from '../../parser/validate-inheritance';
import { familyWith, loadFamily, type Mutations } from './inheritance-family';

function errorsFor(mutations: Mutations) {
	return validateInheritance(familyWith(mutations)).filter((i) => i.severity === 'error');
}

/**
 * The messages a case produces, joined. One change can break more than one
 * rule (a lookup enum that stops being shared also fails the participant that
 * matches it), so a case asserts the message it is about is present — and that
 * the family stops being clean, which `errors.length > 0` states.
 */
function only(mutations: Mutations): string {
	const errors = errorsFor(mutations);
	expect(errors.length).toBeGreaterThan(0);
	return errors.map((e) => e.message).join('\n');
}

describe('the fixture family', () => {
	it('validates clean through the real loader', () => {
		expect(validateInheritance(loadFamily())).toEqual([]);
	});

	it('contains both bases, three children and the match-only entities', () => {
		const names = loadFamily().map((e) => e.definition.entity.name).sort();
		expect(names).toEqual([
			'communication',
			'communication_participant',
			'communication_participant_role',
			'communication_part',
			'email',
			'email_communication_part',
			'email_thread',
			'meeting',
			'meeting_transcript',
			'person',
			'transcript_communication_part',
		].sort());
	});
});

describe('R1 — discriminator and choices_of', () => {
	it('R1: a child whose base declares no discriminator', () => {
		const msg = only({ communication: (r) => delete r.discriminator });
		// meeting, email and the parts' base are unaffected; both children of communication fail.
		expect(msg).toContain('R1');
	});

	it('R1: a child of a base without discriminator names both entities', () => {
		const errors = errorsFor({ communication: (r) => delete r.discriminator });
		const messages = errors.map((e) => e.message).join('\n');
		expect(messages).toContain("'meeting' inherits 'communication'");
		expect(messages).toContain("'email' inherits 'communication'");
	});

	it('R1: choices_of naming an entity that does not exist', () => {
		const msg = only({
			communication_participant_role: (r) => {
				r.fields.kind.choices_of = 'nowhere.kind';
			},
		});
		expect(msg).toContain("'communication_participant_role.kind'");
		expect(msg).toContain("there is no entity 'nowhere'");
	});

	it('R1: choices_of naming a field the owner does not declare', () => {
		const msg = only({
			communication_participant_role: (r) => {
				r.fields.kind.choices_of = 'communication.missing';
			},
		});
		expect(msg).toContain("'communication' declares no field 'missing'");
	});

	it('R1: choices_of naming a field that is not an enum', () => {
		const msg = only({
			communication_participant_role: (r) => {
				r.fields.kind.choices_of = 'communication.source';
			},
		});
		expect(msg).toContain("'communication.source' is 'type: string', not an enum");
	});

	it('R1: choices_of does not chain through another choices_of', () => {
		const errors = errorsFor({
			communication_participant_role: (r) => {
				r.fields.kind.choices_of = 'communication_part.kind';
			},
		});
		const msg = errors.map((e) => e.message).join('\n');
		expect(msg).toContain("'communication_part.kind' must declare literal 'choices:'");
		expect(msg).toContain('does not chain');
	});

	it('R1: choices_of may not name the entity itself', () => {
		const msg = only({
			communication_participant_role: (r) => {
				r.fields.kind.choices_of = 'communication_participant_role.role';
			},
		});
		expect(msg).toContain("'communication_participant_role.kind'");
		expect(msg).toContain("entity's own field");
	});

	it('R1: a discriminator whose choices come from choices_of resolves to the referenced list', () => {
		// communication_part.kind is choices_of: communication.kind; the child's `as: meeting` is checked against it.
		expect(validateInheritance(loadFamily())).toEqual([]);
		const msg = only({
			transcript_communication_part: (r) => {
				r.inherits = { base: 'communication_part', as: 'voicemail' };
			},
		});
		expect(msg).toContain("no choice 'voicemail'");
		expect(msg).toContain('meeting, email, message');
	});
});

describe('R2 — one child per choice; `as:` is a choice', () => {
	it('R2: `as:` names a value the base does not list', () => {
		const msg = only({ meeting: (r) => (r.inherits = { base: 'communication', as: 'call' }) });
		expect(msg).toContain('R2');
		expect(msg).toContain("'meeting'");
		expect(msg).toContain("'communication.kind'");
		expect(msg).toContain("no choice 'call'");
	});

	it('R2: two children of one kind', () => {
		const msg = only({
			email: (r) => (r.inherits = { base: 'communication', as: 'meeting' }),
		});
		expect(msg).toContain('R2');
		expect(msg).toContain("'email'");
		expect(msg).toContain("'meeting'");
		expect(msg).toContain("both the 'meeting' kind of 'communication'");
	});

	it('R2: a choice with no child is a base-only kind and is fine (message)', () => {
		expect(validateInheritance(loadFamily())).toEqual([]);
	});
});

describe('R3 — one level', () => {
	it('R3: a child cannot be a base', () => {
		const msg = only({
			meeting_transcript: (r) => {
				r.inherits = 'meeting';
			},
		});
		expect(msg).toContain('R3');
		expect(msg).toContain("'meeting_transcript' inherits 'meeting'");
		expect(msg).toContain("which itself inherits 'communication'");
	});

	it('R3: inheriting an entity that does not exist names it', () => {
		const msg = only({ meeting: (r) => (r.inherits = 'conversation') });
		expect(msg).toContain("'meeting' inherits 'conversation'");
		expect(msg).toContain('no entity');
	});

	it('R3: an entity cannot inherit itself', () => {
		expect(only({ meeting: (r) => (r.inherits = 'meeting') })).toContain("'meeting' inherits itself");
	});
});

describe('R4 — no name on both tables', () => {
	it('R4: a child field that the base declares', () => {
		const msg = only({ meeting: (r) => (r.fields.source = { type: 'string', nullable: true }) });
		expect(msg).toContain('R4');
		expect(msg).toContain("'meeting' declares field 'source'");
		expect(msg).toContain("base 'communication'");
	});

	it('R4: a child FK column that the base declares', () => {
		const msg = only({
			communication: (r) => {
				r.fields.thread_id = { type: 'uuid', nullable: true };
			},
		});
		expect(msg).toContain("'email' declares foreign key 'thread_id'");
		expect(msg).toContain("'communication' declares field 'thread_id'");
	});

	it('R4: a child relation key that the base declares', () => {
		const msg = only({
			communication: (r) => {
				r.relationships = { transcripts: { type: 'has_many', target: 'meeting_transcript', foreign_key: 'meeting_id' } };
			},
		});
		expect(msg).toContain("'meeting' declares relationship 'transcripts'");
		expect(msg).toContain("'communication' declares relationship 'transcripts'");
	});

	it('R4: a child that redeclares the base discriminator or a behavior column', () => {
		const discriminator = only({ meeting: (r) => (r.fields.kind = { type: 'string', nullable: true }) });
		expect(discriminator).toContain("'meeting' declares field 'kind'");
		const behavior = only({ meeting: (r) => (r.fields.created_at = { type: 'datetime', nullable: true }) });
		expect(behavior).toContain("'meeting' declares field 'created_at'");
		expect(behavior).toContain("'timestamps' behavior");
	});

	it('R4: the reverse — a base declaring what a child declares', () => {
		const msg = only({ communication: (r) => (r.fields.title = { type: 'string', nullable: true }) });
		expect(msg).toContain("'meeting' declares field 'title'");
		expect(msg).toContain("'communication' declares field 'title'");
	});

	it("R4: a child field named after the relation the generator adds to its base", () => {
		const msg = only({ meeting: (r) => (r.fields.communication = { type: 'string', nullable: true }) });
		expect(msg).toContain("'meeting' declares field 'communication'");
		expect(msg).toContain("relation to its base 'communication'");
	});

	it("R4: a base field named after the relation the generator adds to a child", () => {
		const msg = only({ communication: (r) => (r.fields.meeting = { type: 'string', nullable: true }) });
		expect(msg).toContain("'communication' declares field 'meeting'");
		expect(msg).toContain("relation to its child 'meeting'");
	});
});

describe('R6 — a child declares a pattern only over its own columns', () => {
	it('R6: pattern config naming a base column', () => {
		const msg = only({
			meeting: (r) => {
				r.entity.patterns = ['Activity'];
				r.entity.config = { Activity: { occurredAt: 'created_at' } };
			},
		});
		expect(msg).toContain('R6');
		expect(msg).toContain("'meeting' configures pattern 'Activity' with 'created_at'");
		expect(msg).toContain("'communication'");
	});

	it('R6: Activity on a child reads occurred_at, which the base owns', () => {
		const msg = only({ meeting: (r) => (r.entity.patterns = ['Activity']) });
		expect(msg).toContain("'meeting' declares pattern 'Activity'");
		expect(msg).toContain("'occurred_at'");
		expect(msg).toContain("'communication'");
	});

	it('R6: Activity on a child over its own column is fine', () => {
		const errors = errorsFor({
			meeting: (r) => {
				r.entity.patterns = ['Activity'];
				r.entity.config = { Activity: { occurredAt: 'starts_at' } };
			},
		});
		expect(errors).toEqual([]);
	});
});

describe('R7 — a child query names only its own columns', () => {
	it('R7: a finder by a base column', () => {
		const msg = only({ meeting: (r) => (r.queries = [{ by: ['source'] }]) });
		expect(msg).toContain('R7');
		expect(msg).toContain("query on 'meeting' names 'source'");
		expect(msg).toContain("base 'communication'");
	});

	it('R7: an order by a base column', () => {
		const msg = only({ meeting: (r) => (r.queries = [{ by: ['title'], order: 'occurred_at desc' }]) });
		expect(msg).toContain("'occurred_at'");
	});

	it('R7: a finder by its own column is fine', () => {
		expect(errorsFor({ meeting: (r) => (r.queries = [{ by: ['title'] }]) })).toEqual([]);
	});
});

describe('R8 — one sync mode per family', () => {
	it('R8: a child that differs from its base', () => {
		const msg = only({
			communication: (r) => (r.entity.sync = 'electric'),
			meeting: (r) => (r.entity.sync = 'api'),
			email: (r) => (r.entity.sync = 'electric'),
		});
		expect(msg).toContain('R8');
		expect(msg).toContain("'meeting'");
		expect(msg).toContain("base 'communication'");
		expect(msg).toContain("'api'");
		expect(msg).toContain("'electric'");
	});

	it('R8: a declared mode on one side only', () => {
		const messages = errorsFor({ communication: (r) => (r.entity.sync = 'electric') }).map((e) => e.message);
		expect(messages.length).toBe(2); // meeting and email
		expect(messages[0]).toContain('undeclared');
	});

	it('R8: the same mode on every member is fine', () => {
		const all = (r: { entity: { sync?: string } }) => (r.entity.sync = 'electric');
		expect(errorsFor({ communication: all, meeting: all, email: all })).toEqual([]);
	});
});

describe('R10 — a tenant_scoped base declares its tenant column NOT NULL', () => {
	it('R10: the tenant column is not declared (it would be emitted nullable)', () => {
		const msg = only({ communication: (r) => delete r.fields.tenant_id });
		expect(msg).toContain('R10');
		expect(msg).toContain("'communication' is tenant_scoped but does not declare its tenant column 'tenant_id'");
	});

	it('R10: the tenant column is declared nullable', () => {
		const msg = only({ communication: (r) => (r.fields.tenant_id = { type: 'uuid', nullable: true }) });
		expect(msg).toContain("'communication' declares its tenant column 'tenant_id' as nullable");
	});

	it('R10: the tenant column is adopted from a nullable belongs_to', () => {
		const msg = only({
			communication: (r) => {
				delete r.fields.tenant_id;
				r.relationships = { tenant: { type: 'belongs_to', target: 'person', foreign_key: 'tenant_id', nullable: true } };
			},
		});
		expect(msg).toContain("adopts 'tenant_id' from its belongs_to 'tenant'");
		expect(msg).toContain('nullable');
	});

	it('R10: a NOT NULL belongs_to is accepted', () => {
		expect(
			errorsFor({
				communication: (r) => {
					delete r.fields.tenant_id;
					r.relationships = { tenant: { type: 'belongs_to', target: 'person', foreign_key: 'tenant_id' } };
				},
			}),
		).toEqual([]);
	});

	it('R10: a base that is not tenant_scoped is not checked', () => {
		expect(
			errorsFor({
				communication: (r) => {
					delete r.tenant_scoped;
					delete r.fields.tenant_id;
				},
			}),
		).toEqual([]);
	});
});

describe('M1 — match: targets', () => {
	it('M1: a target column the target does not declare', () => {
		const msg = only({
			communication_part: (r) => (r.relationships.communication.match = { kind: 'category' }),
		});
		expect(msg).toContain('M1');
		expect(msg).toContain("'communication_part.communication' (match → 'communication')");
		expect(msg).toContain("'communication' declares no field or foreign key column 'category'");
	});

	it('M1: a nullable target column', () => {
		const msg = only({
			communication_participant_role: (r) => (r.fields.kind.required = false),
		});
		// the lookup's kind is now nullable: the role FK's target column must be NOT NULL.
		expect(msg).toContain('M1');
		expect(msg).toContain("'communication_participant_role.kind' is nullable");
	});

	it('M1: the shorthand list matches same-name columns', () => {
		const errors = errorsFor({
			communication_part: (r) => (r.relationships.communication.match = ['kind']),
		});
		expect(errors).toEqual([]);
	});

	it('M1: the shorthand list names a column the target lacks', () => {
		const msg = only({ communication_part: (r) => (r.relationships.communication.match = ['revision']) });
		expect(msg).toContain("declares no field or foreign key column 'revision'");
	});
});

describe('M2 — the local column is derived, except the discriminator', () => {
	it('M2: the local column is already a declared field', () => {
		const msg = only({
			communication_participant: (r) => (r.fields.communication_kind = { type: 'string', required: true }),
		});
		expect(msg).toContain('M2');
		expect(msg).toContain("'communication_participant.communication'");
		expect(msg).toContain("local column 'communication_kind'");
	});
	// (the same field is matched by both relationships, so both report it)
	it('M2: the local column is a foreign key column', () => {
		const messages = errorsFor({
			communication_participant: (r) => (r.relationships.communication.match = { person_id: 'kind' }),
		}).map((e) => e.message);
		expect(messages.join('\n')).toContain("local column 'person_id'");
	});

	it('M2: the local column collides with a behavior column', () => {
		const messages = errorsFor({
			communication_participant: (r) => {
				r.behaviors = ['timestamps'];
				r.relationships.communication.match = { created_at: 'kind' };
			},
		}).map((e) => e.message);
		expect(messages.join('\n')).toContain("local column 'created_at'");
		expect(messages.join('\n')).toContain("'timestamps' behavior");
	});

	it('M2 exception, allowed: the entity discriminator whose enum is the target column (choices_of)', () => {
		// communication_part.kind is the discriminator, choices_of: communication.kind, matched on `kind`.
		expect(validateInheritance(loadFamily())).toEqual([]);
	});

	it('M2 exception, refused: the discriminator without the target column\'s enum', () => {
		const msg = only({
			communication_part: (r) => {
				r.fields.kind = { type: 'enum', choices: ['meeting', 'email', 'message'], required: true };
			},
		});
		expect(msg).toContain('M2');
		expect(msg).toContain("'communication_part.kind' is the discriminator, but its enum is not 'communication.kind'");
		expect(msg).toContain("'choices_of: communication.kind'");
	});

	it('M2 exception, refused: a field that is not the discriminator', () => {
		const msg = only({
			communication_part: (r) => {
				r.fields.revision = { type: 'enum', choices_of: 'communication.kind', required: true };
				r.relationships.communication.match = { revision: 'kind' };
			},
		});
		expect(msg).toContain('M2');
		expect(msg).toContain("local column 'revision'");
		expect(msg).toContain('own discriminator');
	});
});

describe('M3 — two relationships may match one column when the types agree', () => {
	it('M3: the same local column matched against columns of different types', () => {
		const msg = only({
			communication_participant: (r) => {
				// role.role is a string; communications.kind is an enum.
				r.relationships.role.match = { communication_kind: 'role' };
			},
		});
		expect(msg).toContain('M3');
		expect(msg).toContain("'communication_participant' matches the local column 'communication_kind'");
		expect(msg).toContain("'communication' → 'communication.kind'");
		expect(msg).toContain("'role' → 'communication_participant_role.role'");
	});

	it('M3: two relationships on one column with equal types is the §2.4 case 2 (clean)', () => {
		expect(validateInheritance(loadFamily())).toEqual([]);
	});
});

describe('M4 — a matched column is immutable', () => {
	it('M4: on_delete set_null would rewrite the matched column', () => {
		const msg = only({
			communication_participant: (r) => {
				r.relationships.role.on_delete = 'set_null';
				r.relationships.role.nullable = true;
			},
		});
		expect(msg).toContain('M4');
		expect(msg).toContain("'communication_participant.role' (match → 'communication_participant_role')");
		expect(msg).toContain('set_null');
	});
});

describe('M5 — one Postgres enum type on both sides', () => {
	it('M5: a lookup enum that is its own type, matched against the communication enum', () => {
		const msg = only({
			communication_participant_role: (r) => {
				r.fields.kind = { type: 'enum', choices: ['meeting', 'email', 'message'], required: true };
			},
		});
		expect(msg).toContain('M5');
		expect(msg).toContain("'communication_participant'");
		expect(msg).toContain("'communication.kind'");
		expect(msg).toContain("'communication_participant_role.kind'");
		expect(msg).toContain('one Postgres type');
	});

	it('M5: a discriminator whose choices_of names a different enum than the match target', () => {
		const msg = only({
			communication_part: (r) => {
				r.fields.kind = { type: 'enum', choices_of: 'communication_participant_role.kind', required: true };
			},
			communication_participant_role: (r) => {
				r.fields.kind = { type: 'enum', choices: ['meeting', 'email', 'message'], required: true };
			},
		});
		expect(msg).toContain('M5');
		expect(msg).toContain("'communication_part.kind'");
		expect(msg).toContain("'communication_participant_role.kind'");
		expect(msg).toContain("'communication.kind'");
	});
});
