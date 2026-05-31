# ADR-036 — Surface Packages (`@pattern-stack/codegen-<surface>` L2 layer)

**Status:** Accepted
**Date:** 2026-05-30
**Owner:** Doug
**Related:** ADR-008 (subsystem architecture — L1 home), ADR-033 / 033.1 (config-driven change sources, `detection:`), ADR-034 (provider registry — *superseded by RFC-0001*), ADR-031-auth-subsystem, RFC-0001 (integration codegen retarget — **the binding constraint for L2/L3, see §11**), swe-brain ADR-0006 (domain taxonomy — surface/context/supertype axes; see §11.3), Track C epic #328, C1 #330 (bootstrap `codegen-crm` + `IFieldDefinitionReader`), C2 #331 (`IPicklistReader`), C3 #332 (`IAssociationReader`), C4 #333 (`CrmCapabilities`), C6 #337 (`CrmPort` composing port + `assertCrmAdapter`), C7 #336 (`IEntityChangeSourceRegistry` in L1)

## 1. Context

Integration codegen splits into three port layers. The split is what lets a
framework primitive (auth, change detection) stay domain-blind while a CRM-shaped
or mail-shaped concern (custom-field discovery, picklist sync) still gets a typed
home — without bloating the framework with every consumer's vocabulary.

```
L1 Strategies   @pattern-stack/codegen/subsystems/   cross-type, domain-blind
                IAuthStrategy · IChangeSource<T> · ISyncSink<T>
                          │
L2 Capabilities @pattern-stack/codegen-<surface>/     type-shaped, single-capability ports
                IFieldDefinitionReader · IPicklistReader · CrmFieldType …   ← THIS ADR
                          │
L3 Composing    consumer (contract from C6)            composition is consumer-specific
                <Surface>Port (aggregates L2 ports + entity sources + optional surface methods)
```

L1 has a home (the framework's `subsystems/` tree, ADR-008). L3 has a home (the
consumer app, where composition happens). **L2 had no home.** Type-shaped surface
that is too domain-specific for L1 but too reusable to re-author per consumer —
CRM custom-field discovery, picklist sync, association mapping — was homeless. The
choices were "force it into the framework" (every consumer pays for CRM vocabulary
they don't use) or "re-author it per consumer" (no shared contract, no second-vendor
falsifier reuse). This ADR gives L2 a home and locks the convention so every
subsequent surface (`codegen-mail`, `codegen-transcript`, …) ships against a
documented reference and C1 can bootstrap `codegen-crm` without re-litigating shape.

> **Per RFC-0001.** RFC-0001 retargets integration emission onto exactly this
> L1/L2/L3 model and extends the diagram *below* L3 with the runtime tier Track D
> emits: a **provider-adapter scaffold** (`implements <Surface>Port`) and the
> **hand-rolled implementations** the consumer fills in. Those tiers are not port
> layers and are out of scope here — but the ports this ADR governs are precisely
> what those scaffolds inject (RFC-0001 §4). §11 reconciles the boundary.

## 2. Decision

**A surface is a workspace package**, not a directory inside `@pattern-stack/codegen`.

- Named `@pattern-stack/codegen-<surface>` (e.g. `@pattern-stack/codegen-crm`).
- Lives at `packages/codegen-<surface>/` in the monorepo (bun workspace).
- **Independently versioned, independently installable.** A consumer that needs
  only CRM ports installs `@pattern-stack/codegen-crm` and nothing else.
- `<surface>` is the **singular domain noun** that names the type-shaped grouping:
  `crm`, `mail`, `transcript`, `meeting`. (On the relationship between this axis
  and swe-brain's *context* and *surface* axes, see §11.3 — they are not the same
  word used the same way.)

A surface package is the L2 layer made concrete: the place type-shaped ports,
their tokens, their capability descriptor, and their vocabulary live.

## 3. Layer rules — what lives at L1 vs L2 vs L3

| Layer | Home | Holds | Test |
|---|---|---|---|
| **L1** | `@pattern-stack/codegen/subsystems/` | Anything **cross-type / domain-blind**: `IAuthStrategy`, `IChangeSource<T>`, `ISyncSink<T>`. | Would *every* surface want it, regardless of domain vocabulary? → L1. |
| **L2** | `@pattern-stack/codegen-<surface>/` | Type-shaped surface that **doesn't fit at L1**: CRM custom-field discovery, picklist sync, association mapping. Single-capability ports only (§5). | Is it shaped by *this* domain's vocabulary but still reusable across that domain's vendors? → L2. |
| **L3** | **consumer app** (contract authored in C6) | The **composing port** `<Surface>Port` + surface-only methods, and the concrete composition (adapters, aggregator wiring, method bodies). | Does it compose *which* L2 ports / *which* providers a given app uses? Composition is consumer-specific → **L3, never in the surface package.** |

