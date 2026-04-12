# ADR-011 — Port agentic-patterns Core to TypeScript on Vercel AI SDK

**Status:** Draft — decision deferred until post-v2 cutover (Track C)
**Date:** 2026-04-11
**Owner:** Doug
**Related:** ADR-008, ADR-010
**Research sources:** Three parallel deep-research reports on Google ADK, TS agent framework landscape, and agentic-patterns internals (2026-04-11)

## Context

Dealbrain currently runs its AI agents in `apps/agents/` as a separate Python package built on `agentic-patterns` (the pattern-stack Python framework). The NestJS backend communicates with the agents via a JSON-RPC stdio bridge (`apps/agents/scripts/stdio_bridge.py`, ~450 LoC). Three agencies are built out: `deal_assessment` (5 agents), `call_summaries` (3 agents), and `field_pipeline` (4 agents). Every agent composes pattern-stack primitives — Personas, Judgments, Responsibilities, Missions, Capabilities, Toolboxes — into roles and agents executed by the `AgentRunner`.

The current setup works but introduces real friction:

1. **Subprocess bridge overhead.** 450 lines of JSON-RPC framing, event forwarding, `uv run` process management, auth cookie resolution, and duplicate-event guards.
2. **Tool duplication.** Dealbrain's 15 Python toolboxes wrap HTTP calls back into the NestJS backend. Every CRM read/write exists twice: once as a NestJS route, once as a Python HTTP wrapper.
3. **Schema duplication.** Pydantic schemas in Python (`src/domain/schemas/`) and Zod/TypeScript schemas in NestJS. Manual synchronization.
4. **Debug pain.** Stack traces stop at the subprocess boundary. IDE features, type information, and refactoring all halt.
5. **Upstream dependency risk.** `agentic-patterns 0.1.0` is pinned to Doug's personal repo. Every upstream change is unaudited.

As part of the v2 architecture, we need a unified TypeScript codebase that owns its agent primitives. The question is **which framework or approach to adopt** for that TS agent layer. Three paths have been evaluated:

1. **Google Agent Development Kit (ADK)** — official TS SDK (`@google/adk`)
2. **An existing TS framework** — Mastra, LangGraph JS, Vercel AI SDK primitives, Claude Agent SDK
3. **Port `agentic-patterns` core to TypeScript** — translate the Python primitives to Zod/TS on Vercel AI SDK

Three parallel deep-research agents were dispatched to evaluate these options with full technical assessments.

## Research Summary

### Google ADK (full report in session transcript)

**Verdict: Don't adopt.**

- Official TypeScript SDK exists (`@google/adk` v0.6.1, Dec 2025) but is Pre-GA with explicit "limited support" disclaimers. Java and Go shipped 1.0; TS did not.
- **Gemini-locked in TypeScript.** The TS SDK has first-party support for Gemini and Apigee only. There is no Anthropic class, no OpenAI class, no LiteLLM class. To use Claude (which Dealbrain currently uses via Bifrost+LiteLLM), we would have to subclass `BaseLlm` ourselves and maintain a Claude provider shim against both SDKs as they evolve.
- **Missing persistent memory.** Only `InMemoryMemoryService` exists in TS. The Python SDK's `VertexAiRagMemoryService` has not been ported.
- **Missing parallel tool calls.** Open feature request. Our retrieval agents (WorkspaceRetrievalAgent fanning out to Gmail + Slack + Calendar) would be sequential and slow.
- **Missing human-in-the-loop.** Open feature request.
- **ESM-first with known CJS build issues.** NestJS 10 CJS projects need patch workarounds.
- **No named production users.** Google's blog post uses generic "customer service" examples without company names. The Python/Go/Java SDKs have customer stories; the TS SDK does not.

ADK's composition primitives (Sequential/Parallel/Loop workflow agents, subAgents, AgentTool) are elegant, and OpenTelemetry is baked in. But none of that compensates for losing Claude.

### TS Agent Framework Landscape (full report in session transcript)

**Verdict: Build thin primitives on Vercel AI SDK. Mastra is a viable fallback.**

- **Mastra** — v1.0 Jan 2026, 22k stars, 300k+ weekly npm downloads, production users include Replit, PayPal, Brex, SoftBank. TypeScript-native, four types of memory, first-class Langfuse integration, MCP support, workflow DSL. Strongest "adopt a framework" choice. Risks: maturity (1.0 was January, sharp edges from March 2026 fixes), workflow DSL friction for complex branching, no SOC 2 yet, peer-dep conflicts with AI SDK versions.
- **LangGraph JS** — mature, graph-based, best interrupt/HITL story, used by LinkedIn/Uber/Replit. But verbose (LangChain abstraction tax), bundle-heavy, and has had 2026 CVEs in adjacent packages. Overkill for Dealbrain's domain-boundary agent shape.
- **Vercel AI SDK** — 23k stars, 20M+ monthly downloads, native OTel, 25+ providers, Claude-first-class, used as the underlying model layer by Mastra itself. Deliberately unopinionated — it gives primitives, not a framework. Best-in-class TS quality and model abstraction.
- **Claude Agent SDK** — Claude Code repurposed as a library. Great for filesystem/shell/subagent shapes, awkward for CRMRetrievalAgent shapes that don't fit the coding-agent mold.
- **Inngest AgentKit** — only interesting if already on Inngest for durable execution. We aren't.

