// Provides `$gscAnalyzers` from `~/gscAnalyzers` if the host app defined it.
// The real layer's module option `gscdumpAnalytics.analyzers` generates a
// build-time plugin; this stub leaves the array empty so the dashboard
// degrades gracefully.
// TODO: port from nuxtseo.com

import type { GscAnalyzerDefinition } from '../../types'
import { defineNuxtPlugin } from '#app'

export default defineNuxtPlugin(() => {
  return {
    provide: {
      gscAnalyzers: [] as GscAnalyzerDefinition[],
    },
  }
})
