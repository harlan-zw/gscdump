import type { ManifestReadLimits } from 'icebird/src/manifest.js'

export type { ManifestReadLimits } from 'icebird/src/manifest.js'

const fields = [
  'maxObjectBytes',
  'maxTotalObjectBytes',
  'maxManifests',
  'maxEntries',
  'maxInflatedBlockBytes',
  'maxTotalInflatedBytes',
  'maxValueBytes',
  'maxDecodedValues',
  'maxHeaderBytes',
  'maxSchemaDepth',
] as const satisfies readonly (keyof ManifestReadLimits)[]

/** Capture the raw reader's policy before catalog/cache reads or lazy imports. */
export function captureManifestReadLimits(options: ManifestReadLimits | undefined): ManifestReadLimits | undefined {
  if (options === undefined)
    return undefined
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new TypeError('Invalid manifest read limits')
  for (const key of Object.keys(options)) {
    if (!fields.includes(key as keyof ManifestReadLimits))
      throw new TypeError(`Unknown manifest read limit: ${key}`)
  }
  const limits = {} as ManifestReadLimits
  for (const key of fields) {
    const value = options[key]
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new RangeError(`Invalid manifest read limit: ${key}`)
    limits[key] = value
  }
  if (limits.maxSchemaDepth > 128)
    throw new RangeError('Manifest schema depth must not exceed 128')
  return Object.freeze(limits)
}