The landscape report's top recommendation was **Path A: build thin primitives on Vercel AI SDK**, framed as ~500 LoC of our own primitives (Agent base class, Tool registry tied to facades, Memory interface, Coordinator, AgentRunner loop).

### agentic-patterns Deep Inspection (full report in session transcript)

**Verdict: Port to TypeScript. Effort is bounded. Framework is genuinely portable.**

The third research agent deeply inspected the Python `agentic-patterns` framework and Dealbrain's usage of it. Key findings:

**The framework is portable because it has almost no Python-specific magic.**

- Every atom (`Persona`, `Judgment`, `Mission`, `Background`, etc.) is a frozen Pydantic model with a `to_prompt()` method. ~30-200 LoC each. No metaclasses, no descriptors, no runtime reflection.
- Every molecule (`Capability`, `Toolbox`, `Manual`) is a dataclass composing atoms.
- Every organism (`Role`, `Agent`) is a builder-pattern composition.
- The `AgentRunner` is ~970 LoC of a straightforward tool-loop built on LiteLLM.
- The only Python-specific feature is `BaseToolbox`'s use of `inspect.signature` + `get_type_hints` to auto-generate OpenAI tool schemas from method signatures. **This is actually improved by porting**, because TS uses explicit Zod schemas (cleaner, type-safe, aligns with Vercel AI SDK's native model).

**Dealbrain uses ~60% of the framework's surface area — specifically the well-trodden parts:**

- All 11 atom types (Persona, Judgment, Mission, Background, Awareness, Responsibility, Example, State, Tone, Methodology, Recovery)
- Capability, Toolbox, Manual molecules
- Role, Agent organisms
- AgentRunner, AgentEventBus, Conversation system layer
- Langfuse exporter for observability
- Library presets (coordinator, orchestrator, analyst, retrieval role factories)

**Dealbrain does NOT use the framework's aspirational layers:** Lineups, Steps, DomainTypes, Playbooks, Workflows, TaskLoop, EvaluatorLoop, Sequential, Parallel, the FastAPI app/, orchestrator server, TUI, sandbox, NATS, SQLAlchemy persistence, or the Claude Agent SDK bridge. All of this can be skipped.

**Effort estimate:**
- ~5,600 LoC of core to port (atoms + molecules + organisms + runner + event bus + exporters + library orchestration presets)
- ~3-4 weeks solo, ~2 weeks with a second engineer
- Plus Dealbrain migration: 15 toolboxes become NestJS services, 11 agent factories become TS functions, judgments/personas/schemas/missions get mechanically translated

**The port gives us wins the Python version cannot:**

1. **Parallel tool calls.** Vercel AI SDK supports them natively; the Python `AgentRunner` executes tool calls sequentially. For the 4-analyst deal assessment, this is a real latency win.
2. **Native streaming end-to-end.** AI SDK streams → NestJS SSE/WebSocket → React. No subprocess JSON-RPC bridge.
3. **In-process tool execution.** Toolboxes become NestJS services injected directly, not HTTP wrappers around NestJS routes.
4. **Single debugging story.** One language, one stack trace, one IDE.
5. **Single schema story.** Zod schemas shared across agents, services, DTOs.
6. **Owned primitives.** No upstream dependency risk. We evolve the framework intentionally.

## Decision

**Port `agentic-patterns` core to TypeScript as Dealbrain's agent framework. Ship as workspace packages. Build on Vercel AI SDK as the runner layer. Scope to the 60% of surface area Dealbrain actually uses. Defer the port to Track C (post-v2 cutover).**

### Why This Beats The Alternatives

