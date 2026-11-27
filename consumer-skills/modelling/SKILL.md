---
name: modelling
description: Load when a person is describing a new app, feature or concept and it has to become entities, parts and relationships before any entity YAML is written. Triggers include "model this", "what tables do I need", "how should these relate", "is this its own entity", "one table or two", deciding whether something is a part or a reference, and drawing context boundaries.
user-invocable: false
---

# Modelling an app: from an idea to entities, parts and edges

Use this to help a person talk an idea through until the relationships are right. The output is a small tree they
agree with, then YAML.

## The one idea

One entity is made of many small parts, and it reads back whole. People put everything on one table because that is
the only way they know to get it back as one. Help them see the parts, and show them the parts come back together.

## Two questions, never mixed

1. **What kind of thing is it?** Subject, actor, fact or communication.
2. **Where does it live?** Context, then entity, then part.

A kind is not a level. "Communication" can be a kind and also the name of a context. Decide the two separately.

## How to run the conversation

- Use the person's own nouns. Bring in the words below only when you need them.
- Ask one question at a time, about a concrete case ("open one opportunity: what do you see?").
- After each step, say the model back as a short tree and ask what is wrong with it.
- Write no YAML until the tree is agreed.

## Step 1. Collect the nouns and sort them by kind

Ask of each noun: **does it exist, or did it happen?**

| Kind | Test | Examples |
|---|---|---|
| **Subject** | It exists and changes. Other things are about it. | account, contact, opportunity |
| **Actor** | A subject that can take a role in a communication: send, receive, attend. | contact, user, account |
| **Fact** | It happened, about one or more subjects. | email, meeting, task, order |
| **Communication** | A fact with actors in roles (from, to, witness). | email, meeting, message |

- A fact is one of two sorts. A **point-in-time** fact occurs once (an email). A **lifecycle** fact moves through
  states (a task, an order). Each change in a lifecycle is itself a point-in-time event, so both sorts share a grain.
- An opportunity is a subject but not an actor. Things are about it; it does not act.
- For a person who thinks in warehouse terms: subjects are dimensions and facts are facts.

## Step 2. Entity or part?

Start with the read-back question, which is the fastest way in:

> When you open one of these, what do you expect to come back with it in full? And what shows up as just a name?

What comes back in full is probably a **part**. What shows up as a name is a **reference** to another entity.

Confirm each candidate part with three tests. A part answers no, only the owner, yes.
1. Can it exist without its owner?
2. Does anything outside point at it directly, or only at its owner?
3. Is it saved in the same transaction as its owner?

- A part is a **child** (it has its own id: a version, a line item) or a **value** (it has none: an address, an amount).
- A part has exactly one owner. If it seems to have two, it is its own entity, or it is a link.
- Parts can have parts.
- "Deleted with its owner" is not the test. A task can be deleted with its opportunity and still be its own entity.
- A list of other entities is never a part. An account's opportunities are entities that refer to the account.

## Step 3. Name every edge: owns, or refers to

| Edge | Meaning | Stored as | Reads back |
|---|---|---|---|
| **Owns** | a root to its part | the part's rows or columns | the part, in full |
| **Refers to** | one entity to another | an id | the other entity's `reference`: one hop, to-one |

- The side that holds the id is the side that refers.
- The reverse of a reference (an account's opportunities) is a read someone asks for. It is not part of the entity.
- Many-to-many means there is a link row. Ask "from which side do you manage it?" That side owns the link, and the
  link refers to the other side. If neither side is primary (person knows person), say so and leave it flagged.

## Step 4. Draw the contexts

A context is one model with one vocabulary.

- Does this group have its own words? Could it exist without the other group? Emails and meetings exist without a
  deal, so communications is its own context.
- An entity is in exactly one context. Parts take their owner's.
- Contexts point into each other by id only.
- Do not decide the context from the kind, and do not say "domain": it has meant three different levels.
- Which vendor feeds an entity is a separate question (`surface:`). Leave it out of this conversation.

## Step 5. Say how each entity looks when referred to

For every entity that something refers to, ask: "If another record points at this, what is the least it needs to
show?" Usually the id and a name. That is the entity's `reference`.

- The entity decides its own `reference`. The record pointing at it does not pick the columns.
- Keep it tiny. With nothing listed it is just the id, so nothing leaks by default.

## Step 6. Check what follows

- **Reads may cross; writes stay home.** A read can follow a reference into another entity. A change to two entities
  is a use case, never one entity writing another.
- **Counts and totals are not part of an entity.** They belong to query-surface. "Aggregate" means measures only.
- **A read rule travels only if it is declared** (tenant, soft delete, owner). Ask who may see each entity. If the
  answer needs more than those three, flag it: a rule written in a use case does not cover rows reached through an edge.

## Wrong turns to catch

- Everything on one table, or a JSON column, "so it comes back together". Model the parts.
- "It cascades, so it is a part."
- Choosing the other entity's columns from the side that refers to it.
- A part with two owners.
- The kind deciding the level: "it is a communication, so it goes in communications".
- A list of other entities treated as part of this one.
- A service that fetches two things and zips them in memory.

## What to hand back

The tree, then the YAML.

```
Opportunity  (crm)             subject
  name, amount
  billing      value   address
  line_items   part    opportunity_line_item[]
  owner        ref     User     { id, name }
  account      ref     Account  { id, name }
```

## Writing it down today

Keep this table true to the generator. It is the part of this guide that changes.

| Idea | In codegen today | Coming |
|---|---|---|
| Context | `context:` on the entity | the same key, later also a Postgres schema |
| Entity root | an `entity:` file | the same |
| Value part | value objects (settled 2026-11-26; check whether built) | the same |
| Child part | `belongs_to` with `on_delete: cascade`, and a comment saying it is a part | `type: part_of` |
| Refers to | `belongs_to` | the same |
| `reference` | not declared; ask per read with a column mask, `with: { owner: { columns: { name: true } } }` | `shapes: { reference: [...] }` |
| Kinds | `Actor` and `Communication` capabilities, the `Activity` pattern for point-in-time facts | lifecycle facts, ported from backend-patterns' `EventPattern` |