The bright line: **the surface package carries contracts and vocabulary, never
composition.** A single-capability port is a contract (L2). An aggregation of
ports wired to concrete providers is composition (L3). See §11.2 for how the
`<Surface>Port` *interface* (C6) is reconciled against this line and RFC-0001.

## 4. Package layout

```
packages/codegen-<surface>/
  src/
    ports/            single-capability port interfaces (§5), one concern each
    tokens.ts         DI tokens for the ports
    index.ts          public barrel — ports, tokens, capability descriptor, vocab
    templates/        empty initially (§4.1)
  package.json        name: @pattern-stack/codegen-<surface>, own version
  tsconfig.json
  README.md           what the surface is, which ports exist, the L2/L3 boundary
```

### 4.1 The `templates/` directory

Empty on bootstrap. Populated **only when a `<surface>`-shaped emit pattern
repeats** — i.e. the same generated shape recurs across consumers and is worth
lifting into a template. Premature templating is a smell; the directory exists so
the convention has a slot, not so it must be filled. (This mirrors swe-brain's
operating rule: lift to codegen once the same shape recurs twice.)

## 5. What goes in `ports/`

**Single-capability port interfaces + their DI tokens.** Each port is *one verb*:

```ts
// ports/field-definition-reader.ts
export interface IFieldDefinitionReader {
  list(objectType: string): Promise<CrmFieldDefinition[]>;
}

// ports/picklist-reader.ts
export interface IPicklistReader {
  values(field: CrmFieldRef): Promise<CrmPicklistValue[]>;
}
```

Rules:

- **One capability per port.** `IFieldDefinitionReader.list()`,
  `IPicklistReader.values()`. Not a kitchen-sink `ICrmReader`.
- **No composing ports at L2.** A port that aggregates other ports, or that an
  adapter implements to "be the CRM surface," is L3 — it composes, and composition
  is consumer-specific. (This is the `<Surface>Port` of C6; see §11.2.)
- **Bar for adding a port to L2:** at least one **type-only justification**
  documented — in this ADR or in the port's PR. "It's shaped by CRM vocabulary and
  a framework primitive can't express it without that vocabulary" is the
  justification. "It's convenient" is not. If a port is domain-blind it belongs at
  L1; if it only makes sense once you know which providers an app composes, it
  belongs at L3.

## 6. Capability descriptor — `<Surface>Capabilities`

Each surface declares a per-surface capability descriptor in L2 that names which
ports an adapter implements:

```ts
// part of index.ts / a capabilities module
export interface CrmCapabilities {
  fields?: IFieldDefinitionReader;
  picklists?: IPicklistReader;
  associations?: IAssociationReader;
}
```

`<Surface>Capabilities` is the typed manifest a provider adapter fills in: a
HubSpot adapter that does fields + picklists but not associations is expressed by
which keys it provides. RFC-0001 §4 makes this concrete — the emitted adapter
scaffold injects "the L2 capability ports per the surface's `<Surface>Capabilities`"
and stubs their methods. The descriptor lives at **L2** because the *set of
possible capabilities* is a property of the surface, not of any one consumer's
composition.

## 7. Vocabulary

Type-shaped vocabulary belongs to the surface package, **not** to
`@pattern-stack/codegen`:

```ts
// codegen-crm, NOT codegen
export type CrmFieldType = 'text' | 'number' | 'picklist' | 'date' | 'reference' | …;
export interface CrmPicklistValue { label: string; value: string; archived: boolean; }
export type CrmAssociationType = …;
```

`CrmFieldType`, `CrmPicklistValue`, `CrmAssociationType` are CRM-shaped — they have
no meaning at L1 and would force every non-CRM consumer to carry CRM types. They
ship in `codegen-crm`. The framework stays vocabulary-free; the surface owns its
nouns. This is the same reasoning as the port rule (§5): domain vocabulary is the
*definition* of L2.

## 8. Consequences

**Positive**

