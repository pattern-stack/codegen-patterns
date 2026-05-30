---
to: "<%= hasDetection ? (isCleanLitePs ? clpOutputPaths.integrationSourceModule : `${basePaths.backendSrc}/${paths.modules}/${name}-integration-source.module.ts`) : null %>"
skip_if: <%= !hasDetection %>
force: true
---
<%- typeof generatedBanner !== 'undefined' ? generatedBanner : '' %>
import { Module } from '@nestjs/common';
import { buildChangeSource } from '@shared/subsystems/integration';
import type {
  DetectionConfig,
  IChangeSource,
  PollFetchCallback,
} from '@shared/subsystems/integration';
import type { <%= className %> } from '<%= isCleanLitePs ? clpImports.integrationSourceToEntity : imports.moduleToDomain %>';

const <%= name.toUpperCase() %>_DETECTION_CONFIGS: Record<string, DetectionConfig> = <%- detectionConfigsLiteral %>;

export const <%= name.toUpperCase() %>_POLL_FETCH_REGISTRY = Symbol('<%= name.toUpperCase() %>_POLL_FETCH_REGISTRY');
export const <%= name.toUpperCase() %>_CHANGE_SOURCES = Symbol('<%= name.toUpperCase() %>_CHANGE_SOURCES');

@Module({
  providers: [
    {
      provide: <%= name.toUpperCase() %>_CHANGE_SOURCES,
      inject: [<%= name.toUpperCase() %>_POLL_FETCH_REGISTRY],
      useFactory: (
        fetches: Record<string, PollFetchCallback<<%= className %>>>,
      ): ReadonlyMap<string, IChangeSource<<%= className %>>> =>
        new Map(
          Object.entries(<%= name.toUpperCase() %>_DETECTION_CONFIGS).map(([provider, cfg]) => {
            const fetch = fetches[provider];
            if (!fetch) {
              throw new Error(
                `<%= className %>IntegrationSourceModule: missing fetch callback for provider '${provider}' in <%= name.toUpperCase() %>_POLL_FETCH_REGISTRY`,
              );
            }
            return [provider, buildChangeSource(cfg, fetch)];
          }),
        ),
    },
  ],
  exports: [<%= name.toUpperCase() %>_CHANGE_SOURCES],
})
export class <%= className %>IntegrationSourceModule {}
