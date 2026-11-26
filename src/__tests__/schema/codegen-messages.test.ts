/**
 * ZOD-0: codegen's one message rule (`codegenMessages`, src/schema/zod.ts) names the value an enum refused, and it
 * stays codegen's: it is passed per parse, never installed with `z.config`, which Zod 4 keeps on `globalThis` for
 * every Zod 4 copy in the process (a consumer's pattern schemas included).
 */

import { describe, expect, it } from 'bun:test';
import { codegenMessages, z } from '../../schema/zod';

const kinds = z.enum(['string', 'integer']);
const messageOf = (input: unknown, withRule = true) =>
	kinds.safeParse(input, withRule ? { error: codegenMessages } : undefined).error?.issues[0]?.message;

describe('codegenMessages', () => {
	it('names the refused value', () => {
		expect(messageOf('strng')).toBe('Invalid option: expected one of "string"|"integer", received "strng"');
		expect(messageOf(3)).toContain(', received 3');
	});

	it('is per parse: without it, Zod\'s own message', () => {
		expect(messageOf('strng', false)).toBe('Invalid option: expected one of "string"|"integer"');
	});

	it('installs nothing global', () => {
		const shared = (globalThis as { __zod_globalConfig?: { customError?: unknown } }).__zod_globalConfig;
		expect(shared?.customError).toBeUndefined();
	});

	it('never throws on a value it cannot quote, such as a cyclic YAML alias', () => {
		const cyclic: unknown[] = [];
		cyclic.push(cyclic);
		expect(messageOf(cyclic)).toBe('Invalid option: expected one of "string"|"integer"');
	});

	it('leaves a schema\'s own message alone', () => {
		const own = z.enum(['a', 'b'], { error: 'pick a or b' });
		expect(own.safeParse('c', { error: codegenMessages }).error?.issues[0]?.message).toBe('pick a or b');
	});
});
