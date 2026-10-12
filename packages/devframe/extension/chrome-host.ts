import type { PanelHost } from '../app/host'
import type { GscdumpContext, PageLocation, PageStats } from '../src/shared/protocol'
import { errorMessage } from '../app/host'
import { createPageStatsReader } from '../src/reader'
import { createSessionSource } from '../src/sources/session'

function locationOf(tab: chrome.tabs.Tab | undefined): PageLocation | null {
  const url = tab?.url ? URL.parse(tab.url) : null
  if (!url || !/^https?:$/.test(url.protocol))
    return null
  return { path: url.pathname, href: url.href, title: tab?.title ?? '' }
}

/**
 * The panel in the Chrome side panel. It reads the dashboard's routes with the
 * gscdump.com login cookie, picks the Site from the tab's host, and follows the
 * active tab of its own window.
 */
export function createChromeHost(origin: string): PanelHost {
  const reader = createPageStatsReader({ siteFromPage: true }, createSessionSource({ origin }), Date.now)

  return {
    context: (preferredSiteId, pageUrl) => reader.context(preferredSiteId, pageUrl)
      .catch((error: unknown): GscdumpContext => ({ _tag: 'Unavailable', message: errorMessage(error) })),
    pageStats: input => reader.pageStats(input)
      .catch((error: unknown): PageStats => ({ _tag: 'Failed', message: errorMessage(error), requestId: null })),
    followPage: (onPage) => {
      // A side panel belongs to a normal window. A panel opened as its own
      // popup window follows the last focused normal window instead.
      let windowId: number | null = null
      let stopped = false

      async function refresh(): Promise<void> {
        const tabs = await chrome.tabs.query(windowId === null
          ? { active: true, windowType: 'normal' }
          : { active: true, windowId })
        // Across windows, the active tab used most recently is the page in view.
        const tab = tabs.reduce<chrome.tabs.Tab | undefined>((latest, next) =>
          !latest || (next.lastAccessed ?? 0) > (latest.lastAccessed ?? 0) ? next : latest, undefined)
        const location = locationOf(tab)
        if (location && !stopped)
          onPage(location)
      }

      const onActivated = (): void => void refresh()
      const onUpdated = (_id: number, change: { url?: string, title?: string }, tab: chrome.tabs.Tab): void => {
        if (tab.active && (change.url || change.title))
          void refresh()
      }
      const onFocusChanged = (): void => {
        if (windowId === null)
          void refresh()
      }

      chrome.tabs.onActivated.addListener(onActivated)
      chrome.tabs.onUpdated.addListener(onUpdated)
      chrome.windows.onFocusChanged.addListener(onFocusChanged)
      void chrome.windows.getCurrent().then((current) => {
        windowId = current.type === 'normal' ? current.id ?? null : null
        return refresh()
      })

      return () => {
        stopped = true
        chrome.tabs.onActivated.removeListener(onActivated)
        chrome.tabs.onUpdated.removeListener(onUpdated)
        chrome.windows.onFocusChanged.removeListener(onFocusChanged)
      }
    },
    followLabel: 'Follow tab',
  }
}
