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

```ts
import {
  IFieldDefinitionReader,
  CRM_FIELD_DEFINITION_READER,
  type CrmFieldDescriptor,
} from '@pattern-stack/codegen-crm';
```

This package ships **ports only** — no implementing classes. Implementations
are consumer-side (e.g. `pattern-stack/integration-patterns`).

## Roadmap

- **C2** — `IPicklistReader`
- **C3** — `IAssociationReader`
- **C4** — `CrmCapabilities` descriptor

## License

MIT
