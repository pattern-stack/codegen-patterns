---
to: "<%= hasDetection ? clpOutputPaths.integrationSourceModule : null %>"
skip_if: <%= !hasDetection %>
force: true
---
<%- generatedBanner %>
import { Module } from '@nestjs/common';
import { buildChangeSource } from '<%= integrationSubsystemImport %>';
import type {
  DetectionConfig,
  IChangeSource,
  PollFetchCallback,
} from '<%= integrationSubsystemImport %>';
import type { <%= classNames.entity %> } from '<%= clpImports.integrationSourceToEntity %>';

const <%= entityName.toUpperCase() %>_DETECTION_CONFIGS: Record<string, DetectionConfig> = <%- detectionConfigsLiteral %>;

export const <%= entityName.toUpperCase() %>_POLL_FETCH_REGISTRY = Symbol('<%= entityName.toUpperCase() %>_POLL_FETCH_REGISTRY');
export const <%= entityName.toUpperCase() %>_CHANGE_SOURCES = Symbol('<%= entityName.toUpperCase() %>_CHANGE_SOURCES');

@Module({
  providers: [
    {
      provide: <%= entityName.toUpperCase() %>_CHANGE_SOURCES,
      inject: [<%= entityName.toUpperCase() %>_POLL_FETCH_REGISTRY],
      useFactory: (
        fetches: Record<string, PollFetchCallback<<%= classNames.entity %>>>,
      ): ReadonlyMap<string, IChangeSource<<%= classNames.entity %>>> =>
        new Map(
          Object.entries(<%= entityName.toUpperCase() %>_DETECTION_CONFIGS).map(([provider, cfg]) => {
            const fetch = fetches[provider];
            if (!fetch) {
              throw new Error(
                `<%= classNames.entity %>IntegrationSourceModule: missing fetch callback for provider '${provider}' in <%= entityName.toUpperCase() %>_POLL_FETCH_REGISTRY`,
              );
            }
            return [provider, buildChangeSource(cfg, fetch)];
          }),
        ),
    },
  ],
  exports: [<%= entityName.toUpperCase() %>_CHANGE_SOURCES],
})
export class <%= classNames.entity %>IntegrationSourceModule {}
