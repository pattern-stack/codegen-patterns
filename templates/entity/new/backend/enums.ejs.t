---
to: "<%= outputPaths.enums %>"
skip_if: "<%= !outputPaths.enums %>"
force: true
---
<%- generatedBanner %>
<%_ /* The entity's pgEnum declarations. A LEAF module: it imports nothing but pg-core, so an entity file that imports an enum from here at module top level cannot join an import cycle (a base and its children, or a match: and its target, import each other). */ _%>
import { pgEnum } from 'drizzle-orm/pg-core';

<%_ enumFields.forEach(ef => { _%>
export const <%= ef.enumName %> = pgEnum('<%= ef.dbName %>', [<%- ef.choices.map(c => `'${c}'`).join(', ') %>]);
<%_ }) _%>
