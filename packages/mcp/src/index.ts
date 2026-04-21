#!/usr/bin/env node
import type { Auth } from 'gscdump'
import process from 'node:process'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createGscMcpServer } from './server'

export { createGscMcpServer }
export * from './handlers'
export * from './types'

async function run(): Promise<void> {
  const getAuth: () => Promise<Auth> = async () => {
    if (process.env.GOOGLE_ACCESS_TOKEN || process.env.GOOGLE_REFRESH_TOKEN) {
      return {
        clientId: process.env.GOOGLE_CLIENT_ID!,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
        accessToken: process.env.GOOGLE_ACCESS_TOKEN,
        refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
      } as unknown as Auth
    }
    throw new Error('gscdump-mcp requires GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_ACCESS_TOKEN or GOOGLE_REFRESH_TOKEN env vars. For interactive auth, use @gscdump/cli.')
  }

  const server = createGscMcpServer({
    name: 'gscdump',
    getAuth,
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    process.stderr.write(`${e.message}\n`)
    process.exit(1)
  })
}
