import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'

export function killProcessGroup(child) {
  try {
    if (process.platform === 'win32')
      child.kill('SIGKILL')
    else if (child.pid)
      process.kill(-child.pid, 'SIGKILL')
  }
  catch (error) {
    // The child can exit and be reaped before 'close' clears the kill timer.
    // A missing process group means the kill already happened. Ignore it.
    if (error.code !== 'ESRCH' && error.code !== 'SRCH')
      throw error
  }
}

export function run(command, args, { cwd, env, timeout = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const kill = () => {
      if (timedOut)
        return
      timedOut = true
      killProcessGroup(child)
    }
    const timer = setTimeout(kill, timeout)
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      if (stdout.length > 8_000_000)
        kill()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      if (stderr.length > 8_000_000)
        kill()
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ code: timedOut ? 124 : code ?? 1, stdout, stderr })
    })
  })
}

export async function checked(command, args, options) {
  const result = await run(command, args, options)
  if (result.code !== 0)
    throw new Error(`${command} failed (${result.code}): ${result.stderr.slice(-2000)}`)
  return result.stdout
}

export async function installCandidate(root, directory) {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  const packed = new Map()
  async function pack(name) {
    const cwd = join(root, 'packages', name)
    const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'))
    if (packed.has(pkg.name))
      return
    const tarball = join(directory, `${name}.tgz`)
    packed.set(pkg.name, tarball)
    for (const [dependency, version] of Object.entries(pkg.dependencies ?? {})) {
      if (version.startsWith('workspace:'))
        await pack(dependency === 'gscdump' ? dependency : dependency.slice('@gscdump/'.length))
    }
    await checked('pnpm', ['--config.ignore-scripts=true', 'pack', '--out', tarball], { cwd })
  }
  await pack('cli')
  await checked('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', ...packed.values()], { cwd: directory })
  return join(directory, 'node_modules/@gscdump/cli/bin/gscdump.mjs')
}

export function credentialEnvironment(source) {
  // Do not inherit model API keys, NODE_OPTIONS, CLI profiles, or a custom API root.
  const env = Object.fromEntries(['PATH', 'LANG', 'TERM', 'TMPDIR', 'SystemRoot'].filter(key => source[key]).map(key => [key, source[key]]))
  for (const suffix of ['ACCESS_TOKEN', 'CLIENT_ID', 'CLIENT_SECRET', 'REFRESH_TOKEN']) {
    const value = source[`GSC_${suffix}`] || source[`GOOGLE_${suffix}`]
    if (value)
      env[`GSC_${suffix}`] = value
  }
  for (const key of ['GSCDUMP_API_KEY', 'BING_API_KEY']) {
    if (source[key])
      env[key] = source[key]
  }
  return env
}
