export const GSC_SEARCH_TYPES = {
  WEB: 'web',
  IMAGE: 'image',
  VIDEO: 'video',
  NEWS: 'news',
  DISCOVER: 'discover',
  GOOGLE_NEWS: 'googleNews',
} as const

export type GscSearchType = typeof GSC_SEARCH_TYPES[keyof typeof GSC_SEARCH_TYPES]
