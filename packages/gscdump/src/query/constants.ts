import countries from '../utils/countries'

export const Device = {
  MOBILE: 'MOBILE',
  DESKTOP: 'DESKTOP',
  TABLET: 'TABLET',
} as const
export type Device = typeof Device[keyof typeof Device]

// Generate Country constant from ISO 3166-1 alpha-3 codes (lowercase for GSC API)
export const Country = Object.fromEntries(
  countries.map(c => [c['alpha-3'], c['alpha-3'].toLowerCase()]),
) as { [K in typeof countries[number]['alpha-3']]: Lowercase<K> }
export type Country = typeof Country[keyof typeof Country]
