// Provide the analytics context at the Nuxt app root. Doing this in a plugin
// (instead of `provideGscAnalytics()` inside each layout) means every page /
// component — including routes that opt out of the default layout — can
// inject without boilerplate. Consumers can still call `provideGscAnalytics()`
// inside a layout to override with a scoped context.

import { createGscAnalyticsContext, GSC_ANALYTICS_KEY } from '../composables/useGscAnalytics'

export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.vueApp.provide(GSC_ANALYTICS_KEY, createGscAnalyticsContext())
})
