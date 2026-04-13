---
to: "<%= typeof clpOutputPaths !== 'undefined' ? 'src/app.module.ts' : null %>"
inject: true
skip_if: <%= classNames.module %>
after: "// Codegen module imports"
---
import { <%= classNames.module %> } from './modules/<%= entityNamePlural %>/<%= entityNamePlural %>.module';
