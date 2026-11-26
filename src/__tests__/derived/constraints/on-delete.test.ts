/** TGT-1: `onDeleteAction` is the one YAML `on_delete:` → SQL referential action mapping (entity + junction). */

import { describe, expect, it } from 'bun:test';
import { onDeleteAction } from '../../../derived/constraints/on-delete';

describe('onDeleteAction', () => {
	it.each([
		['restrict', 'restrict'],
		['cascade', 'cascade'],
		['set_null', 'set null'],
		['no_action', 'no action'],
	])('%s → %s', (yaml, sql) => {
		expect(onDeleteAction(yaml)).toBe(sql as ReturnType<typeof onDeleteAction>);
	});

	it('absent is restrict, the declared default', () => {
		expect(onDeleteAction(undefined)).toBe('restrict');
	});
});
