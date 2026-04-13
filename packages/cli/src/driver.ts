import type { GscDriver } from 'gscdump/driver'
import { createCloudDriver, createLocalDriver } from 'gscdump/driver'
import { getAuth, loadCloudTokens } from './auth'
import { DEFAULT_CLOUD_URL, loadConfig } from './config'
import { VERSION } from './utils'

export async function getDriver(opts?: { interactive?: boolean }): Promise<GscDriver> {
  const config = await loadConfig()

  if (config.mode === 'cloud') {
    const tokens = await loadCloudTokens()
    if (!tokens?.sessionId)
      throw new Error('No cloud session. Run gscdump init.')

    return createCloudDriver({
      cloudUrl: config.cloudUrl || DEFAULT_CLOUD_URL,
      sessionId: tokens.sessionId,
      version: VERSION,
    })
  }

  const auth = await getAuth({ interactive: opts?.interactive ?? false, config })
  return createLocalDriver({ auth })
}
