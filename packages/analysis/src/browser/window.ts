/**
 * Re-export from shared /window subpath. Kept for backwards compat with
 * /browser consumers importing window types from this path.
 */

export type { ComparisonMode, ResolvedWindow, ResolveWindowOptions, WindowPreset } from '../window'
export { resolveWindow } from '../window'