- **Independent versioning.** A breaking bump to `codegen-crm` does not force
  `codegen-mail` consumers to upgrade. Surfaces release on their own cadence.
- **Pay-for-what-you-use.** A mail-only consumer never installs CRM vocabulary.
- **A reusable, falsifiable contract.** The L2 ports are the second-vendor
  falsifier seam (a HubSpot adapter and a Salesforce adapter implement the same
  `IFieldDefinitionReader`), without that contract living in the framework.

**Negative**

- **More packages to publish.** Each surface is a publishable artifact. Mitigated:
  bun workspaces give monorepo dev ergonomics (one checkout, transitive
  typecheck, `file:`/workspace deps) so the cost is at publish time, not dev time.
- **A placement question per new port** (L1 vs L2 vs L3). The §3 test and the §5
  type-only-justification bar exist precisely to make that call cheap and
  documented rather than re-litigated.

**Bar for creating a new surface package:** at least one consumer adapter is being
authored against the surface **today**. We do not speculatively scaffold
`codegen-transcript` before a transcript adapter needs its ports — that is the
"don't invent codegen for code that doesn't exist" rule applied to surfaces.

## 9. Alternatives considered

**A. `extensions/<surface>/` directory inside `@pattern-stack/codegen`.**
Rejected. Bloats the framework with domain-specific surface; a consumer that uses
no CRM still ships CRM types and ports; and it couples release cadences — every
surface change forces a framework version bump that every consumer feels.

