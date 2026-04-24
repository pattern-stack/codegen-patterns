---
to: "<%= configPath %>"
inject: true
append: true
skip_if: "observability:"
---

observability:
  # OBS-6 (phase 2) reserved — ObservabilityModule.forRoot() ignores this block
  # in phase 1. OBS-6 consumes these values for the BridgeMetricsReporter.
  reporters:
    bridgeMetrics:
      enabled: false
      intervalMs: 60000
      windowHours: 24
