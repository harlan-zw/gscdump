import { defineNuxtPlugin } from '#app'
import { ANALYZERS } from '~/gscAnalyzers'

export default defineNuxtPlugin(() => ({
  provide: { gscAnalyzers: ANALYZERS },
}))
