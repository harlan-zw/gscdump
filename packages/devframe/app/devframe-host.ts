import type { DevframeRpcClient } from 'devframe/client'
import type { GscdumpContext, PageChannelProtocol, PageStats, PageStatsInput } from '../src/shared/protocol'
import type { PanelHost } from './host'
import { connectDevframe } from 'devframe/client'
import { connectPanelChannel } from 'devframe/in-page-channel'
import { PAGE_CHANNEL } from '../src/shared/protocol'
import { errorMessage } from './host'

/** The node side's functions, by wire name. The registry lives in `src/rpc.ts`. */
interface GscdumpCalls {
  'gscdump:get-context': (preferredSiteId: string | null, pageUrl: string | null) => GscdumpContext
  'gscdump:get-page-stats': (input: PageStatsInput) => PageStats
}

/**
 * The panel inside a devframe dock. Reads go to the node side over devframe
 * RPC. The page script in the app page reports the page in view.
 */
export function createDevframeHost(): PanelHost {
  const client = connectDevframe()

  async function call<K extends keyof GscdumpCalls>(name: K, ...args: Parameters<GscdumpCalls[K]>): Promise<ReturnType<GscdumpCalls[K]>> {
    const connected: DevframeRpcClient = await client
    const invoke = connected.call as unknown as (name: string, ...args: unknown[]) => Promise<ReturnType<GscdumpCalls[K]>>
    return invoke(name, ...args)
  }

  // A dock iframe or a popup. Only there can the page script answer.
  const embedded = window.parent !== window || !!window.opener

  return {
    context: (preferredSiteId, pageUrl) => call('gscdump:get-context', preferredSiteId, pageUrl)
      .catch((error: unknown): GscdumpContext => ({ _tag: 'Unavailable', message: `The devtool did not connect to the dev server: ${errorMessage(error)}` })),
    pageStats: input => call('gscdump:get-page-stats', input)
      .catch((error: unknown): PageStats => ({ _tag: 'Failed', message: errorMessage(error), requestId: null })),
    followPage: embedded
      ? (onPage) => {
          const channel = connectPanelChannel<PageChannelProtocol>({ name: PAGE_CHANNEL, functions: {} })
          void channel.sharedState.get('location').then((state) => {
            onPage({ ...state.value() })
            state.on('updated', value => onPage({ ...value }))
          })
          return () => channel.close()
        }
      : null,
    followLabel: 'Follow app',
  }
}
