---
to: "<%= generate.dtos ? `${basePaths.backendSrc}/${backendLayers.schemas}/index.ts` : '' %>"
inject: true
append: true
skip_if: <%= name %>.dto
---
export * from './<%= name %>.dto';
