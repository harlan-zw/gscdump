import type { CloudGscDriver } from './types'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { createCloudDriver } from './driver'
import { DEFAULT_CLOUD_URL, VERSION } from './utils'

export interface CloudSession {
  cloudUrl: string
  sessionId: string
}

function getTokensPath(): string {
  return path.join(os.homedir(), '.config', 'gscdump', 'cloud-tokens.json')
}

async function loadCloudTokensFile(): Promise<{ sessionId?: string } | null> {
  return fs.readFile(getTokensPath(), 'utf-8')
    .then(d => JSON.parse(d))
    .catch(() => null)
}

export async function loadCloudSession(): Promise<CloudSession> {
  const cloudUrl = process.env.GSCDUMP_CLOUD_URL || DEFAULT_CLOUD_URL
  const envSession = process.env.GSCDUMP_CLOUD_SESSION
  if (envSession)
    return { cloudUrl, sessionId: envSession }

  const tokens = await loadCloudTokensFile()
  if (!tokens?.sessionId)
    throw new Error('No cloud session. Set GSCDUMP_CLOUD_SESSION or run `gscdump init`.')
  return { cloudUrl, sessionId: tokens.sessionId }
}

export async function getDriver(): Promise<CloudGscDriver> {
  const { cloudUrl, sessionId } = await loadCloudSession()
  return createCloudDriver({ cloudUrl, sessionId, version: VERSION })
}
