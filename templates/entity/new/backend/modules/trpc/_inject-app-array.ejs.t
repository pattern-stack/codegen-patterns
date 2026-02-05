---
to: "<%= exposeTrpc ? `${basePaths.backendSrc}/app.module.ts` : '' %>"
inject: true
skip_if: <%= className %>TrpcModule
after: "from '@nestjs/common'"
---
<% if (exposeTrpc) { -%>
import { <%= className %>TrpcModule } from '<%= imports.appModuleToTrpcModule %>';
<% } -%>
