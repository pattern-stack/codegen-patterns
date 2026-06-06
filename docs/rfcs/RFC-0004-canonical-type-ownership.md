# RFC-0004 — Canonical-Type Ownership

**Status:** Stub
**Date:** 2026-06-06
**Owner:** Doug
**Related:** RFC-0002, RFC-0003, ADR-036, #482, #485

## Problem

Codegen should own the `Canonical*` types. Today they are hand-authored in surface packages (per ADR-036); the generated sink mapping in the `assembly-default-sinks` stack type-checks against *imported* canonicals. Owning them means adopting the **join-key model** — store external FK keys as columns, resolve via downstream read-only joins, retire ingest-time FK resolution. This is a pattern-layer change to the Integrated repo write contract and query layer, not a sink-emission change. RFC-0002 §4 named this the **precondition** for fully-mechanical interaction-surface sinks beyond the column-copy convention the `assembly-default-sinks` stack relies on.

## Coupling

**#482** — surface-package generalization gates whether `Canonical*` types can be generated for a surface that has no package today (the `document` case). If #482 generalizes surface-package emission to also generate `Canonical*` from YAML, that directly unblocks the fully-mechanical sink; the two are coupled and should be coordinated.

**#485** — the `assembly-default-sinks` stack ships the mapping against imported canonicals; RFC-0004 would make codegen emit those canonicals. The only residue identified is safe to defer: the generated mapping type-checks against the imported canonical, so any drift between the hand-authored canonical and the entity's fields is a compile error, not a silent mismatch.

This is an intake stub — design and decomposition are deferred to the Draft promotion.
