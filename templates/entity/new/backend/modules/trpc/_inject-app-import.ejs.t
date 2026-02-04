---
to: "<%= exposeTrpc ? `${basePaths.backendSrc}/app.module.ts` : '' %>"
inject: true
skip_if: <%= className %>TrpcModule,
after: "imports: \\["
---
<% if (exposeTrpc) { -%>
    <%= className %>TrpcModule,
<% } -%>
