import { spawnSync } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'

const temporaryDirectories: string[] = []
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe.skipIf(process.platform === 'win32')('live check command', () => {
  async function run(credentials: Record<string, string>) {
    const bin = await mkdtemp(join(tmpdir(), 'gscdump-live-checks-'))
    temporaryDirectories.push(bin)
    const pnpm = join(bin, 'pnpm')
    // Observe the launched command's environment without making a Google request.
    await writeFile(pnpm, `#!${process.execPath}\nconsole.log(JSON.stringify({token:process.env.GSC_ACCESS_TOKEN,clientId:process.env.GSC_CLIENT_ID,clientSecret:process.env.GSC_CLIENT_SECRET,refreshToken:process.env.GSC_REFRESH_TOKEN}))\n`)
    await chmod(pnpm, 0o755)
    const env = { ...process.env, PATH: bin }
    for (const key of Object.keys(env)) {
      if (key.startsWith('GSC_') || key.startsWith('GOOGLE_'))
        delete env[key]
    }
    return spawnSync(process.execPath, [resolve('scripts/test-live.mjs')], {
      env: { ...env, ...credentials },
      encoding: 'utf8',
    })
  }

  it('rejects missing credentials before launching tests', async () => {
    const result = await run({})
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Live checks need')
    expect(result.stdout).toBe('')
  })

  it('passes a Google token fallback to suites that read the GSC token first', async () => {
    const result = await run({ GSC_ACCESS_TOKEN: '', GOOGLE_ACCESS_TOKEN: 'fixture-token' })
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout).token).toBe('fixture-token')
  })

  it('passes complete refresh credentials after resolving empty GSC overrides', async () => {
    const result = await run({
      GSC_CLIENT_ID: '',
      GOOGLE_CLIENT_ID: 'fixture-client',
      GOOGLE_CLIENT_SECRET: 'fixture-secret',
      GOOGLE_REFRESH_TOKEN: 'fixture-refresh',
    })
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      clientId: 'fixture-client',
      clientSecret: 'fixture-secret',
      refreshToken: 'fixture-refresh',
    })
  })
})
