/**
 * Unit tests for `test/smoke/_consumer-errors.ts` (DRZ-2, #584 / #576).
 *
 * This function decides what a smoke gate fails on. The filter it replaced was
 * wrong for four years of commits in a way nothing tested: it matched the error
 * MESSAGE, so `Cannot find module '../x'` in generated code could never fail a
 * smoke. These tests pin the distinction — location-scoped, never
 * message-scoped — so the defect cannot come back.
 */
import { describe, it, expect } from 'bun:test';
import { consumerErrors } from '../../../test/smoke/_consumer-errors';

const E = (s: string) => s;

describe('consumerErrors — keeps diagnostics located in the generated project', () => {
	it('keeps an unresolved RELATIVE import in generated code (#576, the whole point)', () => {
		const out = E(
			"src/shared/subsystems/events/generated/bus.ts(7,38): error TS2307: Cannot find module '../events-errors' or its corresponding type declarations.",
		);
		expect(consumerErrors(out)).toHaveLength(1);
	});

	it('keeps a diagnostic whose MESSAGE mentions node_modules', () => {
		const out = E(
			"src/main.ts(115,27): error TS2345: Argument of type 'import(\"/tmp/x/node_modules/@nestjs/common/i\").INestApplication' is not assignable.",
		);
		expect(consumerErrors(out)).toHaveLength(1);
	});

	it('keeps a diagnostic in a .schema.ts file', () => {
		const out = E(
			"src/modules/accounts/account.entity.schema.ts(3,1): error TS2322: Type 'x' is not assignable to type 'y'.",
		);
		expect(consumerErrors(out)).toHaveLength(1);
	});

	it.each([
		["Property 'table' in type 'AccountRepository' is not assignable to the same property in base type 'BaseRepository'."],
		['Cannot assign an abstract constructor type to a non-abstract constructor type.'],
		["Property 'findByUserId' does not exist on type 'ContactService'."],
		["Cannot find module '@pattern-stack/codegen/runtime/subsystems/jobs/index' or its corresponding type declarations."],
	])('keeps a previously message-filtered error class: %s', (message) => {
		const out = E(`src/modules/x/x.ts(1,1): error TS2416: ${message}`);
		expect(consumerErrors(out)).toHaveLength(1);
	});

	it('keeps an unlocated whole-program diagnostic', () => {
		const out = E("error TS18003: No inputs were found in config file 'tsconfig.json'.");
		expect(consumerErrors(out)).toHaveLength(1);
	});

	it('attaches tsc elaboration lines to their diagnostic without double-counting', () => {
		const out = [
			"src/modules/accounts/account.repository.ts(45,12): error TS2416: Property 'table' is not assignable.",
			"  Type 'PgTableWithColumns<{ name: \"accounts\" }>' is not assignable to type 'PgTableWithColumns<TableConfig>'.",
			"    Index signature for type 'string' is missing.",
		].join('\n');
		const errors = consumerErrors(out);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('Index signature');
		expect(errors[0].split('\n')).toHaveLength(3);
	});
});

describe('consumerErrors — drops diagnostics located outside the generated project', () => {
	it('drops a diagnostic located above the project root', () => {
		const out = E(
			"../../runtime/base-classes/base-repository.ts(115,42): error TS2769: No overload matches this call.",
		);
		expect(consumerErrors(out)).toEqual([]);
	});

	it('drops a diagnostic located inside node_modules', () => {
		const out = E(
			"node_modules/drizzle-orm/pg-core/table.d.ts(21,1): error TS2344: Type constraint not satisfied.",
		);
		expect(consumerErrors(out)).toEqual([]);
	});

	it('drops a nested node_modules location', () => {
		const out = E(
			"src/x/node_modules/pkg/index.d.ts(1,1): error TS2304: Cannot find name 'Foo'.",
		);
		expect(consumerErrors(out)).toEqual([]);
	});

	it('drops the elaboration lines of a dropped diagnostic too', () => {
		const out = [
			'../../runtime/base-classes/base-repository.ts(115,42): error TS2769: No overload matches this call.',
			"  Overload 1 of 2 gave the following error.",
			"src/modules/x/x.ts(1,1): error TS2307: Cannot find module './y'.",
			"  Did you mean './z'?",
		].join('\n');
		const errors = consumerErrors(out);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('src/modules/x/x.ts');
		expect(errors[0]).toContain("Did you mean");
		expect(errors[0]).not.toContain('Overload 1 of 2');
	});

	it('ignores non-error output (build progress, blank lines)', () => {
		const out = ['', 'Files:  120', 'Lines: 40000', ''].join('\n');
		expect(consumerErrors(out)).toEqual([]);
	});
});

describe('consumerErrors — absolute locations and the optional projectDir', () => {
	// test/smoke-integration compiles the generated tree against THIS repo's
	// runtime + surface sources through tsconfig `paths`, so tsc can report an
	// absolute location that the `../` rule never sees (GATE-2 / #604).
	const project = '/tmp/codegen-integ-tsc-abc123';

	it('drops an absolute location outside the project when projectDir is given', () => {
		const out = `/root/codegen-patterns/runtime/base-classes/base-repository.ts(115,42): error TS2769: No overload matches this call.`;
		expect(consumerErrors(out, project)).toEqual([]);
	});

	it('keeps an absolute location INSIDE the project', () => {
		const out = `${project}/src/modules/x/x.ts(1,1): error TS2307: Cannot find module './y'.`;
		expect(consumerErrors(out, project)).toHaveLength(1);
	});

	it('does not treat a sibling directory with a shared prefix as inside', () => {
		const out = `${project}-other/src/x.ts(1,1): error TS2307: Cannot find module './y'.`;
		expect(consumerErrors(out, project)).toEqual([]);
	});

	it('tolerates a trailing slash on projectDir', () => {
		const out = `${project}/src/x.ts(1,1): error TS2307: Cannot find module './y'.`;
		expect(consumerErrors(out, `${project}/`)).toHaveLength(1);
	});

	it('KEEPS an absolute location when projectDir is omitted — never a silent pass', () => {
		// Without projectDir we cannot know whether the file is ours. I9: the
		// failure mode to avoid is the gate that passes quietly.
		const out = '/somewhere/else/x.ts(1,1): error TS2307: Cannot find module y.';
		expect(consumerErrors(out)).toHaveLength(1);
	});

	it('still drops node_modules and ../ locations when projectDir is given', () => {
		const out = [
			`${project}/node_modules/pkg/index.d.ts(1,1): error TS2304: Cannot find name 'Foo'.`,
			'../../runtime/x.ts(1,1): error TS2769: No overload matches this call.',
		].join('\n');
		expect(consumerErrors(out, project)).toEqual([]);
	});
});
