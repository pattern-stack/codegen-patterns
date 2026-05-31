# @pattern-stack/codegen-crm

The **L2 CRM surface package** for [`@pattern-stack/codegen`](https://www.npmjs.com/package/@pattern-stack/codegen).

A *surface package* ships the type-shaped **ports** and **DI tokens** for one
integration surface (here: CRM — `account`, `contact`, `opportunity`). The
code generator emits an L3 composing port (`CrmPort`) that injects these ports;
consumers implement them against a specific provider (Salesforce, HubSpot, …).
The full rationale — why surface vocabulary lives in a per-surface package
rather than in the codegen core — is in **[ADR-036 — Surface packages](../../docs/adrs/ADR-036-surface-packages.md)**.

## Layers

```
L1  @pattern-stack/codegen        — codegen subsystems (IChangeSource, registries)
L2  @pattern-stack/codegen-crm    — THIS PACKAGE: type-shaped CRM ports + tokens
L3  generated CrmPort             — composes the L2 ports (Track C · C6)
    consumer adapters             — implement the ports per provider
```

## Exports

| Export | Kind | Since |
|---|---|---|
| `IFieldDefinitionReader` | port — lists a provider's CRM field definitions (standard + custom) | C1 (#330) |
| `CrmFieldDescriptor`, `CrmFieldType`, `CrmEntity` | type vocab | C1 (#330) |
| `CRM_FIELD_DEFINITION_READER` | DI token (`Symbol.for`) | C1 (#330) |
| `IPicklistReader`, `CrmPicklistValue` | port — resolves picklist/multipicklist field values | C2 (#331) |
| `CRM_PICKLIST_READER` | DI token (`Symbol.for`) | C2 (#331) |
| `IAssociationReader`, `CrmAssociation`, `CrmEntityType` | port — reads cross-entity associations | C3 (#332) |
| `CRM_ASSOCIATION_READER` | DI token (`Symbol.for`) | C3 (#332) |
| `CrmCapabilities`, `NO_CRM_CAPABILITIES` | per-adapter capability descriptor | C4 (#333) |
| `CRM_CAPABILITIES` | DI token (`Symbol.for`) | C4 (#333) |
| `CrmPort` | L3 composing port — the contract an adapter implements (entity-agnostic) | C6 (#337) |
| `CRM_PORT` | DI token (`Symbol.for`) | C6 (#337) |
| `assertCrmAdapter` (from `@pattern-stack/codegen-crm/testing`) | conformance helper | C6 (#337) |

> `CrmEntityType` (C3) is an alias of the canonical `CrmEntity` (C1) — the
> union `'account' | 'contact' | 'opportunity'` has one source of truth; both
> names are exported.

```ts
import {
  IFieldDefinitionReader,
  CRM_FIELD_DEFINITION_READER,
  type CrmFieldDescriptor,
} from '@pattern-stack/codegen-crm';
```

This package ships **ports only** — no implementing classes. Implementations
are consumer-side (e.g. `pattern-stack/integration-patterns`).

## Declaring capabilities

An adapter declares which ports it implements and which entities it serves by
spreading on top of `NO_CRM_CAPABILITIES`, and registers the descriptor under
the `CRM_CAPABILITIES` token:

```ts
import {
  type CrmCapabilities,
  NO_CRM_CAPABILITIES,
  CRM_CAPABILITIES,
} from '@pattern-stack/codegen-crm';

export const HUBSPOT_CRM_CAPABILITIES: CrmCapabilities = {
  ...NO_CRM_CAPABILITIES,
  fieldDefinitions: true,
  picklists: true,
  associations: true,
  entities: ['account', 'contact', 'opportunity'],
};

// in the adapter's NestJS module:
// { provide: CRM_CAPABILITIES, useValue: HUBSPOT_CRM_CAPABILITIES }
```

A consumer queries capabilities at runtime to gate behaviour:

```ts
if (caps.fieldDefinitions && caps.entities.includes('lead')) {
  // safe to read custom fields for `lead` on this provider
}
```

`entities` is runtime coverage data, not a type bound on the L3 `CrmPort` — the
port stays entity-agnostic (ADR-036 §6). C6's `assertCrmAdapter()` checks each
declared entity resolves via the change-source registry.

## The composing port — `CrmPort`

`CrmPort` is the single L3 contract a provider adapter implements. It composes
L1 strategies (`auth`, the entity-keyed `sources` registry) and the L2 ports
(`fields`, `picklists`, `associations`) plus the runtime `capabilities`
descriptor. It is **entity-agnostic** — no entity name appears in its type;
entity access goes through `sources.get<T>(entityName)`. Per-consumer typed
views are codegen-emitted (Track D), not encoded here.

### Conformance testing

`@pattern-stack/codegen-crm/testing` ships `assertCrmAdapter` — a structural
check for adapter tests:

```ts
import { assertCrmAdapter } from '@pattern-stack/codegen-crm/testing';

it('hubspot adapter conforms to CrmPort', () => {
  assertCrmAdapter(hubspotCrmAdapter); // throws AggregateError listing every gap
});
```

It verifies required L1 slots resolve, that `capabilities` flags match the
present ports, and that every `capabilities.entities` entry resolves via
`sources.has(name)` — so an adapter declaring an entity it can't source fails
the test rather than failing at runtime.

## Roadmap

- Surface-only `CrmPort` methods — added only when a consumer feature drives one.
- Track D D3/D4 — codegen-emitted adapter scaffolds + per-consumer typed views.

## License

MIT
