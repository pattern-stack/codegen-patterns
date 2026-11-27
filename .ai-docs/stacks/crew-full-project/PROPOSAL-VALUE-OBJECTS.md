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
order: seq                              # insertion order, beside the identity (rowid on SQLite, identity on Postgres)
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
    # storage: columns (the default): mail filters on to.* and from.* (sqlite.mail-store.ts:211-226)
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

Corrected 2026-11-26 (gap-map's check against crew): `Message.from` and `Message.to` are queried, so they're stored as columns.

| Value object | Queried inside? | Storage |
|---|---|---|
| `AgentAddress` (agent identity, `parent`, notification `agent`, receipt `to`, message `from.agent`) | yes: keys, foreign keys, "children of X" | columns |
| `AgentNotification.delivered` | yes: `delivered IS missing` is "pending" | columns |
| `AgentSession.runtime` | yes: s4 resolves a session from its Herdr terminal (`runtime.ref`) | columns |
| `AgentSession.harness` | not today | json |
| `MessageReceipt.at` (one timestamp per step) | no (queries use `state`) | json |
| `Message.from`, `Message.to` (unions) | yes: room posts filter on `to.*` and `mail.sql:44` indexes it; `countInRoom` excludes `from` = me (`crew:src/modules/mail/infrastructure/sqlite/sqlite.mail-store.ts:211-226`) | columns |

Two more facts from crew:
- **Not every identity is a value object.** Team `(project, id)`, Agent, MessageReceipt, Room and RoomMember have
  value-object identities. AgentSession, AgentNotification and Message keep a plain text `id` (`UNIQUE`, beside `seq`:
  `teams.sql:34`, `notifications.sql:4`, `mail.sql:4`), so `identity:` must also accept a scalar field.
- **`Agent.parent` changes shape.** Today crew stores only the parent's agent name and reuses `address`'s project and
  team (`crew:src/modules/teams/infrastructure/sqlite/sqlite.teams-store.ts:76,107-109`). With `references: agent` on a
  full `agent_address` it becomes three columns. Crew adapts: its use case already refuses a parent on another team
  (`teams/application/teams.ts:207-212`). RoomMember's `room` and `agent` share project and team the same way, and
  crew moves that check from the store to the use case (`assert-mail-repositories.ts:192`).

## Ordering: `order:` beside `identity:`

G1 had two halves, and the value-object identity covers only one. A value-object identity (a composite primary key) has
no insertion order, yet crew's ordered reads all depend on it, and its instants can tie:
- agents `onTeam` `ORDER BY seq`; sessions `ofAgent` `ORDER BY seq DESC` (`crew:…/sqlite.teams-store.ts:170, :208`);
- the room-post cursor `seq > …` in `position` / `inRoom` (`sqlite.mail-store.ts:209-216`);
- notifications, receipts, rooms and members.

crew's suites assert oldest-first and newest-first order (`assert-teams-repositories.ts:84-90, 124-130`). So an entity
can declare `order: seq`: an autoincrement column that isn't the key. It's rowid on SQLite and an identity column on
Postgres. It is the non-key half of #797's `strategy: identity`. Ordered finders and cursors (`after:`) use it.

## Phasing

Columns are the default and come first (Doug, 2026-11-26). Every crew value object that is queried needs them, and
only `AgentSession.harness` and `MessageReceipt.at` are json.

1. **`storage: columns`** (M–L). Prefixed columns, the mapper, `CHECK` constraints, path queries and indexes, plus
   `order:`.
2. **`identity:` and `references:` by value object** (L). Composite primary and foreign keys. Builds on #780 (natural
   keys) and #787 (composite FKs); epics #783 and #793.
3. **`storage: json` with a real schema** (S–M), the opt-in. One typed JSON column, no mapping code. Done together with
   G3's "typed json".

## Risks

- Changing a named value object changes every table that uses it, so codegen must generate those migrations together.
- Postgres composite types (`CREATE TYPE`) exist, but driver and Drizzle support is poor. Prefixed columns stay the
  default; JSON is the opt-in.
- Unions inside unions: cap it at one level until someone needs more.
- drizzle-pg goldens stay byte-identical: an entity with no value objects emits exactly what it does today.
