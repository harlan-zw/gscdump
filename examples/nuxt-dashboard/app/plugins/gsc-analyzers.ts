// Provides the dashboard's analyzer registry as `$gscAnalyzers`.
// Must run after the layer's `analytics.ts` plugin (which provides an empty
// default) so this override wins.

import { ANALYZERS } from '../gscAnalyzers'

// Layer plugins run before app plugins, so the layer's empty default is
// already provided and this override wins on the last-provider-wins rule.
export default defineNuxtPlugin(() => {
  return {
    provide: { gscAnalyzers: ANALYZERS },
  }
})
