# R3 light-review fixes — lane `inh-r3`

Light review of S3 phase R (efacef8a + fd349ca0): ACCEPT_WITH_FIXES. New commits on your branch; COMMON.md binds you.

1. **The include-allowlist gate change has no test that can fail** (`src/emitters/relations/build-includes.ts:169`):
   replacing `inheritanceChildrenOf(entity.name, ctx.definitions.values())` with `[]` turns nothing red. Add to
   `build-includes.test.ts`: (a) a base with child tables and no own relationships declares
   `api.includes: { list: [<child relKey>] }` — accepted, and the path compiles through the family edge; (b) a
   `discriminator:` base with no child still throws "…and is in no family"; (c) the second widening the gate now
   allows — an entity whose only edge is a cardinality-one `roles:` role, declaring `api.includes` — accepted.
   Show (a) red with the `[]` substitution, then restore.
2. **Living docs:** `docs/specs/REL-2.md:752` and `:879` still name the deleted `declaresOwnRelation` and the
   own-relationships-only rule; the comment at `build-includes.ts:158-163` still says "gated on the entity's OWN
   `relationships:`". Update all three to `hasTypedInclude`'s rule (own non-`through:` relationship, or a role edge,
   or a child, or a base with children). RFC-0006 `:1421`: record the roles half of the widening too.
3. **The one remaining permissive default** (`entity-locals.js:2209`, same pattern at `templates/_shared/inheritance.mjs:340`):
   `entityLookup?.definitions ? entityLookup.definitions() : []` drops a base's cross-kind reads and typed include
   silently when there is no lookup. Throw (naming the entity) when the definition has `discriminator:` and there is
   no lookup, as the child path already fails loudly; test it.
4. Rename the now self-referential "hasTypedInclude matches the template's includes" test
   (`build-includes.test.ts:395-447`) and drop its stale "has a twin in the hygen half" comment.

Not now (it changes bytes): finding 5, the per-entity prefixes on the file-private helpers in
`repository.ejs.t:49-50` — add one line to the RFC's follow-ups list instead.

Gates after your last edit: `bun run typecheck`, `just test-unit`, `just test-baseline`. Report to
`codegen-patterns-73`, then stop.
