---
to: "<%= appModulePath %>"
inject: true
append: true
skip_if: "ObservabilityModule"
---

// TODO: Register ObservabilityModule (combiner subsystem, ADR-025)
// Add to AppModule.imports AFTER Events/Jobs/Bridge/Integration:
//
//   import { ObservabilityModule } from '@shared/subsystems/observability';
//   // ...
//   ObservabilityModule.forRoot(),
//
// ObservabilityModule composes sibling read ports via @Optional() DI; order matters.
