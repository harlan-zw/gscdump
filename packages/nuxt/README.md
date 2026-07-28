# @gscdump/nuxt

Minimal Nuxt integration for gscdump applications.

It owns two stable Nuxt seams:

- typed `runtimeConfig.public.analytics` defaults
- build-time analyzer registry injection as `$gscAnalyzers`

Views, authentication, data fetching, server routes, and product fallback
policy stay in the host application. Browser runtime primitives live in
`@gscdump/engine-duckdb-wasm`; hosted API access lives in `@gscdump/sdk`.

```ts
export default defineNuxtConfig({
  modules: ['@gscdump/nuxt'],
  gscdumpAnalytics: {
    analyzers: '~/gscAnalyzers',
  },
})
```
