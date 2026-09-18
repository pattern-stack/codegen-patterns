/**
 * ADR-041.1 / CAP-3 — the library `Actor` and `Communication` capabilities.
 */
import { describe, expect, test } from 'bun:test';

import '../../patterns/index.ts';
import { ActorPattern, ActorPatternConfigSchema } from '../../patterns/library/actor.pattern.ts';
import { CommunicationPattern } from '../../patterns/library/communication.pattern.ts';
import { getPattern } from '../../patterns/registry.ts';
import { isCapabilityPattern } from '../../patterns/pattern-definition.ts';
import { ACTOR_CAPABILITY, COMMUNICATION_CAPABILITY } from '../../roles/derive.ts';

describe('library Actor / Communication', () => {
	test('registered under the CAP-2 names, as capabilities', () => {
		for (const [name, def] of [
			[ACTOR_CAPABILITY, ActorPattern],
			[COMMUNICATION_CAPABILITY, CommunicationPattern],
		] as const) {
			const registered = getPattern(name);
			expect(registered).toBe(def);
			expect(registered && isCapabilityPattern(registered)).toBe(true);
		}
	});

	test('mixins are library-shipped under @shared/base-classes (rewritten per runtime mode)', () => {
		expect(ActorPattern.mixin).toBe('WithActor');
		expect(ActorPattern.mixinImport).toBe('@shared/base-classes/with-actor');
		expect(CommunicationPattern.mixin).toBe('WithCommunication');
		expect(CommunicationPattern.mixinImport).toBe('@shared/base-classes/with-communication');
	});

	test('Communication forwards findByRole + participants; Actor forwards nothing', () => {
		expect(CommunicationPattern.forwarderMethods).toEqual(['findByRole', 'participants']);
		expect(ActorPattern.forwarderMethods).toBeUndefined();
	});

	test('Communication has no author config — its config is generated from roles:', () => {
		expect(CommunicationPattern.configSchema).toBeUndefined();
	});
});

describe('ActorPatternConfigSchema', () => {
	test('individual', () => {
		expect(ActorPatternConfigSchema.safeParse({ kind: 'individual' }).success).toBe(true);
	});

	test('group requires members', () => {
		expect(ActorPatternConfigSchema.safeParse({ kind: 'group', members: 'contacts' }).success).toBe(true);
		expect(ActorPatternConfigSchema.safeParse({ kind: 'group' }).success).toBe(false);
	});

	test('members on an individual is rejected, not ignored', () => {
		expect(ActorPatternConfigSchema.safeParse({ kind: 'individual', members: 'x' }).success).toBe(false);
	});

	test('kind is required and closed', () => {
		expect(ActorPatternConfigSchema.safeParse({}).success).toBe(false);
		expect(ActorPatternConfigSchema.safeParse({ kind: 'team' }).success).toBe(false);
	});
});
