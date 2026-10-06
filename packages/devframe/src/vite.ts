import type { GscdumpDevframeOptions } from './index'
import { createPluginFromDevframe } from '@vitejs/devtools-kit/node'
import { createGscdumpDevframe } from './index'

/**
 * The gscdump devframe as a Vite plugin. Vite DevTools mounts it as a dock.
 *
 * ```ts
 * // vite.config.ts
 * import { gscdump } from '@gscdump/devframe/vite'
 *
 * export default defineConfig({
 *   devtools: true,
 *   plugins: [gscdump({ site: 'example.com' })],
 * })
 * ```
 */
export function gscdump(options: GscdumpDevframeOptions = {}): ReturnType<typeof createPluginFromDevframe> {
  return createPluginFromDevframe(createGscdumpDevframe(options))
}

export default gscdump
