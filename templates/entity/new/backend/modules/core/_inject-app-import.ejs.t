---
to: <%= basePaths.backendSrc %>/app.module.ts
inject: true
skip_if: <%= classNamePlural %>Module
after: "imports: \\["
---
    <%= classNamePlural %>Module,
