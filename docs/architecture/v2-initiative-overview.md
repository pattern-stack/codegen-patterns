# Dealbrain v2 — Architecture Initiative Overview

**Status:** Draft pending review
**Owner:** Doug
**Last updated:** 2026-04-11
**Related:** ADRs 001-014, specs SPEC-001 through SPEC-020

## Objective

Rebuild the Dealbrain backend on a consistent, domain-driven, hexagonal architecture with codegen-enforced layer boundaries, canonical CRM schemas, a semantic measure layer, and a well-defined agent subsystem. Ship v2 before we have real customers to migrate.

## Principles

1. **Domain-driven design with hexagonal ports for externals.** Proper DDD modeling with aggregates, not a bespoke pattern.
2. **Codegen-first.** The architecture is enforced through generated code. Templates are the source of truth.
3. **Canonical over provider-specific.** Sales concepts are modeled canonically from sales expertise; providers (SFDC, HubSpot) are adapters.
4. **Mechanical vs intelligent separation.** Services handle data. Use cases handle workflows. LLM subsystem for deterministic ML tasks. Agents subsystem for reasoning tasks.
5. **Integration testing over unit testing.** Real databases, real flows, mocked externals only.
6. **Greenfield rebuild.** Parallel track to v1, cut over when integration tests reach parity.

## Sequencing — Linear, Three Tracks

```
TRACK A — Codegen-patterns Evolution (foundation)
    ↓
TRACK B — Dealbrain v2 Rebuild (depends on A)
    ↓
TRACK C — Agent Framework Port (final, post-cutover)
```

The tracks are sequential, not parallel. Track B starts when A is ready. Track C starts when B is stable and cut over. During B, the existing Python agents in `apps/agents/` continue running via the stdio bridge — agents are not rewritten until v2 is proven.

### Track A — Codegen-patterns Evolution

Extend `pattern-stack/codegen-patterns` with the new architecture target, base class generators, subsystem templates, canonical schema generator, and semantic measure generator.

**Workstreams:**
- Phase 1.2 — add `pipelines` config to YAML schema
- Clean-Lite-PS template tree (new architecture target)
- Base class generators (entity-family inheritance)
- Subsystem template set (cache, storage, jobs, events, broadcast, integrations, llm, agents)
- Canonical schema generator
- Semantic measure generator
- Injector set for the new architecture

**Team:** Doug as architect/designer. Jeff/Evan/Thiago as template reviewers (performance, race conditions, syntax). Claude drafts templates.

**Exit criteria:** Codegen can emit a complete Dealbrain v2 domain module end-to-end from YAML, with passing integration tests.

### Track B — Dealbrain v2 Rebuild

Greenfield rebuild of the backend using the new codegen. Same database schema, fresh code structure.

**Workstreams:**
- Canonical CRM schemas v1 (Opportunity, Account, Contact, Activity)
- Subsystem implementations (wrap existing Redis, BullMQ, S3, Postgres)
- Base class implementations (CrmEntity, ActivityEntity, KnowledgeEntity, MetadataEntity)
- Hexagonal ports + provider registry (generalize Gong stack patterns)
- Salesforce adapter ported to new port structure
- Domain modules generated from YAML (Opportunity, Account, Contact, Activity, User, Meeting, Email, Artifact, Fact, FieldDefinition, FieldValue, OpportunityUpdate)
- Hand-written use cases for real business logic
- Semantic measure definitions
- Integration test suite (v1 behavior captured, v2 must pass)
- Python agents bridged via stdio during transition
- Frontend cutover

**Team:** Doug drives. Team reviews PRs at each milestone.

**Exit criteria:** v2 passes the v1 integration test suite. Two internal users cut over. v1 archived.

### Track C — Agent Framework Port

Port `agentic-patterns` core from Python to TypeScript on Vercel AI SDK. Integrate as `subsystems/agents/`. Eliminate stdio bridge.

**Workstreams:**
- `packages/agent-core` — atoms, molecules, organisms (Zod-based)
- `packages/agent-runtime` — AgentRunner, event bus, conversation, gates, exporters
- Library presets — coordinator/orchestrator/analyst/retrieval role factories
- Dealbrain agency migrations — deal_assessment, call_summaries, field_pipeline
- Facade-as-toolbox integration (no more HTTP roundtrips)
- Delete `apps/agents/`

**Team:** Doug + Nick. Nick owns semantic layer / agent communication patterns.

**Exit criteria:** All three agencies running in TS. Python subprocess removed. Parallel tool calls enabled. Langfuse tracing continuous.

## Architectural Layers — Final Form

```
apps/backend/src/
  modules/
    canonical/                      ← Canonical schemas (sales-expert defined)
      opportunity/
      account/
      contact/
      activity/

    <domain>/                       ← One folder per domain aggregate
      <domain>.entity.ts            ← Drizzle table + TS type
      <domain>.repository.ts        ← Extends family base, concrete
      <domain>.service.ts           ← DDD aggregate, convenience methods, measures
      <domain>.controller.ts        ← Thin REST adapter
      <domain>.module.ts            ← NestJS wiring
      dto/
        *.dto.ts                    ← Zod schemas (input/output)
      use-cases/
        <semantic-name>.use-case.ts ← Hand-written business workflows

    subsystems/
      cache/                        ← Protocol + memory, redis backends
      storage/                      ← Protocol + s3 backend
      jobs/                         ← Protocol + bullmq backend
      events/                       ← Protocol + pg backend (domain event bus)
      broadcast/                    ← Protocol + electric backend
      integrations/                 ← Provider registry, adapter interfaces, ports
      llm/                          ← LLM port + provider adapters
      agents/                       ← (Track C) agent framework + agent registry

  shared/
    base-classes/
      base-repository.ts
      crm-entity-repository.ts
      activity-entity-repository.ts
      knowledge-entity-repository.ts
      metadata-entity-repository.ts
      base-service.ts
      crm-entity-service.ts
      activity-entity-service.ts
      knowledge-entity-service.ts
      metadata-entity-service.ts
      base-analytics-service.ts     ← Semantic measures
    errors/
    types/
```