**vs. Google ADK:** We keep Claude as a first-class model (ADK's biggest blocker), we keep the entire Persona/Judgment/Role/Mission vocabulary that Doug has invested in, and we avoid Pre-GA maturity risk on a framework with no named production users. ADK's composition primitives are elegant but would require us to rebuild the Persona/Role layer on top anyway.

**vs. adopting Mastra:** We keep owned primitives, avoid framework opinions that don't match our domain-boundary shape, and avoid Mastra's young-framework sharp edges (Observational Memory OOM leaks, Postgres deadlocks, workflow DSL friction — all fixed in March 2026, but indicative of maturity). Mastra's observability story is excellent, but we get the same thing from AI SDK's native OTel + a Langfuse span processor. The architectural consistency argument is strongest here: every other subsystem in v2 follows the Protocol → Backend → Factory pattern with thin owned primitives. The agents subsystem should too.

**vs. building DIY primitives on Vercel AI SDK from scratch:** The agentic-patterns framework has already designed the primitive shape (atoms/molecules/organisms), the composition model (Role = Persona + Judgments + Responsibilities + Capabilities), and the prompt-rendering strategy (every atom has `toPrompt()`). Porting translates a designed system rather than inventing one. The designed system is the vocabulary Doug uses in conversation — porting it means the code matches how the business thinks about agents.

**vs. keeping the Python subprocess:** Eliminates 450 LoC of stdio bridge, 15 files of HTTP toolbox wrappers, duplicate schemas in two languages, and the cross-language debugging pain. The stdio bridge works, but it is permanent friction on every agent change.

**vs. LangGraph JS:** LangGraph's graph model is too heavy for domain-boundary agents. We would use 20% of its capability and pay 100% of its verbosity, bundle weight, and LangChain abstraction tax. Reserve it as a fallback if we ever need true DAG state machines with cycles and time-travel debugging.

### Port Scope — What We Ship

**`packages/agent-core`** (atoms + molecules + organisms)

- `AgenticModel<T extends ZodTypeAny>` base class with `toPrompt()`, `replace()`, `merge()`
- **Atoms:** `Persona`, `Judgment`, `Mission`, `Background`, `Awareness`, `AwarenessDomain`, `Responsibility`, `Example`, `State`, `Tone`, `Methodology`, `Recovery`
- **Molecules:** `Capability`, `Toolbox` (abstract, Zod-schema-based), `Manual` + `SimpleManual`
- **Organisms:** `Role` + `RoleBuilder`, `Agent` + `AgentBuilder`
- `PromptRenderer` with section composition (Identity, Boundaries, Capabilities, Context, Mission, Methodology)

**`packages/agent-runtime`** (systems layer)

- `AgentRunner` built on Vercel AI SDK's `generateText` / `streamText` with manual tool loop for gate support
- `AgentEventBus` with typed event definitions (MessageStart/End, LLMCallStart/End, ToolCallIntent/Start/End, IterationStart/End, Error)
- `Conversation` multi-turn wrapper with persistence hook
- `Gate` base + blocking via `emitIntent` (HITL-ready)
- **Exporters:** `LangfuseExporter` (via `@langfuse/*` JS SDK), console exporter, OTel exporter
- **Library presets:** `coordinatorRole()`, `orchestratorRole()`, `analystRole()`, `retrievalRole()` factories

**What we explicitly skip (out of scope)**

- `app/` FastAPI admin UI — replaced by NestJS
- `orchestrator/` FastAPI standalone server — we are in NestJS
- Workflow primitives (`TaskLoop`, `EvaluatorLoop`, `Sequential`, `Parallel`) — Dealbrain doesn't use them
- `Lineup` / `Step` / `DomainTypes` (aspirational layer) — Dealbrain implements agencies by convention
- `Playbook` — not used
- Claude Agent SDK bridge — not used
- Sandbox / NATS / SQLAlchemy persistence — not needed
- Go TUI — the Go app can call the NestJS runner endpoint directly

### How Agents Plug Into v2

Agents become `subsystems/agents/`, exposing a clean Protocol:

```ts
getAgents().run('CRMRetrievalAgent', { objective, context })
  → AgentResult
getAgents().stream('PreCallAnalyst', { objective, context })
  → AsyncIterable<AgentEvent>
getAgents().register(agent: Agent)
  → void
```

Agents consume **use cases**, never repositories or services directly. If an agent needs data, it goes through the same use case a controller would call. This keeps agents auditable, testable, and interchangeable with human-driven workflows. An agent's Toolbox is a NestJS service injected into it, and each toolbox method calls one or more use cases.

Use cases may invoke either the LLM subsystem (for deterministic ML tasks like sentiment classification or field clustering) or the Agents subsystem (for intelligent reasoning tasks). Services may invoke **neither** — both are side effects (see ADR-010).

### Sequencing — Track C, Post-Cutover

This port is the final track of the v2 initiative, not parallel work. It begins after v2 is stable in production (Track B complete and cut over). During Track B, the existing Python agents in `apps/agents/` continue running via the stdio bridge. Agent capabilities remain unchanged during the rebuild.

The rationale:

- **Reduced risk.** Rebuilding the architecture AND the agents simultaneously compounds complexity. Sequencing them keeps each initiative focused.
- **Clearer requirements at Track C start.** When the port begins, all v2 facades, services, and use cases exist. The TS toolboxes have well-defined call sites (no more reverse-engineering what data the agents need).
- **No regression during B.** Python agents keep working. The stdio bridge is friction, but known friction.
- **Parallel validation.** Once the TS port is partially done, we can run a TS agent and a Python agent side-by-side against the same use cases and compare outputs. Smooth migration path.

### Migration Cadence (Track C)

Port agencies one at a time in order of complexity:

1. **`deal_assessment` first.** Largest (5 agents + coordinator), most complete example of the coordinator-via-toolbox pattern, exercises every primitive.
2. **`call_summaries` second.** Smaller (3 agents), validates the single-pass structured output pattern.
3. **`field_pipeline` third.** Integrates with the LLM subsystem for bounded ML tasks, not just reasoning agents.

After all three agencies are ported and in production, delete `apps/agents/`, delete the stdio bridge, delete the Python toolboxes.

## Consequences

### Positive

- **Unified TypeScript codebase.** One language, one schema system, one stack trace.
- **Parallel tool calls on day one.** Vercel AI SDK supports them natively. Existing sequential limitations disappear.
- **In-process tool execution.** Toolboxes call NestJS services directly — no HTTP roundtrips, no subprocess marshalling.
- **Owned primitives.** No upstream dependency risk, no Pre-GA framework terms.
- **The vocabulary survives.** Every Persona/Judgment/Role/Mission Doug has invested in translates 1:1.
- **Architectural consistency.** Agents subsystem follows the same Protocol → Backend → Factory pattern as every other subsystem.
- **Langfuse tracing is cleaner.** Vercel AI SDK's native OTel spans flow to Langfuse via a single span processor, same as the rest of the stack.
- **The stdio bridge and Python toolbox wrappers are deleted.** Hundreds of lines of duplication gone.

### Negative

- **3-6 weeks of focused porting work.** Not parallelizable with Track B — dedicated effort during Track C.
- **Owned primitives are ours forever.** We maintain the framework instead of delegating to a vendor. Expected given the rest of v2's philosophy, but worth naming.
- **Python agents stay in production during Track B.** The stdio bridge persists for weeks-to-months. Known friction, but it doesn't block anything.
- **Mastra/LangGraph/ADK features we don't get.** No pre-built checkpoint/resume, no pre-built graph DSL, no pre-built multi-agent interrupt. If we later decide we need these, we either build them or adopt a framework retroactively.
- **Onboarding cost.** A new engineer joining Dealbrain learns our agent primitives, not an off-the-shelf framework. Trade-off: our primitives match our domain vocabulary; off-the-shelf primitives don't.

### Neutral

- The Vercel AI SDK dependency is deep but bounded. AI SDK is the most widely-adopted LLM library in TypeScript (20M+ monthly downloads) and is the model layer for Mastra, so we are not betting on a niche project.
- Langfuse JS SDK is mature. Observability continues to work.
- The Python `agentic-patterns` framework remains available upstream if we ever want to reference it or cross-check behavior.

## Open Questions for Track C Start

1. **Lineup/Step/DomainTypes aspirational layer.** Codify the coordinator-spawns-specialist pattern as a first-class primitive, or keep it as a convention? Decision deferred until the port begins — we will see whether the convention-based approach works in TS.
2. **Memory backend.** Dealbrain agents currently have no persistent memory — just message history via `Conversation`. Do we add pgvector-backed semantic memory for the CRMRetrievalAgent / FactRetrievalSpecialist? If yes, the `MemoryPort` is a new subsystem or a sub-protocol of the Agents subsystem.
3. **Structured output validation.** Python agentic-patterns uses Pydantic's `model_json_schema()` injected into the prompt. TS port uses Zod. Decision: use `zod-to-json-schema` for injection, and Vercel AI SDK's `generateObject<T>()` for type-safe structured output where the task fits that mold.
4. **Event bus persistence.** Python AgentEventBus emits to in-memory subscribers by default. Do we persist events to Postgres (via the Events subsystem) for replay and audit? Probably yes, as a Langfuse/Events subscriber — but verify the perf impact.

## References

- [ADR-001 — DDD + hexagonal architecture](./ADR-001-ddd-hexagonal-architecture.md)
- [ADR-008 — Subsystem architecture](./ADR-008-subsystem-architecture.md) (pending)
- [ADR-010 — LLM vs Agents subsystem split](./ADR-010-llm-vs-agents-split.md) (pending)
- Pattern-stack agentic-patterns — `/Users/dug/Projects/dev/pattern-stack/agentic-patterns/`
- [agentic-patterns mental model doc](https://agentic-patterns.pattern-stack.com)
- [Vercel AI SDK docs](https://ai-sdk.dev/)
- Research reports archived in session transcript (2026-04-11): Google ADK assessment, TS framework landscape, agentic-patterns deep inspection
- [v2 Initiative Overview](../v2-initiative-overview.md)
