// Public re-export. The implementation lives in `_useGscQueryDispatcher.ts`;
// the module's `imports:extend` hook strips `_use*` from host auto-imports so
// consumers see the wrapper at `useGscQueryDispatcher` and the layer's own
// composables import the internal file directly. Named re-exports because
// Nuxt's auto-import scanner doesn't traverse `export *`.
export {
  type CreateDefaultDispatcherOpts,
  createDefaultGscQueryDispatcher,
  type GscEngineDecision,
  type GscFallbackEvent,
  type GscQueryDispatcher,
  type PickEngineOpts,
  useGscQueryDispatcher,
} from './_useGscQueryDispatcher'
