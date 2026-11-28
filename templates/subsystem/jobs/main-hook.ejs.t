---
to: "<%= mainTsPath %>"
inject: true
after: "NestFactory.create"
skip_if: "<%= mainHookInjected %>"
---
  // JOBS — the job executor (@pattern-stack/jobs, JOBS-3)
  // `jobs.worker_mode: embedded` (the default) runs it in this process: the generated SUBSYSTEM_MODULES compose
  // `JobsEngineModule.forRoot({ worker: true })`. `standalone`: this process only starts runs, and `bun src/worker.ts`
  // advances them. `app.close()` drains it; this entry owns SIGTERM.
