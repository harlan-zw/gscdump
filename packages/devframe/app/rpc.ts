import type { DevframeRpcClient } from 'devframe/client'
import type { GscdumpContext, PageStats, PageStatsInput } from '../src/shared/protocol'

/** The node side's functions, by wire name. The registry lives in `src/rpc.ts`. */
interface GscdumpCalls {
  'gscdump:get-context': (preferredSiteId: string | null) => GscdumpContext
  'gscdump:get-page-stats': (input: PageStatsInput) => PageStats
}

export function callGscdump<K extends keyof GscdumpCalls>(
  client: DevframeRpcClient,
  name: K,
  ...args: Parameters<GscdumpCalls[K]>
): Promise<ReturnType<GscdumpCalls[K]>> {
  const call = client.call as unknown as (name: string, ...args: unknown[]) => Promise<ReturnType<GscdumpCalls[K]>>
  return call(name, ...args)
}
