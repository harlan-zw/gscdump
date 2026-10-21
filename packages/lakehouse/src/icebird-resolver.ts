import type { cachingResolver } from 'icebird/src/fetch.js'

/**
 * icebird's file `Resolver`.
 *
 * Derive it from `cachingResolver` and never import `icebird/src/types.js`.
 * That specifier has no declaration under icebird's `types/` folder, so the
 * declaration bundler keeps it as an external import. icebird is bundled and
 * consumers do not install it, so the type would resolve to `any` for them.
 */
export type Resolver = ReturnType<typeof cachingResolver>
