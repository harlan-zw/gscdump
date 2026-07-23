import { defineBuildConfig } from '../../scripts/build-config'

export default defineBuildConfig({
  entries: [
    {
      type: 'bundle',
      input: [
        './src/index.ts',
        './src/analytics-client.ts',
        './src/analyzer-defs.ts',
        './src/anonymization.ts',
        './src/archetype-compile.ts',
        './src/client.ts',
        './src/country-names.ts',
        './src/cwv-thresholds.ts',
        './src/errors.ts',
        './src/gsc-console-url.ts',
        './src/gsc-constants.ts',
        './src/gsc-error.ts',
        './src/gsc-period-presets.ts',
        './src/gsc-rows.ts',
        './src/hosted-query.ts',
        './src/indexing-issues.ts',
        './src/lifecycle.ts',
        './src/period.ts',
        './src/search-console-stage.ts',
        './src/site-baseline.ts',
        './src/site-triage.ts',
        './src/webhook.ts',
        './src/v1/index.ts',
        './src/v1/http.ts',
        './src/v1/realtime.ts',
      ],
    },
  ],
})
