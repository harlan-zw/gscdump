import { vi } from 'vitest'

const mocks = vi.hoisted(() => ({
// ... (keep existing mocks)
  analytics: [
     {
      keys: ['desktop'],
      clicks: 1250.0,
      impressions: 12580.0,
      ctr: 0.0994,
      position: 8.2,
    }
  ]
}))

vi.mock('ofetch', () => {
// ...
  return {
    ofetch: vi.fn((url: string, options: any) => {
      // console.log(`[Mock API] Request to: ${url}`)

      if (url.includes('/webmasters/v3/sites') && !url.includes('/sitemaps') && !url.includes('/searchAnalytics')) {
         return Promise.resolve({ siteEntry: mocks.sites })
      }
      
      if (url.includes('/sitemaps')) {
         if (options?.method === 'PUT') return Promise.resolve()
         if (options?.method === 'DELETE') return Promise.resolve()
         // Get specific sitemap
         if (url.split('/').pop()?.includes('.xml')) {
            return Promise.resolve(mocks.sitemaps[0])
         }
         return Promise.resolve({ sitemap: mocks.sitemaps })
      }

      if (url.includes('/searchAnalytics/query')) {
        return Promise.resolve({ rows: mocks.analytics })
      }
      
      if (url.includes('/urlInspection/index:inspect')) {
        return Promise.resolve(mocks.urlInspection)
      }

      if (url.includes('/urlNotifications:publish')) {
        return Promise.resolve({ 
           urlNotificationMetadata: {
             url: options.body?.url,
             latestUpdate: { type: 'URL_UPDATED', notifyTime: new Date().toISOString() }
           }
        })
      }

       if (url.includes('/urlNotifications/metadata')) {
        return Promise.resolve({ 
             url: url.split('url=')[1],
             latestUpdate: { type: 'URL_UPDATED', notifyTime: new Date().toISOString() }
        })
      }

      return Promise.resolve({})
    }),
  }
})
