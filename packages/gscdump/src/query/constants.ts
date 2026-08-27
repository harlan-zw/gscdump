import countries from './utils/countries'

export const Devices = {
  MOBILE: 'MOBILE',
  DESKTOP: 'DESKTOP',
  TABLET: 'TABLET',
} as const
export type Device = typeof Devices[keyof typeof Devices]

export { GSC_SEARCH_TYPES as SearchTypes } from '@gscdump/contracts/search-types'
export type { GscSearchType as SearchType } from '@gscdump/contracts/search-types'

// Generate Country constant from ISO 3166-1 alpha-3 codes (lowercase for GSC API)
export const Countries = Object.fromEntries(
  countries.map(c => [c['alpha-3'], c['alpha-3'].toLowerCase()]),
) as { [K in typeof countries[number]['alpha-3']]: Lowercase<K> }
export type Country = typeof Countries[keyof typeof Countries]
