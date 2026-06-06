---
to: "<%= mainTsPath %>"
inject: true
after: "NestFactory.create"
skip_if: "<%= mainHookInjected %>"
---
  // JOBS — Embedded worker mode (optional)
  // To run the job worker in-process (single-process deploy), add to AppModule imports:
  //   JobWorkerModule.forRoot({ mode: 'embedded' })
  // For standalone worker (separate process), run src/worker.ts (bun src/worker.ts).
  // See codegen.config.yaml jobs.worker_mode to toggle the documented default.
