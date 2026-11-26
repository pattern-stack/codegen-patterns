# Proposal: value objects (G1 + G2 as one feature)

From the crew session `s3-slice-1-69`, settled in conversation with Doug on 2026-11-26 (codegen-targets d13). For
codegen-project-manager. It replaces G1 (composite keys) and G2 (value objects) in `GAP.md` with a single item.

## The principle: DDD for the model, ER for storage

codegen's YAML speaks Domain-Driven Design: entities, value objects, identity, bounded contexts (`context:`).
codegen's output is entity-relationship storage: tables, columns, keys, constraints. A developer designs in DDD terms;
ER terms show up only in storage settings.

This matches Doug's modelling style (analytics: `stg → int → fct/dim`):

| Doug's rule | DDD name |
|---|---|
| An `int_` table is one domain, one concept | an aggregate in a bounded context |
| No cross-domain joins | contexts talk through published interfaces and events |
| Surrogate keys on either side | reference other aggregates by identity only |

## The concepts

- **Entity:** has identity. Two agents with identical fields are still two agents.
- **Value object:** no identity, compared by value, immutable, set and replaced as a unit. It is named and reusable, or
  inline for one field.
- **Tagged union:** a value object that comes in variants, chosen by an enum (`kind`).
- **Identity can be a value object.** A "composite key" is just an entity whose identity is a value object, and a
  reference to such an entity is a value-object-typed foreign key. That is why G1 and G2 are one feature: built
  separately, they're two half-solutions that don't compose.

## The YAML (proposed)

```yaml
# value_objects/agent_address.yaml (named, reusable)
value_object: agent_address
fields: { project: name, team: name, agent: name }
```

```yaml
# entities/agent.yaml
entity: agent
identity: address                       # the identity is a value object (→ composite primary key)
fields:
  address: { value: agent_address }
  parent:  { value: agent_address, optional: true, references: agent }   # composite FK
  state:   { choices: [ready, live, refreshing, down, retired] }
  rev:     { versioned: true }

# entities/agent_notification.yaml (an inline value object)
  delivered:
    optional: true                      # all of it or none of it
    value: { at: instant, via: { choices: [pull, inject] }, session: id }
    storage: columns                    # the ER detail; the default

# entities/message.yaml (a tagged union)
  from:
    union:
      by: kind
      variants:
        agent: { agent: agent_address }
        human: { name: name }
        crew:  {}
    storage: json                       # not queried inside, so one column is enough
```

## Nested everywhere above storage, flat only in storage

| Layer | What codegen emits |
|---|---|
| Domain record | a nested Zod schema and TS type; named value objects are shared schemas |
| Table | `storage: columns` (default): prefixed columns (`delivered_at`, `delivered_via`, …). `storage: json`: one JSON column |
| Integrity | `CHECK`: an optional value object is all-or-none; a union's variant columns are null unless `kind` matches |
| Mapping | row ↔ nested object, both ways; missing vs `null` per target (crew: missing) |
| Identity and references | `identity:` → composite primary key; `references:` → composite foreign key |
| Queries and indexes | addressed by path: `where: { delivered: missing }`, `where: { from.kind: agent }`, `index: [parent]` |
| DTOs, API, editor JSON Schema, Studio | the nested shape; Studio shows the group |
| Semantic model | one dimension group per value object (`delivered.at`, `delivered.via`, `delivered.session`) |
| Tests (G10) | round-trips per variant, all-or-none, and the `CHECK` refusing a half-set value object |

## Crew's value objects, and the storage each needs

| Value object | Queried inside? | Storage |
|---|---|---|
| `AgentAddress` (agent identity, `parent`, notification `agent`, receipt `to`, message `from.agent`) | yes: keys, foreign keys, "children of X" | columns |
| `AgentNotification.delivered` | yes: `delivered IS missing` is "pending" | columns |
| `AgentSession.runtime` | yes: s4 resolves a session from its Herdr terminal (`runtime.ref`) | columns |
| `AgentSession.harness` | not today | json |
| `MessageReceipt.at` (one timestamp per step) | no (queries use `state`) | json |
| `Message.from`, `Message.to` (unions) | not today | json |

## Phasing

1. **`storage: json` with a real schema** (S–M). Value objects (named and inline, unions included) stored as one
   typed JSON column, with no mapping code. This overlaps G3's "typed json"; do them together. It covers crew's json
   rows above.
2. **`storage: columns`** (M–L). Prefixed columns, the mapper, `CHECK` constraints, path queries and indexes.
3. **`identity:` and `references:` by value object** (L). Composite primary and foreign keys. Builds on #780 (natural
   keys) and #787 (composite FKs); epics #783 and #793.

## Risks

- Changing a named value object changes every table that uses it, so codegen must generate those migrations together.
- Postgres composite types (`CREATE TYPE`) exist, but driver and Drizzle support is poor. Prefixed columns stay the
  default; JSON is the opt-in.
- Unions inside unions: cap it at one level until someone needs more.
- drizzle-pg goldens stay byte-identical: an entity with no value objects emits exactly what it does today.