**B. Nest `<surface>` ports under a pattern's directory** (e.g.
`library/patterns/CrmEntity/ports/`). Rejected. Consumers may use the ports
*without* adopting the storage pattern (Track B's `CrmEntity`), so binding the
ports to the pattern's directory is the wrong coupling. Ports and patterns meet
only at runtime in a consumer adapter (§10), not in the source tree.

**C. Separate git repos per surface.** Rejected. Monorepo dev ergonomics
(atomic cross-surface changes, one typecheck graph, shared tooling) matter more
than the isolation separate repos buy. Bun workspaces deliver the independent-
versioning upside (§8) without the multi-repo overhead.

## 10. Relationship to Track A and Track B

Track C is **independent** of both.

- **Track A (#305)** ships the *pattern extension surface* (how app-defined
  patterns plug in). Surface packages do not depend on it — an L2 port is a plain
  interface, not a pattern extension.
- **Track B (#313)** ships the **`CrmEntity` storage pattern** (the consumer-side
  storage shape for CRM records). Track C ships the **provider-side ports** (how a
  vendor's CRM data is read). They are different sides of the integration.

They **meet only in a consumer adapter at runtime**: an adapter implements Track C's
L2 ports to read a vendor, and writes through Track B's storage pattern. Neither
track's source tree references the other's. This is why alternative B (nesting
ports under the pattern) is wrong — the meeting point is runtime composition, which
is L3, which is the consumer's.

## 11. Reconciliation with RFC-0001 and swe-brain ADR-0006

RFC-0001 is the binding constraint: it already retargeted integration emission onto
this L1/L2/L3 model and made calls that touch L2/L3. **Where RFC-0001 made a call,
this ADR defers to it.** Three points needed reconciling.

### 11.1 The runtime tier below L3 (RFC-0001 §2, §4)

RFC-0001's diagram extends below L3 with a **provider-adapter scaffold** and
**hand-rolled implementations**. Those are not port layers — they are the runtime
that Track D *emits and the consumer fills*. This ADR governs only the three port
layers. The contact point: the emitted scaffold's constructor injects **L1
strategies** (the provider's declared auth strategy + client) **and the L2
capability ports** for the surface, and stubs the L2 methods for the author to fill
(RFC-0001 §4). So this ADR's L2 ports are exactly the injectable surface those
scaffolds depend on — which is why their shape is locked here, at C0, before D3/D6
emit against them.

### 11.2 The `<Surface>Port` composing port (C6) — the one tension

#329 states "L3 composing port … **NOT in surface packages**." RFC-0001 §4 calls
`<Surface>Port` "the L3 composing port, Track C C6" (#337 — the *entity-agnostic*
`CrmPort` plus an `assertCrmAdapter` conformance helper) and (line 21) lists its home as
"consumer / `codegen-<surface>`" — i.e. RFC-0001 leaves open that the *interface*
could be sourced from the surface package, because the emitted adapter scaffold must
`implements <Surface>Port` against an importable contract.

**Reconciliation — the invariant that holds either way:**

- **Composition never lives in the surface package.** The concrete adapters, the
  `<surface>-adapters.module.ts` aggregator, the surface-only method bodies, and the
  choice of *which* providers/ports an app wires are all consumer-specific and are
  emitted by **Track D into the consumer** (RFC-0001 §2–§4). #329's bright line is
  upheld in full for composition.
- **The `<Surface>Port` *interface* is C6's deliverable, not this ADR's**, and its
  physical placement is deferred to C6 under RFC-0001's constraint. If C6 places the
  bare interface in the surface package, that is permitted **only because it is a
  contract, not composition** — it aggregates L2 ports + an entity-sources registry
  handle + optional surface-only method slots, and carries zero wiring. The §3/§5
  rule "no composition at L2" is satisfied: a bare aggregating interface is a type,
  the composition that satisfies it is consumer-side.

This ADR therefore does **not** itself place `<Surface>Port`; it locks the
invariant (composition ⇒ consumer; a bare composing-port *interface* is a contract C6
may co-locate) and points at C6 + RFC-0001 §4 for the placement call. *This is the
one spot where #329's wording ("NOT in surface packages") is narrowed: it holds
absolutely for composition, and is deferred to C6 for the interface contract per
RFC-0001.*

### 11.3 `IEntityChangeSourceRegistry` (C7) and the surface/context naming collision

**`IEntityChangeSourceRegistry` (C7, #336).** RFC-0001 §3 has `<SURFACE>_ENTITY_SOURCES`
resolve to a C7 `IEntityChangeSourceRegistry` instance; Track D emits the *wiring*
that populates it, C7 defines the *interface*. That interface is **generic over
`IChangeSource<T>`** (an L1 primitive) and keyed by entity name — it is **not shaped
by any surface's domain vocabulary**. By the §3 test it is cross-type, so its
interface belongs at **L1, not in a surface package** — and C7's own scope (#336:
"`IEntityChangeSourceRegistry` in **L1** (subsystems/sync)") confirms exactly that
placement. The per-surface DI token (`CRM_ENTITY_SOURCES`) and the resolved instance
are consumer-side (Track D). The point for *this* ADR: a per-surface registry whose
*contents* are surface-scoped does **not** make its *interface* L2 — genericity over
an L1 primitive keeps the contract at L1, and C7 is where it lands.

**Naming collision with swe-brain ADR-0006 — read this before mapping the two.**
The word "surface" is not used the same way in the two repos:

| This ADR / RFC-0001 | swe-brain ADR-0006 | Note |
|---|---|---|
| **surface** = the type-shaped domain grouping that names an L2 package (`crm`, `mail`, `transcript`, `meeting`) | **bounded context** (`calendar`, `mail`, `transcript`, `identity`) | These line up. codegen's "surface" ≈ ADR-0006's "context". RFC-0001's per-provider `surfaces: [calendar, mail, transcript]` are ADR-0006 *contexts*. |
| **provider** (RFC-0001 §1) — serves multiple `surfaces:` | **surface** / `InteractionSurface` — vendor-source composition spanning contexts | These line up. ADR-0006's "surface" (one Google OAuth → calendar+mail+transcript) is RFC-0001's **provider**, not codegen's "surface". |

So: a `@pattern-stack/codegen-<surface>` package corresponds to a swe-brain
**bounded context**, and the swe-brain "surface" (vendor composition) corresponds to
a **provider** here. Two consequences worth stating so a reader of both repos isn't
misled:

- #329's example surface `meeting` is swe-brain's **`calendar`** context (entity
  `meeting`); ADR-0006 split `calendar`/`mail` apart and renamed that context to
  `calendar`. A `codegen-calendar` package (entity `meeting`) is the consistent
  name; `codegen-meeting` would name the package after the entity, not the surface.
  C1+ should prefer the context noun.
- "surfaces span contexts" (ADR-0006 §5) is, in this repo's vocabulary, "a
  **provider** serves multiple **surfaces**" — exactly RFC-0001 §1's `surfaces:`
  list. The many-to-many (one Google provider → many surfaces; one surface fed by
  many providers) is the multi-provider registry contract of RFC-0001 §3, which is
  why the per-surface registry (C7) exists.

This ADR keeps the codegen/RFC-0001 vocabulary ("surface" = L2 domain grouping)
because that is the convention C1–C7 build against; the table above is the bridge
for anyone crossing into swe-brain.
