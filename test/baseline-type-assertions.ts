/**
 * Type-level assertions over the generated baseline tree, compiled by the
 * baseline typecheck (`test/tsconfig.baseline.json` includes this file, and
 * `test/run-test.ts` fails on any diagnostic outside the named #680
 * expectation).
 *
 * An output DTO is the row's shape for the keys it exposes: same keys, same
 * optionality, same types. dealbrain dogfood #20 — Zod 3 inferred a `json`
 * (`z.unknown()`) key as OPTIONAL, so `DealStateOutputDto['metadata']` was
 * `metadata?: unknown` while the row has `metadata: unknown`.
 */
import type { DealState } from '@gen/modules/deal-states/deal-state.entity';
import type { DealStateOutputDto } from '@gen/modules/deal-states/dto/deal-state-output.dto';

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

export type DealStateOutputIsTheRow = Assert<
	Equal<DealStateOutputDto, Pick<DealState, keyof DealStateOutputDto>>
>;
