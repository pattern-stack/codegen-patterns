---
to: <%= basePaths.backendSrc %>/app.module.ts
inject: true
skip_if: <%= classNamePlural %>Module
after: "// Codegen module imports"
---
import { <%= classNamePlural %>Module } from '<%= imports.appModuleToModule %>';
