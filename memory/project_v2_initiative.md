---
name: Dealbrain v2 Architecture Initiative
description: Three-track initiative to rebuild Dealbrain on DDD+hexagonal architecture with codegen-first enforcement, canonical CRM schemas, and agent framework port
type: project
---

Dealbrain v2 is a greenfield rebuild (zero customers, two internal users) across three sequential tracks:

- **Track A** — Evolve codegen-patterns with new architecture target (Clean-Lite-PS), base class generators, subsystem templates, canonical schema generator, semantic measure generator
- **Track B** — Rebuild Dealbrain backend using new codegen (domain modules from YAML, hexagonal ports, integration test suite)
- **Track C** — Port agentic-patterns Python agent framework to TypeScript on Vercel AI SDK

**Why:** Current backend has architectural drift — fuzzy service/use-case boundary, inconsistent layer access, bespoke integrations. AI can't generate consistent code when rules have exceptions.

**How to apply:** Track A (codegen-patterns evolution) is the immediate focus. All template and schema work should target the v2 architecture shape defined in ADRs 001-005. The contact module sketch is the reference implementation.

Key architectural decisions (ADRs 001-005):
- DDD + hexagonal ports for externals (ADR-001)
- Domain-first module layout under modules/<domain>/ (ADR-002)
- Sharp test: side effects → use case, pure data → service (ADR-003)
- Cross-domain reads allowed, writes only via use cases (ADR-004)
- Four entity families: crm-synced, activity, knowledge, metadata (ADR-005)

ADRs 006-014 are pending (canonical schemas, semantic measures, subsystems, ports, LLM/agents split, codegen as source of truth, integration testing, greenfield rebuild).
