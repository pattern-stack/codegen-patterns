---
to: "<%= mainTsPath %>"
inject: true
after: "NestFactory.create"
skip_if: "<%= mainHookInjected %>"
---
  // JOBS — Embedded worker mode (optional)
  // To run the job worker in-process (single-process deploy), set
  // `jobs.worker_mode: embedded` in codegen.config.yaml and regenerate: the
  // generated SUBSYSTEM_MODULES then composes JobWorkerModule with your
  // `jobs.backend` — never hand-wire it (a second, differently-configured
  // JobWorkerModule boots a second orchestrator backend).
  // For standalone worker (separate process), run src/worker.ts (bun src/worker.ts).
