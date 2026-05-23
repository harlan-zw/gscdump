// Public re-export. The implementation lives in `_useGscResource.ts`; the
// module's `imports:extend` hook strips `_use*` from host auto-imports so
// consumers see the wrapper at `useGscResource` and the layer's own
// composables import the internal file directly. Named re-exports because
// Nuxt's auto-import scanner doesn't traverse `export *`.
export {
  type GscResourceStatus,
  useGscResource,
  type UseGscResourceOptions,
  type UseGscResourceReturn,
} from './_useGscResource'
