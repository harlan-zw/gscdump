import countries from './utils/countries'

export const Devices = {
  MOBILE: 'MOBILE',
  DESKTOP: 'DESKTOP',
  TABLET: 'TABLET',
} as const
export type Device = typeof Devices[keyof typeof Devices]

export const SearchTypes = {
  WEB: 'web',
  IMAGE: 'image',
  VIDEO: 'video',
  NEWS: 'news',
} as const
export type SearchType = typeof SearchTypes[keyof typeof SearchTypes]

// Generate Country constant from ISO 3166-1 alpha-3 codes (lowercase for GSC API)
export const Countries = Object.fromEntries(
  countries.map(c => [c['alpha-3'], c['alpha-3'].toLowerCase()]),
) as { [K in typeof countries[number]['alpha-3']]: Lowercase<K> }
export type Country = typeof Countries[keyof typeof Countries]
