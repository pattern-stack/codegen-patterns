---
to: <%= basePaths.backendSrc %>/app.module.ts
inject: true
skip_if: <%= classNamePlural %>Module
after: "from '@nestjs/common'"
---
import { <%= classNamePlural %>Module } from './modules/<%= plural %>.module';