## ADR List

| # | Title | Status |
|---|---|---|
| ADR-001 | Adopt DDD + hexagonal architecture for Dealbrain backend | Draft |
| ADR-002 | Domain-first module layout | Draft |
| ADR-003 | Service vs use case boundary rules | Draft |
| ADR-004 | Cross-domain access rules | Draft |
| ADR-005 | Entity-family base class inheritance tree | Draft |
| ADR-006 | Canonical CRM schema as foundational layer | Pending — needs sales expertise input |
| ADR-007 | Semantic measure layer | Pending — needs design session |
| ADR-008 | Subsystem architecture | Pending |
| ADR-009 | Hexagonal ports and provider adapter pattern | Pending |
| ADR-010 | LLM subsystem vs Agents subsystem split | Pending |
| ADR-011 | Port agentic-patterns core to TypeScript | Draft |
| ADR-012 | codegen-patterns as source of truth for scaffolding | Pending |
| ADR-013 | Integration-first testing strategy | Pending |
| ADR-014 | Greenfield rebuild with parallel v2 track | Pending |

## Spec List (ordered by dependency)

| # | Title | Track | Depends on |
|---|---|---|---|
| SPEC-001 | Canonical CRM schemas v1 | A | ADR-006 |
| SPEC-002 | codegen-patterns Phase 1.2 — pipelines config | A | ADR-012 |
| SPEC-003 | codegen-patterns Clean-Lite-PS architecture target | A | SPEC-002, ADRs 1-5 |
| SPEC-004 | codegen-patterns base class generators | A | SPEC-003, ADR-005 |
| SPEC-005 | codegen-patterns subsystem template set | A | SPEC-002, ADR-008 |
| SPEC-006 | codegen-patterns canonical schema generator | A | SPEC-002, ADR-006 |
| SPEC-007 | codegen-patterns semantic measure generator | A | SPEC-002, ADR-007 |
| SPEC-008 | Dealbrain subsystem implementations | B | SPEC-005 |
| SPEC-009 | Dealbrain base class implementations | B | SPEC-004 |
| SPEC-010 | Hexagonal ports and provider registry | B | ADR-009 |
| SPEC-011 | Salesforce adapter ported to new port structure | B | SPEC-010 |
| SPEC-012 | LLM subsystem implementation | B | ADR-010 |
| SPEC-013 | Opportunity domain generation + workflows | B | SPEC-001,004,008,009,010 |
| SPEC-014 | Account domain | B | SPEC-013 |
| SPEC-015 | Contact domain | B | SPEC-013 |
| SPEC-016 | Activity domain | B | SPEC-013 |
| SPEC-017 | ESLint boundaries config | B | ADR-003, ADR-004 |
| SPEC-018 | Integration test suite v1→v2 parity | B | ADR-013 |
| SPEC-019 | Cutover playbook | B | all above |
| SPEC-020 | Agent framework port — packages/agent-core, packages/agent-runtime | C | ADR-011, v2 cutover |

## Open Questions for Team Decision

1. **Knowledge entity family** — fourth base class or fold into Activity?
Separate. 
2. **Canonical schema scope for v1** — four entities or more? Which fields per entity?
Four for now. Doesn't matter for now - details after. Just draft them. 

3. **`repository.interface.ts` → `port.ts` rename** — only for external adapters, or everywhere?
It's not a rename - we're just removing interfaces. Ports for external - but yes - we'll have our repositories be explicit. 

4. **`modules/canonical/` vs `shared/canonical/`** — location decision
Shared - good callout. 

5. **Codegen-patterns fork vs expand** — rename/fork or keep evolving in place?
what do you think? 

6. **Agent port scope** — include Lineup/Step/DomainTypes (aspirational layer) or skip?
Let's discuss - what's lineup step domaintypes 

7. **Agent migration cadence** — one agency at a time or all three in parallel?
We're going to start fresh based on new architecture.

8. **Auto-generated thin use cases** — generate `GetXByIdUseCase` or let controllers call services for reads (CQRS-lite)?
Let's discuss.

## Risks

1. **Codegen scope creep.** Track A roughly triples codegen-patterns' current scope. Risk: it becomes bigger than Dealbrain v2.
2. **Canonical schema lock-in.** Wrong canonical fields = every domain service, adapter, and agent references incorrect concepts. High-quality sales expertise is critical.
3. **Semantic layer novelty.** dbt-style composable measures are new territory for the team. Risk of reinventing the wheel badly.
4. **Bandwidth.** Doug is the sole architect/driver. If pulled elsewhere, the initiative stalls.
5. **Bridge friction during Track B.** Python agents over stdio bridge is known friction. If Track B takes longer than expected, that friction compounds.

## Next Actions

1. Review this overview — gut-check structure, flag anything missing
2. Review ADRs 001-005 and ADR-011 (drafts ready)
3. Review Contact module sketch (draft ready)
4. Decide on open questions (above)
5. Schedule working session with Jeff/Thiago/Evan to kick off Track A
6. Schedule working session with Nick to scope canonical schemas + semantic layer
